// 话术页的中栏（spec「销售话术 · 编辑器」，设计系统 B 页）：节标题 16/24/600，下一行 13 text-2 写「可编辑 · 910 → 954字（+44）」，
// 固定规则节换成「固定规则 · {lockReason}。这里改不了，要改请联系技术。」；下面是编辑卡片（§5.9，内边距 24），正文见 editor.ts。
// SopEditor 是 CodeMirror 的包装：value 从外面变了（换节、刷新）就整段替换，这种替换不回调 onChange；
// 只读与否、节名变了才重建编辑器；线上的正文与行业包的词汇变了只换对应的那一块，不重建（光标和撤销历史都在）。
// 检查出的问题（第 6.2 步）：这一节正文里的波浪线与行内提醒经 problems 给（换了才派一次 setProblems，不重建）；
// 点「改成…」替换以后回调 onChange，再回调 onFix（页面马上保存）。没有行内提醒的几类问题写在编辑卡片上方（notes）。
// 话术页每敲一个字整页重渲，这里没有弹层（Tooltip、下拉、Portal），逐字重渲不碰它们（第 5.1 步 #185 的教训）
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { CircleAlert, Lock } from 'lucide-react';
import { type Ref, useEffect, useId, useRef } from 'react';
import { cspNonce } from '../csp.js';
import { Icon } from '../shell/icons.js';
import { cjk } from '../typography.js';
import {
  CM_PHRASES,
  problemFix,
  problemsField,
  setBaseline,
  setProblems,
  sopEditorSetup,
  type Vocabulary,
  vocabularyFacet,
  vocabularySlot,
} from './editor.js';
import { lockLine, type OutlineRow, sectionMeta } from './outline.js';
import type { EditorProblem } from './problems.js';

/** 外面换正文时打的标记：这种改动不是用户输入，不回调 onChange */
const external = Annotation.define<boolean>();

/** 编辑器与差异视图共用的内置文案（CodeMirror 的 phrases） */
export const cmPhrases = EditorState.phrases.of(CM_PHRASES);

export interface SopEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** 节名，正文的 aria-label 写「「话术原则」正文」 */
  name: string;
  /** 线上版本这一节的正文：相对它改过的段落画沟槽竖条、新加的文字标底色。不给就不标 */
  baseline?: string;
  /** 行业包的词汇：工具名与字段名显示成芯片。不给就都照原文显示 */
  vocabulary?: Vocabulary;
  /** 最近一次检查在这一节报的问题：波浪线与行内提醒。引用变了才重算 */
  problems?: readonly EditorProblem[];
  /** 点了行内提醒的「改成…」（onChange 之后）：页面马上保存 */
  onFix?: () => void;
}

export function SopEditor(props: SopEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // 建编辑器时取最新的属性；这个 effect 排在建编辑器之前，同一次提交里先跑
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const { readOnly = false, name } = props;
  useEffect(() => {
    const p = latest.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
          cmPhrases,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          // 只读时 CodeMirror 的正文不可聚焦；加进 Tab 顺序，键盘也能进来读、选中复制（话术目录按 Enter 进的就是它）
          EditorView.contentAttributes.of({ 'aria-label': `「${name}」正文`, ...(readOnly ? { tabindex: '0' } : {}) }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((t) => t.annotation(external))) return;
            latest.current.onChange?.(u.state.doc.toString());
            if (u.transactions.some((t) => t.annotation(problemFix))) latest.current.onFix?.();
          }),
          sopEditorSetup({ vocabulary: p.vocabulary, baseline: p.baseline ?? null, problems: p.problems }),
        ],
      }),
    });
    view.current = v;
    return () => {
      view.current = null;
      v.destroy();
    };
  }, [readOnly, name]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value }, annotations: external.of(true) });
    }
  }, [props.value]);

  const { baseline, vocabulary } = props;
  useEffect(() => {
    view.current?.dispatch({ effects: setBaseline.of(baseline ?? null) });
  }, [baseline]);
  useEffect(() => {
    const v = view.current;
    if (v && v.state.facet(vocabularyFacet) !== vocabulary && vocabulary)
      v.dispatch({ effects: vocabularySlot.reconfigure(vocabularyFacet.of(vocabulary)) });
  }, [vocabulary]);
  const { problems } = props;
  useEffect(() => {
    const v = view.current;
    const next = problems ?? NO_PROBLEMS;
    if (v && v.state.field(problemsField).problems !== next) v.dispatch({ effects: setProblems.of(next) });
  }, [problems]);

  return <div ref={host} className="sop-editor-host" />;
}

const NO_PROBLEMS: readonly EditorProblem[] = [];

/** 容器里的编辑器（话术页的中栏只有一个） */
export function editorIn(el: HTMLElement | null): EditorView | null {
  const content = el?.querySelector<HTMLElement>('.cm-content');
  return content ? EditorView.findFromDOM(content) : null;
}

/** 容器里的编辑器正在用输入法组字（文档里是还没上屏的拼音）：自动保存这时不存 */
export function composingIn(el: HTMLElement | null): boolean {
  return !!editorIn(el)?.composing;
}

/**
 * 中栏：节标题、说明行、编辑卡片。who：editor 能改（说明行以「可编辑」开头），reader 是只读的成员，anon 是匿名（可编辑节没有说明行）。
 * frozen：能改的人也暂时改不了（自动保存收到 409、停住的时候），说明行照旧。
 * notes：这一节没有行内提醒的问题（结构、固定规则、必需说法、禁用短语的说明），写在编辑卡片上方，样子同行内提醒（§5.12）；
 * notesRef 给页面定位时滚过去
 */
export function SectionPane({
  row,
  who,
  frozen = false,
  notes,
  notesRef,
  ...editor
}: Omit<SopEditorProps, 'name' | 'readOnly'> & {
  row: OutlineRow;
  who: 'editor' | 'reader' | 'anon';
  frozen?: boolean;
  notes?: readonly string[];
  notesRef?: Ref<HTMLUListElement>;
}) {
  const titleId = useId();
  const meta = row.locked ? null : sectionMeta(row, who);
  return (
    <section className="sop-pane" aria-labelledby={titleId}>
      <h2 id={titleId} className="sop-pane-title">
        {cjk(row.name)}
      </h2>
      {row.locked ? (
        <p className="sop-pane-lock">
          <Icon of={Lock} size={14} />
          <span>{cjk(lockLine(row))}</span>
        </p>
      ) : (
        meta && <p className="sop-pane-meta">{cjk(meta)}</p>
      )}
      {notes && notes.length > 0 && (
        <ul ref={notesRef} className="sop-notes" aria-label="这一节的问题">
          {notes.map((t) => (
            <li key={t} className="sop-note">
              <Icon of={CircleAlert} size={14} />
              <span>{cjk(t)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="sop-editor-card">
        <SopEditor {...editor} name={row.name} readOnly={row.locked || who !== 'editor' || frozen} />
      </div>
    </section>
  );
}
