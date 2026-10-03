// 确定性转人工触发（docs/architecture/02-conversations-workbench/spec.md「确定性转人工触发」、R15、R23、开放问题 4）。
// 纯函数，配标注语料自测（src/handoff/triggers.corpus.ts 由 src/handoff/handoff.selftest.ts 逐条跑）：不 import store、engine、
// tools、llm、adapters、src/db/。改词表或规则时先往语料里补正反例，再改到语料全过（plan「实施记录 · 第 11 步」审查之后改的）。
//
// 共同的读法：按小句判。一句话（。！？换行分号之间）再按逗号、顿号、空格等切成小句，一个小句命中就算。
// 不算的：出行前的提问与假设（「去西藏会不会高反」「万一护照丢了怎么办」）、否定（「没有高反」「护照没丢」）、
// 转述别人或以前的经历与评价（「听说高反挺吓人的」「朋友说你们很坑」「上次骨折过」）。
// 假设、转述、以前这三类在同一句话里往后带（「如果到了拉萨，高反了怎么办」后半句也是假设）；「这次、今天、结果、但是」这类
// 说法打断以前（「去年来过没高反，今天高反了」后半句算），「结果、但是、没想到」打断转述。
// 词表不按子串收宽泛的词（「找不到」「跑了」「骗人」「不行」）：证件要和丢失连在一起，走失要有人，情绪要冲着我们。

export type EmergencyKind = 'altitude' | 'injury' | 'medical' | 'documents' | 'stranded';
export type SensitiveCategory = 'health' | 'minor';

/** 一轮的交互失败信号（R15）。guardHit 有值时整轮不算失败 */
export interface TurnSignals {
  /** 模型没给出可用文本，落到兜底话术（engine.ts 里空回复那一处） */
  emptyModelReply: boolean;
  /** 本轮 search_routes 什么也没返回，且不是 destinationMiss */
  noRetrievalResult: boolean;
  /**
   * 这句在问（问号、句末吗/呢/么、疑问词，见 isQuestion），且与前 2 条客户消息之一重复（去标点空白后相同，
   * 或字二元组 Jaccard ≥ 0.8，长度 ≥ 4 字）；重复回答、重复确认不算（owner 2026-10-03）
   */
  repeatedQuestion: boolean;
  guardHit: 'price' | 'injection' | null;
}

// ---------------------------------------------------------------------------------------------
// 归一、切句与小句
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

/** 繁体常用字 → 简体：疑问说法、紧急情况与情绪词表里会出现的字（照 src/jobs/optout.ts 的做法，只收用得到的） */
const TRAD: Record<string, string> = {
  嗎: '吗',
  麼: '么',
  麽: '么',
  幾: '几',
  個: '个',
  號: '号',
  為: '为',
  甚: '什',
  樣: '样',
  沒: '没',
  這: '这',
  誰: '谁',
  問: '问',
  請: '请',
  裡: '里',
  裏: '里',
  兒: '儿',
  時: '时',
  點: '点',
  間: '间',
  種: '种',
  條: '条',
  歲: '岁',
  週: '周',
  張: '张',
  塊: '块',
  輛: '辆',
  層: '层',
  萬: '万',
  無: '无',
  論: '论',
  著: '着',
  還: '还',
  過: '过',
  幹: '干',
  長: '长',
  遠: '远',
  們: '们',
  錢: '钱',
  護: '护',
  丟: '丢',
  傷: '伤',
  難: '难',
  媽: '妈',
  醫: '医',
  車: '车',
  禍: '祸',
  燒: '烧',
  頭: '头',
  腦: '脑',
  嘔: '呕',
  見: '见',
  聯: '联',
  繫: '系',
  撐: '撑',
  厲: '厉',
  嚴: '严',
  現: '现',
  剛: '刚',
  後: '后',
  證: '证',
  帶: '带',
  隊: '队',
  團: '团',
  來: '来',
  開: '开',
  對: '对',
  說: '说',
  聽: '听',
  網: '网',
  會: '会',
  擔: '担',
  憂: '忧',
  慮: '虑',
  寶: '宝',
  爺: '爷',
  孫: '孙',
  邊: '边',
  壞: '坏',
  斷: '断',
  暈: '晕',
  嚇: '吓',
  災: '灾',
  颱: '台',
  風: '风',
  廢: '废',
  滾: '滚',
  爛: '烂',
  煩: '烦',
  氣: '气',
  殘: '残',
  癡: '痴',
  機: '机',
  務: '务',
  態: '态',
  滿: '满',
  離: '离',
  譜: '谱',
  語: '语',
  騙: '骗',
  專: '专',
  業: '业',
  貴: '贵',
  價: '价',
  報: '报',
  應: '应',
  該: '该',
  讓: '让',
  給: '给',
  謝: '谢',
};
const TRAD_RE = new RegExp(`[${Object.keys(TRAD).join('')}]`, 'g');

/** 归一：全角转半角、英文小写，emoji 与微信表情码换成空格 */
function normalizeBase(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(WECHAT_FACE, ' ').replace(EMOJI, ' ');
}
/** 再把繁体常用字转成简体：三类识别共用（重复提问的相似度照 spec 原定义，用 normalizeBase、不转繁简） */
function normalize(text: string): string {
  return normalizeBase(text).replace(TRAD_RE, (ch) => TRAD[ch] ?? ch);
}

/** 最后一处匹配的位置，没有为 -1 */
function lastIndexOf(re: RegExp, s: string): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let last = -1;
  for (const m of s.matchAll(g)) last = m.index;
  return last;
}

// 假设：小句里有它，这一小句与同一句话里后面的小句都不算（「如果到了拉萨，高反了怎么办」）
const COND = /如果|万一|要是|假如|假设|若是|倘若|一旦|的话/;
// 转述：听来的、看来的、别人说的
const HEARSAY =
  /听说|听人说|据说|网上|网传|评论|攻略|帖子|新闻|(?:有人|别人|朋友|同事|大家|网友|他们|她们|人家|邻居|同学|老公|老婆|爱人|家人|我妈|我爸|闺蜜)(?:都|也)?(?:说|讲|反映|提到|吐槽|觉得|认为|感觉)/;
// 以前的事
const PAST =
  /上次|上回|以前|之前|去年|前年|那次|那回|曾经|当时|那时|小时候|几年前|前几年|前两年|前些年|上个月|上周|上礼拜|前几天|前两天|前阵子|昨天|前天|昨晚|昨儿/;
