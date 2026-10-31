import fs from 'node:fs';
import path from 'node:path';
import type { TrialBatch } from '../../db/repo/trial-reset.js';
import { SPILL_FILE_RE } from '../../store/project.js';
import { RESTORE_SENTINEL } from '../../channels/markers.js';

/** 完成重置也不能重放已删除会话的旧 spill；只读检查，绝不改名或删除恢复材料。 */
export function assertTrialReplaySafe(batches: ReadonlyMap<string, TrialBatch>, tenantId: string, varDir: string): void {
  if (!batches.size) return;
  const deleted = new Set([...batches.values()].flatMap((b) => b.checkpoint.targetConversationRefs));
  const latest = Math.max(...[...batches.values()].map((b) => b.updatedAt.getTime()));
  let names: string[];
  try {
    if (!fs.statSync(varDir, { throwIfNoEntry: false })) return;
    names = fs.readdirSync(varDir);
  } catch {
    throw new Error('trial_reset_replay_unreadable');
  }
  for (const name of names.filter((n) => SPILL_FILE_RE.test(n) || n === RESTORE_SENTINEL)) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(varDir, name), 'utf8'));
      if (name === RESTORE_SENTINEL) {
        const at = Date.parse(doc.backupAt);
        if (!Number.isFinite(at) || at <= latest) throw new Error();
      } else {
        if (typeof doc.tenant === 'string' && doc.tenant !== tenantId) continue;
        if (
          doc.tenant !== tenantId ||
          doc.version !== 1 ||
          !Number.isFinite(doc.at) ||
          doc.at <= latest ||
          !Array.isArray(doc.sessions) ||
          doc.sessions.some(
            (entry: unknown) =>
              !entry || typeof entry !== 'object' || !('ref' in entry) || typeof entry.ref !== 'string' || deleted.has(entry.ref),
          )
        )
          throw new Error();
      }
    } catch {
      throw new Error('trial_reset_replay_unsafe');
    }
  }
}
