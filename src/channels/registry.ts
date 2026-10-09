// 渠道注册表与启动装载（docs/architecture/03-channels-v2/spec.md「接口与数据流」的 registry.ts 与启动顺序、R1、R7 的哨兵、R8、R15、
// R19、不变量 13、14）。
// initChannels 在 initSessionStore 之后、监听之前调一次：判企微状态（文件存储 / 未导入 / 已导出 / 在库里），按状态拼账号、解密、
// 查标记文件与恢复哨兵，六个拒绝原因以 ChannelStartupError reject。所有检查都在「装上」之前做完：拒绝时注册表与账号表还是空的、
// 标记没写、哨兵没删、cursor（文件或库里的）不动——库只读、不写，文件只在装上之后才动。
// startChannels 在监听之后、任务与跟进扫描器之前调：这一步只起 env 账号的 02 老路（startWecom）；库里账号的运行时第 7 步接上。
import { retireEnvAccount, startWecom } from '../adapters/wecom.js';
import { withTenant, type Db } from '../db/client.js';
import { listChannelAccounts, type ChannelAccountRow } from '../db/repo/channel-accounts.js';
import { readOpenInbox, type InboxRecord } from '../db/repo/channel-inbox.js';
import { readOpenOutbound, type OpenOutboundRow } from '../db/repo/outbound.js';
import { profile } from '../profile.js';
import { varDir as storeVarDir } from '../store.js';
import {
  accountFromRow,
  DEFAULT_WECOM_PREFIX,
  envAccountFrom,
  installAccounts,
  isEnabled,
  loadedAccounts,
  openAccountSecrets,
  type ChannelAccount,
} from './accounts.js';
import {
  CHANNELS_IN_DB_MARKER,
  hasChannelsMarker,
  hasRestoreSentinel,
  hasWecomStateFile,
  removeRestoreSentinel,
  RESTORE_SENTINEL,
  WECOM_STATE_FILE,
  writeChannelsMarker,
} from './markers.js';
import {
  CHANNEL_KEY_ENV,
  ChannelKeyError,
  ChannelSecretError,
  keyRingFromEnv,
  type KeyRing,
  type Redacted,
  type WecomSecrets,
} from './secrets.js';
import { ChannelStartupError } from './startup-error.js';

export { ChannelStartupError } from './startup-error.js';
export type { ChannelStartupReason } from './startup-error.js';

export interface ChannelDeps {
  db: Db;
  tenantId: string;
  /** 补写标记文件时记进 tenant */
  tenantSlug: string;
  varDir: string;
  /** channelKeyRing(process.env) 的结果：没设为 null，格式不对在那里就以 channel_key_invalid 拒绝 */
  keyRing: KeyRing | null;
}

/** 企微状态（R1）：file 是文件存储；db 存储下按库里本租户的 wecom_kf 行分三种 */
export type WecomState = 'file' | 'not_imported' | 'exported' | 'in_db';

/** 注册表里的一个启用账号：第 7 步的运行时、第 10 步的启动恢复从这里取 */
export interface LoadedChannel {
  account: ChannelAccount;
  /** 库里启用的企微账号解密后的凭据；env 账号（凭据在 env）与网页账号为 null */
  secrets: Redacted<WecomSecrets> | null;
  /** 库里企微账号的 cursor（null 表示冷启动）；env 账号的 cursor 在 var/wecom-cursor.json，这里为 null */
  cursor: string | null;
  /** 启动时没结束的入站行，按 ord（入站恢复用）；只有库里启用的企微账号有 */
  openInbox: readonly InboxRecord[];
  /** 启动时没结果的出站行（pending、sending）（出站恢复用）；默认账号（前缀 wecom:）连带 account_id 为空的行 */
  openOutbound: readonly OpenOutboundRow[];
}

interface Registry {
  /** /healthz 的 channels.mode：企微状态在库里是 db，其余（文件存储、未导入、已导出）是 env */
  mode: 'env' | 'db';
  wecomState: WecomState;
  /** 启用的账号，按账号 uuid */
  channels: ReadonlyMap<string, LoadedChannel>;
  /** 启动时的告警（只有账号 key 与原因）：网页账号因 web_channel 关着没启用、欢迎语不合格按没设处理 */
  warnings: readonly string[];
}

