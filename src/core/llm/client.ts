// OpenAI 兼容 chat completions 封装（默认智谱），含多轮工具调用循环。
// 离线脚本与工具缓存/重试声明由运行时注入，核心不装载行业包。
import { inTenantTx } from '../../db/client.js';
import type { ChatOptions, LlmRuntime } from './types.js';
import type { LlmErrorKind } from '../../trace/recorder.js';
import { recordUsage, type UsagePurpose } from '../../usage.js';
import { gatedFetch, gateBusy } from '../../llm-gate.js';
import { convLabel } from '../../log.js';
import { numEnv } from '../../env.js';

/**
 * 响应里的用量字段。智谱与 DeepSeek 都做隐式前缀缓存（按 messages 公共前缀匹配，
 * 命中部分打折计费），但**两家的字段名不一样**，统一在 cachedTokens() 里读。
 * 注意命中数已经包含在 prompt_tokens 里，不是额外的量。
 */
interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** 智谱 GLM */
  prompt_tokens_details?: { cached_tokens?: number };
  /** 思考 token，已包含在 completion_tokens 里（按输出计费），只做展示 */
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek */
  prompt_cache_hit_tokens?: number;
}

/** 本次请求命中前缀缓存的输入 token 数；供应商没返回就是 0（当作全部未命中，只会低估节省） */
function cachedTokens(u?: WireUsage): number {
  return u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
}

/** 记一次完成的调用。model 必须是**实际答出这次响应**的模型（对冲胜出时不是主模型）。purpose 缺省 chat（主对话） */
function recordCompletion(model: string, u: WireUsage | undefined, sessionId?: string, purpose?: UsagePurpose): void {
  recordUsage(
    model,
    u?.prompt_tokens ?? 0,
    u?.completion_tokens ?? 0,
    sessionId,
    cachedTokens(u),
    u?.completion_tokens_details?.reasoning_tokens ?? 0,
    purpose,
  );
}

/** chat() 入口处看到的固定前缀：system 原文与 JSON.stringify(tools)。只读，改不了请求 */
export interface ObservedRequest {
  system: string;
  tools: string;
}
let requestObserver: ((req: ObservedRequest) => void) | null = null;
/**
 * 只读的请求观察钩子，默认什么都不做。自测和 DB 模式的 eval 用它记录每个请求实际发出的 system 与 tools，
 * 核对它们与 /healthz 报的哈希一致（01 spec 验收 21）。传 null 卸下
 */
export function observeRequests(cb: ((req: ObservedRequest) => void) | null): void {
  requestObserver = cb;
}

/** 引擎唯一入口：返回助手最终文本（末尾可能带 <state> 块，由引擎剥离） */
export async function chat(opts: ChatOptions, runtime: LlmRuntime): Promise<string> {
  // 落库事务的回调里不调模型（02 不变量 9）：在 withTenant 里调到这里，说明有人把模型调用放进了事务，持锁跨过整次生成
  if (inTenantTx()) throw new Error('chat() 不能在 withTenant 的回调里调用：落库事务里只有 SQL，不调模型（02 不变量 9）');
  // 在 mock 与真实分支之前看：两条路发出去的前缀是同一份
  requestObserver?.({ system: opts.system, tools: JSON.stringify(opts.tools) });
  return process.env.LLM_MOCK === '1' || opts.forceMock ? runtime.mock.chat(opts) : realChat(opts, runtime);
}

/**
 * 供应商配置解析：LLM_PROVIDER=zhipu|deepseek 一键切换（各自读 ZHIPU_ / DEEPSEEK_ 前缀变量）；
 * 不设 LLM_PROVIDER 时沿用 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL 三件套（向后兼容）。
 */
