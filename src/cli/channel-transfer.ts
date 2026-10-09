// 03 R13：渠道状态迁移。CLI 只连接 app 身份、取租户锁；所有数据库变化在一个事务里。
// 文件阶段持锁到结束：导入 commit → 备份 → 标记 → 删原件；导出备份 → commit → 文件 → 删标记。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { openAccountSecrets } from '../channels/accounts.js';
import {
  hasChannelsMarker,
  hasWecomStateFile,
  readChannelsMarker,
  removeChannelsMarker,
  WECOM_STATE_FILE,
  writeChannelsMarker,
} from '../channels/markers.js';
import { CHANNEL_KEY_ENV, keyRingFromEnv, sealSecrets, type KeyRing, type WecomSecrets } from '../channels/secrets.js';
import { INBOX_OPEN_STATES } from '../channels/transitions.js';
import { withTenant, type Db, type TenantLock } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { insertChannelAccount, listChannelAccounts, updateChannelAccount, type ChannelAccountRow } from '../db/repo/channel-accounts.js';
import {
  insertInboxRows,
  readAccountInbox,
  resyncInboxPayload,
  setInboxState,
  type InboxRecord,
  type NewInboxRow,
} from '../db/repo/channel-inbox.js';
import { hasOutboundForInboxIds, hasPartlyDeliveredOutbound, readOpenOutbound, transitionOutbound } from '../db/repo/outbound.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { SPILL_FILE_RE } from '../store/project.js';

