// 确定性转人工触发（docs/architecture/02-conversations-workbench/spec.md「确定性转人工触发」、R15、R23、开放问题 4）。
// 纯函数，配向量表自测（src/handoff/handoff.selftest.ts）：不 import store、engine、tools、llm、adapters、src/db/。
//
// 共同的读法：按小句判。一句话（。！？换行分号之间）再按逗号、顿号、空格等切成小句，一个小句命中就算。
// 不算的：出行前的提问与假设（「去西藏会不会高反」「万一护照丢了怎么办」）、否定（「没有高反」「护照没丢」）、
// 转述别人或以前的经历与评价（「听说高反挺吓人的」「朋友说你们很坑」「上次骨折过」）。
// 假设、转述、以前这三类在同一句话里往后带（「如果到了拉萨，高反了怎么办」后半句也是假设），
// 「现在」「刚刚」「突然」这类此刻的说法打断转述与以前（「以前没事，现在高反了」后半句算）。
// 词表不按子串收宽泛的词（「找不到」「跑了」「骗人」「不行」）：证件要和丢失连在一起，走失要有人，辱骂要冲着我们。

export type EmergencyKind = 'altitude' | 'injury' | 'medical' | 'documents' | 'stranded';
export type SensitiveCategory = 'health' | 'minor';

/** 一轮的交互失败信号（R15）。guardHit 有值时整轮不算失败 */
export interface TurnSignals {
  /** 模型没给出可用文本，落到兜底话术（engine.ts 里空回复那一处） */
  emptyModelReply: boolean;
  /** 本轮 search_routes 什么也没返回，且不是 destinationMiss */
  noRetrievalResult: boolean;
  /** 这句与前 2 条客户消息之一重复（去标点空白后相同，或字二元组 Jaccard ≥ 0.8，长度 ≥ 4 字） */
  repeatedQuestion: boolean;
  guardHit: 'price' | 'injection' | null;
}

// ---------------------------------------------------------------------------------------------
// 切句与小句
// ---------------------------------------------------------------------------------------------

interface Clause {
  text: string;
  /** 小句后面跟着问号 */
  asked: boolean;
  /** 同一句话里前面的小句说了假设 / 转述 / 以前（往后带） */
  carried: { hypo: boolean; hearsay: boolean; past: boolean };
  /** 第几句话（。！？换行分号切开的） */
  sentence: number;
}