export function llmCfg(cheap = false): { baseUrl: string; apiKey: string; model: string } {
  const p = (process.env.LLM_PROVIDER ?? '').toLowerCase();
  // 注意用 || 而不是 ??：.env 里 `ZHIPU_API_KEY=` 解析出的是空串不是 undefined，
  // ?? 不会回退，结果是「配了等于没配」且悄无声息
  if (p === 'deepseek') {
    return {
      baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '',
      model: (() => {
        // 与 zhipu 分支一样回退 LLM_MODEL；默认值取 .env.example 里写的那个，
        // 否则「照着 .env.example 配、只是没填 DEEPSEEK_MODEL」会静默跑到另一个模型上
        const main = process.env.DEEPSEEK_MODEL || process.env.LLM_MODEL || 'deepseek-chat';
        // 通用的 LLM_MODEL_CHEAP 在 README / .env.example 里推荐填 glm-4.5-air（智谱的模型名）。
        // 切到 deepseek 后照旧回退它，就会把 glm-4.5-air 发给 DeepSeek，后台洞察/跟进话术
        // 全部静默退回模板。glm- 开头的一律当「给智谱配的」忽略。
        return cheap ? cheapModel(process.env.DEEPSEEK_MODEL_CHEAP, main, (m) => !/^glm-/i.test(m)) : main;
      })(),
    };
  }
  if (p === 'zhipu') {
    return {
      baseUrl: (process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
      apiKey: process.env.ZHIPU_API_KEY || process.env.LLM_API_KEY || '',
      model: (() => {
        const main = process.env.ZHIPU_MODEL || process.env.LLM_MODEL || DEFAULT_MAIN_MODEL;
        return cheap ? cheapModel(process.env.ZHIPU_MODEL_CHEAP, main) : main;
      })(),
    };
  }
  return {
    baseUrl: (process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: (() => {
      const main = process.env.LLM_MODEL || DEFAULT_MAIN_MODEL;
      return cheap ? cheapModel(undefined, main) : main;
    })(),
  };
}

// 主对话模型的默认值。这个默认值的意义是「.env 丢失/换机器部署时跑什么」——
// 必须是可信的那个。
//
// 当初按「客服快聊瓶颈在延迟」选的是轻量档 glm-4.5-air，评测才发现它几乎不查产品库
// （48 次只调了 2 次工具），客户说了目的地也只会空手反问，于是换成 glm-5.2。
//
// 后来补测过中间档，结论是**维持 5.2，但 5.2 有个已知缺陷**，别把这段删了：
//
//   模型          摆真线路  调工具   回归      成本      P50      P90      超8s
//   glm-5.2       36/48    34/48   20/20    ¥0.7968   4042ms   6438ms    0%   ← 现用
//   glm-4.6       48/48    48/48   20/20    ¥0.4262   5780ms   9758ms   17%
//   glm-4.7       44/48    44/48   未跑      —        11s       —        —
//   glm-4.5-air    4/48     2/48   未跑      —        1701ms    —        —
//
// glm-4.6 在「摆线路」和成本上都更好，但**尾延迟不能接受**：17% 的轮次超过 8 秒、
// 最坏 17 秒。微信客服里客户等 8 秒以上就会以为没人在，这不是省 40% token 能换的。
// 当初拒绝 air 用的是「业务指标优先于延迟」，那次延迟代价是 1 秒；这次是 17 秒，
// 不是同一个量级，同一条原则不能机械套用。
//
// 真正该修的不是选型，是 5.2 那 14/48 轮**根本没调工具**。原计划用 tool_choice 强制查库，
// 但智谱的 tool_choice 只支持 auto，已改为引擎预取（engine.ts planPrefetch）：客户点了新目的地，
// 引擎先替模型查一次库，经 ChatOptions.prefetch 交给模型，顺带省掉一次往返。
//
// 2026-09-24 换成 glm-5.3-flashx。同机同时段、新代码（带预取）实测：
//
//   模型             摆真线路  回归     首轮P50  首轮P90  超8s          每千轮
//   glm-5.3-flashx   48/48    23/23    2753ms   5080ms   0%（最坏6.3s）  ¥4.8   ← 现用
//   glm-5.2          48/48    23/23    4077ms   5401ms   4.2%（最坏25s） ¥16.4  ← 对冲兜底
//
// 同一个 flashx 在旧代码下 21% 的轮次超 8 秒、被否过一次：它强制思考，每次 API 往返固定多 2~3 秒，
// 旧写法一轮要两三次往返。是预取把首轮压成一次往返，它才过得了线——**别把预取当成可有可无的优化删掉**，
// 删了就得换回 glm-5.2。
const DEFAULT_MAIN_MODEL = 'glm-5.3-flashx';
// 后台自用路径（AI 洞察 / 成交概率 / 下一步建议 / 沉默跟进话术）的模型。
// **默认与主对话同款**——主模型 glm-5.3-flashx 单次后台调用约 ¥0.001，没必要再降档。
// 主模型换回旗舰时可设 LLM_MODEL_CHEAP=glm-4.7-flashx 单独省钱（后台没有工具调用，客户看不到）。
//
// 便宜档集合仅用于识别「主对话被误配成便宜档」（启动告警）。收的是实测或同代里
// 「几乎不查产品库」的轻量档；glm-5.3-flash / flashx 不在里面——flashx 就是现用主模型。
export const CHEAP_TIER_MODELS: ReadonlySet<string> = new Set([
  'glm-4.5-air',
  'glm-4.5-airx',
  'glm-4.5-flash',
  'glm-4.7-flash',
  'glm-4.7-flashx',
]);
/** 后台模型：显式配了就用，否则跟随主模型。acceptGeneric 用来挡掉「给别家供应商配的」通用值 */
function cheapModel(specific: string | undefined, main: string, acceptGeneric: (m: string) => boolean = () => true): string {
  const generic = process.env.LLM_MODEL_CHEAP;
  return specific || (generic && acceptGeneric(generic) ? generic : '') || main;
}

/** 当前生效的模型，供启动日志与 /healthz 展示——避免"跑着哪个模型"只能靠猜 */
export function activeModels(): { main: string; cheap: string } {
  return { main: llmCfg().model, cheap: llmCfg(true).model };
}

// ---------- 思考参数 ----------
//
// 智谱各代模型对 thinking 的要求不一样，而且发错是直接 400，不是降级：
//   · glm-5.2 及更早：能关。客服快聊要的是首字延迟，关掉（thinking.disabled）。
//   · glm-5.3 / 5.3-flash / 5.3-flashx：**强制思考**，发 disabled 返回 400 + 错误码 1210
//     「该模型始终思考，不支持关闭思考；请使用 low、high 或 max」。只能 enabled，再用
//     reasoning_effort 压档（默认 max）。实测 low 档 48 轮思考 token 合计才 135，
//     但每次调用仍有 2~3.5 秒固定开销——切模型前先拿 eval 看「超 8 秒占比」。
// 以后再出强制思考的新模型不必等人改正则：收到 1210 就改发 enabled 重试一次，成功了记住它。
// 但**正则不能省**，自愈只是兜底：实测 glm-5.3-flashx 只在不带 tools 的请求上对 disabled 报 1210；
// 带 tools 的主对话请求发 disabled 会被静默接受、按默认 max 档照样思考（同一句话 7.3s 对 1.5s）。
// 所以主对话路径上认不出的强制思考模型只能靠「发了 disabled 却返回思考 token」告警发现，
// 后台 completeText（不带 tools）一旦自愈，学到的结果主对话也共用。

const REASONING_EFFORTS = new Set(['low', 'high', 'max']);
/** 强制思考模型的思考档位（LLM_REASONING_EFFORT），只认官方三档，填错按 low——填错不该让每个请求都 400 */
function reasoningEffort(): string {
  const v = (process.env.LLM_REASONING_EFFORT || '').trim().toLowerCase();
  return REASONING_EFFORTS.has(v) ? v : 'low';
}

/** 运行中靠 1210 自愈学到的强制思考模型（进程内缓存；重启清空，重启后首个请求会再自愈一次） */
const learnedThinking = new Set<string>();
/** 已告警过「disabled 被无视」的模型，每个只喊一次 */
const warnedIgnoredDisabled = new Set<string>();
/** hedgeFired/hedgeWon 是总数；followup* 单记工具往返后那几次调用（阈值更低），用来看调低阈值值不值 */
const stats = { hedgeFired: 0, hedgeWon: 0, followupHedgeFired: 0, followupHedgeWon: 0, thinkingSelfHeal: 0, toolReused: 0 };

const isZhipu = (baseUrl: string): boolean => baseUrl.includes('bigmodel');

function mustThink(baseUrl: string, model: string): boolean {
  return learnedThinking.has(model) || (isZhipu(baseUrl) && /^glm-5\.3/i.test(model));
}

/** thinking 参数仅智谱识别；其他 OpenAI 兼容端（DeepSeek 等）可能拒绝未知字段，一律不带 */
function thinkingParams(baseUrl: string, model: string, forceThink = false): Record<string, unknown> {
  if (forceThink || mustThink(baseUrl, model)) {
    return { thinking: { type: 'enabled' }, reasoning_effort: reasoningEffort() };
  }
  return isZhipu(baseUrl) ? { thinking: { type: 'disabled' } } : {};
}

/** 1210 在智谱是笼统的「参数有误」，必须同时看到「思考」字样才算强制思考——
 *  否则一次别的参数错误会把能关思考的模型切进思考模式，白白多出几秒延迟 */
function isAlwaysThinkingError(status: number, detail: string): boolean {
  return status === 400 && /"code"\s*:\s*"?1210\b/.test(detail) && /思考|thinking/i.test(detail);
}

// 超时防线：LLM 挂起时不能无限等（undici 默认约 300s，会拖垮企微串行处理链）。
// 超时抛错走调用方既有 catch（客户收到「开小差」兜底文案），而非全渠道停摆。
function llmTimeout(): AbortSignal {
  return AbortSignal.timeout(Math.max(5000, numEnv('LLM_TIMEOUT_MS', 45000)));
}

// 单次请求有超时不等于一轮对话有上限：6 轮工具调用 × 45s，加上空文本重试再跑一遍，
// 最坏能占住 ~14 分钟。这段时间企微那批消息的 Promise.all 不结束、cursor 不推进，
// 同批次其他客户全部干等。所以整轮再压一个墙钟上限。
function roundDeadline(): AbortSignal {
  return AbortSignal.timeout(Math.max(10000, numEnv('LLM_ROUND_TIMEOUT_MS', 120000)));
}

// ---------- 单次 API 请求 ----------

interface Endpoint {
  baseUrl: string;
  apiKey: string;
}
interface Completion {
  choices?: { message?: WireMessage; finish_reason?: string }[];
  usage?: WireUsage;
}

/** 非 2xx 响应。消息里带状态码和模型：日志里要能直接看出是哪个模型、为什么被拒 */
class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly model: string,
    detail: string,
  ) {
    const hint = status === 401 || status === 403 ? '（API key 无效或无权限，请检查 LLM_API_KEY）' : '';
    super(`LLM 请求失败 ${status}${hint} model=${model}: ${detail.slice(0, 300)}`);
  }
}

