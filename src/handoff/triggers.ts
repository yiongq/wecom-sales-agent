import type { EmergencyKind, EmergencyRule } from '../core/pack-api.js';
import { handoffVocab } from '../packs/travel/handoff-vocab.js';

const {
  TRAD,
  TRAD_RE,
  COND,
  HEARSAY,
  PAST,
  PAST_CUT,
  HEARSAY_CUT,
  NOW_LEAD,
  ASKING_TAIL,
  ASKING_WORDS,
  NOT_A_QUESTION,
  NEG_BEFORE,
  E_ALTITUDE_MARKER,
  E_ALTITUDE_OVERLAP,
  EMERGENCY_RULES,
  CARELESS,
  E_HYPO,
  E_PRETRIP,
  E_NEAR,
  E_HABIT,
  E_PRICE,
  E_JOKE,
  E_POLICY,
  E_HEARSAY,
  E_NEG_BEFORE,
  E_UNSURE,
  E_EXAGGERATE,
  E_AFTER_SKIP,
  E_ATTACHED,
  E_HAPPENED_BEFORE,
  E_FEVER,
  E_NOW,
  E_ONGOING,
  E_FALL_HURT,
  E_FALL_THING,
  E_VEHICLE_STUCK,
  E_WOUND,
  E_FINE_AFTER,
  E_TRAPPED_AT,
  E_TRAPPED_ABSTRACT,
  E_NOT_STUCK,
  E_ELSEWHERE,
  E_RESCUE_LEAD,
  E_HELP,
  E_IDENTITY,
  E_GREETING,
  E_UNKNOWN,
  E_ASKING,
  E_EVERY,
  E_ARRANGE,
  COMPANION_PHRASE,
  COMPANION_MARK,
  PARTY_MENTION,
  OTHER_MENTION,
  NOT_SUBJECT_LEAD,
  FAMILY_LEAD,
  THIRD_PARTY,
  ASK_TAIL,
  EMBEDDED,
  DEPENDS_LEAD,
  ASK_WORDS,
  EVERY_AFTER,
  EVERY_ANOTA_AFTER,
  NOT_ASKING_REST,
  US,
  OWNED_BY_US,
  OWNED_KIND,
  SELF,
  OTHERS,
  OBJECT_LEAD,
  OTHER_AGENCY,
  JOKE,
  DOUBT_WORD,
  STRONG_DIRECTED,
  INSULT,
  STUPID,
  INSULT_TARGET_AFTER,
  INSULT_OBJECT,
  BARE_FILLER,
  BARE_INSULT,
  BROKEN,
  INTENSIFIER,
  WEAK,
  SLOW_PACE,
  WEAK_US_BEFORE,
  WEAK_RHETORICAL,
  REPEAT_SAID,
  PEOPLE,
  WEAK_DIRECTED,
  POSITIVE_BEFORE,
  WORRY_BEFORE,
  SEG_ASKING,
  COMPLAINT_TAG,
  ONLY_US,
  HEALTH,
  PERSON,
  CHILD_AGE_AFTER,
  CHILD_AGE_BEFORE,
  SCHOOL,
  CHILD_RE,
  WITHDRAW,
  POLITE_ASK,
  POLICY_ASK,
  NOT_WANTED,
} = handoffVocab;

