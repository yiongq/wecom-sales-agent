// 迁移检查（docs/architecture/01-pg-config-console/spec.md「迁移纪律」，验收 20），挂在 `pnpm lint` 里。
// 迁移只增不删：回滚到 :prev 时，上一版镜像要能在新 schema 上读和写。
//
// A. drizzle/*.sql 里的破坏性语句，规则见 RULES。先去掉注释和字符串再匹配；CREATE FUNCTION / PROCEDURE
//    的 $$ 函数体不是在执行 DDL，不查。DO 块的函数体要查（单引号写的函数体也算），而且函数体里每个
//    字符串、$$ 字面量的内容都当 SQL 再查一遍（嵌套的引号一层层剥开），拼在 EXECUTE 里的 DDL 也躲不过；
//    DO 块里出现 EXECUTE 本身就算一条（规则名 execute）：动态 SQL 静态查不全，必须标注。
//    确实要做的，在语句正上方紧挨着的 -- 注释行（或语句首行行尾的 -- 注释）里标注，
//    规则名可以写几个，原因不能省：
//      -- migration-allow: drop, revoke 原因
// B. 和基准（git merge-base HEAD origin/dev）比：基准上已有的 drizzle/*.sql 一个字节都不许改、不许删；
//    journal 里基准已有的条目（按 idx 对）不许改。
// C. journal：idx 从 0 连续、when 严格递增、每条都有对应的 .sql、每个 .sql 都在 journal 里；新条目的 when
//    必须大于基准上最大的 when（drizzle 只应用比库里最后一条更晚的迁移，乱序的会被静默跳过）。
// 取不到基准时（没有 origin/dev，或 deploy.sh 在 git archive 解出的目录里跑）CI 下失败，
// 本地只 warn，跳过和基准有关的检查。
//
// 可选参数：要检查的仓库根目录（给自测夹具用），默认当前目录。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

if (process.argv[2]) process.chdir(process.argv[2]);

const DIR = 'drizzle';
const JOURNAL = `${DIR}/meta/_journal.json`;

// ---------- A. 破坏性语句 ----------

const ALTER_TABLE = /\bALTER TABLE\b/;

/** 在 ALTER TABLE 里加列：带 NOT NULL（或主键）却没有 DEFAULT，旧镜像插入时不给这一列就会失败 */
function addsNotNullColumn(stmt: string): boolean {
  if (!ALTER_TABLE.test(stmt)) return false;
  return topLevelParts(stmt).some((part) => {
    const m = /\bADD (?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|CHECK\b|FOREIGN\b|EXCLUDE\b)/.exec(part);
    if (!m) return false;
    const col = part.slice(m.index);
    return /\bNOT NULL\b|\bPRIMARY KEY\b/.test(col) && !/\bDEFAULT\b|\bGENERATED\b|\b(?:SMALL|BIG)?SERIAL[248]?\b/.test(col);
  });
}

/** 输入是去掉注释和字符串、压成单空格、转成大写的语句。doOnly 的只查 DO 块的函数体 */
const RULES: { name: string; test: (s: string) => boolean; doOnly?: boolean }[] = [
  { name: 'drop', test: (s) => /\bDROP\b/.test(s) },
  { name: 'rename', test: (s) => /\bRENAME\b/.test(s) },
  {
    name: 'alter-type',
    test: (s) => ALTER_TABLE.test(s) && /\bALTER (?:COLUMN )?(?!COLUMN\b|TABLE\b)\S+ (?:SET DATA )?TYPE\b/.test(s),
  },
  { name: 'add-not-null', test: addsNotNullColumn },
  { name: 'set-not-null', test: (s) => /\bSET NOT NULL\b/.test(s) },
  // CREATE TABLE 里的 CHECK 是新表，不拦；给已有的表加 CHECK，旧镜像的写入可能被拒
  { name: 'add-check', test: (s) => /\bALTER (?:TABLE|DOMAIN)\b/.test(s) && /\bCHECK\b/.test(s) },
  { name: 'create-or-replace', test: (s) => /\bCREATE OR REPLACE\b/.test(s) },
  { name: 'alter-policy', test: (s) => /\bALTER POLICY\b/.test(s) },
  { name: 'revoke', test: (s) => /\bREVOKE\b/.test(s) },
  // 动态 SQL 静态查不全，一律要标注。EXECUTE ON（权限名）与 EXECUTE FUNCTION（触发器）不是动态 SQL
  { name: 'execute', test: (s) => /\bEXECUTE\b(?! (?:ON|FUNCTION|PROCEDURE)\b)/.test(s), doOnly: true },
];
const CREATE_FN = /\bCREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE)\b/;
const RULE_NAMES = new Set(RULES.map((r) => r.name));

