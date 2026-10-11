// 05 R5：临时夹具走与正式检查相同的 CLI，不执行夹具代码，不改工作区。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checker = path.join(import.meta.dirname, 'check-tenant-state.ts');
const tsx = path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-state-'));
let count = 0;

function write(file: string, source: string): void {
  const target = path.join(fixture, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function reset(source = '', entries = '{}'): void {
  fs.rmSync(path.join(fixture, 'src'), { recursive: true, force: true });
  write('src/probe.ts', source);
  write('src/tenancy/state-manifest.ts', `export const STATE_MANIFEST = Object.freeze(${entries});\nthrow new Error('不得执行清单');`);
}

function check(status: number, options: string[] = []): string {
  const result = spawnSync(process.execPath, [tsx, checker, ...options, fixture], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, status, output);
  count++;
  return output;
}

function errors(output: string, expected: number): void {
  assert.match(output, new RegExp(`tenant-state: ${expected} 项错误：`));
  assert.equal(output.split('\n').filter((line) => line.startsWith('  ')).length, expected, output);
}

try {
  reset(
    [
      'const list = [];',
      'const map = new Map();',
      'const emitter = new EventEmitter();',
      'const instance = new Stateful();',
      'const closure = makeLimiter();',
      'let mutable = 0;',
      'var legacy = null;',
      'const object = {};',
      'const weak = new WeakMap();',
      'const weakSet = new WeakSet();',
      'const set = new Set();',
      'const scope = new AsyncLocalStorage();',
      'const arrow = () => 1;',
      'const alias = arrow;',
      'const callback = function () {};',
    ].join('\n'),
  );
  let output = check(1);
  errors(output, 12);
  const names = ['list', 'map', 'emitter', 'instance', 'closure', 'mutable', 'legacy', 'object', 'weak', 'weakSet', 'set', 'scope'];
  for (const [index, name] of names.entries()) assert.ok(output.includes(`src/probe.ts:${index + 1} ${name} `), output);
  for (const shape of ['数组字面量', 'new Map', 'new EventEmitter', 'new Stateful', '调用 makeLimiter', 'let /', 'var /']) {
    assert.ok(output.includes(shape), output);
  }
  output = check(0, ['--report']);
  assert.match(output, /需登记 12 个绑定/);
  assert.ok(!output.includes('不得执行清单'));

  reset(
    [
      "import fs from 'node:fs';",
      "export { x } from './elsewhere.js';",
      'export function fn() { const local = new Map(); }',
      'export class Example { field = []; method() { var local = new Map(); } }',
      'type Shape = { a: number };',
      'interface Value { a: number }',
      "enum Kind { A = 'a' }",
      "const text = 'plain';",
      'const template = `plain`;',
      'const number = 42, negative = -2, positive = +3, big = 1n;',
      'const yes = true, no = false, empty = null, absent = undefined;',
      'const regex = /pattern/g;',
      'const array = [1, 2] as const;',
      "const object = ({ a: 'a' } as const) satisfies Shape;",
      'const frozen = Object.freeze({ a: 1 });',
      'const frozenArray = Object.freeze([1, 2]);',
      'const arrow = () => new Map();',
      'const callback = function () { return []; };',
      'const asyncCallback = async function () { return new Map(); };',
      'const functionAlias = callback;',
      'const declarationAlias = fn;',
      'const classAlias = Example;',
      'if (true) { const local = new Map(); let blockLocal = []; }',
    ].join('\n'),
  );
  assert.match(check(0), /需登记 0 个绑定，清单 0 个条目，通过/);

  // 非字面量的断言 / freeze、readonly 类型仍默认拒绝；纯算式放行。
  reset(
    [
      'const array: readonly number[] = [];',
      'const frozenCall = Object.freeze(makeState());',
      'const assertedCall = makeState() as const;',
      'const frozenIdentifier = Object.freeze(array);',
      'const computed = 2 * 3;',
      'if (true) { var hoisted = []; }',
    ].join('\n'),
  );
  errors(check(1), 5);

  reset(
    [
      "const prefix = 'x';",
      'const unit = 2;',
      'const product = unit * 3 + 1;',
      'const inverse = -product, complement = ~unit, truth = !false;',
      "const choose = product > unit ? prefix + 'yes' : 'no';",
      'const logic = (unit === 2 && truth) || false;',
      'const bits = (unit << 2) | (unit ^ 1);',
      'const modulo = product % unit, power = unit ** 3, division = power / unit;',
      'const shift = -1 >>> 2, relation = unit <= product && product >= unit && product != unit;',
      'const nullable = null ?? product, absent = undefined ?? nullable;',
      'const big = 2n * 3n, bigShift = big << 1n;',
      'const template = `${prefix}:${choose}:${absent}:${big}:${void 1}:${typeof true}`;',
      'const forward = later + 1; const later = 4;',
      'const fixed = { n: product, nested: { s: prefix }, fn: () => [] } as const;',
      'const { n: renamed, nested: { s } } = fixed;',
      'const member = fixed.n, index = fixed["n"], nested = fixed.nested.s;',
      'const derived = `${renamed * member}:${s}:${index}:${nested}`;',
      'const frozen = Object.freeze([unit, prefix]);',
      'const [first, second, ...rest] = frozen;',
      'const values = `${first}:${second}`;',
      'const copy = fixed, secondCopy = copy;',
      'const fnAlias = secondCopy.fn;',
      'const num = 0xff + 1_000, escaped = "a\\n";',
      'const primitiveFrozen = Object.freeze(2); const frozenSum = primitiveFrozen + 1;',
      'const { absent: fallback = 4 } = fixed; const fallbackSum = fallback + 1;',
      'const key = "n"; const { [key]: computedKey } = fixed; const computedSum = computedKey + 1;',
      'const frozenMethod = Object.freeze({ fn() {} }); const methodAlias = frozenMethod.fn;',
      'const shorthand = Object.freeze({ unit }); const shorthandSum = shorthand.unit * 2;',
      'const comma = (unit, product); const typeofPrimitive = typeof prefix;',
    ].join('\n'),
  );
  assert.match(check(0), /需登记 0 个绑定/);

  reset(
    [
      'const map = new Map();',
      'const alias = map;',
      'const chain = alias;',
      'const method = map.get;',
      'const { get: destructured } = map;',
      'const array = [];',
      'const [element] = array;',
      'const object = { fn: () => 1, n: 1 };',
      'const callback = object.fn;',
      'const { n } = object;',
      'const template = `${map}`;',
      'const fromCall = makePrimitive();',
      'const sum = fromCall + 1;',
      'const interpolation = `${fromCall}`;',
      'const conditional = true ? 1 : fromCall;',
      'const shortCircuit = false && fromCall;',
      'let mutableFunction = () => 1;',
      'const copiedMutable = mutableFunction;',
      'let primitive = 1;',
      'const copiedPrimitive = primitive;',
      'const cycleA = cycleB; const cycleB = cycleA;',
      'const invalidBig = 1n + 1;',
    ].join('\n'),
  );
  output = check(1);
  errors(output, 23);
  for (const name of [
    'alias',
    'chain',
    'method',
    'destructured',
    'element',
    'callback',
    'n',
    'copiedMutable',
    'copiedPrimitive',
    'cycleA',
    'cycleB',
  ]) {
    assert.match(output, new RegExp(` ${name} const / 别名 `));
  }
  assert.match(check(0, ['--report']), /需登记 23 个绑定/);

  reset(
    'const undefined = new Map();\nconst alias = undefined;\nconst frozen = Object.freeze(undefined);\nconst asserted = undefined as const;',
  );
  output = check(1);
  errors(output, 4);
  assert.match(output, /alias const \/ 别名 undefined/);
  reset('const Object = { freeze: () => new Map() };\nconst frozen = Object.freeze({});');
  errors(check(1), 2);

  // 内部 import / 转出跟随真实声明，不能借引入或转出把状态伪装成函数别名。
  reset(
    [
      "import { fn, N, state, frozen } from './reexports.js';",
      "import * as namespace from './reexports.js';",
      "import external from 'node:fs';",
      'const callable = fn;',
      'const arithmetic = N * 2;',
      'const importedConstant = `${N}`;',
      'const externalFn = external.readFileSync;',
      'const { value } = frozen;',
      'const copy = state;',
      'const method = state.get;',
      'const fromNamespace = namespace.state;',
      'const namespaceFn = namespace.fn;',
    ].join('\n'),
    "{ 'src/origin.ts:state': { kind: 'tenant', state: 'probe' }, 'src/probe.ts:copy': { kind: 'tenant', state: 'probe' }, 'src/probe.ts:method': { kind: 'tenant', state: 'probe' }, 'src/probe.ts:fromNamespace': { kind: 'tenant', state: 'probe' } }",
  );
  write(
    'src/origin.ts',
    'export function fn() {}\nexport const N = 3;\nexport const state = new Map();\nexport const frozen = { value: 1 } as const;\nregisterTenantState({ name: "probe" });',
  );
  write('src/reexports.ts', "export { fn, N, state, frozen } from './origin.js';");
  assert.match(check(0), /需登记 4 个绑定，清单 4 个条目，通过/);
  output = check(0, ['--report']);
  for (const name of ['copy', 'method', 'fromNamespace']) assert.match(output, new RegExp(` ${name} const / 别名 `));
  assert.ok(!output.includes(' callable '), output);

  reset('const state = new Map();\nconst alias = state;', "{ 'src/probe.ts:state': { kind: 'object-keyed' } }");
  output = check(1);
  errors(output, 1);
  assert.match(output, /src\/probe.ts:2 alias const \/ 别名 state 未登记/);

  // 跨行的工厂表达式也只输出一条，便于 report 与失败清单逐项计数。
  reset('const closure = (\n  makeFactory()\n)();');
  output = check(1);
  errors(output, 1);
  assert.match(output, /src\/probe.ts:1 closure const \/ 调用 \( makeFactory\(\) \)/);
  output = check(0, ['--report']);
  assert.equal(output.split('\n').filter((line) => line.startsWith('  ')).length, 1, output);

  reset('namespace State { export const map = new Map(); }');
  output = check(1);
  errors(output, 1);
  assert.match(output, /src\/probe.ts:1 State namespace \/ 模块对象/);
  reset('namespace State { export const map = new Map(); }', "{ 'src/probe.ts:State': { kind: 'instance', why: '固定命名空间' } }");
  assert.match(check(0), /需登记 1 个绑定，清单 1 个条目，通过/);

  reset('const { a: renamed, nested: { b }, ...rest } = makeState();\nconst [first, , ...tail] = makeState();');
  output = check(1);
  errors(output, 5);
  for (const name of ['renamed', 'b', 'rest']) assert.ok(output.includes(`src/probe.ts:1 ${name} `), output);
  for (const name of ['first', 'tail']) assert.ok(output.includes(`src/probe.ts:2 ${name} `), output);

  reset('const map = new Map();', "{ 'src/probe.ts:map': { kind: 'object-keyed' } }");
  assert.match(check(0), /需登记 1 个绑定，清单 1 个条目，通过/);

  reset('', "{ 'src/probe.ts:gone': { kind: 'instance', why: '进程配置' } }");
  output = check(1);
  errors(output, 1);
  assert.match(output, /陈旧条目 src\/probe.ts:gone/);

  reset('const map = new Map();', "{ 'src/probe.ts:map': { kind: 'tenant', state: 'probe.map' } }");
  output = check(1);
  errors(output, 1);
  assert.match(output, /tenant state probe\.map 缺少 registerTenantState 登记/);

  write('src/state.selftest.ts', "registerTenantState({ name: 'probe.map' });");
  errors(check(1), 1);
  write('src/registration.ts', "registerTenantState({ name: 'probe.map', drop() {} });");
  assert.match(check(0), /通过/);
  write('src/other.ts', "function install() { registerTenantState(({ name: 'probe.map' } as const)); }");
  output = check(1);
  errors(output, 1);
  assert.match(output, /src\/registration.ts:1/);
  assert.match(output, /src\/other.ts:1/);
  assert.match(output, /state probe\.map 重复登记（2 次）/);

  // 同一登记项可覆盖多个绑定，缺同名登记只报一次；动态 name 和注释不算登记。
  reset(
    'const map = new Map();\nconst list = [];',
    "{ 'src/probe.ts:map': { kind: 'tenant', state: 'probe' }, 'src/probe.ts:list': { kind: 'tenant', state: 'probe' } }",
  );
  write('src/registration.ts', "// registerTenantState({ name: 'probe' });\nregisterTenantState({ name: chooseName() });");
  errors(check(1), 1);
  write('src/registration.ts', "registerTenantState({ name: 'probe' });");
  assert.match(check(0), /需登记 2 个绑定，清单 2 个条目，通过/);

  reset('const map = new Map();', "{ 'src/probe.ts:map': { kind: 'instance', why: '' } }");
  assert.match(check(1), /无效清单分类/);
  reset('const map = new Map();', "{ 'src/probe.ts:map': { kind: 'object-keyed' }, 'src/probe.ts:map': { kind: 'object-keyed' } }");
  output = check(1);
  errors(output, 1);
  assert.match(output, /清单属性 src\/probe.ts:map 重复/);
  reset();
  write('src/tenancy/state-manifest.ts', 'export const STATE_MANIFEST = buildManifest();');
  assert.match(check(1), /STATE_MANIFEST 必须是对象字面量/);
  // report 不解析清单条目，清单不存在也可完成盘点。
  fs.rmSync(path.join(fixture, 'src/tenancy/state-manifest.ts'));
  assert.match(check(0, ['--report']), /扫描 1 个文件，需登记 0 个绑定/);
  assert.match(check(1), /缺少唯一的 STATE_MANIFEST/);

  reset('const list = [];', "{ 'src/probe.ts:list': { kind: 'instance', why: '固定表' }, 'src/view.tsx:cache': { kind: 'object-keyed' } }");
  write('src/view.tsx', 'const cache = new Map();\nexport function View() { return <div />; }');
  write('src/ignored.selftest.ts', 'let cache = new Map();');
  write('src/ignored.selftest.tsx', 'const cache = [];');
  assert.match(check(0), /扫描 3 个文件，需登记 2 个绑定，清单 2 个条目，通过/);
  // 损坏语法不能漏检后报成功。
  reset('const = ;');
  assert.match(check(1), /项错误/);

  console.log(`tenant-state selftest: ${count} 项通过`);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
