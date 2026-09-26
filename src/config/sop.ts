// SOP 的编辑流程（docs/architecture/01-pg-config-console/spec.md「版本与发布」）：草稿、检查、发布、回滚、丢弃。
// 每个写函数自己开一个 withTenant 事务，第一条语句取本租户的配置写锁，同一租户的配置写入因此串行。
// 事务提交之后才替换进程内缓存；提交失败时缓存不动；COMMIT 本身抛错、结果不明时从库里整体重读。
// 导入、后台发布、回滚、启动重渲染这四条写路径，存进 sections 的都是与镜像合并之后的全部节，
// 所以任何一行都满足 rendered_prompt === render(joinSop(sections))。
import { isUniqueViolation, lockTenantConfig, withTenant, type TenantCtx, type Tx } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import {
  archivePublished,
  discardDraft,
  insertDraft,
  insertPublishedSop,
  listReleased,
  maxVersionNo,
  publishDraft,
  readDraft,
  readDraftForUpdate,
  readImportVersion,
  readPublishedSop,
  readVersionById,
  updateDraftSections,
  type SopVersionRow,
} from '../db/repo/sop.js';
import { BUDGET_RATIO, checkSopContract, type ContractViolation } from '../sop/contract.js';
import {
  editableChars,
  joinSop,
  mergeWithImage,
  TRAVEL_SOP_SECTIONS,
  rebuildSection,
  type SectionSpec,
  type SopSection,
} from '../sop/sections.js';
import { promptHashes, renderInputsFor, type PromptHashes } from './hashes.js';
import { assertConfigWritable, configRuntime, reloadFromDb, replacePublishedSop, toPublishedSop } from './source.js';

export type SopStatus = 'draft' | 'published' | 'archived' | 'discarded';
export type SopSource = 'import' | 'console' | 'rollback' | 'rerender';

export interface SopVersion {
  id: string;
  /** draft 与 discarded 为 null */
  versionNo: number | null;
  status: SopStatus;
  source: SopSource;
  /** 与当时镜像合并之后的全部节 */
  sections: SopSection[];
  basedOn: string | null;
  rev: number;
  promptHash: string | null;
  toolsHash: string | null;
  prefixHash: string | null;
  sopHash: string | null;
  changeNote: string | null;
  createdByName: string | null;
  createdAt: string;
  publishedByName: string | null;
  publishedAt: string | null;
}

/** 草稿发布时 rebase 撞上了同一节：→ 409，带当前发布版本的可编辑节，界面据此提示 */
export class SopConflictError extends Error {
  constructor(
    readonly keys: string[],
    readonly current: SopSection[],
  ) {
    super(`这几节在你编辑期间被别人改过：${keys.join('、')}`);
  }
}
/** 草稿的 rev 对不上，或草稿、发布版本在你打开之后变了：→ 409，刷新后重来 */
export class SopRevConflictError extends Error {}
/** 保存草稿时点名了锁定节：→ 422 */
export class SopLockedSectionError extends Error {
  constructor(readonly key: string) {
    super(`「${key}」是锁定节，归代码所有，后台不能改`);
  }
}
/** 过不了契约检查：→ 422 */
export class SopContractError extends Error {
  constructor(readonly violations: ContractViolation[]) {
    super(`过不了契约检查：${violations.map((v) => v.code).join('、')}`);
  }
}
/** → 404 */
export class SopNotFoundError extends Error {}
/** 请求本身不合规（点名了不存在的节、变更说明为空）：→ 422 */
export class SopInputError extends Error {}

const EDITABLE: readonly SectionSpec[] = TRAVEL_SOP_SECTIONS.filter((s) => !s.locked);
const textOf = (sections: readonly SopSection[], key: string): string | undefined => sections.find((s) => s.key === key)?.text;
const editableOf = (sections: readonly SopSection[]): SopSection[] => sections.filter((s) => EDITABLE.some((e) => e.key === s.key));

