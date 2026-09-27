// scripts/check-console-src.ts 的夹具自测（console UX spec 验收 3）：对不变量 2、3、4、6、8、9、11、17、28 各造几处违规，
// 检查脚本要失败，并逐处点名「文件:行」和不变量编号；允许的写法（部件文件本身、日期与时刻、placeholder 里的产品例子、
// 映射表里的 danger 字符串、样张页与自测里的空格，行业包的词出现在注释、标识符、子串、模块名、样张与自测里，
// 系统字段、会话状态值、通用词白名单，旧页面名单里的那几处）一处都不能报；只留允许的写法时脚本通过。
// 不变量 11 的词表是真的：取自本仓库的旅游包与假包，夹具里写的就是它们的词。
// 用法：npx tsx scripts/check-console-src.selftest.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'check-console-src.ts');

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fails.push(`${name}${detail ? `：${detail}` : ''}`);
}

/** 违规夹具：文件、违规所在的行、不变量编号；第一行都是注释，违规从第 2 行起 */
const BAD: ReadonlyArray<readonly [string, number, number, string]> = [
  ['console/src/i2-type.tsx', 2, 2, `export const A = () => <Button type="primary">发布</Button>;`],
  ['console/src/i2-type-expr.tsx', 2, 2, `export const A = () => <Button type={'primary'}>发布</Button>;`],
  ['console/src/i2-solid.tsx', 2, 2, `export const A = () => <Button color="default" variant="solid">发布</Button>;`],
  ['console/src/i2-modal.tsx', 2, 2, `export const A = () => <Modal open>正文</Modal>;`],
  ['console/src/i2-popconfirm.tsx', 2, 2, `import { Popconfirm } from 'antd';\nexport const P = Popconfirm;`],
  ['console/src/i2-confirm.ts', 2, 2, `modal.confirm({ title: '确定？' });`],
  ['console/src/i2-object.ts', 2, 2, `export const props = { type: 'primary' };`],
  [
    'console/src/i2-two.tsx',
    5,
    2,
    `export const A = () => (\n  <div>\n    <PrimaryButton>一</PrimaryButton>\n    {ok && <PrimaryButton>二</PrimaryButton>}\n  </div>\n);`,
  ],
  ['console/src/i3-attr.tsx', 2, 3, `export const A = () => <Button danger>丢弃</Button>;`],
  ['console/src/i3-color.tsx', 2, 3, `export const A = () => <Button color="danger" variant="outlined">丢弃</Button>;`],
  ['console/src/i3-menu.ts', 2, 3, `export const items = [{ key: 'discard', label: '丢弃草稿', danger: true }];`],
  ['console/src/i3-oktype.ts', 2, 3, `export const props = { okType: 'danger' };`],
  ['console/src/i4-error.ts', 2, 4, `message.error('没保存上');`],
  ['console/src/i4-notification.ts', 2, 4, `notification.error({ title: '没保存上' });`],
  ['console/src/i4-import.ts', 2, 4, `import { message } from 'antd';\nexport const m = message;`],
  ['console/src/i4-useapp.tsx', 2, 4, `const { message } = App.useApp();\nexport const m = message;`],
  ['console/src/i4-success.ts', 2, 4, `message.success('已保存');`],
  ['console/src/i6-tag.tsx', 2, 6, `export const A = () => <Tag color="green">已上架</Tag>;`],
  ['console/src/i6-badge.tsx', 2, 6, `export const A = () => <Badge count={3} />;`],
  ['console/src/i6-radio.tsx', 2, 6, `export const A = () => <Radio.Button value="a">甲</Radio.Button>;`],
  ['console/src/i8-access.ts', 2, 8, `export const d = (e: { body: { detail?: string } }) => e.body.detail;`],
  ['console/src/i8-element.ts', 2, 8, `export const d = (e: Record<string, string>) => e['detail'];`],
  ['console/src/i8-destructure.ts', 2, 8, `export const d = ({ detail }: { detail: string }) => detail;`],
  ['console/src/i9-literal.ts', 2, 9, `export const s = '已发布 v2';`],
  ['console/src/i9-template.ts', 2, 9, 'export const s = (n: number) => `第 ${n} 行`;'],
  ['console/src/i9-lead.ts', 2, 9, 'export const s = (n: number) => `${n} 条`;'],
  ['console/src/i9-jsx.tsx', 2, 9, `export const A = ({ n }: { n: number }) => <p>共 {n} 条</p>;`],
  ['console/src/i9-latin-first.tsx', 2, 9, `export const A = () => <p>CSV 导入</p>;`],
  ['console/src/i9-attr.tsx', 2, 9, `export const A = () => <input placeholder="也可以把 CSV 粘贴在这里" />;`],
  ['console/src/i9-concat.ts', 2, 9, `export const s = (n: number) => '共 ' + n;`],
  ['src/packs/demo/console-pack.ts', 2, 9, `export const pack = { label: '每人起价', help: '最多 3 天' };`],
  // 话术节 heading 的例外只给行业包配置（照抄 SOP 文件的标题）；console 里叫 heading 的字符串照样查
  ['console/src/i9-heading.ts', 2, 9, `export const s = { heading: '共 3 节' };`],
  // 假包的界面配置同样查不变量 9：走查照样显示它的字
  ['src/shared/pack-fixtures/demo.ts', 2, 9, `export const pack = { label: '最多 3 个节点' };`],
  // 不变量 11：注册包与假包的实体 kind、实体名、工具原名、字段 key（含子字段、带点 key 的每一段）、字段标签、阶段 key
  ['console/src/i11-kind.ts', 2, 11, `export const k = 'route';`],
  ['console/src/i11-entity.tsx', 3, 11, `export const A = () => <h1>\n  线路\n</h1>;`],
  ['console/src/i11-fake-entity.ts', 2, 11, `export const s = '装修套餐';`],
  ['console/src/i11-fake-kind.ts', 2, 11, `export const s = { to: 'material' };`],
  ['console/src/i11-tool.ts', 2, 11, `export const t = { chip: 'search_routes' };`],
  ['console/src/i11-fake-tool.ts', 2, 11, `export const t = ['book_measure'];`],
  ['console/src/i11-key.ts', 2, 11, `export const get = (p: Record<string, unknown>) => p['priceFrom'];`],
  ['console/src/i11-key-path.ts', 2, 11, `export const k = 'intensity.level';`],
  ['console/src/i11-key-segment.ts', 2, 11, `export const k = 'intensity';`],
  ['console/src/i11-sub-key.ts', 2, 11, `export const k = 'checkpoints';`],
  ['console/src/i11-label.tsx', 2, 11, `export const A = () => <Form.Item label="每人起价" />;`],
  ['console/src/i11-fake-label.ts', 2, 11, `export const s = ' 每平米单价 ';`],
  ['console/src/i11-sub-label.ts', 2, 11, `export const s = '当晚住宿';`],
  ['console/src/i11-code-label.ts', 2, 11, `export const s = '线路编号';`],
  ['console/src/i11-stage.ts', 2, 11, `export const s = (x: string) => x === 'closing';`],
  ['console/src/i11-fake-stage.ts', 2, 11, `export const s = 'deposit';`],
  ['console/src/i11-template.ts', 2, 11, 'export const s = (n: number) => `${n}逐日行程`;'],
  ['console/src/i11-type.ts', 2, 11, `export type K = 'hotel';`],
  ['console/src/i11-quoted-key.ts', 2, 11, `export const m = { '酒店': 1 };`],
  // 旧页面名单只放过那两个文件：同一个词写在别的文件里照报
  ['console/src/pages/Other.tsx', 2, 11, `export const s = '目的地';`],
  // 不变量 17：console 里不读 handedOver，不拿 stage 和 'paid' 比；自测也一样
  ['console/src/i17-access.ts', 2, 17, `export const h = (r: { handedOver: boolean }) => r.handedOver;`],
  ['console/src/i17-optional.ts', 2, 17, `export const h = (r?: { handedOver: boolean }) => r?.handedOver;`],
  ['console/src/i17-destructure.ts', 2, 17, `export const h = ({ handedOver }: { handedOver: boolean }) => handedOver;`],
  ['console/src/i17-dataindex.ts', 2, 17, `export const cols = [{ title: '转人工', dataIndex: 'handedOver' }];`],
  ['console/src/i17-element.ts', 2, 17, `export const h = (r: Record<string, boolean>) => r['handedOver'];`],
  ['console/src/i17-paid.ts', 2, 17, `export const p = (r: { stage: string }) => r.stage === 'paid';`],
  ['console/src/i17-paid-reversed.ts', 2, 17, `export const p = (stage: string) => 'paid' !== stage;`],
  ['console/src/i17-paid-element.ts', 2, 17, `export const p = (r: Record<string, string>) => (r['stage'] as string) == 'paid';`],
  [
    'console/src/i17-switch.ts',
    4,
    17,
    `export const p = (r: { stage: string }) => {\n  switch (r.stage) {\n    case 'paid':\n      return 1;\n    default:\n      return 0;\n  }\n};`,
  ],
  ['console/src/i17.selftest.ts', 2, 17, `export const h = (r: { handedOver: boolean }) => r.handedOver;`],
  ['console/src/i28-dangerous.tsx', 2, 28, `export const A = ({ x }: { x: string }) => <div dangerouslySetInnerHTML={{ __html: x }} />;`],
  ['console/src/i28-csstext.ts', 2, 28, `export const f = (el: HTMLElement) => { el.style.cssText = 'color:red'; };`],
  ['console/src/i28-setattr.ts', 2, 28, `export const f = (el: HTMLElement) => el.setAttribute('style', 'color:red');`],
  ['console/src/i28-inner.ts', 2, 28, `export const f = (el: HTMLElement, s: string) => { el.innerHTML = s; };`],
];

