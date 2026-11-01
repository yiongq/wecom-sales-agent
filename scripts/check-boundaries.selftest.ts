// 04 R2：在临时夹具中验证依赖方向，涵盖 import type、转出与动态加载。
// 08 R5（验收 2）：非包、非门面的 src/ 代码不 import 具体的包、不读写旅游的九个会话字段；data/packs/ 下只能有白名单里的包目录；
// 两份允许名单是空的。
// 不改工作区，也不引入测试框架；CLI 与 pnpm lint 用的是同一个检查器。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACK_IMPORT_ALLOWLIST, SESSION_FIELD_ALLOWLIST } from './boundary-allowlists.js';

const checker = path.join(import.meta.dirname, 'check-boundaries.ts');
const tsx = path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const publicChecker = path.join(import.meta.dirname, 'check-public-boundary.ts');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-boundaries-'));
let count = 0;

/** mention：报错行里还要点名的东西（被 import 的路径、被读写的字段） */
function check(file: string, source: string, rule: string | null, mention?: string): void {
  const target = path.join(fixture, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  try {
    const result = spawnSync(process.execPath, [tsx, checker, fixture], { encoding: 'utf8', timeout: 15_000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, rule === null ? 0 : 1, output);
    if (rule !== null) {
      assert.ok(output.includes(`${file}:1`), output);
      assert.ok(output.includes(rule), output);
      if (mention !== undefined) assert.ok(output.includes(mention), output);
    }
    count++;
  } finally {
    fs.rmSync(target);
  }
}

/** 公开边界检查没有「仓库根目录」参数：在夹具目录里跑（夹具不是 git 工作区，改查目录树）。词表不在这里测，env 里的清掉 */
function checkPublic(file: string, ok: boolean): void {
  const target = path.join(fixture, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{}');
  try {
    const env = { ...process.env };
    delete env.SENSITIVE_PATTERNS;
    const result = spawnSync(process.execPath, [tsx, publicChecker], { cwd: fixture, env, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, ok ? 0 : 1, output);
    if (!ok) assert.ok(output.includes(file), output);
    count++;
  } finally {
    fs.rmSync(target);
  }
}

const RULE_IMPORT = '具体的包 src/packs/<名>/**';
const RULE_FIELD = '九个旅游会话字段不在 src/packs/travel/';
const SESSION_FIELDS = [
  'lastQuote',
  'quoteHistory',
  'budgetGaps',
  'lastShownRoutes',
  'seenRouteIds',
  'missedDestinations',
  'reminders',
  'recommendedRoutes',
  'afterSale',
];
const FACADE_FILES = [
  'src/engine.ts',
  'src/tools.ts',
  'src/price-guard.ts',
  'src/price-rules.ts',
  'src/followup.ts',
  'src/retrieval.ts',
  'src/llm.ts',
  'src/insight.ts',
];

try {
  // 11 R2 / 验收 10：四种违例均由真实 CLI 报文件与行号；目标目录/文件不存在也照样检查。
  check('src/connectors/probe.ts', "fetch('https://erp.example.test');", '11 R2：连接器不调 fetch');
  check('src/probe.ts', "import './connectors/odoo-mock.js';", 'odoo-mock.ts 只许 *.selftest.ts import');
  check('src/probe.ts', 'const opts = { allowLoopback: true };', '11 R2：allowLoopback');
  check('src/packs/travel/probe.ts', "import '../../connectors/odoo.js';", '跨层 import 只经');
  check('src/packs/travel/probe.ts', "import '../../net/egress.js';", '跨层 import 只经');
  for (const builtin of ['http', 'https', 'net', 'tls', 'dns', 'dns/promises']) {
    for (const prefix of ['', 'node:']) {
      const spec = prefix + builtin;
      for (const source of [
        `import '${spec}';`,
        `const m = import('${spec}');`,
        `const m = require('${spec}');`,
        `export * from '${spec}';`,
      ])
        check('src/connectors/probe.ts', source, '不 import 网络内置模块', spec);
    }
  }
  for (const source of ['globalThis.fetch(url);', "globalThis['fetch'](url);", '(fetch)(url);']) {
    check('src/connectors/nested/probe.ts', source, '11 R2：连接器不调 fetch');
  }
  for (const source of [
    "const m = import('./connectors/odoo-mock.js');",
    "const m = require('./connectors/odoo-mock.js');",
    "export * from './connectors/odoo-mock.js';",
  ])
    check('src/probe.ts', source, 'odoo-mock.ts 只许 *.selftest.ts import');
  check('src/probe.ts', "import { createEgress } from './net/egress.js'; const resolver = {};", '11 R2：egress 的 resolver');
  check('src/probe.ts', "const e = import('./net/egress.js'); const resolver = {};", '11 R2：egress 的 resolver');
  check('src/probe.ts', 'const resolver = {};', null);
  check('src/probe.ts', "import { createEgress } from './net/egress.js';", null);
  check('src/connectors/probe.ts', "import { createEgress } from '../net/egress.js';", null);
  check('src/connectors/odoo-mock.ts', "import http from 'node:http'; fetch(url);", null);
  check('src/connectors/probe.selftest.ts', "import http from 'node:http'; fetch(url); const allowLoopback = true;", null);
  check('src/probe.selftest.ts', "import './connectors/odoo-mock.js'; const resolver = {};", null);
  for (const file of ['src/net/egress.ts', 'scripts/odoo-integration.ts', 'src/probe.selftest.ts', 'scripts/check-boundaries.ts']) {
    check(file, 'const allowLoopback = true; const resolver = {};', null);
  }
  check('scripts/check-boundaries.ts', "import '../src/connectors/odoo-mock.js';", null);

  // 核心不引包：包侧引核心出口合法，反方向的各种语法都拒绝。
  check('src/core/probe.ts', "import type { Session } from '../types.js';", null);
  check('src/core/probe.ts', "import '../../src/packs/travel/probe.js';", 'src/core/ 不 import src/packs/');
  check('src/core/probe.ts', "export type { Travel } from '../packs/travel/probe.js';", 'src/core/ 不 import src/packs/');
  check('src/core/probe.ts', "const p = import('../packs/travel/probe.js');", 'src/core/ 不 import src/packs/');

  // 八个门面都受管；未存在的目标也照样拒绝。
  check('src/core/probe.ts', "export type { ToolDef } from '../tool-defs.js';", null);
  for (const name of ['engine', 'tools', 'price-guard', 'price-rules', 'followup', 'retrieval', 'llm', 'insight']) {
    check('src/core/probe.ts', `import type { Probe } from '../${name}.js';`, 'src/core/ 不 import R1 门面路径');
  }
  check('src/core/probe.ts', "const p = require('../engine.js');", 'src/core/ 不 import R1 门面路径');

  // 包内互引与公共出口合法；shared 等老跨层路径同样必须走出口。
  check('src/packs/travel/probe.ts', "export type { Session } from '../../core/pack-api.js';", null);
  check('src/packs/travel/probe.ts', "import { x } from './sop.js';", null);
  check('src/packs/travel/probe.ts', "import fs from 'node:fs';", null);
  check('src/packs/travel/probe.ts', "import type { X } from '../../core/tools/runtime.js';", '跨层 import 只经');
  check('src/packs/travel/probe.ts', "type X = import('../../core/engine/index.js').X;", '跨层 import 只经');
  check('src/packs/travel/probe.ts', "export { x } from '../../shared/pack.js';", '跨层 import 只经');
  check('src/packs/travel/probe.ts', "const x = import('../../tools.js');", '跨层 import 只经');

  // 原有假包隔离仍成立：只给自测使用，不能借 pack-api 转入生产依赖图。
  check('src/packs/probe.selftest.ts', "import { x } from '../shared/pack-fixtures/renovation.js';", null);
  check('src/packs/probe.ts', "import { x } from '../shared/pack-fixtures/renovation.js';", '跨层 import 只经');
  check('src/core/pack-api.ts', "export { x } from '../shared/pack-fixtures/renovation.js';", '只给自测和 scripts/');
  // 配置、后台、shared 的既有规则不因新增出口而放宽。
  check('src/config/probe.ts', "import { x } from '../engine.js';", '配置层不能 import');
  check('console/src/probe.ts', "import { x } from '../../src/core/pack-api.js';", '在仓库里只能 import src/shared/');
  check('src/shared/probe.ts', "import type { X } from '../core/pack-api.js';", 'src/shared/ 只能 import');
  check('src/probe.ts', "import { enterTenantScopeForTest } from './tenancy/testing.js';", '只能被 *.selftest.ts');
  check('src/probe.ts', "const p = import('./tenancy/testing.js');", '只能被 *.selftest.ts');
  check('src/probe.selftest.ts', "import { enterTenantScopeForTest } from './tenancy/testing.js';", null);
  check('eval/run.ts', "import { enterTenantScopeForTest } from '../src/tenancy/testing.js';", null);
  check('src/probe.ts', "import { __tenantTest as helper } from './tenancy/runtime.js';", '只给自测夹具');
  check('src/probe.ts', "const { __tenantTest: helper } = await import('./tenancy/runtime.js');", '只给自测夹具');
  check('src/probe.ts', "import * as r from './tenancy/runtime.js'; r.__tenantTest.enterScope(rt);", '只给自测夹具');

  // 08 R5 规则 (1)：src/packs/ 与门面之外不 import 具体的包。点名文件与 import；import type、export … from、动态 import()、
  // 副作用 import、类型位置的 import()、require 都算；在 src/config/ 之外（存储、适配器、后台接口、测试辅助）一样
  check('src/config/probe.ts', "import { x } from '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "import type { X } from '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "export { x } from '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "export type { X } from '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "export * from '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "const p = import('../packs/travel/sop.js');", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "import '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "type X = import('../packs/travel/sop.js').X;", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "const x = require('../packs/travel/sop.js');", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/config/probe.ts', "import { x } from '../packs/__fixture/runtime.js';", RULE_IMPORT, "'../packs/__fixture/runtime.js'");
  check('src/store/probe.ts', "import { x } from '../packs/travel/legacy.js';", RULE_IMPORT, "'../packs/travel/legacy.js'");
  check('src/adapters/probe.ts', "import { x } from '../packs/travel/legacy.js';", RULE_IMPORT, "'../packs/travel/legacy.js'");
  check('src/probe.ts', "import { x } from './packs/travel/sop.js';", RULE_IMPORT, "'./packs/travel/sop.js'");
  check('src/db/testing.ts', "import { x } from '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  check('src/tenancy/fixture-testing.ts', "import { x } from '../packs/travel/sop.js';", RULE_IMPORT, "'../packs/travel/sop.js'");
  // 参数外面套括号、as、satisfies、<T> 断言、非空断言（可叠几层）照样认：剥到底是字符串字面量就算
  const LEGACY = "'../packs/travel/legacy.js'";
  for (const wrapped of [
    `(${LEGACY})`,
    `((${LEGACY}))`,
    `${LEGACY} as string`,
    `${LEGACY} as const`,
    `${LEGACY} satisfies string`,
    `<string>${LEGACY}`,
    `${LEGACY}!`,
    `((${LEGACY} as string)!)`,
    '(`../packs/travel/legacy.js`)',
  ]) {
    check('src/config/probe.ts', `const p = import(${wrapped});`, RULE_IMPORT, '../packs/travel/legacy.js');
  }
  check('src/config/probe.ts', `const x = require((${LEGACY}));`, RULE_IMPORT, '../packs/travel/legacy.js');
  check('src/config/probe.ts', `const x = require(${LEGACY} as string);`, RULE_IMPORT, '../packs/travel/legacy.js');
  check('src/config/probe.ts', `const m = await import((${LEGACY} as string)!);`, RULE_IMPORT, '../packs/travel/legacy.js');
  // 套了壳但指向包外的路径、写不出字面量的参数都不算
  check('src/config/probe.ts', "const p = import(('../core/prompt.js' as string));", null);
  check('src/config/probe.ts', "const p = import(('../packs/registry.js'));", null);
  check('src/config/probe.ts', 'const p = import((path as string));', null);
  // 门面、注册表、包自己、自测、src/ 之外的代码都不受这条管；注册表本身（src/packs/registry.ts）谁都能 import
  for (const name of FACADE_FILES) check(name, "import { x } from './packs/travel/sop.js';", null);
  check('src/engine.ts', "export { x } from './packs/travel/runtime.js';", null);
  check('src/tools.ts', "const p = import('./packs/travel/tools/index.js');", null);
  check('src/packs/registry.ts', "import { createTravelRuntime } from './travel/runtime.js';", null);
  check('src/packs/travel/probe.ts', "import { x } from './sop.js';", null);
  check('src/packs/__fixture/probe.ts', "import { x } from '../travel/sop.js';", null);
  check('src/config/probe.ts', "import { packById } from '../packs/registry.js';", null);
  check('src/config/probe.ts', "import type { X } from '../packs/registry.js';", null);
  check('src/config/probe.selftest.ts', "import { x } from '../packs/travel/sop.js';", null);
  check('src/db/probe.selftest.ts', "const { x } = await import('../packs/travel/sop.js');", null);
  check('eval/probe.ts', "import { x } from '../src/packs/travel/sop.js';", null);
  check('scripts/probe.ts', "import { x } from '../src/packs/travel/sop.js';", null);

  // 08 R5 规则 (2)：九个旅游会话字段只在 src/packs/travel/、门面与 src/types.ts 里出现。
  // 属性访问（读、写、可选链）、字符串字面量的元素访问、解构里的同名属性、对象字面量里的同名键（含简写）都算
  for (const field of SESSION_FIELDS) {
    check('src/core/probe.ts', `const v = session.${field};`, RULE_FIELD, `属性访问 '${field}'`);
  }
  check('src/core/probe.ts', 'const q = session.lastQuote;', RULE_FIELD, "属性访问 'lastQuote'");
  check('src/core/probe.ts', 'const t = session.lastQuote?.total;', RULE_FIELD, "属性访问 'lastQuote'");
  check('src/core/probe.ts', 'session.quoteHistory = [];', RULE_FIELD, "属性访问 'quoteHistory'");
  check('src/core/probe.ts', 'delete session.afterSale;', RULE_FIELD, "属性访问 'afterSale'");
  check('src/core/probe.ts', "const q = session['lastQuote'];", RULE_FIELD, "元素访问 'lastQuote'");
  check('src/core/probe.ts', 'const q = session[`reminders`];', RULE_FIELD, "元素访问 'reminders'");
  check('src/core/probe.ts', 'const { lastQuote } = session;', RULE_FIELD, "解构 'lastQuote'");
  check('src/core/probe.ts', 'const { budgetGaps: gaps } = session;', RULE_FIELD, "解构 'budgetGaps'");
  check('src/core/probe.ts', "const { 'seenRouteIds': ids } = session;", RULE_FIELD, "解构 'seenRouteIds'");
  check('src/core/probe.ts', 'function f({ recommendedRoutes }: S) { return recommendedRoutes; }', RULE_FIELD, "解构 'recommendedRoutes'");
  check('src/core/probe.ts', 'const s = { lastQuote: undefined };', RULE_FIELD, "对象字面量的键 'lastQuote'");
  check('src/core/probe.ts', "const s = { 'missedDestinations': [] };", RULE_FIELD, "对象字面量的键 'missedDestinations'");
  check('src/core/probe.ts', "const s = { ['reminders']: {} };", RULE_FIELD, "对象字面量的键 'reminders'");
  check('src/core/probe.ts', 'const lastShownRoutes = []; const s = { lastShownRoutes };', RULE_FIELD, "对象字面量的键 'lastShownRoutes'");
  check('src/core/probe.ts', 'const s = { afterSale() { return 1; } };', RULE_FIELD, "对象字面量的键 'afterSale'");
  // 别的目录一样管；非自测的测试辅助文件也管；其他包（含证明包）不能碰旅游的字段
  check('src/config/probe.ts', 'const q = session.lastQuote;', RULE_FIELD, "属性访问 'lastQuote'");
  check('src/console-api/probe.ts', 'const q = s.lastQuote;', RULE_FIELD, "属性访问 'lastQuote'");
  check('src/db/testing.ts', 'const q = s.lastQuote;', RULE_FIELD, "属性访问 'lastQuote'");
  check('src/tenancy/fixture-testing.ts', 'const q = s.lastQuote;', RULE_FIELD, "属性访问 'lastQuote'");
  check('src/packs/__fixture/probe.ts', 'const q = s.lastQuote;', RULE_FIELD, "属性访问 'lastQuote'");
  check('src/packs/registry.ts', 'const q = s.lastQuote;', RULE_FIELD, "属性访问 'lastQuote'");
  // 旅游包、门面、src/types.ts、自测、src/ 之外的代码不受这条管；变量名、别的属性名、动态键不算
  check('src/packs/travel/probe.ts', 'const q = session.lastQuote; session.afterSale = undefined;', null);
  check('src/packs/travel/tools/probe.ts', 'const { reminders } = session;', null);
  for (const name of FACADE_FILES) check(name, 'const q = session.lastQuote;', null);
  check('src/types.ts', 'export const x = { lastQuote: true, afterSale: false };', null);
  check('src/core/probe.selftest.ts', 'const q = session.lastQuote;', null);
  check('src/config/probe.selftest.ts', 'const { afterSale } = session; const s = { reminders: {} };', null);
  check('scripts/probe.ts', 'const q = session.lastQuote;', null);
  check('eval/probe.ts', 'const q = session.lastQuote;', null);
  // 下标、计算键外面套括号、as、satisfies、<T> 断言、非空断言（可叠几层）照样认：读、写、delete、解构、对象字面量都有
  for (const wrap of [
    (k: string) => `(${k})`,
    (k: string) => `((${k}))`,
    (k: string) => `${k} as const`,
    (k: string) => `${k} as string`,
    (k: string) => `${k} satisfies string`,
    (k: string) => `<string>${k}`,
    (k: string) => `${k}!`,
    (k: string) => `((${k} as const)!)`,
  ]) {
    const key = wrap("'lastQuote'");
    check('src/core/probe.ts', `const q = session[${key}];`, RULE_FIELD, "元素访问 'lastQuote'");
    check('src/core/probe.ts', `session[${wrap("'quoteHistory'")}] = [];`, RULE_FIELD, "元素访问 'quoteHistory'");
    check('src/core/probe.ts', `delete session[${wrap("'afterSale'")}];`, RULE_FIELD, "元素访问 'afterSale'");
    check('src/core/probe.ts', `const { [${wrap("'reminders'")}]: r } = session;`, RULE_FIELD, "解构 'reminders'");
    check('src/core/probe.ts', `function f({ [${wrap("'budgetGaps'")}]: g }: S) { return g; }`, RULE_FIELD, "解构 'budgetGaps'");
    check('src/core/probe.ts', `const o = { [${wrap("'recommendedRoutes'")}]: [] };`, RULE_FIELD, "对象字面量的键 'recommendedRoutes'");
  }
  check('src/core/probe.ts', 'const q = session[(`lastQuote`)];', RULE_FIELD, "元素访问 'lastQuote'");
  check('src/core/probe.ts', 'const { [(`seenRouteIds`)]: ids } = session;', RULE_FIELD, "解构 'seenRouteIds'");
  check(
    'src/core/probe.ts',
    'const o = { [(`missedDestinations`) as string]() { return 1; } };',
    RULE_FIELD,
    "对象字面量的键 'missedDestinations'",
  );
  // 套了壳但不是会话字段、或写不出字面量的下标都不算
  check('src/core/probe.ts', "const q = session[('id' as const)]; const { [('stage')]: s } = session; const o = { [('seed')]: 1 };", null);
  check('src/core/probe.ts', 'const q = session[(key as string)]; const { [(key)]: r } = session;', null);
  // 门面、旅游包、src/types.ts、自测里的同样写法不报
  check('src/engine.ts', "const q = session[('lastQuote' as const)]; const { [('reminders')]: r } = session;", null);
  check('src/packs/travel/probe.ts', "const q = session[('lastQuote')]; const o = { ['afterSale' as const]: 1 };", null);
  check('src/types.ts', "export const x = { [('lastQuote' as const)]: true };", null);
  check('src/core/probe.selftest.ts', "const q = session[('lastQuote')]; const { [('reminders')]: r } = session;", null);
  check('src/core/probe.ts', 'const reminders: string[] = []; reminders.push(String(1));', null);
  check('src/core/probe.ts', 'const q = session.lastQuoteAt; const r = session.reminder;', null);
  check('src/core/probe.ts', 'const q = session[key];', null);
  check('src/core/probe.ts', 'const { id, ...lastQuote } = session;', null);

  // 08 R5 公开边界：data/packs/<名>/ 与 src/packs/<名>/ 用同一份白名单
  checkPublic('data/packs/__fixture/pack.json', true);
  checkPublic('data/packs/travel/pack.json', true);
  checkPublic('data/packs/travel/catalog/route.json', true);
  checkPublic('data/packs/some-customer/pack.json', false);
  checkPublic('data/packs/some-customer/catalog/item.json', false);
  checkPublic('src/packs/some-customer/runtime.ts', false);
  checkPublic('src/packs/travel/runtime.ts', true);

  // 08 R5：两份允许名单必须是空的。以后要加违例得同时改名单和这里，评审看得见
  assert.deepEqual(PACK_IMPORT_ALLOWLIST, [], '规则 (1) 的允许名单必须为空');
  assert.deepEqual(SESSION_FIELD_ALLOWLIST, [], '规则 (2) 的允许名单必须为空');
  count += 2;
  console.log(`boundaries selftest: ${count} 项通过`);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
