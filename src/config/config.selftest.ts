// 配置层自测（docs/architecture/01-pg-config-console/spec.md「测试与 CI」）。现在是第 4 步的 SOP 纯内核部分：
// 节表与 data/sop.md 的逐字节往返、规范形、编码检查、契约检查的每种 violation（验收 6 的纯函数部分、验收 3 的编码部分），
// 以及守着契约清单不漂移的三个测试。配置源、导入导出、快照、编辑流程等在后面几步往这里加。
// 用法：npx tsx src/config/config.selftest.ts
import '../selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// 先设临时 VAR_DIR 再动态 import：engine 会连带加载 store.ts，它在加载时就读 VAR_DIR
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
process.env.VAR_DIR = fs.mkdtempSync(path.join(varParent, 'wecom-config-selftest-'));
process.env.LLM_MOCK = '1';

const root = path.join(import.meta.dirname, '..', '..');
const { TRAVEL_SOP_SECTIONS, splitSop, joinSop, sectionBody, withBody, normalizeBody, mergeWithImage, editableChars, assertSopEncoding } =
  await import('../sop/sections.js');
const { SOP_CONTRACT, SOP_KNOWN_FIELDS, KNOWN_FIELD_SOURCES, BUDGET_RATIO, checkSopContract } = await import('../sop/contract.js');
const { renderSystemPrompt } = await import('../prompt/system.js');
const toolDefsModule = await import('../tool-defs.js');
const { toolDefs: toolDefsViaTools } = await import('../tools.js');
const { promptPrefix, __engineTest } = await import('../engine.js');
type SopSection = import('../sop/sections.js').SopSection;
type ViolationCode = import('../sop/contract.js').ViolationCode;

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass += 1;
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`);
}
/** 抛出的错误类名；不抛返回 'ok' */
function thrown(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.constructor.name : String(e);
  }
}
const ch = (code: number): string => String.fromCharCode(code);

const md = fs.readFileSync(path.join(root, 'data', 'sop.md'), 'utf8');
const image = splitSop(md);
const spec = TRAVEL_SOP_SECTIONS;
const specOf = (key: string) => spec.find((s) => s.key === key)!;
const indexOf = (key: string): number => spec.findIndex((s) => s.key === key);
const toolNames = toolDefsModule.toolDefs.map((t) => t.function.name);

// ---------------- 节表与 data/sop.md ----------------
check('节表：11 节，第一节是前言', spec.length === 11 && spec[0]?.key === 'preamble' && spec[0].heading === null);
check(
  '节表：锁定 7 节',
  spec
    .filter((s) => s.locked)
    .map((s) => s.key)
    .join(',') === 'stages,orders,quote-discipline,price-rules,capabilities,no-destinations,handoff',
);
check('data/sop.md：切成 11 节，key 与节表一致', image.map((s) => s.key).join(',') === spec.map((s) => s.key).join(','));
check('data/sop.md：切开再拼回逐字节相同', joinSop(image) === md);
for (const [i, s] of spec.entries()) {
  const section = image[i]!;
  const body = sectionBody(section, s);
  check(`规范形：「${s.key}」已是规范形`, normalizeBody(body, i === spec.length - 1) === body);
  // 后台只提交可编辑节的正文：GET 到的正文原样 PUT 回去，节的字节不变，哈希也就不变
  check(`GET→PUT：「${s.key}」原样提交回去字节不变`, withBody(s, body, i === spec.length - 1).text === section.text);
}
check('mergeWithImage：同一份合并是恒等', joinSop(mergeWithImage(image, image)) === md);
check(
  'editableChars：等于四个可编辑节正文长度之和',
  editableChars(image) === spec.filter((s) => !s.locked).reduce((n, s) => n + sectionBody(image[indexOf(s.key)]!, s).length, 0),
);

// ---------------- 合并 ----------------
{
  const replace = (sections: readonly SopSection[], key: string, text: string): SopSection[] =>
    sections.map((s) => (s.key === key ? { key, text } : s));
  const toneText = `## 话术原则\n\n改过的话术。\n\n`;
  const stagesText = `## 各阶段目标\n\n运营想改锁定节。\n\n`;
  const stored = replace(replace(image, 'tone', toneText), 'stages', stagesText);
  const merged = mergeWithImage(stored, image);
  check('mergeWithImage：可编辑节取存下来的', merged[indexOf('tone')]?.text === toneText);
  check('mergeWithImage：锁定节永远取镜像', merged[indexOf('stages')]?.text === image[indexOf('stages')]?.text);
  const partial = mergeWithImage(
    stored.filter((s) => s.key !== 'objections'),
    image,
  );
  check('mergeWithImage：存下来的缺某个可编辑节时取镜像', partial[indexOf('objections')]?.text === image[indexOf('objections')]?.text);
  const extra = mergeWithImage([...stored, { key: 'old-section', text: '## 旧节\n\n旧的。\n\n' }], image);
  check('mergeWithImage：节表里已经没有的节丢掉', extra.length === spec.length && !extra.some((s) => s.key === 'old-section'));
  // 旧节表里末节在前面、结尾是 \n\n：按当前节表重建后末节只留一个换行
  const oldLast = replace(image, 'wechat-style', `## 旧标题\n\n微信语气。\n\n`);
  const rebuilt = mergeWithImage(oldLast, image).at(-1)!;
  check(
    'mergeWithImage：可编辑节按当前节表重建标题与结尾',
    rebuilt.text === `## 微信语气规范\n\n微信语气。\n`,
    JSON.stringify(rebuilt.text),
  );
}

