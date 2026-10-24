// 08 R11：PGlite 配置下的非旅游包。旅游走 installSeededConfig（把 data/ 导入再装载）；
// import-config 对非旅游包的产品部分还没有，所以这里造一个该包的租户，把参考配置目录
// （data/packs/<包>/ 的 sop.md、brand.json、catalog/<kind>.json）发布成 v1，再装成配置源。
// 只给 eval/run.ts 这个组合根调用：库的测试装配（src/db/testing.ts）由它传进来，v2 的 worker 不依赖它。
import fs from 'node:fs';
import path from 'node:path';
import { BrandProfileSchema } from '../../src/core/pack-api.js';
import { withTenant, type Db } from '../../src/db/client.js';
import { insertActiveItems } from '../../src/db/repo/catalog.js';
import { insertCatalogVersion } from '../../src/db/repo/catalog-versions.js';
import { insertPublishedSop } from '../../src/db/repo/sop.js';
import { insertTenant } from '../../src/db/repo/tenants.js';
import { contractInputs, tenantImage, tenantRenderer } from '../../src/config/brand.js';
import { promptHashes, renderInputsFor, sha256 } from '../../src/config/hashes.js';
import { initConfig, packSources, type ConfigDeps } from '../../src/config/source.js';
import { runtimeById } from '../../src/packs/registry.js';
import { checkSopContract } from '../../src/sop/contract.js';
import { editableChars, joinSop, mergeWithImage } from '../../src/sop/sections.js';

const ACTOR = { kind: 'system' as const, userId: null, name: null, ip: null };
const BY = 'eval-v2';

/** 该包的评测租户的 slug（满足 tenants_slug_check） */
export const packTenantSlug = (packId: string): string =>
  `eval-${packId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`;

/**
 * 建租户（包与品牌取参考配置）、发布 v1（模板模式，source='import'）、上架 catalog/*.json 的全部条目与它们的 v1 版本，再 initConfig。
 * 调用后连接仍是 agent_app，与 installSeededConfig 之后相同；会话存储另用同一个 slug 装（installPgSessionStore）。
 */
export async function installSeededPackConfig(
  t: { db: Db; pg: { exec(sql: string): Promise<unknown> } },
  opts: { packId: string; dir: string; configDeps: ConfigDeps },
): Promise<void> {
  const { packId, dir } = opts;
  const slug = packTenantSlug(packId);
  const runtime = runtimeById(packId, packSources());
  if (!runtime) throw new Error(`pack: 行业包「${packId}」没有登记（证明包要 PACK_FIXTURES=1）`);
  const brand = BrandProfileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8')));
  const imageSop = fs.readFileSync(path.join(dir, 'sop.md'), 'utf8');
  await t.pg.exec('RESET ROLE'); // 建租户是平台的事，以超级用户做
  const tenant = await insertTenant(t.db, { slug, name: `${packId} 评测租户`, packId, locale: 'zh-CN', region: 'CN', brand });
  await t.pg.exec('SET ROLE agent_app');
  const ctx = { tenantId: tenant.id, actor: ACTOR };

  // 首次发布：与 importConfig 的 SOP 部分同一组构件（没有 policy）
  const image = tenantImage(runtime, imageSop, brand);
  const render = tenantRenderer(runtime, brand);
  const merged = mergeWithImage(image, image, runtime.sopSections);
  const sop = joinSop(merged);
  const rendered = render(sop);
  const toolsJson = JSON.stringify(runtime.tools.map((x) => x.def));
  const violations = checkSopContract({
    sections: merged,
    imageSections: image,
    rendered,
    toolNames: runtime.tools.map((x) => x.def.function.name),
    knownFields: runtime.knownFields.names,
    baselineEditableChars: editableChars(merged, runtime.sopSections),
    ...contractInputs(runtime, brand, null),
    hardRequirements: render(''),
  });
  if (violations.length) throw new Error(`pack: 参考配置过不了契约检查：${violations.map((v) => v.code).join('、')}`);
  await withTenant(t.db, ctx, async (tx) => {
    await insertPublishedSop(tx, {
      tenantId: tenant.id,
      versionNo: 1,
      source: 'import',
      packId,
      sections: merged,
      basedOn: null,
      renderedPrompt: rendered,
      ...promptHashes(rendered, toolsJson, sop),
      policy: null,
      renderInputs: renderInputsFor(render, joinSop(image), toolsJson, runtime.sopSections, brand, sha256('null')),
      changeNote: '首次导入',
      createdBy: null,
      createdByName: BY,
    });
    for (const kind of Object.keys(runtime.catalog)) {
      const file = path.join(dir, 'catalog', `${kind}.json`);
      const items = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []) as { id: string }[];
      if (!items.length) continue;
      await insertActiveItems(tx, tenant.id, kind, items, { userId: null, name: BY });
      for (const item of items)
        await insertCatalogVersion(tx, { kind, code: item.id, version: 1, payload: item, source: 'activate', createdByName: BY });
    }
  });
  await initConfig({ ...opts.configDeps, tenantSlug: slug });
}
