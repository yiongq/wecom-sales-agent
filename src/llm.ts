// OpenAI 兼容 chat completions 封装（默认智谱），含多轮工具调用循环。
// LLM_MOCK=1 走确定性脚本：按用户消息关键词驱动真实工具调用，
// 离线跑通「问需 → 推荐 → 报价 → 下单」全链路，是集成冒烟的生命线。
import type { ToolDef } from './tools.js';
import { recordUsage } from './usage.js';
import { gatedFetch } from './llm-gate.js';
import { numEnv } from './env.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  system: string;
  messages: ChatTurn[];
  tools: ToolDef[];
  /** 本轮强制走离线脚本（日预算耗尽时的降级，见 budget.ts） */
  forceMock?: boolean;
  /** 归属会话，用于按会话核算模型成本 */
  sessionId?: string;
  /** 执行工具并返回 JSON 字符串结果；副作用（建单/转人工）由调用方闭包处理 */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

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
  /** DeepSeek */
  prompt_cache_hit_tokens?: number;
}

/** 本次请求命中前缀缓存的输入 token 数；供应商没返回就是 0（当作全部未命中，只会低估节省） */
function cachedTokens(u?: WireUsage): number {
  return u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
}

/** 引擎唯一入口：返回助手最终文本（末尾可能带 <state> 块，由引擎剥离） */
export async function chat(opts: ChatOptions): Promise<string> {
  return process.env.LLM_MOCK === '1' || opts.forceMock ? mockChat(opts) : realChat(opts);
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
        return cheap ? cheapModel(process.env.DEEPSEEK_MODEL_CHEAP, main) : main;
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
// 真正该修的不是选型，是 5.2 那 14/48 轮**根本没调工具**——见 README「模型选型」一节
// 记的待办：首轮识别出目的地时用 tool_choice 强制查一次库，比换模型代价小得多。
const DEFAULT_MAIN_MODEL = 'glm-5.2';
// 后台自用路径（AI 洞察 / 成交概率 / 下一步建议 / 沉默跟进话术）的模型。
// **默认与主对话同款**——实测后台单次调用才千分之几分钱，按每天浏览后台
// 一两百次算也就每月几块钱，没必要为这点钱让后台洞察的质量掉一档。
// 想省的时候设 LLM_MODEL_CHEAP=glm-4.5-air 即可，输入侧便宜 5 倍、输出侧 8 倍。
export const CHEAP_TIER_MODEL = 'glm-4.5-air'; // 仅用于识别「主模型被误配成便宜档」
/** 后台模型：显式配了就用，否则跟随主模型 */
function cheapModel(specific: string | undefined, main: string): string {
  return specific || process.env.LLM_MODEL_CHEAP || main;
}

/** 当前生效的模型，供启动日志与 /healthz 展示——避免"跑着哪个模型"只能靠猜 */
export function activeModels(): { main: string; cheap: string } {
  return { main: llmCfg().model, cheap: llmCfg(true).model };
}

/** thinking 参数仅智谱识别；其他 OpenAI 兼容端（DeepSeek 等）可能拒绝未知字段 */
function maybeThinking(baseUrl: string): Record<string, unknown> {
  return baseUrl.includes('bigmodel') ? { thinking: { type: 'disabled' } } : {};
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

/**
 * 无工具的单轮文本补全（后台 AI 洞察 / 下一步建议 / 跟进话术专用，客户不可见）。
 * 固定走便宜档模型（LLM_MODEL_CHEAP，默认 glm-4.5-air）。
 * LLM_MOCK=1 或未配 key 时返回空串，调用方回退到规则版。
 */
export async function completeText(system: string, user: string): Promise<string> {
  // 走便宜档：这条路径只服务后台（AI 洞察 / 成交概率 / 下一步建议 / 沉默跟进话术），
  // 客户一个字都看不到，没必要用贵模型。主对话仍走 llmCfg() 的主模型。
  const { baseUrl, apiKey, model } = llmCfg(true);
  if (process.env.LLM_MOCK === '1' || !apiKey) return '';
  try {
    const { res } = await gatedFetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.5,
        ...maybeThinking(baseUrl),
      }),
    }, llmTimeout);
    if (!res.ok) return '';
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: WireUsage;
    };
    recordUsage(model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0,
      undefined, cachedTokens(data.usage));
    return stripLeaked(data.choices?.[0]?.message?.content ?? '');
  } catch {
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
}

