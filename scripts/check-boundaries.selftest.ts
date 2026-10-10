// 04 R2：在临时夹具中验证依赖方向，涵盖 import type、转出与动态加载。
// 不改工作区，也不引入测试框架；CLI 与 pnpm lint 用的是同一个检查器。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checker = path.join(import.meta.dirname, 'check-boundaries.ts');
const tsx = path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-boundaries-'));
let count = 0;

function check(file: string, source: string, rule: string | null): void {
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
    }
    count++;
  } finally {
    fs.rmSync(target);
  }
}

try {
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
  console.log(`boundaries selftest: ${count} 项通过`);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
