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
import type { CatalogKindSpec, PackRuntime } from '../core/pack-api.js';
import { HotelSchema, RouteSchema } from '../shared/catalog.js';
import { checkSopContract } from '../sop/contract.js';
import { decodeSopFile, editableChars, joinSop, mergeWithImage, splitSop, type SopSection } from '../sop/sections.js';
import { runtimeById } from '../packs/registry.js';
import { assertKind } from './catalog.js';
import { PACK_FILE, readPackFile } from './pack-file.js';
import { assertBrandForPack, ConfigStartupError, packSources } from './source.js';
import { contractInputs, imageSopFile, tenantImage, tenantRenderer, switchPreamble } from './brand.js';
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

/**
 * 08 R11：非旅游包的条目文件 catalog/<kind>.json，每条过包的 schema、id 不重复；拒绝原因的写法同文件模式装载（source.ts 的 readCatalogFile）。
 * 缺文件也拒绝：导入要的是一份完整的配置，不像文件模式把缺的 kind 当空数组。返回原对象（写库的是原对象，不是 zod 的输出）
 */
function readPackItems(dir: string, kind: string, spec: CatalogKindSpec): Record<string, unknown>[] {
  const name = `catalog/${kind}.json`;
  // kind 拼进文件名：包声明里的 kind 也不许带路径
  if (!/^[A-Za-z0-9_-]+$/.test(kind)) throw new Error(`kind「${kind}」不能当文件名用`);
  let raw: unknown;
  try {
    // 严格解码：非法字节不能被替换成 U+FFFD 后照样通过校验
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(dir, 'catalog', `${kind}.json`))));
  } catch (e) {
    throw new Error(`${name} 读不出来：${message(e)}`, { cause: e });
  }
  if (!Array.isArray(raw)) throw new Error(`${name} 必须是数组`);
  const seen = new Set<string>();
  raw.forEach((item: unknown, i) => {
    const parsed = spec.schema.safeParse(item);
    if (!parsed.success) {
      const why = parsed.error.issues.map((x) => `${x.path.join('.') || '(根)'}：${x.message}`).join('；');
      throw new Error(`${name} 第 ${i + 1} 条不合格：${why}`);
    }
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== 'string' || !id) throw new Error(`${name} 第 ${i + 1} 条没有字符串 id`);
    if (seen.has(id)) throw new Error(`${name} 里 id「${id}」重复`);
    seen.add(id);
  });
  return raw as Record<string, unknown>[];
}

/**
 * 08 R11：非旅游包的导出目录里除 sop.md、policy.json、brand.json 之外的文件：pack.json（{ "id": "<包>" }）与包声明的每个 kind 的
 * catalog/<kind>.json（缺的 kind 写 []）。返回相对路径与文本，闸的导出与 export-config 各自用自己的方式写盘。旅游不走这里（routes.json / hotels.json）
 */