class Stop extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(message: string, code = 1): never {
  throw new Stop(code, message);
}
export interface ChannelTransferDeps {
  connect(): Promise<{ db: Db; close(): Promise<void>; lock(tenantId: string): Promise<TenantLock | null> }>;
}
interface Message {
  msgid: string;
  external_userid: string;
  send_time: number;
  [key: string]: unknown;
}
interface FileState {
  cursor: string;
  handled: [string, number][];
  pending: { msg: Message; tries: number }[];
}
interface Args {
  tenant: string;
  key?: string;
  name?: string;
  keep: string;
  varDir: string;
  dryRun: boolean;
  resync: boolean;
}
function parse(command: 'import' | 'export', argv: string[]): Args {
  let a;
  try {
    a = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        tenant: { type: 'string' },
        keep: { type: 'string' },
        var: { type: 'string' },
        key: { type: 'string' },
        name: { type: 'string' },
        'dry-run': { type: 'boolean' },
        resync: { type: 'boolean' },
      },
    }).values;
  } catch {
    fail('参数无效；请核对 channel-import / channel-export 用法');
  }
  if (command === 'export' && ['key', 'name', 'dry-run', 'resync'].some((k) => Object.hasOwn(a, k))) fail('导出参数无效');
  if (!a.tenant?.trim() || !a.keep?.trim() || (command === 'export' && !a.var?.trim())) fail('须提供 --tenant、--keep；导出还须提供 --var');
  if (command === 'import' && (!a.key || !/^[a-z][a-z0-9-]{1,30}$/.test(a.key))) fail('--key 须匹配 ^[a-z][a-z0-9-]{1,30}$');
  if (a.name !== undefined && (!a.name.trim() || [...a.name.trim()].length > 40)) fail('--name 须为 1–40 个字符');
  return {
    tenant: a.tenant,
    key: a.key,
    name: a.name?.trim(),
    keep: a.keep,
    varDir: a.var ?? process.env.VAR_DIR ?? path.resolve('var'),
    dryRun: a['dry-run'] ?? false,
    resync: a.resync ?? false,
  };
}
function ringRequired(): KeyRing {
  try {
    const ring = keyRingFromEnv(process.env);
    if (ring) return ring;
  } catch {
    fail('渠道密钥环无效；什么都没动');
  }
  return fail(`缺少 ${CHANNEL_KEY_ENV}；什么都没动`);
}
function envCredentials(): WecomSecrets & { corpId: string; openKfid: string } {
  const {
    WECOM_CORP_ID: corpId,
    WECOM_KF_OPEN_KFID: openKfid,
    WECOM_APP_SECRET: appSecret,
    WECOM_CALLBACK_TOKEN: callbackToken,
    WECOM_CALLBACK_AES_KEY: callbackAesKey,
  } = process.env;
  if (![corpId, openKfid, appSecret, callbackToken, callbackAesKey].every((v) => v?.trim())) fail('缺少 WECOM_* 必需项；什么都没动');
  return { corpId: corpId!, openKfid: openKfid!, appSecret: appSecret!, callbackToken: callbackToken!, callbackAesKey: callbackAesKey! };
}
function realOf(p: string): string {
  const tail: string[] = [];
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}
function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function atomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
/** 与 02 一样先验可写；拒绝/演练后移除本次创建的空目录，保留任何已写下的原件。 */
function writableDir(dir: string): () => void {
  const created = fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.channel-probe-${randomUUID()}`);
  try {
    atomic(probe, '');
    fs.unlinkSync(probe);
    fsyncDir(dir);
  } catch (e) {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
    cleanup();
    throw e;
  }
  function cleanup() {
    if (!created) return;
    for (let p = path.resolve(dir); ; p = path.dirname(p)) {
      try {
        fs.rmdirSync(p);
      } catch {
        return;
      }
      if (p === path.resolve(created)) return;
    }
  }
  return cleanup;
}
function backup(a: Args, command: string): void {
  const file = path.join(a.varDir, WECOM_STATE_FILE);
  if (!fs.existsSync(file)) return;
  const dir = fs.mkdtempSync(path.join(a.keep, `channel-${command}-`));
  fsyncDir(a.keep);
  atomic(path.join(dir, WECOM_STATE_FILE), fs.readFileSync(file));
}
/** spill 含渠道行；迁移看不到未回放的写入，必须先回放再停机。dry-run 不写，调用方跳过。 */
function checkSpill(varDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(varDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail('无法检查数据目录里的 spill 文件：修复目录读取权限后重试；什么都没动');
  }
  const spills = names.filter((name) => SPILL_FILE_RE.test(name));
  if (spills.length) {
    fail(
      `数据目录里有没回放的 spill 文件（${spills.join('、')}）：上次 db 存储停机时没落库的改动（含渠道行）在里面，` +
        '导入 / 导出看不到它们，回放会在之后再往 outbound_sends / channel_inbox 写行。' +
        '先以 db 存储起一次应用让它回放（成功后文件会删掉），正常停机，再跑本命令',
      2,
    );
  }
}

function readFileState(dir: string): FileState {
  if (!hasWecomStateFile(dir)) return { cursor: '', handled: [], pending: [] };
  const v = JSON.parse(fs.readFileSync(path.join(dir, WECOM_STATE_FILE), 'utf8'));
  const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
  const time = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && !Number.isNaN(new Date(x).getTime());
  if (!v || typeof v.cursor !== 'string' || !Array.isArray(v.handled) || (v.pending !== undefined && !Array.isArray(v.pending)))
    fail('渠道文件格式无效；什么都没动');
  const handled = new Map<string, number>();
  for (const e of v.handled) {
    if (!Array.isArray(e) || e.length !== 2 || !str(e[0]) || !time(e[1])) fail('handled 格式无效；什么都没动');
    handled.set(e[0], e[1]);
  }
  const pending = new Map<string, FileState['pending'][number]>();
  for (const e of v.pending ?? []) {
    if (
      !e?.msg ||
      !str(e.msg.msgid) ||
      !str(e.msg.external_userid) ||
      !time(e.msg.send_time * 1000) ||
      typeof e.msg.send_time !== 'number' ||
      !Number.isSafeInteger(e.tries) ||
      e.tries < 0 ||
      e.tries >= 2147483647
    )
      fail('pending 格式无效；什么都没动');
    pending.set(e.msg.msgid, e);
  }
  return { cursor: v.cursor, handled: [...handled], pending: [...pending.values()] };
}
function mergedRows(file: FileState): NewInboxRow[] {
  const heads = new Set<string>();
  const pendingIds = new Set(file.pending.map((e) => e.msg.msgid));
  const rows: NewInboxRow[] = file.pending.map((e) => {
    const head = !heads.has(e.msg.external_userid);
    heads.add(e.msg.external_userid);
    return {
      msgid: e.msg.msgid,
      kind: 'message',
      conversationId: `wecom:${e.msg.external_userid}`,
      sentAt: new Date(e.msg.send_time * 1000),
      state: 'received',
      attempts: e.tries + Number(head),
      payload: e.msg,
    };
  });
  return [
    ...rows,
    ...file.handled
      .filter(([id]) => !pendingIds.has(id))
      .map(([msgid, at]): NewInboxRow => ({
        msgid,
        kind: 'legacy',
        conversationId: null,
        sentAt: null,
        state: 'done',
        receivedAt: new Date(at),
      })),
  ];
}
const isOpen = (r: InboxRecord): boolean => INBOX_OPEN_STATES.includes(r.state);
function exportFile(account: ChannelAccountRow, rows: InboxRecord[]): FileState {
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  return {
    cursor: account.cursor ?? '',
    handled: rows
      .filter((r) => r.receivedAt.getTime() >= cutoff)
      .toSorted((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.ord - a.ord)
      .slice(0, 5000)
      .map((r) => [r.msgid, r.receivedAt.getTime()]),
    pending: rows
      .filter((r) => isOpen(r) && r.kind === 'message')
      .map((r) => ({ msg: r.payload as Message, tries: Math.max(r.attempts - 1, 0) })),
  };
}
function sameFile(a: FileState, b: FileState): boolean {
  return a.cursor === b.cursor && isDeepStrictEqual(new Map(a.handled), new Map(b.handled)) && isDeepStrictEqual(a.pending, b.pending);
}
/** 首次提交后文件阶段中断：只有整份原件与已导入行相符才补完，不把新文件当已导入丢掉。 */
function matchesImport(account: ChannelAccountRow, rows: InboxRecord[], file: FileState, merged: NewInboxRow[]): boolean {
  if ((account.cursor ?? '') !== file.cursor || rows.length !== merged.length) return false;
  const byId = new Map(rows.map((r) => [r.msgid, r]));
  return (
    merged.every((w) => {
      const r = byId.get(w.msgid);
      return (
        r &&
        r.kind === w.kind &&
        r.state === w.state &&
        r.conversationId === w.conversationId &&
        r.attempts === (w.attempts ?? 0) &&
        isDeepStrictEqual(r.payload, w.payload ?? null) &&
        (w.receivedAt === undefined || r.receivedAt.getTime() === w.receivedAt.getTime())
      );
    }) &&
    isDeepStrictEqual(
      rows.filter(isOpen).map((r) => r.msgid),
      file.pending.map((e) => e.msg.msgid),
    )
  );
}

export async function runChannelTransfer(command: 'import' | 'export', argv: string[], deps: ChannelTransferDeps): Promise<number> {
  let committed = false;
  let writeAttempted = false;
  let cleanKeep = () => {};
  let cleanVar = () => {};
  try {
    const a = parse(command, argv);
    const keep = realOf(a.keep);
    const varDir = realOf(a.varDir);
    if (keep === varDir || keep.startsWith(`${varDir}${path.sep}`)) fail('--keep 必须在 var/ 之外；什么都没动');
    if (!a.dryRun) checkSpill(a.varDir);
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
        const checkLock = () => {
          if (lost) fail('lock_held：租户锁已断开，停机后重试', 3);
        };
        if (!a.dryRun) checkSpill(a.varDir);
        // 导出须先检查全部拒绝条件，连目录探测也不能提前写。
        if (command === 'import') {
          cleanKeep = writableDir(a.keep);
          cleanVar = writableDir(a.varDir);
        }
        const ring = ringRequired();
        const credentials = envCredentials();
        const filePresent = hasWecomStateFile(a.varDir);
        const marked = hasChannelsMarker(a.varDir);
        const marker = readChannelsMarker(a.varDir);
        if (marker && (marker.tenant !== a.tenant || (command === 'import' && marker.account !== a.key)))
          fail('标记与目标不一致：请核对租户、账号和数据目录；什么都没动', 2);
        const file = command === 'import' ? readFileState(a.varDir) : { cursor: '', handled: [], pending: [] };
        const result = await withTenant(
          conn.db,
          { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: `channel-${command}`, ip: null } },
          async (tx) => {
            checkLock();
            const accounts = await listChannelAccounts(tx);
            const wecom = accounts.filter((r) => r.kind === 'wecom_kf');
            let account = wecom.find((r) => r.idPrefix === 'wecom:');
            if (command === 'import' && wecom.length && (!account || account.key !== a.key))
              fail('默认账号 key 不一致：请核对 --key；什么都没动', 2);
            if (command === 'export' && (!account || accounts.length !== 1))
              fail('回退到 02 只支持默认企微账号：其他账号（含停用）须留在 03 或更新镜像；什么都没动', 2);
            if (account && (account.corpId !== credentials.corpId || account.openKfid !== credentials.openKfid))
              fail('env 的 WECOM_CORP_ID / WECOM_KF_OPEN_KFID 与默认账号不一致：恢复匹配的 env 再重试；什么都没动', 2);
            if (command === 'export') {
              let stored: WecomSecrets;
              try {
                stored = openAccountSecrets(ring, tenant.id, account!).reveal();
              } catch {
                fail('默认账号无法解密：恢复完整密钥环再重试；什么都没动', 2);
              }
              if (
                stored.appSecret !== credentials.appSecret ||
                stored.callbackToken !== credentials.callbackToken ||
                stored.callbackAesKey !== credentials.callbackAesKey
              )
                fail('env 的 WECOM_* 凭据与默认账号不一致：恢复匹配的 env 再重试；什么都没动', 2);
              if (marker && marker.account !== account!.key) fail('标记账号不一致：核对数据目录；什么都没动', 2);
              const rows = await readAccountInbox(tx, account!.id);
              const open = rows.filter(isOpen);
              if (open.some((r) => r.kind !== 'message'))
                fail('有尚未处理完的非 message 入站：先以 03 起一次应用让启动恢复处理完，正常停机，再导出；什么都没动', 2);
              const nonText = open.filter((r) => {
                const msg = r.payload as { msgtype?: unknown; text?: { content?: unknown } } | null;
                return msg?.msgtype !== 'text' || !msg.text?.content;
              });
              if (
                await hasOutboundForInboxIds(
                  tx,
                  account!.id,
                  nonText.map((r) => r.id),
                )
              )
                fail('有非文本在途消息已生成出站：先以 03 起一次应用让启动恢复处理完，正常停机，再导出；什么都没动', 2);
              if (account!.status === 'exported' && !marked && filePresent) return { noop: true, key: account!.key, counts: {} };
              const output = exportFile(account!, rows);
              if (!marked && !sameFile(readFileState(a.varDir), output))
                fail('无标记且文件与库不一致：切回库请用 channel-import --resync；什么都没动', 2);
              if (await hasPartlyDeliveredOutbound(tx, account!.id))
                fail('有部分送达的回复：以 03 起一次应用让启动恢复发完，正常停机后再导出；什么都没动', 2);
              const outbound = await readOpenOutbound(tx, account!.id);
              if (outbound.some((r) => r.status === 'pending' && !r.inboxId))
                fail('有无 inbox_id 的 pending 出站：以 03 起一次应用让启动恢复发完，正常停机后再导出；什么都没动', 2);
              // 所有拒绝已检查；覆盖旧文件前先保留原件，数据库失败也不会覆盖 var/。
              cleanKeep = writableDir(a.keep);
              cleanVar = writableDir(a.varDir);
              backup(a, command);
              checkLock();
              writeAttempted = true;
              let unknown = 0;
              let cancelled = 0;
              for (const r of outbound) {
                const to = r.status === 'sending' ? 'unknown' : 'cancelled';
                if (await transitionOutbound(tx, r.channelMsgid, to, 'recover')) {
                  if (to === 'unknown') unknown++;
                  else cancelled++;
                }
              }
              await updateChannelAccount(tx, account!.id, { status: 'exported' });
              const counts = { handled: output.handled.length, pending: output.pending.length, unknown, cancelled };
              await writeAudit(tx, { action: 'channel.export', targetType: 'channel_account', diff: { key: account!.key, ...counts } });
              checkLock();
              return { noop: false, key: account!.key, counts, output };
            }
            if (account?.status === 'active' && marked && !filePresent) return { noop: true, key: account.key, counts: {} };
            if (account?.status === 'exported' && !a.resync) fail('账号已导出：先 channel-import --resync；什么都没动', 2);
            if (account && a.resync && !filePresent) fail('--resync 需要文件状态：恢复文件再重试；什么都没动', 2);
            const merged = mergedRows(file);
            const rows = account ? await readAccountInbox(tx, account.id) : [];
            if (account && !a.resync) {
              if (!matchesImport(account, rows, file, merged))
                fail('库里已有不一致的状态：核对文件，回退后用 channel-import --resync；什么都没动', 2);
              return { noop: false, key: account.key, counts: { inserted: 0, updated: 0, abandoned: 0 } };
            }
            if (!account && accounts.some((r) => r.key === a.key)) fail('账号 key 已存在：选择其他 key；什么都没动', 2);
            const byId = new Map(rows.map((r) => [r.msgid, r]));
            const pending = new Set(file.pending.map((e) => e.msg.msgid));
            const inserts = merged.filter((r) => !byId.has(r.msgid));
            const updates = merged.filter(
              (w) =>
                w.state === 'received' &&
                byId.has(w.msgid) &&
                isOpen(byId.get(w.msgid)!) &&
                (!isDeepStrictEqual(byId.get(w.msgid)!.payload, w.payload) || byId.get(w.msgid)!.attempts !== w.attempts),
            );
            const abandoned = rows.filter((r) => isOpen(r) && !pending.has(r.msgid));
            const counts = {
              handled: merged.length - pending.size,
              pending: pending.size,
              inserted: inserts.length,
              updated: updates.length,
              abandoned: abandoned.length,
            };
            if (a.dryRun) return { noop: false, key: a.key!, counts };
            writeAttempted = true;
            if (!account) {
              const id = randomUUID();
              const sealed = sealSecrets(ring, { tenantId: tenant.id, accountId: id }, credentials);
              const poll = Number(process.env.WECOM_POLL_INTERVAL_MS);
              account = await insertChannelAccount(tx, {
                id,
                key: a.key!,
                kind: 'wecom_kf',
                name: a.name ?? a.key!,
                idPrefix: 'wecom:',
                corpId: credentials.corpId,
                openKfid: credentials.openKfid,
                secretsCt: sealed.ct,
                secretsKeyId: sealed.keyId,
                settings: Number.isSafeInteger(poll) && poll > 0 ? { pollIntervalMs: poll } : {},
              });
            }
            await updateChannelAccount(tx, account.id, { cursor: file.cursor, status: 'active' });
            for (let i = 0; i < inserts.length; i += 250) await insertInboxRows(tx, account.id, inserts.slice(i, i + 250));
            for (const w of updates) await resyncInboxPayload(tx, byId.get(w.msgid)!.id, w.payload, w.attempts!);
            for (const r of abandoned) await setInboxState(tx, r.id, { state: 'abandoned', reason: 'resync' });
            await writeAudit(tx, { action: 'channel.import', targetType: 'channel_account', diff: { key: account.key, ...counts } });
            checkLock();
            return { noop: false, key: account.key, counts };
          },
          { readOnly: a.dryRun, longRunning: true },
        );
        checkLock();
        if (a.dryRun) {
          console.log(`[channel-import] dry-run ${result.key} ${JSON.stringify(result.counts)}`);
          return 0;
        }
        if (result.noop) {
          console.log(`[channel-${command}] 无操作：${result.key} 已${command === 'import' ? '导入' : '导出'}`);
          return 0;
        }
        committed = true;
        checkLock();
        if (command === 'import') {
          backup(a, command);
          writeChannelsMarker(a.varDir, { tenant: a.tenant, account: result.key, at: new Date().toISOString() });
          if (filePresent) {
            fs.unlinkSync(path.join(a.varDir, WECOM_STATE_FILE));
            fsyncDir(a.varDir);
          }
        } else {
          atomic(path.join(a.varDir, WECOM_STATE_FILE), `${JSON.stringify(result.output)}\n`);
          removeChannelsMarker(a.varDir);
        }
        console.log(`[channel-${command}] ${result.key} ${JSON.stringify(result.counts)}`);
        return 0;
      } finally {
        await lock.release();
      }
    } finally {
      await conn.close();
    }
  } catch (e) {
    // 驱动/JSON/文件异常可能含凭据、标识或路径，绝不回显底层异常。
    console.error(
      `[channel-${command}] ${committed ? '数据库已提交，文件阶段未完成；保持停机，原参数重试本命令' : e instanceof Stop ? e.message : writeAttempted ? '数据库写入结果未确认；保持停机，原参数重试本命令' : '参数或读写失败；请检查数据库、权限和输入，什么都没动'}`,
    );
    return e instanceof Stop ? e.code : 1;
  } finally {
    cleanVar();
    cleanKeep();
  }
}
