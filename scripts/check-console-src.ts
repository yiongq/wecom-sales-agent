// console 源码的静态检查（docs/features/console-ux/spec.md 不变量 2、3、4、6、8、9、11、17、28，验收 3）。挂在 `pnpm lint` 里，
// 每处违规点名「文件:行:列」和不变量编号。
//
// 用 TypeScript 的解析器读 console/src 下的代码文件，注释不算：
// - 2：主按钮只经墨色主按钮组件（parts/PrimaryButton.tsx）。没有 type="primary"（JSX 属性和对象字面量都算）；
//   实心按钮 variant="solid" 只在它和 ConfirmDanger 里；<Modal> 都要写 footer，因为自带的确定按钮是 antd 的 primary；
//   不用 Popconfirm 和 modal.confirm / Modal.info 这类快捷弹窗，它们也自带 primary 按钮；
//   同一个父元素下至多一个 <PrimaryButton>（条件分支取较多的一支；样张页 _specimen/ 不算）。
// - 3：danger 属性、color="danger"、okType 'danger' 只在 parts/ConfirmDanger.tsx 里；
//   对象字面量里没有值为 true 或表达式的 danger 键，菜单项就是这样配成危险项的。字符串值的 danger 键不算。
// - 4：没有 message.error( 和 notification.error(。antd 的 message、notification 只在 parts/toast.tsx 里碰，
//   包括从 antd import、从 App.useApp() 取、直接调 message.xxx(。成功提示只经 toast()。
// - 6：没有带 color 的 <Tag>，没有带 count 或 status 的 <Badge>，没有 Radio.Button。状态只经 parts/Status.tsx。
// - 8：服务端的 detail 只由 parts/TechDetails.tsx 读。别处不许写 .detail、['detail']，也不许解构出 detail。
// - 9：界面字符串里，中文与数字、拉丁字母之间没有手打的空格。查字符串字面量、模板字符串的文字段、JSX 文本
//   （先按 JSX 的空白规则折叠），也查它们和插值相接的一侧，如「第 ${n} 行」。另查各注册行业包的界面配置
//   src/packs/<包>/console-pack.ts。例外：日期与时刻之间的空格，如「9月25日 18:30」；placeholder 里以「例：」开头的
//   产品数据例子；行业包里话术节的 heading（照抄 SOP 文件的标题）；样张目录 _specimen/，它故意放了反例；
//   *.selftest.*，自测里的字不上页面。假包 src/shared/pack-fixtures/ 的界面配置同样查：走查（验收 5）照样显示它的字。
// - 11（第二层，第一层是 scripts/check-boundaries.ts 的 import 规则）：console 只经 /pack 的数据认识行业包。
//   console/src 的字符串字面量（含类型位置和带引号的属性名）、对象字面量里不带引号的属性名（{ quote: '报价' } 与
//   { 'quote': '报价' } 一样是运行时的键，也算）、模板字符串的各个文字段、JSX 文本，去掉首尾空白后整串等于
//   某个注册包或假包的实体 kind、实体名、工具原名、字段 key（含有序子项的子字段，带点的 key 另算每一段）、字段标签、
//   阶段 key，就报。只比整串，不比子串；不扫注释、其余标识符（变量名、属性访问、解构、类型里的成员名、JSX 属性名）、
//   模块名（import、export 的来源，import()、require()、类型位置的 import()、declare module：是模块路径，不是界面字符串）、
//   *.selftest.* 和 _specimen/。对象键和模块名这两处与 spec 原文的出入见 spec 顶部第 3.3 步评审之后的 Revisions。
//   排除：$ 开头的系统字段 key；会话状态值 ai、human、paid（paid 同时是旅游包的阶段 key）；下面 GENERIC 里的通用词，每项写明理由，
//   只在某几个文件里通用的写明文件（如图标表的键）；LEGACY 里旧页面待重做的几处（spec 顶部第 3.3 步的 Revisions）。
//   GENERIC 与 LEGACY 里不再撞上的项也报（限定了文件的，那几个文件里都没有它了才算），免得名单只增不减。
//   词表取自本仓库的 src/packs/registry.ts 与 src/shared/pack-fixtures/ 下导出的每个包，自测夹具也用这份真词表。
// - 17（console 一侧）：会话状态只由 src/shared/conversation.ts 的 conversationState 判定。console/src 里不读 handedOver
//   （.handedOver、['handedOver']、解构、按名字引用的字符串 'handedOver'，如表格的 dataIndex），
//   也不把 stage 与 'paid' 相比。「stage」指 stage、x.stage、x?.stage、x['stage']，以及同一个文件里存着它的名字：
//   const s = r.stage、const { stage: s } = r、表格列 { dataIndex: 'stage', render: (s) => … } 的第一个参数；「'paid'」指
//   字面量和 const PAID = 'paid' 这样的常量。比法：===、!==、==、!=；switch (stage) 里的 case 'paid'；
//   ['paid', …].includes(stage) 与 indexOf、new Set(['paid']).has(stage)，数组与 Set 存进常量也算。名字按声明所在的块、
//   函数算，不跨文件。查不到的：从别的文件 import 的常量、对象查表 { paid: … }[stage]、把 stage 传进别的函数再比。
//   自测和样张同样查。
// - 28：产品库文本只以文本节点渲染。没有 dangerouslySetInnerHTML、.cssText、setAttribute('style'，
//   也没有 innerHTML、outerHTML、insertAdjacentHTML。
//
// 可选参数：要检查的仓库根目录（给自测夹具用），默认当前目录。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { PACK_IDS, packById } from '../src/packs/registry.js';
import type { FieldDef, IndustryPack } from '../src/shared/pack.js';

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
/** 词表从本脚本所在的仓库取，不随 ROOT 变 */
const REPO = path.resolve(import.meta.dirname, '..');

