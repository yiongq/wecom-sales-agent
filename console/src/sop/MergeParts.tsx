// 合并模式的部件（spec「销售话术 · 冲突合并」，样子沿用 B 页的中栏与设计系统 §5.1、§5.15、§6.5）：
// - MergeEditor：@codemirror/merge 的 MergeView。左边「线上v4的写法」只读（也能聚焦、选中复制），右边「你的草稿」可改；
//   revertControls 'a-to-b'：每块改动在两栏之间有一个 24 见方的图标按钮（arrow-right），读屏名称与悬停、聚焦时的提示都是
//   「采用线上的写法」（CodeMirror 的 phrases 汉化的那一句）。库只认 mousedown：键盘在按钮上按 Enter、空格，这里转成同一个
//   mousedown；采用以后这一块没了，焦点接到下一块的按钮上，后面没有了到右边的正文。
//   左右两边改到的行照「你没保存上的改动」的对比上色：左边 --subtle，右边 --accent-bg、改到的字下面一道 --accent。
// - MergePane：中栏，节标题（页面进合并、换到下一节时把焦点放在它上面）、说明行、两栏的名字、MergeEditor、
//   底部「这一节处理好了」（点过以后换成 success 的勾和同一句话）。
// - MergeActions：页头右侧「退出合并」与「完成合并」；还有没处理的节时「完成合并」是 aria-disabled，点了去第一个没处理的节。
// 合并期间每敲一个字页面都重渲：MergeEditor 只在节、线上版本换了时重建，右边的字不从属性往回灌
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { Button } from 'antd';
import { CircleCheck } from 'lucide-react';
import { __iconData as ARROW_RIGHT } from 'lucide-react/dist/esm/icons/arrow-right.mjs';
import { type Ref, useEffect, useId, useRef } from 'react';
import { cspNonce } from '../csp.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import { CM_PHRASES, lucideSvg } from './editor.js';
import { MINE_LABEL } from './merge.js';
import { DIFF_CONFIG } from './publish.js';
import { cmPhrases } from './SopEditor.js';

/** 两栏之间那个按钮的名字：CodeMirror 的「Revert this chunk」汉化成的那一句 */
export const REVERT_LABEL = CM_PHRASES['Revert this chunk']!;

/** 两栏之间的「采用线上的写法」：24 见方，16 的 arrow-right；提示是 CSS 画的（sop.css），字取 aria-label */
function revertButton(): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sop-merge-revert';
  b.setAttribute('aria-label', REVERT_LABEL);
  b.append(lucideSvg(ARROW_RIGHT, 16));
  return b;
}

/** 采用以后焦点去哪：同一个序号（后面的块往前挪了一个）或后面的按钮，都没有了就是最后一个按钮，再没有到右边的正文 */
function focusAfterRevert(view: MergeView, chunk: number): void {
  const buttons = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-merge-revert button[data-chunk]'));
  const next = buttons.find((x) => Number(x.dataset.chunk) >= chunk) ?? buttons.at(-1);
  (next ?? view.b.contentDOM).focus();
}

export interface MergeEditorProps {
  /** 节名：读屏名称写「「话术原则」线上v4的写法」「「话术原则」你的草稿」 */
  name: string;
  /** 左边那一栏的名字 */
  leftLabel: string;
  /** 线上那一版的正文 */
  left: string;
  /** 右边开始时的正文（之后由编辑器自己管，改了回调 onChange） */
  right: string;
  onChange: (text: string) => void;
}

