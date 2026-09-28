// 逐节改动（spec「发布抽屉」第 3 条，设计系统 §6.5）：只列改过的节，节标题行写「+3行 −1行」，未改动的部分折叠。
// 行内是 @codemirror/merge 的 unifiedMergeView（allowInlineDiffs、mergeControls: false：只看不改），并排是 MergeView；
// 两种都只读、自动换行，内置文案用话术编辑器那一份汉化（「18行没有改动」）。选哪一种存在 localStorage（publish.ts）。
// 颜色全在 sop.css 的 .sop-diff 里：新增行 --success-bg、行首「+」，删除行 --subtle、text-2、删除线、行首「−」，
// 删除不用红色（@codemirror/merge 自带的红色、绿色和 ⦚ 都覆盖掉）；读屏念「删去：」「发出：」，不只靠颜色
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Segmented } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';
import { cspNonce } from '../csp.js';
import { cjk } from '../typography.js';
import type { SectionChange } from './outline.js';
import { DIFF_CONFIG, type DiffMode, lineStat, readDiffMode, statText, writeDiffMode } from './publish.js';
import { cmPhrases } from './SopEditor.js';

/** 改动前后各留 2 行，连着 4 行以上没改才折叠 */
const COLLAPSE = { margin: 2, minSize: 4 };

function readOnly(label: string): Extension[] {
  return [
    ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
    cmPhrases,
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ 'aria-label': label }),
  ];
}

/** 一节的差异：before 是线上的正文，after 是草稿的；两边的名字写在并排的两栏上方与读屏的名称里 */
export function DiffView({ change, mode, labels }: { change: SectionChange; mode: DiffMode; labels: readonly [string, string] }) {
  const host = useRef<HTMLDivElement>(null);
  const { before, after, name } = change;
  const [beforeLabel, afterLabel] = labels;
  useEffect(() => {
    const parent = host.current!;
    if (mode === 'inline') {
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: after,
          extensions: [
            ...readOnly(`「${name}」的改动`),
            unifiedMergeView({
              original: before,
              mergeControls: false,
              allowInlineDiffs: true,
              gutter: false,
              syntaxHighlightDeletions: false,
              collapseUnchanged: COLLAPSE,
              diffConfig: DIFF_CONFIG,
            }),
          ],
        }),
      });
      return () => view.destroy();
    }
    const view = new MergeView({
      a: { doc: before, extensions: readOnly(`「${name}」${beforeLabel}`) },
      b: { doc: after, extensions: readOnly(`「${name}」${afterLabel}`) },
      parent,
      gutter: false,
      collapseUnchanged: COLLAPSE,
      diffConfig: DIFF_CONFIG,
    });
    return () => view.destroy();
  }, [before, after, name, mode, beforeLabel, afterLabel]);
  return (
    <>
      {mode === 'split' && (
        <div className="sop-diff-cols" aria-hidden="true">
          <span>{beforeLabel}</span>
          <span>{afterLabel}</span>
        </div>
      )}
      <div ref={host} className={`sop-diff-view is-${mode}`} />
    </>
  );
}

/** 逐节改动的列表：每节一个标题行（节名、「+3行 −1行」）加差异 */
export function DiffList({ items, mode, labels }: { items: readonly SectionChange[]; mode: DiffMode; labels: readonly [string, string] }) {
  const id = useId();
  return (
    <div className="sop-diff">
      {items.map((c, i) => (
        <section key={c.key} className="sop-diff-item" aria-labelledby={`${id}-${i}`}>
          <div className="sop-diff-head">
            <h4 id={`${id}-${i}`} className="sop-diff-name">
              {cjk(c.name)}
            </h4>
            <span className="sop-diff-stat">{statText(lineStat(c.before, c.after))}</span>
          </div>
          <DiffView change={c} mode={mode} labels={labels} />
        </section>
      ))}
    </div>
  );
}

/** 行内 / 并排：打开时读一次存下的选择，换了就存 */
export function useDiffMode(): [DiffMode, (m: DiffMode) => void] {
  const [mode, setMode] = useState<DiffMode>(readDiffMode);
  return [
    mode,
    (m) => {
      setMode(m);
      writeDiffMode(m);
    },
  ];
}

const MODE_OPTIONS: { label: string; value: DiffMode }[] = [
  { label: '行内', value: 'inline' },
  { label: '并排', value: 'split' },
];

export function DiffModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (m: DiffMode) => void }) {
  return (
    <Segmented<DiffMode> className="sop-diff-mode" aria-label="改动的显示方式" options={MODE_OPTIONS} value={mode} onChange={onChange} />
  );
}