let registry: Registry | null = null;

/** 装载的结果：检查全部通过之后才由 commit 装上；effects 是装上之后才做的文件动作（补写标记、删哨兵），失败只记日志 */
interface Plan extends Registry {
  accounts: ChannelAccount[];
  logs: string[];
  effects: (() => void)[];
}

const SYSTEM_ACTOR = { kind: 'system' as const, userId: null, name: null, ip: null };

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.name : 'unknown');

/** 读 app 的 env 里的密钥环（R9）：没设返回 null；格式不对以 channel_key_invalid 拒绝（只说第几项哪里不对，不带值） */
export function channelKeyRing(env: Readonly<Record<string, string | undefined>>): KeyRing | null {
  try {
    return keyRingFromEnv(env);
  } catch (e) {
    if (e instanceof ChannelKeyError) {
      throw new ChannelStartupError(
        'channel_key_invalid',
        `${CHANNEL_KEY_ENV} 格式不对（${e.message}）：应为 <id>:<base64 的 32 字节>，几把用逗号隔开、第一把用来加密`,
      );
    }
    throw e;
  }
}

const loadedOf = (account: ChannelAccount, extra: Partial<LoadedChannel> = {}): LoadedChannel => ({
  account,
  secrets: null,
  cursor: null,
  openInbox: [],
  openOutbound: [],
  ...extra,
});

/** 渠道状态在文件里（文件存储、未导入、已导出）时有恢复哨兵：恢复照 02，只记一行并删掉它（R7） */
function dropSentinel(varDir: string, state: string): () => void {
  return () => {
    try {
      removeRestoreSentinel(varDir);
      console.log(`[channels] 有恢复哨兵 ${RESTORE_SENTINEL}：企微状态${state}，渠道状态在文件里、恢复照 02，已删掉`);
    } catch (e) {
      console.error(`[channels] ⚠️ 有恢复哨兵 ${RESTORE_SENTINEL}（企微状态${state}），删不掉（${errCode(e)}）：下次启动再删`);
    }
  };
}

/** 网页账号：db 存储下库里有 web 行就有（R1）；web_channel 关着时启用的带 inactiveReason，记一条告警（R15） */
function webAccountsOf(rows: readonly ChannelAccountRow[], tenantId: string, warn: (w: string) => void): ChannelAccount[] {
  const webChannel = profile().flags.web_channel;
  const out = rows.filter((r) => r.kind === 'web').map((r) => accountFromRow(tenantId, r, { webChannel, warn }));
  for (const a of out) if (a.status === 'active' && a.inactiveReason) warn(`网页账号 ${a.key} 没有启用：${a.inactiveReason}`);
  return out;
}

/** 文件存储（deps 为 null）：标记文件在就拒绝；否则 WECOM_* 配齐时拼一个 env 账号，状态在 var/wecom-cursor.json（照 02） */
function planFileStore(varDir: string): Plan {
  if (hasChannelsMarker(varDir)) {
    throw new ChannelStartupError(
      'channel_state_in_db',
      `文件存储下 ${varDir} 里有 ${CHANNELS_IN_DB_MARKER}：企微状态在库里，要回到文件存储先跑 channel-export`,
    );
  }
  const env = envAccountFrom(process.env, '');
  const effects: (() => void)[] = [];
  if (hasRestoreSentinel(varDir)) effects.push(dropSentinel(varDir, '在文件存储下'));
  return {
    mode: 'env',
    wecomState: 'file',
    accounts: env ? [env] : [],
    channels: new Map(env ? [[env.id, loadedOf(env)]] : []),
    warnings: [],
    logs: [
      env ? '[channels] 文件存储：企微走 env 账号，状态在 var/wecom-cursor.json（照 02）' : '[channels] 文件存储：WECOM_* 没配齐，不起企微',
    ],
    effects,
  };
}