export function MergeEditor({ name, leftLabel, left, right, onChange }: MergeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ right, onChange });
  useEffect(() => {
    latest.current = { right, onChange };
  });
  useEffect(() => {
    const base = [...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []), cmPhrases, EditorView.lineWrapping];
    const view = new MergeView({
      a: {
        doc: left,
        extensions: [
          ...base,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          // 只读的正文不可聚焦；放进 Tab 顺序，键盘也能进来读、选中复制（同固定规则节）
          EditorView.contentAttributes.of({ 'aria-label': `「${name}」${leftLabel}`, tabindex: '0' }),
        ],
      },
      b: {
        doc: latest.current.right,
        extensions: [
          ...base,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': `「${name}」${MINE_LABEL}` }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      },
      parent: host.current!,
      gutter: false,
      revertControls: 'a-to-b',
      renderRevertControl: revertButton,
      diffConfig: DIFF_CONFIG,
    });
    // 键盘：在按钮上按 Enter、空格。库只认 mousedown（鼠标点的 click 它不管，这里也不管），这里拦下按键的默认动作、转成同一个 mousedown
    const onKey = (e: KeyboardEvent): void => {
      const b = e.target instanceof Element ? e.target.closest<HTMLElement>('.cm-merge-revert button[data-chunk]') : null;
      if (!b || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      const chunk = Number(b.dataset.chunk);
      b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      // 按钮在下一帧按新的分块重画（库的 measure 也排在下一帧，先排的先跑）
      requestAnimationFrame(() => focusAfterRevert(view, chunk));
    };
    view.dom.addEventListener('keydown', onKey);
    return () => {
      view.dom.removeEventListener('keydown', onKey);
      view.destroy();
    };
  }, [name, leftLabel, left]);
  return (
    <>
      <div className="sop-merge-cols" aria-hidden="true">
        <span>{cjk(leftLabel)}</span>
        <span>{cjk(MINE_LABEL)}</span>
      </div>
      <div ref={host} className="sop-merge-view" />
    </>
  );
}

export interface MergePaneProps extends MergeEditorProps {
  /** 说明行的各段（merge.ts 的 mergeMeta） */
  meta: readonly string[];
  done: boolean;
  onDone: () => void;
  /** 节标题：页面进合并、换到下一节时把焦点放上去（不在 Tab 顺序里） */
  titleRef?: Ref<HTMLHeadingElement>;
}

export function MergePane({ meta, done, onDone, titleRef, ...editor }: MergePaneProps) {
  const titleId = useId();
  return (
    <section className="sop-pane sop-merge" aria-labelledby={titleId}>
      <h2 id={titleId} ref={titleRef} tabIndex={-1} className="sop-pane-title">
        {cjk(editor.name)}
      </h2>
      <p className="sop-pane-meta">{cjk(meta)}</p>
      <div className="sop-merge-card">
        <MergeEditor {...editor} />
      </div>
      <div className="sop-merge-foot">
        {done ? (
          <p className="sop-merge-done" role="status">
            <Icon of={CircleCheck} />
            <span>{cjk('这一节处理好了')}</span>
          </p>
        ) : (
          <Button onClick={onDone}>这一节处理好了</Button>
        )}
      </div>
    </section>
  );
}

export function MergeActions({
  blocked,
  busy,
  reasonId,
  finishRef,
  exitRef,
  onExit,
  onFinish,
}: {
  /** 还有没处理的节：「完成合并」aria-disabled，点了由页面去第一个没处理的节 */
  blocked: boolean;
  /** 完成合并的请求在路上 */
  busy: boolean;
  /** 原因写在状态句里（「还有2节要合并」）：「完成合并」的 aria-describedby 指向它 */
  reasonId: string;
  finishRef?: Ref<HTMLButtonElement>;
  /** 「退出合并」：退出的确认框「接着合并」以后焦点还给它 */
  exitRef?: Ref<HTMLButtonElement>;
  onExit: () => void;
  onFinish: () => void;
}) {
  return (
    <>
      <Button ref={exitRef} disabled={busy} onClick={onExit}>
        退出合并
      </Button>
      <PrimaryButton ref={finishRef} blocked={blocked} loading={busy} aria-describedby={blocked ? reasonId : undefined} onClick={onFinish}>
        完成合并
      </PrimaryButton>
    </>
  );
}