const PRIMARY_FILE = 'console/src/parts/PrimaryButton.tsx';
const DANGER_FILE = 'console/src/parts/ConfirmDanger.tsx';
const TOAST_FILE = 'console/src/parts/toast.tsx';
const TECH_FILE = 'console/src/parts/TechDetails.tsx';
const SPECIMEN_DIR = 'console/src/_specimen/';
const CODE = /\.(ts|tsx|mts|js|jsx|mjs)$/;
const SELFTEST = /\.selftest\.[a-z]+$/;
/** 注册行业包的界面配置，和假包（不注册，走查照样显示）：都只查不变量 9 */
const PACK_CONFIG = /^src\/packs\/[^/]+\/console-pack\.ts$/;
const PACK_FIXTURES = 'src/shared/pack-fixtures';
const isPackConfig = (f: string): boolean =>
  PACK_CONFIG.test(f) || (f.startsWith(`${PACK_FIXTURES}/`) && CODE.test(f) && !SELFTEST.test(f));

// ---------- 不变量 11 的词表 ----------

/** 会话状态值（ConversationState），不是行业包的词；paid 碰巧也是旅游包的阶段 key */
const SESSION_STATES = new Set(['ai', 'human', 'paid']);

/** 通用词白名单：撞上了行业包的词，但 console 自己也要用。每项写明理由；只在某几个文件里通用的，only 写明文件，别处照报 */
const GENERIC: Readonly<Record<string, string | { why: string; only: readonly string[] }>> = {
  title: '通用属性名：DOM 的 title 属性、表格列与表单项的键都叫它，不只是行业包的字段',
  name: '通用属性名：表单项、input 的 name 都叫它，不只是行业包的字段',
  tags: '字段类型名：FieldType 里的 tags，渲染器按类型分派时要写',
  状态: '界面自己的词：列表的「状态」列、条目与会话的状态，系统字段 $status 的标签也是它',
  标签: '界面自己的词：tags 类型字段的通用叫法',
  duration: '通用属性名：antd 的 message、notification 的显示时长配置键（parts/toast.tsx），碰巧是假包的字段 key',
  styles: '通用属性名：antd 组件与 ConfigProvider 的语义化样式配置键（theme/ThemeProvider.tsx），碰巧是假包的字段 key',
  route: {
    why: '设计系统 §7 的实体图标名（lucide 的 route），图标表以它为键；别的文件里 route 仍是旅游包的实体 kind',
    only: ['console/src/shell/icons.tsx'],
  },
  package: {
    why: '设计系统 §7 的实体图标名（lucide 的 package），图标表以它为键；别的文件里 package 仍是假包的实体 kind',
    only: ['console/src/shell/icons.tsx'],
  },
};
/** GENERIC 里限定了文件的项实际放过的「文件\0词」，用来查过时的项 */
const genericUsed = new Set<string>();

/**
 * 旧页面待重做：01 留下的产品库抽屉（rjsf 表单，逐日行程的「当天安排」按线路写死成文本域）。第 9 步重做了列表、路由参数改按
 * 行业包的 kind 取，抽屉挪进自己的文件按需下载；第 10.3 步删掉旧抽屉时删掉这一项。只放过这个文件里的这几个词，
 * 别的词、别的文件照查；词在文件里没了就要删掉这一项
 */