/**
 * 向一个模型发一次 chat/completions（排队/退避重试在 gatedFetch 里），含 1210 自愈。
 * 成功返回解析后的响应，失败抛 LlmHttpError 或网络/超时错误。不记 usage——
 * 对冲时只有胜出的那个该记，由调用方决定。
 */
async function requestModel(ep: Endpoint, model: string, payload: Record<string, unknown>, signal: () => AbortSignal): Promise<Completion> {
  const send = (forceThink: boolean) =>
    gatedFetch(
      ep.baseUrl + '/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
        body: JSON.stringify({ model, ...payload, ...thinkingParams(ep.baseUrl, model, forceThink) }),
      },
      signal,
    );
  let { res, errorBody } = await send(false);
  if (!res.ok) {
    // 重试过的响应 body 已被 gatedFetch 读掉，再 res.text() 会抛「Body is unusable」，
    // 把 429 的真实原因（配额说明）整条吃掉——用它带出来的副本
    let detail = errorBody ?? (await res.text().catch(() => ''));
    if (isAlwaysThinkingError(res.status, detail) && !mustThink(ep.baseUrl, model)) {
      // 先按强制思考重发，**成功了才记住**：万一判断错了，不会把一个能关思考的模型永久切过去
      ({ res, errorBody } = await send(true));
      if (res.ok) {
        learnedThinking.add(model);
        stats.thinkingSelfHeal += 1;
        console.warn(
          `[llm] 模型 ${model} 不支持关闭思考（1210），已改用 thinking=enabled + reasoning_effort=${reasoningEffort()}，本进程内后续请求直接这样发`,
        );
      } else {
        detail = errorBody ?? (await res.text().catch(() => ''));
      }
    }
    if (!res.ok) throw new LlmHttpError(res.status, model, detail);
  }
  const data = (await res.json()) as Completion;
  // 发了 disabled 却照样思考：多半是正则没收录的强制思考模型，在按默认最高档想，延迟会翻几倍。
  // 只告警不自动切：自动给老模型加 reasoning_effort 可能换来 400，那比慢更糟
  const think = thinkingParams(ep.baseUrl, model) as { thinking?: { type?: string } };
  if (
    think.thinking?.type === 'disabled' &&
    (data.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0 &&
    !warnedIgnoredDisabled.has(model)
  ) {
    warnedIgnoredDisabled.add(model);
    console.warn(
      `[llm] ⚠️ 模型 ${model} 收到 thinking=disabled 仍返回了思考 token，可能是强制思考模型、正按默认最高档思考（明显变慢）。` +
        '若确认如此，请在 src/core/llm/client.ts 的 mustThink 里收录它，以便发 enabled + 低档 reasoning_effort',
    );
  }
  return data;
}

