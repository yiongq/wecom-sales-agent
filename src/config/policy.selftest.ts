// 07 R1、R4、R5：政策快照贯穿发布、迁移、文件往返与 CLI；同一套事务断言跑 PGlite 和真实 PG。
import '../selftest-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openTestDb, createRealPgFixture, fakeLock, testConfigDeps } from '../db/testing.js';
import { openDb, withTenant, queryCount, type Db } from '../db/client.js';
import { readDraft, readPublishedSop } from '../db/repo/sop.js';
import { canonical, defaultTravelPolicy, travelPolicy } from '../packs/travel/policy.js';
import { policyViolations } from '../packs/travel/policy-lint.js';
import { shanhaiBrand } from '../packs/travel/brand-fixture.js';
import { splitSop, sectionBody, TRAVEL_SOP_SECTIONS } from '../sop/sections.js';
import { checkSopContract } from '../sop/contract.js';
import { policySnapshot, publishedPolicy, sha256 } from './hashes.js';
import { exportConfig, importConfig } from './transfer.js';
import * as config from './source.js';
import * as sop from './sop.js';
import { runSopPolicy } from '../cli/sop-policy.js';
import { hostRuntime } from '../tenancy/runtime.js';
import { enterTenantScopeForTest } from '../tenancy/testing.js';

