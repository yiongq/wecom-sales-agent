// 11 R9：服务器停机后以 agent_app 运行，提交后重启应用生效。凭据只从文件或无回显终端读取。
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { keyRingFromEnv, Redacted, type KeyRing } from '../channels/secrets.js';
import { packSources } from '../config/source.js';
import { autoMapProducts, manualMapProduct, mappingToUnset, type MappingInput } from '../connectors/mapping.js';
import { createOdooConnector } from '../connectors/odoo.js';
import { openConnectorSecrets, sealConnectorSecrets, type ConnectorSecrets } from '../connectors/secrets.js';
import { ErpError, type ErpConnector } from '../connectors/types.js';
import { holdTenantLock, openDb, withTenant, type Db, type TenantLock, type Tx } from '../db/client.js';
import { writeAudit, type AuditEntry } from '../db/repo/audit.js';
import { readCatalogOfKind } from '../db/repo/catalog.js';
import {
  readErpConnector,
  insertErpConnector,
  updateErpConnector,
  listErpItemLinks,
  upsertErpItemLink,
  deleteErpItemLink,
  type ErpConnectorPatch,
  type ErpConnectorRow,
} from '../db/repo/erp.js';
import { findTenantBySlug, standardTenants } from '../db/repo/tenants.js';
import type { ErpConnectorSettings } from '../db/schema.js';
import { createEgress, normalizeBaseUrl } from '../net/egress.js';
import { runtimeById } from '../packs/registry.js';
import { readSecretFields } from './channel-account.js';