// ---------- 对冲兜底（默认关闭，设 LLM_HEDGE_MODEL 开启） ----------
//
// 尾延迟多半来自上游偶发的慢请求，而不是模型的平均速度：P50 4 秒的模型也会冒出一次 17 秒，
// 而客户等 8 秒以上就以为没人在。所以在**单次 API 请求**层面对冲：
//   · 主模型超过 LLM_HEDGE_MS（默认 6000）还没返回，用同一份 messages 让对冲模型也答一次
//     （按对冲模型自己的思考参数发）；
//   · 主请求直接失败（非 2xx 重试耗尽、网络错误）时立刻改用对冲模型，不等计时器；
//   · 谁先成功用谁，另一个立即 abort——gatedFetch 的排队、退避等待和每次尝试都响应这个信号，
//     输家不管停在哪一步都马上让出名额。
// **不会重复产生副作用**：工具是 realChatOnce 拿到响应之后才执行的，一次请求只采用一个响应，
// 输家即使返回了 tool_calls 也没人看见、更不会执行。对冲的只是「问模型」这一步。
// 代价：输家被 abort 前生成的 token 供应商照样计费，但我们拿不到它的 usage，只能按胜者记账。
// 只在对冲模型与主模型不同时启用——同款模型慢多半是它那条队列在堵，再发一个大概率排进同一条队；
// 名额已满时计时器也不加发，拥堵时多一个请求只会让所有人排得更久。
//
// 工具往返之后的调用（同一轮第 2 次起）用单独的阈值 LLM_HEDGE_MS_FOLLOWUP（默认 2800，不超过首轮阈值）。
// 一轮的耗时是几次往返**相加**：第二次调用卡住时要等满首轮的 4 秒才对冲、对冲模型再答几秒，整轮就冲过
// 8 秒线（2026-09 场景测试 A04：11.8 秒，靠的正是第二次调用上的对冲）。这几次请求只是上一次原样加上
// 工具结果，多半只写一段回复，正常比首轮快；首轮常要据预取结果直接写完整回复，本来就慢一截，不跟着调低。
// 2026-09-25 实测 flashx（44 轮 69 次调用，未开对冲）：首轮 P50 2.6s、48% 超 2.8s；后续 P50 1.8s、30% 超 2.8s。
//
// 账要心里有数：flashx 的慢请求是上游抖动（34 个 token 的工具调用也要 3.4 秒，与输出长短、思考 token 无关），
// 集中在 3.3~4.8 秒一档；对冲模型 glm-5.2 自己一次就要 4 秒上下，这一档它抢不过。调低阈值只在真正的离群
// 请求（6~7 秒以上）上早 1.2 秒兜住，代价是后续调用里多出约一成照样计费的对冲请求（超 2.8s 30% 对超 4s 19%）。
// /healthz 的 followupHedgeFired / followupHedgeWon 就是核对这笔账的；不划算就把它设成与 LLM_HEDGE_MS 相同。

function hedgeModelFor(model: string): string | null {
  const h = (process.env.LLM_HEDGE_MODEL || '').trim();
  return h && h !== model ? h : null;
}
function hedgeMs(): number {
  return Math.max(0, numEnv('LLM_HEDGE_MS', 6000));
}
/** 工具往返之后那几次调用的对冲阈值。不超过首轮阈值：只把首轮调到 2 秒时，后续反而等得更久说不通 */
function hedgeFollowupMs(): number {
  return Math.min(hedgeMs(), Math.max(0, numEnv('LLM_HEDGE_MS_FOLLOWUP', 2800)));
}

/**
 * 带对冲的单次请求。返回响应和**实际答出它的模型**（usage 要记在它名下）。
 * round 是这次请求在本轮工具循环里的序号（0 = 首次），决定用哪个对冲阈值。
 */