// 确定性转人工触发（docs/architecture/02-conversations-workbench/spec.md「确定性转人工触发」、R15、R23、开放问题 4）。
// 纯函数，配标注语料自测（src/handoff/triggers.corpus.ts 由 src/handoff/handoff.selftest.ts 逐条跑）：不 import store、engine、
// tools、llm、adapters、src/db/。改词表或规则时先往语料里补正反例，再改到语料全过（plan「实施记录 · 第 11 步」审查之后改的）。
// 精确优先（owner 2026-10-03）：紧急、情绪、在问都只在把握很大的说法上触发，宁可漏判、不能误判，拿不准的交给主模型
// （第 15 步 SOP 里那一句）；各节开头写了高把握的形状。
//
// 共同的读法：按小句判。一句话（。！？换行分号之间）再按逗号、顿号、空格等切成小句，一个小句命中就算。
// 不算的：出行前的提问与假设（「去西藏会不会高反」「万一护照丢了怎么办」）、否定（「没有高反」「护照没丢」）、
// 转述别人或以前的经历与评价（「听说高反挺吓人的」「朋友说你们很坑」「上次骨折过」）。
// 假设、转述、以前这三类在同一句话里往后带（「如果到了拉萨，高反了怎么办」后半句也是假设）；「这次、今天、结果、但是」这类
// 说法打断以前（「去年来过没高反，今天高反了」后半句算），「结果、但是、没想到」打断转述。
// 词表不按子串收宽泛的词（「找不到」「跑了」「骗人」「不行」）：证件要和丢失连在一起，走失要有人，情绪要冲着我们。

export type { EmergencyKind } from '../core/pack-api.js';
export type SensitiveCategory = 'health' | 'minor';