/** 打断「以前」：说到此刻、这一次、今天，或者转折（「去年来过没高反，今天高反了」） */
const PAST_CUT = /现在|此刻|正在|目前|眼下|这会儿?|刚刚|刚才|突然|已经|这次|这回|今天|今早|今晚|今儿|结果|但是|可是|不过|没想到|谁知道?/;
/** 打断转述：转折与「这次」（「评论说这家酒店不错，结果孩子在泳池溺水了」）；「听说今天……」里的今天还是听来的 */
const HEARSAY_CUT = /结果|但是|可是|不过|没想到|谁知道?|这次|这回/;
/** 小句一开头就说此刻：前面带过来的转述到这里为止 */
const NOW_LEAD = /^(?:我们?|咱们?)?(?:现在|此刻|刚刚|刚才|突然|这会儿?)/;

const hearsayCutAt = (s: string): number => (NOW_LEAD.test(s) ? Math.max(0, lastIndexOf(HEARSAY_CUT, s)) : lastIndexOf(HEARSAY_CUT, s));
/** 这一小句之后还带不带着：小句里打断词之后又出现了标记就带，打断了就不带，都没有就照前面的 */
function carriedAfter(raw: string, prev: boolean, marker: RegExp, cut: number): boolean {
  const at = lastIndexOf(marker, raw);
  return cut < 0 ? prev || at >= 0 : at > cut;
}

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
      carried = {
        hypo: carried.hypo || COND.test(raw),
        hearsay: carriedAfter(raw, carried.hearsay, HEARSAY, hearsayCutAt(raw)),
        past: carriedAfter(raw, carried.past, PAST, lastIndexOf(PAST_CUT, raw)),
      };
    }
    if (SENTENCE_END.test(boundary)) {
      carried = { hypo: false, hearsay: false, past: false };
      sentence += 1;
    }
  }
  return out;
}

/** 关键词（位置 at）前面有没有没被打断的转述：本小句里的（'here'），或者前面小句带过来的（'carried'） */
function hearsayBefore(c: Clause, at: number): 'here' | 'carried' | null {
  const before = c.text.slice(0, at);
  const cut = hearsayCutAt(before);
  if (lastIndexOf(HEARSAY, before) > cut) return 'here';
  return c.carried.hearsay && cut < 0 ? 'carried' : null;
}
/** 关键词前面有没有没被打断的「以前」（本小句里的，或者前面带过来的） */
function pastBefore(c: Clause, at: number): boolean {
  const before = c.text.slice(0, at);
  const cut = lastIndexOf(PAST_CUT, before);
  return lastIndexOf(PAST, before) > cut || (c.carried.past && cut < 0);
}

/** 小句是在问：后面跟问号、以吗呢么嘛结尾、「了没」，或带着问法（吧不算：「太离谱了吧」是在抱怨）。紧急情况与情绪用 */
const ASKING_TAIL = /(?:[吗呢么嘛]|了没有?)$/;
const ASKING_WORDS =
  /会不会|是不是|是否|有没有|能不能|可不可以|怎么办|怎么样|咋办|咋整|如何|为什么|为啥|(?<![很好不最许])多少(?![数年女有])|多久|哪(?:里|儿|个|些)|什么时候|啥时候|怎么(?!这么|那么|回事)|(?![不没])(\p{Script=Han})[不没]\1/u;
/** 不是在问的「多少」「几」与正反问：「说了多少遍」「动不动」「时不时」 */
const NOT_A_QUESTION = /(?:说|问|讲|发|催|提|强调|解释|重复)了?(?:都|有)?(?:多少|几)(?:遍|次|回)|动不动|时不时/g;
const isAsking = (c: Clause): boolean => c.asked || ASKING_TAIL.test(c.text) || ASKING_WORDS.test(c.text.replace(NOT_A_QUESTION, ' '));

/** 关键词之前的 4 个字里有否定。「能不能」「是不是」「有没有」这类正反问里的不、没不是否定，先折掉 */
const NEG_BEFORE = /[没不未别无]/;
const foldAnotA = (s: string): string => s.replace(/(?![不没])(\p{Script=Han})[不没]\1/gu, '$1$1');
const negatedBefore = (clause: string, at: number): boolean => NEG_BEFORE.test(foldAnotA(clause.slice(0, at)).slice(-4));

// ---------------------------------------------------------------------------------------------
// 紧急情况：只有「此刻正在发生、客户本人或同行的人遇到」才算（紧急情况重精确）
// ---------------------------------------------------------------------------------------------

/** 同行的家人（走失、联系不上要有人） */
const FAMILY =
  '(?:孩子|小孩|宝宝|娃|儿子|女儿|闺女|老人|我妈|我爸|爸妈|爸爸|妈妈|父母|家人|老公|老婆|爱人|媳妇|婆婆|公公|爷爷|奶奶|外公|外婆|姥姥|姥爷|岳父|岳母|丈母娘|老丈人|同伴|队友|团友)';
/** 证件本身（「护照号」「证件照」「护照的照片」说的是号码与照片，不是证件） */
const DOC = '(?:护照|身份证|证件|通行证|台胞证|回乡证|签证|passport)(?!号|信息|照|片|复印件|扫描件|页|上|办理|申请|材料|过期)';
const LOSS = '(?:弄丢|丢失|遗失|丢|掉了|不见了|被偷|被抢|被扒|找不到(?!在哪|哪|怎么|地方|入口|页面|按钮|链接)|弄没|没(?:有)?了)';
/** 「孩子丢了东西」：丢的是东西，不是孩子 */
const LOST_THING = '(?:东西|钱|手机|包|钱包|玩具|行李|衣服|鞋|帽子|眼镜|水杯|护照|证件|身份证|一|个|件|张|本|把|只)';