const MAX_TOOL_ROUNDS = 6;

/** 剥掉可能渗进正文的 <think> 推理块、<tool_call> 文本型工具调用等，绝不让客户看到 */
function stripLeaked(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // 截断的回复里 <think> 可能没闭合，只删标签会把整段推理原样发给客户
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<\/?(?:think|tool_call|arg_key|arg_value)>/gi, '')
    .trim();
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

async function realChat(opts: ChatOptions): Promise<string> {
  // glm 偶发整段回复为空（或全部内容在 <think> 块里被剥掉）——demo 页示例问题
  // 「这个太贵了能便宜点吗」就实测踩中过，客户只收到干瘪的兜底话术。空文本重试一次。
  //
  // 但重试会把整个工具循环重跑一遍：本轮若已调过写型工具（建单/转人工），重跑可能因
  // temperature 抖动换个参数再建一单。所以只在「本轮没有任何工具副作用」时才重试——
  // 空回复本来也几乎只出现在纯对话轮（异议、闲聊）。
  let sideEffects = 0;
  const guarded: ChatOptions = {
    ...opts,
    executeTool: (name, args) => {
      if (WRITE_TOOLS.has(name)) sideEffects++;
      return opts.executeTool(name, args);
    },
  };
  const first = await realChatOnce(guarded);
  if (first.trim()) return first;
  if (sideEffects) {
    console.warn('[llm] 模型返回空文本，但本轮已执行写型工具，不重试（避免重复下单），交由引擎兜底');
    return '';
  }
  console.warn('[llm] 模型返回空文本，自动重试一次');
  const second = await realChatOnce(guarded);
  if (!second.trim()) console.error('[llm] 重试后仍为空文本，将使用引擎兜底话术');
  return second;
}

/** 有副作用的工具：执行过就不能重放整轮对话 */
const WRITE_TOOLS = new Set(['create_order', 'handoff_to_human']);

