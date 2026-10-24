// SOP 的编辑流程（docs/architecture/01-pg-config-console/spec.md「版本与发布」）：草稿、检查、发布、回滚、丢弃。
// 每个写函数自己开一个 withTenant 事务，第一条语句取本租户的配置写锁，同一租户的配置写入因此串行。
// 事务提交之后才替换进程内缓存；提交失败时缓存不动；COMMIT 本身抛错、结果不明时从库里整体重读。
// 导入、后台发布、回滚、启动重渲染这四条写路径，存进 sections 的都是与镜像合并之后的全部节，
// 所以任何一行都满足 rendered_prompt === render(joinSop(sections))。
import { isUniqueViolation, lockTenantConfig, withTenant, type Db, type TenantCtx, type Tx } from '../db/client.js';
import { writeAudit } from '../db/repo/audit.js';
import {
  archivePublished,
  discardDraft,
  insertDraft,
  insertPublishedSop,
  listReleased,
  maxVersionNo,
  nextDraftRev,
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
import { editableChars, joinSop, mergeWithImage, rebuildSection, type SectionSpec, type SopSection } from '../sop/sections.js';
import type { PackPolicy } from '../core/pack-api.js';
import type { PolicyView, SopVersion } from '../shared/console-api.js';
import { promptHashes, publishedBrand, policySnapshot, publishedPolicy, renderInputsFor, type PromptHashes } from './hashes.js';
import {
  assertBrandForPack,
  assertConfigWritable,
  configRuntime,
  currentSop,
  reloadFromDb,
  replacePublishedSop,
  runtimeOf,
  toPublishedSop,
} from './source.js';

import { currentCatalog } from './source.js';
import { currentRuntime } from '../tenancy/runtime.js';
import { gatesForDraft } from '../db/repo/gate.js';
import { GateError } from './gate-errors.js';
import { contractInputs, preambleWarning, tenantImage } from './brand.js';

export type { SopSource, SopStatus, SopVersion } from '../shared/console-api.js';

/** 草稿发布时 rebase 撞上了同一节（或合并保存时缺了撞上的节）：→ 409，带当前发布版本的可编辑节，界面据此提示 */
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

// 版本 id 是 uuid 列：格式不对的直接当不存在，不让库报类型错误变成 500
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 08 R10：节表取绑定包的 sopSections，不再有旅游缺省 */
const specOf = (rt: ReturnType<typeof configRuntime>): readonly SectionSpec[] => runtimeOf(rt.deps).sopSections;
const editableSpec = (spec: readonly SectionSpec[]): readonly SectionSpec[] => spec.filter((s) => !s.locked);
const textOf = (sections: readonly SopSection[], key: string): string | undefined => sections.find((s) => s.key === key)?.text;
const editableOf = (spec: readonly SectionSpec[], sections: readonly SopSection[]): SopSection[] => {
  const editable = editableSpec(spec);
  return sections.filter((s) => editable.some((e) => e.key === s.key));
};

/** 旧草稿只补新增字段；不合格快照也走契约错误，不能变成未分类的 schema 异常。 */
function draftPolicy(pack: PackPolicy | undefined, raw: unknown): ReturnType<typeof policySnapshot> {
  try {
    return policySnapshot(pack, pack?.upgrade(raw ?? undefined));
  } catch {
    throw new SopContractError([{ code: 'policy_invalid', sectionKey: null, detail: '退改条款不符合政策 schema' }]);
  }
}

function policyView(raw: unknown, pack: PackPolicy | undefined): PolicyView | null {
  if (!pack) return null;
  const policy = pack.upgrade(raw);
  const refund = pack.refund(policy);
  return {
    clauses: pack.clauses(policy).filter((c) => c.topic === 'refund' || c.topic === 'change'),
    approvalThresholdYuan: refund?.approvalThresholdYuan ?? null,
    selfService: refund?.selfService ?? null,
  };
}

function toVersion(r: SopVersionRow, pack = configRuntime().deps.runtime?.policy): SopVersion {
  return {
    id: r.id,
    versionNo: r.versionNo,
    status: r.status,
    source: r.source,
    sections: r.sections.map((s) => ({ key: s.key, text: s.text })),
    basedOn: r.basedOn,
    rev: r.rev,
    policyHash: r.renderInputs?.policyHash ?? null,
    policy: policyView(r.policy ?? undefined, pack),
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
  spec: readonly SectionSpec[],
  base: readonly SopSection[],
  cur: readonly SopSection[],
  mine: readonly SopSection[],
): { sections: SopSection[]; conflicts: string[] } {
  const editable = editableSpec(spec);
  const upstream = editable.filter((s) => textOf(base, s.key) !== textOf(cur, s.key)).map((s) => s.key);
  const edited = editable.filter((s) => textOf(base, s.key) !== textOf(mine, s.key)).map((s) => s.key);
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

/** 原有 120% 预算不变；系统托管前言的渲染差额单独加减，不乘预算倍数、不累加。 */
function budgetFor(
  rt: ReturnType<typeof configRuntime>,
  sections: readonly SopSection[],
  imported: SopVersionRow | null,
  fallback: readonly SopSection[],
): { baseline: number; adjustment: number; limit: number } {
  const baseline = editableChars(imported?.sections ?? fallback, specOf(rt));
  let adjustment = 0;
  if (imported && rt.deps.runtime && !preambleWarning(sections, rt.imageSections)) {
    const originalImage = tenantImage(rt.deps.runtime, rt.legacyImageSop, publishedBrand(imported.renderInputs).brand);
    const preamble = rt.deps.runtime.sopSections.filter((s) => s.key === 'preamble' && !s.locked);
    adjustment = editableChars(rt.imageSections, preamble) - editableChars(originalImage, preamble);
  }
  return { baseline, adjustment, limit: Math.floor(baseline * BUDGET_RATIO) + adjustment };
}

/** 与镜像合并、渲染、契约检查；与概览使用同一份预算计算。 */
async function evaluate(
  tx: Tx,
  rt: ReturnType<typeof configRuntime>,
  sections: readonly SopSection[],
  policy: unknown,
): Promise<Evaluated> {
  const spec = specOf(rt);
  // 检查、发布、回滚都经这里，早于任何写入：非旅游包没有品牌快照时不写出旧版渲染的 SOP（装载时已拒绝，这里兜底；待 owner 确认，plan Open 1）
  assertBrandForPack(runtimeOf(rt.deps), currentSop().brand, `租户「${rt.deps.tenantSlug}」`);
  const merged = mergeWithImage(sections, rt.imageSections, spec);
  const sop = joinSop(merged);
  const rendered = rt.deps.render(sop);
  const imported = await readImportVersion(tx);
  const budget = budgetFor(rt, merged, imported, merged);
  const violations = checkSopContract({
    sections: merged,
    imageSections: rt.imageSections,
    rendered,
    toolNames: rt.deps.toolNames,
    knownFields: rt.deps.knownFields,
    baselineEditableChars: budget.baseline,
    systemEditableAdjustment: budget.adjustment,
    ...contractInputs(runtimeOf(rt.deps), currentSop().brand, policy),
    hardRequirements: rt.deps.render(''),
  });
  return {
    merged,
    rendered,
    hashes: promptHashes(rendered, rt.deps.toolsJson, sop),
    chars: editableChars(merged, spec),
    limit: budget.limit,
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
  preambleWarning?: boolean;
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
      const spec = specOf(rt);
      const merged = mergeWithImage(current.sections, rt.imageSections, spec);
      const budget = budgetFor(rt, merged, imported, pub.sections);
      return {
        ...(preambleWarning(current.sections, rt.imageSections) ? { preambleWarning: true } : {}),
        published: toVersion(pub),
        draft: draft ? { ...toVersion(draft), stale: draft.basedOn !== pub.id } : null,
        spec,
        budget: { chars: editableChars(merged, spec), limit: budget.limit },
      };
    },
    { readOnly: true },
  );
}

/** 只列 published 与 archived，按 versionNo 倒序；limit ≤ 100 */
export async function listSopVersions(ctx: TenantCtx, q: { limit: number; beforeVersionNo?: number }): Promise<SopVersion[]> {
  const rt = runtimeFor(ctx);
  const limit = Math.max(1, Math.min(100, Math.floor(q.limit)));
  return withTenant(rt.db, ctx, async (tx) => (await listReleased(tx, limit, q.beforeVersionNo)).map((r) => toVersion(r)), {
    readOnly: true,
  });
}

/** 任意状态的一个版本（草稿、丢弃的也给：成员本来就看得到草稿） */
export async function getSopVersion(ctx: TenantCtx, id: string): Promise<SopVersion> {
  const rt = runtimeFor(ctx);
  if (!UUID_RE.test(id)) throw new SopNotFoundError('没有这个版本');
  const row = await withTenant(rt.db, ctx, (tx) => readVersionById(tx, id), { readOnly: true });
  if (!row) throw new SopNotFoundError('没有这个版本');
  return toVersion(row);
}

// ---------------- 草稿 ----------------

/**
 * 没有草稿时，以 basedOn 新建一份（basedOn 必须是当前已发布版本，rev 传 null）；已有草稿时 rev 必须相等。edits 只能点名可编辑节。
 * rebaseOnto（后台 UX spec「接口改动」，合并冲突用）：只对已有的草稿有效，必须是当前发布版本的 id。草稿按发布时同一个三方 rebase
 * （基线是草稿的 based_on、上游是当前发布版本）并进上游的改动，撞上的节都要在 edits 里（edits 就是合并的结果），
 * 存下来的节 = rebase 结果再应用 edits，based_on 换成 rebaseOnto。文字自动保存不记审计；显式写 policy 记 sop.policy_draft
 */
export async function saveSopDraft(
  ctx: TenantCtx,
  input: { basedOn: string; rev: number | null; edits: readonly { key: string; body: string }[]; rebaseOnto?: string; policy?: unknown },
  offline?: { db: Db; imageSections: readonly SopSection[]; policy?: PackPolicy; spec: readonly SectionSpec[] },
): Promise<SopVersion> {
  if (input.rev === null && input.rebaseOnto !== undefined) throw new SopInputError('没有草稿，不需要合并');
  // 08 R10：节表取绑定包的；离线（命令行）写草稿时由调用方按租户的包传入
  const spec = offline ? offline.spec : specOf(configRuntime());
  const keys = input.edits.map((e) => e.key);
  for (const key of keys) {
    const section = spec.find((s) => s.key === key);
    if (!section) throw new SopInputError(`没有「${key}」这一节`);
    if (section.locked) throw new SopLockedSectionError(key);
  }
  if (new Set(keys).size !== keys.length) throw new SopInputError('同一节在一次保存里出现了两次');
  // 正文按规范形重建；编码不合格在这里抛（SopEncodingError → 422）。空正文、行首「## 」照存，检查时报 structure、发布时拒绝
  const apply = (sections: readonly SopSection[]): SopSection[] =>
    sections.map((s) => {
      const e = input.edits.find((x) => x.key === s.key);
      const i = spec.findIndex((x) => x.key === s.key);
      return e ? rebuildSection(spec[i]!, e.body, i === spec.length - 1) : s;
    });
  try {
    const pack = offline ? offline.policy : configRuntime().deps.runtime?.policy;
    if (input.policy !== undefined) {
      if (!pack) throw new SopContractError([{ code: 'policy_invalid', sectionKey: null, detail: '当前行业包不支持政策配置' }]);
      const violations = pack.lint?.(input.policy) ?? [];
      if (violations.length) throw new SopContractError(violations);
    }
    const suppliedPolicy = input.policy === undefined ? undefined : policySnapshot(pack, input.policy);
    const persist = async (tx: Tx, rt: { tenantId: string; imageSections: readonly SopSection[] }) => {
      const audited = async (row: SopVersionRow) => {
        if (suppliedPolicy)
          await writeAudit(tx, {
            action: 'sop.policy_draft',
            targetType: 'sop_version',
            targetId: row.id,
            diff: { policyHash: suppliedPolicy.policyHash },
          });
        return toVersion(row, pack);
      };
      const draft = await readDraftForUpdate(tx);
      if (!draft) {
        if (input.rev !== null) throw new SopRevConflictError('草稿已经不在了（被发布或丢弃），刷新后重来');
        const pub = await readPublishedSop(tx);
        if (!pub || pub.id !== input.basedOn) throw new SopRevConflictError('发布版本在你打开之后变了，刷新后重来');
        // rev 接在以前所有草稿之后：每份草稿都从 1 开始的话，拿着已丢弃（或已发布）草稿的旧 rev 能发布、改写、丢弃这份新草稿
        const row = await insertDraft(tx, {
          tenantId: rt.tenantId,
          packId: pub.packId,
          sections: apply(mergeWithImage(pub.sections, rt.imageSections, spec)),
          policy: suppliedPolicy ? suppliedPolicy.policy : publishedPolicy(pack, pub).policy,
          basedOn: pub.id,
          rev: await nextDraftRev(tx),
          createdBy: ctx.actor.userId,
          createdByName: ctx.actor.name,
        });
        return audited(row);
      }
      if (input.rev === null || draft.rev !== input.rev) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
      if (input.rebaseOnto !== undefined) {
        const pub = await readPublishedSop(tx);
        if (!pub || pub.id !== input.rebaseOnto) throw new SopRevConflictError('线上又有新版本，刷新后重来');
        const base = draft.basedOn ? await readVersionById(tx, draft.basedOn) : null;
        const r = rebase(spec, base?.sections ?? pub.sections, pub.sections, draft.sections);
        // 撞上的节没给合并结果：形状同发布冲突，current 只带缺的这几节的线上正文
        const missing = r.conflicts.filter((k) => !keys.includes(k));
        if (missing.length) {
          const online = editableOf(spec, mergeWithImage(pub.sections, rt.imageSections, spec)).filter((s) => missing.includes(s.key));
          throw new SopConflictError(missing, online);
        }
        const row = await updateDraftSections(tx, draft.id, draft.rev, apply(r.sections), pub.id, suppliedPolicy?.policy);
        if (!row) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
        return audited(row);
      }
      const row = await updateDraftSections(tx, draft.id, draft.rev, apply(draft.sections), undefined, suppliedPolicy?.policy);
      if (!row) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
      return audited(row);
    };
    return offline
      ? await withTenant(offline.db, ctx, async (tx) => {
          await lockTenantConfig(tx);
          return persist(tx, { tenantId: ctx.tenantId, imageSections: offline.imageSections });
        })
      : await write(ctx, persist);
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
        const r = rebase(specOf(rt), base?.sections ?? pub.sections, pub.sections, draft.sections);
        conflicts = r.conflicts;
        if (!conflicts.length) sections = r.sections;
      }
      const policy = draftPolicy(rt.deps.runtime?.policy, draft.policy);
      const ev = await evaluate(tx, rt, sections, policy.policy);
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

/** 闸与发布共用同一份三方合并、渲染与静态检查；调用方持配置写锁。 */
export async function prepareSopDraft(tx: Tx, rt: ReturnType<typeof configRuntime>, draft: SopVersionRow, pub: SopVersionRow) {
  let mine: readonly SopSection[] = draft.sections;
  let rebasedFrom: number | null = null;
  if (draft.basedOn !== pub.id) {
    const base = draft.basedOn ? await readVersionById(tx, draft.basedOn) : null;
    const spec = specOf(rt);
    const r = rebase(spec, base?.sections ?? pub.sections, pub.sections, draft.sections);
    if (r.conflicts.length) throw new SopConflictError(r.conflicts, editableOf(spec, mergeWithImage(pub.sections, rt.imageSections, spec)));
    mine = r.sections;
    rebasedFrom = base?.versionNo ?? null;
  }
  const policy = draftPolicy(rt.deps.runtime?.policy, draft.policy);
  const ev = await evaluate(tx, rt, mine, policy.policy);
  if (ev.violations.length) throw new SopContractError(ev.violations);
  return { ev, policy, rebasedFrom };
}

/** 只供闸在配置写锁下捕获快照，长评测不持锁。 */
export async function gateDraftSnapshot(tx: Tx, ctx: TenantCtx, rev: number) {
  const rt = runtimeFor(ctx);
  const draft = await readDraftForUpdate(tx);
  if (!draft) throw new SopNotFoundError('没有草稿');
  if (draft.rev !== rev) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
  const pub = await readPublishedSop(tx);
  if (!pub) throw new SopNotFoundError('没有已发布的 SOP');
  const prepared = await prepareSopDraft(tx, rt, draft, pub);
  return {
    draft,
    pub,
    ...prepared,
    catalog: structuredClone(currentCatalog()),
    brand: currentSop().brand,
    publishedPolicy: publishedPolicy(rt.deps.runtime?.policy, pub),
  };
}

/**
 * 发布：核对 rev → 必要时三方 rebase → 与镜像合并、渲染、契约检查 → 归档当前版本、草稿翻成 published
 * （写回合并后的节，发布时才分配版本号）→ 审计。全部在一个事务里；提交之后才替换缓存
 */
export async function publishSopDraft(
  ctx: TenantCtx,
  input: { rev: number; changeNote: string; gateRunId?: string; override?: { reason: string } },
): Promise<SopVersion> {
  const note = requireNote(input.changeNote);
  const row = await write(ctx, async (tx, rt) => {
    const draft = await readDraftForUpdate(tx);
    if (!draft) throw new SopNotFoundError('没有草稿');
    if (draft.rev !== input.rev) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
    const pub = await readPublishedSop(tx);
    if (!pub) throw new SopNotFoundError('没有已发布的 SOP');
    const { ev, policy, rebasedFrom } = await prepareSopDraft(tx, rt, draft, pub);
    const sandbox = currentRuntime().kind === 'sandbox';
    if (input.override && (ctx.actor.kind !== 'user' || !ctx.actor.userId || ctx.actor.role !== 'owner'))
      throw new GateError('override_forbidden');
    const reason = input.override ? requireNote(input.override.reason) : null;
    if (reason && reason.length > 500) throw new SopInputError('强发原因不能超过500字');
    let gate: string | undefined = sandbox ? 'skipped_sandbox' : undefined;
    if (!sandbox && process.env.SOP_GATE === 'required') {
      if (reason) gate = 'override';
      else {
        const runs = (await gatesForDraft(tx, draft.id)).filter(
          (r) =>
            r.draftRev === draft.rev &&
            r.promptHash === ev.hashes.promptHash &&
            r.policyHash === policy.policyHash &&
            (!input.gateRunId || r.id === input.gateRunId),
        );
        const passed = runs.find((r) => r.status === 'done' && r.verdict === 'pass');
        if (!passed) {
          const failed = runs.find((r) => r.status === 'done' && r.verdict === 'fail');
          throw new GateError(failed ? 'gate_failed' : 'gate_required', failed?.id);
        }
        gate = passed.id;
      }
    }
    const spec = specOf(rt);
    const changedKeys = editableSpec(spec)
      .filter((s) => textOf(pub.sections, s.key) !== textOf(ev.merged, s.key))
      .map((s) => s.key);
    const versionNo = (await maxVersionNo(tx)) + 1;
    await archivePublished(tx, pub.id);
    const published = await publishDraft(tx, draft.id, draft.rev, {
      versionNo,
      sections: ev.merged,
      basedOn: pub.id,
      renderedPrompt: ev.rendered,
      ...ev.hashes,
      policy: policy.policy,
      renderInputs: renderInputsFor(rt.deps.render, rt.deps.imageSop, rt.deps.toolsJson, spec, currentSop().brand, policy.policyHash),
      changeNote: reason ? `${note}\n强发原因：${reason}` : note,
      publishedBy: ctx.actor.userId,
      publishedByName: ctx.actor.name,
    });
    if (!published) throw new SopRevConflictError('草稿已被别人改过，刷新后重来');
    await writeAudit(tx, {
      action: 'sop.publish',
      targetType: 'sop_version',
      targetId: published.id,
      diff: {
        versionNo,
        changedKeys,
        ...(rebasedFrom === null ? {} : { rebasedFrom }),
        ...(gate ? { gate } : {}),
        ...(reason ? { gate: sandbox ? 'skipped_sandbox' : 'override', override: { reason }, changeNote: note } : {}),
      },
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
  if (!UUID_RE.test(input.versionId)) throw new SopNotFoundError('只能回滚到已发布或已归档的版本');
  const { row, same } = await write(ctx, async (tx, rt) => {
    const target = await readVersionById(tx, input.versionId);
    if (!target || (target.status !== 'published' && target.status !== 'archived'))
      throw new SopNotFoundError('只能回滚到已发布或已归档的版本');
    const pub = await readPublishedSop(tx);
    if (!pub) throw new SopNotFoundError('没有已发布的 SOP');
    let policy: ReturnType<typeof policySnapshot>;
    try {
      policy = publishedPolicy(rt.deps.runtime?.policy, target);
    } catch {
      throw new SopContractError([{ code: 'policy_invalid', sectionKey: null, detail: '目标版本的政策快照不合格' }]);
    }
    const ev = await evaluate(tx, rt, target.sections, policy.policy);
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
      policy: policy.policy,
      renderInputs: renderInputsFor(rt.deps.render, rt.deps.imageSop, rt.deps.toolsJson, specOf(rt), currentSop().brand, policy.policyHash),
      changeNote: note,
      createdBy: ctx.actor.userId,
      createdByName: ctx.actor.name,
    });
    const sameHashAsTarget =
      v.promptHash === target.promptHash && policy.policyHash === (target.renderInputs?.policyHash ?? policy.policyHash);
    await writeAudit(tx, {
      action: 'sop.rollback',
      targetType: 'sop_version',
      targetId: v.id,
      diff: {
        fromVersionNo: pub.versionNo,
        toVersionNo: versionNo,
        targetVersionNo: target.versionNo,
        sameHashAsTarget,
        gate: 'skipped_rollback',
      },
    });
    return { row: v, same: sameHashAsTarget };
  });
  replacePublishedSop(toPublishedSop(ctx.tenantId, row, row.sections));
  return { ...toVersion(row), sameHashAsTarget: same };
}