interface EmergencyRule {
  kind: EmergencyKind;
  /** 带 g：同一小句里同一类的几处逐个看 */
  re: RegExp;
  /** 症状与轻伤：要有此刻的标记（关键词上的了、得厉害、39度，前面的有点、在，小句里的现在、突然、一直……） */
  needsNow?: boolean;
  /** 求救：问法里也算（「能不能帮我叫救护车」「要不要打120」） */
  askOk?: boolean;
  /** 天灾路况：要有人（我、我们、家人、同行）或此刻的说法（「九寨沟地震了吗」「雨季泥石流封路了怎么办」不算） */
  needsPerson?: boolean;
  /** 被困、失联、回不去：被困要说在哪儿或「了」，失联与回不去要有人（「被困在这个问题好久了」「玩得太开心回不去了」不算） */
  trapped?: boolean;
}
// 同一小句里按这个顺序（spec 的类型顺序）取第一个命中的；求救那一条排在急病后面，问法里只有它算
const EMERGENCY_RULES: EmergencyRule[] = [
  { kind: 'altitude', re: /高原肺水肿|高原脑水肿|肺水肿|脑水肿/g },
  { kind: 'altitude', re: /高反|高原反应|高山反应|高原病|缺氧/g, needsNow: true },
  {
    kind: 'injury',
    re: /骨折|摔断|车祸|撞车|被车撞|车子?翻了|侧翻|溺水|落水|掉进了?(?:河|湖|海|水|沟|山沟|悬崖)|坠崖|摔下(?:山|楼|去|来|悬崖)|大出血|流血不止|被(?:狗|蛇|猴子|熊|牦牛|马)咬/g,
  },
  {
    kind: 'injury',
    re: /受伤|摔伤|摔倒|摔了一跤|摔了一下|扭伤|扭到|崴了?脚|脚崴|脱臼|撞伤|撞到头|划伤|割伤|烫伤|烧伤|擦伤|流血|(?<!大)出血|被(?:蜂|蜜蜂|马蜂|虫|水母)(?:蛰|蜇|咬)/g,
    needsNow: true,
  },
  {
    kind: 'medical',
    re: /无法呼吸|没法呼吸|不能呼吸|昏迷|休克|晕倒|昏倒|晕过去|昏过去|不省人事|抽搐|呼吸困难|喘不上气|喘不过气|上不来气|心梗|心肌梗|(?:心脏病|哮喘|癫痫)(?:犯|发作)|中风|脑梗|脑溢血|吐血|便血|食物中毒|烧到\s*(?:3[89]|4\d)|急性(?!子)|急诊|抢救|icu|送(?:去|进|到)?医院|进了?医院|住院了|救护车|(?:打|叫|拨|拨打)了?\s*120(?![\d元块米分人天万个%])/g,
  },
  {
    kind: 'medical',
    re: /(?:叫|打|拨|喊|找)(?:个|辆|一辆)?救护车|(?:打|叫|拨|拨打)\s*120(?![\d元块米分人天万个%])/g,
    askOk: true,
  },
  {
    kind: 'medical',
    re: /发烧(?!友)|发高烧|高烧|过敏|胸闷|胸口(?:疼|痛|闷)|胸痛|心慌|心脏不舒服|上吐下泻|呕吐|想吐|一直吐|吐个不停|腹泻/g,
    needsNow: true,
  },
  {
    kind: 'documents',
    re: new RegExp(
      `${DOC}(?<between>[^，的]{0,6}?)${LOSS}|(?:弄丢|丢失|遗失|丢|被偷|被抢|被扒)了?(?:我的|我们的|${FAMILY}的)?${DOC}` +
        '(?![^，]{0,2}(?:还在|在呢|没丢|没事|还有|好好的|找到))',
      'g',
    ),
  },
  {
    kind: 'stranded',
    re: new RegExp(
      `走丢|走失|走散|${FAMILY}(?:丢了(?!${LOST_THING})|不见了|找不到了|联系不上|失联)|找不到${FAMILY}(?=了|啦|$)|联系不上${FAMILY}|` +
        '被(?:扔|丢|甩|落)(?:下|在)|把我们?(?:扔|丢|甩)(?:下|在)',
      'g',
    ),
  },
  { kind: 'stranded', re: /被困|困在|困住|失联|下不了山|回不去了|回不来了/g, trapped: true },
  { kind: 'stranded', re: /迷路|迷了路|找不到路/g, needsNow: true },
  { kind: 'stranded', re: /雪崩|泥石流|山体滑坡|塌方|地震|洪水|台风|暴雪|封路|路断/g, needsNow: true, needsPerson: true },
];

/** 「不小心」「一不留神」说的是意外，不是否定（判之前先去掉） */
const CARELESS = /一?不小心|一不留神|不留神|没注意|没留神/g;
/** 小句里说了此刻（也是「正在发生」的标记） */
const NOW = /现在|此刻|正在|目前|眼下|这会儿?|刚刚|刚才|突然|一直|还在|已经/;
/** 整条消息里明说了此刻：出行前、体质、问政策这几种排除让给它（「我现在高反了，明天还能去纳木错吗」） */
const NOW_STRICT = /现在|此刻|这会儿?|刚刚|刚才|突然|正在|眼下|目前/;
/** 「了」挂在关键词上：紧跟，或者隔一个短补语（摔伤了、丢了、晕过去了、高反得厉害了）。「了吗」「了没」是在问 */
const ATTACHED_AFTER =
  /^(?:[伤倒断破坏掉晕住走来上下起到发犯翻散开着]|起来|过去|进去|下来|进来|出来|得?(?:很|好|太|特别|非常|超|挺)?(?:厉害|严重)|在[^，了]{1,6})?了(?![吗么嘛没])/;
/** 关键词后面接着说程度或此刻的状态：得厉害、很严重、难受、39度…… */
const STATE_AFTER = /^(?:着|得|[^，了]{0,4}?(?:严重|厉害|难受|受不了|撑不住|不行|很重|好重|起不来|不退|\d{2}(?:\.\d)?度))/;
const FEVER = /^[^，]{0,3}?\d{2}(?:\.\d)?度/;
const NOW_BEFORE = /(?:有点|有些|有一点|开始|又|在)\s*$/;
/** 同一小句里说已经好了 */
const RECOVERED_AFTER =
  /^[^，]{0,3}?(?:不严重|不厉害|不明显|还好|还行|好了|好多了|好点|好些|好转|缓过来|缓解|减轻|没事|没啥|没那么|不难受|不疼|不痛|消了|退了|退烧|已经好|恢复)/;
/** 后面的小句报平安（「孩子走丢了，刚找到了」「高反了，现在好多了」） */
const RECOVERED_LATER =
  /^(?:(?:今天|现在|目前|已经|都|也|基本上?|差不多|总算|终于|刚刚?|后来|然后|又)\s*)*(?:好了|好多了|好点了|好些了|没事了|没事啦|没大碍|缓过来了|缓解了|恢复了|退烧了|烧退了|不疼了|不痛了|不难受了|好转了|找到了|找回来了|找着了|回来了|联系上了|出院了)/;
