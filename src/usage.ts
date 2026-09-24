// 模型调用用量与成本核算。此前 API 响应里的 usage 字段从头到尾没被读过，
// 导致「这套系统一天花多少钱、一个客户聊到成交要花多少」只能靠估算——
// 而选型（air 还是 5.2）恰恰要靠这个数决定。
import fs from 'node:fs';
import path from 'node:path';
import { todayIso } from './env.js';

const VAR_DIR = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');
const FILE = path.join(VAR_DIR, 'usage.json');

/** 一组单价，元 / 百万 token。cachedIn 是命中前缀缓存那部分输入的单价（官方单列，不是统一折扣） */
interface PriceRow { in: number; out: number; cachedIn: number }
interface Price extends PriceRow {
  /** 输出阶梯：单次调用输出 ≥ minOut 个 token 时整组换成这档价（智谱 4.7 / 4.5-air 按「输出是否满 0.2K」分档，输入价也跟着变） */
  outTier?: PriceRow & { minOut: number };
}

/**
 * 官方价（智谱取「输入 <32K」档：本项目单轮输入远小于 32K）。未知模型按 0 计，只统计 token 不折算金额。
 *
 * 缓存价逐个模型填官方数字。以前用一个全局 25% 折扣，注释说「取两家里较贵的，宁可算高」，
 * 但 glm-5.3-flash 的缓存价是输入价的 28.75%，这个前提对新模型不成立，成本会少算。
 */
const PRICE: Record<string, Price> = {
  // 5.3 系列强制思考：推理 token 按输出计费，已含在 completion_tokens 里
  'glm-5.3': { in: 8, out: 28, cachedIn: 2 },
  'glm-5.3-flash': { in: 0.8, out: 2.8, cachedIn: 0.23 },
  'glm-5.3-flashx': { in: 2, out: 7, cachedIn: 0.57 },
  'glm-5.2': { in: 8, out: 28, cachedIn: 2 },
  'glm-5.1': { in: 6, out: 24, cachedIn: 1.3 },
  'glm-5': { in: 4, out: 18, cachedIn: 1 },
  'glm-5-turbo': { in: 5, out: 22, cachedIn: 1.2 },
  'glm-4.7': { in: 2, out: 8, cachedIn: 0.4, outTier: { minOut: 200, in: 3, out: 14, cachedIn: 0.6 } },
  'glm-4.6': { in: 4, out: 16, cachedIn: 0.8 },
  // 4.5 已在下线通知里，官方价目表不再列出，沿用下线前与 4.6 同档的价
  'glm-4.5': { in: 4, out: 16, cachedIn: 0.8 },
  'glm-4.5-air': { in: 0.8, out: 2, cachedIn: 0.16, outTier: { minOut: 200, in: 0.8, out: 6, cachedIn: 0.16 } },
  'glm-4.7-flashx': { in: 0.5, out: 3, cachedIn: 0.1 },
  // 免费模型也要在表里：不在表里会被当成「未知模型」告警，看着像漏配了价格
  'glm-4.7-flash': { in: 0, out: 0, cachedIn: 0 },
  // 已于 2026-01-30 下线，请求被自动路由到 glm-4.7-flash（免费）
  'glm-4.5-flash': { in: 0, out: 0, cachedIn: 0 },
  // DeepSeek 维持原来的数字：缓存价仍按输入价 25% 记（与改版前算出的金额一致）
  'deepseek-chat': { in: 2, out: 8, cachedIn: 0.5 },
  'deepseek-reasoner': { in: 4, out: 16, cachedIn: 1 },
  'deepseek-v4-flash': { in: 1, out: 2, cachedIn: 0.25 },
  'deepseek-v4-pro': { in: 12, out: 24, cachedIn: 3 },
  // 语义检索用的 embedding：只在启动/线路库变更时跑一次，金额小但不该显示成 0。没有缓存价
  'embedding-3': { in: 0.5, out: 0, cachedIn: 0.5 },
  'embedding-2': { in: 0.5, out: 0, cachedIn: 0.5 },
};

/** 价格表里没有的模型只记 token 不折金额——但必须喊一声，否则「成本 ¥0」看着像没花钱 */
const warnedUnknown = new Set<string>();

/** 这次调用落在哪一档价：阶梯按单次调用的输出量判断，所以只能逐次算，不能拿当天累计量套 */
function priceFor(price: Price, completionTokens: number): PriceRow {
  return price.outTier && completionTokens >= price.outTier.minOut ? price.outTier : price;
}

export interface UsageStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** promptTokens 中命中前缀缓存的部分（是其子集，不是额外的量） */
  cachedTokens: number;
  /** completionTokens 中的思考 token（是其子集，已按输出计费，只做展示）。
   *  强制思考的模型（glm-5.3 系列）上它决定了延迟与输出成本，不单列就看不出钱花在哪 */
  reasoningTokens: number;
  cny: number;
}
interface UsageState {
  day: string;
  byModel: Record<string, UsageStat>;
  /** 按会话累计，用于算「一个客户聊到成交花了多少」 */
  bySession: Record<string, { calls: number; cny: number }>;
}

// 与 budget/tools 统一走本地时区的「今天」，避免用量在北京时间早上 8 点归零
const today = todayIso;
const blank = (): UsageState => ({ day: today(), byModel: {}, bySession: {} });