// ---------------- 编码检查（验收 3 的编码部分） ----------------
{
  const BOM = ch(0xfeff);
  const cases: [string, string][] = [
    ['BOM', BOM + md],
    ['\\r\\n', md.replace('\n', '\r\n')],
    ['单独的 \\r', md.replace('云途', `云途${ch(13)}x`)],
    ['NFD 字符', md.replace('云途', `云途 e${ch(0x301)}`)],
    ['孤立代理项', md.replace('云途', `云途${ch(0xd800)}`)],
    ['NUL', md.replace('云途', `云途${ch(0)}`)],
    ['其他 C0 控制字符', md.replace('云途', `云途${ch(0x07)}`)],
    ['U+2028', md.replace('云途', `云途${ch(0x2028)}`)],
    ['U+2029', md.replace('云途', `云途${ch(0x2029)}`)],
  ];
  for (const [what, text] of cases) {
    check(`编码：含${what}被 assertSopEncoding 拒`, thrown(() => assertSopEncoding(text)) === 'SopEncodingError');
    check(`编码：含${what}的文件 splitSop 也拒`, thrown(() => splitSop(text)) === 'SopEncodingError');
  }
  check('编码：制表符与换行照收', thrown(() => assertSopEncoding('a\tb\nc')) === 'ok');
  check('编码：当前 data/sop.md 合格', thrown(() => assertSopEncoding(md)) === 'ok');

  // 规范化：BOM、CRLF、NFD、行尾空白、开头空行、末尾空白都修掉；修不了的字符直接拒，不替换
  const messy = `${BOM}\n\n第一行  \r\n第二行 e${ch(0x301)}\t\r\n\n   \n`;
  check(
    '规范化：能修的都修掉，非末节以空行结尾',
    normalizeBody(messy, false) === `第一行\n第二行 é\n\n`,
    JSON.stringify(normalizeBody(messy, false)),
  );
  check('规范化：末节以一个换行结尾', normalizeBody('末节  \n\n', true) === '末节\n');
  check('规范化：单独的 \\r 换成 \\n', normalizeBody(`a${ch(13)}b`, true) === 'a\nb\n');
  check('规范化：行首缩进保留', normalizeBody('  · 一条\n', true) === '  · 一条\n');
  for (const [what, bad] of [
    ['行尾的 U+2028', `一行${ch(0x2028)}`],
    ['孤立代理项', `一行${ch(0xdc00)}`],
    ['NUL', `一行${ch(0)}`],
  ]) {
    check(`规范化：${what}直接拒，不当空白删掉`, thrown(() => normalizeBody(bad!, true)) === 'SopEncodingError');
  }
}