/** 关键词后面紧跟「过」：经历过，是以前的事 */
const EXPERIENCED = /^过/;
/** 「受伤了以后」「地震后」：拿它当时间，说的是之后的事 */
const TEMPORAL_AFTER = /^了?(?:以后|之后|后(?!来|面|边))/;
/** 关键词前面的担心与出行前的顾虑（只看关键词前面：「孩子走丢了我好害怕」算） */
const WORRY =
  /会不会|(?<![开学机社聚约协理体领不])会(?![儿员议场合面所计展馆话谈见])|(?<!不)容易|怕(?!是)|担心|担忧|害怕|顾虑|预防|防止|以防|避免|准备|提前|注意|(?<!不)小心|是否|有没有|要不要|需不需要|需要带|一般|通常|普遍|很多人|不少人|大部分人|大多数|风险|概率|几率|吓人|可怕|该不该|能不能|可不可以/;
/** 拿不准的说法：关键词已经发生了照算（「孩子可能骨折了」「护照好像丢了」） */
const EPISTEMIC = /可能|好像|似乎|怕是|估计|应该|疑似|像是|大概/;
/** 求救前面的问法（「要不要打120」「能不能帮我叫救护车」） */
const HELP_LEAD = /(?:要不要|需不需要|该不该|能不能|可不可以|能否|快|赶紧|帮我|帮忙|请)[^，]{0,4}$/;
/** 求助的问法：带着它、而且已经发生或有此刻标记的问句算（「我现在喘不上气怎么办」「我高反了会不会有危险」） */
const HELP =
  /怎么办|咋办|咋整|怎么弄|怎么搞|怎么处理|如何处理|该怎么|怎么联系|能不能帮|可不可以帮|帮帮|帮我|救命|求救|求助|快来|要不要(?:紧|去医院|送医|报警|打120|叫救护车|吃药|下山)|需不需要(?:去医院|送医|报警)|会不会有(?:事|危险|生命危险)|有没有(?:事|危险|生命危险)|危险吗|要紧吗|严不严重|危不危险|要不要紧|补办|报警|去医院|送医院|看医生|吃什么药|注意什么|赶不上/;
/** 不同行的别人：同一条消息里说了同行（一起、和我、团里的……）或小句里有此刻的说法才算 */
const OTHER_PEOPLE = /朋友|同事|邻居|网友|同学|别人|人家|有人|客人|游客|其他人|他们|她们/;
/** 撤回同意那边的转述对象（第 16 步用） */
const THIRD_PARTY = /朋友|同事|邻居|网友|同学|别人|人家/;
const COMPANION = /一起|同行|和我|跟我|我和|我跟|我们的|团里的?|队友|同伴|团友|结伴|我们团/;
/** 客户本人或同行的人 */
const PARTY = new RegExp(`我|咱|俺|${FAMILY}|大家|全家|一家|全团|一车人|${COMPANION.source}`);
/** 被困在哪儿 */
const TRAPPED_PLACE =
  /^在?(?:山|路|半路|路上|景区|景点|电梯|车上|车里|雪|高速|酒店|机场|服务区|这里|这儿|那里|那儿|原地|岛|海上|河|湖|沙漠|戈壁|隧道|当地|半山|野外|洞|林子|冰川|国外)/;
/** 出行前在问能不能去、适不适合、有没有别的线路、换个地方：整条消息不算（体质与慢性情况的自述，「我爸腿骨折了，还能去吗」） */
const PRETRIP =
  /能去|能不能去|可以去|还能去|去得了|去不了|能不能参加|能参加|适合去|适合(?:老人|孩子|小孩|我们|我|她|他|吗)|适不适合|合适吗|合不合适|(?:有没有|有|推荐|换)[^，]{0,8}(?:线路|路线|行程|团)|(?:线路|路线|行程|团)(?:吗|呢)|低海拔|海拔低|换个|换一|换成|改去|能报名|能玩吗|还能(?:出发|成行|玩)|能不能出发|能出发|能成行|上高原|去高原/;
/** 出行前的安排（要注意什么、带什么、餐食）：还没发生的不算（「孩子芒果过敏得很严重，酒店早餐要注意」） */
const PRETRIP_WEAK = /注意|带什么|带点什么|避开|避免|餐食|早餐|饮食|忌口|准备什么/;
/** 体质、病史、「容易」「一般」「每次」这类习惯性的说法 */
const HABIT = /体质|病史|老毛病|(?<!不)容易|一般|通常|每次|经常|老是|总是|一向|向来|平时|从小|正常|常见|一到[^，]{0,8}就/;
/** 问政策：退、赔、保险（「第一次去西藏，高反了能退款吗」「路上受伤了保险赔吗」），整条消息在问时不算 */
const POLICY = /退款|退团|退费|退钱|能退|可以退|退吗|赔|理赔|保险|报销|改期|延期|算不算|包不包|包括/;
/** 泛泛的场景（「出国旅游护照丢了怎么办」「自由行迷路了怎么办」「去西藏高反了要注意什么」）：没有人也没有此刻时不算 */
const GENERAL =
  /出国旅游|出国玩|出国旅行|出境游|出境旅游|自由行|跟团游|雨季|旱季|冬天|夏天|冬季|夏季|旺季|淡季|^(?:第一次|头一次|第一回)?去(?!年|过|医院|诊所|急诊|派出所|使馆|大使馆|领事馆)\p{Script=Han}/u;
/** 说价钱的语境：骨折价、大出血、贵到吐血、看到账单心梗了 */
const PRICE_CTX =
  /价|账单|多少钱|团费|费用|太贵|好贵|贵到|贵得|便宜|打折|折扣|优惠|花了|花钱|钱包|荷包|预算|块钱|刷卡|付款|\d+(?:万|千|元|块)|[一二两三四五六七八九十几]+(?:万|千)/;
/** 拿来夸张的那几个词（「看到报价我要晕倒了」「哈哈哈笑晕过去了」） */
const EXCLAIM = /^(?:骨折|大出血|吐血|心梗|心肌梗|晕倒|晕过去|昏倒|昏过去|休克|抽搐)$/;
const EXCLAIM_BEFORE = /(?:贵|气|笑|饿|穷|心疼|哭|美|帅|馋)(?:到|得)?我?(?:要|快)?$/;

