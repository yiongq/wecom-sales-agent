import { withTenant } from '../../db/client.js';
import { numEnv, todayIso } from '../../env.js';
import { TenantLocal } from '../../tenancy/local-state.js';
import { currentRuntime } from '../../tenancy/runtime.js';
import { registerTenantState } from '../../tenancy/state.js';

interface DayCount {
  day: string;
  tenant: number;
  sessions: Map<string, number>;
  ready: Promise<void> | null;
}
const counts = new TenantLocal(() => ({ current: null as DayCount | null }));
registerTenantState({ name: 'vision.daily', ...counts.registration((s) => (s.current ? 1 + s.current.sessions.size : 0)) });

/**
 * 每天首次调用读一次持久化基数，此后累加本进程预占（成功、失败都保留）。
 * 不在每次调用时把数据库与预占相加，避免定时刷写/会话提交后重复计数。
 * 同租户由现有运行时锁保证单写者；所有等待基数的调用在 await 后同步检查并预占。
 * usage_daily 定时刷新，trace 随会话提交。崩溃前未提交的少量调用可能漏计：
 * 这是成本护栏而非计费依据，复用既有延迟持久化语义，不新增持久化预占或迁移。
 * 文件模式没有这两张表，仅在内存中执行相同的每日上限，供开发与离线评测使用。
 */
export async function reserveVisionCall(sessionId: string, signal: AbortSignal): Promise<boolean> {
  const rt = currentRuntime();
  const state = counts.get();
  for (;;) {
    signal.throwIfAborted();
    if (!counts.owns(rt, state) || rt.cancel.aborted) throw new Error('tenant_closing');
    const day = todayIso();
    if (state.current?.day !== day) state.current = { day, tenant: 0, sessions: new Map(), ready: null };
    const current = state.current;
    if (!current.ready) {
      const loaded = rt.config.loaded;
      current.ready = (async () => {
        if (!loaded) return;
        const since = new Date(`${day}T00:00:00`);
        const until = new Date(since);
        until.setDate(until.getDate() + 1);
        const baseline = await withTenant(
          loaded.deps.db,
          {
            tenantId: rt.id,
            actor: { kind: 'system', userId: null, name: null, ip: null },
          },
          async (tx) => {
            const usage = await tx.query.usageDaily.findMany({
              columns: { calls: true },
              where: (t, { and, eq }) => and(eq(t.tenantId, rt.id), eq(t.day, day), eq(t.purpose, 'vision')),
            });
            const traces = await tx.query.turnTraces.findMany({
              columns: { conversationId: true, llm: true },
              where: (t, { and, eq, gte, lt, sql }) =>
                and(
                  eq(t.tenantId, rt.id),
                  gte(t.startedAt, since),
                  lt(t.startedAt, until),
                  sql`exists (select 1 from json_array_elements(
                  case when json_typeof(${t.llm}) = 'array' then ${t.llm} else '[]'::json end
                ) c where c->>'purpose' = 'vision')`,
                ),
            });
            const sessions = new Map<string, number>();
            for (const trace of traces) {
              const n = trace.llm.filter((c) => c !== null && typeof c === 'object' && 'purpose' in c && c.purpose === 'vision').length;
              sessions.set(trace.conversationId, (sessions.get(trace.conversationId) ?? 0) + n);
            }
            return { tenant: usage.reduce((n, row) => n + row.calls, 0), sessions };
          },
          { readOnly: true },
        );
        if (!counts.owns(rt, state) || state.current !== current || rt.cancel.aborted) return;
        current.tenant = baseline.tenant;
        current.sessions = baseline.sessions;
      })().catch((error: unknown) => {
        // 读取失败不按零放行，下一次允许重读；不输出带 SQL/会话信息的异常。
        if (state.current === current) current.ready = null;
        throw error;
      });
    }
    await current.ready;
    signal.throwIfAborted();
    if (!counts.owns(rt, state) || rt.cancel.aborted) throw new Error('tenant_closing');
    if (state.current !== current || current.day !== todayIso()) continue;
    const session = current.sessions.get(sessionId) ?? 0;
    const cap = Math.max(0, Math.floor(numEnv('VISION_DAILY_PER_TENANT', 200)));
    if (current.tenant >= cap || session >= 20) return false;
    current.tenant++;
    current.sessions.set(sessionId, session + 1);
    return true;
  }
}