const USAGE = 'erp-connector <show|add-odoo|set|set-secrets|check|map|rekey> --tenant <slug> …';
class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(message: string, code = 1): never {
  throw new CliError(code, message);
}
function required(value: string | undefined, field: string): string {
  if (!value) fail(`缺少 ${field}；${USAGE}`);
  return value;
}
function positive(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) fail('id 须为正整数');
  return Number(value);
}
function expiry(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value <= new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  )
    fail('key-expires 须为晚于今天（上海时区）的 YYYY-MM-DD');
  return value;
}
function units(value: string): Record<string, number> {
  const result: Record<string, number> = Object.create(null);
  for (const entry of value.split(',')) {
    const at = entry.lastIndexOf('=');
    const name = entry.slice(0, at).trim();
    if (at < 1 || !name || Object.hasOwn(result, name)) fail('uom 须为不重复的 单位=id,…，至少一项');
    result[name] = positive(entry.slice(at + 1));
  }
  return result;
}
function parse(argv: string[]) {
  const command = argv[0];
  const options: NonNullable<ParseArgsConfig['options']> = { tenant: { type: 'string' } };
  const addOptions = (names: string[]) => {
    for (const name of names) options[name] = { type: 'string' };
  };
  switch (command) {
    case 'show':
    case 'check':
    case 'rekey':
      break;
    case 'add-odoo':
      addOptions(['base-url', 'database', 'location', 'uom', 'key-expires', 'secrets-file']);
      break;
    case 'set':
      addOptions(['base-url', 'database', 'location', 'uom', 'status']);
      break;
    case 'set-secrets':
      addOptions(['key-expires', 'secrets-file']);
      break;
    case 'map':
      addOptions(['set', 'unset']);
      options.auto = { type: 'boolean' };
      options['dry-run'] = { type: 'boolean' };
      break;
    default:
      fail(`子命令无效；${USAGE}`);
  }
  let v: ReturnType<typeof parseArgs>['values'];
  try {
    v = parseArgs({ args: argv.slice(1), options, strict: true, allowPositionals: false }).values;
  } catch {
    fail(`参数无效；${USAGE}`);
  }
  const str = (key: string) => v[key] as string | undefined;
  const tenant = required(str('tenant'), '--tenant');
  const status = str('status') as 'active' | 'disabled' | undefined;
  if (status !== undefined && status !== 'active' && status !== 'disabled') fail('status 只接受 active 或 disabled');
  let baseUrl: string | undefined;
  if (v['base-url'] !== undefined || command === 'add-odoo') {
    const normalized = normalizeBaseUrl(required(str('base-url'), '--base-url'));
    if (!normalized.ok) fail(normalized.code);
    baseUrl = normalized.url;
  }
  const database = str('database');
  if (database !== undefined && !/^[A-Za-z0-9_.-]{1,63}$/.test(database)) fail('database 无效');
  const locationId = v.location !== undefined || command === 'add-odoo' ? positive(required(str('location'), '--location')) : undefined;
  const uom = v.uom !== undefined || command === 'add-odoo' ? units(required(str('uom'), '--uom')) : undefined;
  const keyExpiresAt = ['add-odoo', 'set-secrets'].includes(command) ? expiry(required(str('key-expires'), '--key-expires')) : undefined;
  if (
    command === 'map' &&
    ([v.auto === true, v.set !== undefined, v.unset !== undefined].filter(Boolean).length !== 1 || (v['dry-run'] && !v.auto))
  )
    fail('map 须指定 --auto [--dry-run]、--set 或 --unset 其中一项');
  let manual: { code: string; id: number } | undefined;
  if (v.set !== undefined) {
    const value = str('set')!;
    const at = value.lastIndexOf('=');
    if (at < 1) fail('--set 须为 编号=id');
    manual = { code: value.slice(0, at), id: positive(value.slice(at + 1)) };
  }
  if (v.unset !== undefined && !str('unset')) fail('--unset 须提供编号');
  return {
    command,
    tenant,
    status,
    baseUrl,
    database,
    locationId,
    uom,
    keyExpiresAt,
    secretsFile: str('secrets-file'),
    auto: !!v.auto,
    dryRun: !!v['dry-run'],
    manual,
    unset: str('unset'),
  };
}
function ringRequired(): KeyRing {
  try {
    const ring = keyRingFromEnv(process.env);
    if (ring) return ring;
  } catch {
    /* 不输出密钥环异常 */
  }
  return fail('密钥环缺失或无效；什么都没动');
}
async function secretsFromFile(file: string | undefined): Promise<Redacted<ConnectorSecrets>> {
  try {
    const secret = await readSecretFields(file, ['apiKey']);
    return new Redacted({ apiKey: secret.reveal().apiKey });
  } catch {
    return fail('凭据读取失败：须为仅含 apiKey 的 JSON、权限不宽于 0600 的普通文件（至多 64 KiB），或无回显终端；什么都没动');
  }
}
export type ConnectorFactory = (options: {
  baseUrl: string;
  database: string | null;
  locationId: number;
  apiKey: Redacted<ConnectorSecrets>;
}) => ErpConnector;
export interface ErpConnectorCliDeps {
  connect(): Promise<{ db: Db; close(): Promise<void>; lock(tenantId: string): Promise<TenantLock | null> }>;
  /** 进程内自测注入；生产与子进程入口始终用严格出站。 */
  connector?: ConnectorFactory;
}
const factory: ConnectorFactory = ({ baseUrl, ...options }) => createOdooConnector({ ...options, send: createEgress(baseUrl) });
export async function checkErpConnector(connector: ErpConnector): Promise<NonNullable<ErpConnectorSettings['lastCheck']>['result']> {
  try {
    const checked = await connector.check();
    return checked.companyCurrency !== 'CNY' ? 'currency' : !checked.locationOk ? 'location' : 'ok';
  } catch (e) {
    return e instanceof ErpError ? e.code : 'bad_response';
  }
}
function conclusion(result: string): string {
  return result === 'ok'
    ? 'ok'
    : result === 'auth'
      ? 'auth；20 只认 scope 为 rpc 的 key；请 set-secrets 后 check'
      : `${result}；请核对配置与权限后 check`;
}