function requestHedged(
  ep: Endpoint,
  model: string,
  payload: Record<string, unknown>,
  signal: () => AbortSignal,
  round = 0,
): Promise<{ data: Completion; model: string }> {
  const hedge = hedgeModelFor(model);
  if (!hedge) return requestModel(ep, model, payload, signal).then((data) => ({ data, model }));
  const followup = round > 0;
  const afterMs = followup ? hedgeFollowupMs() : hedgeMs();
  return new Promise((resolve, reject) => {
    const primaryCtl = new AbortController();
    const hedgeCtl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let hedgeLaunched = false;
    let inflight = 0;
    let primaryErr: unknown;
    let hedgeErr: unknown;
    const settle = (fn: () => void): void => {
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const launch = (m: string, own: AbortController, other: AbortController, isHedge: boolean): void => {
      inflight += 1;
      requestModel(ep, m, payload, () => AbortSignal.any([signal(), own.signal])).then(
        (data) => {
          inflight -= 1;
          if (settled) return;
          other.abort(); // 输家立即取消
          if (isHedge) {
            stats.hedgeWon += 1;
            if (followup) stats.followupHedgeWon += 1;
          }
          settle(() => resolve({ data, model: m }));
        },
        (e: unknown) => {
          inflight -= 1;
          if (settled) return; // 胜负已分后输家因 abort 失败是正常的，不记
          if (isHedge) {
            hedgeErr = e;
            // 必须留痕：对冲模型名拼错、或不接受当前参数（400/404）时，每次慢请求都会加发一个
            // 注定失败的对冲，尾延迟保护完全失效，而 /healthz 上只能看到 hedgeWon 一直是 0。
            // 两边都失败时抛的是主模型的错，对冲这边的原因只有这里能看到
            console.warn(`[llm] ⚠️ 对冲模型 ${m} 请求失败:`, e instanceof Error ? e.message : e);
          } else {
            primaryErr = e;
            launchHedge(false, e);
          }
          // 两边都失败（或对冲已不可能发出）才算失败；报主模型的错，它更能说明问题
          if (inflight === 0 && hedgeLaunched) settle(() => reject(primaryErr ?? hedgeErr));
        },
      );
    };
    const launchHedge = (onTimer: boolean, cause?: unknown): void => {
      if (settled || hedgeLaunched) return;
      if (onTimer && gateBusy()) return; // 主请求若随后直接失败，仍会走失败分支改用对冲
      hedgeLaunched = true;
      if (signal().aborted) return; // 整轮 deadline 已到，再发也是秒失败
      stats.hedgeFired += 1;
      if (followup) stats.followupHedgeFired += 1;
      // 主请求失败时带上原因：对冲接住了，客户看不出问题，主模型配错就只能从这行日志发现
      const why = onTimer ? `超过 ${afterMs}ms 未返回` : `请求失败（${cause instanceof Error ? cause.message : String(cause)}）`;
      // 标出是第几次往返：首轮和工具往返后的阈值不同，日志里要分得清是哪一档触发的
      console.warn(`[llm] 主模型 ${model} ${why}（本轮第 ${round + 1} 次调用），对冲到 ${hedge}`);
      launch(hedge, hedgeCtl, primaryCtl, true);
    };
    timer = setTimeout(() => launchHedge(true), afterMs);
    launch(model, primaryCtl, hedgeCtl, false);
  });
}

/** 运行时统计，供 /healthz 展示：对冲是否在起作用、哪些模型在强制思考 */
export function llmStats(): {
  reasoningEffort: string;
  forcedThinkingModels: string[];
  thinkingSelfHeal: number;
  hedgeModel: string | null;
  hedgeMs: number;
  hedgeMsFollowup: number;
  hedgeFired: number;
  hedgeWon: number;
  followupHedgeFired: number;
  followupHedgeWon: number;
  toolReused: number;
} {
  const { baseUrl, model: main } = llmCfg();
  const cheap = llmCfg(true).model;
  const hedge = hedgeModelFor(main);
  const active = [main, cheap, ...(hedge ? [hedge] : [])].filter((m) => mustThink(baseUrl, m));
  return {
    reasoningEffort: reasoningEffort(),
    forcedThinkingModels: [...new Set([...active, ...learnedThinking])],
    thinkingSelfHeal: stats.thinkingSelfHeal,
    hedgeModel: hedge,
    hedgeMs: hedgeMs(),
    hedgeMsFollowup: hedgeFollowupMs(),
    hedgeFired: stats.hedgeFired,
    hedgeWon: stats.hedgeWon,
    followupHedgeFired: stats.followupHedgeFired,
    followupHedgeWon: stats.followupHedgeWon,
    toolReused: stats.toolReused,
  };
}

/**
 * 无工具的单轮文本补全（后台 AI 洞察 / 下一步建议 / 跟进话术专用，客户不可见）。
 * 走后台模型 llmCfg(true)（LLM_MODEL_CHEAP，不配则跟随主模型）。
 * LLM_MOCK=1 或未配 key 时返回空串，调用方回退到规则版。
 * opts：用量记在哪个用途（insight、suggestion、draft、followup，进 usage_daily）与哪个会话名下；不给按 chat、不记会话
 */
export async function completeText(system: string, user: string, opts?: { purpose: UsagePurpose; sessionId?: string }): Promise<string> {
  const { baseUrl, apiKey, model } = llmCfg(true);
  if (process.env.LLM_MOCK === '1' || !apiKey) return '';
  try {
    // 与主对话共用思考参数与 1210 自愈；不对冲——客户看不到这条路径，慢一点无妨，不值得多花一份钱
    const data = await requestModel(
      { baseUrl, apiKey },
      model,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.5,
      },
      llmTimeout,
    );
    recordCompletion(model, data.usage, opts?.sessionId, opts?.purpose);
    return stripLeaked(data.choices?.[0]?.message?.content ?? '');
  } catch (e) {
    // 以前这里静默返回空串：模型被拒（参数错、模型名错）时后台洞察/跟进话术悄悄退回模板，
    // 日志里什么都没有。LlmHttpError 的消息里已带状态码和模型
    console.warn(`[llm] 后台补全失败（model=${model}），调用方回退规则版:`, e instanceof Error ? e.message : e);
    return '';
  }
}