/** 一轮的交互失败信号（R15）。guardHit 有值时整轮不算失败 */
export interface TurnSignals {
  /** 模型没给出可用文本，落到兜底话术（engine.ts 里空回复那一处） */
  emptyModelReply: boolean;
  /** 本轮 search_routes 什么也没返回，且不是 destinationMiss */
  noRetrievalResult: boolean;
  /**
   * 这句是高把握的问句（问号、句末吗/么、正反问、明确问法；句末呢、陈述里内嵌的疑问词与任指不算，见 isQuestion），
   * 且与前 2 条客户消息之一重复（去标点空白后相同，或字二元组 Jaccard ≥ 0.8，长度 ≥ 4 字）；重复回答、重复确认不算（owner 2026-10-03）
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
const BOUNDARY = /((?:[，,、：:～~…\s—–\-－·•()（）【】[\]「」『』《》<>"“”'‘’/|。！!？?；;]|(?<!\d)\.|\.(?!\d))+)/;
const SENTENCE_END = /[。.！!？?；;\n]/;
const QUESTION_MARK = /[？?]/;

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
const isAsking = (c: Clause): boolean => c.asked || ASKING_TAIL.test(c.text) || ASKING_WORDS.test(c.text.replace(NOT_A_QUESTION, ' '));
const foldAnotA = (s: string): string => s.replace(/(?![不没])(\p{Script=Han})[不没]\1/gu, '$1$1');
const negatedBefore = (clause: string, at: number): boolean => NEG_BEFORE.test(foldAnotA(clause.slice(0, at)).slice(-4));
const askingNotHelp = (c: Clause): boolean => {
  const t = c.text;
  const asking = (c.asked || E_ASKING.test(t)) && !E_EVERY.test(t);
  if (!asking || E_IDENTITY.test(t) || E_GREETING.test(t) || E_UNKNOWN.test(t)) return false;
  return !E_HELP.test(t) || E_ARRANGE.test(t);
};

/** 关键词前面（同一句话里）最近点到的人是不是客户这边的：'party' | 'other' | null（没点到人） */
function lastPerson(before: string): 'party' | 'other' | null {
  const t = before.replace(COMPANION_PHRASE, COMPANION_MARK);
  let best: { at: number; who: 'party' | 'other' } | null = null;
  for (const [re, who] of [
    [PARTY_MENTION, 'party'],
    [OTHER_MENTION, 'other'],
  ] as const) {
    for (const m of t.matchAll(re)) {
      if (NOT_SUBJECT_LEAD.test(t.slice(0, m.index))) continue;
      const end = m.index + m[0].length;
      if (!best || end > best.at || (end === best.at && who === 'other')) best = { at: end, who };
    }
  }
  return best?.who ?? null;
}

/** 俚语：骨折价、打骨折、日期撞车 */
function slangOf(k: string, before: string, after: string, t: string): boolean {
  if (k === '骨折' && (/打(?:个|了|了个)?$/.test(before) || /^(?:价|促销|优惠|甩卖|大促|级)/.test(after))) return true;
  return k === '撞车' && /日期|日程|时间|行程|档期|安排|活动|计划|会议|航班|假期|节日/.test(t);
}

/** 同一句话：前面小句的原文、整句的原文、有没有此刻标记 */
interface SentenceCtx {
  before: string;
  text: string;
  now: boolean;
}

/** 关键词这一处是不是高把握的说法（见本节开头的 1、2、5 条与小句里的排除） */
function emergencyAt(rule: EmergencyRule, m: RegExpMatchArray, c: Clause, sentence: SentenceCtx): boolean {
  const t = c.text;
  const at = m.index ?? 0;
  const k = m[0];
  const before = t.slice(0, at);
  const after = t.slice(at + k.length);
  if (slangOf(k, before, after, t)) return false;
  // 摔了一跤、跌倒：要说了后果、摔的不是东西；车船坏了要困住了；流了好多血要说了伤在哪儿
  if (rule.fall && (!E_FALL_HURT.test(sentence.text) || E_FALL_THING.test(before))) return false;
  if (rule.vehicle && !E_VEHICLE_STUCK.test(sentence.text)) return false;
  if (rule.bleeding && !E_WOUND.test(sentence.text)) return false;
  if (E_NEG_BEFORE.test(before) || (m.groups?.between && /[没不未别无]/.test(m.groups.between))) return false;
  // 叫救护车：前面是求救就算（帮我叫救护车、快叫救护车），不然照常要有人、已经打了
  if (rule.ambulance && E_RESCUE_LEAD.test(before)) return true;
  if (E_EXAGGERATE.test(before) || E_UNSURE.test(before) || E_AFTER_SKIP.test(after) || pastBefore(c, at)) return false;
  // 已经发生或正在发生
  const attached = k.includes('了') || E_ATTACHED.test(after) || E_HAPPENED_BEFORE.test(before);
  let realized = attached || sentence.now || !!rule.ongoing || E_FEVER.test(k + after);
  if (rule.trapped) {
    if (E_TRAPPED_ABSTRACT.test(t) || E_NOT_STUCK.test(t)) return false;
    realized ||= E_TRAPPED_AT.test(after) || k.endsWith('在') || after.startsWith('在');
  }
  if (/^被[^，]{0,4}?(?:扔|丢|甩|落)在/.test(k)) realized = true;
  if (!realized) return false;
  // 关键词里带着人：「把我们扔下了」「找不到我女儿了」就是客户这边；「孩子丢了」要看前面是不是「有个」「隔壁桌的」这类旁观
  if (rule.withParty) return !FAMILY_LEAD.test(k) || lastPerson(`${sentence.before}，${before}${k}`) !== 'other';
  if (rule.disaster) return !E_ELSEWHERE.test(before) && lastPerson(before) === 'party';
  return lastPerson(`${sentence.before}，${before}`) === 'party';
}

/** 客户本人或同行的人此刻正处在危险或困境里：高反、受伤、急病、证件丢失、被困走失。精确优先：只认把握很大的说法
 *  （主语是客户本人、家人或明确的同行，已经发生或正在发生，不是在问、不是出行前、假设、转述、差点、价钱与玩笑），拿不准就不判，
 *  交给主模型（第 15 步 SOP 那一句）。出行前的提问（「会不会高反」「高反怎么办」）、假设、否定、转述别人以前的经历都不算 */
export function emergencyOf(text: string): EmergencyKind | null {
  if (E_JOKE.test(text)) return null;
  const cleaned = text.replace(CARELESS, '');
  const whole = normalize(cleaned);
  for (const re of [E_HYPO, E_PRETRIP, E_NEAR, E_HABIT, E_PRICE, E_POLICY, E_HEARSAY]) if (re.test(whole)) return null;
  const clauses = clausesOf(cleaned);
  if (clauses.some(askingNotHelp)) return null;
  // 最后一个说没事、不要紧、不严重的小句：它前面的命中都不算（只看关键词后面的）
  const fineAt = clauses.findLastIndex((o) => !o.asked && E_FINE_AFTER.test(o.text));
  for (let i = 0; i < clauses.length; i += 1) {
    const c = clauses[i]!;
    if (c.carried.hypo || COND.test(c.text) || i < fineAt) continue;
    const same = clauses.filter((o) => o.sentence === c.sentence);
    const text = same.map((o) => o.text).join('，');
    const sentence: SentenceCtx = {
      before: same
        .filter((o) => clauses.indexOf(o) < i)
        .map((o) => o.text)
        .join('，'),
      text,
      now: E_NOW.test(text) || E_ONGOING.test(text),
    };
    for (const rule of EMERGENCY_RULES) {
      for (const m of c.text.matchAll(rule.re)) {
        if (emergencyAt(rule, m, c, sentence)) {
          if (rule.kind !== 'altitude' && E_ALTITUDE_OVERLAP.test(m[0]) && E_ALTITUDE_MARKER.test(text)) return 'altitude';
          return rule.kind;
        }
      }
    }
  }
  return null;
}

function clauseAsks(c: Clause): boolean {
  if (c.asked) return true;
  if (ASK_TAIL.test(c.text)) return true;
  const t = c.text.replace(NOT_ASKING_REST, ' ');
  for (const m of t.matchAll(ASK_WORDS)) {
    const word = m[0];
    const at = m.index;
    if (EMBEDDED.test(t.slice(0, at)) || DEPENDS_LEAD.test(t.slice(0, at))) continue;
    const after = t.slice(at + word.length);
    // 正反问的任指要接都行、都可以这类（「去不去都行」）；「是不是每天都要早起」还在问
    const aNotA = /[不没]/.test(word) && word.length >= 3;
    if (!word.startsWith('为') && (aNotA ? EVERY_ANOTA_AFTER : EVERY_AFTER).test(after)) continue;
    // 同一个疑问词说两遍：「想去哪就去哪」「你说多少就多少」「什么时候便宜什么时候去」
    // （按原文数：「想玩几天就玩几天」前一个几天被上面的「想……玩几」去掉了，也还是说了两遍）
    if (word.length <= 4 && (after.includes(word) || t.slice(0, at).includes(word) || c.text.split(word).length > 2)) continue;
    return true;
  }
  return false;
}

/** 这句客户消息是在问（高把握的问句）：有一个小句后面跟问号、以吗么结尾、是正反问，或带着明确的问法（不按子串收，见上） */
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
const isBareEdgeInsult = (w: string): boolean => {
  const rest = w.replace(BARE_INSULT, '').replace(BARE_FILLER, '');
  BARE_INSULT.lastIndex = 0;
  // 「你们就是骗子吧」带着问的语气，照单独成段的「你们是骗子吧」不算（打消疑虑）
  if (/骗子/.test(w) && /[吧吗么嘛]$/.test(w)) return false;
  return rest === '' && /傻|煞笔|sb|智障|脑残|弱智|白痴|蠢|笨蛋|人渣|畜生|贱人|狗东西|王八蛋|混蛋|神经病|废物|骗子/.test(w);
};

interface Segment {
  text: string;
  asked: boolean;
  carried: { hypo: boolean; hearsay: boolean; past: boolean; agency: boolean };
  /** 同一句话（。！？换行分号之间）：前面几段的原文、整句的原文 */
  before: string;
  sentence: string;
  /** 同一句话里下一段只是对象（「太失望了，你们」） */
  nextIsUs: boolean;
}

/** 按标点分段（不按空格），假设、转述、以前在同一句话里往后带（与小句同样的规则） */
function segmentsOf(text: string): Segment[] {
  const parts = normalize(text).split(/([，,、：:～~…。！!？?；;\n]+|(?<!\d)\.|\.(?!\d))/);
  const raws: { text: string; asked: boolean; carried: Segment['carried']; sentence: number }[] = [];
  const none = { hypo: false, hearsay: false, past: false, agency: false };
  let carried = { ...none };
  let sentence = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const raw = (parts[i] ?? '').replace(/\s+/g, ' ').trim();
    const boundary = parts[i + 1] ?? '';
    if (raw) {
      raws.push({ text: raw, asked: QUESTION_MARK.test(boundary), carried: { ...carried }, sentence });
      carried = {
        hypo: carried.hypo || COND.test(raw),
        hearsay: carriedAfter(raw, carried.hearsay, HEARSAY, hearsayCutAt(raw)),
        past: carriedAfter(raw, carried.past, PAST, lastIndexOf(PAST_CUT, raw)),
        agency: carried.agency || OTHER_AGENCY.test(raw),
      };
    }
    if (SENTENCE_END.test(boundary)) {
      carried = { ...none };
      sentence += 1;
    }
  }
  return raws.map((r, i) => {
    const same = raws.filter((o) => o.sentence === r.sentence);
    const next = raws[i + 1];
    return {
      text: r.text,
      asked: r.asked,
      carried: r.carried,
      before: same
        .slice(0, same.indexOf(r))
        .map((o) => o.text)
        .join('，'),
      sentence: same.map((o) => o.text).join('，'),
      nextIsUs: !!next && next.sentence === r.sentence && ONLY_US.test(next.text),
    };
  });
}