/** emoji（含肤色、变体选择符、零宽连接）与微信表情码「[微笑]」：当成分隔 */
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Variation_Selector}\p{Join_Control}]/gu;
const WECHAT_FACE = /\[[^[\]\s]{1,8}\]/g;
/** 小句边界（捕获，用来看边界里有没有问号、是不是一句话的结尾） */
const BOUNDARY = /([，,、：:～~…\s—–\-－·•()（）【】[\]「」『』《》<>"“”'‘’/|。.！!？?；;]+)/;
const SENTENCE_END = /[。.！!？?；;\n]/;
const QUESTION_MARK = /[？?]/;

/** 归一：全角转半角、英文小写，emoji 与微信表情码换成空格 */
function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(WECHAT_FACE, ' ').replace(EMOJI, ' ');
}

// 假设：小句里有它，这一小句与同一句话里后面的小句都不算（「如果到了拉萨，高反了怎么办」）
const COND = /如果|万一|要是|假如|假设|若是|倘若|一旦|的话/;
// 出行前的顾虑与泛泛的问法：只管它所在的小句（「我怕高反，结果真的高反了」后半句算）
const MODAL =
  /会不会|(?<![开学机社聚约协理体领不])会(?![儿员议场合面所计展馆话谈见])|容易|可能|怕|担心|担忧|害怕|顾虑|预防|防止|以防|避免|准备|提前|注意|小心|是否|有没有|要不要|需不需要|需要带|一般|通常|普遍|很多人|不少人|大部分人|大多数|风险|概率|几率|吓人|可怕/;
// 转述：听来的、看来的、别人说的
const HEARSAY =
  /听说|听人说|据说|网上|网传|评论|攻略|帖子|新闻|(?:有人|别人|朋友|同事|大家|网友|他们|她们|人家|邻居|同学)(?:都|也)?(?:说|讲|反映|提到|吐槽|觉得|认为|感觉)/;
// 以前的事
const PAST =
  /上次|上回|以前|之前|去年|前年|那次|那回|曾经|当时|那时|小时候|几年前|前几年|前两年|前些年|上个月|上周|上礼拜|前几天|前两天|前阵子/;
// 此刻：打断转述与以前，也是「正在发生」的标记
const NOW = /现在|此刻|正在|目前|眼下|这会儿?|刚刚|刚才|突然|一直在|还在|已经/;
// 说的是不同行的别人（不是同行的家人）：没有此刻的说法时按转述算
const THIRD_PARTY = /朋友|同事|邻居|网友|同学|别人|人家/;

function clausesOf(text: string): Clause[] {
  const parts = normalize(text).split(BOUNDARY);
  const out: Clause[] = [];
  let carried = { hypo: false, hearsay: false, past: false };
  let sentence = 0;
  // split 带捕获组：偶数位是小句，奇数位是边界
  for (let i = 0; i < parts.length; i += 2) {
    const raw = (parts[i] ?? '').trim();
    const boundary = parts[i + 1] ?? '';
    if (raw) {
      out.push({ text: raw, asked: QUESTION_MARK.test(boundary), carried: { ...carried }, sentence });
      const now = NOW.test(raw);
      carried = {
        hypo: carried.hypo || COND.test(raw),
        hearsay: !now && (carried.hearsay || HEARSAY.test(raw)),
        past: !now && (carried.past || PAST.test(raw)),
      };
    }
    if (SENTENCE_END.test(boundary)) {
      carried = { hypo: false, hearsay: false, past: false };
      sentence += 1;
    }
  }
  return out;
}

/** 小句是在问：后面跟问号、以吗呢么嘛结尾，或带着问法（吧不算：「太离谱了吧」是在抱怨） */
const ASKING_TAIL = /[吗呢么嘛]$/;
const ASKING_WORDS =
  /会不会|是不是|是否|有没有|能不能|可不可以|怎么办|怎么样|咋办|咋整|如何|为什么|为啥|多少|多久|哪(?:里|儿|个|些)|什么时候|啥时候|怎么(?!这么|那么|回事)/;
const isAsking = (c: Clause): boolean => c.asked || ASKING_TAIL.test(c.text) || ASKING_WORDS.test(c.text);

/** 关键词之前的 4 个字里有否定。「能不能」「是不是」「有没有」这类正反问里的不、没不是否定，先折掉 */
const NEG_BEFORE = /[没不未别无]/;
const negatedBefore = (clause: string, at: number): boolean =>
  NEG_BEFORE.test(
    clause
      .slice(0, at)
      .replace(/(.)[不没]\1/gu, '$1$1')
      .slice(-4),
  );

// ---------------------------------------------------------------------------------------------
// 紧急情况
// ---------------------------------------------------------------------------------------------

/** 同行的家人（走失、联系不上要有人） */
const FAMILY =
  '(?:孩子|小孩|宝宝|娃|儿子|女儿|闺女|老人|我妈|我爸|爸妈|爸爸|妈妈|父母|家人|老公|老婆|爱人|媳妇|婆婆|公公|爷爷|奶奶|外公|外婆|姥姥|姥爷|岳父|岳母|丈母娘|老丈人|同伴|队友|团友)';
/** 证件本身（「护照号」「身份证照片」说的是号码与照片，不是证件） */
const DOC = '(?:护照|身份证|证件|通行证|台胞证|回乡证)(?!号|信息|照片|复印件|扫描件|页|上)';
const LOSS = '(?:弄丢|丢失|遗失|丢|掉了|不见了|被偷|被抢|被扒|找不到|弄没|没(?:有)?了)';

interface EmergencyRule {
  kind: EmergencyKind;
  re: RegExp;
  /** 要有「此刻」的标记才算（症状、轻伤这类，单说一个词多半是在问或在担心） */
  needsNow: boolean;
  /** 问法里也算（「能不能帮我叫救护车」是在求救，不是在问） */
  askOk?: boolean;
}
// 同一小句里按这个顺序取第一个命中的类型
const EMERGENCY_RULES: EmergencyRule[] = [
  {
    kind: 'medical',
    re: /(?:叫|打|拨|喊|找)(?:个|辆|一辆)?救护车|(?:打|叫|拨|拨打)\s*120(?![\d元块米分人天万个%])/,
    needsNow: false,
    askOk: true,
  },
  { kind: 'altitude', re: /高原肺水肿|高原脑水肿|肺水肿|脑水肿/, needsNow: false },
  { kind: 'altitude', re: /高反|高原反应|高山反应|高原病|缺氧/, needsNow: true },
  {
    kind: 'injury',
    re: /骨折|摔断|车祸|撞车|被车撞|溺水|落水|掉进(?:河|湖|海|水)|坠崖|摔下(?:山|楼|去|来)|大出血|流血不止|被(?:狗|蛇|猴子|熊|牦牛|马)咬/,
    needsNow: false,
  },
  {
    kind: 'injury',
    re: /受伤|摔伤|摔倒|摔了一跤|摔了一下|扭伤|扭到|崴(?:了)?脚|脚崴|脱臼|撞伤|撞到头|划伤|割伤|烫伤|烧伤|擦伤|流血|出血|被(?:蜂|蜜蜂|马蜂|虫|水母)(?:蛰|蜇|咬)/,
    needsNow: true,
  },
  {
    kind: 'medical',
    re: /无法呼吸|没法呼吸|不能呼吸|昏迷|休克|晕倒|昏倒|晕过去|昏过去|不省人事|抽搐|呼吸困难|喘不上气|喘不过气|上不来气|心梗|心肌梗|(?:心脏病|哮喘|癫痫)(?:犯|发作)|中风|脑梗|脑溢血|吐血|便血|食物中毒|急性(?!子)|急诊|抢救|icu|送(?:去|进|到)?医院|进了?医院|住院了|救护车|(?:打|叫|拨|拨打)了?\s*120(?![\d元块米分人天万个%])/,
    needsNow: false,
  },
  {
    kind: 'medical',
    re: /发烧(?!友)|发高烧|高烧|烧到\s*(?:3[89]|4\d)|过敏|胸闷|胸口(?:疼|痛|闷)|胸痛|心慌|心脏不舒服|上吐下泻|呕吐不止|一直吐|腹泻/,
    needsNow: true,
  },
  {
    kind: 'documents',
    re: new RegExp(`${DOC}(?<between>[^，]{0,6}?)${LOSS}|(?:弄丢|丢失|遗失|丢|被偷|被抢|被扒)了?[^，]{0,4}?${DOC}`),
    needsNow: false,
  },
  {
    kind: 'stranded',
    re: new RegExp(
      `被困|困在|困住|走丢|走失|失联|下不了山|回不去了|回不来了|被(?:扔|丢|甩|落)下|把我们?(?:扔|丢|甩)(?:下|在)|` +
        `找不到${FAMILY}|${FAMILY}(?:不见了|找不到了|联系不上)|联系不上${FAMILY}`,
    ),
    needsNow: false,
  },
  { kind: 'stranded', re: /迷路|迷了路|找不到路|雪崩|泥石流|山体滑坡|塌方|地震|洪水|台风|暴雪|封路|路断/, needsNow: true },
];

/** 关键词之后的几个字：已经发生（了、得厉害、严重……），或者已经好了（不算） */
const NOW_AFTER = /^[^，]{0,4}?(?:了|得|着|严重|厉害|难受|受不了|撑不住|不行|很重|好重|起不来|不退|\d{2}(?:\.\d)?度)/;
/** 关键词之后的几个字里有「了」：已经发生了 */
const DONE_AFTER = /^[^，]{0,4}?了/;
const NOW_BEFORE = /(?:有点|有些|有一点|开始|又)\s*$/;
const RECOVERED_AFTER = /^[^，]{0,3}?(?:不严重|不厉害|不明显|还好|还行|好了|好多了|缓解|减轻|没事|没啥|消了|退了|已经好)/;
/** 关键词后面紧跟「过」：经历过，是以前的事 */
const EXPERIENCED = /^过/;

function emergencyInClause(c: Clause): EmergencyKind | null {
  const t = c.text;
  if (c.carried.hypo || COND.test(t) || MODAL.test(t)) return null;
  const now = NOW.test(t);
  if (!now && (c.carried.hearsay || c.carried.past || HEARSAY.test(t) || PAST.test(t) || THIRD_PARTY.test(t))) return null;
  const asking = isAsking(c);
  for (const rule of EMERGENCY_RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    const at = m.index;
    const after = t.slice(at + m[0].length);
    if (negatedBefore(t, at) || RECOVERED_AFTER.test(after) || EXPERIENCED.test(after)) continue;
    // 证件与丢失之间夹着否定：「护照没丢」
    if (m.groups?.between && NEG_BEFORE.test(m.groups.between)) continue;
    const done = m[0].endsWith('了') || DONE_AFTER.test(after);
    const happened = done || NOW_AFTER.test(after);
    // 问法里只有已经发生了的才算：「高反了怎么办」算，「高反怎么办」「高反严重吗」是出行前在问
    if (asking && !done && !rule.askOk) continue;
    if (rule.needsNow && !happened && !now && !NOW_BEFORE.test(t.slice(0, at))) continue;
    return rule.kind;
  }
  return null;
}

/** 客户此刻正处在危险或困境里：高反症状、受伤、急病、证件丢失、被困走失。按小句判；
 *  出行前的提问（「会不会高反」「高反怎么办」）、假设、否定、转述别人以前的经历都不算 */
export function emergencyOf(text: string): EmergencyKind | null {
  for (const c of clausesOf(text)) {
    const kind = emergencyInClause(c);
    if (kind) return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// 交互失败
// ---------------------------------------------------------------------------------------------

/** 去掉标点、空白与 emoji，只留字（汉字、字母、数字） */
const squash = (s: string): string => normalize(s).replace(/[^\p{L}\p{N}]+/gu, '');

function bigrams(s: string): Set<string> {
  const cs = [...s];
  const out = new Set<string>();
  for (let i = 0; i + 1 < cs.length; i += 1) out.add(cs[i]! + cs[i + 1]!);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 重复提问的最短长度（去标点空白之后的字数）：「好的」「嗯嗯」这类短应答重复不算 */
const REPEAT_MIN_CHARS = 4;
const REPEAT_JACCARD = 0.8;

/**
 * 这句与前 2 条客户消息之一重复：去标点空白后相同，或字二元组 Jaccard ≥ 0.8；长度 ≥ 4 字。
 * previous 是这句之前的客户消息（旧的在前），只看最后 2 条
 */
export function repeatedQuestion(text: string, previous: readonly string[]): boolean {
  const cur = squash(text);
  if ([...cur].length < REPEAT_MIN_CHARS) return false;
  const grams = bigrams(cur);
  return previous.slice(-2).some((p) => {
    const prev = squash(p);
    if ([...prev].length < REPEAT_MIN_CHARS) return false;
    return prev === cur || jaccard(grams, bigrams(prev)) >= REPEAT_JACCARD;
  });
}

export function turnFailed(s: TurnSignals): boolean {
  if (s.guardHit) return false;
  return s.emptyModelReply || s.noRetrievalResult || s.repeatedQuestion;
}

/** 失败窗口：最近 6 轮 */
export const FAILURE_WINDOW = 6;
/** 最近 6 轮（新的在后）：最后 2 轮都失败，或其中 3 轮失败 */
export function failureThresholdReached(recent: readonly number[]): boolean {
  const w = recent.slice(-FAILURE_WINDOW);
  return (w.at(-1) === 1 && w.at(-2) === 1) || w.filter((x) => x === 1).length >= 3;
}

// ---------------------------------------------------------------------------------------------
// 负面情绪（开放问题 4：词表加规则）
// ---------------------------------------------------------------------------------------------

/** 强：冲着我们的辱骂。「垃圾」「废物」「滚」要冲着人说（「垃圾桶」「滚烫」「摇滚」不算） */
const STRONG_ANY =
  /傻[逼比屄b]|煞笔|(?<![a-z])sb(?![a-z])|nmsl|cnm|草泥马|操你|艹你|日你妈|tmd|他妈的|你妈的|你妈逼|去你妈|去死|死全家|狗日的|狗东西|王八蛋|混蛋|人渣|畜生|贱人|智障|脑残|弱智|白痴|蠢货|蠢猪|滚犊子|滚蛋|滚开|给我滚|滚远点|(?<![a-z])fuck|(?<![a-z])shit(?![a-z])/;
const TRASH_TARGET = '(?:公司|平台|客服|服务|ai|机器人|系统|回复|回答|玩意儿?|东西|产品|旅行社)';
const STRONG_TARGETED = new RegExp(
  '(?:你们?(?:就是|真是?|太|是|这)?|真是?|太|就是|简直|一群|全是|都是|什么|这(?:是|就是|也太|太|真是?|破)?)(?:个|群|堆|种)?(?:垃圾|废物)' +
    `|(?:垃圾|废物)${TRASH_TARGET}|(?:垃圾|废物)(?:一样|透了|死了|至极)`,
);
/** 整个小句就是一个弱的词（「服了」） */
const WEAK_WHOLE = /^(?:我|真)?服了(?:吧|啊|呀|哈)*$/;
/** 整个小句就是骂人的一个词（「垃圾」「滚」「妈的」），前后只有你、给我、快、吧、啊这类 */
const STRONG_WHOLE = /^(?:你们?|给我|快|赶紧)?(?:滚|垃圾|废物|妈的)(?:吧|啊|呀|了|蛋|开)*$/;
/** 「垃圾」「废物」后面跟着这些就是在说东西本身：垃圾分类、废物利用 */
const NOT_TRASH_TALK =
  /(?:垃圾|废物)(?:分类|桶|袋|食品|处理|回收|站|车|场|短信|广告|邮件|篓|堆|费|利用)|(?:扔|倒|捡|丢|带|收拾|清理|分)(?:垃圾|废物)/;

/** 弱：失望、无语、太差了、坑人、离谱、敷衍这一类 */
const WEAK =
  /失望|无语|(?:太|很|真|好|特别|非常|超|贼)差|差劲|差到|烂透|(?:太|好|真|很)烂|(?<![天地水矿土泥大])坑(?:人|爹|钱|我|死)|(?:被|太|好|真|很)坑|黑店|宰客|割韭菜|智商税|离谱|敷衍|烦死了|(?:好|真|很)烦|(?<!麻)烦人|心烦|气死我|气死了|(?<![名人])气人|(?<![篝灯烟野炉柴])火大(?!会)|恼火|(?:很|太|真)生气|生气了|不耐烦|受够了|忍无可忍|(?:我|真|彻底|算是?)服了(?=$|你|吧|啊|呀|哈)|服了(?:你们|你|ai)|答非所问|听不懂人话|不懂人话|牛头不对马嘴|驴唇不对马嘴|鸡同鸭讲|白问了|(?:太|很|真)浪费时间|浪费我(?:的)?时间|一点用(?:都|也)没有|没屁用|毫无用处|不靠谱|不专业|慢死了|(?:回|回复|反应|处理)[^，]{0,3}太慢/;
/** 说的是别家、以前的事：不是冲着我们 */
const OTHER_AGENCY = /别家|其他家|其它家|另一家|前一家|别的(?:旅行社|平台|公司)|其他(?:旅行社|平台|公司)|同行/;

function negativeInClause(c: Clause): 0 | 1 | 2 {
  const t = c.text;
  if (isAsking(c) || c.carried.hypo || c.carried.hearsay || c.carried.past || COND.test(t)) return 0;
  if (HEARSAY.test(t) || PAST.test(t) || OTHER_AGENCY.test(t)) return 0;
  const strong =
    STRONG_ANY.exec(t) ?? (NOT_TRASH_TALK.test(t) ? null : STRONG_TARGETED.exec(t)) ?? (STRONG_WHOLE.test(t) ? { index: 0 } : null);
  if (strong && !negatedBefore(t, strong.index)) return 2;
  const weak = WEAK.exec(t);
  // 「不靠谱」「不耐烦」「不专业」自己带着不：只看词前面
  if ((weak && !negatedBefore(t, weak.index)) || WEAK_WHOLE.test(t)) return 1;
  return 0;
}

/** 负面情绪（开放问题 4：词表加规则）：0 无、1 弱、2 强 */
export function negativeLevel(text: string): 0 | 1 | 2 {
  let level: 0 | 1 | 2 = 0;
  for (const c of clausesOf(text)) {
    const l = negativeInClause(c);
    if (l > level) level = l;
    if (level === 2) break;
  }
  return level;
}

/** 情绪窗口：最近 3 条客户消息 */
export const SENTIMENT_WINDOW = 3;
/** 最近 3 条客户消息里有 1 次强或 2 次弱 */
export function sentimentThresholdReached(recent: readonly number[]): boolean {
  const w = recent.slice(-SENTIMENT_WINDOW);
  return w.some((x) => x === 2) || w.filter((x) => x === 1).length >= 2;
}

/**
 * 把这一轮的值追加进窗口（新的在后），只留最近 size 个，再去掉前导的 0：前导的 0 不影响两个阈值，
 * 全 0 时返回 undefined（会话上不留这个键，平常的会话 JSON 不多出字段）
 */
export function pushWindow(prev: readonly number[] | undefined, value: number, size: number): number[] | undefined {
  const w = [...(prev ?? []), value].slice(-size);
  const first = w.findIndex((x) => x !== 0);
  return first < 0 ? undefined : w.slice(first);
}

// ---------------------------------------------------------------------------------------------
// 敏感信息（R23，第 16 步接进引擎）
// ---------------------------------------------------------------------------------------------

const HEALTH =
  /病史|慢病|慢性病|高血压|低血压|血压高|糖尿病|血糖高|心脏病|冠心病|心脏不好|心脏支架|搭过桥|搭桥|哮喘|癫痫|脑梗|中风|肾病|透析|癌|肿瘤|化疗|做过手术|手术后|术后|骨折|腿脚不好|腿脚不便|腿脚不利索|腿不好|膝盖不好|行动不便|走路不方便|走不了远路|坐轮椅|轮椅|拄拐|残疾|怀孕|孕期|孕妇|孕早期|孕中期|孕晚期|备孕|有身孕|身体不好|身体不太好|身子不好|体弱|过敏|抑郁|焦虑症|精神疾病|心理疾病|老年痴呆|阿尔茨海默/;
/** 小句里点到了具体的人（同行的家人或自己）：问法里说出来的病情也是在告诉我们 */
const PERSON = new RegExp(`我|我们|我家|家里|长辈|${FAMILY}|岳父|岳母`);
const CHILD = '(?:孩子|小孩|宝宝|宝贝|娃|儿子|女儿|闺女|小朋友|大宝|二宝|老大|老二|侄子|侄女|外甥|外孙|孙子|孙女|男孩|女孩|小孩子)';
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 「12」「十二」「三」「半」→ 数；认不出为 null */
function ageNumber(s: string): number | null {
  if (s === '半') return 0;
  if (/^\d{1,2}$/.test(s)) return Number(s);
  if (/^十[一二三四五六七八九]?$/.test(s)) return 10 + (CN_NUM[s[1] ?? ''] ?? 0);
  if (/^[一二两三四五六七八九]十[一二三四五六七八九]?$/.test(s)) return (CN_NUM[s[0]!] ?? 0) * 10 + (CN_NUM[s[2] ?? ''] ?? 0);
  return CN_NUM[s] ?? null;
}
const AGE = '(\\d{1,2}|[一二两三四五六七八九十]{1,3}|半)\\s*(?:周岁|岁|个月)';
const CHILD_AGE_AFTER = new RegExp(`${CHILD}[^，]{0,4}?${AGE}`, 'g');
const CHILD_AGE_BEFORE = new RegExp(`${AGE}(?:半)?(?:的)?${CHILD}`, 'g');
/** 上幼儿园、小学、初一：14 周岁以下 */
const SCHOOL = /幼儿园|小学|[一二三四五六]年级|初一/;
const MINOR_AGE = 14;

/** 一个年龄（「8岁」「三岁」）：同一句话里提到了孩子时，不挨着「孩子」也算是孩子的年龄（「两个孩子，一个8岁一个12岁」） */
const BARE_AGE = /(\d{1,2}|[一二两三四五六七八九十]{1,3}|半)\s*(?:周岁|岁)/g;
const CHILD_RE = new RegExp(CHILD);

function childAgeInClause(t: string): boolean {
  for (const re of [CHILD_AGE_AFTER, CHILD_AGE_BEFORE]) {
    for (const m of t.matchAll(re)) {
      const n = ageNumber(m[1] ?? '');
      // 「宝宝8个月」是婴儿
      if (n !== null && (m[0].includes('个月') || n < MINOR_AGE)) return true;
    }
  }
  return SCHOOL.test(t) && CHILD_RE.test(t);
}
const bareMinorAge = (t: string): boolean =>
  [...t.matchAll(BARE_AGE)].some((m) => {
    const n = ageNumber(m[1] ?? '');
    return n !== null && n < MINOR_AGE;
  });

/** 长辈病史、慢病、孕期、行动不便这类健康信息；14 周岁以下孩子的年龄等信息 */
export function sensitiveCategoriesOf(text: string): SensitiveCategory[] {
  const found = new Set<SensitiveCategory>();
  for (const c of clausesOf(text)) {
    const t = c.text;
    if (c.carried.hypo || c.carried.hearsay || HEARSAY.test(t)) continue;
    const h = HEALTH.exec(t);
    // 假设（「如果有高血压能去吗」）与否定（「没有高血压」）不算；问法里点到了具体的人（「我妈高血压能去西藏吗」）算
    if (h && !negatedBefore(t, h.index) && !COND.test(t) && (!isAsking(c) || PERSON.test(t))) {
      found.add('health');
    }
    if (childAgeInClause(t)) found.add('minor');
  }
  // 同一句话里提到了孩子、另一小句只说了年龄
  const clauses = clausesOf(text).filter((c) => !c.carried.hypo && !c.carried.hearsay && !HEARSAY.test(c.text));
  for (const c of clauses) {
    if (bareMinorAge(c.text) && clauses.some((o) => o.sentence === c.sentence && CHILD_RE.test(o.text))) found.add('minor');
  }
  return (['health', 'minor'] as const).filter((k) => found.has(k));
}

// ---------------------------------------------------------------------------------------------
// 撤回同意与删除请求（R23，第 16 步接进引擎）
// ---------------------------------------------------------------------------------------------

const MY_INFO = '(?:我的|我们的|我家的|我)?(?:个人)?(?:信息|资料|数据|隐私|记录|聊天记录|手机号|电话号码?|身份证号|护照号)';
const DELETE = '(?:删除|删掉|删了|删|清除|清空|抹掉|销毁|注销)';
const WITHDRAW: readonly RegExp[] = [
  /(?:撤回|撤销|收回|取消)(?:我的|对你们的)?(?:同意|授权)|不再同意/,
  new RegExp(`${DELETE}${MY_INFO}`),
  new RegExp(`(?:把|将)${MY_INFO}(?:都|全部|全)?${DELETE}`),
  new RegExp(`${MY_INFO}(?:请|麻烦)?(?:都|全部|全)?(?:${DELETE}|别存|不要存|不要保存|不要保留)`),
  new RegExp(`(?:别|不要|不许|不准|请勿|不能)(?:再)?(?:保存|保留|存|记录|留着|收集|使用|用)${MY_INFO}`),
  new RegExp(`不同意(?:你们)?(?:收集|使用|保存|处理|存)${MY_INFO}`),
];
/** 礼貌的请求（「可以删除我的信息吗」「能不能帮我删掉资料」）算；问政策、问怎么做（「你们会删除我的信息吗」「怎么撤回」）不算 */
const POLITE_ASK = /^(?:请|麻烦)?(?:你们?|您)?(?:能不能|可不可以|可以|能|麻烦|帮我|帮忙)/;
const POLICY_ASK = /会不会|会(?!儿)|是否|怎么|如何|多久|什么时候|啥时候|哪里|能否保证|有没有/;
/** 前面带着否定或不需要（「不用删除我的信息」「我不想撤回同意」） */
const NOT_WANTED = /(?:不用|不需要|不必|不想|没有?|别)\s*$/;

/** 「撤回同意」「删除我的信息」「别保存我的资料」这类行权的话（R23）。按小句判，疑问与转述排除 */
export function consentWithdrawalOf(text: string): boolean {
  for (const c of clausesOf(text)) {
    const t = c.text;
    if (c.carried.hearsay || HEARSAY.test(t) || THIRD_PARTY.test(t) || c.carried.hypo) continue;
    if (COND.test(t)) continue;
    const m = WITHDRAW.map((re) => re.exec(t)).find((x) => x !== null);
    if (!m) continue;
    const head = t.slice(0, m.index);
    if (NOT_WANTED.test(head)) continue;
    if (isAsking(c) && (POLICY_ASK.test(t) || !POLITE_ASK.test(t))) continue;
    return true;
  }
  return false;
}
