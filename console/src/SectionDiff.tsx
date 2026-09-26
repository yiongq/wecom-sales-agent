// 一节的前后对比（spec「后台 API 与页面 · SOP」：草稿和已发布版本的逐节 diff 用 @codemirror/merge）。
// 两侧都只读、自动换行，没改的长段落折叠起来
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Col, Row, Typography } from 'antd';
import { useEffect, useRef } from 'react';
import { cspNonce } from './csp.js';

export function SectionDiff(props: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const readOnly = [
      ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({ '.cm-content': { fontSize: '14px' } }),
    ];
    const view = new MergeView({
      a: { doc: props.before, extensions: readOnly },
      b: { doc: props.after, extensions: readOnly },
      parent: host.current!,
      collapseUnchanged: { margin: 2, minSize: 6 },
    });
    return () => view.destroy();
  }, [props.before, props.after]);
  return (
    <div>
      <Row>
        <Col span={12}>
          <Typography.Text type="secondary">{props.beforeLabel}</Typography.Text>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">{props.afterLabel}</Typography.Text>
        </Col>
      </Row>
      <div ref={host} style={{ border: '1px solid #d9d9d9', borderRadius: 6 }} />
    </div>
  );
}