const LEGACY: Readonly<Record<string, { terms: readonly string[]; until: string }>> = {
  'console/src/pages/CatalogDrawer.tsx': { terms: ['route', 'detail'], until: '第 10.3 步删掉旧抽屉' },
};

const isPackLike = (v: unknown): v is IndustryPack =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as IndustryPack).entities) &&
  Array.isArray((v as IndustryPack).stages) &&
  typeof (v as IndustryPack).vocabulary === 'object';

/** 注册的包，加上假包目录下各文件导出的包 */
async function packsToScan(): Promise<{ pack: IndustryPack; who: string }[]> {
  const out = PACK_IDS.map((id) => ({ pack: packById(id)!, who: `${packById(id)!.name}包` }));
  const dir = path.join(REPO, PACK_FIXTURES);
  const fixtures = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => CODE.test(f) && !SELFTEST.test(f)) : [];
  for (const f of fixtures.toSorted()) {
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as Record<string, unknown>;
    for (const v of Object.values(mod)) if (isPackLike(v)) out.push({ pack: v, who: `${v.name}包（假包）` });
  }
  return out;
}

/** 词 → 它是哪个包的什么（可能不止一处） */
function vocabularyOf(packs: { pack: IndustryPack; who: string }[]): Map<string, string[]> {
  const vocab = new Map<string, string[]>();
  const add = (term: string, what: string): void => {
    const t = term.trim();
    if (!t) return;
    const list = vocab.get(t) ?? [];
    if (!list.includes(what)) list.push(what);
    vocab.set(t, list);
  };
  for (const { pack, who } of packs) {
    const fields = (defs: readonly FieldDef[]): void => {
      for (const f of defs) {
        if (!f.key.startsWith('$')) {
          add(f.key, `${who}的字段 key`);
          for (const seg of f.key.split('.')) add(seg, `${who}的字段 key`);
        }
        add(f.label, `${who}的字段标签`);
        if (f.item) fields(f.item);
      }
    };
    for (const e of pack.entities) {
      add(e.kind, `${who}的实体 kind`);
      add(e.label, `${who}的实体名`);
      fields(e.fields);
    }
    for (const tool of Object.keys(pack.vocabulary.tools)) add(tool, `${who}的工具原名`);
    for (const s of pack.stages) add(s.key, `${who}的阶段 key`);
  }
  return vocab;
}

const PACKS = await packsToScan();
const VOCAB = vocabularyOf(PACKS);

/** 中文：汉字与全角标点（U+3001–303F、U+FF01–FF60）。码位用 fromCodePoint 拼，源码里不写转义 */
const CJK_CLASS = `\\p{Script=Han}${String.fromCodePoint(0x3001)}-${String.fromCodePoint(0x303f)}${String.fromCodePoint(0xff01)}-${String.fromCodePoint(0xff60)}`;
const SPACE_CLASS = ` ${String.fromCodePoint(0xa0)}`;
const INNER_SPACE = new RegExp(`([${CJK_CLASS}])[${SPACE_CLASS}]+([A-Za-z0-9])|([A-Za-z0-9])[${SPACE_CLASS}]+([${CJK_CLASS}])`, 'gu');
const LEAD_SPACE = new RegExp(`^[${SPACE_CLASS}]+[${CJK_CLASS}]`, 'u');
const TAIL_SPACE = new RegExp(`([${CJK_CLASS}])[${SPACE_CLASS}]+$`, 'u');
/** 日期与时刻之间的空格：「日」后面跟时刻（数字，或 dayjs 格式里的 H） */
const DATE_TIME = /日$/;
const TIME_START = /^[0-9H]/;

interface Hit {
  file: string;
  line: number;
  col: number;
  msg: string;
}

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) {
      if (d.name !== 'node_modules' && d.name !== 'dist') out.push(...walk(rel));
    } else if (d.isFile()) out.push(rel);
  }
  return out;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.m?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** 属性值是写死的字符串时取出来（"x"、{'x'}、{`x`}）；动态值返回 undefined */
function literalOf(init: ts.Node | undefined): string | undefined {
  if (!init) return undefined;
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) return literalOf(init.expression);
  if (ts.isParenthesizedExpression(init)) return literalOf(init.expression);
  return undefined;
}

const nameText = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : undefined;

function jsxAttrs(el: ts.JsxOpeningLikeElement): { names: Map<string, ts.JsxAttribute>; spread: boolean } {
  const names = new Map<string, ts.JsxAttribute>();
  let spread = false;
  for (const p of el.attributes.properties) {
    if (ts.isJsxSpreadAttribute(p)) spread = true;
    else names.set(p.name.getText(), p);
  }
  return { names, spread };
}

