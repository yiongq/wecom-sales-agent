// 03 第 15 步：以 agent_app 身份管理渠道账号，应用须已停，改完重启生效。
// docker compose stop app
// docker compose run --rm app node --import tsx src/cli/channel-account.ts list --tenant demo
// 凭据只从 0600 文件或无回显终端读取，不接受凭据参数。退出码：0 成功/无操作，1 用法/读写错误，2 数据不一致，3 租户锁被占。
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
import { CHANNEL_KEY_ENV, Redacted, keyRingFromEnv, sealSecrets, type KeyRing, type WecomSecrets } from '../channels/secrets.js';
import { holdTenantLock, openDb, withTenant, type Db, type TenantLock } from '../db/client.js';
import { writeAudit, type AuditEntry } from '../db/repo/audit.js';
import { insertChannelAccount, listChannelAccounts, updateChannelAccount, type ChannelAccountPatch } from '../db/repo/channel-accounts.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { profile } from '../profile.js';

const USAGE = 'channel-account <list|add-wecom|add-web|set-secrets|set|rekey|restore-cutoff> --tenant <slug> …';
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

function parse(argv: string[]) {
  const command = argv[0];
  if (command === 'restore-cutoff') fail('restore-cutoff 由第 12 步实现');
  const options: NonNullable<ParseArgsConfig['options']> = { tenant: { type: 'string' } };
  switch (command) {
    case 'list':
    case 'rekey':
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
  if (command !== 'list' && command !== 'rekey') {
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

export interface ChannelAccountDeps {
  /** DATABASE_URL：app 身份；自测用同样 SET ROLE agent_app 的 PGlite */
  connect(): Promise<{ db: Db; close(): Promise<void>; lock(tenantId: string): Promise<TenantLock | null> }>;
}

/** 独立入口便于子进程自测注入 PGlite；生产入口只连接 DATABASE_URL，不读本机 env 文件。 */
export async function runChannelAccount(argv: string[], deps: ChannelAccountDeps): Promise<number> {
  try {
    const a = parse(argv);
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
