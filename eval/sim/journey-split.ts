// 16 R1：先固定 id 清单，再按族内哈希顺序切分，不按场景内容挑选。
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const JOURNEY_COUNTS = {
  标准成交: [2, 3],
  写法不规范: [2, 2],
  多行清单: [1, 2],
  阶梯起订量: [2, 3],
  库存交期: [1, 2],
  中途改需求: [1, 2],
  砍价施压: [1, 2],
  必须转人工: [2, 3],
  库外与替代: [1, 1],
  附件询价: [1, 1],
  注入越权: [1, 2],
  顾问驳回: [1, 1],
} as const;
export const JOURNEY_DIR = 'eval/sim/goals/industrial/journey';
export interface JourneyId {
  id: string;
  family: string;
}
export function splitJourney(ids: JourneyId[]): Map<string, 'dev' | 'holdout'> {
  const result = new Map<string, 'dev' | 'holdout'>();
  if (new Set(ids.map((v) => v.id)).size !== ids.length) throw new Error('journey id 重复');
  if (ids.some((v) => !Object.hasOwn(JOURNEY_COUNTS, v.family))) throw new Error('journey 场景族未知');
  for (const [family, [dev, holdout]] of Object.entries(JOURNEY_COUNTS)) {
    const group = ids.filter((v) => v.family === family);
    if (group.length !== dev + holdout) throw new Error(`${family}: 场景数不符`);
    const hash = (id: string): string =>
      createHash('sha256')
        .update(id + 'journey-holdout')
        .digest('hex');
    group.sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
    group.forEach((v, i) => result.set(v.id, i < holdout ? 'holdout' : 'dev'));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = JSON.parse(await fs.readFile(`${JOURNEY_DIR}/ids.json`, 'utf8')) as JourneyId[];
  const splits = splitJourney(ids);
  console.log(
    JSON.stringify(
      ids.map((v) => ({ ...v, split: splits.get(v.id) })),
      null,
      2,
    ),
  );
}
