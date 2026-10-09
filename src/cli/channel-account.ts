// 03 第 15 步：以 agent_app 身份管理渠道账号，应用须已停，改完重启生效。
// docker compose stop app
// docker compose run --rm app node --import tsx src/cli/channel-account.ts list --tenant demo
// 凭据只从 0600 文件或无回显终端读取，不接受凭据参数。退出码：0 成功/无操作，1 用法/读写错误，2 数据不一致，3 租户锁被占。
// 03 第 12 步：restore-cutoff --tenant <slug> --until <带时区的 ISO 时刻|now> [--var <var 目录>]，从备份恢复之后、起应用之前跑
// （R7、spec「重启、崩溃与恢复 · 恢复截止点」、不变量 9、14）：一个事务里写全部企微账号的 record_only_until、截止点之前建的出站
// pending 记 cancelled、sending 记 unknown、run_at 不晚于它的 pending 与 running 跟进记 cancelled、涉及的会话各加一条说明、审计一行；
// 提交之后删恢复哨兵。var/ 里有没回放的 spill 以 2 拒绝。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  accountFromRow,
  checkWelcomeText,
  openAccountSecrets,
  WEB_CHANNEL_OFF_REASON,
  WEB_DEFAULT_DAILY_NEW,
  WEB_DEFAULT_DAILY_TURNS,
} from '../channels/accounts.js';
import { hasRestoreSentinel, removeRestoreSentinel, RESTORE_SENTINEL } from '../channels/markers.js';
import { CHANNEL_KEY_ENV, Redacted, keyRingFromEnv, sealSecrets, type KeyRing, type WecomSecrets } from '../channels/secrets.js';
import { holdTenantLock, openDb, withTenant, type Db, type TenantLock, type Tx } from '../db/client.js';
import { writeAudit, type AuditEntry } from '../db/repo/audit.js';
import { insertChannelAccount, listChannelAccounts, updateChannelAccount, type ChannelAccountPatch } from '../db/repo/channel-accounts.js';
import { readOpenInboxUntil } from '../db/repo/channel-inbox.js';
import { appendSystemNote } from '../db/repo/conversations.js';
import { cancelFollowupsUntil } from '../db/repo/jobs.js';
import { readOpenOutboundUntil, transitionOutbound } from '../db/repo/outbound.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { profile } from '../profile.js';
import { SPILL_FILE_RE } from '../store/project.js';

const USAGE = 'channel-account <list|add-wecom|add-web|set-secrets|set|rekey|restore-cutoff> --tenant <slug> …';
/** --until 至多比命令行的当前时刻晚这么多（两台机器的钟差）；写明天以 1 拒绝 */
const UNTIL_SKEW_MS = 5 * 60_000;
const SECRET_FIELDS = ['appSecret', 'callbackToken', 'callbackAesKey'] as const;
const CREATE_FIELDS = ['corpId', 'openKfId', ...SECRET_FIELDS] as const;

class CliError extends Error {
  constructor(
    readonly code: 1 | 2 | 3,
    message: string,
  ) {
    super(message);
  }
}
function fail(message: string, code: 1 | 2 | 3 = 1): never {
  throw new CliError(code, message);
}

function required(value: string | undefined, field: string): string {
  if (!value) fail(`缺少 ${field}；用法：${USAGE}`);
  return value;
}

/** 名称与初始网页标题共用账号 name 的 1–40 字限制；不回显用户输入。 */
function shortText(value: string, field: string): string {
  const text = value.trim();
  if (!text || [...text].length > 40) fail(`${field} 须为 1–40 个字符`);
  return text;
}

const UNTIL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * --until（spec「恢复截止点」、验收 22）：now 取命令行的当前时刻；否则必须是带时区（Z 或 ±hh:mm）的 ISO 时刻，各字段在范围内，
 * 且不晚于当前时刻 5 分钟。只按字段算出绝对时刻，不经本机时区。拒绝时不回显输入
 */