/** db 存储：读本租户的全部账号（一个只读快照），按 R1 判企微状态 */
async function planDbStore(deps: ChannelDeps): Promise<Plan> {
  const { db, tenantId, varDir } = deps;
  // 账号与启用企微账号没结束的入站、出站行在同一个快照里读：只读，库里什么都不改（拒绝时 cursor 也就不动）
  const { rows, open } = await withTenant(
    db,
    { tenantId, actor: SYSTEM_ACTOR },
    async (tx) => {
      const rows = await listChannelAccounts(tx);
      const wecom = rows.filter((r) => r.kind === 'wecom_kf');
      const open = new Map<string, { inbox: InboxRecord[]; outbound: OpenOutboundRow[] }>();
      if (wecom.some((r) => r.status !== 'exported')) {
        for (const r of wecom.filter((x) => x.status === 'active')) {
          const inbox = await readOpenInbox(tx, r.id);
          // 默认账号（前缀 wecom:）连带 account_id 为空的行：02 的旧行与「NULL 表示默认账号」的写法
          const outbound = [
            ...(await readOpenOutbound(tx, r.id)),
            ...(r.idPrefix === DEFAULT_WECOM_PREFIX ? await readOpenOutbound(tx, null) : []),
          ];
          open.set(r.id, { inbox, outbound });
        }
      }
      return { rows, open };
    },
    { readOnly: true, isolation: 'repeatable read' },
  );

  const warnings: string[] = [];
  const warn = (w: string): void => void warnings.push(w);
  const wecomRows = rows.filter((r) => r.kind === 'wecom_kf');
  const webAccounts = webAccountsOf(rows, tenantId, warn);
  const webChannels = webAccounts.filter(isEnabled).map((a): [string, LoadedChannel] => [a.id, loadedOf(a)]);

  // ---- 未导入（一行企微账号都没有）、已导出（全部是 exported）：照 02 走 env 账号与文件状态 ----
  const state: WecomState =
    wecomRows.length === 0 ? 'not_imported' : wecomRows.every((r) => r.status === 'exported') ? 'exported' : 'in_db';
  if (state !== 'in_db') {
    if (hasChannelsMarker(varDir)) {
      throw new ChannelStartupError(
        'channel_state_in_db',
        state === 'exported'
          ? `默认企微账号已是 exported，${varDir} 里还有 ${CHANNELS_IN_DB_MARKER}：导出没做完，重跑 channel-export，或 channel-import --resync 切回库里`
          : `库里没有企微账号，${varDir} 里却有 ${CHANNELS_IN_DB_MARKER}：标记与库对不上（库是不是恢复成了导入之前的备份？），核对之后重跑 channel-import`,
      );
    }
    const env = envAccountFrom(process.env, tenantId);
    const label = state === 'not_imported' ? '未导入（库里没有企微账号）' : `已导出（默认账号 ${wecomRows[0]!.key} 是 exported）`;
    const effects: (() => void)[] = [];
    if (hasRestoreSentinel(varDir)) effects.push(dropSentinel(varDir, state === 'not_imported' ? '未导入' : '已导出'));
    return {
      mode: 'env',
      wecomState: state,
      accounts: [...(env ? [env] : []), ...webAccounts],
      channels: new Map([...(env ? [[env.id, loadedOf(env)] as [string, LoadedChannel]] : []), ...webChannels]),
      warnings,
      logs: [`[channels] 企微状态：${label}，照 02 走 env 账号与 var/wecom-cursor.json${env ? '' : '；WECOM_* 没配齐，不起企微'}`],
      effects,
    };
  }

  // ---- 在库里（有任何一行不是 exported）：只用库里的账号，env 的 WECOM_* 一律忽略 ----
  const active = wecomRows.filter((r) => r.status === 'active');
  if (active.length && !deps.keyRing) {
    throw new ChannelStartupError(
      'channel_key_missing',
      `库里有启用的企微账号（${active.map((r) => r.key).join('、')}），app 的 env 文件里没有 ${CHANNEL_KEY_ENV}：补上加密时用的那把（已轮换掉的从离线保管处取回）`,
    );
  }
  const secrets = new Map<string, Redacted<WecomSecrets>>();
  for (const r of active) {
    try {
      secrets.set(r.id, openAccountSecrets(deps.keyRing!, tenantId, r));
    } catch (e) {
      // ChannelSecretError 的 message 只有 key id 与失败类别；这里拼上账号 key，不带密文与明文
      if (e instanceof ChannelSecretError) {
        throw new ChannelStartupError(
          'channel_decrypt',
          `账号 ${r.key} 的凭据解不开（${e.message}）：密文被改过或换了行，或密钥环里没有、换掉了 key id 为 ${e.keyId} 的那把`,
        );
      }
      throw e;
    }
  }
  const sentinel = hasRestoreSentinel(varDir);
  if (sentinel && active.length) {
    throw new ChannelStartupError(
      'channel_restore_pending',
      `${varDir} 里有恢复哨兵 ${RESTORE_SENTINEL}：从备份恢复之后还没跑 channel-account restore-cutoff（恢复手册），跑完再起`,
    );
  }
  const marker = hasChannelsMarker(varDir);
  if (hasWecomStateFile(varDir) && !marker) {
    throw new ChannelStartupError(
      'channel_state_in_file',
      `库里有企微账号，${varDir} 里还有没导入的 ${WECOM_STATE_FILE}：跑 channel-import（回退到 02 跑过一段就加 --resync）`,
    );
  }

  const wecomAccounts = wecomRows.map((r) => accountFromRow(tenantId, r, { webChannel: profile().flags.web_channel, warn }));
  const channels = new Map<string, LoadedChannel>();
  for (const r of active) {
    const account = wecomAccounts.find((a) => a.id === r.id)!;
    const o = open.get(r.id);
    channels.set(
      r.id,
      loadedOf(account, { secrets: secrets.get(r.id)!, cursor: r.cursor, openInbox: o?.inbox ?? [], openOutbound: o?.outbound ?? [] }),
    );
  }
  for (const [id, c] of webChannels) channels.set(id, c);

  const effects: (() => void)[] = [];
  if (!marker) {
    const def = wecomRows.find((r) => r.idPrefix === DEFAULT_WECOM_PREFIX) ?? wecomRows[0]!;
    effects.push(() => {
      try {
        writeChannelsMarker(varDir, { tenant: deps.tenantSlug, account: def.key, at: new Date().toISOString() });
        console.log(`[channels] 补写了 ${CHANNELS_IN_DB_MARKER}（企微状态在库里）`);
      } catch (e) {
        // 写不进去只记日志、照常启动：库里的状态本身是好的；回滚检查标记不在时会再问库（R19），下次启动再补
        console.error(`[channels] ⚠️ 补写 ${CHANNELS_IN_DB_MARKER} 失败（${errCode(e)}）：下次启动再补，回退到 02 之前先跑 channel-export`);
      }
    });
  }
  const logs = [
    `[channels] 企微状态：在库里（企微账号 ${wecomRows.length} 个，启用 ${active.length} 个），只用库里的账号` +
      // TODO(03 第 7 步)：库里账号按账号的运行时接上之后去掉后半句
      (active.length ? '；库里账号的收发这一版还没接上，不起企微' : ''),
  ];
  const ignored = Object.keys(process.env)
    .filter((k) => k.startsWith('WECOM_') && process.env[k])
    .toSorted();
  if (ignored.length) logs.push(`[channels] 企微状态在库里：忽略 env 里的 ${ignored.join('、')}（不读取）`);
  if (sentinel) {
    logs.push(
      `[channels] ⚠️ 有恢复哨兵 ${RESTORE_SENTINEL}、企微账号全部停用：照常起、不起企微，哨兵留着；启用账号之前先跑 channel-account restore-cutoff`,
    );
  }
  return {
    mode: 'db',
    wecomState: 'in_db',
    accounts: [...wecomAccounts, ...webAccounts],
    channels,
    warnings,
    logs,
    effects,
  };
}

