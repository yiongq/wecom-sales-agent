// 06 R10：出口形状检查。步骤体由第 9 步填；本步只登记位置，并提供行数、字数的统一数法。
import type { ReplyGuardContext } from '../pack-api.js';
import { stripMarkdown } from './text.js';
import { replyStep } from './reply-step.js';

/** 行数：先去 markdown，再数非空行；「·」开头的每一项各占一行，所以与普通行同样计数。 */
export function replyLineCount(text: string): number {
  return stripMarkdown(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '').length;
}

/** 字数：先去 markdown，不计空白字符（空格、换行、制表），按码点计。 */
export function replyCharCount(text: string): number {
  return [...stripMarkdown(text).replace(/\s/g, '')].length;
}

/** 核心步骤 `shape_check`：默认排在 identity 之后、takeover_check:post 之前（装载校验守着）。第 1 步不改文本。 */
export function shapeCheckStep<Context extends ReplyGuardContext>() {
  return replyStep<Context>('shape_check', 'identity', [], [], () => {});
}