export function parseUntil(value: string, now: number): Date {
  if (value === 'now') return new Date(now);
  const m = UNTIL_RE.exec(value);
  if (!m) fail('--until 须为带时区的 ISO 时刻（如 2026-10-09T03:00:00+08:00 或 2026-10-08T19:00:00Z）或 now；什么都没动');
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));
  const sign = m[8] === '-' ? -1 : 1;
  const oh = Number(m[9] ?? 0);
  const om = Number(m[10] ?? 0);
  const daysInMonth = mo >= 1 && mo <= 12 ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 0;
  // 2000 年之前不会是恢复截止点（也避开 Date.UTC 把 0–99 年当成 19xx 年）
  if (y < 2000 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59)
    fail('--until 的日期、时刻或时区超出范围；什么都没动');
  const at = Date.UTC(y, mo - 1, d, h, mi, s, ms) - sign * (oh * 60 + om) * 60_000;
  if (at > now + UNTIL_SKEW_MS)
    fail('--until 晚于现在：截止点取旧实例最后一次正常回复的时刻，拿不准取恢复开始的时刻（或写 now）；什么都没动');
  return new Date(at);
}

function parse(argv: string[]) {
  const command = argv[0];
  const now = Date.now();
  const options: NonNullable<ParseArgsConfig['options']> = { tenant: { type: 'string' } };
  switch (command) {
    case 'list':
    case 'rekey':
      break;
    case 'restore-cutoff':
      Object.assign(options, { until: { type: 'string' }, var: { type: 'string' } });
      break;
    case 'add-wecom':
      Object.assign(options, { key: { type: 'string' }, name: { type: 'string' }, 'secrets-file': { type: 'string' } });
      break;
    case 'add-web':
      Object.assign(options, { key: { type: 'string' }, title: { type: 'string' } });
      break;
    case 'set-secrets':
      Object.assign(options, { key: { type: 'string' }, 'secrets-file': { type: 'string' } });
      break;
    case 'set':
      Object.assign(options, {
        key: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string' },
        setting: { type: 'string', multiple: true },
      });
      break;
    default:
      fail(`子命令无效；用法：${USAGE}`);
  }
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    values = parseArgs({ args: argv.slice(1), options, strict: true, allowPositionals: false }).values;
  } catch {
    // parseArgs 的异常带原始参数，凭据误传进来时也不能回显。
    fail(`参数无效；用法：${USAGE}`);
  }
  const tenant = required(values.tenant as string | undefined, '--tenant');
  const key = values.key as string | undefined;
  const until = command === 'restore-cutoff' ? parseUntil(required(values.until as string | undefined, '--until'), now) : null;
  if (command !== 'list' && command !== 'rekey' && command !== 'restore-cutoff') {
    required(key, '--key');
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(key!)) fail('key 须匹配 ^[a-z][a-z0-9-]{1,30}$');
  }
  const name = values.name === undefined ? undefined : shortText(values.name as string, 'name');
  const title = values.title === undefined ? undefined : shortText(values.title as string, 'title');
  if (command === 'add-wecom') required(name, '--name');
  if (command === 'add-web') required(title, '--title');
  const status = values.status as 'active' | 'disabled' | undefined;
  if (status !== undefined && status !== 'active' && status !== 'disabled')
    fail('status 只接受 active 或 disabled；exported 由 channel-export 设置');
  return {
    command,
    tenant,
    key,
    name,
    title,
    status,
    settings: (values.setting ?? []) as string[],
    secretsFile: values['secrets-file'] as string | undefined,
    until,
    // 与应用同一个缺省（src/store.ts：VAR_DIR，否则工作目录下的 var/；容器里是 /app/var）
    varDir: (values.var as string | undefined) ?? process.env.VAR_DIR ?? path.resolve('var'),
  };
}

