// scripts/check-console-src.ts 的夹具自测（console UX spec 验收 3）：对不变量 2、3、4、6、8、9、28 各造几处违规，
// 检查脚本要失败，并逐处点名「文件:行」和不变量编号；允许的写法（部件文件本身、日期与时刻、placeholder 里的产品例子、
// 映射表里的 danger 字符串、样张页与自测里的空格）一处都不能报；只留允许的写法时脚本通过。
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
for (const d of [all, cleanDir, toastDir]) fs.rmSync(d, { recursive: true, force: true });

if (fails.length) {
  console.error(`check-console-src: ${fails.length} 条失败（${pass} 条通过）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`check-console-src: ${pass} 条断言全部通过`);
