// 固定前缀只拼 SOP 与包的固定要求，不读取本轮状态。
export function renderSystemPrompt(sop: string, hardRequirements: string): string {
  return [sop, '', hardRequirements].join('\n');
}
