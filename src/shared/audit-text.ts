// 审计记录写成人话（docs/features/console-ux/spec.md「审计日志 · 句子」，设计系统 §5.11、§10.0、§10.2 K 页）。
// 总览的「最近变更」和审计日志页共用。动作的中文、分组、图标名在 ui-labels.ts 的 AUDIT_ACTIONS；实体名、字段名、话术节名
// 取自行业包；对象名从 diff 和产品库缓存（lookups）拼，查不到用编号。表里没有的动作兜底为「{操作者} 执行了一项操作」，
// 动作编码只放进技术详情。不依赖 React；diff 是库里的 JSON，形状按写审计的代码读，每一步都防着形状不对。
import type { AuditEntryView } from './console-api.js';
import type { EntityType, IndustryPack } from './pack.js';
import { ACTOR_KIND_LABEL, auditAction, type AuditGroup, RERENDER_CAUSE_LABEL, roleLabel } from './ui-labels.js';

/** 查产品库缓存：这个实体里这个编号的条目名称（行业包 titleKey 的值）；缓存里没有时 undefined */
export interface AuditLookups {
  itemName?: (kind: string, code: string) => string | undefined;
}

/** 句子的一段；strong 的用 500（对象名、邮箱、版本号这类「对象」） */
export interface AuditPart {
  text: string;
  strong?: true;
}