/** 允许的写法：一处都不能报 */
const GOOD: ReadonlyArray<readonly [string, string]> = [
  ['console/src/parts/PrimaryButton.tsx', `export const P = () => <Button color="default" variant="solid" />;`],
  ['console/src/parts/ConfirmDanger.tsx', `export const D = () => <Button color="danger" variant="solid" danger />;`],
  ['console/src/parts/TechDetails.tsx', `export const t = (e: { body: { detail?: string } }) => e.body.detail;`],
  ['console/src/parts/toast.tsx', `const { message } = App.useApp();\nexport const ok = () => message.success('已保存');`],
  [
    'console/src/good.tsx',
    [
      `const when = '9月25日 18:30';`,
      `const format = 'M月D日 HH:mm';`,
      `const at = (t: string) => \`9月25日 \${t}\`;`,
      `export const A = () => <input placeholder="例：四川 稻城亚丁·色达秘境 8 日" />;`,
      `export const B = () => <Modal open footer={null}>正文</Modal>;`,
      `export const C = ({ a }: { a: boolean }) => <div>{a ? <PrimaryButton>甲</PrimaryButton> : <PrimaryButton>乙</PrimaryButton>}<Button>次要</Button></div>;`,
      `export const map = { neutral: 'info', danger: 'error' };`,
      `export const D = () => <Tag>草稿</Tag>;`,
      `export const E = () => <p>已发布v2 · prompt abc{when}{format}</p>;`,
      `export const F = (e: { message: string }) => e.message.includes('x');`,
      `export const G = () => <p>\n  共{3}条\n  {at('10:00')}\n</p>;`,
    ].join('\n'),
  ],
  [
    'console/src/_specimen/Spec.tsx',
    `export const S = () => <div><p>销售话术 Sales v2</p><PrimaryButton>一</PrimaryButton><PrimaryButton>二</PrimaryButton></div>;`,
  ],
  ['console/src/x.selftest.ts', `export const s = '已发布 v2';`],
  ['src/packs/demo/other.ts', `export const s = '不是界面配置 v2';`],
  ['src/packs/sop/console-pack.ts', `export const pack = { sop: [{ key: 'h', heading: '转人工条件（调用 handoff_to_human）' }] };`],
  ['src/shared/pack-fixtures/good.ts', `export const pack = { sop: [{ key: 'h', heading: '转人工条件（调用 handoff_to_human）' }] };`],
  // 不变量 11 放过的：注释、标识符、子串、模块名、$ 开头的系统字段、会话状态值、通用词白名单
  [
    'console/src/good11.tsx',
    [
      `// 线路、酒店、priceFrom 写在注释里不算`,
      `import { route } from 'hotel';`,
      `export { hotel } from 'route';`,
      `export type T = import('route').T;`,
      `export const lazy = () => import('hotel');`,
      `export const kinds = { route: 1, hotel: 2 };`,
      `export const price = (r: { priceFrom: number }) => r.priceFrom;`,
      `export const A = () => <p>新建线路草稿</p>;`,
      `export const B = ({ label }: { label: string }) => <p>{label}</p>;`,
      `export const sys = ['$code', '$status', '$updated'];`,
      `export type S = 'ai' | 'human' | 'paid';`,
      `export const generic = ['title', 'name', 'tags', '状态', '标签'];`,
      `export const C = () => <th>状态</th>;`,
    ].join('\n'),
  ],
  ['console/src/_specimen/Pack.tsx', `export const S = () => <p>线路</p>;\nexport const k = 'priceFrom';`],
  ['console/src/y.selftest.ts', `export const k = ['route', '装修套餐', 'search_routes'];`],
  ['src/packs/demo2/console-pack.ts', `export const pack = { kind: 'route', label: '线路', key: 'priceFrom' };`],
  // 不变量 17 放过的：只经 conversationState 判定、造数据时写 handedOver、别的东西和 'paid' 比
  [
    'console/src/good17.ts',
    [
      `// 注释里提到 handedOver 和 stage === 'paid' 不算`,
      `import { conversationState } from '../../src/shared/conversation.js';`,
      `export const paid = (r: { stage: string; handedOver: boolean }) => conversationState(r) === 'paid';`,
      `export const row = (stage: string) => ({ stage, handedOver: true });`,
      `export const tab = (state: string) => state === 'paid';`,
      `export const same = (stage: string, other: string) => stage === other;`,
    ].join('\n'),
  ],
  // 旧页面待重做：只放过 LEGACY 里这两个文件的这几个词
  ['console/src/pages/CatalogPage.tsx', `export const L = { a: '线路', b: '酒店', c: 'route', d: '目的地' };`],
  ['console/src/router.tsx', `export type K = 'route' | 'hotel';`],
];

