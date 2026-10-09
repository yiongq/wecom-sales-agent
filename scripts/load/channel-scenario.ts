// 03 plan 第 19 步「压测」：在目标仓库自己的进程里跑的场景驱动（被 channel-run.ts 当子进程起，cwd 就是目标仓库，
// 所以这个文件里所有 `../../src/...` 的相对导入天然指向「跑它的那个仓库」自己的代码——baseline 组指向开工提交
// 5b697c2（02，env 账号、文件存储），03 组指向本 worktree（库里的两个企微账号）。channel-run.ts 会把这个文件和
// channel-fake-upstream.ts 原样复制到两边的 scripts/load/ 目录下再起子进程，两边跑的是完全相同的一份代码。
//
// 场景（spec「测试与 CI · 压测」）：mock LLM 2–8 秒延迟、真实 PG（基线组不连，走文件存储）、不杀进程；
// 只测两件事：①正确性——每条客户消息恰好一次回复、每个（客户、轮次）恰好一组 send_msg、没有重复 msgid；
// ②延迟——「客户消息到达假企微（拉取可见）→ 第一段 send_msg 到达假企微」的 p50/p95/p99。
// 不涉及转人工、顾问接手、429 风暴、对冲——spec 这一条压测原文没有这些。
//
// 读的环境变量（由 channel-run.ts 设好）：
//   SCN_MODE=baseline|channels, SCN_ACCOUNTS=JSON（[{id?, openKfId}]）, SCN_CUSTOMERS_PER_ACCOUNT, SCN_TURNS,
//   SCN_SEED, SCN_LLM_HOST, SCN_OUT_FILE, SCN_ROUND_TIMEOUT_MS
// 产品相关环境变量（CONFIG_SOURCE、SESSION_STORE、DATABASE_URL、WECOM_*、LLM_BASE_URL 等）由调用方照常设好。
import fs from 'node:fs';

interface ScnAccount {
  id?: string; // 库里账号的 uuid（channels 模式才有，用来调 syncAccountFromCallback）
  openKfId: string;
}

const MODE = process.env.SCN_MODE === 'channels' ? 'channels' : 'baseline';
const ACCOUNTS = JSON.parse(process.env.SCN_ACCOUNTS ?? '[]') as ScnAccount[];
const PER_ACCOUNT = Number(process.env.SCN_CUSTOMERS_PER_ACCOUNT ?? 25);
const TURNS = Number(process.env.SCN_TURNS ?? 10);
const SEED = Number(process.env.SCN_SEED ?? 1);
const LLM_HOST = process.env.SCN_LLM_HOST ?? 'llm.fake.invalid';
const ROUND_TIMEOUT_MS = Number(process.env.SCN_ROUND_TIMEOUT_MS ?? 120_000);

if (!ACCOUNTS.length) throw new Error('SCN_ACCOUNTS 为空');
const OUT_FILE: string =
  process.env.SCN_OUT_FILE ??
  (() => {
    throw new Error('缺少 SCN_OUT_FILE');
  })();

const TOTAL_CUSTOMERS = ACCOUNTS.length * PER_ACCOUNT;
const uidOf = (i: number): string => `wmlc${i}`;
const accountOf = (i: number): ScnAccount => ACCOUNTS[Math.floor(i / PER_ACCOUNT)]!;

const ROUND_MESSAGES = [
  '你好，想了解一下云南的线路',
  '大概两个人，预算五千左右',
  '国庆假期出发可以吗',
  '有没有海边的推荐',
  '价格大概多少',
  '能发一下详细行程吗',
  '住宿是几星级酒店',
  '可以改签吗',
  '还有优惠吗',
  '好的，我再想想',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  return check();
}

interface ScenarioOut {
  mode: string;
  totalCustomers: number;
  turns: number;
  issues: string[];
  duplicateMsgids: string[];
  totalMessages: number;
  totalMatchedReplies: number;
  latenciesMs: number[];
  p50: number;
  p95: number;
  p99: number;
}