const tagOf = (el: ts.JsxOpeningLikeElement, sf: ts.SourceFile): string => el.tagName.getText(sf);

/** 可能是 true 的值：true、变量、条件、调用这类表达式。字符串、数字、数组、对象、false、null 不算（如映射表里的 danger: 'error'） */
const isBoolish = (e: ts.Expression): boolean =>
  e.kind === ts.SyntaxKind.TrueKeyword ||
  ts.isIdentifier(e) ||
  ts.isConditionalExpression(e) ||
  ts.isBinaryExpression(e) ||
  ts.isCallExpression(e) ||
  ts.isPropertyAccessExpression(e) ||
  ts.isElementAccessExpression(e) ||
  ts.isPrefixUnaryExpression(e) ||
  (ts.isParenthesizedExpression(e) && isBoolish(e.expression));

/** JSX 文本的空白规则：各行去掉行首（首行除外）与行尾（末行除外）的空白，空行丢掉，其余行用一个空格连起来 */
function jsxTextValue(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  lines.forEach((l, i) => {
    let t = l;
    if (i > 0) t = t.trimStart();
    if (i < lines.length - 1) t = t.trimEnd();
    if (t) kept.push(t);
  });
  return kept.join(' ');
}

/** 模块名：import / export … from、import x = require()、declare module、import('x')、require('x')、类型位置的 import('x') */
function isModuleName(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
  const p = node.parent;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isModuleDeclaration(p)) return true;
  if (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent)) return true;
  return (
    ts.isCallExpression(p) &&
    p.arguments[0] === node &&
    (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === 'require'))
  );
}

/** 去掉括号、非空断言、as、satisfies，看里面的表达式 */
function unwrapExpr(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x))
    x = x.expression;
  return x;
}

/** 名字的作用范围：声明所在的块、函数、循环或文件（不变量 17 的别名，按名字认，不做完整的作用域分析） */
function scopeOf(n: ts.Node): ts.Node {
  let x = n.parent;
  while (
    !(
      ts.isBlock(x) ||
      ts.isSourceFile(x) ||
      ts.isModuleBlock(x) ||
      ts.isCaseClause(x) ||
      ts.isDefaultClause(x) ||
      ts.isFunctionLike(x) ||
      ts.isIterationStatement(x, false)
    )
  )
    x = x.parent;
  return x;
}
/** 名字 → 声明它的范围；一个引用在某个范围里面才算 */
type Scoped = Map<string, ts.Node[]>;
const addScoped = (m: Scoped, name: string, scope: ts.Node): void => void m.set(name, [...(m.get(name) ?? []), scope]);
function inScope(m: Scoped, id: ts.Identifier): boolean {
  const scopes = m.get(id.text);
  if (!scopes) return false;
  for (let x: ts.Node | undefined = id.parent; x; x = x.parent) if (scopes.includes(x)) return true;
  return false;
}
const MEMBERSHIP = new Set(['includes', 'indexOf', 'lastIndexOf', 'has']);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const MSG_HANDED_OVER = '不变量 17：读了 handedOver；会话状态只经 src/shared/conversation.ts 的 conversationState 判定';
const MSG_STAGE_PAID = "不变量 17：拿 stage 和 'paid' 比；会话状态只经 src/shared/conversation.ts 的 conversationState 判定";

/** LEGACY 里实际放过的「文件\0词」，用来查名单里过时的项 */
const legacyUsed = new Set<string>();

