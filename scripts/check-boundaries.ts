// import 边界与字符串禁区（docs/architecture/01-pg-config-console/spec.md「模块与依赖方向」，验收 20）。
// 挂在 `pnpm lint` 里，规则写成下面两张表，后面的阶段往表里加。
//
// 查的是工作区里的代码文件：已跟踪的加上没被忽略的新文件（git ls-files -co），新建还没 add 的也要拦。
// 不在 git 工作区根目录时（deploy.sh 在 git archive 解出的目录里跑门禁），改查目录树，
// 跳过 node_modules、.git、var、dist。
//
// import 用 TypeScript 的解析器读：import / import type / export … from / 副作用 import / 动态 import('x') /
// import x = require('x') / require('x') / 类型位置的 import('x')。相对路径解析成仓库内路径，
// `.js` 对应同名的 `.ts`。字符串规则按原文查，注释也算。
//
// 可选参数：要检查的仓库根目录（给自测夹具用），默认当前目录。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

if (process.argv[2]) process.chdir(process.argv[2]);

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'var', 'dist']);

/** 一处 import。pkg 是 npm 包名（含 node: 内置），target 是解析出的仓库内路径，两者至多一个非空 */
interface Imp {
  line: number;
  spec: string;
  typeOnly: boolean;
  pkg: string | null;
  target: string | null;
}

interface ImportRule {
  desc: string;
  /** 这条规则管不管这个文件 */
  applies: (file: string) => boolean;
  bad: (imp: Imp) => boolean;
}

interface TextRule {
  desc: string;
  files: (file: string) => boolean;
  allowed: (file: string) => boolean;
  re: RegExp;
}

const DB_PKGS = new Set(['pg', 'drizzle-orm', '@electric-sql/pglite']);
const RUNTIME = new Set(['src/store.ts', 'src/tools.ts', 'src/engine.ts', 'src/retrieval.ts', 'src/llm.ts']);
const CONFIG_LAYER = ['src/config/', 'src/db/', 'src/sop/', 'src/prompt/', 'src/auth/', 'src/cli/'];

const under = (p: string | null, dir: string) => p !== null && p.startsWith(dir);
const isSelftest = (p: string) => p.endsWith('.selftest.ts');

const IMPORT_RULES: ImportRule[] = [
  {
    desc: 'pg / drizzle-orm / @electric-sql/pglite 只能在 src/db/ 里 import',
    applies: (f) => !under(f, 'src/db/'),
    bad: (i) => i.pkg !== null && DB_PKGS.has(i.pkg),
  },
  {
    desc: 'src/shared/ 只能 import zod 和 src/shared/，import type 也一样',
    applies: (f) => under(f, 'src/shared/'),
    bad: (i) => (i.pkg !== null ? i.pkg !== 'zod' : !under(i.target, 'src/shared/')),
  },
  {
    desc: 'console/src/ 在仓库里只能 import src/shared/，外加用 import type 引 src/console-api/app.ts',
    applies: (f) => under(f, 'console/src/'),
    bad: (i) =>
      i.pkg === null &&
      !under(i.target, 'console/') &&
      !under(i.target, 'src/shared/') &&
      !(i.typeOnly && i.target === 'src/console-api/app.ts'),
  },
  {
    desc: 'src/db/testing.ts 只能被 *.selftest.ts 和 eval/run.ts import',
    applies: (f) => !isSelftest(f) && f !== 'eval/run.ts',
    bad: (i) => i.target === 'src/db/testing.ts',
  },
  {
    desc: 'src/prompt/ 与 src/sop/ 不能 import src/db/ 和 src/config/',
    applies: (f) => under(f, 'src/prompt/') || under(f, 'src/sop/'),
    bad: (i) => under(i.target, 'src/db/') || under(i.target, 'src/config/'),
  },
  {
    // 自测要动态 import 运行时模块来搭场景，这一条不管 *.selftest.ts（上面几条照管）
    desc: '配置层不能 import store / tools / engine / retrieval / llm / adapters，工具定义从 tool-defs 取',
    applies: (f) => CONFIG_LAYER.some((d) => under(f, d)) && !isSelftest(f),
    bad: (i) => (i.target !== null && RUNTIME.has(i.target)) || under(i.target, 'src/adapters/'),
  },
];

// 规则说明里的两个禁词拆开拼，免得本文件自己命中
const GUC = ['app', 'tenant_id'].join('.');
const SQL_RAW = ['sql', 'raw'].join('.');

