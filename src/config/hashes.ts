// 四个哈希与 render_inputs 的算法（spec「渲染与哈希」）。导入、启动装载、发布、回滚、导出都用这一份，
// 任何一处算法不同，存下来的哈希就对不上。
import { createHash } from 'node:crypto';
import type { RenderInputs } from '../db/schema.js';
import { TRAVEL_SOP_SECTIONS, type SectionSpec } from '../sop/sections.js';

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface PromptHashes {
  promptHash: string;
  toolsHash: string;
  prefixHash: string;
  sopHash: string;
}

/** rendered 是整段 system；toolsJson 是 JSON.stringify(toolDefs)；sop 是 joinSop(sections) */
export function promptHashes(rendered: string, toolsJson: string, sop: string): PromptHashes {
  const promptHash = sha256(rendered);
  const toolsHash = sha256(toolsJson);
  return { promptHash, toolsHash, prefixHash: sha256(toolsHash + promptHash), sopHash: sha256(sop) };
}

/** 启动重渲染据此判断是哪类输入变了：硬性要求、镜像的 SOP（锁定节随它）、节表、工具定义 */
export function renderInputsFor(
  render: (sop: string) => string,
  imageSop: string,
  toolsJson: string,
  spec: readonly SectionSpec[] = TRAVEL_SOP_SECTIONS,
): RenderInputs {
  return {
    hardRulesHash: sha256(render('')),
    imageSopHash: sha256(imageSop),
    sectionTableHash: sha256(JSON.stringify(spec)),
    toolsHash: sha256(toolsJson),
  };
}
