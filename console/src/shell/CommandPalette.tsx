// ⌘K（spec「外壳 · 搜索触发器」，设计系统 §5.18）：antd Modal，宽 640、距顶 120、无动画。
// 结果分组为「页面 / 各实体 / 会话 / 操作」，匹配与分组在 search.ts。只用 ↑↓ 移动、Enter 打开；输入法组字时 Enter 不打开；
// 不响应不带修饰键的 J / K。拼音库在第一次打开时才加载（动态 import，不进入口集合），加载好之前按原文匹配。
// 某一组还在取时显示一行骨架（和别处的骨架一样 300ms 后才出现）；取失败时这一组显示一行「没取到 · 重试」，其他组照常。
// 匿名没有「会话」组。弹窗的名字是「搜索」：标题只给读屏，看不见（设计系统 §5.18 没有标题栏）
import { useQueries, useQuery } from '@tanstack/react-query';
import { Button, Modal } from 'antd';
import { type LucideIcon, MessagesSquare, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConversationRow } from '../../../src/shared/console-api.js';
import type { IndustryPack } from '../../../src/shared/pack.js';
import { catalogKind } from '../api.js';
import { paletteConversationsQuery, paletteListQuery } from '../queries.js';
import { cjk } from '../typography.js';
import { entityIcon, Icon } from './icons.js';
import { conversationLabel, packEntities, sinceText, type ShellViewer } from './model.js';
import {
  type EntitySource,
  type GroupState,
  moveActive,
  type PinyinLib,
  paletteKey,
  pinyinMatcher,
  plainMatch,
  searchGroups,
  selectableRows,
  type StaticRow,
} from './search.js';

let pinyinLoad: Promise<PinyinLib> | null = null;
/** 拼音库只加载一次；加载失败就一直按原文匹配 */
const loadPinyin = (): Promise<PinyinLib> => (pinyinLoad ??= import('pinyin-match').then((m) => m.default as PinyinLib));

export type PaletteAction = () => void;

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  viewer: ShellViewer;
  pack: IndustryPack;
  placeholder: string;
  pages: readonly StaticRow<PaletteAction>[];
  actions: readonly StaticRow<PaletteAction>[];
  openEntity: (kind: string, code: string) => void;
  openConversation: (row: ConversationRow) => void;
}

const stateOf = (q: { isPending: boolean; isError: boolean; data?: unknown }): GroupState =>
  q.data !== undefined ? 'ok' : q.isError ? 'error' : 'loading';

