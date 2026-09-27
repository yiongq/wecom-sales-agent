// 检查清单（spec「通用部件 · CheckList」，design-system §5.17）：发布前检查与上架前检查共用。
// 头是标题与「6/7通过」，下一行是补充；每项一个图标（通过、没过、只是建议、还没跑）、标签和右侧说明，没过时说明用 danger 字。
// 没过的项给了 onClick 就整行是一个按钮，末尾加箭头，点了跳到出问题的位置
import { CheckCircleOutlined, CloseCircleOutlined, RightOutlined, WarningOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { cjk } from '../typography.js';

export type CheckState = 'pass' | 'fail' | 'warn' | 'pending';

export interface CheckItem {
  key: string;
  label: string;
  state: CheckState;
  /** 右侧 13 号说明，如「不拦上架」；数组的各段之间用 Sep 隔开，如 ['1处', '话术原则'] */
  note?: string | readonly string[];
  /** 点了跳到出问题的位置；只对没过和建议项生效 */
  onClick?: () => void;
}

const STATE_NAME: Readonly<Record<CheckState, string>> = { pass: '通过', fail: '没过', warn: '建议', pending: '还没跑' };

function StateIcon({ state }: { state: CheckState }) {
  if (state === 'pass') return <CheckCircleOutlined className="check-icon check-icon-pass" aria-hidden="true" />;
  if (state === 'fail') return <CloseCircleOutlined className="check-icon check-icon-fail" aria-hidden="true" />;
  if (state === 'warn') return <WarningOutlined className="check-icon check-icon-warn" aria-hidden="true" />;
  return <span className="check-icon check-icon-pending" aria-hidden="true" />;
}

function Row({ item }: { item: CheckItem }) {
  const inner = (
    <>
      <StateIcon state={item.state} />
      <span className="check-item-label">{cjk(item.label)}</span>
      {item.note && <span className="check-item-note">{cjk(item.note)}</span>}
    </>
  );
  const cls = `check-item check-item-${item.state}`;
  if (item.onClick && item.state !== 'pass' && item.state !== 'pending') {
    return (
      <button type="button" className={cls} onClick={item.onClick} aria-label={`${item.label}：${STATE_NAME[item.state]}`}>
        {inner}
        <RightOutlined className="check-item-chevron" aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className={cls} aria-label={`${item.label}：${STATE_NAME[item.state]}`} role="group">
      {inner}
    </div>
  );
}

export interface CheckListProps {
  /** 卡片标题字阶，如「发布前检查」「上架前检查」 */
  title: string;
  /** 右侧，如「6/7通过」「必须项13/13 · 建议1条没做」 */
  summary?: ReactNode;
  /** 下一行，如「每次自动保存都会跑 · 上次14:05」 */
  meta?: ReactNode;
  items: readonly CheckItem[];
}

export function CheckList({ title, summary, meta, items }: CheckListProps) {
  return (
    <section className="check-list" aria-label={title}>
      <div className="check-list-head">
        <h3 className="check-list-title">{cjk(title)}</h3>
        {summary && <span className="check-list-summary">{typeof summary === 'string' ? cjk(summary) : summary}</span>}
      </div>
      {meta && <div className="check-list-meta">{typeof meta === 'string' ? cjk(meta) : meta}</div>}
      <ul className="check-list-items">
        {items.map((item) => (
          <li key={item.key}>
            <Row item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}
