// 文件模式的已发布政策读取；同步读者与配置装配共用，不反向装载包注册表。
import fs from 'node:fs';
import path from 'node:path';
import type { PackPolicy } from '../core/pack-api.js';
import { deepFreeze } from '../shared/freeze.js';
import { policySnapshot } from './hashes.js';

export function readFilePolicy(pack: PackPolicy | undefined): ReturnType<typeof policySnapshot> {
  const file = path.join(path.dirname(process.env.SOP_PATH ?? path.join(process.cwd(), 'data', 'sop.md')), 'policy.json');
  const value = fs.existsSync(file) ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))) : pack?.defaults;
  const snapshot = policySnapshot(pack, value);
  const violations = pack?.lint?.(snapshot.policy) ?? [];
  if (violations.length) throw new Error(`policy_invalid: ${violations.map((v) => v.detail).join('；')}`);
  return deepFreeze(snapshot);
}