const TEXT_RULES: TextRule[] = [
  {
    desc: `租户 GUC 名 ${GUC} 只能出现在 src/db/client.ts 和迁移 SQL 里`,
    files: (f) => CODE_EXT.test(f) || f.endsWith('.sql'),
    // src/db/ 下的自测要亲手 SET 它，才测得出会话级泄漏
    allowed: (f) => f === 'src/db/client.ts' || (under(f, 'src/db/') && isSelftest(f)) || (under(f, 'drizzle/') && f.endsWith('.sql')),
    // 两段各自带引号、点两边有空格的写法也算
    re: /\bapp["'`]?\s*\.\s*["'`]?tenant_id\b/gi,
  },
  {
    desc: `禁用 drizzle 的 ${SQL_RAW}`,
    files: (f) => CODE_EXT.test(f),
    allowed: () => false,
    re: /\bsql\s*\.\s*raw\b/g,
  },
];

/** 当前目录是否就是一个 git 工作区的根 */
function atGitRoot(): boolean {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return fs.realpathSync(top.trim()) === fs.realpathSync('.');
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function walk(dir = ''): string[] {
  const files: string[] = [];
  for (const d of fs.readdirSync(dir || '.', { withFileTypes: true })) {
    const p = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) files.push(...walk(p));
    } else if (d.isFile()) files.push(p);
  }
  return files;
}

function listFiles(): string[] {
  if (!atGitRoot()) return walk();
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  // 冲突时同一路径会出现多次；已删除但还在索引里的文件、子模块目录都不是要查的文件
  return [...new Set(out.split('\0'))].filter((p) => p && isFile(p));
}

const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

function resolve(from: string, spec: string): { pkg: string | null; target: string | null } {
  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const ext = path.posix.extname(base);
    const mapped = JS_TO_TS[ext];
    const cands = mapped
      ? mapped.map((e) => base.slice(0, -ext.length) + e)
      : [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    // 目标还不存在时按最可能的那个算，照样套规则
    return { pkg: null, target: cands.find(isFile) ?? (mapped || ext ? cands[0] : `${base}.ts`) };
  }
  // 绝对路径当成解析不了的文件：只有 src/shared/ 与 console/src/ 两条会拦它
  if (spec.startsWith('/')) return { pkg: null, target: null };
  const parts = spec.split('/');
  return { pkg: spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0], target: null };
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function importsOf(file: string, text: string): Imp[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const found: Imp[] = [];
  const add = (lit: ts.Node | undefined, typeOnly: boolean) => {
    if (!lit || !ts.isStringLiteralLike(lit)) return;
    const line = sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1;
    found.push({ line, spec: lit.text, typeOnly, ...resolve(file, lit.text) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, node.importClause?.isTypeOnly ?? false);
    else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression, node.isTypeOnly);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0], false);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const files = listFiles()
  .filter((p) => !p.split('/').includes('node_modules'))
  .toSorted();
const hits: string[] = [];
let codeFiles = 0;
let importCount = 0;

for (const file of files) {
  const isCode = CODE_EXT.test(file);
  const textRules = TEXT_RULES.filter((r) => r.files(file) && !r.allowed(file));
  if (!isCode && !textRules.length) continue;
  const text = fs.readFileSync(file, 'utf8');
  const found: [number, string][] = [];
  if (isCode) {
    codeFiles++;
    const rules = IMPORT_RULES.filter((r) => r.applies(file));
    const imps = importsOf(file, text);
    importCount += imps.length;
    for (const imp of imps) {
      for (const r of rules) if (r.bad(imp)) found.push([imp.line, `${r.desc}（'${imp.spec}'）`]);
    }
  }
  for (const r of textRules) {
    const lines = new Set<number>();
    for (const m of text.matchAll(r.re)) lines.add(text.slice(0, m.index).split('\n').length);
    for (const n of lines) found.push([n, r.desc]);
  }
  for (const [n, desc] of found.toSorted((a, b) => a[0] - b[0])) hits.push(`  ${file}:${n}  ${desc}`);
}

if (hits.length) {
  console.error('boundaries: 越过了 01 spec「模块与依赖方向」的边界：');
  for (const h of hits) console.error(h);
  process.exit(1);
}
console.log(`boundaries: ${codeFiles} 个代码文件、${importCount} 处 import，没有越界`);
