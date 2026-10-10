// 虚构品牌仅装在评测夹具；生产发布写路径另由配置自测验证。
import fs from 'node:fs';
import path from 'node:path';
import { shanhaiBrand } from '../../src/packs/travel/brand-fixture.js';
import { bindPack } from '../../src/core/pack-api.js';
import { renderBrandTemplate } from '../../src/core/brand.js';
import { tenantImage, tenantRenderer } from '../../src/config/brand.js';
import { brandSnapshot, promptHashes } from '../../src/config/hashes.js';
import { configMode, currentPack, currentSop, replacePublishedSop } from '../../src/config/source.js';
import { joinSop } from '../../src/sop/sections.js';
import type { CaseV2 } from './schema.js';

export function brandCase(c: CaseV2, name: string): CaseV2 {
  if (name !== 'shanhai') throw new Error(`brand: 未注册的夹具 ${name}`);
  const text = (s: string) => s.replaceAll('云途定制旅行', shanhaiBrand.brandName);
  return {
    ...c,
    brand: name,
    turns: c.turns.map((t) => ({
      ...t,
      script: t.script?.map((s) => ({ ...s, ...(s.content === undefined ? {} : { content: text(s.content) }) })),
      expect: { ...t.expect, replyMatches: t.expect.replyMatches?.map(text), replyExcludes: t.expect.replyExcludes?.map(text) },
    })),
  };
}

export function installBrand(name: string | undefined, dir: string): () => void {
  const binding = currentPack();
  const previousPath = process.env.SOP_PATH;
  if (!name) return () => {};
  if (name !== 'shanhai') throw new Error(`brand: 未注册的夹具 ${name}`);
  const brand = shanhaiBrand;
  const source = fs.readFileSync(previousPath ?? 'data/sop.md', 'utf8');
  const sections = tenantImage(binding.runtime, source, brand);
  const sop = joinSop(sections);
  if (configMode() === 'db') {
    const current = currentSop();
    const renderedPrompt = tenantRenderer(binding.runtime, brand)(sop);
    replacePublishedSop({
      ...current,
      versionNo: current.versionNo + 1,
      sections,
      renderedPrompt,
      ...promptHashes(renderedPrompt, JSON.stringify(binding.runtime.tools.map((t) => t.def)), sop),
      ...brandSnapshot(brand),
    });
    return () => replacePublishedSop({ ...current, versionNo: currentSop().versionNo + 1 });
  }
  const file = path.join(dir, 'brand-sop.md');
  fs.writeFileSync(file, sop);
  process.env.SOP_PATH = file;
  bindPack(
    {
      ...binding.runtime,
      legacy: { ...binding.runtime.legacy, hardRequirements: renderBrandTemplate(binding.runtime.templates.hardRequirements, brand) },
    },
    brand,
  );
  return () => {
    if (previousPath === undefined) delete process.env.SOP_PATH;
    else process.env.SOP_PATH = previousPath;
    bindPack(binding.runtime, binding.brand);
    fs.rmSync(file, { force: true });
  };
}
