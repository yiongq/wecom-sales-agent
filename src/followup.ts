// 沉默唤醒 / 自动跟进调度器。
//
// 此前所有主动外发都要人点（顾问在后台点发送、或有人点了支付按钮触发回执），
// 没有任何按时间触发的跟进——而销售场景里「报价后沉默」恰恰是最该追的时刻：
// 客户不是不想买，是被别的事打断了，一条恰当的追问就能拉回来。
//
// 设计要点：
// - 每个会话每个阶段只追一次，且全程最多 MAX_PER_SESSION 次，绝不变成骚扰
// - 夜间不打扰（QUIET_HOURS），到点顺延到次日
// - 已转人工、已成交、访客模拟会话一律不追
// - 追问内容走 LLM 生成（带上下文，比模板自然），失败时用阶段模板兜底
import { flushStoreNow, getSession, listSessions, onShutdown, saveSession } from './store.js';
import { completeText } from './llm.js';
import { numEnv } from './env.js';
import type { Session, SalesStage } from './types.js';
import { profileForPrompt } from './types.js';

// 种子演示会话（wecom:cust_*）的 external_userid 是编出来的，send_msg 必然失败。
// 不排除的话，一开 FOLLOWUP_ENABLED=1 就会每轮为它们各烧一次 LLM 生成话术，
// 再对企微发一次注定失败的请求，永远收敛不了。与 store.ts 的 DEMO_SESSION_RE 同源。
const DEMO_SESSION_RE = /^wecom:cust_/;

/** 连续推送失败多少次后放弃该会话的这个阶段，不再每轮重试 */
const MAX_PUSH_FAILURES = 3;

/** 各阶段沉默多久算「该追了」（分钟）。不在表里的阶段不追。 */
const IDLE_MINUTES: Partial<Record<SalesStage, number>> = {
  quote: 120, // 报价后沉默 2 小时：最该追的时刻
  closing: 180, // 订单已建但没付
  objection: 240, // 提了异议没下文
  recommend: 360, // 看过线路没反应，隔久一点再问
};

/** 兜底话术：LLM 不可用时按阶段发，每条都得是能直接发给客户的正经话。
 *  线路的天数和住宿是固定的（sop.md 能力边界），只提真做得到的：换出发日期或人数重新报价、看别的现成线路。
 *  此前写着「酒店档次都可以再商量」「换个思路搭配、出个新方案」，客户照着回就接不住 */
const TEMPLATE: Partial<Record<SalesStage, string>> = {
  quote: '前两天给您报的价格，不知道您还有什么顾虑？出发日期或人数有变化的话跟我说，我按新的给您重新报～',
  closing: '您的订单我还给您留着呢～名额是以付款为准的，要是日期或人数需要改，跟我说一声我重新安排。',
  // 不用「要不要我…」这种是非问句（sop.md 话术原则）：客户只会答「可以」，还得再问一轮
  objection: '上次您提到的顾虑我记着呢——您更在意价格，还是出发时间？告诉我，我按这个帮您挑别的现成线路，或换个日期重新报价～',
  recommend: '之前给您看的几条线路，感觉哪条更对味一些？或者告诉我哪里不合适，我再帮您挑～',
};

const MAX_PER_SESSION = Math.max(0, numEnv('FOLLOWUP_MAX_PER_SESSION', 2));
const SCAN_MS = Math.max(60_000, numEnv('FOLLOWUP_SCAN_MS', 15 * 60_000));
const QUIET_START = numEnv('FOLLOWUP_QUIET_START', 22); // 22:00 起不打扰
const QUIET_END = numEnv('FOLLOWUP_QUIET_END', 9); // 次日 09:00 恢复

function inQuietHours(d = new Date()): boolean {
  const h = d.getHours();
  return QUIET_START > QUIET_END ? h >= QUIET_START || h < QUIET_END : h >= QUIET_START && h < QUIET_END;
}

interface FollowupMeta {
  count?: number;
  /** 已经在哪些阶段追过，避免同一阶段反复追 */
  stages?: string[];
  lastAt?: number;
  /** 连续推送失败次数，达到 MAX_PUSH_FAILURES 就放弃，别每轮都白烧一次 LLM */
  failures?: number;
  /** 这条跟进开始推送的时间：先记账再推送，推送有结果前一直挂着。重启后还在，说明推到一半进程没了——
   *  客户可能已经收到、对话记录里却没有这条；不管收没收到，都不会再发第二遍 */
  pendingAt?: number;
}
type SessionWithFollowup = Session & { followup?: FollowupMeta };