/** 这段话里点到了我们（你们、你、您、客服、机器人、AI、顾问……） */
function targetsUs(s: string): boolean {
  US.lastIndex = 0;
  const hit = US.test(s);
  US.lastIndex = 0;
  return hit;
}

/** 一段话里最近（last）或最早（first）点到的人：'us' | 'self' | 'other' | null。让、对、给后面的人不算（宾语） */
function targetIn(s: string, pick: 'last' | 'first'): 'us' | 'self' | 'other' | null {
  // 「你他妈」里的他不是别人
  const t = s.replace(new RegExp(INTENSIFIER.source, 'g'), (x) => ' '.repeat(x.length));
  let best: { at: number; who: 'us' | 'self' | 'other' } | null = null;
  for (const [re, who] of [
    [US, 'us'],
    [SELF, 'self'],
    [OTHERS, 'other'],
  ] as const) {
    for (const m of t.matchAll(re)) {
      const prefix = t.slice(0, m.index);
      if (who !== 'us' && OBJECT_LEAD.test(prefix)) continue;
      // 「携程的客服」「那家旅行社的客服」：别人的客服、回复不是我们
      const theirs =
        who === 'us' &&
        /^(?:客服|机器人|ai|顾问|小编|bot|回复|回答)$/.test(m[0]) &&
        prefix.endsWith('的') &&
        !/(?:你们|你|您|你家|贵司|这家)的$/.test(prefix);
      const at = pick === 'last' ? m.index + m[0].length : -m.index;
      // 「你们导游」「你们安排的酒店」：我们的人与东西
      const ours = who === 'other' && OWNED_KIND.test(m[0]) && OWNED_BY_US.test(prefix);
      const w = theirs ? 'other' : ours ? 'us' : who;
      if (!best || at > best.at || (at === best.at && w !== 'us')) best = { at, who: w };
    }
  }
  return best?.who ?? null;
}

