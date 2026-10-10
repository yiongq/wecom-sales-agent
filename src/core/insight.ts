// 后台 AI 洞察 / 下一步建议：聚合真实数据 → LLM 生成 → 缓存。
// LLM 不可用（mock / 未配 key / 失败）时返回空，前端回退到规则版。
import type { Session, Order } from '../types.js';
import { profileForPrompt } from '../types.js';
import { listSessions, listOrders } from '../store.js';
import { completeText } from './llm/client.js';
import { currentPack } from '../config/source.js';
const prompts = () => currentPack().runtime.insightPrompts;

function aggregate(sessions: Session[], orders: Order[]) {
  const active = sessions.filter((s) => s.stage !== 'handoff');
  const names = prompts().funnelNames;
  const cnt = [1, 2, 3, 4, 5].map((min) => active.filter((s) => (prompts().reach[s.stage] ?? -1) >= min).length);
  const paid = orders.filter((o) => o.status === 'paid');
  const paidSids = new Set(paid.map((o) => o.sessionId));
  const handoff = sessions.filter((s) => s.handedOver);
  const gmv = paid.reduce((a, o) => a + o.totalPrice, 0);
  const hoGmv = paid.filter((o) => sessions.find((s) => s.id === o.sessionId)?.handedOver).reduce((a, o) => a + o.totalPrice, 0);
  const stuck = sessions.filter((s) => prompts().stuckStages.includes(s.stage) && Date.now() - s.updatedAt >= 10 * 60000).length;
  return {
    total: sessions.length,
    funnel: names.map((n, i) => ({ name: n, count: cnt[i] })),
    conv: sessions.length ? Math.round((paidSids.size / sessions.length) * 100) : 0,
    handoffCount: handoff.length,
    handoffGmvPct: gmv ? Math.round((hoGmv / gmv) * 100) : 0,
    gmv,
    deals: paid.length,
    stuckQuotes: stuck,
  };
}

// ---------- AI 洞察（全局，缓存 10 分钟）----------
let insightCache: { at: number; data: string[] } | null = null;
const INSIGHT_TTL = 10 * 60 * 1000;

export async function getInsights(): Promise<string[]> {
  if (insightCache && Date.now() - insightCache.at < INSIGHT_TTL) return insightCache.data;
  const agg = aggregate(listSessions(), listOrders());
  const sys = prompts().insights;
  const user =
    '实时数据：\n' +
    '总会话 ' +
    agg.total +
    '，整体成交率 ' +
    agg.conv +
    '%，成交额 ¥' +
    agg.gmv.toLocaleString() +
    '（' +
    agg.deals +
    ' 单）。\n' +
    '销售漏斗（人数）：' +
    agg.funnel.map((f) => f.name + ' ' + f.count).join(' → ') +
    '。\n' +
    '转人工 ' +
    agg.handoffCount +
    ' 条，贡献 GMV ' +
    agg.handoffGmvPct +
    '%。\n' +
    '报价/促成档中已沉默超 10 分钟的会话 ' +
    agg.stuckQuotes +
    ' 条。';
  const out = await completeText(sys, user, { purpose: 'insight' });
  if (!out) return insightCache?.data ?? []; // LLM 不可用：返回旧缓存或空（前端回退规则版）
  let lines = out
    .split('\n')
    .map((l) => l.replace(/^[-*\d.、\s]+/, '').trim())
    .filter(Boolean);
  // 模型有时把三条挤在一行（句号分隔），按句切开
  if (lines.length < 2)
    lines = out
      .replace(/\n/g, '')
      .split(/(?<=[。！])/)
      .map((s) => s.trim())
      .filter(Boolean);
  lines = lines.slice(0, 3);
  if (lines.length) insightCache = { at: Date.now(), data: lines };
  return lines;
}

// ---------- 进行中请求去重 ----------
// 结果缓存只在请求**返回之后**才生效。顾问开着某个会话时，客户发一条消息会触发几次
// SSE → 重绘（客户消息落盘、写型工具落盘、AI 回复落盘），同一个 key 的请求还在飞就又发一次，
// 白花钱不说，还占着与客户对话共用的 LLM 并发名额。同 key 的并发调用共享同一个 Promise。
function dedupe(inflight: Map<string, Promise<string>>, key: string, run: () => Promise<string>): Promise<string> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- 下一步建议（按会话，缓存 by id+消息数）----------
const sugCache = new Map<string, string>();
const sugInflight = new Map<string, Promise<string>>();

export async function getSuggestion(s: Session): Promise<string> {
  const key = s.id + ':' + (s.messages?.length ?? 0);
  const hit = sugCache.get(key);
  if (hit !== undefined) return hit;
  return dedupe(sugInflight, key, () => suggest(s, key));
}

async function suggest(s: Session, key: string): Promise<string> {
  const recent = (s.messages || [])
    .slice(-8)
    .map((m) => (m.role === 'customer' ? '客户' : m.role === 'agent' ? '顾问' : '系统') + '：' + m.content)
    .join('\n');
  const sys = prompts().suggestion;
  const user = '销售阶段：' + s.stage + '\n客户画像：' + JSON.stringify(profileForPrompt(s.profile)) + '\n近期对话：\n' + recent;
  const out = await completeText(sys, user, { purpose: 'suggestion' });
  const val = (out || '').split('\n')[0].trim();
  if (val) {
    sugCache.set(key, val);
    if (sugCache.size > 500) sugCache.clear();
  }
  return val;
}

// ---------- AI 代拟回复（按会话，起草可以直接发给客户的下一条消息）----------
// 与「下一步建议」严格分开：建议是给顾问看的教练话术（内部口吻），绝不能直接发给客户；
// 这里生成的才是客户可读的正文，供「填入回复框」使用。
const draftCache = new Map<string, string>();
const draftInflight = new Map<string, Promise<string>>();

export async function getDraftReply(s: Session): Promise<string> {
  const key = s.id + ':' + (s.messages?.length ?? 0);
  const hit = draftCache.get(key);
  if (hit !== undefined) return hit;
  return dedupe(draftInflight, key, () => draft(s, key));
}

async function draft(s: Session, key: string): Promise<string> {
  const recent = (s.messages || [])
    .slice(-8)
    .map((m) => (m.role === 'customer' ? '客户' : m.role === 'agent' ? '顾问' : '系统') + '：' + m.content)
    .join('\n');
  const sys = prompts().draft;
  const user = '销售阶段：' + s.stage + '\n客户画像：' + JSON.stringify(profileForPrompt(s.profile)) + '\n近期对话：\n' + recent;
  const out = await completeText(sys, user, { purpose: 'draft' });
  // 草稿是一键填进回复框、可能直接发给真实客户的文本：链接和订单号一律不许出现
  // （价格/订单只能来自工具，模型编的支付链接是钓鱼级风险）
  const cleaned = (out || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\/pay\/\S+/g, '')
    .replace(/ord_[A-Za-z0-9]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const val = cleaned || prompts().draftFallback[s.stage] || prompts().draftFallback[prompts().draftFallbackStage];
  draftCache.set(key, val);
  if (draftCache.size > 500) draftCache.clear();
  return val;
}