// ---------------- 结构 ----------------
{
  const structure = (text: string): string => thrown(() => splitSop(text));
  check('结构：标题改一个字被拒', structure(md.replace('## 话术原则\n', '## 话术原则们\n')) === 'SopStructureError');
  check('结构：少一节被拒', structure(md.replace(/## 异议处理\n[\s\S]*?(?=## 能力边界)/, '')) === 'SopStructureError');
  check('结构：多一节被拒', structure(md.replace('## 异议处理\n', '## 新节\n\n多出来的。\n\n## 异议处理\n')) === 'SopStructureError');
  check('结构：标题后缺空行被拒', structure(md.replace('## 话术原则\n\n', '## 话术原则\n')) === 'SopStructureError');
  check('结构：末尾多一节被拒', structure(`${md}## 附录\n\n内容\n`) === 'SopStructureError');
  // 空正文要写成规范形（非末节 \n\n、末节 \n），否则先被「不是规范形」拦下，测不到「正文为空」本身
  check(
    '结构：非末节正文为空被拒',
    structure(md.replace(/## 异议处理\n\n[\s\S]*?(?=## 能力边界)/, '## 异议处理\n\n\n\n')) === 'SopStructureError',
  );
  check('结构：末节正文为空被拒', structure(md.replace(/## 微信语气规范\n\n[\s\S]*$/, '## 微信语气规范\n\n\n')) === 'SopStructureError');
  check(
    '结构：正文开头多一个空白行（不是规范形）被拒',
    structure(md.replace('## 话术原则\n\n', '## 话术原则\n\n  \n')) === 'SopStructureError',
  );
  const trailing = md.replace(/(## 话术原则\n\n[^\n]*)\n/, '$1 \n');
  check('结构：正文某行带行尾空格被拒', trailing !== md && structure(trailing) === 'SopStructureError');
  check('结构：末节多一个空行被拒', structure(`${md}\n`) === 'SopStructureError');
  check('withBody：正文为空被拒', thrown(() => withBody(specOf('tone'), '  \n\n', false)) === 'SopStructureError');
  check(
    'withBody：正文里有行首「## 」被拒',
    thrown(() => withBody(specOf('wechat-style'), '正文\n## 新节\n内容', true)) === 'SopStructureError',
  );
  check('withBody：「### 」小标题照收', thrown(() => withBody(specOf('tone'), '### 小标题\n内容', false)) === 'ok');
  check(
    'sectionBody：标题不对抛结构错误',
    thrown(() => sectionBody({ key: 'tone', text: '## 别的\n\n正文\n\n' }, specOf('tone'))) === 'SopStructureError',
  );
}

// ---------------- 渲染与工具定义 ----------------
check(
  '渲染：renderSystemPrompt(data/sop.md) 与引擎的 buildSystemPrompt 逐字节相同',
  renderSystemPrompt(md) === __engineTest.buildSystemPrompt(),
);
check('渲染：promptPrefix().system 也经它', promptPrefix().system === renderSystemPrompt(md));
check('渲染：同一份输入渲染两遍结果相同', renderSystemPrompt(md) === renderSystemPrompt(md));
check('渲染：以 SOP 开头，硬性要求在后', renderSystemPrompt(md).startsWith(md) && renderSystemPrompt('').startsWith('\n\n【硬性要求】'));
check('工具定义：tools.ts 再导出的就是 tool-defs.ts 的同一个数组', toolDefsViaTools === toolDefsModule.toolDefs);
check('工具定义：promptPrefix().tools 等于 JSON.stringify(toolDefs)', promptPrefix().tools === JSON.stringify(toolDefsModule.toolDefs));

// ---------------- 契约检查 ----------------
const contract = (sections: readonly SopSection[], over: Partial<Parameters<typeof checkSopContract>[0]> = {}) =>
  checkSopContract({
    sections,
    imageSections: image,
    rendered: renderSystemPrompt(joinSop(sections)),
    toolNames,
    knownFields: SOP_KNOWN_FIELDS,
    baselineEditableChars: null,
    ...over,
  });
const codes = (vs: { code: ViolationCode; sectionKey: string | null }[]): string =>
  vs.map((v) => `${v.code}@${v.sectionKey ?? '-'}`).join(' ');
/** 把某个可编辑节的正文换成 body，其余不动（后台保存草稿就是这样） */
const editBody = (key: string, body: (old: string) => string): SopSection[] =>
  image.map((s, i) => (s.key === key ? withBody(spec[i]!, body(sectionBody(s, spec[i]!)), i === spec.length - 1) : s));

{
  const clean = contract(image, { baselineEditableChars: editableChars(image) });
  check('契约：当前 data/sop.md 零 violation（含预算）', clean.length === 0, JSON.stringify(clean));

  // 验收 6 的五种草稿
  const forbidden = contract(editBody('tone', (b) => `${b}\n明显超出我们现有线路的范围，就转人工。`));
  check('契约：话术原则里写进禁用短语 → phrase_forbidden@tone', codes(forbidden) === 'phrase_forbidden@tone', codes(forbidden));
  for (const name of ['search_route', 'create_refund']) {
    const vs = contract(editBody('objections', (b) => `${b}\n嫌贵时调 ${name} 看看。`));
    check(
      `契约：异议处理里写 ${name} → unknown_tool@objections`,
      codes(vs) === 'unknown_tool@objections' && vs[0]!.detail.includes(name),
      codes(vs),
    );
  }
  const field = contract(editBody('objections', (b) => `${b}\n看结果里的 destinationMissing。`));
  check('契约：写 destinationMissing → unknown_field', codes(field) === 'unknown_field@objections', codes(field));
  const newSection = image.map((s) => (s.key === 'wechat-style' ? { key: s.key, text: `${s.text}## 新节\n\n多一节。\n` } : s));
  const struct = contract(newSection);
  check(
    '契约：微信语气规范的正文里加一行「## 新节」→ structure@wechat-style',
    codes(struct).split(' ').includes('structure@wechat-style'),
    codes(struct),
  );
  const baseline = editableChars(image);
  const limit = Math.floor(baseline * BUDGET_RATIO);
  const grow = (k: number): SopSection[] => editBody('tone', (b) => b + '多'.repeat(k));
  // 追加在正文末尾时，规范化会在原结尾和新内容之间留一个空行：多出来的那几个字符先量出来
  const newline = editableChars(grow(1)) - baseline - 1;
  const atLimit = grow(limit - baseline - newline);
  const grown = grow(limit - baseline - newline + 1);
  check(
    '契约：正好在上限上不算超',
    editableChars(atLimit) === limit && contract(atLimit, { baselineEditableChars: baseline }).length === 0,
  );
  check(
    '契约：可编辑节超出导入时的 120% → over_budget',
    editableChars(grown) === limit + 1 && codes(contract(grown, { baselineEditableChars: baseline })) === 'over_budget@-',
  );
  check('契约：预算传 null 不查', contract(grown).length === 0);

  // 其余几种 code
  const lockedEdit = image.map((s) => (s.key === 'price-rules' ? { key: s.key, text: s.text.replace('定价只有两条规则', '定价规则') } : s));
  const lockedVs = contract(lockedEdit);
  check(
    '契约：改了锁定节 → locked_changed（顺带丢了必需短语）',
    codes(lockedVs) === 'locked_changed@price-rules phrase_missing@-',
    codes(lockedVs),
  );
  // 代码部署改了锁定节、镜像也跟着变时，只剩 phrase_missing：这正是「要求出现」这一类防的情况
  const missing = contract(lockedEdit, { imageSections: lockedEdit });
  check(
    '契约：镜像里的锁定节丢了必需短语 → phrase_missing',
    codes(missing) === 'phrase_missing@-' && missing[0]!.detail.includes('定价只有两条规则'),
    codes(missing),
  );
  const pattern = contract(editBody('objections', (b) => `${b}\n嫌贵就换酒店档。`));
  check(
    '契约：命中禁用模式 → phrase_forbidden',
    codes(pattern) === 'phrase_forbidden@objections' && pattern[0]!.detail.includes('换酒店档'),
    codes(pattern),
  );
  const order = contract(image.toReversed());
  check('契约：节的顺序不对 → structure', codes(order).startsWith('structure@-'), codes(order));
  const noBlank = image.map((s) => (s.key === 'tone' ? { key: s.key, text: s.text.replace('## 话术原则\n\n', '## 话术原则\n') } : s));
  check('契约：标题后缺空行 → structure@tone', codes(contract(noBlank)).split(' ').includes('structure@tone'));
  const emptyBody = contract(image.map((x) => (x.key === 'objections' ? { key: x.key, text: '## 异议处理\n\n\n\n' } : x)));
  check('契约：正文为空 → structure@objections', codes(emptyBody).split(' ').includes('structure@objections'), codes(emptyBody));
  // 短语规则对的是整段 rendered（含硬性要求），不是各节：只改 rendered 也要拦得住
  const rendered = renderSystemPrompt(md);
  const extraForbidden = contract(image, { rendered: `${rendered}\n明显超出我们现有线路的范围` });
  check(
    '契约：rendered 里出现禁用短语 → phrase_forbidden（不在任何一节里）',
    codes(extraForbidden) === 'phrase_forbidden@-',
    codes(extraForbidden),
  );
  const lostRequired = contract(image, { rendered: rendered.replace('定价只有两条规则', '') });
  check('契约：rendered 里丢了必需短语 → phrase_missing', codes(lostRequired) === 'phrase_missing@-', codes(lostRequired));
  const multi = contract(editBody('objections', (b) => `${b}\n先调 get_route_details，再看 maxBudgetPerKid。`));
  check(
    '契约：多段下划线的未知工具、多个驼峰的未知字段都拦',
    codes(multi) === 'unknown_tool@objections unknown_field@objections',
    codes(multi),
  );
  check(
    '契约：大写开头的词与纯小写单词不查',
    contract(editBody('tone', (b) => `${b}\n住 Aman 或 WeChat 里说，greeting 与 emoji 都行。`)).length === 0,
  );
  check('契约：已有的工具名与字段名照收', contract(editBody('tone', (b) => `${b}\n报价调 create_quote，看 withinBudget。`)).length === 0);
}

// ---------------- 清单不漂移 ----------------
{
  // 源码扫描按 AST 走，不按正则：格式化器会把长短语折成多行，正则就漏了。
  // engine.selftest.ts 里对 system prompt 的每一处短语断言，都必须原样在 SOP_CONTRACT 里，反过来也一样
  const file = path.join(root, 'src', 'engine.selftest.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const HOLDERS = new Set(['sys', 'sop']);
  const isHolder = (n: ts.Node): n is ts.Identifier => ts.isIdentifier(n) && HOLDERS.has(n.text);
  const negated = (call: ts.Node): boolean =>
    ts.isPrefixUnaryExpression(call.parent) && call.parent.operator === ts.SyntaxKind.ExclamationToken;
  const found: string[] = [];
  const recognized = new Set<ts.Node>();
  const odd: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const callee = n.expression;
      const [arg] = n.arguments;
      // sys.includes('…')：参数必须是不带插值的字面量，否则清单里没法照抄
      if (callee.name.text === 'includes' && isHolder(callee.expression)) {
        recognized.add(callee.expression);
        if (n.arguments.length === 1 && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          found.push(`${negated(n) ? 'exclude' : 'include'}:${arg.text}`);
        } else odd.push(`第 ${line(n)} 行的 includes 参数不是字面量`);
      }
      // /…/.test(sys)：带上 flags 一起比，/x/i 与 /x/ 不算同一条
      if (callee.name.text === 'test' && ts.isRegularExpressionLiteral(callee.expression) && arg && isHolder(arg)) {
        recognized.add(arg);
        const lit = callee.expression.text;
        found.push(`${negated(n) ? 'exclude-pattern' : 'include-pattern'}:${lit}`);
      }
      // buildSystemPrompt() 只能赋给 sys 或 sop：换个变量名、或者直接在调用结果上断言，扫描就看不见了
      if (callee.name.text === 'buildSystemPrompt') {
        const decl = n.parent;
        if (!(ts.isVariableDeclaration(decl) && decl.initializer === n && isHolder(decl.name))) {
          odd.push(`第 ${line(n)} 行的 buildSystemPrompt() 没有赋给 sys 或 sop`);
        }
      }
    }
    if (isHolder(n) && ts.isVariableDeclaration(n.parent) && n.parent.name === n) recognized.add(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const holderUses = (n: ts.Node, acc: ts.Identifier[] = []): ts.Identifier[] => {
    if (isHolder(n)) acc.push(n);
    ts.forEachChild(n, (c) => void holderUses(c, acc));
    return acc;
  };
  for (const id of holderUses(sf))
    if (!recognized.has(id)) odd.push(`第 ${line(id)} 行对 ${id.text} 的用法认不出来（只认 .includes('…') 与 /…/.test(${id.text})）`);
  const listed = SOP_CONTRACT.map((r) => `${r.kind}:${r.kind === 'exclude-pattern' ? String(r.pattern) : r.text}`);
  const unlisted = found.filter((f) => !listed.includes(f));
  const stale = listed.filter((l) => !found.includes(l));
  check('漂移：engine.selftest.ts 的每条 SOP 短语断言都在 SOP_CONTRACT 里', unlisted.length === 0, `没进清单：${unlisted.join(' | ')}`);
  check('漂移：SOP_CONTRACT 里没有 engine.selftest.ts 已经删掉的断言', stale.length === 0, `多出来的：${stale.join(' | ')}`);
  check('漂移：engine.selftest.ts 里对 system prompt 的断言都是认得出的写法', odd.length === 0, odd.join('；'));
  check('漂移：扫描确实找到了断言（17 条）', found.length === 17, String(found.length));

  // SOP_KNOWN_FIELDS 的每一项都要以标识符（或字符串字面量）的形式出现在产出工具字段的源文件里；注释里提到不算
  const tokens = new Set<string>();
  for (const f of KNOWN_FIELD_SOURCES) {
    const src = ts.createSourceFile(f, fs.readFileSync(path.join(root, f), 'utf8'), ts.ScriptTarget.Latest, true);
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) tokens.add(n.text);
      ts.forEachChild(n, walk);
    };
    walk(src);
  }
  const absent = SOP_KNOWN_FIELDS.filter((f) => !tokens.has(f));
  check('漂移：SOP_KNOWN_FIELDS 都以标识符出现在 KNOWN_FIELD_SOURCES 里', absent.length === 0, absent.join(','));
  check('漂移：SOP 点名的工具都是现有的工具', contract(image).filter((v) => v.code === 'unknown_tool').length === 0);
}

if (fails.length) {
  console.error(`CONFIG SELFTEST FAIL: ${fails.length} 项\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `CONFIG SELFTEST PASS: ${pass} 项断言全通（节表与 data/sop.md 往返 / 规范形与 GET→PUT / 编码检查 / 结构 / 合并 / 渲染等价 / 契约的每种 violation / 清单不漂移）`,
);
process.exit(0);