type Kind = 'ws' | 'line' | 'block' | 'str' | 'ident' | 'dollar' | 'semi' | 'word' | 'other';
/** [s, e) 是 token 在 src 里的位置；dollar 另记内容 [bs, be)；esc 表示 E'…' 字符串 */
interface Tok {
  k: Kind;
  s: number;
  e: number;
  bs: number;
  be: number;
  esc: boolean;
}
/** 一条语句：toks 里 [a, z)，f 是第一个实义 token；[a, f) 是它前面的空白和注释 */
interface Stmt {
  a: number;
  f: number;
  z: number;
}

const TRIVIA = new Set<Kind>(['ws', 'line', 'block']);
const DOLLAR = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_$]*/uy;
const BREAKPOINT = '--> statement-breakpoint';

function lex(src: string, from: number, to: number): Tok[] {
  const toks: Tok[] = [];
  let i = from;
  // 截到 to 为止，DO 块函数体末尾的词不会吞掉收尾的 $$
  const lim = src.slice(0, to);
  const sticky = (re: RegExp) => {
    re.lastIndex = i;
    return re.exec(lim)?.[0] ?? null;
  };
  while (i < to) {
    const s = i;
    const c = src[i];
    let k: Kind = 'other';
    let bs = 0;
    let be = 0;
    let esc = false;
    let m: string | null;
    if (/\s/.test(c)) {
      while (i < to && /\s/.test(src[i])) i++;
      k = 'ws';
    } else if (src.startsWith('--', i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 || nl > to ? to : nl;
      k = 'line';
    } else if (src.startsWith('/*', i)) {
      // PG 的块注释可以嵌套
      let depth = 0;
      while (i < to) {
        if (src.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (src.startsWith('*/', i)) {
          i += 2;
          if (--depth === 0) break;
        } else i++;
      }
      k = 'block';
    } else if (c === "'") {
      // E'…' 里反斜杠是转义；普通字符串只有 '' 一种转义
      const prev = toks.at(-1);
      esc = prev?.k === 'word' && prev.e === i && /^[eE]$/.test(src.slice(prev.s, prev.e));
      i++;
      while (i < to) {
        if (esc && src[i] === '\\') i += 2;
        else if (src[i] !== "'") i++;
        else if (src[i + 1] === "'") i += 2;
        else {
          i++;
          break;
        }
      }
      k = 'str';
    } else if (c === '"') {
      i++;
      while (i < to) {
        if (src[i] !== '"') i++;
        else if (src[i + 1] === '"') i += 2;
        else {
          i++;
          break;
        }
      }
      k = 'ident';
    } else if (c === '$' && (m = sticky(DOLLAR))) {
      const close = src.indexOf(m, i + m.length);
      bs = i + m.length;
      be = close === -1 || close + m.length > to ? to : close;
      i = be === to ? to : close + m.length;
      k = 'dollar';
    } else if ((m = sticky(WORD))) {
      i += m.length;
      k = 'word';
    } else {
      i++;
      if (c === ';') k = 'semi';
    }
    toks.push({ k, s, e: Math.min(i, to), bs, be, esc });
  }
  return toks;
}

/** 按 ; 和 drizzle 的 statement-breakpoint 切语句 */
function split(src: string, toks: Tok[]): Stmt[] {
  const out: Stmt[] = [];
  let a = 0;
  let f = -1;
  toks.forEach((t, j) => {
    const breakpoint = t.k === 'line' && src.startsWith(BREAKPOINT, t.s);
    if (t.k === 'semi' || (breakpoint && f >= 0)) {
      if (f >= 0) out.push({ a, f, z: j });
      a = j + 1;
      f = -1;
    } else if (f < 0 && !TRIVIA.has(t.k)) f = j;
  });
  if (f >= 0) out.push({ a, f, z: toks.length });
  return out;
}

function lineAt(src: string, pos: number): number {
  return src.slice(0, pos).split('\n').length;
}

function startsLine(src: string, pos: number): boolean {
  return src.slice(src.lastIndexOf('\n', pos - 1) + 1, pos).trim() === '';
}

/** 语句正上方紧挨着、各占一行的 -- 注释，加上语句首行行尾的 -- 注释 */
function annotations(src: string, toks: Tok[], st: Stmt): Tok[] {
  const found: Tok[] = [];
  for (let j = st.f - 1; j >= st.a; j--) {
    const t = toks[j];
    if (t.k === 'ws' && src.slice(t.s, t.e).split('\n').length <= 2) continue;
    if (t.k === 'line' && startsLine(src, t.s)) found.push(t);
    else break;
  }
  for (let j = st.f; j < toks.length; j++) {
    const t = toks[j];
    if (t.k === 'line') {
      found.push(t);
      break;
    }
    if (src.slice(t.s, t.e).includes('\n')) break;
  }
  return found;
}

/** 去掉注释和字符串（dollar 引号的也算字符串），带引号的标识符换成占位，压成单空格、转大写 */
function cleaned(src: string, toks: Tok[], st: Stmt): string {
  const parts = toks.slice(st.f, st.z).map((t) => {
    if (TRIVIA.has(t.k)) return ' ';
    if (t.k === 'str') return "''";
    if (t.k === 'ident') return '"_"';
    if (t.k === 'dollar') return ' $$ ';
    return src.slice(t.s, t.e);
  });
  return parts.join('').replace(/\s+/g, ' ').trim().toUpperCase();
}

function topLevelParts(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** 字面量的内容：dollar 引号原样；单引号的去掉 '' 转义，E'…' 另去反斜杠转义 */
function unquote(src: string, t: Tok): string {
  const end = t.e - t.s >= 2 && src[t.e - 1] === "'" ? t.e - 1 : t.e;
  const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t' };
  const text = src.slice(t.s + 1, end);
  return t.esc
    ? text.replace(/''|\\(.)/gs, (m: string, c: string | undefined) => (m === "''" ? "'" : (esc[c!] ?? c!)))
    : text.replaceAll("''", "'");
}

const hits: string[] = [];

/**
 * top：文件本身；do：DO 块的函数体（PL/pgSQL）；lit：DO 块里某个字面量的内容（多半是动态 SQL）
 */
type Mode = 'top' | 'do' | 'lit';

/**
 * 查 src 里 [from, to) 这一段，line 把 src 里的位置换成文件行号。DO 块的函数体和它里面的字面量
 * 都递归进来（嵌套的引号一层层剥开），外层语句上的标注对里面整体有效
 */
function checkRange(
  file: string,
  src: string,
  from: number,
  to: number,
  line: (pos: number) => number,
  mode: Mode,
  inherited: Set<string>,
): void {
  const toks = lex(src, from, to);
  const descend = (t: Tok, child: Mode, allow: Set<string>) => {
    if (t.k === 'dollar') return checkRange(file, src, t.bs, t.be, line, child, allow);
    const inner = unquote(src, t);
    const l0 = line(t.s);
    checkRange(file, inner, 0, inner.length, (p) => l0 + lineAt(inner, p) - 1, child, allow);
  };
  for (const st of split(src, toks)) {
    const allow = new Set(inherited);
    for (const c of annotations(src, toks, st)) {
      const text = src.slice(c.s, c.e);
      const m = /migration-allow:(.*)/.exec(text);
      if (!m) continue;
      const where = `  ${file}:${line(c.s)}`;
      const km = /^\s*([a-z-]+(?:\s*,\s*[a-z-]+)*)(.*)$/.exec(m[1]);
      if (!km) {
        hits.push(`${where}  migration-allow 后面要写规则名（${[...RULE_NAMES].join(', ')}）：${text.trim()}`);
        continue;
      }
      const names = km[1].split(',').map((n) => n.trim());
      const unknown = names.filter((n) => !RULE_NAMES.has(n));
      if (unknown.length) hits.push(`${where}  migration-allow 里有不认识的规则名 ${unknown.join(', ')}：${text.trim()}`);
      if (!/[\p{L}\p{N}]/u.test(km[2])) hits.push(`${where}  migration-allow 要写原因：${text.trim()}`);
      else for (const n of names) allow.add(n);
    }
    const stmt = cleaned(src, toks, st);
    const head = src
      .slice(toks[st.f].s, toks[st.z - 1].e)
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    for (const r of RULES) {
      if ((mode === 'do' || !r.doOnly) && !allow.has(r.name) && r.test(stmt))
        hits.push(`  ${file}:${line(toks[st.f].s)}  ${r.name}: ${head}`);
    }
    // 顶层只有 DO 的函数体要进去；DO 里面除了 CREATE FUNCTION 的函数体，每个字面量都当 SQL 再查一遍
    const lits = toks.slice(st.f, st.z).filter((t) => t.k === 'str' || t.k === 'dollar');
    if (/^DO\b/.test(stmt)) for (const t of lits) descend(t, 'do', allow);
    else if (mode !== 'top' && !CREATE_FN.test(stmt)) for (const t of lits) descend(t, 'lit', allow);
  }
}

const hasDir = fs.existsSync(DIR);
const sqlFiles = hasDir
  ? fs
      .readdirSync(DIR)
      .filter((n) => n.endsWith('.sql'))
      .toSorted()
  : [];
for (const name of sqlFiles) {
  const src = fs.readFileSync(`${DIR}/${name}`, 'utf8');
  checkRange(`${DIR}/${name}`, src, 0, src.length, (p) => lineAt(src, p), 'top', new Set());
}

// ---------- B / C. 基准与 journal ----------

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
}

/** 当前目录是否就是一个 git 工作区的根 */
function atGitRoot(): boolean {
  try {
    return fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim()) === fs.realpathSync('.');
  } catch {
    return false;
  }
}

function parseEntries(text: string, where: string): Entry[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    hits.push(`  ${where}  不是合法的 JSON`);
    return null;
  }
  const entries = (json as { entries?: unknown } | null)?.entries;
  const ok =
    Array.isArray(entries) &&
    entries.every((e: Entry) => typeof e?.idx === 'number' && typeof e.when === 'number' && typeof e.tag === 'string');
  if (!ok) hits.push(`  ${where}  entries 不是 { idx, when, tag } 的数组`);
  return ok ? (entries as Entry[]) : null;
}