function toVersion(r: SopVersionRow): SopVersion {
  return {
    id: r.id,
    versionNo: r.versionNo,
    status: r.status,
    source: r.source,
    sections: r.sections.map((s) => ({ key: s.key, text: s.text })),
    basedOn: r.basedOn,
    rev: r.rev,
    promptHash: r.promptHash,
    toolsHash: r.toolsHash,
    prefixHash: r.prefixHash,
    sopHash: r.sopHash,
    changeNote: r.changeNote,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    publishedByName: r.publishedByName,
    publishedAt: r.publishedAt?.toISOString() ?? null,
  };
}

/** 本进程只装载了一个租户（spec R9）：写别的租户是调用方的错 */
function runtimeFor(ctx: TenantCtx): ReturnType<typeof configRuntime> {
  const rt = configRuntime();
  if (ctx.tenantId !== rt.tenantId) throw new Error('这个租户不是本进程装载的租户');
  return rt;
}

/**
 * 三方 rebase，只比可编辑节：base 是草稿 based_on 的版本，cur 是当前发布版本，mine 是草稿。
 * 上游改过的节（base ≠ cur）与草稿改过的节（base ≠ mine）没有交集时，上游改过的取 cur；有交集就是冲突。
 * 锁定节不参与判定：发布时本来就取镜像
 */
function rebase(
  base: readonly SopSection[],
  cur: readonly SopSection[],
  mine: readonly SopSection[],
): { sections: SopSection[]; conflicts: string[] } {
  const upstream = EDITABLE.filter((s) => textOf(base, s.key) !== textOf(cur, s.key)).map((s) => s.key);
  const edited = EDITABLE.filter((s) => textOf(base, s.key) !== textOf(mine, s.key)).map((s) => s.key);
  const conflicts = upstream.filter((k) => edited.includes(k));
  const sections = mine.map((s) => (upstream.includes(s.key) ? { key: s.key, text: textOf(cur, s.key) ?? s.text } : s));
  return { sections, conflicts };
}

interface Evaluated {
  merged: SopSection[];
  rendered: string;
  hashes: PromptHashes;
  chars: number;
  limit: number;
  violations: ContractViolation[];
}

/** 与镜像合并、渲染、契约检查。预算基线是该租户导入版本的可编辑节总长 */
async function evaluate(tx: Tx, rt: ReturnType<typeof configRuntime>, sections: readonly SopSection[]): Promise<Evaluated> {
  const merged = mergeWithImage(sections, rt.imageSections);
  const sop = joinSop(merged);
  const rendered = rt.deps.render(sop);
  const imported = await readImportVersion(tx);
  const baseline = imported ? editableChars(imported.sections) : editableChars(merged);
  const violations = checkSopContract({
    sections: merged,
    imageSections: rt.imageSections,
    rendered,
    toolNames: rt.deps.toolNames,
    knownFields: rt.deps.knownFields,
    baselineEditableChars: baseline,
  });
  return {
    merged,
    rendered,
    hashes: promptHashes(rendered, rt.deps.toolsJson, sop),
    chars: editableChars(merged),
    limit: Math.floor(baseline * BUDGET_RATIO),
    violations,
  };
}

/**
 * 写事务的外壳：先确认持着租户锁，再开事务、取配置写锁。fn 跑完而 COMMIT 抛错时结果不明（可能已经提交），
 * 从库里整体重读，免得缓存与库不一致
 */
async function write<T>(ctx: TenantCtx, fn: (tx: Tx, rt: ReturnType<typeof configRuntime>) => Promise<T>): Promise<T> {
  assertConfigWritable();
  const rt = runtimeFor(ctx);
  let reachedCommit = false;
  try {
    return await withTenant(rt.db, ctx, async (tx) => {
      await lockTenantConfig(tx);
      const out = await fn(tx, rt);
      reachedCommit = true;
      return out;
    });
  } catch (e) {
    if (reachedCommit) void reloadFromDb().catch(() => {});
    throw e;
  }
}

