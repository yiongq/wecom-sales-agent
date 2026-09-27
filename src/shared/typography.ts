// 连用全角标点的挤压回退（docs/features/console-ux/spec.md「标点与间距」，设计系统 §2.5）。
// Chromium 靠 `text-spacing-trim: normal` 加 Noto Sans SC 的 `halt` 原生挤压；Firefox、Safari 和老版本企业微信内置浏览器
// 不支持这个属性，由 console 的 cjk() 与话术编辑器按这里算出的下标，把要挤的字包进 `.halt`（font-feature-settings: 'halt'）。
// 规则与 Chromium 153 逐对核对过：typography.selftest.ts 里的 24×24 = 576 对和几句真实文案，是在 Chromium 上逐字量出来的。

/** 字身在右、左边空半字的开标点 */
const OPEN = '（［｛〔〈《「『【〖“‘';
/** 字身在左、右边空半字的收标点（简体的 ，。、：； 也靠左） */
const CLOSE = '）］｝〕〉》」』】〗，。、：；”’';
/** 间隔号：U+00B7 由 Geist 画，仍按间隔号算 */
const MID = '·・';

/**
 * 要加 `halt` 的字在 s 里的下标（UTF-16 码元，升序、不重复）。
 * 收标点后面紧跟开、收标点或间隔号时，挤前面那个收标点的右半；开标点或间隔号后面紧跟开标点时，挤后面那个开标点的左半。
 * 单独出现的标点不挤，「！？」不参与（Chromium 也不挤它们）。
 * 字符串要先拼好再算：用 Sep 画成单独元素的间隔号也要算进去。
 */
export function haltIndices(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i];
    const b = s[i + 1];
    // 开、收两组不相交，两个分支不会落到同一个下标，结果天然升序、不重复
    if (CLOSE.includes(a) && (OPEN.includes(b) || CLOSE.includes(b) || MID.includes(b))) out.push(i);
    else if ((OPEN.includes(a) || MID.includes(a)) && OPEN.includes(b)) out.push(i + 1);
  }
  return out;
}