/** 检查全部通过之后才装上：账号表、注册表、env 账号退场与否，再做文件动作、打日志 */
function commit(plan: Plan): void {
  installAccounts(plan.accounts);
  registry = { mode: plan.mode, wecomState: plan.wecomState, channels: plan.channels, warnings: plan.warnings };
  // 企微状态在库里：env 的老路整条关掉（不读 WECOM_*、不写 var/wecom-cursor.json，不变量 13）
  retireEnvAccount(plan.mode === 'db');
  for (const fx of plan.effects) fx();
  for (const line of plan.logs) console.log(line);
  for (const w of plan.warnings) console.warn(`[channels] ⚠️ ${w}`);
}

/**
 * boot() 在 initSessionStore 之后、serve 之前调。deps 为 null（文件存储）：var/ 下有 channels-in-db.json 就以 channel_state_in_db
 * reject；否则 WECOM_* 配齐时拼一个 env 账号（状态在文件）。db 存储：读本租户的全部账号，按 R1 判企微状态。
 * 未导入、已导出：var/ 下有标记文件 → channel_state_in_db（已导出时是导出没做完；未导入时是标记与库对不上）；否则照 R1 拼 env 账号，
 * 有恢复哨兵就只记一行并删掉它。在库里：有 active 的企微账号而没有密钥环 → channel_key_missing；逐个解密 active 的，解不开 →
 * channel_decrypt；var/ 下有恢复哨兵而有 active 的企微账号 → channel_restore_pending（没有 active 的：照常起、不起企微、哨兵留着、
 * 日志一行）；var/ 下有 wecom-cursor.json、没有标记文件 → channel_state_in_file；补写标记文件（写不进去只记日志），按 R15、R19 判定
 * 每个账号的 inactiveReason 与欢迎语，读出每个启用企微账号没结束的入站行与没结果的出站行。任何一步失败都不留半装载状态
 */
