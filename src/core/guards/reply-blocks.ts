import type { GuardStep, ReplyBlocks, ReplyGuardContext, TurnBlocks, ShapePolicy } from '../pack-api.js';
import { trimDangling } from './text.js';
import { sentenceUnits } from '../parse/sentences.js';
import { replyCharCount, replyLineCount } from './shape.js';

const tokens = (text: string): string[] => [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]!);
const shape = (text: string) => ({ lines: replyLineCount(text), chars: replyCharCount(text) });

/** 只清掉无效占位符所在的句子；残缺标记同样不能到客户出口。 */
function dropTokens(text: string, valid: (name: string) => boolean): { text: string; dropped: number } {
  let dropped = 0;
  const kept = sentenceUnits(text).map(({ start, end }) => {
    const unit = text.slice(start, end);
    const names = tokens(unit);
    if (names.some((name) => !valid(name)) || /\{\{|\}\}/.test(unit.replace(/\{\{[^{}]+\}\}/g, ''))) {
      dropped++;
      // 只恢复本步骤连带删掉的有效标记；护栏随后删掉的标记仍不会补回。
      return names
        .filter(valid)
        .map((name) => `\n{{${name}}}\n`)
        .join('');
    }
    return unit;
  });
  return { text: kept.join('').trim(), dropped };
}

function placements(ctx: ReplyGuardContext, body: string) {
  const state = ctx.replyBlocks;
  const blocks = new Map<string, 'inline' | 'appended'>();
  if (!state) return { body, blocks };
  const cleaned = dropTokens(body, (name) => !!state.texts[name]).text;
  if (!ctx.turn.flags.blocksSuppressed) {
    for (const name of tokens(cleaned)) blocks.set(name, 'inline');
    for (const name of state.autoAppend) {
      if (state.texts[name] && !blocks.has(name) && !state.originalTokens.includes(name)) blocks.set(name, 'appended');
    }
  }
  return { body: cleaned, blocks };
}

/** 与实际放置共用决策，包含无数据、抑制和占位符随句删除的分支。 */
export function willPlaceReplyBlock(ctx: ReplyGuardContext, name: string, body = ctx.text): boolean {
  return placements(ctx, body).blocks.has(name);
}

/** 只裁正文；运费和包邮门槛等政策金额仍由原有护栏核对。 */
function withoutItemAmounts(body: string): string {
  return sentenceUnits(body)
    .map(({ start, end }) => body.slice(start, end))
    .filter((unit) => {
      if (/^\s*试算[:：]\s*$/.test(unit)) return false;
      const items = unit.replace(/(?:运费|包邮门槛)\s*(?:合计|总价|金额)?\s*(?:为|是)?\s*[:：]?\s*[¥￥]?\s*\d+(?:\.\d+)?\s*元?/g, '');
      return !/(?:单价|小计|合计|总价|金额)\s*(?:为|是)?\s*[:：]?\s*[¥￥]?\s*\d+(?:\.\d+)?/.test(items);
    })
    .join('');
}

