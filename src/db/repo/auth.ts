// 鉴权的数据访问（spec「RLS、授权与认证函数」「鉴权」）。
// 运行时（agent_app）对 users、memberships、auth_sessions 没有任何表权限，只能经五个 SECURITY DEFINER 认证函数；
// 平台命令行（agent_platform）直接读写这几张表，写 memberships 时同样经 withTenant。
import { and, eq, sql } from 'drizzle-orm';
import { rowsOf, type Db, type Tx } from '../client.js';
import type { Role } from '../../shared/console-api.js';
import { authSessions, memberships, users } from '../schema.js';

export type { Role };

// ---------------- 运行时：认证函数 ----------------

export async function authLoginLookup(
  db: Db,
  tenantId: string,
  email: string,
): Promise<{ userId: string; passwordHash: string; role: Role; displayName: string } | null> {
  const [r] = rowsOf<{ o_user_id: string; o_password_hash: string; o_role: Role; o_display_name: string }>(
    await db.execute(sql`select * from auth_login_lookup(${tenantId}::uuid, ${email})`),
  );
  return r ? { userId: r.o_user_id, passwordHash: r.o_password_hash, role: r.o_role, displayName: r.o_display_name } : null;
}

export async function authSessionCreate(
  db: Db,
  s: { tenantId: string; tokenHash: Buffer; userId: string; now: Date; ip: string | null; userAgent: string | null },
): Promise<void> {
  await db.execute(
    sql`select auth_session_create(${s.tenantId}::uuid, ${s.tokenHash}, ${s.userId}::uuid, ${s.now.toISOString()}::timestamptz, ${s.ip}::inet, ${s.userAgent})`,
  );
}

export async function authSessionTouch(
  db: Db,
  tenantId: string,
  tokenHash: Buffer,
  now: Date,
): Promise<{ userId: string; role: Role; displayName: string } | null> {
  const [r] = rowsOf<{ o_user_id: string; o_role: Role; o_display_name: string }>(
    await db.execute(sql`select * from auth_session_touch(${tenantId}::uuid, ${tokenHash}, ${now.toISOString()}::timestamptz)`),
  );
  return r ? { userId: r.o_user_id, role: r.o_role, displayName: r.o_display_name } : null;
}

export async function authSessionDelete(db: Db, tokenHash: Buffer): Promise<void> {
  await db.execute(sql`select auth_session_delete(${tokenHash})`);
}

export async function authPasswordRehash(db: Db, tenantId: string, userId: string, oldHash: string, newHash: string): Promise<boolean> {
  const [r] = rowsOf<{ ok: boolean }>(
    await db.execute(sql`select auth_password_rehash(${tenantId}::uuid, ${userId}::uuid, ${oldHash}, ${newHash}) as ok`),
  );
  return r?.ok === true;
}

// ---------------- 平台命令行：直接读写 ----------------

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  disabledAt: Date | null;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName, disabledAt: users.disabledAt })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`);
  return row ?? null;
}

export async function insertUser(db: Db, u: { email: string; displayName: string; passwordHash: string }): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values(u)
    .returning({ id: users.id, email: users.email, displayName: users.displayName, disabledAt: users.disabledAt });
  return row!;
}

export async function setUserPassword(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function disableUser(db: Db, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ disabledAt: sql`now()` })
    .where(eq(users.id, userId));
}

/** 吊销会话：tenantId 给了只吊销这个租户的，不给就是这个人的全部会话 */
export async function deleteSessionsOfUser(db: Db, userId: string, tenantId?: string): Promise<number> {
  const rows = await db
    .delete(authSessions)
    .where(tenantId ? and(eq(authSessions.userId, userId), eq(authSessions.tenantId, tenantId)) : eq(authSessions.userId, userId))
    .returning({ userId: authSessions.userId });
  return rows.length;
}

/** 以下三个受 RLS 约束，调用方经 withTenant */
export async function readMembership(tx: Tx, userId: string): Promise<Role | null> {
  const [row] = await tx.select({ role: memberships.role }).from(memberships).where(eq(memberships.userId, userId));
  return row?.role ?? null;
}

export async function upsertMembership(tx: Tx, tenantId: string, userId: string, role: Role): Promise<void> {
  await tx
    .insert(memberships)
    .values({ tenantId, userId, role })
    .onConflictDoUpdate({ target: [memberships.tenantId, memberships.userId], set: { role } });
}

export async function deleteMembership(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx.delete(memberships).where(eq(memberships.userId, userId)).returning({ userId: memberships.userId });
  return rows.length > 0;
}
