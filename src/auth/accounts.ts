// 平台的账号与成员管理（spec「导入、导出与回滚」的平台命令行）。以 agent_platform 身份连库：users、auth_sessions 直接读写，
// memberships 与审计受 RLS 约束、经 withTenant。审计记在 --tenant 指定的租户下，diff 永远不含口令。
// 改口令、停用账号吊销这个人的全部会话；移除成员只吊销他在本租户的会话。
import { withTenant, type Db, type TenantCtx } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import {
  deleteMembership,
  deleteSessionsOfUser,
  disableUser,
  findUserByEmail,
  insertUser,
  readMembership,
  setUserPassword,
  upsertMembership,
  type Role,
  type UserRow,
} from '../db/repo/auth.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { hashPassword } from './password.js';

export const ROLES: readonly Role[] = ['owner', 'admin', 'supervisor', 'agent', 'viewer'];
export const MIN_PASSWORD_LENGTH = 10;

export interface AccountResult {
  /** 0 成功或已一致；2 已有不一致的内容；1 其他错误 */
  code: 0 | 1 | 2;
  message: string;
}
const fail = (message: string): AccountResult => ({ code: 1, message });

async function context(db: Db, tenantSlug: string, what: string): Promise<{ ctx: TenantCtx } | AccountResult> {
  const tenant = await findTenantBySlug(db, tenantSlug);
  if (!tenant) return fail(`没有 slug 为「${tenantSlug}」的租户`);
  return { ctx: { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: what, ip: null } } };
}

/** 本租户的成员：不是成员的账号在这个租户下什么都不能动 */
async function member(db: Db, ctx: TenantCtx, email: string): Promise<{ user: UserRow; role: Role } | AccountResult> {
  const user = await findUserByEmail(db, email);
  if (!user) return fail(`没有邮箱为 ${email} 的账号`);
  const role = await withTenant(db, ctx, (tx) => readMembership(tx, user.id));
  if (!role) return fail(`${email} 不是这个租户的成员`);
  return { user, role };
}

const isResult = (x: object): x is AccountResult => 'code' in x;

/** 邮箱已存在时只加成员关系，不碰口令（password 此时不用）；已是同角色成员算已一致 */
export async function createUser(
  db: Db,
  input: { tenantSlug: string; email: string; name: string; role: Role; password: () => Promise<string> },
): Promise<AccountResult> {
  if (!ROLES.includes(input.role)) return fail(`角色只能是 ${ROLES.join('、')}`);
  const c = await context(db, input.tenantSlug, 'user-create');
  if (isResult(c)) return c;
  let user = await findUserByEmail(db, input.email);
  const created = !user;
  if (!user) {
    const password = await input.password();
    if (password.length < MIN_PASSWORD_LENGTH) return fail(`口令至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    user = await insertUser(db, { email: input.email.trim(), displayName: input.name, passwordHash: await hashPassword(password) });
  }
  const u = user;
  return withTenant(db, c.ctx, async (tx) => {
    const existing = await readMembership(tx, u.id);
    if (existing === input.role) return { code: 0, message: `${u.email} 已是这个租户的 ${existing}` };
    if (existing) return { code: 2, message: `${u.email} 已是这个租户的 ${existing}，没有改；换角色用 member-role` };
    await upsertMembership(tx, c.ctx.tenantId, u.id, input.role);
    await writeAudit(tx, {
      action: 'platform.user_create',
      targetType: 'user',
      targetId: u.id,
      diff: { email: u.email, role: input.role, created },
    });
    return { code: 0, message: `${created ? '已建账号并' : '账号已存在，已'}加为 ${input.role}：${u.email}` };
  });
}

/** 改口令，同时吊销这个人的全部会话 */
export async function setPassword(
  db: Db,
  input: { tenantSlug: string; email: string; password: () => Promise<string> },
): Promise<AccountResult> {
  const c = await context(db, input.tenantSlug, 'user-password');
  if (isResult(c)) return c;
  const m = await member(db, c.ctx, input.email);
  if (isResult(m)) return m;
  const password = await input.password();
  if (password.length < MIN_PASSWORD_LENGTH) return fail(`口令至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  await setUserPassword(db, m.user.id, await hashPassword(password));
  const revoked = await deleteSessionsOfUser(db, m.user.id);
  await withTenant(db, c.ctx, (tx) =>
    writeAudit(tx, {
      action: 'platform.user_password',
      targetType: 'user',
      targetId: m.user.id,
      diff: { email: m.user.email, revokedSessions: revoked },
    }),
  );
  return { code: 0, message: `已改 ${m.user.email} 的口令，吊销 ${revoked} 个会话` };
}

/** 停用账号（设 disabled_at），吊销全部会话 */
export async function disable(db: Db, input: { tenantSlug: string; email: string }): Promise<AccountResult> {
  const c = await context(db, input.tenantSlug, 'user-disable');
  if (isResult(c)) return c;
  const m = await member(db, c.ctx, input.email);
  if (isResult(m)) return m;
  if (!m.user.disabledAt) await disableUser(db, m.user.id);
  const revoked = await deleteSessionsOfUser(db, m.user.id);
  await withTenant(db, c.ctx, (tx) =>
    writeAudit(tx, {
      action: 'platform.user_disable',
      targetType: 'user',
      targetId: m.user.id,
      diff: { email: m.user.email, revokedSessions: revoked },
    }),
  );
  return { code: 0, message: `已停用 ${m.user.email}，吊销 ${revoked} 个会话` };
}

export async function setRole(db: Db, input: { tenantSlug: string; email: string; role: Role }): Promise<AccountResult> {
  if (!ROLES.includes(input.role)) return fail(`角色只能是 ${ROLES.join('、')}`);
  const c = await context(db, input.tenantSlug, 'member-role');
  if (isResult(c)) return c;
  const m = await member(db, c.ctx, input.email);
  if (isResult(m)) return m;
  if (m.role === input.role) return { code: 0, message: `${m.user.email} 已是 ${m.role}` };
  await withTenant(db, c.ctx, async (tx) => {
    await upsertMembership(tx, c.ctx.tenantId, m.user.id, input.role);
    await writeAudit(tx, {
      action: 'platform.member_role',
      targetType: 'user',
      targetId: m.user.id,
      diff: { email: m.user.email, role: [m.role, input.role] },
    });
  });
  return { code: 0, message: `${m.user.email}：${m.role} → ${input.role}` };
}

/** 删成员关系，吊销这个人在本租户的会话 */
export async function removeMember(db: Db, input: { tenantSlug: string; email: string }): Promise<AccountResult> {
  const c = await context(db, input.tenantSlug, 'member-remove');
  if (isResult(c)) return c;
  const m = await member(db, c.ctx, input.email);
  if (isResult(m)) return m;
  await withTenant(db, c.ctx, async (tx) => {
    await deleteMembership(tx, m.user.id);
    await writeAudit(tx, {
      action: 'platform.member_remove',
      targetType: 'user',
      targetId: m.user.id,
      diff: { email: m.user.email, role: m.role },
    });
  });
  const revoked = await deleteSessionsOfUser(db, m.user.id, c.ctx.tenantId);
  return { code: 0, message: `已把 ${m.user.email} 移出这个租户，吊销 ${revoked} 个会话` };
}