/** 情绪一侧的否定：不、没、未（禁止式「别敷衍我」是抱怨；「别让我失望」「不会让您失望」是否定）；段首「我不是说」管到整段 */
function sentimentNegated(t: string, at: number): boolean {
  const before = t.slice(0, at);
  if (/^(?:我|其实|倒|也|并)?(?:并不是|不是|并非|也不是)/.test(before) || /以为|当成|当作/.test(before)) return true;
  if (/(?:别|不要|不许|不准|不会)再?(?:让|叫|使)[^，]{0,4}$/.test(before)) return true;
  const w = foldAnotA(before)
    .replace(/不过|不然|不管|不论|不少|不错|不停|不断|不知道|不一定|不仅|不但|没想到/g, '')
    .replace(/不要|不许|不准|不能再|别/g, '')
    .slice(-4);
  return /[不没未]/.test(w);
}

/** 这一处前面（本段里的，或同一句话里前面带过来的）有没有转述、以前、别家（「携程客服太差了」「我在别家报过，导游很敷衍」；
 *  别家在后面的照算：「你们这个价格也太坑了吧 别家便宜一千」） */
function heardOrPast(s: Pick<Segment, 'text' | 'asked' | 'carried'>, at: number): boolean {
  const c: Clause = { text: s.text, asked: s.asked, carried: s.carried, sentence: 0 };
  return !!hearsayBefore(c, at) || pastBefore(c, at) || s.carried.agency || OTHER_AGENCY.test(s.text.slice(0, at));
}