const requireNote = (note: string): string => {
  const n = note.trim();
  if (!n) throw new SopInputError('变更说明不能为空');
  return n;
};

// ---------------- 读 ----------------

export async function getSopOverview(ctx: TenantCtx): Promise<{
  published: SopVersion;
  /** stale：basedOn 已不是当前发布版本 */
  draft: (SopVersion & { stale: boolean }) | null;
  spec: readonly SectionSpec[];
  budget: { chars: number; limit: number };
}> {
  const rt = runtimeFor(ctx);
  return withTenant(
    rt.db,
    ctx,
    async (tx) => {
      const pub = await readPublishedSop(tx);
      if (!pub) throw new SopNotFoundError('没有已发布的 SOP');
      const draft = await readDraft(tx);
      const imported = await readImportVersion(tx);
      const current = draft ?? pub;
      const baseline = imported ? editableChars(imported.sections) : editableChars(pub.sections);
      return {
        published: toVersion(pub),
        draft: draft ? { ...toVersion(draft), stale: draft.basedOn !== pub.id } : null,
        spec: TRAVEL_SOP_SECTIONS,
        budget: { chars: editableChars(mergeWithImage(current.sections, rt.imageSections)), limit: Math.floor(baseline * BUDGET_RATIO) },
      };
    },
    { readOnly: true },
  );
}

/** 只列 published 与 archived，按 versionNo 倒序；limit ≤ 100 */
export async function listSopVersions(ctx: TenantCtx, q: { limit: number; beforeVersionNo?: number }): Promise<SopVersion[]> {
  const rt = runtimeFor(ctx);
  const limit = Math.max(1, Math.min(100, Math.floor(q.limit)));
  return withTenant(rt.db, ctx, async (tx) => (await listReleased(tx, limit, q.beforeVersionNo)).map(toVersion), { readOnly: true });
}

// ---------------- 草稿 ----------------

/** 没有草稿时，以 basedOn 新建一份（basedOn 必须是当前已发布版本，rev 传 null）；已有草稿时 rev 必须相等。edits 只能点名可编辑节 */
export async function saveSopDraft(
  ctx: TenantCtx,
  input: { basedOn: string; rev: number | null; edits: readonly { key: string; body: string }[] },
): Promise<SopVersion> {
  const keys = input.edits.map((e) => e.key);
  for (const key of keys) {
    const spec = TRAVEL_SOP_SECTIONS.find((s) => s.key === key);
    if (!spec) throw new SopInputError(`没有「${key}」这一节`);
    if (spec.locked) throw new SopLockedSectionError(key);
  }
  if (new Set(keys).size !== keys.length) throw new SopInputError('同一节在一次保存里出现了两次');
  // 正文按规范形重建；编码不合格在这里抛（SopEncodingError → 422）。空正文、行首「## 」照存，检查时报 structure、发布时拒绝
  const apply = (sections: readonly SopSection[]): SopSection[] =>
    sections.map((s) => {
      const e = input.edits.find((x) => x.key === s.key);
      const i = TRAVEL_SOP_SECTIONS.findIndex((x) => x.key === s.key);
      return e ? rebuildSection(TRAVEL_SOP_SECTIONS[i]!, e.body, i === TRAVEL_SOP_SECTIONS.length - 1) : s;
    });
  try {
    return await write(ctx, async (tx, rt) => {
      const draft = await readDraftForUpdate(tx);
      if (!draft) {
        if (input.rev !== null) throw new SopRevConflictError('草稿已经不在了（被发布或丢弃），刷新后重来');
        const pub = await readPublishedSop(tx);
        if (!pub || pub.id !== input.basedOn) throw new SopRevConflictError('发布版本在你打开之后变了，刷新后重来');
        const row = await insertDraft(tx, {
          tenantId: rt.tenantId,
          packId: pub.packId,
          sections: apply(mergeWithImage(pub.sections, rt.imageSections)),
          basedOn: pub.id,
          createdBy: ctx.actor.userId,
          createdByName: ctx.actor.name,
        });
        return toVersion(row);
      }
      if (input.rev === null || draft.rev !== input.rev) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
      const row = await updateDraftSections(tx, draft.id, draft.rev, apply(draft.sections));
      if (!row) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
      return toVersion(row);
    });
  } catch (e) {
    // 两个并发的首次保存：配置写锁让它们排队，后一个看到草稿已在、rev 对不上；万一还是撞上唯一索引，同样是 409
    if (isUniqueViolation(e)) throw new SopRevConflictError('已经有人建了草稿，刷新后重来');
    throw e;
  }
}

