import { readFileSync } from 'node:fs';
import { RUNBOOKS, isRunbookKey } from '../shared/alert-policy.js';
import type { RunbookView } from '../shared/console-api.js';

// 公共静态文档进程内只读一次；缺失/不完整延迟到请求时返回 503。
let sections: Map<string, string> | null | undefined;
export function readRunbook(key: string): RunbookView | null | undefined {
  if (!isRunbookKey(key)) return undefined;
  if (sections === undefined) {
    try {
      const text = readFileSync(new URL('../../docs/ops/observability.md', import.meta.url), 'utf8');
      sections = new Map([...text.matchAll(/^## (RB-\d{2}) ([a-z_]+) · (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map((m) => [m[2]!, m[0]]));
      if (Object.values(RUNBOOKS).some((b) => !sections?.get(b.key)?.startsWith(`## ${b.code} ${b.key} · ${b.title}\n`))) sections = null;
    } catch {
      sections = null;
    }
  }
  if (!sections) return null;
  return { ...RUNBOOKS[key], body: sections.get(key)! };
}