export async function initChannels(deps: ChannelDeps | null): Promise<void> {
  if (registry) throw new Error('initChannels 只能调一次');
  const plan = deps === null ? planFileStore(storeVarDir()) : await planDbStore(deps);
  commit(plan);
}

/**
 * 监听成功之后、任务与跟进扫描器之前调。这一步：env 账号（文件存储、未导入、已导出时 WECOM_* 配齐）起 02 的企微拉取（startWecom）；
 * 企微状态在库里时不起企微
 */
export function startChannels(): void {
  if (!registry) return;
  if (registry.mode === 'env') {
    if ([...registry.channels.values()].some((c) => c.account.source === 'env')) startWecom();
    return;
  }
  // TODO(03 第 7 步)：每个启用的库里企微账号起一个 WecomRuntime（按账号 uuid 建键，凭据与 cursor 取 loadedChannels()），先做启动恢复
  // （第 10 步：出站恢复、再入站恢复，用 openOutbound、openInbox），做完才开始拉取。这一版不起，也不让它们临时走 env 的老路
}

/** 装上的企微状态；还没装载（自测、eval）时为 null */
export function wecomState(): WecomState | null {
  return registry?.wecomState ?? null;
}

/** 企微状态在库里是 db，其余是 env；还没装载时按 env（02 的老路） */
export function channelsMode(): 'env' | 'db' {
  return registry?.mode ?? 'env';
}

/** 启用的账号（按账号 uuid）与它们的启动数据 */
export function loadedChannels(): ReadonlyMap<string, LoadedChannel> {
  return registry?.channels ?? new Map();
}

/** 装载时的告警（只有账号 key 与原因），startAlerts 以 channel 键推一条 */
export function channelStartupWarnings(): readonly string[] {
  return registry?.warnings ?? [];
}

/**
 * /healthz 的 channels：只有个数，不带 key 与任何标识。accounts 是启用的账号数（env 账号与库里的，企微与网页都算）。
 * TODO(03 第 13 步)：failing（连续 10 分钟拉取失败或取不到 token 的启用企微账号数）、stuck（有入站行没结束超过 5 分钟的账号数）接实数
 */
export function channelsHealth(): { mode: 'env' | 'db'; accounts: number; failing: number; stuck: number } {
  return { mode: channelsMode(), accounts: loadedAccounts().filter(isEnabled).length, failing: 0, stuck: 0 };
}

/** 仅供自测：清回还没装载的样子（账号表清空、env 账号回到 02 的老路） */
export const __channelsTest = {
  reset(): void {
    registry = null;
    installAccounts([]);
    retireEnvAccount(false);
  },
};