/** 俚语与夸张的说法：骨折价、打骨折、大出血、贵到吐血、日期撞车 */
function slangOf(k: string, before: string, after: string, t: string, priceCtx: boolean): boolean {
  if (k === '骨折' && (/打(?:个|了|了个)?$/.test(before) || /^(?:价|促销|优惠|甩卖|大促|级)/.test(after))) return true;
  if (k === '大出血' && !/伤口|流血|孕|产|手术|胃|鼻|内/.test(t) && !new RegExp(`${FAMILY}[^，]{0,4}$`).test(before)) return true;
  if (k === '撞车' && /日期|日程|时间|行程|档期|安排|活动|计划|会议|航班|假期|节日/.test(t)) return true;
  if (!EXCLAIM.test(k)) return false;
  if (EXCLAIM_BEFORE.test(before)) return true;
  // 说着价钱、关键词前面又没点到同行的家人：夸张
  return priceCtx && !new RegExp(`${FAMILY}|${COMPANION.source}`).test(before);
}

function trappedOk(k: string, before: string, after: string, t: string): boolean {
  if (/被困|困在|困住/.test(k)) {
    return !/问题|事情?|烦恼|工作|学习|选择|纠结|会议/.test(before) && (/^住?了/.test(after) || TRAPPED_PLACE.test(after));
  }
  return PARTY.test(before) && !/开心|好玩|太美|舍不得|不想|哈哈/.test(t);
}

interface EmergencyCtx {
  /** 消息里点到了客户本人或同行的人 */
  person: boolean;
  companion: boolean;
  priceCtx: boolean;
  pretripWeak: boolean;
}

function emergencyInClause(c: Clause, ctx: EmergencyCtx): EmergencyKind | null {
  const t = c.text;
  if (c.carried.hypo || COND.test(t)) return null;
  const asking = isAsking(c);
  const help = HELP.test(t);
  const now = NOW.test(t);
  for (const rule of EMERGENCY_RULES) {
    for (const m of t.matchAll(rule.re)) {
      const at = m.index;
      const k = m[0];
      const before = t.slice(0, at);
      const after = t.slice(at + k.length);
      if (slangOf(k, before, after, t, ctx.priceCtx)) continue;
      if (negatedBefore(t, at) || RECOVERED_AFTER.test(after) || EXPERIENCED.test(after) || TEMPORAL_AFTER.test(after)) continue;
      // 证件与丢失之间夹着否定：「护照没丢」
      if (m.groups?.between && NEG_BEFORE.test(m.groups.between)) continue;
      const attached = k.includes('了') || ATTACHED_AFTER.test(after);
      const state = attached || STATE_AFTER.test(after) || NOW_BEFORE.test(before);
      // 以前的事；转述（本人或同行的人已经出了事的，不吃前面小句带过来的转述：「听说前面塌方了，我们被困在半路了」）
      if (pastBefore(c, at)) continue;
      const heard = hearsayBefore(c, at);
      if (heard === 'here' || (heard === 'carried' && !(attached && PARTY.test(before)))) continue;
      // 担心与顾虑只看关键词前面；拿不准的说法在已经发生时照算
      if (WORRY.test(before) && !(rule.askOk && HELP_LEAD.test(before))) continue;
      if (EPISTEMIC.test(before) && !attached) continue;
      if (OTHER_PEOPLE.test(before) && !ctx.companion && !now) continue;
      // 问法：是非问（X了吗、有没有X、会X吗）与问政策一律不算；带求助问法而且已经发生或有此刻标记的算；求救本身算
      if (asking && !rule.askOk && !(help && (state || now))) continue;
      if (rule.needsNow && !state && !now) continue;
      if (rule.needsPerson && !ctx.person && !now) continue;
      if (rule.trapped && !trappedOk(k, before, after, t)) continue;
      if (ctx.pretripWeak && !attached && !now && !FEVER.test(after)) continue;
      return rule.kind;
    }
  }
  return null;
}

/** 客户此刻正处在危险或困境里：高反症状、受伤、急病、证件丢失、被困走失。按小句判；
 *  出行前的提问（「会不会高反」「高反怎么办」）、假设、否定、转述别人以前的经历都不算 */
