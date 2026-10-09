// 渠道账号（docs/architecture/03-channels-v2/spec.md「数据库」、R8）：本步只有基本读写；装载与解密在 src/channels/accounts.ts
// （第 6 步），命令行在第 14、15 步。agent_app 有 SELECT、INSERT 与列级 UPDATE（只能改 ChannelAccountPatch 里这几列），
// 没有 DELETE（停用代替删除）；kind、key、id_prefix、corp_id、open_kfid 建好不改，updated_at 由触发器写。
// 行里有密文与企微标识：调用方不打印整行（R9、不变量 16）
import { asc, eq } from 'drizzle-orm';
import type { ChannelAccountStatus, ChannelKind } from '../../shared/channel-types.js';
import { currentTenantCtx, type Tx } from '../client.js';
import { channelAccounts } from '../schema.js';

export interface ChannelAccountRow {
  id: string;
  key: string;
  kind: ChannelKind;
  name: string;
  status: ChannelAccountStatus;
  idPrefix: string | null;
  corpId: string | null;
  openKfid: string | null;
  secretsCt: Buffer | null;
  secretsKeyId: string | null;
  cursor: string | null;
  cursorAt: Date | null;
  recordOnlyUntil: Date | null;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewChannelAccount {
  key: string;
  kind: ChannelKind;
  name: string;
  status?: ChannelAccountStatus;
  idPrefix?: string | null;
  corpId?: string | null;
  openKfid?: string | null;
  secretsCt?: Buffer | null;
  secretsKeyId?: string | null;
  settings?: Record<string, unknown>;
}

/** 列级授权里 agent_app 能改的那几列（updated_at 由触发器写，不用给） */
export type ChannelAccountPatch = Partial<
  Pick<ChannelAccountRow, 'name' | 'status' | 'secretsCt' | 'secretsKeyId' | 'cursor' | 'cursorAt' | 'recordOnlyUntil' | 'settings'>
>;

const COLUMNS = {
  id: channelAccounts.id,
  key: channelAccounts.key,
  kind: channelAccounts.kind,
  name: channelAccounts.name,
  status: channelAccounts.status,
  idPrefix: channelAccounts.idPrefix,
  corpId: channelAccounts.corpId,
  openKfid: channelAccounts.openKfid,
  secretsCt: channelAccounts.secretsCt,
  secretsKeyId: channelAccounts.secretsKeyId,
  cursor: channelAccounts.cursor,
  cursorAt: channelAccounts.cursorAt,
  recordOnlyUntil: channelAccounts.recordOnlyUntil,
  settings: channelAccounts.settings,
  createdAt: channelAccounts.createdAt,
  updatedAt: channelAccounts.updatedAt,
};

/** 本租户的全部账号（任何状态），按建立先后、key 排 */
export async function listChannelAccounts(tx: Tx): Promise<ChannelAccountRow[]> {
  return tx.select(COLUMNS).from(channelAccounts).orderBy(asc(channelAccounts.createdAt), asc(channelAccounts.key));
}

/** 新建一个账号，返回整行 */
export async function insertChannelAccount(tx: Tx, a: NewChannelAccount): Promise<ChannelAccountRow> {
  const { tenantId } = currentTenantCtx();
  const [row] = await tx
    .insert(channelAccounts)
    .values({
      tenantId,
      key: a.key,
      kind: a.kind,
      name: a.name,
      ...(a.status !== undefined ? { status: a.status } : {}),
      idPrefix: a.idPrefix ?? null,
      corpId: a.corpId ?? null,
      openKfid: a.openKfid ?? null,
      secretsCt: a.secretsCt ?? null,
      secretsKeyId: a.secretsKeyId ?? null,
      ...(a.settings !== undefined ? { settings: a.settings } : {}),
    })
    .returning(COLUMNS);
  if (!row) throw new Error('channel_accounts：插入没有返回行');
  return row;
}

/** 改一个账号的可改列（cursor 推进、停用、换凭据、改设置）；返回是否改到了。patch 为空时什么都不发 */
export async function updateChannelAccount(tx: Tx, id: string, patch: ChannelAccountPatch): Promise<boolean> {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as ChannelAccountPatch;
  if (!Object.keys(set).length) return false;
  const out = await tx.update(channelAccounts).set(set).where(eq(channelAccounts.id, id)).returning({ id: channelAccounts.id });
  return out.length === 1;
}
