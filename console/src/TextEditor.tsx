// CodeMirror 6 的最小包装：纯文本、自动换行、撤销历史。value 从外面变了（切换节、刷新）就整段替换
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { cspNonce } from './csp.js';

/** 外面换正文时打的标记：这种改动不是用户输入，不回调 onChange */
const external = Annotation.define<boolean>();

export function TextEditor(props: { value: string; onChange?: (value: string) => void; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChange = useRef(props.onChange);
  // 编辑器只在只读与否变了时重建，建的时候取最新的正文；之后正文的变化走最后一个 effect。
  // 这个 effect 排在建编辑器之前，同一次提交里先跑
  const latest = useRef(props.value);
  useEffect(() => {
    onChange.current = props.onChange;
    latest.current = props.value;
  });

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current,
        extensions: [
          ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!!props.readOnly),
          EditorView.editable.of(!props.readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) onChange.current?.(u.state.doc.toString());
          }),
          EditorView.theme({ '&': { border: '1px solid #d9d9d9', borderRadius: '6px' }, '.cm-content': { fontSize: '14px' } }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, [props.readOnly]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value }, annotations: external.of(true) });
    }
  }, [props.value]);

  return <div ref={host} />;
}