function shouldFollowUp(s: SessionWithFollowup): boolean {
  if (s.handedOver) return false; // 人工在跟，别插嘴
  if (s.channel !== 'wecom') return false; // 只追真实客户，不骚扰网页访客
  if (DEMO_SESSION_RE.test(s.id)) return false; // 种子演示数据，发不出去也不该发
  if (s.stage === 'paid' || s.stage === 'handoff') return false;
  if ((s.followup?.failures ?? 0) >= MAX_PUSH_FAILURES) return false;
  const threshold = IDLE_MINUTES[s.stage];
  if (!threshold) return false;
  const meta = s.followup ?? {};
  if ((meta.count ?? 0) >= MAX_PER_SESSION) return false;
  if (meta.stages?.includes(s.stage)) return false; // 这个阶段追过了
  const idleMin = (Date.now() - s.updatedAt) / 60_000;
  if (idleMin < threshold) return false;
  // 最后一条必须是我们发的——客户刚说完话还没回他，那是回复不是跟进
  const last = (s.messages ?? []).filter((m) => m.role !== 'system').at(-1);
  return !!last && last.role === 'agent';
}

async function composeFollowUp(s: Session): Promise<string> {
  const recent = (s.messages ?? [])
    .slice(-6)
    .map((m) => (m.role === 'customer' ? '客户' : '顾问') + '：' + m.content)
    .join('\n');
  const sys =
    '你是高端定制旅行的销售顾问。客户在这轮对话后沉默了一段时间，写一条主动跟进的微信消息把他拉回来。' +
    '要求：≤60 字；提一个具体的、能让他一句话回复的问题（不要「在吗」「考虑得怎么样」这种空话）；' +
    '不要催付款、不要制造焦虑、不要用感叹号堆情绪；不出现价格数字和链接；' +
    '线路的天数和住宿是固定的，不要提缩短天数、换酒店档次、重新搭配行程；只输出消息正文。';
  const user = `销售阶段：${s.stage}\n客户画像：${JSON.stringify(profileForPrompt(s.profile))}\n最近对话：\n${recent}`;
  const out = (await completeText(sys, user)).trim().split('\n')[0];
  // 生成内容同样不许带链接/订单号（跟进消息是主动外发，风险更高）
  const cleaned = out
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\/pay\/\S+/g, '')
    .replace(/ord_[A-Za-z0-9]+/g, '')
    .trim();
  return cleaned || TEMPLATE[s.stage] || '想起您之前的行程，还有什么我能帮上忙的随时说～';
}

// ---------------- 停机 ----------------
// 同一条跟进发两遍是主动外发最忌的事，所以一条跟进是「先把 count/stages 记进会话并同步落盘，再推企微」
// （见 scanOnce）：停机、崩溃落在推送途中，重启后这个阶段已经记过账，不会再追——宁可漏一条，不能重发。
// 此前是先推后记，而企微推送最坏要 47s（send_msg 最多 3 次 × 15s 超时），停机只等 8s，
// 推送送达、记账没落盘时进程被强杀，重启后同一条再发一遍。
// 停机时：不再起新扫描，进行中的扫描不再推下一条，手上这条推送尽量等它回来（好把消息记进对话），
// 但等不等得到都不影响会不会重发。正在生成话术的那条直接放弃：还没记账、没发出去，下次启动再追；
// 生成要调 LLM（超时 45s 起），等它只会把 8 秒的停机宽限期耗光，连企微那边的收尾一起被强杀。
let stopping = false;
let scanTask: Promise<number> | null = null;
let scanTimer: NodeJS.Timeout | null = null;
/** 正在等话术生成的扫描：停机时逐个叫醒，让它们放弃这次生成。生成结束就移除，不随扫描次数累积 */
const composeWaiters = new Set<() => void>();

/** 生成话术，但停机时提前返回 null（生成本身继续跑完，结果不用） */
async function composeUnlessStopping(s: Session): Promise<string | null> {
  const composing = composeFollowUp(s);
  composing.catch(() => undefined); // 停机时被弃用的那次生成，失败也别变成未捕获 rejection
  let wake!: () => void;
  const stopped = new Promise<null>((r) => {
    wake = () => r(null);
  });
  composeWaiters.add(wake);
  try {
    return await Promise.race([composing, stopped]);
  } finally {
    composeWaiters.delete(wake);
  }
}

async function drainForShutdown(): Promise<void> {
  stopping = true;
  for (const wake of composeWaiters) wake();
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  await scanTask?.catch(() => undefined);
}
onShutdown(drainForShutdown);

