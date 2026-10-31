// 11 R3 / R6：启动快照、租户隔离的单路队列与唯一的新鲜值定义。
import { AsyncLocalStorage } from 'node:async_hooks';
import { channelKeyRing } from '../channels/registry.js';
import type { KeyRing } from '../channels/secrets.js';
import { currentPack } from '../config/source.js';
import type { PackSources } from '../core/pack-api.js';
import { withTenant, type Db } from '../db/client.js';
import { readErpConnector, listErpItemLinks, type ErpConnectorRow, type ErpItemLink } from '../db/repo/erp.js';
import { createEgress, EgressError } from '../net/egress.js';
import { alert, type AlertOpts } from '../ops/alert.js';
import { onShutdown } from '../shutdown.js';
import { scopedState } from '../tenancy/scoped-state.js';
import { registerTenantState } from '../tenancy/state.js';
import { currentRuntime, scopedRuntime, hostRuntime, tenantRuntimes, withTenantScope, withoutTenantScope } from '../tenancy/runtime.js';
import { createOdooConnector } from './odoo.js';
import { openConnectorSecrets } from './secrets.js';
import { ErpError, type Availability, type ErpConnector, type ErpErrorCode } from './types.js';

interface TurnStats {
  ms: number;
  cacheHit: boolean;
  deadlineReached: boolean;
}
interface Turn {
  deadline?: number;
  stats: TurnStats;
  waits: [number, number][];
  /** 本轮 availability 给出过的结果，含没取到：同一轮工具、订单行、自动批准与护栏看到同一份（不变量 8）。 */
  seen: Map<string, Availability | undefined>;
}
const turns = new AsyncLocalStorage<Turn>();

/** 只由声明 erp 的包进入；截止时间从第一次缓存未命中开始，共享到整轮结束。 */
export function withErpTurn<T>(fn: () => T): T {
  return turns.run({ stats: { ms: 0, cacheHit: true, deadlineReached: false }, waits: [], seen: new Map() }, fn);
}
export function erpTurnStats(): Readonly<TurnStats> | undefined {
  const turn = turns.getStore();
  return turn ? { ...turn.stats } : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}
const deps = {
  now: () => Date.now(),
  sleep,
  factory: createOdooConnector,
  alert: (text: string, opts: AlertOpts) => alert('erp', text, opts),
};
interface Waiter {
  codes: Set<string>;
  deadline: number;
  finish(): void;
}
interface Loaded {
  connector: ErpConnector;
  links: Map<string, ErpItemLink>;
  cache: Map<string, { at: number; value?: Availability }>;
  pending: Set<Waiter>;
  lastStart: number;
  pumping: boolean;
  cooldownUntil: number;
  failure: string | null;
  expiry: string;
  expirySent: Set<number>;
  closed: boolean;
  wake: AbortController | null;
}
function dispose(loaded: Loaded | null): void {
  if (!loaded) return;
  loaded.closed = true;
  loaded.wake?.abort();
  for (const waiter of loaded.pending) waiter.finish();
  loaded.cache.clear();
  loaded.links.clear();
}
const tenantState = scopedState(() => ({ loaded: null as Loaded | null }), { loaded: dispose });
const state = tenantState.get;
registerTenantState({ name: 'erp.registry.loaded', ...tenantState.registration('loaded') });

let expiryTimer: ReturnType<typeof setInterval> | null = null;
export function stopErp(): void {
  if (expiryTimer) clearInterval(expiryTimer);
  expiryTimer = null;
  for (const rt of tenantState.owners()) dispose(tenantState.peek(rt)?.loaded ?? null);
}
withoutTenantScope(() => onShutdown(stopErp));

