// 审计记录写成人话（docs/features/console-ux/spec.md「审计日志 · 句子」，设计系统 §5.11、§10.0、§10.2 K 页）。
// 总览的「最近变更」和审计日志页共用。动作的中文、分组、图标名在 ui-labels.ts 的 AUDIT_ACTIONS；实体名、字段名、话术节名
// 取自行业包；对象名从 diff 和产品库缓存（lookups）拼，查不到用编号。表里没有的动作兜底为「{操作者} 执行了一项操作」，
// 动作编码只放进技术详情。不依赖 React；diff 是库里的 JSON，形状按写审计的代码读，每一步都防着形状不对。
import type { AuditEntryView } from './console-api.js';
import { money } from './format.js';
import type { EntityType, FieldDef, IndustryPack } from './pack.js';
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

/** 按「a.b」这样的路径取嵌套对象里的值；路径中途不是对象时是 undefined */
const at = (v: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (isRecord(o) && Object.hasOwn(o, k) ? o[k] : undefined), v);

/**
 * 嵌套对象（intensity）在 diff 里整个记成 [原来, 现在]：逐个比包里的子字段（intensity.level、intensity.hardest），
 * 返回真正变了的那些在 fields 里的下标。两边都不是对象（形状认不出）时 null；认得出、包里的子字段却都没变时是空数组
 */
function changedSubFields(fields: readonly FieldDef[], key: string, subs: readonly number[], pair: unknown): number[] | null {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [was, now] = pair as [unknown, unknown];
  if (!(isRecord(was) || was === null) || !(isRecord(now) || now === null) || (was === null && now === null)) return null;
  return subs.filter((i) => {
    const sub = fields[i]!.key.slice(key.length + 1);
    return JSON.stringify(at(was, sub)) !== JSON.stringify(at(now, sub));
  });
}

/**
 * 产品库 diff（顶层键 → [原来, 现在]）写成行业包的字段名，按包里字段的顺序排。`id` 对应系统字段 `$code`。
 * 嵌套字段随它的顶层对象整体记在 diff 里：写真正变了的子字段（只改了 intensity.hardest 就写「最累的一段」），
 * diff 形状认不出时才取第一个子字段的标签；包里的子字段都没变（包里没有的子键变了，或只是键序变了）时不点名，
 * 算进「另N项」。包里找不到的键不写原名，同样合成「另N项」
 */
