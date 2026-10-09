// 行权删除（02 spec「隐私说明、敏感信息同意、保留期与行权」，R23）。以 platform 身份运行，要求应用已停（要取租户锁）：
//   docker compose stop app
//   docker compose run --rm platform node --import tsx src/cli/erase-conversation.ts \
//     --tenant <slug> --id <会话 id> --reason <文字> [--var <dir>]
// 不看保留期；删除范围与清除函数相同（会话行连同消息、trace、护栏事件、同意记录，按 id 删发送账本与 payload 里 sessionId
// 是它的任务，订单的 session_id 置空、data 去掉 sessionId）；写一行 platform.erase 审计，只有各类的条数与原因。
// 会话不存在时各类为 0、审计照写（留下有过这次请求的记录）。
// var/ 里有没回放的 spill 文件时拒绝：那是上次 db 存储停机时没落库的改动，这次删除看不到它们，删了等于白删
// （回放完才能确定这个会话到底在不在、该不该删）。
// 退出码：0 执行完成（conversations 为 1 是真删了，为 0 是会话本来就不在，两者都算成功）；
//         2 会话本不存在只是信息提示（仍是 0，见上）；3 应用还在跑（拿不到租户锁）；1 其他错误
import fs from 'node:fs';
import path from 'node:path';
import { holdTenantLock, withTenant } from '../db/client.js';
import { eraseConversation } from '../db/repo/retention.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { SPILL_FILE_RE } from '../store/project.js';
import { args, dbFromEnv, main, need } from './common.js';

const USAGE = 'erase-conversation --tenant <slug> --id <会话 id> --reason <文字> [--var <dir>]';

function checkSpill(varDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(varDir);
  } catch {
    return;
  }
  const spills = names.filter((f) => SPILL_FILE_RE.test(f));
  if (spills.length) {
    console.error(
      `[erase-conversation] 数据目录里有没回放的 spill 文件（${spills.join('、')}）：上次 db 存储停机时没落库的改动在里面，` +
        '这次删除看不到它们。先以 db 存储启动一次让它回放（成功后文件会删掉），再停机跑本命令；什么都没动',
    );
    process.exit(1);
  }
}

main(async () => {
  const a = args({ tenant: { type: 'string' }, id: { type: 'string' }, reason: { type: 'string' }, var: { type: 'string' } }, USAGE);
  const tenantSlug = need(a.tenant, '--tenant', USAGE);
  const convId = need(a.id, '--id', USAGE);
  const reason = need(a.reason, '--reason', USAGE);
  const varDir = a.var ?? process.env.VAR_DIR ?? path.join(process.cwd(), 'var');
  checkSpill(varDir);
  const { db, url, close } = await dbFromEnv('DATABASE_PLATFORM_URL');
  try {
    const tenant = await findTenantBySlug(db, tenantSlug);
    if (!tenant) {
      console.error(`[erase-conversation] tenant_not_found：没有 slug 为「${tenantSlug}」的租户`);
      return 1;
    }
    const lock = await holdTenantLock(url, tenant.id);
    if (!lock) {
      console.error(`[erase-conversation] lock_held：租户「${tenantSlug}」的锁在别的进程手里（应用还在跑？先 docker compose stop app）`);
      return 3;
    }
    try {
      const counts = await withTenant(
        db,
        { tenantId: tenant.id, actor: { kind: 'platform', userId: null, name: 'erase-conversation', ip: null } },
        (tx) => eraseConversation(tx, convId, reason),
      );
      console.log(
        `[erase-conversation] 完成：conversations=${counts.conversations} messages=${counts.messages} traces=${counts.traces} ` +
          `guardEvents=${counts.guardEvents} consents=${counts.consents} outboundSends=${counts.outboundSends} ` +
          `orders=${counts.orders} jobs=${counts.jobs} inbox=${counts.inbox}`,
      );
      if (counts.conversations === 0) {
        console.log(`[erase-conversation] 这个会话本来就不在（conversations=0），审计已记下这次请求`);
      }
      return 0;
    } finally {
      await lock.release();
    }
  } finally {
    await close();
  }
});