async function realChatOnce(opts: ChatOptions): Promise<string> {
  const { baseUrl, apiKey, model } = llmCfg();
  // 整轮（含全部工具往返）的墙钟上限，与单次请求超时取先到者
  const deadline = roundDeadline();
  const signal = (): AbortSignal => AbortSignal.any([deadline, llmTimeout()]);
  if (!apiKey) {
    throw new Error('LLM API Key 未配置（检查 LLM_PROVIDER 对应的 *_API_KEY 或 LLM_API_KEY），或设 LLM_MOCK=1 走离线脚本回复');
  }
  const wire: WireMessage[] = [
    { role: 'system', content: opts.system },
    ...opts.messages.map((m): WireMessage => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // 最后一轮强制出文本（tool_choice=none），避免模型无限调工具导致没有回复
    const forceText = round === MAX_TOOL_ROUNDS - 1;
    const body: Record<string, unknown> = {
      model,
      messages: wire,
      temperature: 0.7,
      ...maybeThinking(baseUrl), // 智谱专属参数，其他供应商不带
    };
    if (!forceText) {
      body.tools = opts.tools;
    } else {
      body.tools = opts.tools;
      body.tool_choice = 'none';
    }
    const { res, errorBody } = await gatedFetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, signal);
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? '（API key 无效或无权限，请检查 LLM_API_KEY）' : '';
      // 重试过的响应 body 已被 gatedFetch 读掉，再 res.text() 会抛「Body is unusable」，
      // 把 429 的真实原因（配额说明）整条吃掉——用它带出来的副本
      const detail = errorBody ?? (await res.text().catch(() => ''));
      throw new Error(`LLM 请求失败 ${res.status}${hint}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices: { message: WireMessage; finish_reason?: string }[];
      usage?: WireUsage;
    };
    // 一轮对话可能有多次 API 往返（工具调用），每次都要计入。
    // 同一轮里的第 2、3 次往返天然共享第 1 次的整个前缀，缓存命中率最高的就是这些。
    recordUsage(model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0,
      opts.sessionId, cachedTokens(data.usage));
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error('LLM 返回缺少 choices[0].message');
    // 被输出上限截断：客户会收到一条断在半句话的报价消息，而这在日志里毫无痕迹
    if (data.choices[0]?.finish_reason === 'length') {
      console.warn(`[llm] ⚠️ 模型输出被截断（finish_reason=length，model=${model}），客户可能收到半句话`);
    }

    if (!forceText && msg.tool_calls?.length) {
      wire.push(msg);
      for (const tc of msg.tool_calls) {
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
      continue;
    }

    // 兜底：模型把工具调用当文本输出（没走 tool_calls 字段）。解析并真正执行，再让它据结果回复。
    const textCalls = !forceText && msg.content ? parseTextToolCalls(msg.content) : [];
    if (textCalls.length) {
      wire.push({ role: 'assistant', content: stripLeaked(msg.content ?? '') });
      for (const tc of textCalls) {
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
      continue;
    }

    return stripLeaked(msg.content ?? '');
  }
  return '好的，我核对一下细节，稍等片刻马上回复您～';
}

// ---------- Mock 脚本 ----------

// SPEC 模块 1 规定的 14 个目的地，用于从自由文本里识别意向
// 国内核心目的地在前——公司主营国内高端定制，客户提得最多的就是这几个
const DESTINATIONS = [
  '四川', '成都', '稻城', '九寨沟', '西藏', '拉萨', '林芝', '云南', '香格里拉', '丽江',
  '大理', '贵州', '西安', '北京', '新疆', '喀什', '喀纳斯', '三亚',
  '马尔代夫', '瑞士', '日本', '新西兰', '北欧', '极光', '迪拜', '巴厘岛',
  '意大利', '肯尼亚', '南极', '摩洛哥', '法国',
];

const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function findDestination(texts: string[]): string | undefined {
  for (const t of [...texts].reverse()) {
    const hit = DESTINATIONS.find((d) => t.includes(d));
    if (hit) return hit;
  }
  return undefined;
}

function findTravelers(texts: string[]): number {
  for (const t of [...texts].reverse()) {
    const m = t.match(/([0-9]+|[一两二三四五六七八九十])\s*(?:个|位|大人)?(?:人|口|大)/);
    if (m) {
      const n = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : CN_NUM[m[1]];
      if (n && n > 0) return n;
    }
  }
  return 2;
}

function findBudget(texts: string[]): string | undefined {
  for (const t of [...texts].reverse()) {
    const m = t.match(/(?:每人)?\s*[0-9.]+\s*万/);
    if (m) return m[0].trim();
  }
  return undefined;
}

function findDepartDate(texts: string[]): string {
  for (const t of [...texts].reverse()) {
    const iso = t.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    // 「X月Y号」优先取客户明说的日；只说「X月」才用 15 号兜底（mock 要保证流程能走完）
    const md = t.match(/([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*[号日]/);
    if (md) return `2026-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
    const m = t.match(/([0-9]{1,2})\s*月/);
    if (m) return `2026-${m[1].padStart(2, '0')}-15`;
  }
  return '2026-10-01'; // 未提日期时的确定性默认值
}

interface RouteSummary {
  id: string;
  title: string;
  days: number;
  priceFrom: number;
  hotelLevel: string;
  highlights: string[];
}

/** 找线路：优先按意向目的地，搜不到就取全量第一条，保证脚本永远能走下去 */
async function pickRoutes(opts: ChatOptions, destination?: string): Promise<RouteSummary[]> {
  if (destination) {
    const hit = JSON.parse(await opts.executeTool('search_routes', { destination })) as RouteSummary[];
    if (hit.length) return hit;
  }
  return JSON.parse(await opts.executeTool('search_routes', {})) as RouteSummary[];
}

function state(stage: string, profile: Record<string, unknown> = {}): string {
  return `\n<state>${JSON.stringify({ stage, profile })}</state>`;
}

const yuan = (n: number): string => '¥' + n.toLocaleString('zh-CN');

async function mockChat(opts: ChatOptions): Promise<string> {
  const userTexts = opts.messages.filter((m) => m.role === 'user').map((m) => m.content);
  const last = userTexts[userTexts.length - 1] ?? '';
  const destination = findDestination(userTexts);

  // 关键词优先级：转人工 > 下单 > 报价 > 推荐 > 问需
  if (/人工|真人客服|投诉|退款/.test(last)) {
    await opts.executeTool('handoff_to_human', { reason: '客户主动要求人工/投诉退款' });
    return (
      '好的，我马上为您转接专属人工顾问，请稍候，顾问会第一时间联系您～' +
      state('handoff')
    );
  }

  if (/就订|就定|下单|购买|买了|订了|就这个|就它|确定|成交|付款/.test(last)) {
    const routes = await pickRoutes(opts, destination);
    if (!routes.length) return '目前线路库还没有匹配的产品，我帮您登记需求，稍后顾问联系您～' + state('discovery');
    const travelers = findTravelers(userTexts);
    const departDate = findDepartDate(userTexts);
    // 工具可能返回 {error:...}（如客户给了 2026-99-99 这类假日期）——不检查就取 total 会直接 TypeError
    const order = JSON.parse(
      await opts.executeTool('create_order', { routeId: routes[0].id, travelers, departDate }),
    ) as { orderId?: string; payUrl?: string; total?: number; error?: string };
    if (order.error || !order.orderId || typeof order.total !== 'number') {
      return (
        '好嘞～不过出发日期我还想跟您确认一下：方便告诉我具体哪天出发吗（比如「10月1号」）？确认后我马上为您锁定名额～' +
        state('quote')
      );
    }
    return (
      `收到！已为您锁定《${routes[0].title}》的名额 🎉\n` +
      `${travelers} 位出行，${departDate} 出发，总价 ${yuan(order.total)}。\n` +
      `请点击链接完成支付：${order.payUrl}\n支付后我会第一时间为您确认行程～` +
      state('closing', { dates: departDate })
    );
  }

  if (/预算|多少钱|报价|费用|价格|([0-9一两二三四五六七八九十]\s*(?:个|位)?人)/.test(last)) {
    const routes = await pickRoutes(opts, destination);
    if (!routes.length) return '稍等，我先帮您查下合适的线路哈～' + state('discovery');
    const travelers = findTravelers(userTexts);
    const quote = JSON.parse(
      await opts.executeTool('create_quote', { routeId: routes[0].id, travelers }),
    ) as { routeTitle?: string; perPerson?: number; travelers?: number; total?: number; note?: string; error?: string };
    if (quote.error || typeof quote.total !== 'number' || typeof quote.perPerson !== 'number') {
      return '咱们几位出行呢？告诉我人数（比如「2 个人」），我马上给您出准确报价～' + state('discovery');
    }
    const profile: Record<string, unknown> = { travelers: `${travelers}人` };
    const budget = findBudget(userTexts);
    if (budget) profile['budget'] = budget;
    if (destination) profile['destinationInterest'] = destination;
    return (
      `好嘞，给您报个准价 💰\n《${quote.routeTitle}》每人 ${yuan(quote.perPerson)}，` +
      `${quote.travelers} 位总价 ${yuan(quote.total)}（${quote.note}）。\n` +
      `含全程住宿、行程内体验和专属管家服务。觉得合适的话，回复「就订这个」我直接帮您下单～` +
      state('quote', profile)
    );
  }

  if (destination && last.includes(destination)) {
    const routes = await pickRoutes(opts, destination);
    if (!routes.length) return `${destination}方向的线路我帮您定制安排，先问下几位出行、大概什么时间呢？` + state('discovery', { destinationInterest: destination });
    const lines = routes
      .slice(0, 2)
      .map((r) => `《${r.title}》${r.days} 天，${r.hotelLevel}，每人 ${yuan(r.priceFrom)} 起，亮点：${r.highlights.slice(0, 2).join('、')}`)
      .join('\n');
    return (
      `${destination}选得好呀 ✨ 给您挑了这些：\n${lines}\n` +
      `方便告诉我几位出行、预算大概多少吗？我好给您出个准确报价～` +
      state('recommend', { destinationInterest: destination })
    );
  }

  return (
    '您好呀～我是云途定制旅行的旅行顾问 😊 咱们做高端定制游，先了解下您的想法：' +
    '这次想去哪个方向玩，大概几位出行呢？' +
    state('discovery')
  );
}
