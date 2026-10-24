// 导入与导出（docs/architecture/01-pg-config-console/spec.md「导入、导出与回滚」）。命令行是薄包装，逻辑在这里，自测直接调用。
// 退出码：0 成功或已一致；2 库里已有不一致的内容；3 拿不到租户锁；1 其他错误。
import fs from 'node:fs';
import path from 'node:path';
import { currentTenantCtx, lockTenantConfig, withTenant, type Db, type TenantCtx, type TenantLock, type Tx } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { countCatalogItems, insertActiveItems, readActiveCatalog, type CatalogKind } from '../db/repo/catalog.js';
import { insertCatalogVersion } from '../db/repo/catalog-versions.js';
import { countSopVersions, insertPublishedSop, readPublishedSop } from '../db/repo/sop.js';
import { findTenantBySlug, readBrand } from '../db/repo/tenants.js';
import { renderSystemPrompt as renderPackSystemPrompt } from '../core/prompt.js';
import type { PackRuntime } from '../core/pack-api.js';
import { HotelSchema, RouteSchema } from '../shared/catalog.js';
import { checkSopContract } from '../sop/contract.js';
import { decodeSopFile, editableChars, joinSop, mergeWithImage, splitSop, type SopSection } from '../sop/sections.js';
import { runtimeById } from '../packs/registry.js';
import { assertKind } from './catalog.js';
import { packSources } from './source.js';
import { contractInputs, tenantImage, tenantRenderer, switchPreamble } from './brand.js';
import { promptHashes, publishedBrand, policySnapshot, publishedPolicy, renderInputsFor, type PromptHashes } from './hashes.js';