function strongInSegment(s: Segment, asking: boolean): boolean {
  const t = s.text;
  const ok = (at: number): boolean => !heardOrPast(s, at) && !sentimentNegated(t, at);
  const m = STRONG_DIRECTED.exec(t);
  // 「我想去死」「累得要去死」是在说自己
  if (m && ok(m.index) && !(m[0] === '去死' && /(?:我|自己)?(?:想|要|得)$/.test(t.slice(0, m.index)))) return true;
  // 单独成句：整段除了骂人的词只剩语气词与你、你们（滚另按空格分开认：「你们是骗子吧 滚」）
  const squashed = t.replace(/\s+/g, '');
  const bare = squashed.replace(BARE_INSULT, '').replace(BARE_FILLER, '') === '' && BARE_INSULT.test(squashed);
  BARE_INSULT.lastIndex = 0;
  if (bare && !(asking && /骗子/.test(t))) return !heardOrPast(s, 0);
  const words = t.split(' ');
  if (words.some((w) => /^滚+(?:吧|啊|蛋|开)?$/.test(w))) return true;
  // 段首、段尾按空格分开的骂人的词（「废物 连个价格都报不清楚」「蠢货 我早说了」）；垃圾、放屁另有本义，不按空格认
  if (words.length > 1 && [words[0]!, words.at(-1)!].some(isBareEdgeInsult) && !heardOrPast(s, 0)) return true;
  for (const x of t.matchAll(INSULT)) {
    const at = x.index;
    const after = t.slice(at + x[0].length);
    if (!ok(at) || INSULT_OBJECT.test(after)) continue;
    // 打消疑虑的问：「你们不会是骗子吧」「你们是骗子吗」
    if (asking && DOUBT_WORD.test(x[0])) continue;
    const who = targetIn(t.slice(0, at), 'last');
    if (who === 'us' || (who === null && INSULT_TARGET_AFTER.test(after))) return true;
    // 这一段没点到人：看同一句话里前面最近点到的人（「你们又搞错了，真是个白痴」；「我又搞错了，真是个白痴」是自嘲）
    if (who === null && s.before && targetIn(s.before, 'last') === 'us') return true;
  }
  // 冲着人的蠢、笨、傻：前面最近点到的是我们（「你好蠢」「你们的AI真的很蠢」「你是不是傻」；「我太蠢了」是自嘲）
  const st = STUPID.exec(t);
  if (st && ok(st.index) && targetIn(t.slice(0, st.index), 'last') === 'us') return true;
  // 什么破客服、这破 AI：后面就是我们
  const broken = BROKEN.exec(t);
  if (broken && ok(broken.index)) return true;
  // 程度副词一样的脏话：冲着我们（「你他妈能不能快点」「tmd你们到底会不会回复」）
  const im = INTENSIFIER.exec(t);
  return !!im && ok(im.index) && targetIn(t, 'last') === 'us';
}