export function packCatalogFiles(
  packId: string,
  kinds: readonly string[],
  itemsOf: (kind: string) => readonly unknown[],
): { file: string; text: string }[] {
  const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  return [
    { file: PACK_FILE, text: text({ id: packId }) },
    ...kinds.map((kind) => {
      if (!/^[A-Za-z0-9_-]+$/.test(kind)) throw new Error(`kind「${kind}」不能当文件名用`);
      return { file: `catalog/${kind}.json`, text: text(itemsOf(kind)) };
    }),
  ];
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
  // 非旅游包的模板没有品牌快照就不复制：在开通事务提交之前失败，与启动同一个原因 brand_required（owner 2026-10-24 定，plan Open 1）
  assertBrandForPack(runtime, brand, '沙箱模板');
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

/**
 * import-config 没传 --data 时的配置目录（08 R11，清单 7.23）：旅游照旧是 ./data，其他包是它的参考配置 ./data/packs/<包>/。
 * 与镜像 SOP 同一个位置（imageSopFile），包 id 必须已经过注册表校验。
 */
export const defaultDataDir = (packId: string, root?: string): string => path.dirname(imageSopFile(packId, root));

export interface ImportOptions {
  db: Db;
  tenantSlug: string;
  /**
   * --data：配置目录。旅游是 sop.md、routes.json、hotels.json；其他包是 sop.md、pack.json 与 catalog/<kind>.json（08 R11），目录的包要与租户绑定的包一致。
   * 给函数时在解析出租户的包之后才取（命令行没传 --data 时用 defaultDataDir），同 imageSop
   */
  dataDir: string | ((packId: string) => string);
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
  let dataDir: string;
  try {
    dataDir = typeof o.dataDir === 'string' ? o.dataDir : o.dataDir(tenant.packId);
  } catch (e) {
    return fail(`文件不合格：读不到行业包「${tenant.packId}」的配置目录：${message(e)}`);
  }
  // 08 R11：--data 目录属于哪个包（pack.json 的 id，没有就是旅游）要与租户绑定的包一致；旅游读 routes.json / hotels.json，
  // 其他包读 pack.json 声明的各 kind 的 catalog/<kind>.json。在读取条目、加锁和任何写入之前校验。
  const travel = runtime.id === 'travel';
  const kinds: readonly string[] = travel ? ['route', 'hotel'] : Object.keys(runtime.catalog);
  let dirPackFile: ReturnType<typeof readPackFile>;
  try {
    dirPackFile = readPackFile(dataDir);
  } catch (e) {
    return fail(`文件不合格：${message(e)}`);
  }
  const dirPack = dirPackFile?.id ?? 'travel';
  if (dirPack !== runtime.id)
    return fail(
      `文件不合格：--data 目录属于行业包「${dirPack}」（${dirPackFile ? `${PACK_FILE} 写的` : `没有 ${PACK_FILE}，按旅游算`}），租户「${o.tenantSlug}」绑定的是行业包「${runtime.id}」，两边的包不符`,
    );
  try {
    if (travel) for (const kind of kinds) assertKind(tenant.packId, kind);
  } catch (e) {
    return fail(message(e));
  }
  const brand = (await readBrand(o.db, tenant.id)) ?? null;
  // owner 2026-10-24 定（plan Open 1）：非旅游包只支持模板模式（08 R10），没有品牌的租户启动会被 brand_required 拒绝，所以不导入
  try {
    assertBrandForPack(runtime, brand, `租户「${o.tenantSlug}」`);
  } catch (e) {
    if (e instanceof ConfigStartupError) return fail(e.message);
    throw e;
  }
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
    let items: Record<string, Record<string, unknown>[]>;
    let imageSections: SopSection[];
    let policy: ReturnType<typeof policySnapshot>;
    try {
      const file = path.join(dataDir, 'policy.json');
      const raw = fs.existsSync(file)
        ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)))
        : runtime.policy?.defaults;
      policy = policySnapshot(runtime.policy, raw);
    } catch {
      return fail('policy_invalid：policy.json 不合格');
    }
    try {
      imageSections = tenantImage(runtime, imageSop, brand);
      sections = splitSop(decodeSopFile(fs.readFileSync(path.join(dataDir, 'sop.md'))), spec);
      items = travel
        ? { route: readItems(dataDir, 'routes.json', 'route'), hotel: readItems(dataDir, 'hotels.json', 'hotel') }
        : Object.fromEntries(kinds.map((kind) => [kind, readPackItems(dataDir, kind, runtime.catalog[kind]!)]));
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
    // 给人看的条数：旅游的文字不变；其他包按 kind 列出
    const counts = travel
      ? `${items.route!.length} 条线路、${items.hotel!.length} 家酒店`
      : kinds.map((kind) => `${kind} ${items[kind]!.length} 条`).join('、');

    return await withTenant(o.db, platformCtx(tenant.id, 'import-config'), async (tx) => {
      await lockTenantConfig(tx);
      if ((await countSopVersions(tx)) === 0 && (await countCatalogItems(tx)) === 0) {
        if (o.dryRun) return { code: EXIT.ok, hashes, message: `dry-run：会写入 SOP v1、${counts}` };
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
        for (const kind of kinds) await insertActiveItems(tx, tenant.id, kind, items[kind]!, by);
        // 导入直接是 active，等于上架：每条写版本 1（02「报价快照」），之后启动时就没有要补写的
        for (const kind of kinds) {
          for (const payload of items[kind]!) {
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
        await writeAudit(tx, {
          action: 'config.import',
          diff: travel
            ? { sections: merged.length, routes: items.route!.length, hotels: items.hotel!.length }
            : { sections: merged.length, items: Object.fromEntries(kinds.map((kind) => [kind, items[kind]!.length])) },
        });
        return { code: EXIT.ok, hashes, versionNo: 1, message: `已导入 SOP v1、${counts}` };
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
      const inFile = kinds.flatMap((kind) => items[kind]!.map((item, i) => itemKey(kind, String(item.id), i, item))).toSorted();
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
 * 旅游写 routes.json、hotels.json；其他包写 pack.json 与包声明的每个 kind 的 catalog/<kind>.json（08 R11）。
 * 输出目录可以复用：写之前先删旧的 routes.json、hotels.json、pack.json 与 catalog/（只这四样），再按本包写，所以换了包不会留下上一个包的产品文件。
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
  const travel = runtime.id === 'travel';
  const kinds = Object.keys(runtime.catalog);
  fs.mkdirSync(o.outDir, { recursive: true });
  for (const stale of ['routes.json', 'hotels.json', PACK_FILE]) fs.rmSync(path.join(o.outDir, stale), { force: true });
  fs.rmSync(path.join(o.outDir, 'catalog'), { recursive: true, force: true });
  fs.writeFileSync(path.join(o.outDir, 'sop.md'), sopText);
  if (travel) {
    fs.writeFileSync(path.join(o.outDir, 'routes.json'), `${JSON.stringify(payloads('route'), null, 2)}\n`);
    fs.writeFileSync(path.join(o.outDir, 'hotels.json'), `${JSON.stringify(payloads('hotel'), null, 2)}\n`);
  } else {
    fs.mkdirSync(path.join(o.outDir, 'catalog'));
    for (const { file, text } of packCatalogFiles(runtime.id, kinds, payloads)) fs.writeFileSync(path.join(o.outDir, file), text);
  }
  fs.writeFileSync(path.join(o.outDir, 'policy.json'), `${JSON.stringify(policy.policy, null, 2)}\n`);
  const brandFile = path.join(o.outDir, 'brand.json');
  if (brand) fs.writeFileSync(brandFile, `${JSON.stringify(brand, null, 2)}\n`);
  else fs.rmSync(brandFile, { force: true });
  return {
    code: EXIT.ok,
    hashes,
    versionNo: pub.versionNo ?? undefined,
    message: `已导出 SOP v${pub.versionNo}、${
      travel
        ? `${payloads('route').length} 条线路、${payloads('hotel').length} 家酒店`
        : kinds.map((kind) => `${kind} ${payloads(kind).length} 条`).join('、')
    }到 ${o.outDir}`,
  };
}
