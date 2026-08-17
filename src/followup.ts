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
import { getSession, listSessions, saveSession } from './store.js';
import { completeText } from './llm.js';
import { numEnv } from './env.js';
import type { Session, SalesStage } from './types.js';

// 种子演示会话（wecom:cust_*）的 external_userid 是编出来的，send_msg 必然失败。
// 不排除的话，一开 FOLLOWUP_ENABLED=1 就会每轮为它们各烧一次 LLM 生成话术，
// 再对企微发一次注定失败的请求，永远收敛不了。与 store.ts 的 DEMO_SESSION_RE 同源。
const DEMO_SESSION_RE = /^wecom:cust_/;

/** 连续推送失败多少次后放弃该会话的这个阶段，不再每轮重试 */
const MAX_PUSH_FAILURES = 3;

/** 各阶段沉默多久算「该追了」（分钟）。不在表里的阶段不追。 */
const IDLE_MINUTES: Partial<Record<SalesStage, number>> = {
  quote: 120,      // 报价后沉默 2 小时：最该追的时刻
  closing: 180,    // 订单已建但没付
  objection: 240,  // 提了异议没下文
  recommend: 360,  // 看过线路没反应，隔久一点再问
};

/** 兜底话术：LLM 不可用时按阶段发，每条都得是能直接发给客户的正经话 */
const TEMPLATE: Partial<Record<SalesStage, string>> = {
  quote: '前两天给您报的价格，不知道还有没有什么想调整的？人数、日期、酒店档次都可以再商量，您说说顾虑我帮您想办法～',
  closing: '您的订单我还给您留着呢～名额是以付款为准的，要是日期或人数需要改，跟我说一声我重新安排。',
  objection: '上次您提到的顾虑我又琢磨了下，我这边可以帮您换个思路搭配，要不要我出个新方案给您看看？',
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
}
type SessionWithFollowup = Session & { followup?: FollowupMeta };

function shouldFollowUp(s: SessionWithFollowup): boolean {
  if (s.handedOver) return false;                       // 人工在跟，别插嘴
  if (s.channel !== 'wecom') return false;              // 只追真实客户，不骚扰网页访客
  if (DEMO_SESSION_RE.test(s.id)) return false;         // 种子演示数据，发不出去也不该发
  if (s.stage === 'paid' || s.stage === 'handoff') return false;
  if ((s.followup?.failures ?? 0) >= MAX_PUSH_FAILURES) return false;
  const threshold = IDLE_MINUTES[s.stage];
  if (!threshold) return false;
  const meta = s.followup ?? {};
  if ((meta.count ?? 0) >= MAX_PER_SESSION) return false;
  if (meta.stages?.includes(s.stage)) return false;     // 这个阶段追过了
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
    '不要催付款、不要制造焦虑、不要用感叹号堆情绪；不出现价格数字和链接；只输出消息正文。';
  const user = `销售阶段：${s.stage}\n客户画像：${JSON.stringify(s.profile)}\n最近对话：\n${recent}`;
  const out = (await completeText(sys, user)).trim().split('\n')[0];
  // 生成内容同样不许带链接/订单号（跟进消息是主动外发，风险更高）
  const cleaned = out.replace(/https?:\/\/\S+/g, '').replace(/\/pay\/\S+/g, '').replace(/ord_[A-Za-z0-9]+/g, '').trim();
  return cleaned || TEMPLATE[s.stage] || '想起您之前的行程，还有什么我能帮上忙的随时说～';
}

/** 扫描一轮。push 由调用方注入（server 传 adapterFor），便于测试 */
export async function runFollowUpScan(
  push: (sessionId: string, text: string) => Promise<boolean>,
  now = new Date(),
): Promise<number> {
  if (process.env.FOLLOWUP_ENABLED !== '1') return 0;
  if (inQuietHours(now)) return 0;
  let sent = 0;
  for (const s of listSessions() as SessionWithFollowup[]) {
    if (!shouldFollowUp(s)) continue;
    try {
      const text = await composeFollowUp(s);
      // 生成话术要几秒到几十秒，这期间客户很可能已经回消息了——那就不是跟进而是打断。
      // 用最新的会话对象重新判一次，避免发出「您之前的顾虑…」跟在客户刚说完的话后面。
      const fresh = getSession(s.id) as SessionWithFollowup | undefined;
      if (!fresh || !shouldFollowUp(fresh)) {
        console.log(`[followup] ${s.id} 在生成话术期间已有新动静，本轮跳过`);
        continue;
      }
      const ok = await push(s.id, text);
      if (!ok) {
        // 失败也要记次数：企微 external_userid 无效、48h 窗口关闭这类是持续性失败，
        // 不计数就等于每轮扫描都白烧一次 LLM + 一次注定失败的 API 调用，永不收敛
        const m = (fresh.followup ??= {});
        m.failures = (m.failures ?? 0) + 1;
        saveSession(fresh, false);
        console.error(
          `[followup] 跟进消息未送达 ${s.id}（第 ${m.failures}/${MAX_PUSH_FAILURES} 次失败${
            m.failures >= MAX_PUSH_FAILURES ? '，不再重试' : ''
          }）`,
        );
        continue;
      }
      s.messages.push({ role: 'agent', content: text, at: Date.now() });
      const meta = (s.followup ??= {});
      meta.failures = 0;
      meta.count = (meta.count ?? 0) + 1;
      meta.stages = [...(meta.stages ?? []), s.stage];
      meta.lastAt = Date.now();
      // touch=false：不刷新 updatedAt。它代表「客户最后活跃时间」，跟进不该把沉默时长
      // 清零，否则后台「N 小时未回应」失真，介入队列也会漏掉真正该救的客户
      saveSession(s, false);
      sent += 1;
      console.log(`[followup] 已跟进 ${s.id}（阶段=${s.stage}）：${text.slice(0, 40)}`);
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
  setInterval(() => { void runFollowUpScan(push); }, SCAN_MS).unref();
}