function weakInSegment(s: Segment, asking: boolean): boolean {
  const t = s.text;
  // 本身就在说这次对话的：答非所问、说了多少遍（反问「你听不懂人话吗」照算）、别敷衍我
  for (const re of asking ? [WEAK_RHETORICAL] : [WEAK_RHETORICAL, WEAK_DIRECTED]) {
    const x = re.exec(t);
    if (!x || heardOrPast(s, x.index) || sentimentNegated(t, x.index) || targetIn(t.slice(0, x.index), 'last') === 'other') continue;
    // 「说了多少遍了」说的是家人或别人：同一句话里点到了家人、他她，又没点到我们（审查 blind-sentiment[4]）
    if (REPEAT_SAID.test(x[0]) && PEOPLE.test(s.sentence) && !targetsUs(s.sentence)) continue;
    return true;
  }
  if (asking) return false;
  // 正反问里的「不靠谱」「不专业」不是在说不靠谱（「你们靠不靠谱」），先折掉
  const f = foldAnotA(t);
  for (const m of f.matchAll(WEAK)) {
    const at = m.index;
    const before = f.slice(0, at);
    const after = f.slice(at + m[0].length);
    if (heardOrPast({ ...s, text: f }, at) || sentimentNegated(f, at)) continue;
    if (WORRY_BEFORE.test(before) || /^.?(?:过|怕)/.test(after) || POSITIVE_BEFORE.test(before)) continue;
    if (m[0].includes('慢') && SLOW_PACE.test(f)) continue;
    // 冲着我们：前面（说话的我不算）最近点到的是我们；或者前面没点到别人、后面最先点到的是我们（「后悔找你们了」「我真服了你们」），
    // 或者同一句话里下一段只是对象（「太失望了，你们」）
    const who = targetIn(before.replace(SELF, ''), 'last');
    if (who === 'us') return true;
    if (who === null && (targetIn(after.replace(SELF, ''), 'first') === 'us' || s.nextIsUs)) return true;
  }
  // 没听懂、不是一回事、等于没说：只认前面最近点到的是我们（「你根本没听懂我说什么」；「我没听懂你的意思」不算）
  for (const m of f.matchAll(WEAK_US_BEFORE)) {
    if (heardOrPast({ ...s, text: f }, m.index) || sentimentNegated(f, m.index)) continue;
    if (targetIn(f.slice(0, m.index).replace(SELF, ''), 'last') === 'us') return true;
  }
  return false;
}

/** 负面情绪（开放问题 4：词表加规则，精确优先）：0 无、1 弱、2 强。只认冲着我们的重话（见上） */
export function negativeLevel(text: string): 0 | 1 | 2 {
  if (JOKE.test(text)) return 0;
  let level: 0 | 1 | 2 = 0;
  for (const s of segmentsOf(text)) {
    if (s.carried.hypo || COND.test(s.text)) continue;
    const asking = (s.asked || SEG_ASKING.test(s.text)) && !COMPLAINT_TAG.test(s.text);
    if (strongInSegment(s, asking)) return 2;
    if (weakInSegment(s, asking)) level = 1;
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
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 「12」「十二」「三」「半」→ 数；认不出为 null */
function ageNumber(s: string): number | null {
  if (s === '半') return 0;
  if (/^\d{1,2}$/.test(s)) return Number(s);
  if (/^十[一二三四五六七八九]?$/.test(s)) return 10 + (CN_NUM[s[1] ?? ''] ?? 0);
  if (/^[一二两三四五六七八九]十[一二三四五六七八九]?$/.test(s)) return (CN_NUM[s[0]!] ?? 0) * 10 + (CN_NUM[s[2] ?? ''] ?? 0);
  return CN_NUM[s] ?? null;
}
const MINOR_AGE = 14;

/** 一个年龄（「8岁」「三岁」）：同一句话里提到了孩子时，不挨着「孩子」也算是孩子的年龄（「两个孩子，一个8岁一个12岁」） */
const BARE_AGE = /(\d{1,2}|[一二两三四五六七八九十]{1,3}|半)\s*(?:周岁|岁)/g;

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
