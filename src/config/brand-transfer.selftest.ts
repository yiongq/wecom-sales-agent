// 第 24 步：已发布品牌导出、文件前缀往返与复用目录清理。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openTestDb, installSeededConfig } from '../db/testing.js';
import { withTenant } from '../db/client.js';
import { updateBrand } from '../db/repo/tenants.js';
import { shanhaiBrand } from '../packs/travel/brand-fixture.js';
import type { BrandProfile } from '../core/pack-api.js';
import { exportConfig, importConfig, EXIT } from './transfer.js';
import { promptHashes } from './hashes.js';
import * as config from './source.js';
import * as sop from './sop.js';

process.env.CONFIG_SOURCE = 'file';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-transfer-'));
const out = path.join(dir, 'export');
const md = fs.readFileSync('data/sop.md', 'utf8');
const t = await openTestDb();
let checks = 0;
function check(fn: () => void): void {
  fn();
  checks++;
}

// 独立文件进程走真实装载与引擎入口，避免 DB 缓存或手工 bindPack 让往返误通过。
function filePrefix(sopPath: string, lazy = false): { system: string; tools: string; brand: BrandProfile | null } {
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import './src/selftest-env.ts';
       const config = await import('./src/config/source.ts');
       ${lazy ? '' : 'await config.initConfigFromEnv(process.env, () => {});'}
       const { promptPrefix } = await import('./src/engine.ts');
       console.log(JSON.stringify({ ...promptPrefix(), brand: config.currentPack().brand }));`,
    ],
    {
      env: { ...process.env, CONFIG_SOURCE: 'file', SOP_PATH: sopPath, VAR_DIR: path.join(dir, 'file-state') },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
}

try {
  const deps = await installSeededConfig(t, { slug: 'transfer' });
  const initial = config.currentSop();
  const ctx = { tenantId: initial.tenantId, actor: { kind: 'platform' as const, userId: null, name: '自测', ip: null } };
  const setBrand = async (brand: BrandProfile | null): Promise<void> => {
    await t.pg.exec('RESET ROLE');
    await withTenant(t.db, ctx, (tx) => updateBrand(tx, ctx.tenantId, brand));
    await t.pg.exec('SET ROLE agent_app');
  };
  const restart = async (): Promise<void> => {
    await config.closeConfig();
    config.__configTest.reset();
    await config.initConfig(deps);
  };
  const roundtrip = async (brand: BrandProfile | null): Promise<void> => {
    const published = config.currentSop();
    const r = await exportConfig({ db: t.db, tenantSlug: 'transfer', outDir: out, imageSop: md });
    check(() => assert.equal(r.code, EXIT.ok, r.message));
    check(() => assert.equal(r.hashes!.prefixHash, published.prefixHash));
    check(() => assert.equal(r.hashes!.sopHash, published.sopHash));
    const brandFile = path.join(out, 'brand.json');
    if (brand) {
      check(() => assert.deepEqual(JSON.parse(fs.readFileSync(brandFile, 'utf8')), brand));
      check(() => assert.equal(fs.readFileSync(brandFile, 'utf8'), `${JSON.stringify(brand, null, 2)}\n`));
    } else check(() => assert.equal(fs.existsSync(brandFile), false));
    // 非默认文件名、相对 SOP_PATH：品牌来自有效 SOP 所在目录。
    const file = path.join(out, 'published.md');
    fs.copyFileSync(path.join(out, 'sop.md'), file);
    const prefix = filePrefix(path.relative(process.cwd(), file));
    check(() => assert.deepEqual(prefix.brand, brand));
    check(() => assert.equal(prefix.system, published.renderedPrompt));
    check(() => assert.equal(promptHashes(prefix.system, prefix.tools, fs.readFileSync(file, 'utf8')).prefixHash, published.prefixHash));
    check(() => assert.equal(prefix.tools, deps.toolsJson));
  };

  await roundtrip(null);
  await setBrand(shanhaiBrand);
  await roundtrip(null); // set 未重启：不把待生效品牌带出去。
  await restart();
  await roundtrip(shanhaiBrand);
  check(() => assert.notEqual(config.currentSop().promptHash, initial.promptHash));
  check(() => assert.deepEqual(filePrefix(path.join(out, 'sop.md'), true).brand, shanhaiBrand));
  const templateSop = fs.readFileSync(path.join(out, 'sop.md'), 'utf8');
  fs.writeFileSync(path.join(out, 'sop.md'), templateSop.replace('定价只有两条规则', '文件里改动过的锁定规则'));
  check(() => assert.equal(filePrefix(path.join(out, 'sop.md')).system, config.currentSop().renderedPrompt));
  fs.writeFileSync(path.join(out, 'sop.md'), templateSop);
  const target = await exportConfig({ db: t.db, tenantSlug: 'transfer', outDir: out, imageSop: md, targetImageSop: md });
  check(() => assert.equal(target.code, EXIT.ok, target.message));
  check(() => assert.equal(target.hashes!.prefixHash, config.currentSop().prefixHash));
  await setBrand({ ...shanhaiBrand, brandName: '远山旅行', identityLine: '我是远山旅行的 AI 旅行顾问' });
  await roundtrip(shanhaiBrand); // 再次 set 仍导出旧品牌快照。
  await setBrand(null);
  await roundtrip(shanhaiBrand); // clear 未重启：仍是模板模式。
  await restart();
  await roundtrip(null); // 同一输出目录：brand.json 必须删除。
  check(() => assert.equal(config.currentSop().promptHash, initial.promptHash));
  check(() => assert.equal(fs.readFileSync(path.join(out, 'sop.md'), 'utf8'), md));

  // 运营编辑过的可编辑节在模板文件渲染中原样保留。
  await setBrand(shanhaiBrand);
  await restart();
  const published = config.currentSop();
  const draft = await sop.saveSopDraft(ctx, {
    basedOn: published.versionId,
    rev: null,
    edits: [{ key: 'preamble', body: published.sections.find((s) => s.key === 'preamble')!.text + '运营保留的说明。' }],
  });
  await sop.publishSopDraft(ctx, { rev: draft.rev!, changeNote: '自测导出可编辑节' });
  await roundtrip(shanhaiBrand);
  check(() => assert.match(filePrefix(path.join(out, 'sop.md')).system, /运营保留的说明/));

  // 导入保护不变：锁定节拒绝、拿不到锁拒绝、不一致拒绝。
  const opts = { db: t.db, tenantSlug: 'transfer', dataDir: out, imageSop: md, lock: deps.lock };
  const consistent = await importConfig(opts);
  check(() => assert.equal(consistent.code, EXIT.ok, consistent.message));
  const locked = await importConfig({ ...opts, lock: async () => null });
  check(() => assert.equal(locked.code, EXIT.locked));
  const exported = fs.readFileSync(path.join(out, 'sop.md'), 'utf8');
  fs.writeFileSync(path.join(out, 'sop.md'), exported.replace('定价只有两条规则', '定价改成别的规则'));
  const invalid = await importConfig(opts);
  check(() => assert.equal(invalid.code, EXIT.error, invalid.message));
  check(() => assert.match(invalid.message, /locked_changed/));
  fs.writeFileSync(path.join(out, 'sop.md'), exported.replace('运营保留的说明。', '另一份运营说明。'));
  const inconsistent = await importConfig(opts);
  check(() => assert.equal(inconsistent.code, EXIT.inconsistent, inconsistent.message));

  // 不合格 brand.json 不静默回落；没有品牌的另一个 SOP 目录按旧版装载。
  fs.writeFileSync(path.join(out, 'brand.json'), '{}');
  const dbBinding = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "const c = await import('./src/config/source.ts'); console.log(c.currentPack().brand);",
    ],
    { env: { ...process.env, CONFIG_SOURCE: 'db', SOP_PATH: path.join(out, 'sop.md') }, encoding: 'utf8', timeout: 30_000 },
  );
  check(() => assert.equal(dbBinding.status, 0, dbBinding.stderr));
  check(() => assert.equal(dbBinding.stdout.trim(), 'null')); // DB 装载前也不碰文件品牌。
  const previousPath = process.env.SOP_PATH;
  try {
    process.env.SOP_PATH = path.join(out, 'sop.md');
    await config.closeConfig();
    config.__configTest.reset();
    await assert.rejects(config.initConfig(null));
    checks++;
  } finally {
    if (previousPath === undefined) delete process.env.SOP_PATH;
    else process.env.SOP_PATH = previousPath;
  }
  const legacyFile = path.join(dir, 'legacy.md');
  fs.writeFileSync(legacyFile, md);
  check(() => assert.equal(filePrefix(legacyFile).brand, null));
  console.log(`BRAND TRANSFER SELFTEST：${checks} 项通过（发布快照、两种模式往返、复用目录与导入保护）`);
} finally {
  await config.closeConfig();
  config.__configTest.reset();
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
