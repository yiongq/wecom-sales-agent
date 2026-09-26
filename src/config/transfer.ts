// 导入与导出（docs/architecture/01-pg-config-console/spec.md「导入、导出与回滚」）。命令行是薄包装，逻辑在这里，自测直接调用。
// 退出码：0 成功或已一致；2 库里已有不一致的内容；3 拿不到租户锁；1 其他错误。
import fs from 'node:fs';
import path from 'node:path';
import { lockTenantConfig, withTenant, type Db, type TenantCtx, type TenantLock } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import { countCatalogItems, insertActiveItems, readActiveCatalog, type CatalogKind } from '../db/repo/catalog.js';
import { countSopVersions, insertPublishedSop, readPublishedSop } from '../db/repo/sop.js';
import { findTenantBySlug } from '../db/repo/tenants.js';
import { renderSystemPrompt } from '../prompt/system.js';
import { HotelSchema, RouteSchema } from '../shared/catalog.js';
import { checkSopContract, SOP_KNOWN_FIELDS } from '../sop/contract.js';
import { decodeSopFile, editableChars, joinSop, mergeWithImage, splitSop, TRAVEL_SOP_SECTIONS, type SopSection } from '../sop/sections.js';
import { toolDefs } from '../tool-defs.js';
import { promptHashes, renderInputsFor, type PromptHashes } from './hashes.js';

