// 租户镜像：只消费传入的品牌快照，发布期间不读 tenants.brand。
import { renderBrandTemplate, type BrandProfile, type PackRuntime } from '../core/pack-api.js';
import { renderSystemPrompt } from '../core/prompt.js';
import { splitSop, type SopSection } from '../sop/sections.js';

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