function tree(files: ReadonlyArray<readonly [string, string]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-src-'));
  for (const [f, body] of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), `// 夹具\n${body}\n`);
  }
  return dir;
}

function runOn(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, dir], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const all = tree([...BAD.map(([f, , , body]) => [f, body] as const), ...GOOD]);
const bad = runOn(all);
check('有违规时退出码是 1', bad.status === 1, `${bad.status}\n${bad.out.slice(0, 500)}`);
const lines = bad.out.split('\n');
for (const [f, line, inv] of BAD) {
  const named = lines.some((l) => l.includes(`${f}:${line}:`) && l.includes(`不变量 ${inv}：`));
  check(`不变量 ${inv}：${f} 第 ${line} 行被点名`, named, lines.filter((l) => l.includes(f)).join(' | ') || '没有报');
}
for (const [f] of GOOD) check(`允许的写法不报：${f}`, !bad.out.includes(`${f}:`), lines.filter((l) => l.includes(f)).join(' | '));

const cleanDir = tree(GOOD);
const clean = runOn(cleanDir);
check('只留允许的写法时通过', clean.status === 0, clean.out.slice(0, 500));

// toast 文件能碰 message，但 message.error 在它里面也不行
const toastDir = tree([['console/src/parts/toast.tsx', `message.error('没保存上');`]]);
const toastRun = runOn(toastDir);
check(
  '不变量 4：toast 文件里的 message.error( 也被点名',
  toastRun.status === 1 && toastRun.out.includes('console/src/parts/toast.tsx:2:') && toastRun.out.includes('不变量 4：message.error('),
  toastRun.out.slice(0, 300),
);