enterTenantScopeForTest(hostRuntime());
process.env.LLM_MOCK = '1';
const md = fs.readFileSync('data/sop.md', 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-selftest-'));
const expectedHash = sha256(canonical(defaultTravelPolicy));
let checks = 0;
function check(fn: () => void) {
  fn();
  checks++;
}
const changedPolicy = () => {
  const p = structuredClone(defaultTravelPolicy);
  p.refund.approvalThresholdYuan = 25000;
  p.refund.selfService = false;
  p.refund.tiers[1]!.percent = 75;
  p.change = '出发前20天及以上可以改期一次，由顾问为您办理';
  return p;
};

function fileSnapshot(file: string) {
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import './src/selftest-env.ts';
    const {hostRuntime,withTenantScope}=await import('./src/tenancy/runtime.ts');
    const c=await import('./src/config/source.ts');
    const {promptPrefix}=await import('./src/engine.ts');
    await withTenantScope(hostRuntime(),async()=>{
      await c.initConfig(null);
      console.log(JSON.stringify({...c.currentPolicy(),...promptPrefix()}));
    });`,
    ],
    { env: { ...process.env, CONFIG_SOURCE: 'file', SOP_PATH: file, VAR_DIR: path.join(dir, 'state') }, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout.trim().split('\n').at(-1)!) as { policy: unknown; policyHash: string; system: string; tools: string };
}

// 当前镜像零违规，并证明只读字段、档位与文字数字检查不误判普通行程。
check(() => assert.deepEqual(policyViolations(defaultTravelPolicy, splitSop(md)), []));
const badPolicies = [
  (p: ReturnType<typeof changedPolicy>) => {
    p.refund.tiers[1]!.maxDays = 30;
  },
  (p: ReturnType<typeof changedPolicy>) => {
    p.refund.tiers[1]!.maxDays = 28;
  },
  (p: ReturnType<typeof changedPolicy>) => {
    p.refund.tiers[0]!.maxDays = 60;
  },
  (p: ReturnType<typeof changedPolicy>) => {
    p.refund.tiers[1]!.percent = 120;
  },
  (p: ReturnType<typeof changedPolicy>) => {
    p.refund.approvalThresholdYuan = -1;
  },
  (p: ReturnType<typeof changedPolicy>) => {
    p.pricing.peakMultiplier = 1.15;
  },
  (p: ReturnType<typeof changedPolicy>) => {
    p.booking.maxDepartMonths = 24;
  },
];
for (const mutate of badPolicies) {
  const p = changedPolicy();
  mutate(p);
  check(() => assert.equal(policyViolations(p)[0]?.code, 'policy_invalid'));
}
check(() => assert.equal(policyViolations({ refund: {} })[0]?.code, 'policy_invalid'));
for (const [text, mismatch] of [
  ['旺季上浮 15%', true],
  ['旺季上浮10%', false],
  ['团体打9折', true],
  ['团体打95折', false],
  ['团体打9.5折', false],
  ['出发前7天退全款', true],
  ['出发前30天内退全款', true],
  ['出发前15–29天退80%', false],
  ['出发前15–30天退80%', true],
  ['出发前30天及以上退全款', false],
  ['出发前30天退100%，出发前7天退80%', true],
  ['退120%', true],
  ['退80%，仅限出发前7天', true],
  ['退80%，仅限出发前15–29天', false],
  ['退120%需要7天到账', true],
  ['退80%需要7天到账', false],
  ['行程7天，住5晚', false],
] as const) {
  const vs = policyViolations(defaultTravelPolicy, [{ key: 'tone', text }]);
  check(() =>
    assert.equal(
      vs.some((v) => v.code === 'policy_mismatch' && v.match === text && v.sectionKey === 'tone'),
      mismatch,
      text,
    ),
  );
}
check(() =>
  assert.equal(policySnapshot(travelPolicy, Object.fromEntries(Object.entries(defaultTravelPolicy).reverse())).policyHash, expectedHash),
);

const prior = changedPolicy();
const oldPolicy = Object.fromEntries(Object.entries(prior).filter(([key]) => key !== 'change'));
check(() =>
  assert.deepEqual(
    publishedPolicy(travelPolicy, {
      policy: oldPolicy,
      renderInputs: {
        hardRulesHash: '',
        imageSopHash: '',
        sectionTableHash: '',
        toolsHash: '',
        policyHash: sha256(JSON.stringify(oldPolicy)),
      },
    }).policy,
    { ...prior, change: defaultTravelPolicy.change },
  ),
);
check(() =>
  assert.throws(
    () =>
      publishedPolicy(travelPolicy, {
        policy: defaultTravelPolicy,
        renderInputs: { hardRulesHash: '', imageSopHash: '', sectionTableHash: '', toolsHash: '', policyHash: 'x' },
      }),
    /哈希不匹配/,
  ),
);
const futureDefaults = { ...travelPolicy, defaults: changedPolicy() };
check(() =>
  assert.deepEqual(
    publishedPolicy(futureDefaults, {
      policy: defaultTravelPolicy,
      renderInputs: { hardRulesHash: '', imageSopHash: '', sectionTableHash: '', toolsHash: '', policyHash: expectedHash },
    }).policy,
    defaultTravelPolicy,
  ),
);

type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
async function suite(db: Db, q: Query, slug: string, cliUrl?: string) {
  config.__configTest.reset();
  const opts = { db, tenantSlug: slug, dataDir: 'data', imageSop: md, lock: async () => fakeLock() };
  if (cliUrl) {
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/import-config.ts', '--tenant', slug, '--data', 'data', '--dry-run'],
      {
        env: { ...process.env, DATABASE_URL: cliUrl, CONFIG_SOURCE: 'file' },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    check(() => assert.equal(cli.status, 0, cli.stderr));
    check(() => assert.match(cli.stdout, /promptHash=cf3b163c9f694003099d94855cf0a3b2807ab4bf7df8d8d6dc18c96b48713900/));
    check(() => assert.ok(cli.stdout.includes(`policyHash=${expectedHash}`)));
  }
  const dry = await importConfig({ ...opts, dryRun: true });
  check(() => assert.equal(dry.hashes?.policyHash, expectedHash));
  check(() => assert.equal(dry.code, 0));
  const imported = await importConfig(opts);
  check(() => assert.equal(imported.code, 0, imported.message));
  const deps = testConfigDeps({ db }, { tenantSlug: slug });
  await config.initConfig(deps);
  const first = config.currentSop();
  const ctx = { tenantId: first.tenantId, actor: { kind: 'system' as const, userId: null, name: '政策自测', ip: null } };
  const snapshot = config.currentPolicy();
  const queries = queryCount();
  for (let i = 0; i < 5; i++) config.currentPolicy();
  check(() => assert.equal(queryCount(), queries));
  check(() => assert.equal(first.versionNo, 1));
  check(() => assert.equal(snapshot.policyHash, expectedHash));
  check(() => assert.deepEqual(snapshot.policy, defaultTravelPolicy));
  check(() => assert.ok(Object.isFrozen(snapshot.policy)));
  check(() => assert.equal(first.promptHash, sha256(fileSnapshot(path.resolve('data/sop.md')).system)));
  check(() =>
    assert.deepEqual(
      checkSopContract({
        sections: first.sections,
        imageSections: first.sections,
        rendered: first.renderedPrompt,
        toolNames: deps.toolNames,
        knownFields: deps.knownFields,
        baselineEditableChars: null,
        policy: first.policy,
      }),
      [],
    ),
  );
  for (const mutate of badPolicies) {
    const p = changedPolicy();
    mutate(p);
    await assert.rejects(
      sop.saveSopDraft(ctx, { basedOn: first.versionId, rev: null, edits: [], policy: p }),
      (e: unknown) => e instanceof sop.SopContractError && e.violations[0]?.code === 'policy_invalid',
    );
    checks++;
  }
  const mine = changedPolicy();
  const saving = sop.saveSopDraft(ctx, { basedOn: first.versionId, rev: null, edits: [], policy: mine });
  mine.refund.approvalThresholdYuan = 1; // 保存开始后调用方立即改对象，也不能改变待写快照。
  let draft = await saving;
  const overview = await sop.getSopOverview(ctx);
  check(() => assert.equal(overview.draft?.policy?.approvalThresholdYuan, 25000));
  check(() => assert.equal(overview.published.policy?.approvalThresholdYuan, 30000));
  check(() => assert.deepEqual(config.currentPolicy(), snapshot));
  const released = await sop.publishSopDraft(ctx, { rev: draft.rev, changeNote: '仅修改退改条款' });
  check(() => assert.equal(released.versionNo, 2));
  check(() => assert.equal(released.promptHash, first.promptHash));
  check(() => assert.equal(released.prefixHash, first.prefixHash));
  check(() => assert.notEqual(released.policyHash, first.policyHash));
  check(() => assert.equal(released.policyHash, sha256(canonical(changedPolicy()))));
  check(() => assert.deepEqual(config.currentPolicy().policy, changedPolicy()));
  check(() => assert.deepEqual(snapshot.policy, defaultTravelPolicy)); // 整轮捕获的旧快照稳定。
  const releasedRow = (await withTenant(db, ctx, readPublishedSop))!;
  check(() => assert.deepEqual(releasedRow.policy, changedPolicy()));
  await assert.rejects(q('update sop_versions set policy=$2::json where id=$1', [released.id, JSON.stringify(defaultTravelPolicy)]));
  checks++;

  // 导出读取发布快照，草稿不能泄漏到导出物或运行时；现有 policy 文件有错时不能静默回退。
  draft = await sop.saveSopDraft(ctx, { basedOn: released.id, rev: null, edits: [], policy: defaultTravelPolicy });
  const out = path.join(dir, `${slug}-out`);
  const exported = await exportConfig({ db, tenantSlug: slug, outDir: out, imageSop: md });
  check(() => assert.equal(exported.code, 0, exported.message));
  check(() => assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'policy.json'), 'utf8')), changedPolicy()));
  const file = fileSnapshot(path.join(out, 'sop.md'));
  check(() => assert.equal(file.policyHash, released.policyHash));
  check(() => assert.equal(sha256(file.system), released.promptHash));
  check(() => assert.equal(fileSnapshot(path.resolve('data/sop.md')).policyHash, expectedHash));
  const [copy] = await q<{ id: string }>("insert into tenants(slug,name,pack_id) values($1,$1,'travel') returning id", [`${slug}-copy`]);
  const reimported = await importConfig({ ...opts, tenantSlug: `${slug}-copy`, dataDir: out });
  check(() => assert.equal(reimported.code, 0, reimported.message));
  check(() => assert.equal(reimported.hashes?.policyHash, released.policyHash));
  const copyCtx = { ...ctx, tenantId: copy!.id };
  const copyRow = (await withTenant(db, copyCtx, readPublishedSop))!;
  check(() => assert.deepEqual(copyRow.policy, changedPolicy()));
  fs.writeFileSync(path.join(out, 'policy.json'), '{}');
  check(() => assert.throws(() => fileSnapshot(path.join(out, 'sop.md'))));
  const invalidImport = await importConfig({ ...opts, dataDir: out, dryRun: true });
  check(() => assert.equal(invalidImport.code, 1));
  fs.rmSync(path.join(out, 'policy.json'));
  check(() => assert.equal(fileSnapshot(path.join(out, 'sop.md')).policyHash, expectedHash));
  check(() => assert.equal(fs.existsSync(path.join(out, 'policy.json')), false));
  await sop.discardSopDraft(ctx, { rev: draft.rev });
  const rollback = await sop.rollbackSop(ctx, { versionId: first.versionId, changeNote: '恢复退改条款' });
  check(() => assert.equal(rollback.policyHash, first.policyHash));
  check(() => assert.equal(rollback.sameHashAsTarget, true));
  check(() => assert.deepEqual(config.currentPolicy().policy, defaultTravelPolicy));

  // 发布、回滚、启动共用 contract 检查；可编辑节必须点名那句原文。
  const tone = sectionBody(
    first.sections.find((s) => s.key === 'tone')!,
    TRAVEL_SOP_SECTIONS.find((s) => s.key === 'tone')!,
  );
  draft = await sop.saveSopDraft(ctx, { basedOn: rollback.id, rev: null, edits: [{ key: 'tone', body: `${tone}\n旺季上浮 15%` }] });
  const checked = await sop.checkSopDraft(ctx);
  check(() =>
    assert.ok(checked.violations.some((v) => v.code === 'policy_mismatch' && v.sectionKey === 'tone' && v.match === '旺季上浮 15%')),
  );
  await assert.rejects(sop.publishSopDraft(ctx, { rev: draft.rev, changeNote: '错误规则' }), sop.SopContractError);
  checks++;
  check(() => assert.equal(config.currentSop().versionId, rollback.id));
  await sop.discardSopDraft(ctx, { rev: draft.rev });

  // CLI 不装载/发布配置：app 身份，复用保存路径与审计，重复写入沿用已有草稿 rev。
  const policyFile = path.join(dir, 'input.json');
  fs.writeFileSync(policyFile, canonical(changedPolicy()));
  const auditsBefore = (
    await q<{ n: number }>("select count(*)::int as n from audit_log where tenant_id=$1 and action='sop.policy_draft'", [ctx.tenantId])
  )[0]!.n;
  let closes = 0;
  const cliDeps = {
    connect: async () => ({
      db,
      close: async () => {
        closes++;
      },
    }),
  };
  check(() => assert.equal(closes, 0));
  assert.equal(await runSopPolicy(['set', '--tenant', slug, '--policy-file', policyFile], cliDeps), 0);
  checks++;
  assert.equal(await runSopPolicy(['set', '--tenant', slug, '--policy-file', policyFile], cliDeps), 0);
  checks++;
  check(() => assert.equal(closes, 2));
  if (cliUrl) {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/sop-policy.ts', 'set', '--tenant', slug, '--policy-file', policyFile],
      {
        env: { ...process.env, DATABASE_URL: cliUrl, CONFIG_SOURCE: 'file', TENANCY_STRICT: '1' },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    check(() => assert.equal(child.status, 0, child.stderr));
    check(() => assert.match(child.stdout, /已保存退改条款草稿/));
  }
  const fromCli = (await withTenant(db, ctx, readDraft))!;
  check(() => assert.deepEqual(fromCli.policy, changedPolicy()));
  check(() => assert.equal(config.currentSop().versionId, rollback.id));
  const audits = await q<{ n: number }>("select count(*)::int as n from audit_log where tenant_id=$1 and action='sop.policy_draft'", [
    ctx.tenantId,
  ]);
  check(() => assert.equal(audits[0]!.n, auditsBefore + 2 + (cliUrl ? 1 : 0)));
  await assert.rejects(
    sop.saveSopDraft(ctx, { basedOn: rollback.id, rev: fromCli.rev - 1, edits: [], policy: defaultTravelPolicy }),
    sop.SopRevConflictError,
  );
  checks++;
  await sop.discardSopDraft(ctx, { rev: fromCli.rev });

  await config.closeConfig();
  config.__configTest.reset();
  // 模拟 07 之前的发布行；只在专用测试库暂时关闭触发器，始终恢复。
  await q('alter table sop_versions disable trigger sop_versions_guard_update');
  try {
    await q("update sop_versions set policy=null,render_inputs=render_inputs-'policyHash' where id=$1", [rollback.id]);
  } finally {
    await q('alter table sop_versions enable trigger sop_versions_guard_update');
  }
  const countRerenders = async () =>
    (await q<{ n: number }>("select count(*)::int as n from audit_log where tenant_id=$1 and action='sop.rerender'", [ctx.tenantId]))[0]!.n;
  const before = await countRerenders();
  await config.initConfig(deps);
  const upgraded = config.currentSop();
  check(() => assert.equal(upgraded.promptHash, rollback.promptHash));
  check(() => assert.equal(upgraded.policyHash, expectedHash));
  check(() => assert.equal(upgraded.versionNo, rollback.versionNo! + 1));
  check(() => assert.deepEqual(upgraded.policy, defaultTravelPolicy));
  assert.equal(await countRerenders(), before + 1);
  checks++;
  const [audit] = await q<{ diff: { causes: string[]; oldPromptHash: string; newPromptHash: string } }>(
    "select diff from audit_log where tenant_id=$1 and action='sop.rerender' order by id desc limit 1",
    [ctx.tenantId],
  );
  check(() => assert.ok(audit!.diff.causes.includes('policy')));
  check(() => assert.equal(audit!.diff.oldPromptHash, audit!.diff.newPromptHash));
  await config.closeConfig();
  config.__configTest.reset();
  await config.initConfig(deps);
  check(() => assert.equal(config.currentSop().versionId, upgraded.versionId));
  assert.equal(await countRerenders(), before + 1);
  checks++;
  await config.closeConfig();
  config.__configTest.reset();

  // 较早 policy 快照缺少后来新增字段：仅补字段，保留租户已有值，再启动不重复物化。
  const partial = Object.fromEntries(Object.entries(changedPolicy()).filter(([key]) => key !== 'change'));
  await q('alter table sop_versions disable trigger sop_versions_guard_update');
  try {
    await q(
      "update sop_versions set policy=$2::json,render_inputs=jsonb_set(render_inputs,'{policyHash}',to_jsonb($3::text)) where id=$1",
      [upgraded.versionId, JSON.stringify(partial), sha256(JSON.stringify(partial))],
    );
  } finally {
    await q('alter table sop_versions enable trigger sop_versions_guard_update');
  }
  await config.initConfig(deps);
  const filled = config.currentSop();
  check(() => assert.deepEqual(filled.policy, { ...changedPolicy(), change: defaultTravelPolicy.change }));
  check(() => assert.equal(filled.promptHash, first.promptHash));
  check(() => assert.equal(filled.versionNo, upgraded.versionNo + 1));
  await config.closeConfig();
  config.__configTest.reset();
  await config.initConfig(deps);
  check(() => assert.equal(config.currentSop().versionId, filled.versionId));
  await config.closeConfig();
  config.__configTest.reset();

  // 模板模式：同一份未改动 data/ 与 brand.json 导入、文件模式哈希等价。
  const brandedDir = path.join(dir, `${slug}-brand`);
  fs.mkdirSync(brandedDir);
  for (const name of ['sop.md', 'routes.json', 'hotels.json']) fs.copyFileSync(path.join('data', name), path.join(brandedDir, name));
  fs.writeFileSync(path.join(brandedDir, 'brand.json'), JSON.stringify(shanhaiBrand));
  const brandedSlug = `${slug}-brand`;
  const [tenant] = await q<{ id: string }>("insert into tenants(slug,name,pack_id,brand) values($1,$1,'travel',$2::json) returning id", [
    brandedSlug,
    JSON.stringify(shanhaiBrand),
  ]);
  if (cliUrl) {
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/import-config.ts', '--tenant', brandedSlug, '--data', brandedDir, '--dry-run'],
      { env: { ...process.env, DATABASE_URL: cliUrl, CONFIG_SOURCE: 'file' }, encoding: 'utf8', timeout: 30000 },
    );
    check(() => assert.equal(cli.status, 0, cli.stderr));
    check(() => assert.ok(cli.stdout.includes(`policyHash=${expectedHash}`)));
    check(() => assert.ok(cli.stdout.includes(`promptHash=${sha256(fileSnapshot(path.join(brandedDir, 'sop.md')).system)}`)));
  }
  const br = await importConfig({ ...opts, tenantSlug: brandedSlug, dataDir: brandedDir });
  check(() => assert.equal(br.code, 0, br.message));
  await config.initConfig(testConfigDeps({ db }, { tenantSlug: brandedSlug }));
  const branded = config.currentSop();
  check(() => assert.equal(branded.policyHash, expectedHash));
  check(() => assert.equal(branded.promptHash, sha256(fileSnapshot(path.join(brandedDir, 'sop.md')).system)));
  check(() => assert.equal(branded.promptHash, br.hashes!.promptHash));
  check(() => assert.deepEqual(branded.brand, shanhaiBrand));
  check(() => assert.equal(branded.tenantId, tenant!.id));
  await config.closeConfig();
  config.__configTest.reset();
  console.log(`POLICY ${cliUrl ? 'REAL PG' : 'PGLITE'}：发布、回滚、单次物化、双模式哈希、CLI 与只读快照通过`);
}

try {
  const t = await openTestDb();
  const q: Query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
    await t.pg.exec('RESET ROLE');
    try {
      return (await t.pg.query<T>(sql, params)).rows;
    } finally {
      await t.pg.exec('SET ROLE agent_app');
    }
  };
  try {
    await q("insert into tenants(slug,name,pack_id) values('policy','policy','travel')");
    await suite(t.db, q, 'policy');
  } finally {
    await config.closeConfig();
    config.__configTest.reset();
    await t.close();
  }
  if (process.env.PG_TEST_URL) {
    const fx = await createRealPgFixture(process.env.PG_TEST_URL, { slug: 'policy-pg' });
    const app = await openDb(fx.urls.app);
    try {
      await suite(app.db, fx.query, 'policy-pg', fx.urls.app);
    } finally {
      await config.closeConfig();
      config.__configTest.reset();
      await app.close();
      await fx.drop();
    }
  } else console.log('POLICY REAL PG：未设 PG_TEST_URL，跳过');
  console.log(`POLICY SELFTEST PASS：${checks} 项断言通过`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
