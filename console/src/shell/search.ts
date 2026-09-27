// ⌘K 的纯逻辑（spec「外壳 · 搜索触发器」，设计系统 §5.18）：匹配、分组、各组的加载与出错、键盘。
// 结果分组为「页面 / 各实体 / 会话 / 操作」。「页面」「操作」是静态的；「各实体」用各实体的列表（与列表页共用缓存），
// 按行业包 list.search 的字段在前端匹配；「会话」只搜最近 100 个会话，按短码匹配，匿名没有这一组。
// 支持拼音和首字母：拼音库（pinyin-match）在 ⌘K 第一次打开时才加载，不进入口集合；加载好之前只按原文匹配
import type { LucideIcon } from 'lucide-react';
import type { ConversationRow } from '../../../src/shared/console-api.js';
import { shortIdOf } from '../../../src/shared/conversation.js';
import type { EntityType } from '../../../src/shared/pack.js';

/** 拼音库的接口（pinyin-match 的 default export）：命中时返回下标区间，否则 false */
export interface PinyinLib {
  match(input: string, keys: string): [number, number] | false;
}

export type Matcher = (text: string, query: string) => boolean;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '');

/** 原文匹配：不分大小写、忽略空白的子串 */
export const plainMatch: Matcher = (text, query) => {
  const q = norm(query);
  return q.length > 0 && norm(text).includes(q);
};

/** 原文匹配，再试拼音与首字母（「jd」→ 酒店，「xianlu」→ 线路） */
export const pinyinMatcher =
  (lib: PinyinLib): Matcher =>
  (text, query) =>
    plainMatch(text, query) || (norm(query).length > 0 && lib.match(text, query.trim()) !== false);

// ---------------- 条目取值 ----------------

/** 条目里按字段 key 取值：$code 是编号；数组连成一串（其他叫法、标签）；对象不参与匹配 */
export function fieldText(item: { code: string; payload: unknown }, key: string): string {
  if (key === '$code') return item.code;
  let v: unknown = item.payload;
  for (const part of key.split('.')) {
    if (!v || typeof v !== 'object' || !Object.hasOwn(v, part)) return '';
    v = (v as Record<string, unknown>)[part];
  }
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').join(' ');
  return '';
}

// ---------------- 结果 ----------------

export type GroupState = 'ok' | 'loading' | 'error';

export interface Row<A> {
  key: string;
  /** 一段或几段（几段之间用 Sep 隔开） */
  label: string | readonly string[];
  /** 右侧 13 text-3 的补充；几段时用 Sep 隔开 */
  hint?: string | readonly string[];
  /** 行首 16 的图标；不给就用这一组的图标（实体、会话） */
  icon?: LucideIcon;
  action: A;
}

export interface Group<A> {
  key: string;
  title: string;
  state: GroupState;
  rows: Row<A>[];
  /** 组底的说明，如「只搜最近100个会话」 */
  footer?: string;
}

export interface EntitySource {
  entity: Pick<EntityType, 'kind' | 'label' | 'titleKey' | 'subtitleKeys' | 'list'>;
  state: GroupState;
  items: ReadonlyArray<{ code: string; payload: unknown }>;
}

export interface ConversationSource {
  state: GroupState;
  rows: readonly ConversationRow[];
  /** 行的标签与补充，由外壳按行业包拼（「企微客户 · F01」「8分钟前」） */
  label: (row: ConversationRow) => readonly string[];
  hint: (row: ConversationRow) => string;
}

export interface StaticRow<A> {
  key: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  action: A;
}

export interface SearchInput<A> {
  query: string;
  match: Matcher;
  pages: readonly StaticRow<A>[];
  entities: readonly EntitySource[];
  /** 匿名是 null：没有「会话」组 */
  conversations: ConversationSource | null;
  actions: readonly StaticRow<A>[];
  /** 各实体与会话，每组最多列几条 */
  limit?: number;
  entityAction: (kind: string, code: string) => A;
  conversationAction: (row: ConversationRow) => A;
}

export const CONVERSATION_FOOTER = '只搜最近100个会话';

/**
 * 按输入算出各组。没输入时只列「页面」「操作」；有输入时列出各组命中的行，还在取的组给一行骨架（state loading），
 * 取失败的组给一行「没取到 · 重试」（state error），其他组照常。命中 0 行的 ok 组不出现
 */