/** raw 模式下终端不回显；支持退格、Ctrl-U、Ctrl-C，退出/异常/信号都恢复原模式。 */
async function terminalSecrets(fields: readonly string[]): Promise<Record<string, string>> {
  const input = process.stdin;
  if (!input.isTTY || !input.setRawMode) fail('需要交互终端（docker compose run --rm -it app），或用 --secrets-file');
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  const decoder = new StringDecoder('utf8');
  const out: Record<string, string> = {};
  let value = '';
  let index = 0;
  let cleanup = () => {};
  input.setRawMode(true);
  input.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new CliError(1, '凭据输入已取消'));
      const onError = () => reject(new CliError(1, '终端读取失败'));
      const timer = setTimeout(() => reject(new CliError(1, '凭据输入超时；什么都没动')), 90000);
      const onData = (chunk: Buffer) => {
        for (const c of decoder.write(chunk)) {
          if (c === '\u0003' || c === '\u0004') {
            abort();
            return;
          }
          if (c === '\u007f' || c === '\b') value = [...value].slice(0, -1).join('');
          else if (c === '\u0015') value = '';
          else if (c === '\r' || c === '\n') {
            out[fields[index]!] = value;
            value = '';
            process.stderr.write('\n');
            index++;
            if (index === fields.length) {
              resolve();
              return;
            }
            process.stderr.write(`${fields[index]}: `);
          } else if (c >= ' ') value += c;
        }
      };
      input.on('data', onData);
      input.once('end', abort);
      input.once('error', onError);
      process.once('SIGTERM', abort);
      process.once('SIGHUP', abort);
      process.once('SIGINT', abort);
      // 清理绑定到 promise 的 finally：任何一条拒绝路径也移除监听。
      cleanup = () => {
        clearTimeout(timer);
        input.off('data', onData);
        input.off('end', abort);
        input.off('error', onError);
        process.off('SIGTERM', abort);
        process.off('SIGHUP', abort);
        process.off('SIGINT', abort);
      };
      process.stderr.write(`${fields[0]}: `);
    });
  } finally {
    cleanup();
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  }
  return out;
}

async function readSecrets(
  file: string | undefined,
  creating: boolean,
): Promise<Redacted<WecomSecrets & { corpId?: string; openKfId?: string }>> {
  const fields = creating ? CREATE_FIELDS : SECRET_FIELDS;
  let value: unknown;
  if (file !== undefined) {
    let fd: number | undefined;
    try {
      // 对同一 fd 校验权限并读取，避免 stat/readFile 之间文件被换掉；拒绝符号链接与非普通文件。
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o177) !== 0 || stat.size > 65536) fail('凭据文件须为权限不宽于 0600 的普通文件（至多 64 KiB）');
      value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (e) {
      if (e instanceof CliError) throw e;
      fail('凭据文件读取失败或 JSON 无效；什么都没动');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  } else value = await terminalSecrets(fields);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('凭据须为 JSON 对象');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !(fields as readonly string[]).includes(key)) ||
    fields.some((key) => typeof data[key] !== 'string' || !(data[key] as string).trim())
  )
    fail('凭据字段缺失、为空或不受支持');
  return new Redacted(data as unknown as WecomSecrets & { corpId?: string; openKfId?: string });
}

function ringRequired(env: NodeJS.ProcessEnv): KeyRing {
  let ring: KeyRing | null;
  try {
    ring = keyRingFromEnv(env);
  } catch {
    fail('渠道密钥环格式无效；什么都没动');
  }
  if (!ring) fail(`缺少 ${CHANNEL_KEY_ENV}；什么都没动`);
  return ring;
}

