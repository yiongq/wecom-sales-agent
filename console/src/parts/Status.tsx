// 状态（spec「通用部件」、不变量 6，design-system §5.6）：全站唯一表达状态的组件，圆点加文字。
// 只有「等人接手」加底色（第一次出现时圆点闪 3 次）；草稿是空心圆点；只读是中性胶囊。
// 状态不用主色，也不用带 color 的 Tag、Badge 或 Radio.Button 表达（scripts/check-console-src.ts 查）。
// 顾问处理中（assigned）02 起有了数据，列表与铃铛到 02 第 19 步才画它

export type StatusKind = 'ai' | 'human' | 'assigned' | 'paid' | 'active' | 'live' | 'draft' | 'readonly';

export const STATUS_LABEL: Readonly<Record<StatusKind, string>> = {
  ai: 'AI接待中',
  human: '等人接手',
  assigned: '顾问处理中',
  paid: '已成交',
  active: '已上架',
  live: '线上',
  draft: '草稿',
  readonly: '只读',
};

export function Status({ kind, title }: { kind: StatusKind; title?: string }) {
  return (
    <span className={`status status-${kind}`} title={title}>
      <span className="status-dot" aria-hidden="true" />
      {STATUS_LABEL[kind]}
    </span>
  );
}