export const EXIT = { ok: 0, error: 1, inconsistent: 2, locked: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface TransferResult {
  code: ExitCode;
  /** 给人看的一句话，命令行原样打印 */
  message: string;
  hashes?: PromptHashes;
  versionNo?: number;
}

/** 渲染与契约检查用到的代码侧输入，默认取本镜像的 */
export interface CodeInputs {
  toolsJson: string;
  toolNames: readonly string[];
  knownFields: readonly string[];
  render(sop: string): string;
}
export const imageCode = (): CodeInputs => ({
  toolsJson: JSON.stringify(toolDefs),
  toolNames: toolDefs.map((t) => t.function.name),
  knownFields: SOP_KNOWN_FIELDS,
  render: renderSystemPrompt,
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

export interface ImportOptions {
  db: Db;
  tenantSlug: string;
  /** --data：sop.md、routes.json、hotels.json 所在目录 */
  dataDir: string;
  /** 镜像里 data/sop.md 的全文：锁定节以它为准 */
  imageSop: string;
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
  const code = o.code ?? imageCode();
  const tenant = await findTenantBySlug(o.db, o.tenantSlug);
  if (!tenant) return fail(`tenant_not_found：没有 slug 为「${o.tenantSlug}」的租户，先跑 tenant-create`);
  // DB 模式的应用在跑时持着锁：拿不到就别动库
  const lock = await o.lock(tenant.id);
  if (!lock) return { code: EXIT.locked, message: `lock_held：租户「${o.tenantSlug}」的锁在别的进程手里（应用正以 DB 模式运行？）` };
  try {
    let sections: SopSection[];
    let routes: Record<string, unknown>[];
    let hotels: Record<string, unknown>[];
    let imageSections: SopSection[];
    try {
      imageSections = splitSop(o.imageSop);
      sections = splitSop(decodeSopFile(fs.readFileSync(path.join(o.dataDir, 'sop.md'))));
      routes = readItems(o.dataDir, 'routes.json', 'route');
      hotels = readItems(o.dataDir, 'hotels.json', 'hotel');
    } catch (e) {
      return fail(`文件不合格：${message(e)}`);
    }
    const changed = TRAVEL_SOP_SECTIONS.filter(
      (s) => s.locked && sections.find((x) => x.key === s.key)?.text !== imageSections.find((x) => x.key === s.key)?.text,
    );
    if (changed.length) return fail(`locked_changed：sop.md 的锁定节与镜像不一致：${changed.map((s) => s.heading).join('、')}`);
    const merged = mergeWithImage(sections, imageSections);
    const sopText = joinSop(merged);
    const rendered = code.render(sopText);
    // 预算基线就是它自己：导入不会 over_budget
    const violations = checkSopContract({
      sections: merged,
      imageSections,
      rendered,
      toolNames: code.toolNames,
      knownFields: code.knownFields,
      baselineEditableChars: editableChars(merged),
    });
    if (violations.length)
      return fail(`contract_failed：${violations.map((v) => `${v.code}${v.sectionKey ? `@${v.sectionKey}` : ''} ${v.detail}`).join('；')}`);
    const hashes = promptHashes(rendered, code.toolsJson, sopText);

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
          renderInputs: renderInputsFor(code.render, o.imageSop, code.toolsJson),
          changeNote: '首次导入',
          createdBy: null,
          createdByName: 'import-config',
        });
        const by = { userId: null, name: 'import-config' };
        await insertActiveItems(tx, tenant.id, 'route', routes, by);
        await insertActiveItems(tx, tenant.id, 'hotel', hotels, by);
        await writeAudit(tx, { action: 'config.import', diff: { sections: merged.length, routes: routes.length, hotels: hotels.length } });
        return { code: EXIT.ok, hashes, versionNo: 1, message: `已导入 SOP v1、${routes.length} 条线路、${hotels.length} 家酒店` };
      }
      // 已有内容：一致 = 当前已发布版本的可编辑节等于文件切出的可编辑节，且每条 active 条目与文件完全一致。
      // rerender 版本（只动锁定节）和 draft 条目不影响判定
      const pub = await readPublishedSop(tx);
      const editable = TRAVEL_SOP_SECTIONS.filter((s) => !s.locked);
      const pubMerged = pub ? mergeWithImage(pub.sections, imageSections) : [];
      const sopSame =
        !!pub && editable.every((s) => pubMerged.find((x) => x.key === s.key)?.text === merged.find((x) => x.key === s.key)?.text);
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
  /** 镜像里 data/sop.md 的全文 */
  imageSop: string;
  /** --image-sop：回到旧版本时，用目标版本的 data/sop.md 合并锁定节 */
  targetImageSop?: string;
  code?: CodeInputs;
}

/**
 * 在一个 REPEATABLE READ READ ONLY 事务里一次读出已发布版本和全部 active 条目，写成 sop.md、routes.json、hotels.json。
 * 只读库，应用可以照常在跑
 */
export async function exportConfig(o: ExportOptions): Promise<TransferResult> {
  const code = o.code ?? imageCode();
  const tenant = await findTenantBySlug(o.db, o.tenantSlug);
  if (!tenant) return fail(`tenant_not_found：没有 slug 为「${o.tenantSlug}」的租户`);
  const { pub, items } = await withTenant(
    o.db,
    platformCtx(tenant.id, 'export-config'),
    async (tx) => ({ pub: await readPublishedSop(tx), items: await readActiveCatalog(tx) }),
    { isolation: 'repeatable read', readOnly: true },
  );
  if (!pub) return fail(`no_published_sop：租户「${o.tenantSlug}」没有已发布的 SOP`);
  let target: SopSection[];
  try {
    target = splitSop(o.targetImageSop ?? o.imageSop);
  } catch (e) {
    return fail(`目标镜像的 sop.md 不合格：${message(e)}`);
  }
  const merged = mergeWithImage(pub.sections, target);
  const sopText = joinSop(merged);
  const rendered = code.render(sopText);
  const hashes = promptHashes(rendered, code.toolsJson, sopText);
  if (o.targetImageSop !== undefined) {
    // 工具名与字段名按本镜像的代码查；目标版本的代码由它自己的 CI 在提交时再验一遍
    const violations = checkSopContract({
      sections: merged,
      imageSections: target,
      rendered,
      toolNames: code.toolNames,
      knownFields: code.knownFields,
      baselineEditableChars: null,
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
  return {
    code: EXIT.ok,
    hashes,
    versionNo: pub.versionNo ?? undefined,
    message: `已导出 SOP v${pub.versionNo}、${payloads('route').length} 条线路、${payloads('hotel').length} 家酒店到 ${o.outDir}`,
  };
}