export const EXIT = { ok: 0, error: 1, inconsistent: 2, locked: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface TransferResult {
  code: ExitCode;
  /** 给人看的一句话，命令行原样打印 */
  message: string;
  hashes?: PromptHashes & { policyHash?: string };
  versionNo?: number;
}

/** 渲染与契约检查用到的代码侧输入，默认取绑定包的运行时（08 R10） */
export interface CodeInputs {
  toolsJson: string;
  toolNames: readonly string[];
  knownFields: readonly string[];
  render(sop: string): string;
}
/** 工具、已知字段与旧版渲染都从包的运行时派生，不再取旅游的模块级常量；旅游取到的字节与原来相同 */
export const imageCode = (runtime: PackRuntime): CodeInputs => ({
  toolsJson: JSON.stringify(runtime.tools.map((t) => t.def)),
  toolNames: runtime.tools.map((t) => t.def.function.name),
  knownFields: runtime.knownFields.names,
  render: (sop) => renderPackSystemPrompt(sop, runtime.legacy.hardRequirements),
});

const fail = (message: string): TransferResult => ({ code: EXIT.error, message });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const platformCtx = (tenantId: string, name: string): TenantCtx => ({
  tenantId,
  actor: { kind: 'platform', userId: null, name, ip: null },
});

/** 条目文件：数组，每条都过 schema，id 不重复。返回原对象（写库的是原对象，不是 zod 的输出） */
function readItems(dir: string, file: string, kind: CatalogKind): Record<string, unknown>[] {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file} 不是数组`);
  const schema = kind === 'route' ? RouteSchema : HotelSchema;
  const seen = new Set<string>();
  raw.forEach((item: unknown, i) => {
    const r = schema.safeParse(item);
    if (!r.success) {
      const issues = r.error.issues.map((x) => `${x.path.join('.') || '（整条）'}：${x.message}`).join('；');
      throw new Error(`${file} 第 ${i + 1} 条不合格：${issues}`);
    }
    const id = String((item as { id: string }).id);
    if (seen.has(id)) throw new Error(`${file} 里 id「${id}」重复`);
    seen.add(id);
  });
  return raw as Record<string, unknown>[];
}

const itemKey = (kind: CatalogKind, code: string, ord: number, payload: unknown): string =>
  `${kind}|${code}|${ord}|${JSON.stringify(payload)}`;

/** 05 R9：发布快照复制为新租户 v1；按本镜像与快照品牌渲染，不能复制待生效品牌或历史元数据。 */
export async function writeTemplateConfig(
  tx: Tx,
  pub: NonNullable<Awaited<ReturnType<typeof readPublishedSop>>>,
  items: Awaited<ReturnType<typeof readActiveCatalog>>,
  imageSop: string,
): Promise<PromptHashes> {
  const { tenantId } = currentTenantCtx();
  const runtime = runtimeById(pub.packId, packSources());
  if (!runtime) throw new Error('pack_unknown');
  for (const row of items) assertKind(pub.packId, row.kind);
  const brand = publishedBrand(pub.renderInputs).brand;
  const policy = publishedPolicy(runtime.policy, pub);
  const render = brand ? tenantRenderer(runtime, brand) : (sop: string) => renderPackSystemPrompt(sop, runtime.legacy.hardRequirements);
  const imageSections = tenantImage(runtime, imageSop, brand);
  const merged = mergeWithImage(pub.sections, imageSections, runtime.sopSections);
  const sop = joinSop(merged);
  const rendered = render(sop);
  const toolsJson = JSON.stringify(runtime.tools.map((t) => t.def));
  const hashes = promptHashes(rendered, toolsJson, sop);
  if (Object.entries(hashes).some(([key, value]) => pub[key as keyof PromptHashes] !== value) || pub.renderedPrompt !== rendered)
    throw new Error('sandbox_template_unpublished_inputs');
  const violations = checkSopContract({
    sections: merged,
    imageSections,
    rendered,
    toolNames: runtime.tools.map((t) => t.def.function.name),
    knownFields: runtime.knownFields.names,
    baselineEditableChars: editableChars(merged, runtime.sopSections),
    ...contractInputs(runtime, brand, policy.policy),
    hardRequirements: render(''),
  });
  if (violations.length) throw new Error('sandbox_template_contract_failed');
  await insertPublishedSop(tx, {
    tenantId,
    versionNo: 1,
    source: 'import',
    packId: pub.packId,
    sections: merged,
    basedOn: null,
    renderedPrompt: rendered,
    ...hashes,
    policy: policy.policy,
    renderInputs: renderInputsFor(render, joinSop(imageSections), toolsJson, runtime.sopSections, brand, policy.policyHash),
    changeNote: null,
    createdBy: null,
    createdByName: null,
  });
  for (const kind of Object.keys(runtime.catalog)) {
    const rows = items.filter((row) => row.kind === kind);
    await insertActiveItems(
      tx,
      tenantId,
      kind,
      rows.map((row) => row.payload),
      { userId: null, name: null },
      rows.map((row) => row.ord),
    );
    for (const row of rows)
      await insertCatalogVersion(tx, {
        kind,
        code: row.code,
        version: 1,
        payload: row.payload,
        source: 'activate',
        createdByName: null,
      });
  }
  return hashes;
}

export interface ImportOptions {
  db: Db;
  tenantSlug: string;
  /** --data：sop.md、routes.json、hotels.json 所在目录 */
  dataDir: string;
  /**
   * 镜像 SOP 的全文，锁定节以它为准。给函数时在解析出租户的包之后才取（旅游 data/sop.md，其他包 data/packs/<id>/sop.md，08 R10），
   * 命令行用 readImageSop；自测直接给字符串。
   */
  imageSop: string | ((packId: string) => string);
  lock(tenantId: string): Promise<TenantLock | null>;
  dryRun?: boolean;
  code?: CodeInputs;
}

/**
 * 首次导入：租户下既没有 SOP 版本也没有条目时，在一个事务里写入 v1（source='import'，直接 published）、
 * 全部条目（active，ord 就是数组下标）和一行 config.import 审计。库里已有内容时只做一致性判定，库不动。
 * 之后的修改走后台，这里不覆盖任何东西
 */
export async function importConfig(o: ImportOptions): Promise<TransferResult> {
  const tenant = await findTenantBySlug(o.db, o.tenantSlug);
  if (!tenant) return fail(`tenant_not_found：没有 slug 为「${o.tenantSlug}」的租户，先跑 tenant-create`);
  const runtime = runtimeById(tenant.packId, packSources());
  if (!runtime) return fail('pack_unknown：没有行业包运行时');
  let code = o.code ?? imageCode(runtime);
  const spec = runtime.sopSections;
  // 本步保留旅游文件与循环；在读取、加锁和任何写入之前校验它们的 kind。
  try {
    assertKind(tenant.packId, 'route');
    assertKind(tenant.packId, 'hotel');
  } catch (e) {
    return fail(message(e));
  }
  const brand = (await readBrand(o.db, tenant.id)) ?? null;
  // 待 owner 确认（plan Open 1）：非旅游包只支持模板模式（08 R10），没有品牌的租户启动会被 brand_required 拒绝，所以不导入
  if (runtime.id !== 'travel' && brand === null) return fail(`brand_required：行业包「${runtime.id}」只支持模板模式，租户要先设置品牌档案`);
  // 镜像在解析出租户的包之后才取
  let imageSop: string;
  try {
    imageSop = typeof o.imageSop === 'string' ? o.imageSop : o.imageSop(tenant.packId);
  } catch (e) {
    return fail(`image_sop_invalid：读不到行业包「${tenant.packId}」的镜像 SOP：${message(e)}`);
  }
  if (brand) code = { ...code, render: tenantRenderer(runtime, brand) };
  // DB 模式的应用在跑时持着锁：拿不到就别动库
  const lock = await o.lock(tenant.id);
  if (!lock) return { code: EXIT.locked, message: `lock_held：租户「${o.tenantSlug}」的锁在别的进程手里（应用正以 DB 模式运行？）` };
  try {
    let sections: SopSection[];
    let routes: Record<string, unknown>[];
    let hotels: Record<string, unknown>[];
    let imageSections: SopSection[];
    let policy: ReturnType<typeof policySnapshot>;
    try {
      const file = path.join(o.dataDir, 'policy.json');
      const raw = fs.existsSync(file)
        ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)))
        : runtime.policy?.defaults;
      policy = policySnapshot(runtime.policy, raw);
    } catch {
      return fail('policy_invalid：policy.json 不合格');
    }
    try {
      imageSections = tenantImage(runtime, imageSop, brand);
      sections = splitSop(decodeSopFile(fs.readFileSync(path.join(o.dataDir, 'sop.md'))), spec);
      routes = readItems(o.dataDir, 'routes.json', 'route');
      hotels = readItems(o.dataDir, 'hotels.json', 'hotel');
    } catch (e) {
      return fail(`文件不合格：${message(e)}`);
    }
    const changed = spec.filter(
      (s) =>
        s.locked &&
        sections.find((x) => x.key === s.key)?.text !== imageSections.find((x) => x.key === s.key)?.text &&
        sections.find((x) => x.key === s.key)?.text !== splitSop(imageSop, spec).find((x) => x.key === s.key)?.text,
    );
    if (changed.length) return fail(`locked_changed：sop.md 的锁定节与镜像不一致：${changed.map((s) => s.heading).join('、')}`);
    const stored = brand ? switchPreamble(sections, splitSop(imageSop, spec), imageSections) : sections;
    const merged = mergeWithImage(stored, imageSections, spec);
    const sopText = joinSop(merged);
    const rendered = code.render(sopText);
    // 预算基线就是它自己：导入不会 over_budget
    const violations = checkSopContract({
      sections: merged,
      imageSections,
      rendered,
      toolNames: code.toolNames,
      knownFields: code.knownFields,
      baselineEditableChars: editableChars(merged, spec),
      ...contractInputs(runtime, brand, policy.policy),
      hardRequirements: code.render(''),
    });
    if (violations.length)
      return fail(`contract_failed：${violations.map((v) => `${v.code}${v.sectionKey ? `@${v.sectionKey}` : ''} ${v.detail}`).join('；')}`);
    const hashes = { ...promptHashes(rendered, code.toolsJson, sopText), policyHash: policy.policyHash };

    return await withTenant(o.db, platformCtx(tenant.id, 'import-config'), async (tx) => {
      await lockTenantConfig(tx);
      if ((await countSopVersions(tx)) === 0 && (await countCatalogItems(tx)) === 0) {
        if (o.dryRun) return { code: EXIT.ok, hashes, message: `dry-run：会写入 SOP v1、${routes.length} 条线路、${hotels.length} 家酒店` };
        await insertPublishedSop(tx, {
          tenantId: tenant.id,
          versionNo: 1,
          source: 'import',
          packId: tenant.packId,
          sections: merged,
          basedOn: null,
          renderedPrompt: rendered,
          ...hashes,
          policy: policy.policy,
          renderInputs: renderInputsFor(code.render, joinSop(imageSections), code.toolsJson, spec, brand, policy.policyHash),
          changeNote: '首次导入',
          createdBy: null,
          createdByName: 'import-config',
        });
        const by = { userId: null, name: 'import-config' };
        await insertActiveItems(tx, tenant.id, 'route', routes, by);
        await insertActiveItems(tx, tenant.id, 'hotel', hotels, by);
        // 导入直接是 active，等于上架：每条写版本 1（02「报价快照」），之后启动时就没有要补写的
        for (const [kind, list] of [
          ['route', routes],
          ['hotel', hotels],
        ] as const) {
          for (const payload of list) {
            await insertCatalogVersion(tx, {
              kind,
              code: String(payload.id),
              version: 1,
              payload,
              source: 'activate',
              createdByName: by.name,
            });
          }
        }
        await writeAudit(tx, { action: 'config.import', diff: { sections: merged.length, routes: routes.length, hotels: hotels.length } });
        return { code: EXIT.ok, hashes, versionNo: 1, message: `已导入 SOP v1、${routes.length} 条线路、${hotels.length} 家酒店` };
      }
      // 已有内容：一致 = 当前已发布版本的可编辑节等于文件切出的可编辑节，且每条 active 条目与文件完全一致。
      // rerender 版本（只动锁定节）和 draft 条目不影响判定
      const pub = await readPublishedSop(tx);
      const editable = spec.filter((s) => !s.locked);
      const pubMerged = pub ? mergeWithImage(pub.sections, imageSections, spec) : [];
      const sopSame =
        !!pub &&
        publishedPolicy(runtime.policy, pub).policyHash === policy.policyHash &&
        editable.every((s) => pubMerged.find((x) => x.key === s.key)?.text === merged.find((x) => x.key === s.key)?.text);
      // 两边按同一个顺序排好再逐条比（库里按 kind、ord 读出，hotel 排在 route 前面）
      const inDb = (await readActiveCatalog(tx)).map((r) => itemKey(r.kind, r.code, r.ord, r.payload)).toSorted();
      const inFile = [
        ...routes.map((r, i) => itemKey('route', String(r.id), i, r)),
        ...hotels.map((h, i) => itemKey('hotel', String(h.id), i, h)),
      ].toSorted();
      const itemsSame = inDb.length === inFile.length && inDb.every((k, i) => k === inFile[i]);
      if (sopSame && itemsSame)
        return { code: EXIT.ok, hashes, versionNo: pub?.versionNo ?? undefined, message: '库里已是这份内容，没有写入' };
      const why = [sopSame ? '' : 'SOP 的可编辑节不同', itemsSame ? '' : '产品库的 active 条目不同'].filter(Boolean).join('、');
      return { code: EXIT.inconsistent, message: `库里已有不同的内容（${why}），import 只做首次导入，库没动；之后的修改走后台` };
    });
  } finally {
    await lock.release();
  }
}

export interface ExportOptions {
  db: Db;
  tenantSlug: string;
  outDir: string;
  /** 镜像 SOP 的全文；给函数时在读出租户的包之后才取，同 ImportOptions.imageSop */
  imageSop: string | ((packId: string) => string);
  /** --image-sop：回到旧版本时，用目标版本的 data/sop.md 合并锁定节 */
  targetImageSop?: string;
  code?: CodeInputs;
}

/**
 * 在一个 REPEATABLE READ READ ONLY 事务里一次读出已发布版本和全部 active 条目，写成 SOP、条目与已发布品牌。
 * 只读库，应用可以照常在跑
 */
export async function exportConfig(o: ExportOptions): Promise<TransferResult> {
  const tenant = await findTenantBySlug(o.db, o.tenantSlug);
  if (!tenant) return fail(`tenant_not_found：没有 slug 为「${o.tenantSlug}」的租户`);
  const { pub, items } = await withTenant(
    o.db,
    platformCtx(tenant.id, 'export-config'),
    async (tx) => ({ pub: await readPublishedSop(tx), items: await readActiveCatalog(tx) }),
    { isolation: 'repeatable read', readOnly: true },
  );
  if (!pub) return fail(`no_published_sop：租户「${o.tenantSlug}」没有已发布的 SOP`);
  const runtime = runtimeById(pub.packId, packSources());
  if (!runtime) return fail('pack_unknown：没有行业包运行时');
  let brand: ReturnType<typeof publishedBrand>['brand'];
  try {
    brand = publishedBrand(pub.renderInputs).brand;
  } catch (e) {
    return fail(`品牌快照不合格：${message(e)}`);
  }
  const policy = publishedPolicy(runtime.policy, pub);
  let code = o.code ?? imageCode(runtime);
  if (brand) code = { ...code, render: tenantRenderer(runtime, brand) };
  const spec = runtime.sopSections;
  let target: SopSection[];
  try {
    target = tenantImage(runtime, o.targetImageSop ?? (typeof o.imageSop === 'string' ? o.imageSop : o.imageSop(pub.packId)), brand);
  } catch (e) {
    return fail(`目标镜像的 sop.md 不合格：${message(e)}`);
  }
  const merged = mergeWithImage(pub.sections, target, spec);
  const sopText = joinSop(merged);
  const rendered = code.render(sopText);
  const hashes = { ...promptHashes(rendered, code.toolsJson, sopText), policyHash: policy.policyHash };
  if (o.targetImageSop !== undefined) {
    // 工具名与字段名按本镜像的代码查；目标版本的代码由它自己的 CI 在提交时再验一遍
    const violations = checkSopContract({
      sections: merged,
      imageSections: target,
      rendered,
      toolNames: code.toolNames,
      knownFields: code.knownFields,
      baselineEditableChars: null,
      ...contractInputs(runtime, brand, policy.policy),
      hardRequirements: code.render(''),
    });
    if (violations.length)
      return fail(
        `contract_failed：导出结果与目标镜像合并后过不了契约检查：${violations.map((v) => `${v.code}${v.sectionKey ? `@${v.sectionKey}` : ''} ${v.detail}`).join('；')}`,
      );
  } else if (hashes.promptHash !== pub.promptHash) {
    return fail(`本地重新渲染的 promptHash 与库里 v${pub.versionNo} 存的不同：代码在发布之后变过，先以 DB 模式启动一次（重渲染）再导出`);
  }
  const payloads = (kind: CatalogKind): unknown[] => items.filter((r) => r.kind === kind).map((r) => r.payload);
  fs.mkdirSync(o.outDir, { recursive: true });
  fs.writeFileSync(path.join(o.outDir, 'sop.md'), sopText);
  fs.writeFileSync(path.join(o.outDir, 'routes.json'), `${JSON.stringify(payloads('route'), null, 2)}\n`);
  fs.writeFileSync(path.join(o.outDir, 'hotels.json'), `${JSON.stringify(payloads('hotel'), null, 2)}\n`);
  fs.writeFileSync(path.join(o.outDir, 'policy.json'), `${JSON.stringify(policy.policy, null, 2)}\n`);
  const brandFile = path.join(o.outDir, 'brand.json');
  if (brand) fs.writeFileSync(brandFile, `${JSON.stringify(brand, null, 2)}\n`);
  else fs.rmSync(brandFile, { force: true });
  return {
    code: EXIT.ok,
    hashes,
    versionNo: pub.versionNo ?? undefined,
    message: `已导出 SOP v${pub.versionNo}、${payloads('route').length} 条线路、${payloads('hotel').length} 家酒店到 ${o.outDir}`,
  };
}