function notify(code: string, text: string, opts: AlertOpts = {}): void {
  deps.alert(`${currentRuntime().slug} ${code} ${text}`, { scope: 'runtime', ...opts });
}
function transition(loaded: Loaded, code: string | null): void {
  if (loaded.failure === code) return;
  const previous = loaded.failure;
  loaded.failure = code;
  if (code === null) {
    if (previous) notify('ok', '已恢复', { resolved: true });
    return;
  }
  const text =
    code === 'auth'
      ? 'API key 无效或已到期，请 set-secrets'
      : code === 'forbidden'
        ? '机器人用户缺少读产品或库存的权限'
        : code === 'not_found' || code === 'invalid'
          ? '连接器配置与 Odoo 不符'
          : 'ERP 库存暂不可用';
  notify(code, text, { escalate: true });
}
function checkExpiryInScope(): void {
  const loaded = state().loaded;
  if (!loaded || loaded.closed) return;
  const today = new Date(deps.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const days = (Date.parse(loaded.expiry.slice(0, 10)) - Date.parse(today)) / 86400_000;
  for (const threshold of [14, 3]) {
    if (days > threshold || loaded.expirySent.has(threshold)) continue;
    loaded.expirySent.add(threshold);
    notify(`key_expiry_${threshold}`, 'API key 即将到期，请 set-secrets', { scope: `key_expiry_${threshold}` });
  }
}
function checkExpiries(): void {
  for (const rt of tenantState.owners()) if (rt.kind === 'standard' && rt.state === 'serving') withTenantScope(rt, checkExpiryInScope);
}

export interface ErpDeps {
  db: Db;
  keyRing: KeyRing | null;
}
/** 宿主逐租户装载，和 channels 一样只用启动时的快照；运行中不读数据库。 */
export async function initErp(): Promise<void> {
  const owner = scopedRuntime() ?? hostRuntime();
  const runtimes = owner.isHost ? [owner, ...tenantRuntimes().filter((rt) => rt !== owner)] : [owner];
  for (const rt of runtimes) {
    if (rt.kind !== 'standard' || rt.state !== 'serving' || !rt.config.loaded || !rt.store.pgBackend || tenantState.peek(rt)?.loaded)
      continue;
    await withTenantScope(rt, () => initErpInScope({ db: rt.config.loaded!.deps.db, keyRing: channelKeyRing(process.env) }));
  }
  if (!expiryTimer && tenantState.owners().some((rt) => tenantState.peek(rt)?.loaded)) {
    expiryTimer = withoutTenantScope(() => setInterval(checkExpiries, 86400_000));
    expiryTimer.unref();
  }
}
export async function initErpInScope(input: ErpDeps | null): Promise<void> {
  if (!input || currentRuntime().kind !== 'standard') return;
  const tenantId = currentRuntime().id;
  const snapshot = await withTenant(
    input.db,
    { tenantId, actor: { kind: 'system', userId: null, name: null, ip: null } },
    async (tx) => {
      const row = await readErpConnector(tx);
      return { row, links: row?.status === 'active' ? await listErpItemLinks(tx, row.id) : [] };
    },
    { readOnly: true, isolation: 'repeatable read' },
  );
  install(snapshot.row, snapshot.links, input.keyRing);
}
function install(row: ErpConnectorRow | null, links: readonly ErpItemLink[], ring: KeyRing | null): void {
  dispose(state().loaded);
  state().loaded = null;
  if (!row || row.status !== 'active' || currentRuntime().kind !== 'standard') return;
  let connector: ErpConnector;
  try {
    if (!ring) throw new ErpError('auth');
    const apiKey = openConnectorSecrets(ring, { tenantId: currentRuntime().id, connectorId: row.id }, row.secretsCt, row.secretsKeyId);
    const send = createEgress(row.baseUrl);
    connector = deps.factory({
      send,
      apiKey,
      database: row.database,
      locationId: row.settings.locationId,
      now: deps.now,
      sleep: deps.sleep,
    });
  } catch (error) {
    notify(error instanceof ErpError ? error.code : error instanceof EgressError ? 'egress' : 'auth', '连接器已停用', { scope: 'startup' });
    return;
  }
  state().loaded = {
    connector,
    links: new Map(links.map((link) => [`${link.kind}:${link.code}`, link])),
    cache: new Map(),
    pending: new Set(),
    lastStart: -Infinity,
    pumping: false,
    cooldownUntil: 0,
    failure: null,
    expiry: row.settings.keyExpiresAt,
    expirySent: new Set(),
    closed: false,
    wake: null,
  };
  checkExpiryInScope();
}
function loadedFor(kind: string): Loaded | null {
  const rt = currentRuntime();
  const loaded = state().loaded;
  if (rt.kind !== 'standard' || !loaded || loaded.closed || currentPack().runtime.erp?.kind !== kind) return null;
  return loaded;
}
function fresh(kind: string, code: string): Availability | undefined {
  const loaded = loadedFor(kind);
  const key = `${kind}:${code}`;
  const turn = turns.getStore();
  if (loaded && turn?.seen.has(key)) return turn.seen.get(key);
  const cached = loaded?.cache.get(key);
  return cached && deps.now() - cached.at <= 60_000 ? cached.value : undefined;
}
function prune(loaded: Loaded): void {
  for (const waiter of loaded.pending) if (waiter.deadline <= deps.now()) waiter.finish();
}
async function pump(loaded: Loaded): Promise<void> {
  // 同一拍进入的调用先合并；队列运行期间的调用并入下一批。
  await Promise.resolve();
  try {
    while (!loaded.closed) {
      prune(loaded);
      if (!loaded.pending.size) break;
      if (deps.now() < loaded.cooldownUntil) {
        for (const waiter of loaded.pending) waiter.finish();
        break;
      }
      const nextAt = Math.max(deps.now(), loaded.lastStart + 1000);
      for (const waiter of loaded.pending) if (nextAt >= waiter.deadline) waiter.finish();
      if (!loaded.pending.size) break;
      if (nextAt > deps.now()) {
        const wake = new AbortController();
        loaded.wake = wake;
        await deps.sleep(nextAt - deps.now(), wake.signal);
        loaded.wake = null;
        continue;
      }
      const codes = [...new Set([...loaded.pending].flatMap((waiter) => [...waiter.codes]))].slice(0, 30);
      const batch = [...loaded.pending].filter((waiter) => codes.some((code) => waiter.codes.has(code)));
      const deadline = Math.max(...batch.map((waiter) => waiter.deadline));
      const ids = [...new Set(codes.map((code) => loaded.links.get(code)!.remoteId))];
      const start = deps.now();
      loaded.lastStart = start;
      let outcome = 'ok';
      try {
        const result = await loaded.connector.stock(ids, deadline);
        if (loaded.closed) return;
        let missing = 0;
        for (const code of codes) {
          const link = loaded.links.get(code)!;
          const row = result.get(link.remoteId);
          const at = deps.now();
          if (!row || !row.active || row.uomId !== link.remoteUomId) {
            loaded.cache.set(code, { at });
            missing++;
          } else {
            const value = Object.freeze({ onHand: Math.max(0, Math.floor(row.freeQty)), at });
            loaded.cache.set(code, { at, value });
          }
        }
        // 单个产品读不到不是连接器故障：只计数告警，不进健康状态，否则含它与不含它的批次会来回「不可用 / 已恢复」。
        transition(loaded, null);
        if (missing) {
          console.warn(`[erp] ${currentRuntime().slug} search_read ${missing} ${deps.now() - start} unmapped`);
          notify('unmapped', `${missing} 个已映射的产品在 ERP 里读不到，按未映射处理`, { scope: 'unmapped' });
        }
      } catch (error) {
        if (loaded.closed) return;
        const code: ErpErrorCode = error instanceof ErpError ? error.code : 'egress';
        outcome = code;
        loaded.cooldownUntil = deps.now() + (['auth', 'forbidden', 'not_found', 'invalid'].includes(code) ? 600_000 : 30_000);
        transition(loaded, code);
      }
      console.log(`[erp] ${currentRuntime().slug} search_read ${ids.length} ${deps.now() - start} ${outcome}`);
      for (const waiter of loaded.pending) {
        for (const code of codes) waiter.codes.delete(code);
        if (!waiter.codes.size) waiter.finish();
      }
    }
  } finally {
    loaded.pumping = false;
  }
}
async function availability(kind: string, codes: readonly string[]): Promise<ReadonlyMap<string, Availability>> {
  const loaded = loadedFor(kind);
  if (!loaded) return new Map();
  const unique = [...new Set(codes)];
  const turn = turns.getStore();
  const needed = unique
    .map((code) => `${kind}:${code}`)
    .filter((key) => {
      if (!loaded.links.has(key) || turn?.seen.has(key)) return false;
      const cached = loaded.cache.get(key);
      return !cached || deps.now() - cached.at > (cached.value ? 30_000 : 60_000);
    });
  if (turn && needed.length) turn.stats.cacheHit = false;
  const start = deps.now();
  const deadline = needed.length ? (turn ? (turn.deadline ??= start + 1000) : start + 5000) : start;
  if (needed.length && deps.now() >= loaded.cooldownUntil) {
    // 可算出下一次发起不及截止时刻时，直接退回，连计时器都不建。
    if (Math.max(start, loaded.lastStart + 1000) < deadline) {
      await new Promise<void>((resolve) => {
        const timer = new AbortController();
        const waiter: Waiter = {
          codes: new Set(needed),
          deadline,
          finish() {
            loaded.pending.delete(waiter);
            if (!loaded.pending.size) loaded.wake?.abort();
            timer.abort();
            resolve();
          },
        };
        loaded.pending.add(waiter);
        void deps.sleep(deadline - start, timer.signal).then(() => {
          if (!loaded.pending.has(waiter)) return;
          if (turn && deps.now() >= deadline) turn.stats.deadlineReached = true;
          waiter.finish();
        });
        if (!loaded.pumping) {
          loaded.pumping = true;
          void pump(loaded);
        }
      });
    }
    if (turn) {
      turn.waits.push([start, deps.now()]);
      let end = -Infinity;
      turn.stats.ms = 0;
      for (const [from, to] of turn.waits.toSorted((a, b) => a[0] - b[0])) {
        turn.stats.ms += Math.max(0, to - Math.max(from, end));
        end = Math.max(end, to);
      }
      turn.stats.deadlineReached ||= deps.now() >= deadline;
    }
  }
  return new Map(
    unique.flatMap((code) => {
      const value = fresh(kind, code);
      turn?.seen.set(`${kind}:${code}`, value);
      return value ? [[code, value] as const] : [];
    }),
  );
}
export const erpSources: PackSources['erp'] = {
  active: (kind) => loadedFor(kind) !== null,
  mapped: (kind, code) => loadedFor(kind)?.links.has(`${kind}:${code}`) ?? false,
  availability,
  fresh,
};

/** 自测只替换依赖与启动快照；请求、排队、冷却均走生产路径。 */
export const __erpTest = {
  configure(input: Partial<typeof deps>): void {
    Object.assign(deps, input);
  },
  install,
  checkExpiries,
  stop: stopErp,
  reset(): void {
    stopErp();
    tenantState.registration('loaded').reset();
    Object.assign(deps, {
      now: () => Date.now(),
      sleep,
      factory: createOdooConnector,
      alert: (text: string, opts: AlertOpts) => alert('erp', text, opts),
    });
  },
};
