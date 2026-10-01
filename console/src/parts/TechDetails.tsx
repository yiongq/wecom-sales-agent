// 技术详情（spec「通用部件」、不变量 7、8）：默认折叠的「技术详情」，是 console 里唯一读取服务端 detail、显示机器码、
// 哈希、动作编码和 JSON 原文的地方（scripts/check-console-src.ts 查：别的文件读 .detail 都算违规）。
// 用原生 <details>：键盘可达、展开 0ms，折叠时里面的字不算页面上的可见文字
import { RightOutlined } from '@ant-design/icons';
import { type RefObject, useRef, useState } from 'react';
import type { ApiError, ContractViolation } from '../../../src/shared/console-api.js';
import { HttpError } from '../api.js';

export interface TechDetailsProps {
  /** 出错时的原始错误：HttpError 列出状态码、机器码、服务端 detail 与逐条问题；其余错误列出类型与消息 */
  error?: unknown;
  /** 话术检查的原始违规：机器码、节、服务端 detail */
  violations?: readonly ContractViolation[];
  /** 其余原文：哈希、编号这类「名称 值」 */
  rows?: readonly (readonly [string, string])[];
  /** JSON 原文 */
  json?: unknown;
  /** 给了就在原文下面放一个「复制」按钮，复制这段字（审计详情抽屉：spec「审计日志 · 详情抽屉」） */
  copy?: string;
}

function errorLines(e: unknown): string[] {
  if (e instanceof HttpError) {
    const b: ApiError = e.body;
    return [
      `HTTP ${e.status} · ${b.error}`,
      ...(b.detail ? [b.detail] : []),
      ...(b.issues ?? []).map((i) => `${i.path || '（整条）'}：${i.message}`),
      ...(b.fields?.length ? [`fields: ${b.fields.join(', ')}`] : []),
      ...(b.keys?.length ? [`keys: ${b.keys.join(', ')}`] : []),
      ...(b.rows ?? []).flatMap((r) => r.issues.map((i) => `#${r.row} ${i.path}：${i.message}`)),
      ...(b.violations ?? []).map(violationLine),
    ];
  }
  if (e instanceof Error) return [`${e.name}: ${e.message}`];
  return e === undefined || e === null ? [] : [String(e)];
}

const violationLine = (v: ContractViolation): string => `${v.code} · ${v.sectionKey ?? '—'} · ${v.detail}`;

export function techLines(p: TechDetailsProps): string[] {
  return [
    ...errorLines(p.error),
    ...(p.violations ?? []).map(violationLine),
    ...(p.rows ?? []).map(([k, v]) => `${k} ${v}`),
    ...(p.json === undefined ? [] : [JSON.stringify(p.json, null, 2)]),
  ];
}

/**
 * 复制原文。剪贴板不可用（非 https、浏览器拒绝）时不报错：选中原文，按钮改写成「已选中，手动复制」，
 * 用户自己按复制键。复制成功时按钮写「已复制」，不弹 toast（技术详情里的小动作）
 */
function CopyButton({ text, target }: { text: string; target: RefObject<HTMLPreElement | null> }) {
  const [done, setDone] = useState<'copied' | 'selected' | null>(null);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setDone('copied');
    } catch {
      const pre = target.current;
      if (pre) window.getSelection()?.selectAllChildren(pre);
      setDone('selected');
    }
  };
  return (
    <button type="button" className="tech-details-copy" onClick={() => void copy()} aria-live="polite">
      {done === 'copied' ? '已复制' : done === 'selected' ? '已选中，手动复制' : '复制'}
    </button>
  );
}

export function TechDetails(props: TechDetailsProps) {
  const pre = useRef<HTMLPreElement>(null);
  const lines = techLines(props);
  if (!lines.length) return null;
  return (
    <details className="tech-details">
      <summary>
        <RightOutlined className="tech-details-chevron" aria-hidden="true" />
        技术详情
      </summary>
      <pre ref={pre} className="tech-details-body">
        {lines.join('\n')}
      </pre>
      {props.copy !== undefined && <CopyButton text={props.copy} target={pre} />}
    </details>
  );
}