export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose, viewer, pack } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pinyin, setPinyin] = useState<PinyinLib | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const member = viewer.kind === 'member';

  useEffect(() => {
    if (!open || pinyin) return;
    let live = true;
    loadPinyin().then(
      (lib) => live && setPinyin(() => lib),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, pinyin]);

  // 各实体的列表与列表页、侧栏共用缓存；打开时只取还没载入的（刷新归侧栏和列表页）。实体表与侧栏、搜索占位同源
  const entities = packEntities(pack).map((entity) => ({ entity, kind: catalogKind(entity.kind) }));
  const lists = useQueries({ queries: entities.map(({ kind }) => paletteListQuery(kind, open)) });
  const conversations = useQuery(paletteConversationsQuery(open && member));

  const match = useMemo(() => (pinyin ? pinyinMatcher(pinyin) : plainMatch), [pinyin]);
  const now = conversations.dataUpdatedAt;
  const sources: EntitySource[] = entities.map(({ entity }, i) => ({
    entity,
    state: stateOf(lists[i]!),
    items: lists[i]!.data?.items ?? [],
  }));
  const groups = searchGroups<PaletteAction>({
    query,
    match,
    pages: props.pages,
    entities: sources,
    conversations: member
      ? {
          state: stateOf(conversations),
          rows: conversations.data?.items ?? [],
          label: (row) => conversationLabel(row, pack),
          hint: (row) => sinceText(row.updatedAt, now),
        }
      : null,
    actions: props.actions,
    entityAction: (kind, code) => () => props.openEntity(kind, code),
    conversationAction: (row) => () => props.openConversation(row),
  });
  const rows = selectableRows(groups);
  const current = rows.length ? Math.min(Math.max(active, 0), rows.length - 1) : -1;
  const optionId = (i: number): string => `${listId}-opt-${i}`;

  useEffect(() => {
    if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  });

  /** 每组的图标（行里 16 text-3）与重试 */
  const groupIcon = (key: string): LucideIcon | null => {
    if (key === 'conversations') return MessagesSquare;
    const e = entities.find(({ entity }) => `entity:${entity.kind}` === key);
    return e ? entityIcon(e.entity.icon) : null;
  };
  const retryGroup = (key: string): void => {
    if (key === 'conversations') void conversations.refetch();
    const i = entities.findIndex(({ entity }) => `entity:${entity.kind}` === key);
    if (i >= 0) void lists[i]?.refetch();
  };

  const run = (i: number): void => {
    const row = rows[i];
    if (!row) return;
    onClose();
    row.action();
  };

  // 每组第一行在整列里的序号（↑↓ 按整列走）
  const starts = groups.map((_, gi) => groups.slice(0, gi).reduce((n, g) => n + g.rows.length, 0));
  const noResults = query.trim() !== '' && groups.length === 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="搜索"
      footer={null}
      closable={false}
      width={640}
      style={{ top: 120 }}
      transitionName=""
      maskTransitionName=""
      rootClassName="cmdk-root"
      destroyOnHidden
      afterOpenChange={(visible) => {
        if (visible) inputRef.current?.focus();
        else {
          setQuery('');
          setActive(0);
        }
      }}
    >
      <div className="cmdk-input">
        <Icon of={Search} size={18} />
        <input
          ref={inputRef}
          value={query}
          placeholder={props.placeholder}
          aria-label="搜索"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            const k = paletteKey({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode });
            if (k === null) return;
            e.preventDefault();
            if (k === 'open') run(current);
            else setActive(moveActive(current, rows.length, k));
          }}
        />
      </div>
      <div className="cmdk-results" id={listId} role="listbox" aria-label="搜索结果">
        {groups.map((g, gi) => (
          <div key={g.key} className="cmdk-group" role="group" aria-label={g.title}>
            <div className="cmdk-group-title" aria-hidden="true">
              {g.title}
            </div>
            {g.state === 'loading' && (
              <div className="cmdk-row cmdk-skeleton state-skeleton" aria-hidden="true">
                <span className="skeleton-bar" />
              </div>
            )}
            {g.state === 'error' && (
              <div className="cmdk-row cmdk-error">
                <span>没取到</span>
                <Button type="link" size="small" onClick={() => retryGroup(g.key)}>
                  重试
                </Button>
              </div>
            )}
            {g.rows.map((r, ri) => {
              const i = starts[gi]! + ri;
              const icon = r.icon ?? groupIcon(g.key);
              return (
                <div
                  key={r.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  className={i === current ? 'cmdk-row is-active' : 'cmdk-row'}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => run(i)}
                >
                  <span className="cmdk-icon">{icon && <Icon of={icon} />}</span>
                  <span className="cmdk-label">{cjk(r.label)}</span>
                  {r.hint && (typeof r.hint === 'string' ? r.hint : r.hint.length > 0) && <span className="cmdk-hint">{cjk(r.hint)}</span>}
                </div>
              );
            })}
            {g.footer && <div className="cmdk-footer">{g.footer}</div>}
          </div>
        ))}
        {noResults && (
          <div className="cmdk-empty">
            <p className="cmdk-empty-title">{cjk(`没有找到「${query.trim()}」`)}</p>
            <p className="cmdk-empty-desc">换个说法，或者用拼音首字母</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
