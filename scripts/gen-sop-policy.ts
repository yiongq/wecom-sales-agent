// 默认检查镜像；只有 --write 才改写六个生成段中位于 SOP 的部分。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultTravelPolicy, sopPolicyMirror } from '../src/packs/travel/policy.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--write') || args.length > 1) throw new Error('用法：gen-sop-policy.ts [--write]');
    const file = new URL('../data/sop.md', import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    const rendered = sopPolicyMirror(source, defaultTravelPolicy, args.includes('--write'));
    if (args.includes('--write') && rendered !== source) fs.writeFileSync(file, rendered);
    console.log(`SOP policy 生成段${args.includes('--write') ? '已同步' : '检查通过'}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
