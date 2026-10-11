import { TenantLocal } from '../tenancy/local-state.js';
import { registerTenantState } from '../tenancy/state.js';
import { currentRuntime, type TenantRuntime } from '../tenancy/runtime.js';
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

// 每租户一份缓存；drop/reset 令旧请求的写回失效。
const caches = new TenantLocal(
  () => ({
    insightCache: null as { at: number; data: string[] } | null,
    sugCache: new Map<string, string>(),
    sugInflight: new Map<string, Promise<string>>(),
    draftCache: new Map<string, string>(),
    draftInflight: new Map<string, Promise<string>>(),
  }),
  (s) => {
    s.insightCache = null;
    s.sugCache.clear();
    s.sugInflight.clear();
    s.draftCache.clear();
    s.draftInflight.clear();
  },
);
type Caches = ReturnType<typeof caches.get>;
registerTenantState({ name: 'insight.insightCache', ...caches.registration((s) => Number(s.insightCache !== null)) });
registerTenantState({ name: 'insight.sugCache', ...caches.registration((s) => s.sugCache.size) });
registerTenantState({ name: 'insight.sugInflight', ...caches.registration((s) => s.sugInflight.size) });
registerTenantState({ name: 'insight.draftCache', ...caches.registration((s) => s.draftCache.size) });
registerTenantState({ name: 'insight.draftInflight', ...caches.registration((s) => s.draftInflight.size) });
const INSIGHT_TTL = 10 * 60 * 1000;

export async function getInsights(): Promise<string[]> {
  const rt = currentRuntime();
  const state = caches.get(rt);
  if (state.insightCache && Date.now() - state.insightCache.at < INSIGHT_TTL) return state.insightCache.data;
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
  const out = await rt.inflight.track(completeText(sys, user, { purpose: 'insight' }));
  if (rt.cancel.aborted || !caches.owns(rt, state)) return [];
  if (!out) return state.insightCache?.data ?? []; // LLM 不可用：返回旧缓存或空（前端回退规则版）
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
  if (lines.length) state.insightCache = { at: Date.now(), data: lines };
  return lines;
}

// ---------- 进行中请求去重 ----------
// 结果缓存只在请求**返回之后**才生效。顾问开着某个会话时，客户发一条消息会触发几次
// SSE → 重绘（客户消息落盘、写型工具落盘、AI 回复落盘），同一个 key 的请求还在飞就又发一次，
// 白花钱不说，还占着与客户对话共用的 LLM 并发名额。同 key 的并发调用共享同一个 Promise。
function dedupe(inflight: Map<string, Promise<string>>, key: string, run: () => Promise<string>): Promise<string> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

// ---------- 下一步建议（按会话，缓存 by id+消息数）----------

export async function getSuggestion(s: Session): Promise<string> {
  const rt = currentRuntime();
  const state = caches.get(rt);
  const key = s.id + ':' + (s.messages?.length ?? 0);
  const hit = state.sugCache.get(key);
  if (hit !== undefined) return hit;
  return rt.inflight.track(dedupe(state.sugInflight, key, () => suggest(s, key, rt, state)));
}

async function suggest(s: Session, key: string, rt: TenantRuntime, state: Caches): Promise<string> {
  const recent = (s.messages || [])
    .slice(-8)
    .map((m) => (m.role === 'customer' ? '客户' : m.role === 'agent' ? '顾问' : '系统') + '：' + m.content)
    .join('\n');
  const sys = prompts().suggestion;
  const user = '销售阶段：' + s.stage + '\n客户画像：' + JSON.stringify(profileForPrompt(s.profile)) + '\n近期对话：\n' + recent;
  const out = await completeText(sys, user, { purpose: 'suggestion' });
  if (rt.cancel.aborted || !caches.owns(rt, state)) return '';
  const val = (out || '').split('\n')[0].trim();
  if (val) {
    state.sugCache.set(key, val);
    if (state.sugCache.size > 500) state.sugCache.clear();
  }
  return val;
}

// ---------- AI 代拟回复（按会话，起草可以直接发给客户的下一条消息）----------
// 与「下一步建议」严格分开：建议是给顾问看的教练话术（内部口吻），绝不能直接发给客户；
// 这里生成的才是客户可读的正文，供「填入回复框」使用。

export async function getDraftReply(s: Session): Promise<string> {
  const rt = currentRuntime();
  const state = caches.get(rt);
  const key = s.id + ':' + (s.messages?.length ?? 0);
  const hit = state.draftCache.get(key);
  if (hit !== undefined) return hit;
  return rt.inflight.track(dedupe(state.draftInflight, key, () => draft(s, key, rt, state)));
}

async function draft(s: Session, key: string, rt: TenantRuntime, state: Caches): Promise<string> {
  const recent = (s.messages || [])
    .slice(-8)
    .map((m) => (m.role === 'customer' ? '客户' : m.role === 'agent' ? '顾问' : '系统') + '：' + m.content)
    .join('\n');
  const sys = prompts().draft;
  const user = '销售阶段：' + s.stage + '\n客户画像：' + JSON.stringify(profileForPrompt(s.profile)) + '\n近期对话：\n' + recent;
  const fallback = prompts().draftFallback[s.stage] || prompts().draftFallback[prompts().draftFallbackStage];
  const out = await completeText(sys, user, { purpose: 'draft' });
  if (rt.cancel.aborted || !caches.owns(rt, state)) return '';
  // 草稿是一键填进回复框、可能直接发给真实客户的文本：链接和订单号一律不许出现
  // （价格/订单只能来自工具，模型编的支付链接是钓鱼级风险）
  const cleaned = (out || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\/pay\/\S+/g, '')
    .replace(/ord_[A-Za-z0-9]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const val = cleaned || fallback;
  state.draftCache.set(key, val);
  if (state.draftCache.size > 500) state.draftCache.clear();
  return val;
}