function settingsPatch(kind: string, entries: string[]): Record<string, unknown> {
  const allowed =
    kind === 'wecom_kf'
      ? ['pollIntervalMs', 'welcomeText', 'welcomeBackText']
      : ['title', 'welcomeText', 'dailyNewConversations', 'dailyTurns'];
  const patch: Record<string, unknown> = {};
  for (const entry of entries) {
    const at = entry.indexOf('=');
    const field = entry.slice(0, at);
    if (at < 1 || !allowed.includes(field) || Object.hasOwn(patch, field)) fail('--setting 字段无效或重复');
    const value = entry.slice(at + 1);
    if (field === 'welcomeText' || field === 'welcomeBackText') {
      const reason = checkWelcomeText(value);
      if (reason) fail(`欢迎语不合格：${reason}；什么都没动`);
      patch[field] = value;
    } else if (field === 'title') patch[field] = shortText(value, 'title');
    else {
      const n = Number(value);
      const min = field === 'pollIntervalMs' ? 30000 : 1;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) fail('数值设置须为正整数，pollIntervalMs 至少 30000');
      patch[field] = n;
    }
  }
  return patch;
}

/** 涉及的会话里加的说明（R7「每个涉及的会话加一条 system 说明」）。截止点之前还有没结束的客户消息的会话不加这一条：启动时只补记那一步
 *  会加 spec 原话的那条（src/adapters/wecom.ts 的 RESTORE_CUTOFF_NOTE），一个会话一次恢复只加一条 */
export const RESTORE_CUTOFF_CLI_NOTE =
  '恢复备份之后补记：备份之后的处理记录已丢失，恢复截止点之前没发完的回复与到点的跟进已取消、不会再发，请人工确认是否已回复';

/** var/ 里没回放的 spill（上次 db 存储停机时没落库的改动，含渠道行）：回放在 restore-cutoff 之后会接不上命令行加的说明 */
function checkSpill(varDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(varDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail('无法检查数据目录里的 spill 文件：修复目录读取权限后重试；什么都没动');
  }
  if (names.some((name) => SPILL_FILE_RE.test(name)))
    fail(
      '数据目录里有没回放的 spill 文件：先以 db 存储起一次应用让它回放（回放在恢复哨兵的检查之前，回放完应用会以 ' +
        'channel_restore_pending 停下，这是预期的），再跑本命令；什么都没动',
      2,
    );
}

interface CutoffCounts {
  /** 企微账号数（含停用） */
  accounts: number;
  /** 截止点之前没结束的客户消息与菜单点击（启动时只补记、不回复） */
  inbox: number;
  /** pending → cancelled */
  cancelled: number;
  /** sending → unknown */
  unknown: number;
  /** 跟进任务 pending / running → cancelled */
  jobs: number;
  /** 加了说明的会话 */
  notes: number;
}
type CutoffResult = { state: 'not_in_db' } | { state: 'noop' | 'done'; counts: CutoffCounts };

/**
 * restore-cutoff 的事务（R7、不变量 9）。企微状态不在库里（未导入、已导出）时什么都不改、返回 not_in_db：渠道状态在文件里，恢复照 02，
 * 哨兵由应用启动时删。在库里时全部企微账号（含停用）都写截止点：停用的之后启用也照样只补记。同一个截止点重跑什么都不改，返回 noop
 */
async function restoreCutoffTx(tx: Tx, until: Date, checkLock: () => void): Promise<CutoffResult> {
  const wecom = (await listChannelAccounts(tx)).filter((r) => r.kind === 'wecom_kf');
  if (!wecom.length || wecom.every((r) => r.status === 'exported')) return { state: 'not_in_db' };
  let moved = 0;
  for (const r of wecom) {
    if (r.recordOnlyUntil?.getTime() === until.getTime()) continue;
    await updateChannelAccount(tx, r.id, { recordOnlyUntil: until });
    moved++;
  }
  const inbox = await readOpenInboxUntil(tx, until);
  const recordOnly = new Set(inbox.flatMap((r) => (r.kind === 'message' && r.conversationId ? [r.conversationId] : [])));
  const touched = new Set<string>();
  let cancelled = 0;
  let unknown = 0;
  for (const o of await readOpenOutboundUntil(tx, until)) {
    const to = o.status === 'sending' ? 'unknown' : 'cancelled';
    if ((await transitionOutbound(tx, o.channelMsgid, to, 'recover')) === null) continue;
    if (to === 'unknown') unknown++;
    else cancelled++;
    touched.add(o.conversationId);
  }
  const jobs = await cancelFollowupsUntil(tx, until);
  for (const j of jobs) if (j.sessionId) touched.add(j.sessionId);
  const at = new Date();
  let notes = 0;
  for (const id of [...touched].toSorted()) {
    if (!recordOnly.has(id) && (await appendSystemNote(tx, id, RESTORE_CUTOFF_CLI_NOTE, at))) notes++;
  }
  const counts = { accounts: wecom.length, inbox: inbox.length, cancelled, unknown, jobs: jobs.length, notes };
  // 同一个截止点重跑：什么都没改，不记审计（照第 15 步「无操作」的写法）
  if (!moved && !cancelled && !unknown && !jobs.length && !notes) return { state: 'noop', counts };
  checkLock();
  // 只有账号 key、截止点与条数：没有会话 id、客户标识
  await writeAudit(tx, {
    action: 'channel.restore_cutoff',
    targetType: 'channel_account',
    diff: { keys: wecom.map((r) => r.key), until: until.toISOString(), ...counts },
  });
  return { state: 'done', counts };
}

