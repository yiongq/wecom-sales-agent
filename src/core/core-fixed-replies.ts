// 06 R21：核心自己发的对客固定文字。它们不属于任何行业包，不经 PackRuntime 登记，由 consistency.selftest 一起查。
import { EMERGENCY_REPLY } from './engine/index.js';
import { TOOL_LOOP_FALLBACK } from './llm/client.js';
import { FIXED_REPLY_MODES, type FixedReply } from './consistency.js';

const same = (text: string) => FIXED_REPLY_MODES.map((mode) => ({ mode, text }));

export const CORE_FIXED_REPLIES: readonly FixedReply[] = Object.freeze([
  {
    id: 'core.emergency',
    source: 'src/core/engine/index.ts',
    kind: 'plain',
    afterHandoff: true,
    producedBy: { outside: '紧急情况的确定性应急回复，模型前直发（core/engine 的确定性转人工触发），不经出口护栏' },
    samples: () => same(EMERGENCY_REPLY),
  },
  {
    id: 'core.tool-loop-fallback',
    source: 'src/core/llm/client.ts',
    kind: 'plain',
    // 当作模型原文，从管线开头起穿过全部步骤
    producedBy: { pipeline: 'reply', step: null },
    samples: () => same(TOOL_LOOP_FALLBACK),
  },
] satisfies FixedReply[]);
