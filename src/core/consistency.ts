// 06 R21：话术、工具提示、代码模板之间的一致性检查。本文件只放通用的类型和纯函数，不认识任何行业：
// 包登记文字和规则（PackRuntime 的 fixedReplies / consistencyRules），具体的词和判断由包提供。
import { replyLineCount } from './guards/shape.js';

/** 四类文字：对客固定文字、工具结果里的提示、出口词表、渲染后的 SOP */
export type ConsistencyGroup = 'fixed' | 'tool-note' | 'wordlist' | 'sop';

/**
 * 对客固定文字的三种渲染（06「原则」）：
 *   legacy   旧版模式、企微（顾问会在微信上联系您）
 *   web      网页渠道、品牌模板（顾问会在这个页面里回复您）
 *   template 模板模式、非网页（顾问会联系您，不点名渠道）
 */
export type FixedReplyMode = 'legacy' | 'web' | 'template';
export const FIXED_REPLY_MODES: readonly FixedReplyMode[] = Object.freeze(['legacy', 'web', 'template'] as const);

export interface FixedReplySample {
  mode: FixedReplyMode;
  text: string;
}

/**
 * 一条固定文字由谁产出，决定它之后还要穿过哪些护栏：
 *   { pipeline, step }  由该管线的这个步骤产出（step 为 null 表示管线开始之前就有了），只穿过它之后的步骤
 *   { outside }         不经出口护栏，必须写明原因
 * 步骤 id 必须在真实管线里（packPipelines 的步骤表），自测核；顺序也取自那张表，这里不手写第二套。
 */
export type FixedReplyOrigin = { pipeline: string; step: string | null } | { outside: string };

/** 包登记的一条对客固定文字：id 加样例。样例每次现渲染，不在装载时读任何东西 */
export interface FixedReply {
  /** 稳定的点号分隔名，如 handoff.request */
  id: string;
  /** 出处：仓库内文件路径 */
  source: string;
  /** 它那一类的行数上限按这个取：rich 是推荐、报价、订单类，plain 是普通类（与 ShapePolicy 同一口径） */
  kind: 'rich' | 'plain';
  /** 转人工之后也会发出（只在转人工后才生效的护栏要核它） */
  afterHandoff?: boolean;
  /** 由哪个步骤产出，或不经出口护栏 */
  producedBy: FixedReplyOrigin;
  samples(): readonly FixedReplySample[] | Promise<readonly FixedReplySample[]>;
}

/** 包登记的一条规则。a、b 是冲突的两方，scope 是它查哪几类文字，why 是为什么这两样不能同时存在 */
export interface ConsistencyRule {
  id: string;
  a: string;
  b: string;
  scope: readonly ConsistencyGroup[];
  why: string;
}

/**
 * 一处冲突。a、b 点名双方（文字 id 或 SOP 位置），where 是豁免、待裁决用的位置键。
 * 失败信息一律由 formatConflict 生成，保证带规则 id 和双方。
 */
export interface ConsistencyConflict {
  rule: string;
  a: string;
  b: string;
  detail: string;
  where: string;
  /** 命中的那句原文（契约检查用它在正文里定位）；不是每条规则都有 */
  match?: string;
}

/** 有期限的白名单和待裁决清单的一项：同一规则同一位置 */
export interface ConsistencyException {
  rule: string;
  where: string;
  note: string;
}

export function formatConflict(c: ConsistencyConflict): string {
  return `[${c.rule}] ${c.a}  <->  ${c.b}：${c.detail}`;
}

export interface ResolvedConflicts {
  /** 不在白名单也不在待裁决里：自测要失败 */
  failing: ConsistencyConflict[];
  exempted: ConsistencyConflict[];
  pending: ConsistencyConflict[];
  /** 白名单、待裁决里没有命中任何冲突的项：过期了，要删 */
  unusedExemptions: ConsistencyException[];
  unusedPending: ConsistencyException[];
}

const sameSpot = (e: ConsistencyException, c: ConsistencyConflict): boolean => e.rule === c.rule && e.where === c.where;

export function resolveConflicts(
  conflicts: readonly ConsistencyConflict[],
  exemptions: readonly ConsistencyException[],
  pending: readonly ConsistencyException[] = [],
): ResolvedConflicts {
  const failing: ConsistencyConflict[] = [];
  const exempted: ConsistencyConflict[] = [];
  const pendingHits: ConsistencyConflict[] = [];
  for (const c of conflicts) {
    if (exemptions.some((e) => sameSpot(e, c))) exempted.push(c);
    else if (pending.some((e) => sameSpot(e, c))) pendingHits.push(c);
    else failing.push(c);
  }
  return {
    failing,
    exempted,
    pending: pendingHits,
    unusedExemptions: exemptions.filter((e) => !conflicts.some((c) => sameSpot(e, c))),
    unusedPending: pending.filter((e) => !conflicts.some((c) => sameSpot(e, c))),
  };
}

/** 一段待查的文字：where 是位置键，id 是给人看的名字 */
export interface ConsistencyText {
  id: string;
  where: string;
  text: string;
  /** 固定文字的哪一种渲染；别的文字没有 */
  mode?: FixedReplyMode;
  /** 固定文字由谁产出；没有就当作管线开始前就有，每道变换都要穿过 */
  origin?: FixedReplyOrigin;
}

/**
 * 同一条里出现两样不能共存的说法（quote-final 的主体）。
 * hedge 命中就是冲突；同一段文字里也有 definite 时点名那一处，没有就点名 counterpart（代码里说确定价的那条模板）。
 */