/** 提交之后才删哨兵（不变量 14：企微状态在库里时只有这里删）；删不掉以 1 退出，库已提交 */
async function restoreCutoff(db: Db, tenantId: string, until: Date, varDir: string, lost: () => boolean): Promise<number> {
  const checkLock = () => {
    if (lost()) fail('lock_held：租户锁已断开，重新停机后运行；什么都没动', 3);
  };
  const result = await withTenant(
    db,
    { tenantId, actor: { kind: 'platform', userId: null, name: 'channel-account', ip: null } },
    (tx) => restoreCutoffTx(tx, until, checkLock),
    { longRunning: true },
  );
  if (result.state === 'not_in_db') {
    console.log('[channel-account] 无操作：企微状态未导入或已导出，渠道状态在文件里、恢复照 02；恢复哨兵由应用启动时删掉，直接起应用');
    return 0;
  }
  const { counts } = result;
  console.log(
    result.state === 'noop'
      ? `[channel-account] 无操作：恢复截止点 ${until.toISOString()} 已经写过，没有要取消的出站与跟进`
      : `[channel-account] 恢复截止点 ${until.toISOString()}：企微账号 ${counts.accounts} 个（含停用）都写了；` +
          `截止点之前没结束的入站 ${counts.inbox} 条（启动时只补记、不回复）；出站 pending 记 cancelled ${counts.cancelled} 段、` +
          `sending 记 unknown ${counts.unknown} 段；跟进任务记 cancelled ${counts.jobs} 个；${counts.notes} 个会话加了说明`,
  );
  if (!hasRestoreSentinel(varDir)) {
    console.log(`[channel-account] 数据目录里没有恢复哨兵 ${RESTORE_SENTINEL}（不是从备份恢复的，或已删过）；重启应用生效`);
    return 0;
  }
  try {
    removeRestoreSentinel(varDir);
  } catch (e) {
    console.error(
      `[channel-account] 数据库已提交，恢复哨兵 ${RESTORE_SENTINEL} 删不掉（${(e as NodeJS.ErrnoException).code ?? 'unknown'}）：` +
        '手动删掉它再起应用；别用 --until now 重跑（截止点会往后挪）',
    );
    return 1;
  }
  console.log(`[channel-account] 已删恢复哨兵 ${RESTORE_SENTINEL}；现在可以起应用`);
  return 0;
}

export interface ChannelAccountDeps {
  /** DATABASE_URL：app 身份；自测用同样 SET ROLE agent_app 的 PGlite */
  connect(): Promise<{ db: Db; close(): Promise<void>; lock(tenantId: string): Promise<TenantLock | null> }>;
}