function checkFile(file: string, source: string, hits: Hit[]): void {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const isPack = isPackConfig(file);
  const inSpecimen = file.startsWith(SPECIMEN_DIR);
  const scanText = !inSpecimen && !SELFTEST.test(file);
  const inConsole = file.startsWith('console/src/');
  const scanVocab = inConsole && scanText;
  const hit = (node: ts.Node, msg: string, offset = 0): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf) + offset);
    hits.push({ file, line: line + 1, col: character + 1, msg });
  };

  // ---------- 不变量 17：stage 与 'paid'，连同同一个文件里存着它们的名字 ----------
  const stageNames: Scoped = new Map(); // 存着 stage 的变量、参数
  const paidNames: Scoped = new Map(); // 值是 'paid' 的常量
  const paidLists: Scoped = new Map(); // 含 'paid' 的数组、Set
  /** stage、x.stage、x?.stage、x['stage']，或存着它的名字 */
  const isStageRef = (e: ts.Expression): boolean => {
    const x = unwrapExpr(e);
    if (ts.isIdentifier(x)) return x.text === 'stage' || inScope(stageNames, x);
    if (ts.isPropertyAccessExpression(x)) return x.name.text === 'stage';
    if (ts.isElementAccessExpression(x)) return literalOf(x.argumentExpression) === 'stage';
    return false;
  };
  const isPaid = (e: ts.Expression): boolean => {
    const x = unwrapExpr(e);
    return literalOf(x) === 'paid' || (ts.isIdentifier(x) && inScope(paidNames, x));
  };
  const isPaidList = (e: ts.Expression): boolean => {
    const x = unwrapExpr(e);
    if (ts.isArrayLiteralExpression(x)) return x.elements.some(isPaid);
    if (ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'Set' && x.arguments?.[0])
      return isPaidList(x.arguments[0]);
    return ts.isIdentifier(x) && inScope(paidLists, x);
  };
  /** 按源码顺序收名字，后面的别名可以接前面的（const t = s） */
  const collectNames = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const scope = scopeOf(node);
      if (isStageRef(node.initializer)) addScoped(stageNames, node.name.text, scope);
      else if (isPaid(node.initializer)) addScoped(paidNames, node.name.text, scope);
      else if (isPaidList(node.initializer)) addScoped(paidLists, node.name.text, scope);
    }
    if (ts.isBindingElement(node) && nameText(node.propertyName) === 'stage' && ts.isIdentifier(node.name))
      addScoped(stageNames, node.name.text, scopeOf(node));
    // 表格列 { dataIndex: 'stage', render: (s) => … }：render 的第一个参数就是 stage
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (k: string) => node.properties.find((p) => nameText(p.name) === k);
      const index = prop('dataIndex');
      const render = prop('render');
      if (index && ts.isPropertyAssignment(index) && literalOf(index.initializer) === 'stage' && render) {
        const fn = ts.isPropertyAssignment(render) ? unwrapExpr(render.initializer) : render;
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) {
          const first = fn.parameters[0];
          if (first && ts.isIdentifier(first.name)) addScoped(stageNames, first.name.text, fn);
        }
      }
    }
    ts.forEachChild(node, collectNames);
  };
  if (inConsole) collectNames(sf);

  // ---------- 不变量 11：写死的行业包词汇（整串比对） ----------
  const legacy = LEGACY[file];
  const vocabHits = (node: ts.Node, text: string): void => {
    const t = text.trim();
    const what = VOCAB.get(t);
    if (!what || SESSION_STATES.has(t)) return;
    const generic = Object.hasOwn(GENERIC, t) ? GENERIC[t] : undefined;
    if (typeof generic === 'string') return;
    if (generic?.only.includes(file)) {
      genericUsed.add(`${file}\0${t}`);
      return;
    }
    if (legacy?.terms.includes(t)) {
      legacyUsed.add(`${file}\0${t}`);
      return;
    }
    hit(node, `不变量 11：写死了行业包的词「${t}」（${what.join('、')}）；console 只经 /pack 的数据认识行业包`);
  };

  // ---------- 不变量 9：界面字符串里的手打空格 ----------
  const textHits = (node: ts.Node, text: string, leftOpen: boolean, rightOpen: boolean, raw?: string): void => {
    const where = (fragment: string): number => (raw ? Math.max(0, raw.indexOf(fragment)) : 0);
    for (const m of text.matchAll(INNER_SPACE)) {
      const before = text.slice(0, m.index + 1);
      const after = text.slice(m.index + m[0].length - 1);
      if (DATE_TIME.test(before) && TIME_START.test(after)) continue;
      hit(node, `不变量 9：中文与数字、拉丁字母之间手打了空格「${m[0]}」（由 text-autospace 补）`, where(m[0]));
    }
    if (leftOpen && LEAD_SPACE.test(text)) hit(node, `不变量 9：插值后面、中文前面手打了空格「${text.slice(0, 8)}」`);
    const tail = rightOpen ? TAIL_SPACE.exec(text) : null;
    if (tail && !DATE_TIME.test(tail[1]!)) hit(node, `不变量 9：中文后面、插值前面手打了空格「${text.slice(-8)}」`, where(tail[0]));
  };
  const isPlaceholderExample = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean => {
    const p = node.parent;
    const owner = ts.isJsxAttribute(p) ? p.name.getText(sf) : ts.isPropertyAssignment(p) ? nameText(p.name) : undefined;
    return owner === 'placeholder' && node.text.startsWith('例：');
  };
  /** 行业包里话术节的 heading：要和 SOP 文件里的标题逐字相同（节表按它对上），是租户的话术内容，不是标签、帮助、说明 */
  const isSopHeading = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean =>
    isPack && ts.isPropertyAssignment(node.parent) && nameText(node.parent.name) === 'heading';
  const isConcat = (node: ts.Node): boolean => {
    const p = node.parent;
    return ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken;
  };

  const primaryCount = (node: ts.Node): number => {
    if (ts.isJsxElement(node)) return tagOf(node.openingElement, sf) === 'PrimaryButton' ? 1 : 0;
    if (ts.isJsxSelfClosingElement(node)) return tagOf(node, sf) === 'PrimaryButton' ? 1 : 0;
    if (ts.isJsxFragment(node)) return node.children.reduce((s, c) => s + primaryCount(c), 0);
    if (ts.isJsxExpression(node)) return node.expression ? primaryCount(node.expression) : 0;
    if (ts.isParenthesizedExpression(node)) return primaryCount(node.expression);
    if (ts.isConditionalExpression(node)) return Math.max(primaryCount(node.whenTrue), primaryCount(node.whenFalse));
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    )
      return primaryCount(node.right);
    return 0;
  };

  const visit = (node: ts.Node): void => {
    // ----- JSX 元素：2、3、6、28 -----
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagOf(node, sf);
      const { names, spread } = jsxAttrs(node);
      const val = (n: string): string | undefined => literalOf(names.get(n)?.initializer);
      if (val('type') === 'primary') hit(names.get('type')!, '不变量 2：type="primary"，主按钮用 parts/PrimaryButton.tsx');
      if (val('variant') === 'solid' && file !== PRIMARY_FILE && file !== DANGER_FILE)
        hit(names.get('variant')!, '不变量 2：实心按钮只在墨色主按钮组件（parts/PrimaryButton.tsx）和 ConfirmDanger 里');
      if (tag === 'Modal' && !names.has('footer') && !spread)
        hit(node, '不变量 2：<Modal> 没写 footer，自带的确定按钮是 antd 的 primary；写 footer，主按钮用 PrimaryButton');
      if (tag === 'Popconfirm')
        hit(node, '不变量 2：Popconfirm 自带 primary 按钮；危险操作用 ConfirmDanger，其余写成 Modal 加 PrimaryButton');
      if (file !== DANGER_FILE) {
        if (names.has('danger')) hit(names.get('danger')!, '不变量 3：danger 属性只准出现在 parts/ConfirmDanger.tsx 里');
        if (val('color') === 'danger') hit(names.get('color')!, '不变量 3：color="danger" 只准出现在 parts/ConfirmDanger.tsx 里');
      }
      if (val('okType') === 'danger') hit(names.get('okType')!, '不变量 3：okType="danger"，危险确认用 ConfirmDanger');
      if (tag === 'Tag' && names.has('color')) hit(names.get('color')!, '不变量 6：带 color 的 Tag，状态用 parts/Status.tsx');
      if (tag === 'Badge' && (names.has('count') || names.has('status')))
        hit(node, '不变量 6：<Badge count / status>，状态用 parts/Status.tsx（数字徽标另有组件）');
      if (names.has('dangerouslySetInnerHTML')) hit(names.get('dangerouslySetInnerHTML')!, '不变量 28：dangerouslySetInnerHTML');
    }
    // ----- 一个操作区至多一个主按钮（2） -----
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && !inSpecimen) {
      let seen = 0;
      for (const child of node.children) {
        seen += primaryCount(child);
        if (seen > 1) {
          hit(child, '不变量 2：同一个父元素下有不止一个 <PrimaryButton>，每个操作区至多一个主按钮');
          break;
        }
      }
    }
    // ----- 对象字面量：2、3 -----
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = nameText(node.name);
      const init = ts.isPropertyAssignment(node) ? node.initializer : undefined;
      const lit = literalOf(init);
      if (key === 'type' && lit === 'primary') hit(node, "不变量 2：type: 'primary'，主按钮用 parts/PrimaryButton.tsx");
      if (key === 'okType' && lit === 'danger') hit(node, "不变量 3：okType: 'danger'，危险确认用 ConfirmDanger");
      if (key === 'danger' && (!init || isBoolish(init)))
        hit(node, '不变量 3：对象里的 danger 键（菜单项不设 danger: true；危险操作走 ConfirmDanger）');
    }
    // ----- import：2、4 -----
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'antd') {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named))
        for (const el of named.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === 'Popconfirm') hit(el, '不变量 2：Popconfirm 自带 primary 按钮；危险操作用 ConfirmDanger');
          if ((imported === 'message' || imported === 'notification') && file !== TOAST_FILE)
            hit(el, `不变量 4：从 antd import ${imported}；成功提示只经 parts/toast.tsx 的 toast()`);
        }
    }
    // ----- 调用：2、4、28 -----
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const obj = node.expression.expression;
      const objName = ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : undefined;
      if ((objName === 'message' || objName === 'notification') && method === 'error')
        hit(node, `不变量 4：${objName}.error(，错误就地显示（ErrorAlert、StateView），不用 toast`);
      else if ((objName === 'message' || objName === 'notification') && ts.isIdentifier(obj) && file !== TOAST_FILE)
        hit(node, `不变量 4：${objName}.${method}(，成功提示只经 parts/toast.tsx 的 toast()`);
      if ((objName === 'Modal' || objName === 'modal') && ['confirm', 'info', 'success', 'warning', 'error'].includes(method))
        hit(node, `不变量 2：${objName}.${method}( 自带 primary 按钮；写成 Modal 加 PrimaryButton，危险操作用 ConfirmDanger`);
      const first = node.arguments[0];
      if (method === 'setAttribute' && first && literalOf(first)?.toLowerCase() === 'style') hit(node, "不变量 28：setAttribute('style'");
      if (method === 'insertAdjacentHTML') hit(node, '不变量 28：insertAdjacentHTML');
    }
    // ----- 属性访问：4、6、8、28 -----
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === 'detail' && file !== TECH_FILE) hit(node.name, '不变量 8：读了 detail；服务端的 detail 只由 parts/TechDetails.tsx 读');
      if (name === 'cssText') hit(node.name, '不变量 28：style.cssText');
      if (name === 'innerHTML' || name === 'outerHTML') hit(node.name, `不变量 28：${name}`);
      if (name === 'Button' && ts.isIdentifier(node.expression) && node.expression.text === 'Radio' && !ts.isJsxClosingElement(node.parent))
        hit(node, '不变量 6：Radio.Button，单选用 Segmented，状态用 parts/Status.tsx');
      if ((name === 'message' || name === 'notification') && file !== TOAST_FILE && ts.isCallExpression(node.expression)) {
        const callee = node.expression.expression.getText(sf);
        if (callee.endsWith('useApp')) hit(node, `不变量 4：从 useApp() 取 ${name}；成功提示只经 parts/toast.tsx 的 toast()`);
      }
    }
    if (ts.isElementAccessExpression(node) && literalOf(node.argumentExpression) === 'detail' && file !== TECH_FILE)
      hit(node, '不变量 8：读了 detail；服务端的 detail 只由 parts/TechDetails.tsx 读');
    // ----- 解构：4、8 -----
    if (ts.isBindingElement(node)) {
      const key = nameText(node.propertyName) ?? nameText(node.name);
      if (key === 'detail' && file !== TECH_FILE) hit(node, '不变量 8：解构出 detail；服务端的 detail 只由 parts/TechDetails.tsx 读');
      if ((key === 'message' || key === 'notification') && file !== TOAST_FILE) {
        let decl: ts.Node = node.parent;
        while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
        const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
        if (init && ts.isCallExpression(init) && init.expression.getText(sf).endsWith('useApp'))
          hit(node, `不变量 4：从 useApp() 取 ${key}；成功提示只经 parts/toast.tsx 的 toast()`);
      }
    }
    // ----- 会话状态：17 -----
    if (inConsole) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'handedOver') hit(node.name, MSG_HANDED_OVER);
      if (ts.isBindingElement(node) && (nameText(node.propertyName) ?? nameText(node.name)) === 'handedOver') hit(node, MSG_HANDED_OVER);
      // 按名字引用：r['handedOver']、'handedOver' in r、表格列的 dataIndex: 'handedOver'、Pick<…, 'handedOver'>
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'handedOver' && !isModuleName(node))
        hit(node, MSG_HANDED_OVER);
      if (
        ts.isBinaryExpression(node) &&
        EQUALITY.has(node.operatorToken.kind) &&
        ((isStageRef(node.left) && isPaid(node.right)) || (isPaid(node.left) && isStageRef(node.right)))
      )
        hit(node, MSG_STAGE_PAID);
      if (ts.isCaseClause(node) && isPaid(node.expression) && isStageRef(node.parent.parent.expression)) hit(node, MSG_STAGE_PAID);
      // ['paid'].includes(stage)、new Set(['paid']).has(stage)、PAID_LIST.indexOf(stage)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        MEMBERSHIP.has(node.expression.name.text) &&
        node.arguments[0] &&
        isStageRef(node.arguments[0]) &&
        isPaidList(node.expression.expression)
      )
        hit(node, MSG_STAGE_PAID);
    }
    // ----- 行业包词汇：11 -----
    if (scanVocab) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isModuleName(node)) vocabHits(node, node.text);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) vocabHits(node, node.text);
      else if (ts.isJsxText(node)) vocabHits(node, jsxTextValue(node.getFullText(sf)));
      // 对象字面量里不带引号的属性名（含简写 { quote }）：和带引号的一样是运行时的键
      else if (
        ts.isIdentifier(node) &&
        ts.isObjectLiteralElementLike(node.parent) &&
        node.parent.name === node &&
        ts.isObjectLiteralExpression(node.parent.parent)
      )
        vocabHits(node, node.text);
    }
    // ----- 字符串：9 -----
    if (scanText) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const inImport =
          ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isExternalModuleReference(node.parent);
        if (!inImport && !isPlaceholderExample(node) && !isSopHeading(node)) textHits(node, node.text, isConcat(node), isConcat(node));
      } else if (ts.isTemplateExpression(node)) {
        const concat = isConcat(node);
        textHits(node.head, node.head.text, concat, true);
        node.templateSpans.forEach((span, i) => {
          const last = i === node.templateSpans.length - 1;
          textHits(span.literal, span.literal.text, true, !last || concat);
        });
      } else if (ts.isJsxText(node) && !isPack) {
        const raw = node.getFullText(sf);
        const text = jsxTextValue(raw);
        if (text) {
          const siblings = ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent) ? node.parent.children : undefined;
          const idx = siblings ? siblings.indexOf(node) : -1;
          const leftOpen = idx > 0 && !/^\s*\n/.test(raw);
          const rightOpen = !!siblings && idx < siblings.length - 1 && !/\n\s*$/.test(raw);
          textHits(node, text, leftOpen, rightOpen, raw);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const consoleFiles = walk('console/src').filter((f) => CODE.test(f));
const packFiles = [...walk('src/packs'), ...walk(PACK_FIXTURES)].filter(isPackConfig);
const hits: Hit[] = [];
for (const file of [...consoleFiles, ...packFiles].toSorted()) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (isPackConfig(file)) {
    // 行业包配置只查不变量 9 的字符串（它不渲染界面，其余几条管不到它）
    const only: Hit[] = [];
    checkFile(file, source, only);
    hits.push(...only.filter((h) => h.msg.startsWith('不变量 9')));
  } else checkFile(file, source, hits);
}

