// 标点挤压的回退与间隔号（spec「标点与间距」，设计系统 §2.5、§5.19）。
// Chromium 靠全局的 text-spacing-trim: normal（brand.css）原生挤压连用的全角标点；不支持这个属性的浏览器
// （Firefox、Safari、老版本企业微信内置浏览器）由 cjk() 按 haltIndices 把要挤的字包进 .halt。
// 用在我们自己渲染文字的地方：页标题与状态句、渲染器的单元格与只读值、表单标签、帮助与错误、Alert、检查清单、审计句子、
// 保存条与发布条的摘要、弹窗与抽屉的标题和后果列表。
import type { ReactNode } from 'react';
import { haltIndices } from '../../src/shared/typography.js';

/** 不支持 text-spacing-trim 时为真，页面加载时测一次 */
export const needsTrimFallback: boolean =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && !CSS.supports('text-spacing-trim', 'normal');

/** Sep 在拼好的串里算作一个间隔号（U+00B7，由 Geist 画） */
const SEP_CHAR = '·';

/**
 * 间隔号：并列的几段信息之间用它隔开，两侧文字不打空格。画出来是一个 Geist 的「·」（左右外边距 6，颜色跟随文字），
 * 读屏不念它、念成「，」：「，」是后面那个空 span 的生成内容的替代文字（brand.css 的 .sep-sr），看不见、不占宽度。
 * 不用 position: absolute 的 sr-only：WebKit 的一行里有 absolute 的盒子时，整行的 text-autospace 都失效（第 1.3 步实测）
 */
export function Sep() {
  return (
    <>
      <span className="sep" aria-hidden="true">
        {SEP_CHAR}
      </span>
      <span className="sep-sr" />
    </>
  );
}

/**
 * 我们自己渲染的中文文字。text 是数组时，各段之间用 Sep 隔开，挤压在拼好的串上算（间隔号也算进去）。
 * 需要回退时，要挤的字包进 <span class="halt">；其余连续的文字留在同一个文本节点里，拆成逐字节点时 WebKit 的整句宽度会变
 * （plan 第 1.2 步的实测）。fallback 只给自测和样张页用，平时取浏览器的检测结果
 */
export function cjk(text: string | readonly string[], fallback: boolean = needsTrimFallback): ReactNode {
  const parts = typeof text === 'string' ? [text] : text;
  if (!fallback && typeof text === 'string') return text;
  const halt = fallback ? new Set(haltIndices(parts.join(SEP_CHAR))) : new Set<number>();
  const out: ReactNode[] = [];
  let pos = 0;
  parts.forEach((part, k) => {
    if (k > 0) {
      out.push(<Sep key={`sep-${pos}`} />);
      pos += 1;
    }
    // 一段连续的字：要么都挤（包一个 .halt），要么都不挤（一个文本节点）
    let run = '';
    let runHalt = false;
    let runStart = pos;
    const push = (): void => {
      if (!run) return;
      out.push(
        runHalt ? (
          <span key={`halt-${runStart}`} className="halt">
            {run}
          </span>
        ) : (
          run
        ),
      );
      run = '';
    };
    for (let i = 0; i < part.length; i += 1, pos += 1) {
      const h = halt.has(pos);
      if (h !== runHalt) {
        push();
        runHalt = h;
        runStart = pos;
      }
      run += part[i];
    }
    push();
  });
  return out;
}