let base: string | null = null;
if (atGitRoot()) {
  try {
    base = git(['merge-base', 'HEAD', 'origin/dev']).trim();
  } catch {
    base = null;
  }
}

if (!base && !hasDir) {
  console.log('migrations: 还没有 drizzle/，跳过');
  process.exit(0);
}

const journal = fs.existsSync(JOURNAL) ? parseEntries(fs.readFileSync(JOURNAL, 'utf8'), JOURNAL) : null;
if (!fs.existsSync(JOURNAL) && sqlFiles.length) hits.push(`  ${JOURNAL}  缺失，drizzle/ 里的 .sql 没有 journal 引用`);

let baseEntries: Entry[] = [];
if (base) {
  const short = base.slice(0, 7);
  // B. 基准上的迁移文件：用 blob id 比，等于逐字节比
  const baseFiles = git(['ls-tree', '-z', base, '--', `${DIR}/`])
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      // <mode> <type> <oid>\t<path>
      const tab = rec.indexOf('\t');
      const [, type, oid] = rec.slice(0, tab).split(' ');
      return [rec.slice(tab + 1), oid, type];
    })
    .filter(([p, , type]) => type === 'blob' && /^drizzle\/[^/]+\.sql$/.test(p));
  const present = baseFiles.filter(([p]) => fs.existsSync(p));
  for (const [p] of baseFiles) if (!fs.existsSync(p)) hits.push(`  ${p}  基准（${short}）上已有的迁移被删除了`);
  if (present.length) {
    const now = git(['hash-object', '--no-filters', '--', ...present.map(([p]) => p)]).split('\n');
    present.forEach(([p, oid], i) => {
      if (now[i] !== oid) hits.push(`  ${p}  基准（${short}）上已有的迁移被修改了；要改就写新迁移`);
    });
  }
  let baseJournal: string | null = null;
  try {
    baseJournal = git(['show', `${base}:${JOURNAL}`]);
  } catch {
    baseJournal = null;
  }
  baseEntries = (baseJournal !== null && parseEntries(baseJournal, `${JOURNAL}（基准 ${short}）`)) || [];
  for (const old of baseEntries) {
    const cur = journal?.find((e) => e.idx === old.idx);
    if (!cur) hits.push(`  ${JOURNAL}  基准（${short}）上已有的条目 idx=${old.idx}（${old.tag}）被删除了`);
    else if (!isDeepStrictEqual(old, cur)) hits.push(`  ${JOURNAL}  基准（${short}）上已有的条目 idx=${old.idx}（${old.tag}）被修改了`);
  }
}
const noBaseInCi = !base && process.env.CI === 'true';
if (!base) {
  const msg = 'migrations: 取不到基准（git merge-base HEAD origin/dev）';
  if (noBaseInCi) console.error(`${msg}，CI 下不能跳过「已提交迁移不许改」与 when 顺序的检查`);
  else console.warn(`${msg}，跳过和基准的比较（CI 下这里会失败）`);
}

