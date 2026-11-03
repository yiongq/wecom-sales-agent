// 手册小节的纯逻辑（17 spec R9）：不依赖 React，runbook.selftest.ts 直接 import。
export type RunbookBlock = { kind: 'heading' | 'text' | 'code'; text: string };

/** 小节标题由页头显示，这里跳过；### 是小标题，``` 之间是代码，其余按空行分段 */
export function runbookBlocks(body: string): RunbookBlock[] {
  const blocks: RunbookBlock[] = [];
  let code: string[] | null = null;
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) blocks.push({ kind: 'text', text: para.join('') });
    para = [];
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      flush();
      if (code) blocks.push({ kind: 'code', text: code.join('\n') });
      code = code ? null : [];
    } else if (code) code.push(line);
    else if (line.startsWith('## ')) continue;
    else if (line.startsWith('### ')) {
      flush();
      blocks.push({ kind: 'heading', text: line.slice(4).trim() });
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