/** 独立入口便于子进程自测注入 PGlite；生产入口只连接 DATABASE_URL，不读本机 env 文件。 */
export async function runChannelAccount(argv: string[], deps: ChannelAccountDeps): Promise<number> {
  try {
    const a = parse(argv);
    if (a.command === 'restore-cutoff') checkSpill(a.varDir);
    const conn = await deps.connect();
    try {
      const tenant = await findTenantBySlug(conn.db, a.tenant);
      if (!tenant) fail('tenant_not_found：租户不存在');
      const lock = await conn.lock(tenant.id);
      if (!lock) fail('lock_held：先 docker compose stop app，再运行本命令', 3);
      try {
        let lost = false;
        lock.onLost(() => {
          lost = true;
        });
        if (a.command === 'restore-cutoff') {
          // 取锁之前到现在应用可能起过一次、回放过（或又写出了）spill：持锁之后再查一次
          checkSpill(a.varDir);
          return await restoreCutoff(conn.db, tenant.id, a.until!, a.varDir, () => lost);
        }
        const webChannel = profile().flags.web_channel;
        const lines = await withTenant(
          conn.db,
          {
            tenantId: tenant.id,
            actor: { kind: 'platform', userId: null, name: 'channel-account', ip: null },
          },
          async (tx) => {
            const rows = await listChannelAccounts(tx);
            const wecom = rows.filter((r) => r.kind === 'wecom_kf');
            if (a.command === 'list')
              return rows.map((row) => {
                const account = accountFromRow(tenant.id, row, { webChannel });
                return JSON.stringify({
                  key: row.key,
                  kind: row.kind,
                  name: row.name,
                  status: row.status,
                  prefix: row.idPrefix,
                  inactiveReason: account.inactiveReason,
                  凭据已设置: row.secretsCt && row.secretsKeyId ? '是' : '否',
                });
              });
            const audit = async (entry: Pick<AuditEntry, 'action'>, keys: string[], fields: string[]) => {
              if (lost) fail('lock_held：租户锁已断开，重新停机后运行；什么都没动', 3);
              await writeAudit(tx, { ...entry, targetType: 'channel_account', diff: { keys, fields } });
            };
            if (a.command === 'add-wecom' || a.command === 'add-web') {
              if (wecom.length && wecom.every((r) => r.status === 'exported'))
                fail('企微状态已导出：先 channel-import --resync；什么都没动', 2);
              if (a.command === 'add-web' && !webChannel) fail(WEB_CHANNEL_OFF_REASON, 2);
              if (rows.some((r) => r.key === a.key)) fail('账号 key 已存在：用 set 修改，或选择其他 key；什么都没动', 2);
              if (a.command === 'add-wecom') {
                const ring = ringRequired(process.env);
                const secrets = (await readSecrets(a.secretsFile, true)).reveal();
                if (wecom.some((r) => r.openKfid === secrets.openKfId)) fail('客服账号已存在：用 set-secrets 更新凭据；什么都没动', 2);
                const id = randomUUID();
                const sealed = sealSecrets(ring, { tenantId: tenant.id, accountId: id }, secrets);
                await insertChannelAccount(tx, {
                  id,
                  key: a.key!,
                  kind: 'wecom_kf',
                  name: a.name!,
                  idPrefix: wecom.length ? `wecom:${a.key}:` : 'wecom:',
                  corpId: secrets.corpId!,
                  openKfid: secrets.openKfId!,
                  secretsCt: sealed.ct,
                  secretsKeyId: sealed.keyId,
                });
                await audit(
                  { action: 'channel.account_create' },
                  [a.key!],
                  ['key', 'kind', 'name', 'status', 'idPrefix', ...CREATE_FIELDS],
                );
              } else {
                await insertChannelAccount(tx, {
                  key: a.key!,
                  kind: 'web',
                  name: a.title!,
                  settings: {
                    title: a.title!,
                    dailyNewConversations: WEB_DEFAULT_DAILY_NEW,
                    dailyTurns: WEB_DEFAULT_DAILY_TURNS,
                  },
                });
                await audit(
                  { action: 'channel.account_create' },
                  [a.key!],
                  ['key', 'kind', 'name', 'status', 'title', 'dailyNewConversations', 'dailyTurns'],
                );
              }
              return [`已创建 ${a.key}；重启应用生效`];
            }
            if (a.command === 'rekey') {
              const encrypted = rows.filter((r) => r.secretsCt !== null);
              if (!encrypted.length) return ['无操作：没有已设置凭据的账号'];
              const ring = ringRequired(process.env);
              const patches = encrypted.map((row) => {
                let secrets: Redacted<WecomSecrets>;
                try {
                  secrets = openAccountSecrets(ring, tenant.id, row);
                } catch {
                  fail('有账号凭据无法解密：恢复完整旧密钥环后重试；什么都没动', 2);
                }
                return { id: row.id, sealed: sealSecrets(ring, { tenantId: tenant.id, accountId: row.id }, secrets.reveal()) };
              });
              for (const { id, sealed } of patches)
                await updateChannelAccount(tx, id, { secretsCt: sealed.ct, secretsKeyId: sealed.keyId });
              await audit(
                { action: 'channel.rekey' },
                encrypted.map((r) => r.key),
                ['secretsCt', 'secretsKeyId'],
              );
              return [`已重新加密 ${encrypted.length} 个账号；重启应用生效`];
            }
            const row = rows.find((r) => r.key === a.key);
            if (!row) fail('账号不存在：先 list 确认 key；什么都没动', 2);
            if (a.command === 'set-secrets') {
              if (row.kind !== 'wecom_kf') fail('set-secrets 只适用于企微账号');
              const ring = ringRequired(process.env);
              const secrets = await readSecrets(a.secretsFile, false);
              const sealed = sealSecrets(ring, { tenantId: tenant.id, accountId: row.id }, secrets.reveal());
              await updateChannelAccount(tx, row.id, { secretsCt: sealed.ct, secretsKeyId: sealed.keyId });
              await audit({ action: 'channel.secrets_update' }, [row.key], [...SECRET_FIELDS]);
              return [`已更新 ${row.key} 的凭据；重启应用生效`];
            }
            if (row.kind === 'web' && a.status === 'active' && !webChannel) fail(WEB_CHANNEL_OFF_REASON, 2);
            const setting = settingsPatch(row.kind, a.settings);
            const patch: ChannelAccountPatch = {};
            const fields: string[] = [];
            if (a.name !== undefined && a.name !== row.name) {
              patch.name = a.name;
              fields.push('name');
            }
            if (a.status !== undefined && a.status !== row.status) {
              patch.status = a.status;
              fields.push('status');
            }
            const changed = Object.keys(setting).filter((key) => row.settings[key] !== setting[key]);
            if (changed.length) {
              patch.settings = { ...row.settings, ...setting };
              fields.push(...changed);
            }
            if (!fields.length) return ['无操作：设置未改变'];
            await updateChannelAccount(tx, row.id, patch);
            await audit({ action: 'channel.account_update' }, [row.key], fields);
            return [`已更新 ${row.key}；重启应用生效`];
          },
          { readOnly: a.command === 'list', longRunning: true },
        );
        for (const line of lines) console.log(`[channel-account] ${line}`);
        return 0;
      } finally {
        await lock.release();
      }
    } finally {
      await conn.close();
    }
  } catch (e) {
    // Drizzle/PG 的异常可能包含 SQL 参数、密文和标识；只输出本模块的固定安全错误。
    console.error(`[channel-account] ${e instanceof CliError ? e.message : '读写失败；请检查数据库、权限和输入，什么都没动'}`);
    return e instanceof CliError ? e.code : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await runChannelAccount(process.argv.slice(2), {
    connect: async () => {
      const url = process.env.DATABASE_URL;
      if (!url) fail('缺少 DATABASE_URL（agent_app 身份）');
      const conn = await openDb(url);
      return { ...conn, lock: (tenantId) => holdTenantLock(url, tenantId) };
    },
  });
  process.exit(code);
}