function place(ctx: ReplyGuardContext, body: string, trace?: TurnBlocks): string {
  const state = ctx.replyBlocks;
  if (!state) return body;
  const selected = placements(ctx, body);
  const seen = new Set<string>();
  const ownsAmounts = selected.blocks.has('试算明细');
  let text = selected.body
    .split('\n')
    .map((line) => {
      const inline: string[] = [];
      // 先取出这一行的标记，再处理正文，块始终放在整行之后。
      let prose = line.replace(/\{\{([^{}]+)\}\}/g, (_token, name: string) => {
        if (selected.blocks.get(name) === 'inline' && !seen.has(name)) {
          seen.add(name);
          inline.push(name);
        }
        return '';
      });
      if (ownsAmounts) prose = withoutItemAmounts(prose);
      if (inline.length) {
        // 去掉标记后留下的价格引子没有可读内容；正常说明句照常保留。
        prose = sentenceUnits(prose)
          .map(({ start, end }) => prose.slice(start, end))
          .filter((unit) => !/(?:单价|小计|合计|总价|金额)\s*(?:为|是|[:：])?\s*(?:[，,、；;。／/（(]|$)/.test(unit))
          .join('');
      }
      if (ownsAmounts || inline.length) {
        const trimmed = trimDangling(prose);
        prose = /(?:[:：，,、]|为|单价|小计|合计|总价|金额)\s*$/.test(trimmed) ? '' : trimmed;
      }
      return [
        prose.trim(),
        ...inline.map((name) => {
          const value = state.texts[name]!;
          trace?.rendered.push({ name, placed: 'inline', rows: replyLineCount(value), trimmedRows: state.trimmedRows[name] ?? 0 });
          return value;
        }),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  for (const [name, placed] of selected.blocks) {
    if (placed !== 'appended') continue;
    const value = state.texts[name]!;
    text = [text.trim(), value].filter(Boolean).join('\n');
    trace?.rendered.push({ name, placed, rows: replyLineCount(value), trimmedRows: state.trimmedRows[name] ?? 0 });
  }
  return text.replace(/\n(?:[ \t]*\n)+/g, '\n').trim();
}

/** 护栏按展开后的文本算预算，但永远只改正文。 */
export function expandedReply(ctx: ReplyGuardContext, body = ctx.text): string {
  return place(ctx, body);
}

/** 渲染给正文至少留两行；字数保留至多 200 字供正文裁剪使用。 */
export function replyBlockBudget(ctx: ReplyGuardContext): { lines: number; chars: number } {
  const body = ctx.text.replace(/\{\{[^{}]*\}\}/g, '');
  const policy = (ctx.thresholds as { shape?: ShapePolicy }).shape;
  return { lines: (policy?.richMaxLines ?? 12) - 2, chars: (policy?.maxChars ?? 600) - Math.min(200, replyCharCount(body)) };
}

export function replyBlockSteps(blocks: ReplyBlocks): GuardStep<ReplyGuardContext>[] {
  return [
    {
      id: 'reply_blocks:render',
      after: ['stage_advance'],
      run(ctx) {
        // 放在 context 而非 flags：这是数据，不是跨步骤控制旗标。
        ctx.replyBlocks = {
          texts: {},
          originalTokens: tokens(ctx.raw),
          autoAppend: blocks.autoAppend,
          trimmedRows: {},
          trace: { rendered: [], suppressed: false, droppedTokens: 0, bareItemAmounts: 0, finalShape: shape('') },
        };
        const values = blocks.render(ctx);
        ctx.replyBlocks.texts = Object.assign(
          Object.create(null) as Record<string, string | null>,
          Object.fromEntries(blocks.names.map((name) => [name, Object.hasOwn(values, name) ? (values[name] ?? null) : null])),
        );
        const cleaned = dropTokens(ctx.text, (name) => !!ctx.replyBlocks!.texts[name]);
        ctx.replyBlocks.trace.droppedTokens += cleaned.dropped;
        if (cleaned.text === ctx.text) return { action: 'pass' };
        return { action: 'strip', text: cleaned.text };
      },
    },
    {
      id: 'reply_blocks:place',
      after: ['rfq_trim', 'reply_blocks:render'],
      reads: ['blocksSuppressed'],
      run(ctx) {
        const trace = ctx.replyBlocks!.trace;
        trace.suppressed = !!ctx.turn.flags.blocksSuppressed;
        const cleaned = dropTokens(ctx.text, (name) => !!ctx.replyBlocks!.texts[name]);
        trace.droppedTokens += cleaned.dropped;
        // 只统计商品金额，政策运费常数不记为商品金额。
        trace.bareItemAmounts = [
          ...ctx.text.matchAll(/(?:单价|小计|合计|应付(?:金额)?|总价|金额)\s*[:：]?\s*[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元)?/g),
        ].length;
        const text = place(ctx, ctx.text, trace);
        trace.finalShape = shape(text);
        return text === ctx.text ? { action: 'pass' } : { action: 'replace', text };
      },
    },
  ];
}

/** turn_failure 和 final_clean 仍可能整段换话术；记录最终真正写入消息的形状。 */
export function finalizeReplyBlocks(ctx: ReplyGuardContext): void {
  if (!ctx.replyBlocks) return;
  const trace = ctx.replyBlocks.trace;
  trace.suppressed = !!ctx.turn.flags.blocksSuppressed;
  if (trace.suppressed) trace.rendered = [];
  trace.finalShape = shape(ctx.text);
  if (ctx.turn.flags.replyShape) {
    Object.assign(ctx.turn.flags.replyShape, trace.finalShape, {
      overLimit:
        trace.finalShape.lines > ctx.turn.flags.replyShape.limit ||
        trace.finalShape.chars > ((ctx.thresholds as { shape?: ShapePolicy }).shape?.maxChars ?? 600),
    });
  }
}