// ---------- 真实 LLM ----------

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  /**
   * 智谱思考模型的推理过程（与 content 分开返回）。交错式思考要求：工具轮把它**原样**
   * 连同工具结果一起传回，否则模型要从头再想一遍（强制思考的 5.3 系列上是实打实的
   * 输出 token 和延迟）。它只在 wire 里流转，**永远不进客户可见文本**。
   * 不开保留式思考（clear_thinking 不传，标准端点默认关），所以跨轮不需要保留。
   */
  reasoning_content?: string;
}

const MAX_TOOL_ROUNDS = 6;

// 最后一轮强制出文本。不能靠 tool_choice:'none'——智谱文档写明 tool_choice「仅支持 auto」，
// 发了要么 400、要么被忽略后模型照样调工具（而最后一轮不执行工具，结果就是空回复）。
// 所以最后一轮干脆不带 tools，再补这句系统提示让它据已有结果直接回复。实测「历史里有
// tool 消息、本次不带 tools、末尾一条 system」glm-5.2 与 glm-5.3-flashx 都接受并据结果作答。
const FINAL_ROUND_HINT = '请根据以上已有信息直接回复客户，不要再调用工具。';

/** 把模型返回的 assistant 消息转成回传用的 wire 消息：reasoning_content 原样保留 */
function assistantEcho(msg: WireMessage, content: string | null): WireMessage {
  return {
    role: 'assistant',
    content,
    ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    ...(typeof msg.reasoning_content === 'string' ? { reasoning_content: msg.reasoning_content } : {}),
  };
}

/**
 * 组装首轮请求的 messages：system → 历史 →（contextNote）→ 最新 user →（prefetch 还原的工具往返）。
 *
 * contextNote 用独立的 system 消息，而不是往客户原话前拼「【系统】…」：客户自己也打得出
 * 「【系统】」，拼进 user 消息后模型分不清哪句是我们写的、哪句是客户伪造的。插在最新 user
 * 之前，「system + 历史」这段前缀每轮不变，照样吃前缀缓存。
 * 实测两种写法 glm-5.2 与 glm-5.3-flashx 都接受、都会用上 note；选这种是为了上面那条伪造问题。
 * prefetch 还原出的 assistant（content 为空串、无 reasoning_content）+ tool 消息两者也都接受，
 * 并直接据结果回复、不再重复调工具。
 */