export function searchGroups<A>(input: SearchInput<A>): Group<A>[] {
  const q = input.query.trim();
  const limit = input.limit ?? 5;
  const statics = (key: string, title: string, rows: readonly StaticRow<A>[]): Group<A> => ({
    key,
    title,
    state: 'ok',
    rows: (q ? rows.filter((r) => input.match(r.label, q)) : rows).map((r) => ({ ...r })),
  });
  const groups: Group<A>[] = [statics('pages', '页面', input.pages)];
  if (q) {
    for (const src of input.entities) {
      const rows: Row<A>[] =
        src.state === 'ok'
          ? src.items
              .filter((it) => src.entity.list.search.some((k) => input.match(fieldText(it, k), q)))
              .slice(0, limit)
              .map((it) => ({
                key: `${src.entity.kind}:${it.code}`,
                label: fieldText(it, src.entity.titleKey) || it.code,
                hint: src.entity.subtitleKeys.map((k) => fieldText(it, k)).filter(Boolean),
                action: input.entityAction(src.entity.kind, it.code),
              }))
          : [];
      groups.push({ key: `entity:${src.entity.kind}`, title: src.entity.label, state: src.state, rows });
    }
    const c = input.conversations;
    if (c) {
      const code = norm(q).toUpperCase();
      const rows: Row<A>[] =
        c.state === 'ok'
          ? c.rows
              .filter((r) => code.length > 0 && shortIdOf(r.id).includes(code))
              .slice(0, limit)
              .map((r) => ({ key: `conversation:${r.id}`, label: c.label(r), hint: c.hint(r), action: input.conversationAction(r) }))
          : [];
      groups.push({ key: 'conversations', title: '会话', state: c.state, rows, footer: CONVERSATION_FOOTER });
    }
  }
  groups.push(statics('actions', '操作', input.actions));
  return groups.filter((g) => g.state !== 'ok' || g.rows.length > 0);
}

/** 可以用 ↑↓ 选中、Enter 打开的行，按显示顺序排成一列 */
export const selectableRows = <A>(groups: readonly Group<A>[]): Row<A>[] => groups.flatMap((g) => g.rows);

// ---------------- 键盘 ----------------

export type PaletteKey = 'up' | 'down' | 'open' | null;

/**
 * ⌘K 里的按键：只用 ↑↓ 移动、Enter 打开。输入法组字时的 Enter 是在选字，不打开结果；
 * 不响应不带修饰键的 J / K：拼音是直接敲拉丁字母的，「jd」「kh」这类查询要能输入（设计系统 §5.18）
 */
export function paletteKey(e: { key: string; isComposing?: boolean; keyCode?: number }): PaletteKey {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'ArrowDown') return 'down';
  if (e.key === 'ArrowUp') return 'up';
  if (e.key === 'Enter') return 'open';
  return null;
}

/** 当前行按 ↑↓ 移动，首尾循环；没有行时是 -1 */
export function moveActive(active: number, count: number, key: 'up' | 'down'): number {
  if (count <= 0) return -1;
  if (active < 0) return key === 'down' ? 0 : count - 1;
  return (active + (key === 'down' ? 1 : -1) + count) % count;
}

/**
 * 打开 ⌘K 的快捷键按平台只认一种：Mac 是 ⌘K，其余是 Ctrl+K；不带 Shift、Alt，也不带另一个修饰键。
 * Mac 上不认 Ctrl+K：它是文本框和 CodeMirror 里的「删到行尾」，认了就一按两用。别处已经处理过的按键（defaultPrevented）不接
 */
export const isPaletteShortcut = (
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented?: boolean },
  mac: boolean,
): boolean =>
  !e.defaultPrevented &&
  (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
  !e.shiftKey &&
  !e.altKey &&
  e.key.toLowerCase() === 'k';

/** 快捷键的提示：Tooltip 里的写法与 aria-keyshortcuts（设计系统 §4.2 第 2 项） */
export const paletteShortcut = (mac: boolean): { label: string; aria: string } =>
  mac ? { label: '⌘K', aria: 'Meta+K' } : { label: 'Ctrl+K', aria: 'Control+K' };