export function hedgeConflicts(input: {
  rule: string;
  texts: readonly ConsistencyText[];
  hedge: RegExp;
  definite: RegExp;
  counterpart: string;
}): ConsistencyConflict[] {
  const out: ConsistencyConflict[] = [];
  for (const t of input.texts) {
    const hit = new RegExp(input.hedge.source, input.hedge.flags.replace('g', '')).exec(t.text);
    if (!hit) continue;
    const same = new RegExp(input.definite.source, input.definite.flags.replace('g', '')).exec(t.text);
    out.push({
      rule: input.rule,
      a: t.id,
      b: same ? `${t.id} 里的确定价说法「${same[0]}」` : input.counterpart,
      detail: `出现了「${hit[0]}」，而这里说的价是确定价`,
      where: t.where,
      match: hit[0],
    });
  }
  return out;
}

/** 一道把文字变成文字的变换：出口词表或纯文字护栏 */
export interface TextTransform {
  id: string;
  /** 这道变换在各条管线里是哪个步骤（管线名 → 步骤 id）；没写的管线里没有它。没有 steps 的变换对每条文字都跑 */
  steps?: Readonly<Record<string, string>>;
  /** item 带着这段文字的渲染模式（固定文字才有），模式相关的变换（联系方式的说法）按它走 */
  run(text: string, item: ConsistencyText & { afterHandoff: boolean }): string | Promise<string>;
  /** 不填就对每条文字都跑 */
  applies?(item: ConsistencyText & { afterHandoff: boolean }): boolean;
}

/** 各条管线的真实步骤顺序：管线名 → 步骤 id（取自 packPipelines，不手写） */
export type PipelineOrder = Readonly<Record<string, readonly string[]>>;

/** 这条文字要不要穿过这道变换：按产出步骤在真实管线里的位置，只穿过它之后的步骤 */
function reaches(item: ConsistencyText, tr: TextTransform, order: PipelineOrder | undefined): boolean {
  const origin = item.origin;
  if (!origin || !tr.steps || !order) return true;
  if ('outside' in origin) return false;
  const at = tr.steps[origin.pipeline];
  const steps = order[origin.pipeline];
  if (at === undefined || !steps) return false;
  const guardIdx = steps.indexOf(at);
  const originIdx = origin.step === null ? -1 : steps.indexOf(origin.step);
  return guardIdx > originIdx && guardIdx >= 0 && (origin.step === null || originIdx >= 0);
}

/** 声明的步骤不在真实管线里，或变换的步骤 id 写错了：返回问题清单（自测要求为空） */
export function originProblems(input: {
  items: readonly ConsistencyText[];
  transforms: readonly TextTransform[];
  order: PipelineOrder;
}): string[] {
  const out = new Set<string>();
  for (const item of input.items) {
    const o = item.origin;
    if (!o) continue;
    if ('outside' in o) {
      if (!o.outside.trim()) out.add(`${item.id}：不经出口护栏却没写原因`);
      continue;
    }
    const steps = input.order[o.pipeline];
    if (!steps) out.add(`${item.id}：管线「${o.pipeline}」不存在`);
    else if (o.step !== null && !steps.includes(o.step)) out.add(`${item.id}：步骤「${o.step}」不在管线「${o.pipeline}」里`);
  }
  for (const tr of input.transforms) {
    for (const [pipeline, step] of Object.entries(tr.steps ?? {})) {
      if (!input.order[pipeline]?.includes(step)) out.add(`${tr.id}：步骤「${step}」不在管线「${pipeline}」里`);
    }
  }
  return [...out];
}

/** 每条文字穿过每道变换后必须不变（sop-vs-wordlist、fixed-vs-guards 的主体） */
export async function passThroughConflicts(input: {
  rule: string;
  items: readonly (ConsistencyText & { afterHandoff?: boolean })[];
  transforms: readonly TextTransform[];
  /** 给了就按真实管线位置过滤：固定文字只穿过产出它的步骤之后的变换 */
  order?: PipelineOrder;
}): Promise<ConsistencyConflict[]> {
  const out: ConsistencyConflict[] = [];
  for (const item of input.items) {
    const full = { ...item, afterHandoff: !!item.afterHandoff };
    for (const tr of input.transforms) {
      if (!reaches(item, tr, input.order)) continue;
      if (tr.applies && !tr.applies(full)) continue;
      const after = await tr.run(item.text, full);
      if (after !== item.text) {
        out.push({
          rule: input.rule,
          a: item.id,
          b: tr.id,
          detail: `穿过后变了：「${brief(item.text)}」→「${brief(after)}」`,
          // 位置键带上是哪道变换：待裁决只放过这一对，同一条文字将来撞上别的护栏照样失败
          where: `${item.where}|${tr.id}`,
        });
      }
    }
  }
  return out;
}

/** 固定文字不超过它那一类的行数上限 */
export function lineCapConflicts(input: {
  rule: string;
  items: readonly (ConsistencyText & { kind: 'rich' | 'plain' })[];
  caps: { rich: number; plain: number };
}): ConsistencyConflict[] {
  const out: ConsistencyConflict[] = [];
  for (const item of input.items) {
    const cap = input.caps[item.kind];
    const lines = replyLineCount(item.text);
    if (lines > cap) {
      out.push({
        rule: input.rule,
        a: item.id,
        b: `line-cap:${item.kind}=${cap}`,
        detail: `${lines} 行，超过${item.kind === 'rich' ? '推荐 / 报价类' : '普通类'}上限 ${cap} 行`,
        where: `${item.where}|line-cap`,
      });
    }
  }
  return out;
}

function brief(text: string): string {
  const t = text.replace(/\n/g, '\\n');
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}