/** 扫描一轮。push 由调用方注入（server 传 adapterFor），便于测试 */
export function runFollowUpScan(push: (sessionId: string, text: string) => Promise<boolean>, now = new Date()): Promise<number> {
  if (process.env.FOLLOWUP_ENABLED !== '1' || stopping) return Promise.resolve(0);
  if (inQuietHours(now)) return Promise.resolve(0);
  // 上一轮还没扫完就不叠一轮：生成话术慢（每条要调一次 LLM），会话一多就会跨过扫描间隔。
  // 两轮并发时同一个会话在两边都还没记账，各生成一条、各推一次
  if (scanTask) return Promise.resolve(0);
  const task = scanOnce(push).finally(() => {
    if (scanTask === task) scanTask = null;
  });
  scanTask = task;
  return task;
}

async function scanOnce(push: (sessionId: string, text: string) => Promise<boolean>): Promise<number> {
  let sent = 0;
  for (const s of listSessions() as SessionWithFollowup[]) {
    if (stopping) break;
    if (!shouldFollowUp(s)) continue;
    try {
      const text = await composeUnlessStopping(s);
      if (text === null || stopping) {
        console.log(`[followup] 停机中，放弃尚未发出的跟进 ${s.id}（下次启动再追）`);
        break;
      }
      // 生成话术要几秒到几十秒，这期间客户很可能已经回消息了——那就不是跟进而是打断。
      // 用最新的会话对象重新判一次，避免发出「您之前的顾虑…」跟在客户刚说完的话后面。
      const fresh = getSession(s.id) as SessionWithFollowup | undefined;
      if (!fresh || !shouldFollowUp(fresh)) {
        console.log(`[followup] ${s.id} 在生成话术期间已有新动静，本轮跳过`);
        continue;
      }
      // 先记账、同步落盘，再推送（at-most-once，见上面「停机」）。
      // touch=false：不刷新 updatedAt。它代表「客户最后活跃时间」，跟进不该把沉默时长
      // 清零，否则后台「N 小时未回应」失真，介入队列也会漏掉真正该救的客户
      const meta = (fresh.followup ??= {});
      const stage = fresh.stage;
      const before = { count: meta.count, stages: meta.stages, lastAt: meta.lastAt };
      meta.count = (meta.count ?? 0) + 1;
      meta.stages = [...(meta.stages ?? []), stage];
      meta.lastAt = Date.now();
      meta.pendingAt = Date.now();
      saveSession(fresh, false);
      flushStoreNow();
      let ok: boolean;
      try {
        ok = await push(s.id, text);
      } catch (e) {
        // 推送抛异常：结果不明（可能已经送达）。账不退、pendingAt 留着，按已发处理——宁可漏一条，不能重发
        console.error(`[followup] 跟进 ${s.id} 推送结果不明，按已发处理、不再重试:`, e instanceof Error ? e.message : e);
        continue;
      }
      delete meta.pendingAt;
      if (!ok) {
        // 明确没送达：把记的账退回去，下一轮还能再追。
        // 失败也要记次数：企微 external_userid 无效、48h 窗口关闭这类是持续性失败，
        // 不计数就等于每轮扫描都白烧一次 LLM + 一次注定失败的 API 调用，永不收敛
        Object.assign(meta, before);
        meta.failures = (meta.failures ?? 0) + 1;
        saveSession(fresh, false);
        console.error(
          `[followup] 跟进消息未送达 ${s.id}（第 ${meta.failures}/${MAX_PUSH_FAILURES} 次失败${
            meta.failures >= MAX_PUSH_FAILURES ? '，不再重试' : ''
          }）`,
        );
        continue;
      }
      fresh.messages.push({ role: 'agent', content: text, at: Date.now() });
      meta.failures = 0;
      saveSession(fresh, false);
      sent += 1;
      console.log(`[followup] 已跟进 ${s.id}（阶段=${stage}）：${text.slice(0, 40)}`);
    } catch (e) {
      console.error(`[followup] 跟进 ${s.id} 失败:`, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

export function startFollowUpScheduler(push: (sessionId: string, text: string) => Promise<boolean>): void {
  if (process.env.FOLLOWUP_ENABLED !== '1') {
    console.log('[followup] 未启用（设 FOLLOWUP_ENABLED=1 开启自动跟进）');
    return;
  }
  console.log(`[followup] 自动跟进已启用：每 ${SCAN_MS / 60000} 分钟扫描一次，${QUIET_START}:00-${QUIET_END}:00 不打扰`);
  if (stopping) return;
  scanTimer = setInterval(() => {
    void runFollowUpScan(push);
  }, SCAN_MS);
  scanTimer.unref();
}

/** 仅供自测：把停机状态清回刚启动的样子 */
function resetForTest(): void {
  stopping = false;
  scanTask = null;
}

export const __followupTest = { resetForTest, TEMPLATE };