// 旧页面名单（LEGACY）：只放过名单里的词，同一个文件里的别的词照报
const withGood = (over: ReadonlyArray<readonly [string, string | null]>): (readonly [string, string])[] => {
  const map = new Map<string, string | null>(GOOD.map(([f, body]) => [f, body]));
  for (const [f, body] of over) map.set(f, body);
  return [...map].filter((e): e is [string, string] => e[1] !== null);
};
const CATALOG = 'console/src/pages/CatalogPage.tsx';
const ROUTER = 'console/src/router.tsx';
const extraDir = tree(
  withGood([[CATALOG, `export const L = { a: '线路', b: '酒店', c: 'route', d: '目的地' };\nexport const M = '主材';`]]),
);
const extra = runOn(extraDir);
check(
  '不变量 11：旧页面名单只放过名单里的词，同一个文件里的「主材」照报',
  extra.status === 1 && extra.out.includes(`${CATALOG}:3:`) && extra.out.includes('不变量 11：写死了行业包的词「主材」'),
  extra.out.slice(0, 400),
);
check('不变量 11：名单里的词不报', !extra.out.includes(`${CATALOG}:2:`), extra.out.slice(0, 400));
// 名单里的词在文件里没了（或文件删了），要求删掉这一项
const staleDir = tree(
  withGood([
    [CATALOG, `export const L = { a: '线路', b: '酒店', c: 'route' };`],
    [ROUTER, null],
  ]),
);
const stale = runOn(staleDir);
const staleNamed = (file: string, term: string): boolean => stale.out.includes(`LEGACY 放过 ${file} 里的「${term}」`);
check(
  '不变量 11：旧页面名单里过时的项被点名（词没了、文件没了）',
  stale.status === 1 && staleNamed(CATALOG, '目的地') && staleNamed(ROUTER, 'route') && staleNamed(ROUTER, 'hotel'),
  stale.out.slice(0, 600),
);
check(
  '不变量 11：还在的项不算过时',
  !staleNamed(CATALOG, '线路') && !staleNamed(CATALOG, '酒店') && !staleNamed(CATALOG, 'route'),
  stale.out.slice(0, 600),
);
for (const d of [all, cleanDir, toastDir, extraDir, staleDir]) fs.rmSync(d, { recursive: true, force: true });

if (fails.length) {
  console.error(`check-console-src: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`check-console-src: ${pass} 条断言全部通过`);