function buildWire(opts: ChatOptions): WireMessage[] {
  const history = opts.messages.map((m): WireMessage => ({ role: m.role, content: m.content }));
  if (opts.contextNote?.trim()) {
    const last = history[history.length - 1];
    const at = last?.role === 'user' ? history.length - 1 : history.length;
    history.splice(at, 0, { role: 'system', content: opts.contextNote });
  }
  const wire: WireMessage[] = [{ role: 'system', content: opts.system }, ...history];
  if (opts.prefetch?.length) {
    const ids = opts.prefetch.map((_, i) => `prefetch_${i}`);
    wire.push({
      role: 'assistant',
      content: '',
      tool_calls: opts.prefetch.map((c, i) => ({
        id: ids[i],
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });
    opts.prefetch.forEach((c, i) => wire.push({ role: 'tool', content: c.result, tool_call_id: ids[i] }));
  }
  return wire;
}

/** 剥掉可能渗进正文的 <think> 推理块、<tool_call> 文本型工具调用等，绝不让客户看到 */
function stripLeaked(text: string): string {
  return (
    text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // 截断的回复里 <think> 可能没闭合，只删标签会把整段推理原样发给客户
      .replace(/<think>[\s\S]*$/i, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .replace(/<\/?(?:think|tool_call|arg_key|arg_value)>/gi, '')
      .trim()
  );
}

/**
 * 解析模型「把工具调用当文本输出」的情况（glm 偶发 <tool_call> 文本格式）：
 * <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>
 */
function parseTextToolCalls(content: string): { name: string; args: Record<string, unknown> }[] {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const callRe = /<tool_call>\s*([A-Za-z_][A-Za-z0-9_]*)([\s\S]*?)<\/tool_call>/g;
  for (let m = callRe.exec(content); m; m = callRe.exec(content)) {
    const args: Record<string, unknown> = {};
    const argRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
    for (let a = argRe.exec(m[2]); a; a = argRe.exec(m[2])) {
      const raw = a[2].trim();
      args[a[1].trim()] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
    calls.push({ name: m[1].trim(), args });
  }
  return calls;
}

async function realChat(opts: ChatOptions, runtime: LlmRuntime): Promise<string> {
  // glm 偶发整段回复为空（或全部内容在 <think> 块里被剥掉）——demo 页示例问题
  // 「这个太贵了能便宜点吗」就实测踩中过，客户只收到干瘪的兜底话术。空文本重试一次。
  //
  // 但重试会把整个工具循环重跑一遍：本轮若已调过写型工具（建单/转人工），重跑可能因
  // temperature 抖动换个参数再建一单。所以只在「本轮没有任何工具副作用」时才重试——
  // 空回复本来也几乎只出现在纯对话轮（异议、闲聊）。
  let sideEffects = 0;
  // 同一轮里参数完全相同的只读查询直接复用第一次的结果（含引擎预取的那几次）。模型偶尔把
  // 刚查过的条件原样再查一遍，或把预取还原给它的调用照抄一遍；重复执行只是白等。
  // 缓存的是 Promise：同一次响应里并列的两个相同调用也只执行一次。
  // 只在本轮内有效，下一轮画像、客群都可能变了，同样的参数不一定查出同样的东西。
  const reusable = new Map<string, Promise<string>>();
  // 每个工具上一次调用的键。A → B → A 这样查，第三次复用会跳过执行时的展示状态更新。
  // 所以复用时上一次同名调用不是这组参数，就交给 onReuse 重放展示记录（不重新执行查询）。
  const lastKey = new Map<string, string>();
  for (const p of opts.prefetch ?? []) {
    reusable.set(callKey(p.name, p.args), Promise.resolve(p.result));
    lastKey.set(p.name, callKey(p.name, p.args));
  }
  const trace: CallTrace[] = [];
  const t0 = Date.now();
  const guarded: ChatOptions = {
    ...opts,
    executeTool: (name, args) => {
      const spec = runtime.getToolSpec(name);
      if (spec?.blocksRetry) sideEffects++;
      if (!spec?.cacheable) return opts.executeTool(name, args);
      // 键要在执行**之前**算：工具执行时可能会往 args 里补会话属性
      const key = callKey(name, args);
      const hit = reusable.get(key);
      const moved = lastKey.get(name) !== key;
      lastKey.set(name, key);
      if (hit && moved && opts.onReuse)
        void hit.then(
          (r) => opts.onReuse!(name, args, r),
          () => {},
        );
      if (hit) {
        stats.toolReused += 1;
        trace.at(-1)?.reused.push(name);
        console.log(`[llm] 本轮已用相同参数调过 ${name}，直接复用结果（会话 ${opts.sessionId == null ? '-' : convLabel(opts.sessionId)}）`);
        return hit;
      }
      const run = opts.executeTool(name, args);
      reusable.set(key, run);
      // 执行失败不缓存：同一个调用再来一次可能就成了（例如线路文件刚好在写）
      run.catch(() => {
        if (reusable.get(key) === run) reusable.delete(key);
      });
      return run;
    },
  };
  try {
    const first = await realChatOnce(guarded, trace);
    if (first.trim()) return first;
    if (sideEffects) {
      console.warn('[llm] 模型返回空文本，但本轮已执行写型工具，不重试（避免重复下单），交由引擎兜底');
      return '';
    }
    console.warn('[llm] 模型返回空文本，自动重试一次');
    const second = await realChatOnce(guarded, trace);
    if (!second.trim()) console.error('[llm] 重试后仍为空文本，将使用引擎兜底话术');
    return second;
  } finally {
    logSlowTurn(Date.now() - t0, trace, opts.sessionId);
  }
}

/** 工具调用的规范化键：键按字母序、忽略值为 undefined 的键（发给模型的 JSON 里本来就没有它们） */
function callKey(name: string, args: Record<string, unknown>): string {
  const canon = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .toSorted()
        .filter((k) => o[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
  };
  return `${name}${canon(args)}`;
}

/** 本轮每次模型调用的耗时与它要的工具，整轮超时时打出来；也交给 onLlmCall 的订阅者（逐轮 trace，02 spec） */
export interface CallTrace {
  model: string;
  hedged: boolean;
  ms: number;
  tools: string[];
  toolMs: number;
  reused: string[];
  /** 这次调用的失败类别，成功为 null（AI 出错率按它算，R24） */
  error: LlmErrorKind;
}

const llmCallObservers = new Set<(c: CallTrace) => void>();
/**
 * 主对话每次模型调用（含失败的那次）都通知订阅者，在这一轮的异步上下文里同步调用。传的是同一个对象：之后这次调用要的工具、
 * 工具耗时与复用还会记到它上面，订阅者在轮次结束时再读。用量随后经 usage.ts 的 onUsage 另行送达（先通知这里、再记用量）
 */
export function onLlmCall(fn: (c: CallTrace) => void): () => void {
  llmCallObservers.add(fn);
  return () => llmCallObservers.delete(fn);
}
function notifyLlmCall(c: CallTrace): void {
  for (const fn of llmCallObservers) {
    try {
      fn(c);
    } catch {
      /* 观测者出错不影响对话 */
    }
  }
}

/**
 * 一次模型调用失败的类别（02 spec 的 LlmErrorKind）：超时（含整轮墙钟）、重试后仍 429、5xx 与连不上 / 连接中断（上游不可用）、
 * 其余（别的 4xx、回包不是 JSON、缺 choices）算回包不可用
 */
function llmErrorKind(e: unknown): Exclude<LlmErrorKind, null> {
  if (e instanceof LlmHttpError) return e.status === 429 ? 'rate_limited' : e.status >= 500 ? 'http_5xx' : 'bad_response';
  const name = e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException) ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (e instanceof SyntaxError) return 'bad_response';
  return 'http_5xx';
}

/**
 * 整轮超过 LLM_SLOW_TURN_MS（默认 8000，客户等到以为没人在的那条线）时，打一行逐次调用的耗时明细。
 * 此前线上只有企微渠道记整轮总耗时，网页 /api/chat 什么都不记；慢了也分不清是往返次数多、
 * 某一次卡住等到了对冲，还是工具（embedding）慢——2026-09 场景测试里线上 3/17 超 8 秒就因此无从复核。
 * 只记慢轮次，平时不刷屏。
 */
function logSlowTurn(totalMs: number, trace: CallTrace[], sessionId?: string): void {
  if (totalMs <= Math.max(0, numEnv('LLM_SLOW_TURN_MS', 8000)) || !trace.length) return;
  const steps = trace.map((c, i) => {
    const tools = c.tools.length ? ` → ${c.tools.join('+')} ${c.toolMs}ms${c.reused.length ? `（复用 ${c.reused.length} 次）` : ''}` : '';
    return `#${i + 1} ${c.model}${c.hedged ? '（对冲）' : ''} ${c.ms}ms${tools}`;
  });
  console.warn(`[llm] ⚠️ 本轮工具循环耗时 ${totalMs}ms（会话 ${sessionId == null ? '-' : convLabel(sessionId)}）：${steps.join(' · ')}`);
}

async function realChatOnce(opts: ChatOptions, trace: CallTrace[] = []): Promise<string> {
  const { baseUrl, apiKey, model } = llmCfg();
  // 整轮（含全部工具往返）的墙钟上限，与单次请求超时取先到者
  const deadline = roundDeadline();
  const signal = (): AbortSignal => AbortSignal.any([deadline, llmTimeout()]);
  if (!apiKey) {
    throw new Error('LLM API Key 未配置（检查 LLM_PROVIDER 对应的 *_API_KEY 或 LLM_API_KEY），或设 LLM_MOCK=1 走离线脚本回复');
  }
  const ep: Endpoint = { baseUrl, apiKey };
  const wire = buildWire(opts);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const forceText = round === MAX_TOOL_ROUNDS - 1;
    const payload: Record<string, unknown> = {
      // 提示只加在这次请求里，不进 wire：这就是最后一轮，没有下一次了
      messages: forceText ? [...wire, { role: 'system', content: FINAL_ROUND_HINT }] : wire,
      temperature: 0.7,
    };
    if (!forceText) payload.tools = opts.tools;
    const tCall = Date.now();
    let res: { data: Completion; model: string };
    try {
      res = await requestHedged(ep, model, payload, signal, round);
    } catch (e) {
      // 失败的那次也进 trace（AI 出错率，R24）：没有用量，模型记主模型
      notifyLlmCall({ model, hedged: false, ms: Date.now() - tCall, tools: [], toolMs: 0, reused: [], error: llmErrorKind(e) });
      throw e;
    }
    const { data, model: used } = res;
    const step: CallTrace = { model: used, hedged: used !== model, ms: Date.now() - tCall, tools: [], toolMs: 0, reused: [], error: null };
    trace.push(step);
    notifyLlmCall(step);
    // 一轮对话可能有多次 API 往返（工具调用），每次都要计入。
    // 同一轮里的第 2、3 次往返天然共享第 1 次的整个前缀，缓存命中率最高的就是这些。
    recordCompletion(used, data.usage, opts.sessionId);
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      step.error = 'bad_response';
      throw new Error(`LLM 返回缺少 choices[0].message（model=${used}）`);
    }
    // 被输出上限截断：客户会收到一条断在半句话的报价消息，而这在日志里毫无痕迹
    if (choice.finish_reason === 'length') {
      console.warn(`[llm] ⚠️ 模型输出被截断（finish_reason=length，model=${used}），客户可能收到半句话`);
    }

    if (!forceText && msg.tool_calls?.length) {
      wire.push(assistantEcho(msg, msg.content ?? null));
      const tTools = Date.now();
      for (const tc of msg.tool_calls) {
        step.tools.push(tc.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          /* 参数不是合法 JSON 时按空参执行 */
        }
        let result: string;
        try {
          result = await opts.executeTool(tc.function.name, args);
        } catch (e) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
        wire.push({ role: 'tool', content: result, tool_call_id: tc.id });
      }
      step.toolMs = Date.now() - tTools;
      continue;
    }

    // 兜底：模型把工具调用当文本输出（没走 tool_calls 字段）。解析并真正执行，再让它据结果回复。
    const textCalls = !forceText && msg.content ? parseTextToolCalls(msg.content) : [];
    if (textCalls.length) {
      // 这条路径同样要带回 reasoning_content（理由同上），只是正文要先剥掉标签
      wire.push(assistantEcho(msg, stripLeaked(msg.content ?? '')));
      const tTools = Date.now();
      for (const tc of textCalls) {
        step.tools.push(tc.name);
        let result: string;
        try {
          result = await opts.executeTool(tc.name, tc.args);
        } catch (e) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
        wire.push({
          role: 'user',
          content: `【系统】工具 ${tc.name} 返回：${result}\n请根据以上结果用中文微信语气回复客户，不要再输出任何工具调用或标签。`,
        });
      }
      step.toolMs = Date.now() - tTools;
      continue;
    }

    // 只取 content：reasoning_content 是模型的内部推理，绝不能发给客户
    return stripLeaked(msg.content ?? '');
  }
  return '好的，我核对一下细节，稍等片刻马上回复您～';
}

/** 仅供自测：模型调用失败的分类（02 spec 的 LlmErrorKind） */
export const __llmTest = {
  llmErrorKind,
  httpError: (status: number): Error => new LlmHttpError(status, 'selftest', ''),
};
