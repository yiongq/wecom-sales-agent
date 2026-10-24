// 租户镜像：只消费传入的品牌快照，发布期间不读 tenants.brand。
import fs from 'node:fs';
import path from 'node:path';
import { renderBrandTemplate, type BrandProfile, type PackRuntime, type SopContractRule } from '../core/pack-api.js';
import { renderSystemPrompt } from '../core/prompt.js';
import { sopConsistencyOf } from '../packs/registry.js';
import type { SopConsistencyCheck, SopPolicyCheck } from '../sop/contract.js';
import { decodeSopFile, splitSop, type SectionSpec, type SopSection } from '../sop/sections.js';

/**
 * 08 R10：行业包的 SOP 镜像文件。旅游照旧是 data/sop.md；其他包的参考配置在 data/packs/<包 id>/sop.md（R11），
 * 内容只当可编辑节的默认正文，锁定节与前言由包的模板按品牌渲染（tenantImage）。包 id 必须已经过注册表校验。
 */
export function imageSopFile(packId: string, root: string = process.cwd()): string {
  if (!/^[A-Za-z0-9_-]+$/.test(packId)) throw new Error('行业包 id 不合法');
  return packId === 'travel' ? path.join(root, 'data', 'sop.md') : path.join(root, 'data', 'packs', packId, 'sop.md');
}

/** 读镜像文本：严格 UTF-8 解码，非法字节直接拒绝 */
export function readImageSop(packId: string, root?: string): string {
  return decodeSopFile(fs.readFileSync(imageSopFile(packId, root)));
}

/**
 * 08 R10：契约检查里随包变的输入，全部取绑定包，调用方不再有旅游缺省：节表、契约规则（按模式）、一致性检查、policy 检查。
 * policy 是要查的政策快照值；包没有 policy 能力或没有 lint 时不查。
 */
export function contractInputs(
  runtime: PackRuntime,
  brand: BrandProfile | null,
  policy: unknown,
): {
  spec: SectionSpec[];
  rules: SopContractRule[];
  brand: BrandProfile | null;
  consistency: SopConsistencyCheck | null;
  policy: SopPolicyCheck | null;
} {
  return {
    spec: runtime.sopSections,
    rules: runtime.contractRules(brand ? { brand } : 'legacy'),
    brand,
    consistency: sopConsistencyOf(runtime),
    policy: runtime.policy?.lint ? { lint: runtime.policy.lint, value: policy } : null,
  };
}

export function tenantImage(runtime: PackRuntime, legacyImage: string, brand: BrandProfile | null): SopSection[] {
  const image = splitSop(legacyImage, runtime.sopSections);
  if (brand === null) return image;
  return image.map((section) => {
    const spec = runtime.sopSections.find((s) => s.key === section.key)!;
    const template = spec.locked
      ? runtime.templates.lockedSectionTemplates[section.key]
      : section.key === 'preamble'
        ? runtime.templates.preamble
        : undefined;
    if (spec.locked && template === undefined) throw new Error(`锁定节 ${section.key} 缺少模板`);
    return template === undefined ? section : { ...section, text: renderBrandTemplate(template, brand) };
  });
}

export function tenantRenderer(runtime: PackRuntime, brand: BrandProfile): (sop: string) => string {
  const hard = renderBrandTemplate(runtime.templates.hardRequirements, brand);
  return (sop) => renderSystemPrompt(sop, hard);
}

/** 前言只在与上一模式的默认值逐字节相同时随品牌切换。 */
export function switchPreamble(stored: readonly SopSection[], before: readonly SopSection[], after: readonly SopSection[]): SopSection[] {
  return stored.map((s) =>
    s.key === 'preamble' && s.text === before.find((x) => x.key === s.key)?.text
      ? { ...s, text: after.find((x) => x.key === s.key)!.text }
      : { ...s },
  );
}

export function preambleWarning(sections: readonly SopSection[], image: readonly SopSection[]): boolean {
  return sections.find((s) => s.key === 'preamble')?.text !== image.find((s) => s.key === 'preamble')?.text;
}