let state: UsageState = blank();
try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as UsageState;
  if (raw?.day === today()) state = { day: raw.day, byModel: raw.byModel ?? {}, bySession: raw.bySession ?? {} };
} catch (e) {
  if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
    console.error('[usage] usage.json 解析失败，今日用量统计已从 0 重新开始:', e);
  }
}

let timer: NodeJS.Timeout | null = null;
function persist(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(VAR_DIR, { recursive: true });
      // 原子写：半截文件下次启动解析失败，今日成本统计会静默归零
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch { /* 用量统计落盘失败不该影响对话 */ }
  }, 3000);
}

export function costOf(model: string, promptTokens: number, completionTokens: number, cachedTokens = 0): number {
  const price = PRICE[model];
  if (!price) {
    if (!warnedUnknown.has(model)) {
      warnedUnknown.add(model);
      console.warn(`[usage] ⚠️ 模型 ${model} 不在价格表里，其成本会记为 ¥0（请在 src/usage.ts 的 PRICE 补一行）`);
    }
    return 0;
  }
  const p = priceFor(price, completionTokens);
  // 命中数是 promptTokens 的子集。夹一下上下界：供应商返回异常值（负数、或大于
  // prompt_tokens）时按全价算比算出负成本安全——成本统计宁可保守。
  const hit = Math.min(Math.max(0, cachedTokens), promptTokens);
  const fresh = promptTokens - hit;
  return (fresh * p.in + hit * p.cachedIn + completionTokens * p.out) / 1_000_000;
}

/** 每次真实模型调用后记一笔。sessionId 可空（后台洞察/建议这类非会话调用） */
export function recordUsage(
  model: string, promptTokens: number, completionTokens: number,
  sessionId?: string, cachedTokens = 0, reasoningTokens = 0,
): void {
  if (state.day !== today()) state = blank();
  const m = (state.byModel[model] ??= { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cny: 0 });
  // 旧 usage.json 里没有 cachedTokens / reasoningTokens 字段，跨版本重启后这里会是 undefined，
  // += 直接变 NaN 并顺着 JSON 落盘污染当天所有统计。补一次默认值。
  m.cachedTokens ??= 0;
  m.reasoningTokens ??= 0;
  const cny = costOf(model, promptTokens, completionTokens, cachedTokens);
  m.calls += 1;
  m.promptTokens += promptTokens;
  m.completionTokens += completionTokens;
  m.cachedTokens += Math.min(Math.max(0, cachedTokens), promptTokens);
  m.reasoningTokens += Math.min(Math.max(0, reasoningTokens), completionTokens);
  m.cny += cny;
  if (sessionId) {
    const s = (state.bySession[sessionId] ??= { calls: 0, cny: 0 });
    s.calls += 1;
    s.cny += cny;
  }
  persist();
}

export function usageToday(): {
  day: string;
  totalCalls: number;
  totalCny: number;
  avgCnyPerSession: number;
  /** 输入 token 里命中前缀缓存的占比（0~1）。0 且调用量不小 = 缓存没生效，去查前缀是不是被打断了 */
  cacheHitRate: number;
  /** 因缓存命中而少付的钱。这是 buildSystemPrompt 里那套排序规则唯一的验收指标 */
  cacheSavedCny: number;
  /** 输出 token 里思考 token 的合计（已计入输出费用，单列只为看清延迟和钱花在哪） */
  reasoningTokens: number;
  byModel: Record<string, UsageStat>;
} {
  if (state.day !== today()) state = blank();
  const models = Object.values(state.byModel);
  const totalCalls = models.reduce((a, m) => a + m.calls, 0);
  const totalCny = models.reduce((a, m) => a + m.cny, 0);
  const promptTokens = models.reduce((a, m) => a + m.promptTokens, 0);
  const cached = models.reduce((a, m) => a + (m.cachedTokens ?? 0), 0);
  // 省下的钱要按各模型自己的单价算，不能用总量乘一个平均价——便宜档和旗舰档
  // 差 10 倍，混在一起算出来的数没有意义。有输出阶梯的模型按基础档近似（只差几分之一分钱）
  const saved = Object.entries(state.byModel).reduce((a, [model, m]) => {
    const price = PRICE[model];
    return price ? a + (m.cachedTokens ?? 0) * (price.in - price.cachedIn) / 1_000_000 : a;
  }, 0);
  const reasoning = models.reduce((a, m) => a + (m.reasoningTokens ?? 0), 0);
  const sessions = Object.values(state.bySession);
  return {
    day: state.day,
    totalCalls,
    totalCny: Number(totalCny.toFixed(4)),
    avgCnyPerSession: sessions.length ? Number((sessions.reduce((a, s) => a + s.cny, 0) / sessions.length).toFixed(4)) : 0,
    cacheHitRate: promptTokens ? Number((cached / promptTokens).toFixed(4)) : 0,
    cacheSavedCny: Number(saved.toFixed(4)),
    reasoningTokens: reasoning,
    byModel: Object.fromEntries(
      Object.entries(state.byModel).map(([k, v]) => [k, {
        ...v, cachedTokens: v.cachedTokens ?? 0, reasoningTokens: v.reasoningTokens ?? 0, cny: Number(v.cny.toFixed(4)),
      }]),
    ),
  };
}

/** 某个会话累计花了多少（后台会话详情展示） */
export function sessionCost(sessionId: string): { calls: number; cny: number } {
  return state.bySession[sessionId] ?? { calls: 0, cny: 0 };
}