/** 不写库。返回按当前镜像合并、必要时 rebase 之后的结果 */
export async function checkSopDraft(ctx: TenantCtx): Promise<{
  promptHash: string;
  prefixHash: string;
  chars: number;
  limit: number;
  violations: ContractViolation[];
  rebase: { needed: boolean; conflicts: string[] };
}> {
  const rt = runtimeFor(ctx);
  return withTenant(
    rt.db,
    ctx,
    async (tx) => {
      const draft = await readDraft(tx);
      if (!draft) throw new SopNotFoundError('没有草稿');
      const pub = await readPublishedSop(tx);
      if (!pub) throw new SopNotFoundError('没有已发布的 SOP');
      let sections: readonly SopSection[] = draft.sections;
      let conflicts: string[] = [];
      const needed = draft.basedOn !== pub.id;
      if (needed) {
        const base = draft.basedOn ? await readVersionById(tx, draft.basedOn) : null;
        const r = rebase(base?.sections ?? pub.sections, pub.sections, draft.sections);
        conflicts = r.conflicts;
        if (!conflicts.length) sections = r.sections;
      }
      const ev = await evaluate(tx, rt, sections);
      return {
        promptHash: ev.hashes.promptHash,
        prefixHash: ev.hashes.prefixHash,
        chars: ev.chars,
        limit: ev.limit,
        violations: ev.violations,
        rebase: { needed, conflicts },
      };
    },
    { readOnly: true },
  );
}

/**
 * 发布：核对 rev → 必要时三方 rebase → 与镜像合并、渲染、契约检查 → 归档当前版本、草稿翻成 published
 * （写回合并后的节，发布时才分配版本号）→ 审计。全部在一个事务里；提交之后才替换缓存
 */
export async function publishSopDraft(ctx: TenantCtx, input: { rev: number; changeNote: string }): Promise<SopVersion> {
  const note = requireNote(input.changeNote);
  const row = await write(ctx, async (tx, rt) => {
    const draft = await readDraftForUpdate(tx);
    if (!draft) throw new SopNotFoundError('没有草稿');
    if (draft.rev !== input.rev) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
    const pub = await readPublishedSop(tx);
    if (!pub) throw new SopNotFoundError('没有已发布的 SOP');
    let mine: readonly SopSection[] = draft.sections;
    let rebasedFrom: number | null = null;
    if (draft.basedOn !== pub.id) {
      const base = draft.basedOn ? await readVersionById(tx, draft.basedOn) : null;
      const r = rebase(base?.sections ?? pub.sections, pub.sections, draft.sections);
      if (r.conflicts.length) throw new SopConflictError(r.conflicts, editableOf(mergeWithImage(pub.sections, rt.imageSections)));
      mine = r.sections;
      rebasedFrom = base?.versionNo ?? null;
    }
    const ev = await evaluate(tx, rt, mine);
    if (ev.violations.length) throw new SopContractError(ev.violations);
    const changedKeys = EDITABLE.filter((s) => textOf(pub.sections, s.key) !== textOf(ev.merged, s.key)).map((s) => s.key);
    const versionNo = (await maxVersionNo(tx)) + 1;
    await archivePublished(tx, pub.id);
    const published = await publishDraft(tx, draft.id, draft.rev, {
      versionNo,
      sections: ev.merged,
      basedOn: pub.id,
      renderedPrompt: ev.rendered,
      ...ev.hashes,
      renderInputs: renderInputsFor(rt.deps.render, rt.deps.imageSop, rt.deps.toolsJson),
      changeNote: note,
      publishedBy: ctx.actor.userId,
      publishedByName: ctx.actor.name,
    });
    if (!published) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
    await writeAudit(tx, {
      action: 'sop.publish',
      targetType: 'sop_version',
      targetId: published.id,
      diff: { versionNo, changedKeys, ...(rebasedFrom === null ? {} : { rebasedFrom }) },
    });
    return published;
  });
  replacePublishedSop(toPublishedSop(ctx.tenantId, row, row.sections));
  return toVersion(row);
}

