import { publicBase } from '../tenancy/hosts.js';
import { currentRuntime, withoutTenantScope, tenantCallback, TenantScopeMissing } from '../tenancy/runtime.js';
import { TenantLocal } from '../tenancy/local-state.js';
import { registerTenantState } from '../tenancy/state.js';
// 隐私说明（docs/architecture/02-conversations-workbench/spec.md「隐私说明、敏感信息同意、保留期与行权」，R23）。
// DB 配置模式下：boot() 在 initConfig 成功之后调 initPrivacy() 读进内存，之后 startPrivacyPoll() 起一个 60 秒的后台轮询——
// 对话的轮次、GET /privacy、欢迎语都只读内存（不变量 9：读路径不发数据库查询），发布本身由平台命令行 privacy-publish 执行。
// 文件配置模式（demo）下 currentPrivacyNotice() 恒为 null：不发布隐私说明、不发同意菜单、欢迎语逐字节不变（不变量 40）。
import { configMode, configRuntime } from '../config/source.js';
import { withTenant } from '../db/client.js';
import { readLatestPrivacyNotice } from '../db/repo/privacy.js';

export interface PrivacyNotice {
  version: number;
  body: string;
}

const notices = new TenantLocal(
  () => ({ current: null as PrivacyNotice | null, pollTimer: null as NodeJS.Timeout | null }),
  (s) => {
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.pollTimer = null;
    s.current = null;
  },
);
registerTenantState({ name: 'privacy.current', ...notices.registration((s) => Number(s.current !== null)) });
registerTenantState({ name: 'privacy.pollTimer', ...notices.registration((s) => Number(s.pollTimer !== null)) });

const systemActor = (tenantId: string) => ({ tenantId, actor: { kind: 'system' as const, userId: null, name: 'privacy-poll', ip: null } });

async function refresh(): Promise<void> {
  const rt = currentRuntime();
  const state = notices.get(rt);
  const { db, tenantId } = configRuntime();
  const row = await withTenant(db, systemActor(tenantId), (tx) => readLatestPrivacyNotice(tx), { readOnly: true });
  if (!notices.owns(rt, state)) return;
  state.current = row ? { version: row.version, body: row.body } : null;
}

/** boot() 在 initConfig 成功之后调一次（db 模式；文件模式什么都不做，current 保持 null） */
export async function initPrivacy(): Promise<void> {
  const rt = currentRuntime();
  const state = notices.get(rt);
  if (configMode() !== 'db') {
    state.current = null;
    return;
  }
  try {
    await refresh();
  } catch (e) {
    if (e instanceof TenantScopeMissing) throw e;
    if (!notices.owns(rt, state)) return;
    console.error('[privacy] 启动读取隐私说明失败（先当没发布过，60 秒后重试）:', e instanceof Error ? e.message : e);
    state.current = null;
  }
}

/** 之后每 60 秒在后台查一次（不在对话的轮次里）；文件模式什么都不做。可以调多次，只起一次定时器 */
export function startPrivacyPoll(intervalMs = 60_000): void {
  const rt = currentRuntime();
  const state = notices.get(rt);
  if (rt.kind !== 'standard' || process.env.APP_ROLE === 'sandbox' || configMode() !== 'db' || state.pollTimer) return;
  state.pollTimer = withoutTenantScope(() =>
    setInterval(
      tenantCallback(rt, () =>
        !notices.owns(rt, state)
          ? undefined
          : rt.inflight.track(refresh()).catch((e: unknown) => {
              if (e instanceof TenantScopeMissing) throw e;
              console.error('[privacy] 刷新隐私说明失败（保留上一次的结果）:', e instanceof Error ? e.message : e);
            }),
      ),
      intervalMs,
    ),
  );
  state.pollTimer.unref();
}

/** GET /privacy、欢迎语、同意记录的 notice_version 都从这里取；没发布过是 null */
export function currentPrivacyNotice(): PrivacyNotice | null {
  return notices.get().current;
}

/** 发布过时的 /privacy 完整链接；没发布过是 null */
export function privacyLink(): string | null {
  if (!notices.get().current) return null;
  const base = publicBase();
  return `${base}/privacy`;
}

/** 转义 HTML 特殊字符：GET /privacy 把纯文本正文包进页面之前过一遍 */
export function escapeHtml(t: string): string {
  return t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
}

/** 仅供自测 */
export const __privacyTest = {
  reset(): void {
    const state = notices.get();
    state.current = null;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  },
  set(n: PrivacyNotice | null): void {
    notices.get().current = n;
  },
  refresh,
  polling: (): boolean => notices.get().pollTimer !== null,
};