export function emergencyOf(text: string): EmergencyKind | null {
  const cleaned = text.replace(CARELESS, '');
  const whole = normalize(cleaned);
  const clauses = clausesOf(cleaned);
  const person = PARTY.test(whole);
  // 出行前、体质与习惯、问政策、泛泛的场景：整条消息不算，除非明说了此刻
  if (!NOW_STRICT.test(whole)) {
    if (PRETRIP.test(whole) || HABIT.test(whole)) return null;
    if (POLICY.test(whole) && clauses.some(isAsking)) return null;
    if (!person && GENERAL.test(whole)) return null;
  }
  const ctx: EmergencyCtx = {
    person,
    companion: COMPANION.test(whole),
    priceCtx: PRICE_CTX.test(whole),
    pretripWeak: PRETRIP_WEAK.test(whole),
  };
  for (let i = 0; i < clauses.length; i += 1) {
    const kind = emergencyInClause(clauses[i]!, ctx);
    if (!kind) continue;
    // 后面的小句报了平安
    if (clauses.slice(i + 1).some((c) => RECOVERED_LATER.test(c.text))) return null;
    return kind;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// 交互失败
// ---------------------------------------------------------------------------------------------

// 在问：重复提问的前提（owner 2026-10-03 定，plan「Open」第 11 步选 B）。重复回答、重复确认不算：锁定的 engine.selftest V4
// 把「两位 12号」连说三遍，是在回答。按小句判，有一个小句在问就算：后面跟问号（全角半角）、以吗呢么嘛结尾（应答的「可以的呢」
// 「好的呢」不算）、句末「X 不」「X 没」（「是纯玩团不」「有优惠没」），或带着疑问词。
// 疑问词不按子串收：「几」要接量词（「几乎」「十几个」「过几天」「这几天」「我们几个人」「约了几个朋友」不算），「哪怕」「无论如何」
// 「不怎么样」「不咋样」「没什么」「门票什么的」「很多少数民族」「动不动」「时不时」「说了多少遍」不算，后面接着都、也的是任指
// （「什么都行」「哪天都可以」「去不去都行」）。判之前先归一：全角转半角、英文小写、繁体常用字转简体，emoji 与微信表情码当分隔。

/** 「几」后面接的量词（「几号」「几天」「几个」「几位」「几折」「几星」……） */
const MEASURE =
  '(?:号|天|日|晚|夜|点|月|周|星期|年|岁|个|位|人|间|种|条|次|家|张|块|元|站|趟|口|层|辆|小时|分钟|钟|折|星|件|公里|斤|楼|遍|套|成)';
/** 小句以吗、呢、么、嘛结尾。「那么」「这么」「多么」「要么」不是问，「什么」「怎么」归疑问词；「早着呢」不是问；「好嘛」「行嘛」是应答 */
const ASK_TAIL = /(?:吗|(?<!着)呢|(?<![那这多要什怎])么|(?<![好行对是就样以干])嘛)$/;
/** 句末「X 不」「X 没」：前面要有有、是、能、要这类说法（「是纯玩团不」「有优惠没」「能便宜点不」；「我还没」「我们也不」不算） */
const ASK_TAIL_NEG = /(?:有|是|能|要|会|可以|行|去|想|带|含|包)[^，不没还就也都算再先了]{1,8}(?:不|没有?)$/;
/** 「还没定呢」「正在看呢」：句末的呢是在陈述；「可以的呢」「嗯嗯好的呢」「是的呢」：应答与确认 */
const STATED_NE =
  /(?:还没|还在|正在)[^，]*呢$|^(?:嗯+|好+|哦+|噢+|对+)?(?:好的|可以的?|是的|对的|行的?|没问题|收到|知道了?|明白了?|好滴|好哒|好嘞|ok|了解|嗯嗯|好)呢$/;
/** 疑问词的这些用法不是在问，判之前先从小句里去掉 */
const NOT_ASKING = new RegExp(
  [
    // 任指：疑问词（或正反问）后面隔着至多两个字接都、也（「什么都行」「哪天都可以」「几个人都行」「去不去都行」）
    `(?:(?<![为凭])什么|(?<!为)啥|干嘛|谁|哪(?:里|儿|个|些|天|家|种|条|位)?|(?<!不)怎么|怎样|咋|多少|几${MEASURE}?|(\\p{Script=Han})[不没]\\1)[^，我你他她们]{0,2}?(?:都|也)`,
    // 没什么、没多少、没几天、没多久
    '没有?(?:什么|啥|多少|几|多久|怎么)',
    // 不怎么样、不咋样、哪怕、无论如何、不管多少钱
    '不怎么|不怎样|不咋|哪怕',
    '(?:无论|不论|不管)[^，]*',
    // 「门票什么的」是「等等」（「干什么的」「是什么的」还是在问）
    '(?<![干做是搞])什么的',
    // 多少有点、多少有些：是「稍微」；多多少少；很多少数民族
    '多少(?:有点|有些|会)|多多少少|(?<=[很好许不最])多少',
    // 我们几个人、约了几个朋友、我和几个同事：说的是人数
    '(?:我们|咱们|他们|她们|了|和|跟|与|同|约)几(?:个|位|家)',
    // 说了多少遍、动不动、时不时
    '(?:说|问|讲|发|催|提|强调|解释|重复)了?(?:都|有)?(?:多少|几)(?:遍|次|回)',
    '动不动|时不时',
  ].join('|'),
  'gu',
);
/** 疑问词与正反问（能不能、可不可以、是不是、有没有、行不行……）。「几」前面是数字、十、好、这、那、过、前、近的不是问 */
const ASK_WORDS = new RegExp(
  '为什么|为啥|凭什么|干嘛|干吗|什么|啥|谁|哪|怎么|怎样|咋|如何|多少|多久|多长时间|多远|请问|想问|可以吗|' +
    `(?<![\\d十百千万好过再多这那前后没些近])几${MEASURE}|` +
    '(?<![很好许诸众差不最太更那这再过])多(?:高|大|长|重|贵|宽|深|冷|热)(?![型家量部半数多点])|' +
    '(?![不没])(\\p{Script=Han})[不没]\\1',
  'u',
);

function clauseAsks(c: Clause): boolean {
  if (c.asked) return true;
  if (ASK_TAIL.test(c.text) && !STATED_NE.test(c.text)) return true;
  if (ASK_TAIL_NEG.test(c.text)) return true;
  return ASK_WORDS.test(c.text.replace(NOT_ASKING, ' '));
}

/** 这句客户消息是在问：有一个小句后面跟问号、以吗呢么嘛结尾，或带着疑问词（不按子串收，见上） */
export function isQuestion(text: string): boolean {
  return clausesOf(text).some(clauseAsks);
}

/** 去掉标点、空白与 emoji，只留字（汉字、字母、数字）。照 spec 原定义，不转繁简 */
const squash = (s: string): string => normalizeBase(s).replace(/[^\p{L}\p{N}]+/gu, '');

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
 * 这句在问（isQuestion），且与前 2 条客户消息之一重复：去标点空白后相同，或字二元组 Jaccard ≥ 0.8；长度 ≥ 4 字。
 * 重复回答、重复确认（「两位 12号」「就订这个」「可以的呢」）不算。previous 是这句之前的客户消息（旧的在前），只看最后 2 条
 */
export function repeatedQuestion(text: string, previous: readonly string[]): boolean {
  const cur = squash(text);
  if ([...cur].length < REPEAT_MIN_CHARS || !isQuestion(text)) return false;
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
// 负面情绪（开放问题 4：词表加规则）：要冲着我们（「针对我们的话」）
// ---------------------------------------------------------------------------------------------

/** 冲着我们：你们、客服、机器人、回复、服务、导游……，或者就是在评价这次对话（答非所问、说了多少遍） */
const US =
  /你们|你(?!好)|您(?!好)|客服|机器人|ai|回复|回答|服务|态度|这家|你家|贵司|顾问|小编|系统|平台|公司|旅行社|导游|领队|司机|师傅|玩意|答非所问|听不懂|(?:说|问|讲|发|催)了.{0,4}(?:遍|次)/;
/** 说的是客户自己、家人、工作、天气、那边的景点……：没冲着我们时，弱词不算（「我英语很差」「最近工作烦死了」「那边天气太差了」） */
const OTHER =
  /自己|我的?(?:英语|数学|方向感|体力|身体|睡眠|记性|脾气|运气|皮肤|胃|腿|腰|眼睛|视力|口语|水平|成绩|工资|收入|酒量|胆子)|老公|老婆|妈妈|我妈|我爸|爸爸|爱人|媳妇|对象|男朋友|女朋友|男友|女友|孩子|儿子|女儿|婆婆|公公|老人|家人|爸妈|父母|闺蜜|领导|老板|同事|室友|工作|上班|加班|学习|考试|天气|堵车|交通|航班|飞机|火车|高铁|身体|生活|日子|前任|房价|股票|景区|景点|海滩|沙滩|那边|那里|那儿|这里|当地|这地方|那地方/;
/** 出游的动机（「最近工作烦死了，想出去散散心」「受够了上班，有什么海岛推荐吗」） */
const MOTIVATION = /散心|散散心|放松一下|透透气|出去玩|出去走走|出去转转|换个心情|逃离|想出去|有什么[^，]{0,6}推荐/;
/** 开玩笑 */
const JOKE = /哈哈|hhh|笑死|233/;
/** 褒义的离谱、无语（「便宜得离谱」「美到无语」） */
const POSITIVE =
  /(?:美|好看|漂亮|便宜|划算|好吃|好玩|开心|爽|值|帅|赞|棒|好|美丽|壮观|震撼|舒服|干净|实惠|浪漫|好喝)(?:得|到)(?:有点|有些)?(?:离谱|无语)/;
/** 打消疑虑的问法：这类问句里的强词也不算（「你们不会是骗人的吧」） */
const DOUBT = /骗|坑|靠谱|正规|真的假的|不会是|会不会|是不是真/;
/** 弱词前面的担心与顾虑：售前疑虑（「第一次报团，怕被坑」「最怕导游敷衍」） */
const WORRY_NEG = /怕|担心|担忧|害怕|顾虑|万一|会不会|避免|防止|以防|小心/;
/** 反问式的抱怨：问句里照算（「你听不懂人话吗」） */
const RHETORICAL = /听不懂人话|不懂人话|答非所问|(?:说|问|讲|发|催)了.{0,4}(?:遍|次)|有完没完/;

/** 强：冲着人说的辱骂。这些词本身就是冲着人的 */
const STRONG_DIRECTED =
  /操你|艹你|日你妈|你妈的|你妈逼|去你妈|去死|死全家|草泥马|cnm|nmsl|狗日的|滚犊子|滚蛋|滚开|给我滚|滚远点|滚一边|滚出去|(?<![a-z])fuck\s*(?:you|u)(?![a-z])/;
/** 骂人的词：要冲着我们（你、你们、客服、AI……），或者整个小句就是它（「傻逼」「神经病」）；自嘲与泛指不算 */
const INSULT =
  /傻[逼比屄b]|煞笔|(?<![a-z])sb(?![a-z])|智障|脑残|弱智|白痴|蠢货|蠢猪|笨蛋|人渣|畜生|贱人|狗东西|王八蛋|混蛋|神经病|放屁|狗屁|(?<![a-z])fuck(?![a-z])|(?<![a-z])shit(?![a-z])/g;
/** 当程度副词用的脏话：后面有冲着我们的话或抱怨才算（「这风景他妈的太美了」「tmd终于订到了」不算） */
const INTENSIFIER = /他妈的?|tmd|妈的|卧槽|我靠|尼玛|特么/;
/** 「有病」要冲着人（「你们有病吧」「你他妈是不是有病」；「老人有病能去吗」不算） */
const SICK = /(?:你|你们|客服|机器人|ai|系统)[^，]{0,5}有病/;
/** 什么破服务、这破玩意 */
const BROKEN = /破(?:服务|玩意儿?|系统|机器人|ai|客服|公司|平台|回复|回答|软件|app|东西)/;
/** 整个小句就是一个骂人的词（「垃圾」「滚吧你」「垃圾垃圾垃圾」「妈的」「有病吧」），前后只有你、给我、快、吧、啊这类 */
const STRONG_WHOLE =
  /^(?:你们?|给我|快|赶紧|真是)?(?:滚|(?:垃圾)+|废物|妈的|神经病|放屁|狗屁|有病)(?:吧|啊|呀|了|蛋|开|一边去?|远点|出去|你们?)*$/;
/** 「垃圾」「废物」冲着我们：前面是你们、很、好、超、这么、太、什么、这……，或后面接着公司、客服、AI 这类 */
const TRASH = /垃圾|废物/g;
const TRASH_PREFIX =
  /(?:你们?(?:就是|真是?|太|是|这)?|真的?很?|很|好|超|挺|特别|非常|这么|那么|太|就是|简直|一群|一堆|一帮|什么|这(?:是|就是|也太|太|真是?|破|个)?)(?:个|群|堆|种|帮)?$/;
const TRASH_TARGET = /^(?:公司|平台|客服|服务|ai|机器人|系统|回复|回答|玩意儿?|东西|产品|旅行社)|^(?:一样|透了|死了|至极)/;
/** 「垃圾」「废物」说的是东西本身：垃圾分类、垃圾食品、废物利用 */
const NOT_TRASH_TALK =
  /(?:垃圾|废物)(?:分类|桶|袋|食品|处理|回收|站|车|场|短信|广告|邮件|篓|堆|费|利用)|(?:扔|倒|捡|丢|带|收拾|清理|分)(?:垃圾|废物)/;
/** 骂人的词后面接着东西：白痴问题、白痴操作 */
const INSULT_OBJECT = /^的?(?:问题|操作|设计|游戏|食品)/;
/** 自嘲：我真是个智障、我脑残了 */
const SELF_BEFORE = /(?:我|自己)(?:真的?|也|就|简直|真是|都)?(?:是|成|变成|像)?(?:个|一个)?(?:大)?$/;
/** 整个小句除了骂人的词只剩这些：算「整个小句就是它」 */
const BARE_FILLER =
  /你们?|您|给我|快|赶紧|真是?的?|简直|就是|真的|很|好|超|挺|特别|非常|这么|那么|太|个|一群|一堆|一帮|这|那|什么|吧|啊|呀|呢|吗|了|啦|哈|嘛|蛋|开|一样|透了|死了|至极|玩意儿?|东西|都|全|是|他妈的?|tmd|妈的/g;

/** 弱：失望、无语、太差了、坑人、离谱、敷衍这一类 */
const WEAK =
  /失望|无语|(?:太|很|真|好|特别|非常|超|贼)差|差劲|差到|烂透|(?:太|好|真|很)烂|(?<![天地水矿土泥大])坑(?:人|爹|钱|我|死)|(?:被|太|好|真|很)坑|黑店|宰客|割韭菜|智商税|离谱|敷衍|烦死了|(?:好|真|很)烦|(?<!麻)烦人|心烦|气死我|气死了|(?<![名人])气人|(?<![篝灯烟野炉柴])火大(?!会)|恼火|(?:很|太|真)生气|生气了|不耐烦|受够了|忍无可忍|(?:我|真|彻底|算是?)服了(?=$|你|吧|啊|呀|哈)|服了(?:你们|你|ai)|答非所问|听不懂人话|不懂人话|牛头不对马嘴|驴唇不对马嘴|鸡同鸭讲|白问了|(?:太|很|真)浪费时间|浪费我的?时间|一点用(?:都|也)没有|没屁用|毫无用处|不靠谱|不专业|慢死了|(?:回|回复|反应|处理)[^，]{0,3}太慢|不满意|不满(?![\d一二两三四五六七八九十]|足|月|岁|周)|(?:太|真|也太|很|好|有点|实在)过分|过分了|(?:太|很|真|好|特别|非常|超|挺)糟糕|糟糕透|(?:服务|态度|体验|质量|效率|回复)(?:也|都|太|很|真|好|这么|那么|特别|非常)?差|后悔/g;
/** 整个小句就是一个弱的词（「服了」） */
const WEAK_WHOLE = /^(?:我|真)?服了(?:吧|啊|呀|哈)*$/;
/** 说的是别家、以前的事：不是冲着我们 */
const OTHER_AGENCY = /别家|其他家|其它家|另一家|前一家|别的(?:旅行社|平台|公司)|其他(?:旅行社|平台|公司)|同行/;

/** 情绪一侧的否定：不、没、未（禁止式「别敷衍我」「不要太离谱」是在抱怨，不是否定；「别让我失望」是在盼着，算否定）。
 *  小句开头的「我不是说」「我不是嫌」管到整个小句 */
function sentimentNegated(t: string, at: number): boolean {
  const before = t.slice(0, at);
  if (/^(?:我|其实|倒|也|并)?(?:并不是|不是|并非|也不是)/.test(before)) return true;
  if (/(?:别|不要|不许|不准|不会)再?(?:让|叫|使)[^，]{0,4}$/.test(before)) return true;
  const w = foldAnotA(before)
    .replace(/不过|不然|不管|不论|不少|不错|不停|不断|不知道|不一定|不仅|不但|没想到/g, '')
    .replace(/不要|不许|不准|不能再|别/g, '')
    .slice(-4);
  return /[不没未]/.test(w);
}

function strongInClause(c: Clause, asking: boolean): boolean {
  const t = c.text;
  if (asking && DOUBT.test(t)) return false;
  const us = US.test(t);
  const ok = (at: number): boolean =>
    !hearsayBefore(c, at) && !pastBefore(c, at) && !sentimentNegated(t, at) && !SELF_BEFORE.test(t.slice(0, at));
  if (STRONG_WHOLE.test(t)) return true;
  for (const re of [STRONG_DIRECTED, SICK, BROKEN]) {
    const m = re.exec(t);
    if (m && ok(m.index)) return true;
  }
  const bare = t.replace(INSULT, '').replace(TRASH, '').replace(BARE_FILLER, '').trim() === '';
  for (const m of t.matchAll(INSULT)) {
    if (!ok(m.index) || INSULT_OBJECT.test(t.slice(m.index + m[0].length))) continue;
    if (us || bare) return true;
  }
  if (!NOT_TRASH_TALK.test(t)) {
    for (const m of t.matchAll(TRASH)) {
      const before = t.slice(0, m.index);
      const after = t.slice(m.index + m[0].length);
      if (!ok(m.index)) continue;
      if (bare || TRASH_TARGET.test(after)) return true;
      // 全是垃圾、都是垃圾：要冲着我们（「那边海滩全是垃圾」不算）
      if (/(?:全是|都是)$/.test(before)) {
        if (us) return true;
        continue;
      }
      if (TRASH_PREFIX.test(before) && (us || !OTHER.test(t))) return true;
    }
  }
  const im = INTENSIFIER.exec(t);
  return !!im && ok(im.index) && (us || new RegExp(WEAK.source).test(t));
}

interface SentimentCtx {
  /** 消息里说的是客户自己、家人、工作、天气、那边的景点 */
  other: boolean;
  motivation: boolean;
  joke: boolean;
}

function weakInClause(c: Clause, asking: boolean, ctx: SentimentCtx): boolean {
  const t = c.text;
  if (WEAK_WHOLE.test(t)) return !c.carried.hearsay && !c.carried.past;
  // 正反问里的「不靠谱」「不专业」不是在说不靠谱（「你们靠不靠谱」），先折掉
  const f = foldAnotA(t);
  const us = US.test(t);
  for (const m of f.matchAll(WEAK)) {
    const at = m.index;
    const before = f.slice(0, at);
    const after = f.slice(at + m[0].length);
    if (hearsayBefore({ ...c, text: f }, at) || pastBefore({ ...c, text: f }, at)) continue;
    if (asking && !RHETORICAL.test(t)) continue;
    // 售前疑虑：怕被坑、担心被坑；被坑过、被坑怕了
    if (WORRY_NEG.test(before) || /^.?(?:过|怕)/.test(after)) continue;
    if (POSITIVE.test(f) || sentimentNegated(f, at)) continue;
    // 「后悔」要冲着我们（「后悔找你们了」；「后悔没早点去」不算）
    if (m[0] === '后悔' && !us) continue;
    if (!us && (ctx.other || ctx.motivation || ctx.joke)) continue;
    return true;
  }
  return false;
}

function negativeInClause(c: Clause, ctx: SentimentCtx): 0 | 1 | 2 {
  const t = c.text;
  if (c.carried.hypo || COND.test(t) || OTHER_AGENCY.test(t)) return 0;
  const asking = isAsking(c);
  if (strongInClause(c, asking)) return 2;
  return weakInClause(c, asking, ctx) ? 1 : 0;
}

/** 负面情绪（开放问题 4：词表加规则）：0 无、1 弱、2 强 */
export function negativeLevel(text: string): 0 | 1 | 2 {
  const whole = normalize(text);
  const ctx: SentimentCtx = { other: OTHER.test(whole), motivation: MOTIVATION.test(whole), joke: JOKE.test(whole) };
  let level: 0 | 1 | 2 = 0;
  for (const c of clausesOf(text)) {
    const l = negativeInClause(c, ctx);
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

/**
 * 「撤回同意」「删除我的信息」「别保存我的资料」这类行权的话（R23）。按小句判；转述、假设、「不用删除」不算，问政策与做法的
 * 疑问（「你们会删除我的信息吗」「怎么撤回」）不算，礼貌的请求（「可以删除我的信息吗」）算。后一条与 spec 签名注释的
 * 「疑问与转述排除」不一致，待 owner 定（plan「Open」第 11 步审查带出的第 4 条）
 */
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
