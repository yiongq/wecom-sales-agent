// 公开边界检查（docs/architecture/00-baseline/spec.md「CI 与部署 · 公开边界检查」，规则来源 ADR-003 决策 4）。
// 仓库是公开的，推上去的东西自己洗不掉（PR 的 refs 也会留下），所以它挂在 `pnpm lint` 里，
// pre-commit 在提交前就拦，CI 走同一个名字。
//
// 查的是 git 索引里的全部文件（已跟踪 + 已暂存），内容也读索引里的版本：
// 部分暂存时，要提交出去的是索引那一份，不是工作区那一份。不在 git 工作区根目录时
// （deploy.sh 在 git archive 解出的目录里跑门禁），改查目录树里 node_modules 以外的文件。
//
// - 路径黑名单：命中时列出路径。
// - 内容黑名单：词表来自环境变量 SENSITIVE_PATTERNS（CI 从仓库 secret 注入），没有时读被忽略的
//   `.sensitive-patterns`；每行一个 JavaScript 正则（区分大小写，u 标志），空行和 # 开头的行忽略。
//   两者都没有时跳过这一项并提示一行。命中时只报「文件:行号」，不回显命中的内容，也不回显词表，
//   因为 CI 日志是公开的。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** src/packs/ 下允许公开的行业包。新增公开包要改这里，并在 PR 里说明（ADR-003 决策 4） */
const PUBLIC_PACKS = new Set(['travel', 'ecommerce-aftersales']);

function pathViolation(p: string): boolean {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  if (base === '.deploy.env' || base === '.sensitive-patterns') return true;
  if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') return true;
  if (/\.(pem|key|p12|pfx|bundle)$/.test(base)) return true;
  if (base.startsWith('kf-qr')) return true; // 客服二维码编码的就是 open_kfid，等同凭据
  if (base.endsWith('.log')) return true;
  if (parts.slice(0, -1).some((d) => d === '.playwright-mcp' || d === 'scratchpad')) return true;
  if (parts[0] === 'var' || parts[0] === 'tenants') return true;
  if (parts[0] === 'eval' && parts[1] === 'real') return true;
  if (parts[0] === '.claude' && !(parts[1] === 'settings.json' && parts.length === 2) && parts[1] !== 'hooks') return true;
  if (parts[0] === 'src' && parts[1] === 'packs' && parts.length > 3 && !PUBLIC_PACKS.has(parts[2])) return true;
  return false;
}

function loadPatterns(): RegExp[] | null {
  const fromEnv = process.env.SENSITIVE_PATTERNS;
  let text: string | null = fromEnv && fromEnv.trim() ? fromEnv : null;
  if (text === null && fs.existsSync('.sensitive-patterns')) text = fs.readFileSync('.sensitive-patterns', 'utf8');
  if (text === null) return null;
  const patterns: RegExp[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      patterns.push(new RegExp(line, 'gu'));
    } catch {
      // 只报行号：正则原文本身就是要保护的内容
      console.error(`public-boundary: 词表第 ${i + 1} 行不是合法的正则`);
      process.exit(2);
    }
  });
  return patterns;
}

/** 当前目录是否就是一个 git 工作区的根。deploy.sh 在 git archive 解出的目录里跑门禁，那里没有 .git */
function atGitRoot(): boolean {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return fs.realpathSync(top.trim()) === fs.realpathSync('.');
  } catch {
    return false;
  }
}

/** 索引里的文件：[路径, blob id]。跳过子模块（gitlink） */
function indexEntries(): [string, string][] {
  const out = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const entries: [string, string][] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, oid] = rec.slice(0, tab).split(' ');
    if (mode === '160000') continue;
    entries.push([rec.slice(tab + 1), oid]);
  }
  return entries;
}

/** 一次 git cat-file --batch 读出全部 blob */
function readBlobs(oids: string[]): Buffer[] {
  if (!oids.length) return [];
  const out = execFileSync('git', ['cat-file', '--batch'], { input: oids.join('\n') + '\n', maxBuffer: 1 << 30 });
  const blobs: Buffer[] = [];
  let pos = 0;
  for (let i = 0; i < oids.length; i++) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString('latin1').split(' ')[2]);
    blobs.push(out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}

/** 不在 git 工作区根目录时，查目录树里的文件（跳过 node_modules） */
function walk(dir = ''): string[] {
  const files: string[] = [];
  for (const d of fs.readdirSync(dir || '.', { withFileTypes: true })) {
    const p = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) {
      if (d.name !== 'node_modules') files.push(...walk(p));
    } else if (d.isFile()) files.push(p);
  }
  return files;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

let paths: string[];
let contents: () => Buffer[];
if (atGitRoot()) {
  const entries = indexEntries();
  paths = entries.map(([p]) => p);
  contents = () => readBlobs(entries.map(([, oid]) => oid));
} else {
  paths = walk();
  contents = () => paths.map((p) => fs.readFileSync(p));
}
let failed = false;

const badPaths = paths.filter(pathViolation);
if (badPaths.length) {
  failed = true;
  console.error('public-boundary: 这些路径不能进公开仓库（00 spec「路径黑名单」）：');
  for (const p of badPaths) console.error(`  ${p}`);
}

const patterns = loadPatterns();
if (patterns === null) {
  console.log('public-boundary: 没有 SENSITIVE_PATTERNS 或 .sensitive-patterns，跳过内容黑名单');
} else if (patterns.length) {
  const blobs = contents();
  const hits: string[] = [];
  paths.forEach((p, i) => {
    let text: string;
    try {
      text = utf8.decode(blobs[i]);
    } catch {
      return; // 不是 UTF-8 文本（图片等）
    }
    const lines = new Set<number>();
    for (const re of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        lines.add(text.slice(0, m.index).split('\n').length);
        if (m[0] === '') re.lastIndex++;
      }
    }
    for (const n of [...lines].sort((a, b) => a - b)) hits.push(`  ${p}:${n}`);
  });
  if (hits.length) {
    failed = true;
    console.error('public-boundary: 命中内容黑名单（只列位置，不回显内容）：');
    for (const h of hits) console.error(h);
  }
}

process.exit(failed ? 1 : 0);
