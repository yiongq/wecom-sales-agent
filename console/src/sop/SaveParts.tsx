// 自动保存在页面上的样子（spec「销售话术 · 状态句」「自动保存」，设计系统 §4.3）：
// - SaveState：状态句的最后一段，「保存中…」「已自动保存14:05」、danger 的「没保存上 · 重试」（「重试」是按钮）；
//   本次打开页面后还没保存过时不写。按最宽的两种写法占好位置（看不见的两行叠在同一格里），切换时不挤动、不折行。
// - ConflictBanner：409 以后页头下的横幅「草稿刚被别人改过」和「载入最新草稿」；自动保存已经停住，编辑器只读。
// - LostEdits：载入最新草稿以后，没存上的节以只读对比的形式留着（左边最新草稿、右边你写的），可以选中复制；
//   又一次 409 时接在后面，关掉之前不丢。
import { Alert, Button } from 'antd';
import { memo, type Ref, useId } from 'react';
import { clockTime } from '../../../src/shared/format.js';
import { TechDetails } from '../parts/TechDetails.js';
import { SectionDiff } from '../SectionDiff.js';
import { cjk, Sep } from '../typography.js';
import type { SaveStatus } from './autosave.js';

/** 自动保存没存上（状态句的保存那一段、发布条的左边） */
export const SAVE_FAILED = '没保存上';
const RETRY = '重试';

export function saveText(status: SaveStatus): string | null {
  switch (status.kind) {
    case 'saving':
      return '保存中…';
    case 'saved':
      return `已自动保存${clockTime(status.at)}`;
    case 'failed':
    case 'conflict':
      return SAVE_FAILED;
    default:
      return null;
  }
}

export function SaveState({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  const text = saveText(status);
  const failed = status.kind === 'failed' || status.kind === 'conflict';
  return (
    <span className="sop-save">
      {/* 占位：最宽的两种写法（数字是等宽的），看不见、读屏不念 */}
      <span className="sop-save-sizer" aria-hidden="true">
        {cjk(['', '已自动保存00:00'])}
      </span>
      <span className="sop-save-sizer" aria-hidden="true">
        {cjk(['', SAVE_FAILED, RETRY])}
      </span>
      <span className="sop-save-now" role="status">
        {text !== null && <Sep />}
        {failed ? (
          <span className="sop-save-failed">
            {SAVE_FAILED}
            {/* 409 以后不能重试，要先载入最新草稿（横幅上的按钮） */}
            {status.kind === 'failed' && (
              <>
                <Sep />
                <button type="button" className="sop-save-retry" onClick={onRetry}>
                  {RETRY}
                </button>
              </>
            )}
          </span>
        ) : (
          text
        )}
      </span>
    </span>
  );
}

export function ConflictBanner({
  error,
  names,
  loading,
  onReload,
}: {
  error: unknown;
  /** 没存上的节名 */
  names: readonly string[];
  loading: boolean;
  onReload: () => void;
}) {
  const next = names.length
    ? `自动保存停下了；载入最新草稿以后，你没保存上的${names.length}节（${names.join('、')}）以对比形式留在下面，可以复制`
    : '自动保存停下了；载入最新草稿以后接着改';
  return (
    <Alert
      type="error"
      showIcon
      title={cjk('草稿刚被别人改过')}
      description={
        <>
          <div>{cjk(next)}</div>
          <TechDetails error={error} />
        </>
      }
      action={
        <Button size="small" loading={loading} onClick={onReload}>
          载入最新草稿
        </Button>
      }
    />
  );
}

export interface LostSection {
  key: string;
  /** 同一节第几次没存上（从 1 数）：别人接着在存时同一节可能接连 409 几次，每次一份对比 */
  nth: number;
  name: string;
  /** 载入时草稿里这一节的正文 */
  latest: string;
  /** 你写的、没存上的 */
  mine: string;
}

/** 对比里的节名；同一节有几份时写「话术原则（第2次没存上）」，按先后排 */
export const lostName = (items: readonly LostSection[], it: LostSection): string =>
  items.some((x) => x.key === it.key && x.nth !== it.nth) ? `${it.name}（第${it.nth}次没存上）` : it.name;

/** titleRef：标题可以由页面聚焦（载入最新草稿以后，读屏从这里念起），它不在 Tab 顺序里 */
export const LostEdits = memo(function LostEdits({
  items,
  onClose,
  titleRef,
}: {
  items: readonly LostSection[];
  onClose: () => void;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  const titleId = useId();
  return (
    <section className="sop-card sop-lost" aria-labelledby={titleId}>
      <div className="sop-lost-head">
        <div>
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className="sop-card-title">
            {cjk('你没保存上的改动')}
          </h2>
          <p className="sop-lost-note">{cjk('只读，选中以后可以复制；关掉以后就找不回来了')}</p>
        </div>
        <Button size="small" onClick={onClose}>
          关掉对比
        </Button>
      </div>
      {items.map((it) => (
        <div key={`${it.key}#${it.nth}`} className="sop-lost-item">
          <h3 className="sop-lost-name">{cjk(lostName(items, it))}</h3>
          <SectionDiff before={it.latest} after={it.mine} beforeLabel="最新草稿" afterLabel="你没保存上的" />
        </div>
      ))}
    </section>
  );
});
