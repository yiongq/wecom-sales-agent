// LLM 日预算硬闸。演示链接一旦对外公开就会被陌生人点，/api/chat 是公开匿名端点，
// 每次调用都花真钱——按 IP 限流挡不住持续刷（单 IP 20 条/分钟不停打，一天也是几万次）。
// 这里对「网页访客」的真实 LLM 调用记日计数并封顶；超额后网页端自动降级到
// 离线脚本回复（演示流程照样能走完，只是话术固定），企微真实客户不受影响。
import fs from 'node:fs';
import path from 'node:path';
import { numEnv, todayIso } from './env.js';

const VAR_DIR = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');
const FILE = path.join(VAR_DIR, 'budget.json');

/** 网页访客每日真实 LLM 轮次上限；0 = 不限制 */
const DAILY_CAP = Math.max(0, numEnv('DAILY_VISITOR_LLM_CALLS', 0));
/** 单个网页访客会话最多多少条消息走真实 LLM（防单人长跑）；0 = 不限制 */
const SESSION_CAP = Math.max(0, numEnv('VISITOR_SESSION_LLM_CALLS', 60));

interface BudgetState {
  day: string;
  calls: number;
  perSession: Record<string, number>;
}

// 与 tools/engine 的日期口径统一走本地时区。用 UTC 会让「跨天重置」发生在北京时间
// 早上 8 点：运营上班时额度凭空刷新一次，后台「今日成本」那会儿看恒为 0。
const today = todayIso;

let state: BudgetState = { day: today(), calls: 0, perSession: {} };
try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as BudgetState;
  if (raw && raw.day === today()) state = { day: raw.day, calls: raw.calls || 0, perSession: raw.perSession || {} };
} catch (e) {
  // 文件不存在是正常的（首次运行）；内容坏掉则意味着当日已消耗的额度被静默清零，
  // 必须留一行日志，否则「怎么又能刷了」永远查不出来
  if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
    console.error('[budget] budget.json 解析失败，当日访客额度已重置为 0:', e);
  }
}

let flushTimer: NodeJS.Timeout | null = null;
function persist(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      fs.mkdirSync(VAR_DIR, { recursive: true });
      // 原子写：直接覆盖时被 SIGKILL 撞上会留下半截文件，下次启动解析失败即额度清零
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch {
      /* 预算计数落盘失败不该影响对话 */
    }
  }, 2000);
}

function rollDay(): void {
  const d = today();
  if (state.day !== d) {
    state = { day: d, calls: 0, perSession: {} };
    console.log('[budget] 跨天重置访客 LLM 预算');
  }
}

/**
 * 占用一个访客 LLM 轮次名额：查额度与记账在同一个同步块里完成，返回 false 表示
 * 已超额，调用方应降级到 mock。仅用于 simulator 渠道——企微真实客户永远不限。
 *
 * 必须是「查+记」原子的：此前拆成 visitorMayUseLLM() + recordVisitorLLM()，
 * 中间隔着整轮 await chat()，上千个并发请求会全部读到同一个未超限的计数，
 * 日预算这道硬闸在突发流量下等于没有。
 */
export function tryReserveVisitorLLM(sessionId: string): boolean {
  rollDay();
  if (SESSION_CAP && (state.perSession[sessionId] ?? 0) >= SESSION_CAP) return false;
  if (DAILY_CAP && state.calls >= DAILY_CAP) return false;
  state.calls += 1;
  state.perSession[sessionId] = (state.perSession[sessionId] ?? 0) + 1;
  if (DAILY_CAP && state.calls === DAILY_CAP) {
    console.warn(`[budget] ⚠️ 今日访客 LLM 轮次已达上限 ${DAILY_CAP}，网页端降级为离线脚本回复（企微不受影响）`);
  }
  persist();
  return true;
}

export function budgetStatus(): { day: string; calls: number; dailyCap: number; sessionCap: number; degraded: boolean } {
  rollDay();
  return {
    day: state.day,
    calls: state.calls,
    dailyCap: DAILY_CAP,
    sessionCap: SESSION_CAP,
    degraded: DAILY_CAP > 0 && state.calls >= DAILY_CAP,
  };
}