// 名单本身：词表要真的有注册包和假包；白名单与旧页面名单里不再撞上的项要删掉
const SELF = 'scripts/check-console-src.ts';
const problems: string[] = [];
if (!PACKS.some((p) => !p.who.endsWith('（假包）'))) problems.push(`${SELF}  src/packs/registry.ts 里一个包都没有，不变量 11 的词表是空的`);
if (!PACKS.some((p) => p.who.endsWith('（假包）')))
  problems.push(`${SELF}  ${PACK_FIXTURES}/ 下没找到导出的行业包，不变量 11 的词表漏了假包`);
for (const [t, g] of Object.entries(GENERIC)) {
  if (!VOCAB.has(t)) problems.push(`${SELF}  GENERIC 里的「${t}」已经不是任何行业包的词，删掉这一项`);
  else if (typeof g !== 'string' && !g.only.some((f) => genericUsed.has(`${f}\0${t}`)))
    problems.push(`${SELF}  GENERIC 只在 ${g.only.join('、')} 里放过「${t}」，这些文件里已经没有它了，删掉这一项`);
}
for (const [file, { terms, until }] of Object.entries(LEGACY))
  for (const t of terms)
    if (!legacyUsed.has(`${file}\0${t}`))
      problems.push(`${SELF}  LEGACY 放过 ${file} 里的「${t}」，这个文件里已经没有它了（${until}），删掉这一项`);

if (hits.length || problems.length) {
  console.error('console-src: 违反了后台 UX spec（docs/features/console-ux/spec.md）的不变量：');
  for (const h of hits.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col))
    console.error(`  ${h.file}:${h.line}:${h.col}  ${h.msg}`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `console-src: ${consoleFiles.length} 个 console 文件、${packFiles.length} 个行业包配置，不变量 2、3、4、6、8、9、11、17、28 都没有违反` +
    `（行业包词表 ${VOCAB.size} 个词，来自${PACKS.map((p) => p.who).join('、')}）`,
);