// C. journal 自身的顺序与文件对应，不需要基准
if (journal) {
  const baseIdx = new Set(baseEntries.map((e) => e.idx));
  const baseMax = Math.max(-Infinity, ...baseEntries.map((e) => e.when));
  const tags = new Set(journal.map((e) => e.tag));
  journal.forEach((e, i) => {
    const at = `  ${JOURNAL}  idx=${e.idx}（${e.tag}）`;
    if (e.idx !== i) hits.push(`${at}：idx 应当是 ${i}，要从 0 连续编号`);
    if (i > 0 && !(e.when > journal[i - 1].when)) hits.push(`${at}：when ${e.when} 不大于上一条的 ${journal[i - 1].when}`);
    if (!baseIdx.has(e.idx) && !(e.when > baseMax)) {
      hits.push(`${at}：新迁移的 when ${e.when} 不大于基准上最新的 ${baseMax}，drizzle 会静默跳过它`);
    }
    if (!sqlFiles.includes(`${e.tag}.sql`)) hits.push(`${at}：找不到 ${DIR}/${e.tag}.sql`);
  });
  for (const name of sqlFiles) {
    if (!tags.has(name.slice(0, -'.sql'.length))) hits.push(`  ${DIR}/${name}  不在 journal 里，drizzle 不会执行它`);
  }
}

if (hits.length) {
  console.error('migrations: 违反 01 spec「迁移纪律」：');
  for (const h of hits) console.error(h);
}
if (hits.length || noBaseInCi) process.exit(1);
const against = base ? `，基准 ${base.slice(0, 7)}` : '';
console.log(`migrations: ${sqlFiles.length} 个迁移、${journal?.length ?? 0} 条 journal${against}，没有问题`);
