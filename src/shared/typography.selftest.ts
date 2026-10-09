// haltIndices 的自测（docs/features/console-ux/spec.md「标点与间距」，设计系统 §2.2、§2.5）。挂在 `pnpm test` 里。
// 用法：pnpm exec tsx src/shared/typography.selftest.ts
//
// 期望值不是照着实现抄的，是在 Chromium 153（Playwright 1.63 自带）上逐字量出来的：「字{前}{后}字」写成 20px 的
// Noto Sans SC（生产的 UI 优先片与完整的源字体各量一遍，结果相同），在 `text-spacing-trim: normal` 下用 Range 量每个字的宽度，
// 比 `space-all` 窄了半个字的就是被挤的字。前 24 个字是设计系统 §2.2 核对过的 24×24 = 576 对，后 9 个是 haltIndices 里另有的
// 开收标点，一共 33×33 = 1,089 对。同一批字符串整串的宽度，Chromium 原生挤压与包上 .halt 的回退 0 处不同；回退在 Firefox 155、
// WebKit 26.6 上与 Chromium 原生相差不超过 0.04px（plan 第 1.3 步的实施记录）。
//
// 只有一类对子，Chromium 把挤压算在另一个字上：收标点后面紧跟开标点（如「）（」），Chromium 挤开标点的左半，回退挤收标点的右半。
// 两个字形的墨迹位置和整串宽度都相同；换行正好断在两字之间时，回退留在行首的开标点仍是全宽，与 normal「行首的开括号不挤」一致。
// 下面按这一条把量到的位置换成回退该加 halt 的位置；哪些字是开、收标点也从表里读，不照抄实现里的字表。
//
// src/shared/ 只许 import src/shared/（scripts/check-boundaries.ts），所以不用 node:assert。
import { haltIndices } from './typography.js';

const CHARS = [...'（）「」『』【】《》〈〉，。、：；！？·“”‘’［］｛｝〔〕〖〗・'];

/** 行是前一个字、列是后一个字，顺序同 CHARS。「.」不挤；「a」挤前一个字；「b」挤后一个字 */
const CHROMIUM = [
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // （
  'babababababaaaaaa..ababababababaa', // ）
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // 「
  'babababababaaaaaa..ababababababaa', // 」
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // 『
  'babababababaaaaaa..ababababababaa', // 』
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // 【
  'babababababaaaaaa..ababababababaa', // 】
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // 《
  'babababababaaaaaa..ababababababaa', // 》
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // 〈
  'babababababaaaaaa..ababababababaa', // 〉
  'babababababaaaaaa..ababababababaa', // ，
  'babababababaaaaaa..ababababababaa', // 。
  'babababababaaaaaa..ababababababaa', // 、
  'babababababaaaaaa..ababababababaa', // ：
  'babababababaaaaaa..ababababababaa', // ；
  '.................................', // ！
  '.................................', // ？
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // ·
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // “
  'babababababaaaaaa..ababababababaa', // ”
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // ‘
  'babababababaaaaaa..ababababababaa', // ’
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // ［
  'babababababaaaaaa..ababababababaa', // ］
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // ｛
  'babababababaaaaaa..ababababababaa', // ｝
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // 〔
  'babababababaaaaaa..ababababababaa', // 〕
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // 〖
  'babababababaaaaaa..ababababababaa', // 〗
  'b.b.b.b.b.b.........b.b.b.b.b.b..', // ・
];

/** 真实文案：Chromium 上逐字量到的被挤位置（UTF-16 下标） */
const SENTENCES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['客户答「可以」「好」，（「不用倒时差」「想找个安静的地方」）', [7, 9, 11, 12, 19, 28]],
  ['改了2节（话术原则、异议处理）·有1个问题要改', [14]],
  ['问法有歧义：「可以/好的」，', [6, 12]],
  ['上架「贵州 小七孔·西江千户苗寨 5 日」', []],
  ['旅程（D1）：「成都→丹巴」。', [5, 7, 13]],
  ['客户答「可以」「好」，你还得再问一遍', [7, 9]],
  ['（「不用倒时差、带娃能玩水」「想找个安静的地方过纪念日」）', [1, 14, 27]],
  ['字体：Geist、Geist Mono（Vercel），思源黑体Noto Sans SC（Adobe、Google）。都按SIL Open Font License 1.1使用。', [26, 57]],
  ['最后一天可以写「—（返程）」', [12]],
  ['客户只会答「可以」……', []],
];

/** 收标点：跟在它后面的字里，有被 Chromium 挤掉自己右半的（表里这一行出现过「a」） */
const closes = (c: string): boolean => CHROMIUM[CHARS.indexOf(c)]?.includes('a') ?? false;
/** 开标点：Chromium 挤过它的左半（表里这一列出现过「b」） */
const opens = (c: string): boolean => {
  const k = CHARS.indexOf(c);
  return k >= 0 && CHROMIUM.some((row) => row[k] === 'b');
};
/** Chromium 量到的被挤位置 → 回退该加 halt 的位置：收标点后紧跟开标点时挤收标点 */
const fallbackOf = (s: string, trimmed: readonly number[]): number[] =>
  trimmed.map((j) => (j > 0 && closes(s[j - 1]) && opens(s[j]) ? j - 1 : j));

let pass = 0;
const fails: string[] = [];
const show = (xs: readonly number[]) => `[${xs.join(', ')}]`;
function check(name: string, got: readonly number[], want: readonly number[]): void {
  if (show(got) === show(want)) pass += 1;
  else fails.push(`${name}：得到 ${show(got)}，期望 ${show(want)}`);
}

if (CHROMIUM.length !== CHARS.length || CHROMIUM.some((row) => row.length !== CHARS.length)) {
  console.error('TYPOGRAPHY SELFTEST FAIL: 表的行数或列数与 CHARS 不一致');
  process.exit(1);
}

let pairs576 = 0;
CHARS.forEach((a, r) =>
  CHARS.forEach((b, c) => {
    const s = `字${a}${b}字`;
    const cell = CHROMIUM[r][c];
    const trimmed = cell === 'a' ? [1] : cell === 'b' ? [2] : [];
    check(`「${a}${b}」`, haltIndices(s), fallbackOf(s, trimmed));
    if (r < 24 && c < 24) pairs576 += 1;
  }),
);
for (const [s, trimmed] of SENTENCES) check(s, haltIndices(s), fallbackOf(s, trimmed));

// 边界：空串、单个字、连着几个收标点（每个都挤、不重复）
check('空串', haltIndices(''), []);
check('单个收标点', haltIndices('」'), []);
check('连用收标点', haltIndices('」」」'), [0, 1]);
check('连用开标点', haltIndices('「「「'), [1, 2]);

if (fails.length) {
  console.error(`TYPOGRAPHY SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 12)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(
  `TYPOGRAPHY SELFTEST PASS: ${pass} 项断言全通（${CHARS.length}×${CHARS.length} 对标点，含设计系统 §2.2 的 ${pairs576} 对；${SENTENCES.length} 句真实文案；边界）`,
);