async function main(): Promise<void> {
  const { installChannelFakeUpstream } = await import('./channel-fake-upstream.js');
  const fake = installChannelFakeUpstream({ llmHost: LLM_HOST, seed: SEED });

  console.log(`[scn] 启动目标服务（模式 ${MODE}，账号 ${ACCOUNTS.length} 个，每账号 ${PER_ACCOUNT} 客户，${TURNS} 轮）…`);
  await import('../../src/server.js');
  await sleep(500); // 让启动期的同步部分先跑完，不是必须，图个稳

  const wecomMod = await import('../../src/adapters/wecom.js');
  const syncFromCallback = wecomMod.syncFromCallback as (token: string) => Promise<void>;
  const syncAccountFromCallback = (wecomMod as { syncAccountFromCallback?: (id: string, token: string) => Promise<void> })
    .syncAccountFromCallback;

  const issues: string[] = [];
  const latencies: number[] = [];

  for (let r = 0; r < TURNS; r++) {
    const before = new Map<number, number>();
    for (let i = 0; i < TOTAL_CUSTOMERS; i++) before.set(i, fake.sentTo(accountOf(i).openKfId, uidOf(i)).length);

    const pushedAt: number[] = Array.from({ length: TOTAL_CUSTOMERS });
    const text = ROUND_MESSAGES[r % ROUND_MESSAGES.length]!;
    for (let i = 0; i < TOTAL_CUSTOMERS; i++) {
      pushedAt[i] = fake.pushCustomerMessage(accountOf(i).openKfId, uidOf(i), text);
    }

    if (MODE === 'baseline') {
      await syncFromCallback(`scn-r${r}`);
    } else {
      if (!syncAccountFromCallback) throw new Error('channels 模式缺少 syncAccountFromCallback');
      for (const acct of ACCOUNTS) {
        // eslint-disable-next-line no-await-in-loop
        await syncAccountFromCallback(acct.id!, `scn-r${r}`);
      }
    }

    const ok = await waitUntil(() => {
      for (let i = 0; i < TOTAL_CUSTOMERS; i++) {
        const acct = accountOf(i);
        if (fake.sentTo(acct.openKfId, uidOf(i)).length < (before.get(i) ?? 0) + 1) return false;
      }
      return true;
    }, ROUND_TIMEOUT_MS);
    if (!ok) issues.push(`第 ${r} 轮：等不到全部客户的回复（超时 ${ROUND_TIMEOUT_MS}ms）`);

    for (let i = 0; i < TOTAL_CUSTOMERS; i++) {
      const acct = accountOf(i);
      const uid = uidOf(i);
      const list = fake.sentTo(acct.openKfId, uid);
      const b = before.get(i) ?? 0;
      const delta = list.length - b;
      if (delta !== 1) {
        issues.push(`客户 ${uid}（账号 ${acct.openKfId}）第 ${r} 轮收到 ${delta} 组 send_msg（应恰好 1 组）`);
      }
      if (delta >= 1) {
        const entry = list[b]!;
        latencies.push(Math.max(0, entry.at - pushedAt[i]!));
      }
    }
    console.log(`[scn] 第 ${r} 轮完成（累计样本 ${latencies.length}/${(r + 1) * TOTAL_CUSTOMERS}）`);
  }

  const allSent = fake.allSent();
  const msgids = allSent.map((s) => s.msgid);
  const seen = new Set<string>();
  const duplicateMsgids: string[] = [];
  for (const m of msgids) {
    if (seen.has(m)) duplicateMsgids.push(m);
    else seen.add(m);
  }
  if (duplicateMsgids.length) issues.push(`出现重复 msgid：${duplicateMsgids.slice(0, 10).join('、')}`);

  console.log('[scn] 走停机钩子（释放租户锁、关连接池），不退出这个进程');
  try {
    const storeMod = (await import('../../src/store.js')) as { runShutdownHooks?: () => Promise<boolean> };
    if (storeMod.runShutdownHooks) {
      const drained = await storeMod.runShutdownHooks();
      if (!drained) console.warn('[scn] 停机钩子超时，继续收尾');
    }
  } catch (e) {
    console.warn('[scn] 停机钩子异常，继续收尾：', e);
  }

  const out: ScenarioOut = {
    mode: MODE,
    totalCustomers: TOTAL_CUSTOMERS,
    turns: TURNS,
    issues,
    duplicateMsgids,
    totalMessages: TOTAL_CUSTOMERS * TURNS,
    totalMatchedReplies: latencies.length,
    latenciesMs: latencies,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`[scn] 结果写到 ${OUT_FILE}`);
  console.log(JSON.stringify({ ...out, latenciesMs: `[${out.latenciesMs.length} 个样本，省略]` }, null, 2));
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error('[scn] 失败：', e);
    process.exit(1);
  },
);
