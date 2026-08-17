// 模型调用用量与成本核算。此前 API 响应里的 usage 字段从头到尾没被读过，
// 导致「这套系统一天花多少钱、一个客户聊到成交要花多少」只能靠估算——
// 而选型（air 还是 5.2）恰恰要靠这个数决定。
import fs from 'node:fs';
import path from 'node:path';
import { todayIso } from './env.js';

const VAR_DIR = process.env.VAR_DIR ?? path.join(process.cwd(), 'var');
const FILE = path.join(VAR_DIR, 'usage.json');

/** 元 / 百万 token（输入, 输出）。未知模型按 0 计，只统计 token 不折算金额 */
const PRICE: Record<string, [number, number]> = {
  'glm-4.5-air': [0.8, 2],
  'glm-4.5-flash': [0.1, 0.1],
  'glm-4.5': [4, 16],
  'glm-4.6': [4, 16],
  'glm-4.7': [4, 16],
  'glm-5': [8, 28],
  'glm-5.1': [8, 28],
  'glm-5.2': [8, 28],
  'deepseek-chat': [2, 8],
  'deepseek-reasoner': [4, 16],
  'deepseek-v4-flash': [1, 2],
  'deepseek-v4-pro': [12, 24],
  // 语义检索用的 embedding：只在启动/线路库变更时跑一次，金额小但不该显示成 0
  'embedding-3': [0.5, 0],
  'embedding-2': [0.5, 0],
};

/** 价格表里没有的模型只记 token 不折金额——但必须喊一声，否则「成本 ¥0」看着像没花钱 */
const warnedUnknown = new Set<string>();

/**
 * 命中前缀缓存的输入 token 相对原价的折扣。
 *
 * 智谱 GLM 命中部分按 25% 计费；DeepSeek 的硬盘缓存更便宜。这里统一取智谱这档，
 * 也就是**两家里较贵的那个**——宁可把成本算高，也不要让后台显示的钱比实际花的少。
 * 真按 DeepSeek 跑时，实际账单只会比这里显示的更低。
 */
const CACHE_DISCOUNT = 0.25;

export interface UsageStat {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** promptTokens 中命中前缀缓存的部分（是其子集，不是额外的量） */
  cachedTokens: number;
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
  // 命中数是 promptTokens 的子集。夹一下上下界：供应商返回异常值（负数、或大于
  // prompt_tokens）时按全价算比算出负成本安全——成本统计宁可保守。
  const hit = Math.min(Math.max(0, cachedTokens), promptTokens);
  const fresh = promptTokens - hit;
  return (fresh * price[0] + hit * price[0] * CACHE_DISCOUNT + completionTokens * price[1]) / 1_000_000;
}

/** 每次真实模型调用后记一笔。sessionId 可空（后台洞察/建议这类非会话调用） */
export function recordUsage(
  model: string, promptTokens: number, completionTokens: number,
  sessionId?: string, cachedTokens = 0,
): void {
  if (state.day !== today()) state = blank();
  const m = (state.byModel[model] ??= { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cny: 0 });
  // 旧 usage.json 里没有 cachedTokens 字段，跨版本重启后这里会是 undefined，
  // += 直接变 NaN 并顺着 JSON 落盘污染当天所有统计。补一次默认值。
  m.cachedTokens ??= 0;
  const cny = costOf(model, promptTokens, completionTokens, cachedTokens);
  m.calls += 1;
  m.promptTokens += promptTokens;
  m.completionTokens += completionTokens;
  m.cachedTokens += Math.min(Math.max(0, cachedTokens), promptTokens);
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
  byModel: Record<string, UsageStat>;
} {
  if (state.day !== today()) state = blank();
  const models = Object.values(state.byModel);
  const totalCalls = models.reduce((a, m) => a + m.calls, 0);
  const totalCny = models.reduce((a, m) => a + m.cny, 0);
  const promptTokens = models.reduce((a, m) => a + m.promptTokens, 0);
  const cached = models.reduce((a, m) => a + (m.cachedTokens ?? 0), 0);
  // 省下的钱要按各模型自己的单价算，不能用总量乘一个平均价——便宜档和旗舰档
  // 差 10 倍，混在一起算出来的数没有意义
  const saved = Object.entries(state.byModel).reduce((a, [model, m]) => {
    const price = PRICE[model];
    return price ? a + (m.cachedTokens ?? 0) * price[0] * (1 - CACHE_DISCOUNT) / 1_000_000 : a;
  }, 0);
  const sessions = Object.values(state.bySession);
  return {
    day: state.day,
    totalCalls,
    totalCny: Number(totalCny.toFixed(4)),
    avgCnyPerSession: sessions.length ? Number((sessions.reduce((a, s) => a + s.cny, 0) / sessions.length).toFixed(4)) : 0,
    cacheHitRate: promptTokens ? Number((cached / promptTokens).toFixed(4)) : 0,
    cacheSavedCny: Number(saved.toFixed(4)),
    byModel: Object.fromEntries(
      Object.entries(state.byModel).map(([k, v]) => [k, { ...v, cachedTokens: v.cachedTokens ?? 0, cny: Number(v.cny.toFixed(4)) }]),
    ),
  };
}

/** 某个会话累计花了多少（后台会话详情展示） */
export function sessionCost(sessionId: string): { calls: number; cny: number } {
  return state.bySession[sessionId] ?? { calls: 0, cny: 0 };
}