export async function runErpConnector(argv: string[], deps: ErpConnectorCliDeps): Promise<number> {
  try {
    if (process.env.CONFIG_SOURCE !== 'db' || process.env.SESSION_STORE !== 'db') fail('db_storage_required');
    const a = parse(argv);
    const conn = await deps.connect();
    try {
      const tenant = await findTenantBySlug(conn.db, a.tenant);
      if (!tenant) fail('tenant_not_found');
      if (!(await standardTenants(conn.db)).some((row) => row.id === tenant.id)) fail('standard_tenant_required');
      const lock = await conn.lock(tenant.id);
      if (!lock) fail('lock_held：先 docker compose stop app', 3);
      try {
        let lost = false;
        lock.onLost(() => {
          lost = true;
        });
        const result = await withTenant(
          conn.db,
          {
            tenantId: tenant.id,
            actor: { kind: 'platform', userId: null, name: 'erp-connector', ip: null },
          },
          async (tx) => {
            const row = await readErpConnector(tx);
            const audit = async (entry: Pick<AuditEntry, 'action'>, fields: string[]) => {
              if (lost) fail('lock_held：租户锁已断开；什么都没动', 3);
              await writeAudit(tx, { ...entry, targetType: 'erp_connector', diff: { fields } });
            };
            const done = (lines: string[], code = 0) => ({ lines, code });
            const open = (r: ErpConnectorRow, ring: KeyRing) => {
              try {
                return openConnectorSecrets(ring, { tenantId: tenant.id, connectorId: r.id }, r.secretsCt, r.secretsKeyId);
              } catch {
                return fail('凭据无法解密：恢复完整旧密钥环后重试；什么都没动', 2);
              }
            };
            const make = (r: Pick<ErpConnectorRow, 'baseUrl' | 'database' | 'settings'>, apiKey: Redacted<ConnectorSecrets>) =>
              (deps.connector ?? factory)({ baseUrl: r.baseUrl, database: r.database, locationId: r.settings.locationId, apiKey });
            if (a.command === 'show') {
              if (!row) return done(['未配置连接器']);
              const links = await listErpItemLinks(tx, row.id);
              return done([
                JSON.stringify({
                  kind: row.kind,
                  status: row.status,
                  mappings: links.length,
                  keyExpiresAt: row.settings.keyExpiresAt,
                  lastCheck: row.settings.lastCheck ?? null,
                }),
              ]);
            }
            if (a.command === 'add-odoo') {
              if (row) fail('connector_exists：请用 set 修改；什么都没动', 2);
              const ring = ringRequired();
              const secret = await secretsFromFile(a.secretsFile);
              const settings: ErpConnectorSettings = { locationId: a.locationId!, uom: a.uom!, keyExpiresAt: a.keyExpiresAt! };
              const config = { baseUrl: a.baseUrl!, database: a.database ?? null, settings };
              const checked = await checkErpConnector(make(config, secret));
              if (checked === 'egress') fail('egress');
              settings.lastCheck = { at: new Date().toISOString(), result: checked };
              const id = randomUUID();
              const sealed = sealConnectorSecrets(ring, { tenantId: tenant.id, connectorId: id }, secret.reveal());
              await insertErpConnector(tx, { ...config, id, kind: 'odoo', secretsCt: sealed.ct, secretsKeyId: sealed.keyId });
              await audit({ action: 'erp.create' }, [
                'kind',
                'status',
                'baseUrl',
                'database',
                'locationId',
                'uom',
                'keyExpiresAt',
                'apiKey',
                'lastCheck',
              ]);
              return done(
                [`已创建；${conclusion(checked)}；重启应用生效`, 'ERP 不可用时按产品库库存回答，请将产品库库存设置得保守'],
                checked === 'ok' ? 0 : 1,
              );
            }
            if (!row && a.command === 'rekey') return done(['无操作：没有已设置凭据的连接器']);
            if (!row) fail('connector_not_found：先 add-odoo；什么都没动', 2);
            if (a.command === 'rekey' || a.command === 'set-secrets') {
              const ring = ringRequired();
              const secret = a.command === 'rekey' ? open(row, ring) : await secretsFromFile(a.secretsFile);
              const sealed = sealConnectorSecrets(ring, { tenantId: tenant.id, connectorId: row.id }, secret.reveal());
              await updateErpConnector(tx, row.id, {
                secretsCt: sealed.ct,
                secretsKeyId: sealed.keyId,
                ...(a.command === 'set-secrets'
                  ? { settings: { locationId: row.settings.locationId, uom: row.settings.uom, keyExpiresAt: a.keyExpiresAt! } }
                  : {}),
              });
              await audit(
                a.command === 'rekey' ? { action: 'erp.rekey' } : { action: 'erp.secrets_update' },
                a.command === 'rekey' ? ['secretsCt', 'secretsKeyId'] : ['apiKey', 'keyExpiresAt', 'lastCheck'],
              );
              return done(['已更新凭据；重启应用生效；请 check']);
            }
            if (a.command === 'check') {
              const checked = await checkErpConnector(make(row, open(row, ringRequired())));
              await updateErpConnector(tx, row.id, {
                settings: { ...row.settings, lastCheck: { at: new Date().toISOString(), result: checked } },
              });
              await audit({ action: 'erp.check' }, ['lastCheck']);
              return done([conclusion(checked)], checked === 'ok' ? 0 : 1);
            }
            if (a.command === 'set') {
              const patch: ErpConnectorPatch = {};
              const fields: string[] = [];
              if (a.status !== undefined && a.status !== row.status) {
                patch.status = a.status;
                fields.push('status');
              }
              for (const field of ['baseUrl', 'database'] as const)
                if (a[field] !== undefined && a[field] !== row[field]) {
                  patch[field] = a[field];
                  fields.push(field);
                }
              const settings = { ...row.settings };
              if (a.locationId !== undefined && a.locationId !== settings.locationId) {
                settings.locationId = a.locationId;
                fields.push('locationId');
              }
              if (a.uom !== undefined && JSON.stringify(a.uom) !== JSON.stringify(settings.uom)) {
                settings.uom = a.uom;
                fields.push('uom');
              }
              let checked: Awaited<ReturnType<typeof checkErpConnector>> | undefined;
              if (a.baseUrl !== undefined) {
                checked = await checkErpConnector(make({ ...row, ...patch, settings }, open(row, ringRequired())));
                if (checked === 'egress') fail('egress');
                settings.lastCheck = { at: new Date().toISOString(), result: checked };
                fields.push('lastCheck');
              } else if (fields.some((f) => ['database', 'locationId', 'uom'].includes(f))) {
                delete settings.lastCheck;
                fields.push('lastCheck');
              }
              if (!fields.length) return done(['无操作：设置未改变']);
              patch.settings = settings;
              await updateErpConnector(tx, row.id, patch);
              await audit({ action: 'erp.update' }, fields);
              return done([`已更新；重启应用生效${checked ? `；${conclusion(checked)}` : ''}`], checked && checked !== 'ok' ? 1 : 0);
            }
            return map(tx, row, tenant.packId, a, () => make(row, open(row, ringRequired())), audit);
          },
          { longRunning: true },
        );
        for (const line of result.lines) console.log(`[erp-connector] ${line}`);
        return result.code;
      } finally {
        await lock.release();
      }
    } finally {
      await conn.close();
    }
  } catch (e) {
    console.error(
      `[erp-connector] ${e instanceof CliError ? e.message : e instanceof ErpError ? e.code : '读写失败；请检查数据库、权限和输入，什么都没动'}`,
    );
    return e instanceof CliError ? e.code : 1;
  }
}
async function map(
  tx: Tx,
  row: ErpConnectorRow,
  packId: string,
  a: ReturnType<typeof parse>,
  connector: () => ErpConnector,
  audit: (entry: Pick<AuditEntry, 'action'>, fields: string[]) => Promise<void>,
) {
  const declaration = runtimeById(packId, packSources())?.erp;
  if (!declaration) fail('pack_erp_required');
  const existing = await listErpItemLinks(tx, row.id);
  if (a.unset !== undefined) {
    mappingToUnset(existing, declaration.kind, a.unset);
    await deleteErpItemLink(tx, row.id, declaration.kind, a.unset);
    await audit({ action: 'erp.map' }, ['kind', 'code']);
    return { lines: ['已删除映射；重启应用生效'], code: 0 };
  }
  const input: MappingInput = {
    declaration,
    connectorId: row.id,
    connector: connector(),
    uom: row.settings.uom,
    existing,
    items: await readCatalogOfKind(tx, declaration.kind),
  };
  if (a.manual) {
    const link = await manualMapProduct(input, a.manual.code, a.manual.id);
    await upsertErpItemLink(tx, link);
    await audit({ action: 'erp.map' }, ['kind', 'code', 'remoteId', 'remoteUomId', 'source', 'checkedAt']);
    return { lines: ['已设置映射；重启应用生效'], code: 0 };
  }
  const result = await autoMapProducts(input);
  if (!a.dryRun) {
    for (const code of result.remove) await deleteErpItemLink(tx, row.id, declaration.kind, code);
    for (const link of result.links) await upsertErpItemLink(tx, link);
    await audit({ action: 'erp.map' }, ['kind', 'code', 'remoteId', 'remoteCode', 'remoteUomId', 'source', 'checkedAt']);
  }
  return {
    lines: [
      JSON.stringify(
        Object.fromEntries(
          ['mapped', 'unmapped', 'conflict', 'unitMismatch'].map((key) => {
            const codes = result[key as 'mapped'];
            return [key, { count: codes.length, codes }];
          }),
        ),
      ),
      a.dryRun ? 'dry-run：未写库' : '已映射；重启应用生效',
    ],
    code: 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await runErpConnector(process.argv.slice(2), {
    connect: async () => {
      const url = process.env.DATABASE_URL;
      if (!url) fail('缺少 DATABASE_URL（agent_app 身份）');
      const conn = await openDb(url);
      return { ...conn, lock: (tenantId) => holdTenantLock(url, tenantId) };
    },
  });
  process.exit(code);
}