export interface AuditText {
  /** 操作者：成员写显示名，命令行、系统写「命令行」「系统」；human 为 false 时画方块图标，不画头像 */
  actor: { name: string; human: boolean };
  /** 句子里操作者后面的部分（操作者与它之间留一个空格，操作者自己用 500） */
  parts: AuditPart[];
  /** 一行写完时接在句子后面的补充，如「的住宿档次、行程亮点」「，改了1节（异议处理）」；总览用 */
  tail: string | null;
  /** 审计页句子下一行的改动摘要，如「改了：住宿档次、行程亮点」 */
  summary: string | null;
  /** 纯文字的整句：操作者、空格、句子、补充 */
  text: string;
  /** 表里没有的动作时为 null */
  group: AuditGroup | null;
  /** lucide 名称；表里没有的动作用 circle-dashed */
  icon: string;
  /** 合在一起的条数（auditRuns 合并的连续同类记录），单条是 1 */
  count: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
/** diff 里 [原来, 现在] 的「现在」 */
const after = (v: unknown): unknown => (Array.isArray(v) && v.length === 2 ? v[1] : undefined);

/** 操作者（设计系统 §6.8、§11） */
export function auditActor(entry: Pick<AuditEntryView, 'actorKind' | 'actorName'>): { name: string; human: boolean } {
  if (entry.actorKind === 'user') return { name: str(entry.actorName) ?? '已删除的成员', human: true };
  return { name: ACTOR_KIND_LABEL[entry.actorKind], human: false };
}

/** 实体：按 targetType 在行业包里找；包里没有（换过包、老记录）时用包的「产品」叫法 */
const entityOf = (pack: IndustryPack, kind: string | null): EntityType | null =>
  (kind !== null && pack.entities.find((e) => e.kind === kind)) || null;

/**
 * 产品库 diff 的顶层键 → 行业包的字段名，按包里字段的顺序排。`id` 对应系统字段 `$code`；嵌套字段（intensity.level）
 * 随它的顶层对象整体记在 diff 里，取第一个子字段的标签。包里找不到的键不写原名，合成「另N项」
 */
export function auditFieldLabels(entity: EntityType | null, keys: readonly string[]): string[] {
  const fields = entity?.fields ?? [];
  const found: { label: string; at: number }[] = [];
  let unknown = 0;
  for (const k of keys) {
    const at = fields.findIndex((f) => (k === 'id' ? f.key === '$code' : f.key === k || f.key.startsWith(`${k}.`)));
    if (at < 0) unknown += 1;
    else if (!found.some((x) => x.label === fields[at]!.label)) found.push({ label: fields[at]!.label, at });
  }
  const labels = found.toSorted((a, b) => a.at - b.at).map((x) => x.label);
  if (unknown) labels.push(`另${unknown}项`);
  return labels;
}

/** 话术节的中文名：取行业包 sopSections 的 heading，前言写「前言」；认不出的合成「另N节」 */
function sectionNames(pack: IndustryPack, keys: readonly unknown[]): string[] {
  const names: string[] = [];
  let unknown = 0;
  for (const k of keys) {
    const s = typeof k === 'string' ? pack.sopSections.find((x) => x.key === k) : undefined;
    if (!s) unknown += 1;
    else names.push(s.heading ?? '前言');
  }
  if (unknown) names.push(`另${unknown}节`);
  return names;
}

/** 条目名：diff 里新值的名称（新建、改名）、产品库缓存、编号，依次取第一个有的 */
function itemName(entry: AuditEntryView, entity: EntityType | null, lookups: AuditLookups): string {
  const diff = isRecord(entry.diff) ? entry.diff : {};
  const fromDiff = entity ? str(after(diff[entity.titleKey])) : null;
  const code = str(entry.targetId);
  const cached = code !== null && entry.targetType !== null ? str(lookups.itemName?.(entry.targetType, code)) : null;
  return fromDiff ?? cached ?? code ?? '—';
}

interface Body {
  parts: AuditPart[];
  tail?: string | null;
  summary?: string | null;
}

const strong = (text: string): AuditPart => ({ text, strong: true });
const plain = (text: string): AuditPart => ({ text });
/** 版本号「v2」，作为对象用 500；diff 里没有时不写 */
const version = (n: number | null): AuditPart[] => (n === null ? [] : [strong(`v${n}`)]);
/** 账号类动作的对象：diff 里的邮箱；形状不对时写「一个账号」 */
const account = (diff: Record<string, unknown>): AuditPart => {
  const email = str(diff.email);
  return email ? strong(email) : plain('一个账号');
};
const revoked = (diff: Record<string, unknown>): string | null => {
  const n = int(diff.revokedSessions);
  return n !== null && n > 0 ? `退出了${n}处登录` : null;
};

/** 单条记录的句子（操作者之后的部分） */
function single(entry: AuditEntryView, pack: IndustryPack, lookups: AuditLookups): Body {
  const diff = isRecord(entry.diff) ? entry.diff : {};
  const entity = entityOf(pack, entry.targetType);
  const noun = entity?.label ?? pack.vocabulary.productNoun;
  const name = (): AuditPart[] => [plain('「'), strong(itemName(entry, entity, lookups)), plain('」')];
  const changed = (): string[] =>
    auditFieldLabels(
      entity,
      Object.keys(diff).filter((k) => k !== 'reason'),
    );
  const fieldsTail = (labels: string[]): Pick<Body, 'tail' | 'summary'> =>
    labels.length ? { tail: `的${labels.join('、')}`, summary: `改了：${labels.join('、')}` } : {};

  switch (entry.action) {
    case 'sop.publish': {
      const keys = Array.isArray(diff.changedKeys) ? diff.changedKeys : [];
      const names = sectionNames(pack, keys);
      return {
        parts: [plain('发布了话术'), ...version(int(diff.versionNo))],
        ...(names.length
          ? { tail: `，改了${keys.length}节（${names.join('、')}）`, summary: `改了${keys.length}节：${names.join('、')}` }
          : {}),
      };
    }
    case 'sop.rollback': {
      const to = int(diff.toVersionNo);
      return {
        parts: [plain('把话术回滚到'), ...version(int(diff.targetVersionNo))],
        ...(to === null ? {} : { tail: `，生成v${to}`, summary: `生成v${to}` }),
      };
    }
    case 'sop.discard':
      return { parts: [plain('丢弃了话术草稿')] };
    case 'sop.rerender': {
      const causes = (Array.isArray(diff.causes) ? diff.causes : [])
        .map((c) => (typeof c === 'string' && Object.hasOwn(RERENDER_CAUSE_LABEL, c) ? RERENDER_CAUSE_LABEL[c]! : null))
        .filter((c) => c !== null);
      return {
        parts: [plain('重新生成了话术'), ...version(int(diff.toVersionNo))],
        ...(causes.length ? { tail: `（${causes.join('、')}变了）`, summary: `${causes.join('、')}变了` } : {}),
      };
    }
    case 'catalog.create':
      return { parts: [plain(`新建了${noun}草稿`), ...name()] };
    case 'catalog.update':
      return { parts: [plain(`修改了${noun}`), ...name()], ...fieldsTail(changed()) };
    case 'catalog.activate':
      return { parts: [plain(`上架了${noun}`), ...name()] };
    case 'catalog.locked_fix':
      return { parts: [plain(`修正了${noun}`), ...name()], ...fieldsTail(changed()) };
    case 'auth.login':
      return { parts: [plain('登录了')] };
    case 'auth.logout':
      return { parts: [plain('退出了登录')] };
    case 'config.import':
      return { parts: [plain('导入了初始配置')] };
    case 'platform.tenant_create':
      return { parts: [plain('建了租户')] };
    case 'platform.user_create': {
      const role = `角色：${roleLabel(diff.role)}`;
      const parts =
        diff.created === false ? [plain('把'), account(diff), plain('加为成员')] : [plain('为'), account(diff), plain('建了账号')];
      return { parts, tail: `（${role}）`, summary: role };
    }
    case 'platform.user_password': {
      const r = revoked(diff);
      return { parts: [plain('为'), account(diff), plain('重设了密码')], tail: r && `，${r}`, summary: r };
    }
    case 'platform.user_disable': {
      const r = revoked(diff);
      return { parts: [plain('停用了'), account(diff)], tail: r && `，${r}`, summary: r };
    }
    case 'platform.member_role': {
      const pair = Array.isArray(diff.role) && diff.role.length === 2 ? diff.role : [undefined, undefined];
      return {
        parts: [plain('把'), account(diff), plain(`的角色改成${roleLabel(pair[1])}`)],
        tail: `（原来是${roleLabel(pair[0])}）`,
        summary: `原来是${roleLabel(pair[0])}`,
      };
    }
    case 'platform.member_remove':
      return {
        parts: [plain('把'), account(diff), plain('移出了租户')],
        tail: `（原来是${roleLabel(diff.role)}）`,
        summary: `原来是${roleLabel(diff.role)}`,
      };
    default:
      return { parts: [plain('执行了一项操作')] };
  }
}

/** 合并的连续同类记录（只有产品库的几种动作会合并，见 auditRuns） */
function merged(first: AuditEntryView, n: number, pack: IndustryPack): Body {
  const noun = entityOf(pack, first.targetType)?.label ?? pack.vocabulary.productNoun;
  const verb: Record<string, string> = {
    'catalog.create': `新建了${n}条${noun}草稿`,
    'catalog.update': `修改了${n}条${noun}`,
    'catalog.activate': `上架了${n}条${noun}`,
    'catalog.locked_fix': `修正了${n}条${noun}`,
  };
  return { parts: [plain(Object.hasOwn(verb, first.action) ? verb[first.action]! : `执行了${n}项操作`)] };
}

/**
 * 一条审计记录（或 auditRuns 合并出的一组）写成句子。
 * 例：「小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」」「小林 新建了6条酒店草稿」「老板 发布了话术v2，改了1节（异议处理）」
 */
export function describeAudit(
  entry: AuditEntryView | readonly AuditEntryView[],
  pack: IndustryPack,
  lookups: AuditLookups = {},
): AuditText {
  const run = Array.isArray(entry) ? (entry as readonly AuditEntryView[]) : [entry as AuditEntryView];
  const first = run[0];
  if (!first) throw new Error('describeAudit：没有记录');
  const def = auditAction(first.action);
  const body = run.length > 1 ? merged(first, run.length, pack) : single(first, pack, lookups);
  const actor = auditActor(first);
  const tail = body.tail ?? null;
  return {
    actor,
    parts: body.parts,
    tail,
    summary: body.summary ?? null,
    text: `${actor.name} ${body.parts.map((p) => p.text).join('')}${tail ?? ''}`,
    group: def?.group ?? null,
    icon: def?.icon ?? 'circle-dashed',
    count: run.length,
  };
}

/** 能合成一句的动作：产品库的这几种，同一实体（设计系统 §10.0：CSV 导入的 6 条酒店草稿合成一句） */
const MERGEABLE = new Set(['catalog.create', 'catalog.update', 'catalog.activate', 'catalog.locked_fix']);
/** 相邻两条的时间差不超过它才合并（spec「审计日志 · 时间线」） */
export const AUDIT_RUN_GAP_MS = 5 * 60_000;

/**
 * 按 spec 合并连续的同类记录：同一操作者、同一动作、同一实体、相邻两条相隔不超过 5 分钟。只合并产品库的动作；
 * 输入是接口的顺序（新的在前），输出每组也是新的在前，各组按原顺序
 */
export function auditRuns(entries: readonly AuditEntryView[], gapMs = AUDIT_RUN_GAP_MS): AuditEntryView[][] {
  const runs: AuditEntryView[][] = [];
  for (const e of entries) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    const same =
      !!last &&
      MERGEABLE.has(e.action) &&
      e.action === last.action &&
      e.targetType === last.targetType &&
      e.actorKind === last.actorKind &&
      e.actorName === last.actorName &&
      Math.abs(Date.parse(last.at) - Date.parse(e.at)) <= gapMs;
    if (same) run!.push(e);
    else runs.push([e]);
  }
  return runs;
}
