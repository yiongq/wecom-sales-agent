// 「预览」页签（spec「产品库详情与编辑」：按 375 宽、单栏、只读形态渲染全部分组，包含未保存的改动，让运营看到文字在手机宽度上的样子；
// plan 第 10.3 步）。字段走渲染器的只读形态（与没有编辑权限时同一套），表单网格按自己的宽度收列（fields.css 的容器查询：
// 窄于 480 时两列并成一列），所以放进 375 宽的框里就是单栏。全部以文本节点渲染：产品库文本是不可信输入（01，不变量 28）。
// 行业包只经 props 进来
import { useId } from 'react';
import type { EntityType } from '../../../src/shared/pack.js';
import { FieldGrid } from '../fields/FieldGrid.js';
import type { ItemContext, Payload } from '../fields/model.js';
import { cjk } from '../typography.js';
import { blockOnly, cardHasFields } from './detail.js';

/** 只读：不会写回 */
const READ_ONLY = (): void => undefined;

function PreviewGroup({
  entity,
  group,
  state,
  ctx,
}: {
  entity: EntityType;
  group: { key: string; label: string };
  state: Payload;
  ctx: ItemContext;
}) {
  const id = useId();
  // 只有多字段有序子项的分组，区块头「逐日行程 · 8天」就是标题（同编辑页签）
  const block = blockOnly(entity, group.key);
  return (
    <section
      className="preview-group"
      data-group={group.key}
      aria-labelledby={block ? undefined : id}
      aria-label={block ? group.label : undefined}
    >
      {block ? null : (
        <h2 id={id} className="preview-group-title">
          {cjk(group.label)}
        </h2>
      )}
      <FieldGrid entity={entity} group={group.key} state={state} ctx={ctx} onChange={READ_ONLY} />
    </section>
  );
}

export interface ItemPreviewProps {
  entity: EntityType;
  /** 条目名 */
  title: string;
  /** 表单里眼下的内容（含没保存的改动） */
  state: Payload;
  status: ItemContext['status'];
  /** 有没保存的改动：说明里写一句 */
  dirty: boolean;
}

export function ItemPreview({ entity, title, state, status, dirty }: ItemPreviewProps) {
  // 只读形态：不挂锁、不写帮助（与没有编辑权限看到的相同），锁定与否在编辑页签看
  const ctx: ItemContext = { status, canEdit: false };
  return (
    <div className="detail-preview">
      <p className="detail-preview-note">{cjk(['手机宽度', ...(dirty ? ['含没保存的改动'] : [])])}</p>
      <section className="detail-preview-frame" aria-label="手机宽度预览">
        <p className="detail-preview-title">{cjk(title)}</p>
        {entity.groups
          .filter((g) => cardHasFields(entity, g.key, state))
          .map((g) => (
            <PreviewGroup key={g.key} entity={entity} group={g} state={state} ctx={ctx} />
          ))}
      </section>
    </div>
  );
}