export async function discardSopDraft(ctx: TenantCtx, input: { rev: number }): Promise<void> {
  await write(ctx, async (tx) => {
    const draft = await readDraftForUpdate(tx);
    if (!draft) throw new SopNotFoundError('没有草稿');
    if (draft.rev !== input.rev || !(await discardDraft(tx, draft.id, draft.rev)))
      throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
    await writeAudit(tx, { action: 'sop.discard', targetType: 'sop_version', targetId: draft.id });
  });
}

/**
 * 回滚：取 versionId（必须是 published 或 archived）的可编辑节，锁定节取镜像，新建并发布一个 source='rollback' 的版本，
 * 同样要过契约检查。不碰已有的草稿：它的 based_on 从此过期，再发布时按三方 rebase 处理。
 * 目标版本之后硬性要求、锁定节和工具定义都没变时，新版本的 prompt_hash 等于目标版本的（sameHashAsTarget）
 */
export async function rollbackSop(
  ctx: TenantCtx,
  input: { versionId: string; changeNote: string },
): Promise<SopVersion & { sameHashAsTarget: boolean }> {
  const note = requireNote(input.changeNote);
  const { row, same } = await write(ctx, async (tx, rt) => {
    const target = await readVersionById(tx, input.versionId);
    if (!target || (target.status !== 'published' && target.status !== 'archived'))
      throw new SopNotFoundError('只能回滚到已发布或已归档的版本');
    const pub = await readPublishedSop(tx);
    if (!pub) throw new SopNotFoundError('没有已发布的 SOP');
    const ev = await evaluate(tx, rt, target.sections);
    if (ev.violations.length) throw new SopContractError(ev.violations);
    const versionNo = (await maxVersionNo(tx)) + 1;
    await archivePublished(tx, pub.id);
    const v = await insertPublishedSop(tx, {
      tenantId: rt.tenantId,
      versionNo,
      source: 'rollback',
      packId: pub.packId,
      sections: ev.merged,
      basedOn: target.id,
      renderedPrompt: ev.rendered,
      ...ev.hashes,
      renderInputs: renderInputsFor(rt.deps.render, rt.deps.imageSop, rt.deps.toolsJson),
      changeNote: note,
      createdBy: ctx.actor.userId,
      createdByName: ctx.actor.name,
    });
    const sameHashAsTarget = v.promptHash === target.promptHash;
    await writeAudit(tx, {
      action: 'sop.rollback',
      targetType: 'sop_version',
      targetId: v.id,
      diff: { fromVersionNo: pub.versionNo, toVersionNo: versionNo, targetVersionNo: target.versionNo, sameHashAsTarget },
    });
    return { row: v, same: sameHashAsTarget };
  });
  replacePublishedSop(toPublishedSop(ctx.tenantId, row, row.sections));
  return { ...toVersion(row), sameHashAsTarget: same };
}