export function auditFieldLabels(entity: EntityType | null, diff: Readonly<Record<string, unknown>>): string[] {
  const fields = entity?.fields ?? [];
  const hit = new Set<number>();
  let unknown = 0;
  for (const [k, pair] of Object.entries(diff)) {
    const exact = fields.findIndex((f) => f.key === (k === 'id' ? '$code' : k));
    if (exact >= 0) {
      hit.add(exact);
      continue;
    }
    const subs = fields.flatMap((f, i) => (f.key.startsWith(`${k}.`) ? [i] : []));
    if (!subs.length) {
      unknown += 1;
      continue;
    }
    const changed = changedSubFields(fields, k, subs, pair);
    if (changed === null) hit.add(subs[0]!);
    else if (changed.length) for (const i of changed) hit.add(i);
    else unknown += 1;
  }
  const labels: string[] = [];
  for (const i of [...hit].sort((a, b) => a - b)) if (!labels.includes(fields[i]!.label)) labels.push(fields[i]!.label);
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

/** 条目名（审计页合并的那一句在摘要里列出前几条的名字）：与句子里的对象名同一个取法 */
export const auditItemName = (entry: AuditEntryView, pack: IndustryPack, lookups: AuditLookups = {}): string =>
  itemName(entry, entityOf(pack, entry.targetType), lookups);

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
/** 会话类、订单类动作的对象：「会话」加 diff 里的短码；没有短码时写「一个会话」 */
const conv = (diff: Record<string, unknown>): AuditPart[] => {
  const id = str(diff.shortId);
  return id ? [plain('会话'), strong(id)] : [plain('一个会话')];
};
/** 订单类动作句尾的金额（diff.totalPrice） */
const amount = (diff: Record<string, unknown>): Pick<Body, 'tail' | 'summary'> => {
  const n = typeof diff.totalPrice === 'number' && Number.isFinite(diff.totalPrice) ? diff.totalPrice : null;
  return n === null ? {} : { tail: `（${money(n)}）`, summary: money(n) };
};
/** 快捷回复的标题（diff.title）；没有时不写 */
const replyTitle = (diff: Record<string, unknown>): AuditPart[] => {
  const t = str(diff.title);
  return t ? [plain('「'), strong(t), plain('」')] : [];
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
  const changed = (): string[] => auditFieldLabels(entity, Object.fromEntries(Object.entries(diff).filter(([k]) => k !== 'reason')));
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
    case 'catalog.version': {
      // 「小林 记下了线路「…」的第2版」：之后发出的方案书按这一版报价，已发出的不变
      const v = int(diff.version);
      return { parts: [plain(`记下了${noun}`), ...name(), plain(v === null ? '的新版本' : `的第${v}版`)] };
    }
    case 'auth.login':
      return { parts: [plain('登录了')] };
    case 'auth.logout':
      return { parts: [plain('退出了登录')] };
    case 'config.import':
      return { parts: [plain('导入了初始配置')] };
    case 'tenant.brand_set':
      return { parts: [plain('设置了待生效企业信息配置')] };
    case 'tenant.brand_clear':
      return { parts: [plain('清除了待生效企业信息配置')] };
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
    // 02「后台接口」：会话类的对象是 diff 里的短码（审计不存会话 id），订单类同样写所属会话的短码
    case 'conversation.takeover':
      return { parts: [plain('接手了'), ...conv(diff)] };
    case 'conversation.reassign': {
      const from = str(diff.from);
      return {
        parts: [plain('接过了'), ...conv(diff)],
        ...(from ? { tail: `（原来是${from}在处理）`, summary: `原来是${from}在处理` } : {}),
      };
    }
    case 'conversation.release':
      return { parts: [plain('交还了'), ...conv(diff)] };
    case 'order.confirm':
      return { parts: [plain('确认了'), ...conv(diff), plain('的订单价格')], ...amount(diff) };
    case 'order.mark_paid':
      return { parts: [plain('确认收到了'), ...conv(diff), plain('的付款')], ...amount(diff) };
    case 'order.cancel': {
      const reason = str(diff.reason);
      return { parts: [plain('取消了'), ...conv(diff), plain('的订单')], ...(reason ? { summary: `原因：${reason}` } : {}) };
    }
    case 'quick_reply.create':
      return { parts: [plain('新建了快捷回复'), ...replyTitle(diff)] };
    case 'quick_reply.update':
      return { parts: [plain('修改了快捷回复'), ...replyTitle(diff)] };
    case 'quick_reply.archive':
      return { parts: [plain('收起了快捷回复'), ...replyTitle(diff)] };
    case 'quick_reply.move':
      return { parts: [plain(diff.direction === 'down' ? '下移了快捷回复' : '上移了快捷回复'), ...replyTitle(diff)] };
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
  const body = run.length > 1 ? merged(first, run.length, pack) : withVersion(single(first, pack, lookups), first);
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
/** 这几种写入在同一事务里接着记一行 catalog.version（02「报价快照」），那一行并进这次写入，不单独成句 */
const WRITES_VERSION = new Set(['catalog.update', 'catalog.activate', 'catalog.locked_fix']);
/**
 * 这个动作的记录能不能与相邻的记录合成一句（审计页按页取时，页尾是这类记录就要往后看一眼）。catalog.version 也算：
 * 它比自己那次写入新，排在前面，页尾是它时那次写入在下一页
 */
export const auditMergeable = (action: string): boolean => MERGEABLE.has(action) || action === 'catalog.version';

/** auditRuns 并掉的版本行：键是它并进的那次写入（同一个对象），describeAudit 据此在句尾写「（第N版）」 */
const absorbedVersion = new WeakMap<AuditEntryView, AuditEntryView>();

/**
 * version 是不是 write 那次写入在同一事务里记的版本行：同一条目、同一操作者、紧挨着（version 在前，新的在前）、相隔不超过 gapMs。
 * 系统的启动补写（source='backfill'）前面没有写入，单独成句
 */
function versionOfWrite(version: AuditEntryView, write: AuditEntryView | undefined, gapMs: number): boolean {
  return (
    !!write &&
    version.action === 'catalog.version' &&
    !(isRecord(version.diff) && version.diff.source === 'backfill') &&
    WRITES_VERSION.has(write.action) &&
    write.targetType === version.targetType &&
    write.targetId === version.targetId &&
    write.actorKind === version.actorKind &&
    write.actorName === version.actorName &&
    Math.abs(Date.parse(write.at) - Date.parse(version.at)) <= gapMs
  );
}

/** 单条写入并进了版本行、版本号大于 1 时句尾补「（第N版）」（上架恒为第 1 版，不写） */
function withVersion(body: Body, entry: AuditEntryView): Body {
  const ver = absorbedVersion.get(entry);
  const v = ver && isRecord(ver.diff) ? int(ver.diff.version) : null;
  if (v === null || v <= 1) return body;
  return { ...body, tail: `${body.tail ?? ''}（第${v}版）`, summary: body.summary ? `${body.summary}（第${v}版）` : `第${v}版` };
}
/** 相邻两条的时间差不超过它才合并（spec「审计日志 · 时间线」） */
export const AUDIT_RUN_GAP_MS = 5 * 60_000;

/**
 * 按 spec 合并连续的同类记录：同一操作者、同一动作、同一实体、相邻两条相隔不超过 5 分钟。只合并产品库的动作；
 * 输入是接口的顺序（新的在前），输出每组也是新的在前，各组按原顺序。
 * 后台改、上架、catalog-fix 在同一事务里接着记的 catalog.version 先并进那次写入（不出现在输出里，句尾写版本号，见
 * versionOfWrite），所以每次保存仍是一句、连着改几条仍合成「修改了N条」；审计行照写，只是不单独成句
 */
export function auditRuns(entries: readonly AuditEntryView[], gapMs = AUDIT_RUN_GAP_MS): AuditEntryView[][] {
  const runs: AuditEntryView[][] = [];
  for (const [i, e] of entries.entries()) {
    if (versionOfWrite(e, entries[i + 1], gapMs)) {
      absorbedVersion.set(entries[i + 1]!, e);
      continue;
    }
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
