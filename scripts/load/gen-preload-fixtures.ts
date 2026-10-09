// 压测第 25 步「预载」：生成 var/sessions.json、var/orders.json（R2：5,000 个会话、每个 300 条消息），
// 给 import-sessions CLI 导入真实 Postgres。只在压测脚本里用，不进 pnpm test。
// 用法：tsx scripts/load/gen-preload-fixtures.ts --sessions 5000 --messages 300 --out <var目录>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ChatMessage, Session } from '../../src/types.js';

const { values: a } = parseArgs({
  options: {
    sessions: { type: 'string' },
    messages: { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
});
const nSessions = Number(a.sessions ?? 5000);
const nMessages = Number(a.messages ?? 300);
const outDir = a.out;
if (!outDir) {
  console.error('缺少 --out <var目录>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// 会话 id 用短名：wecom: 之后一个「wm」+ 11 个十六进制字符（不到「十几个字符」的上限，CI 的内容黑名单只拦更长的）
const ALPHABET = '0123456789abcdef';
function shortSuffix(n: number): string {
  let s = '';
  let x = n;
  for (let i = 0; i < 11; i++) {
    s += ALPHABET[x % 16];
    x = Math.floor(x / 16) + i * 7 + 1; // 简单打散，避免连号
  }
  return s;
}

const now = Date.now();
const sessions: Session[] = [];
for (let i = 0; i < nSessions; i++) {
  const id = `wecom:wm${shortSuffix(i)}`;
  const createdAt = now - (nMessages + 10) * 60_000;
  const messages: ChatMessage[] = [];
  let at = createdAt;
  for (let j = 0; j < nMessages; j++) {
    at += 60_000;
    const customer = j % 2 === 0;
    messages.push({
      role: customer ? 'customer' : 'agent',
      content: customer ? `第 ${j + 1} 条客户消息：想了解一下行程安排` : `第 ${j + 1} 条回复：好的，马上为您安排`,
      at,
      ...(customer ? { sentAt: at - 500 } : {}),
    });
  }
  sessions.push({
    id,
    channel: 'wecom',
    stage: 'discovery',
    profile: {},
    messages,
    orderIds: [],
    handedOver: false,
    createdAt,
    updatedAt: at,
  });
}

fs.writeFileSync(path.join(outDir, 'sessions.json'), JSON.stringify(sessions, null, 2));
fs.writeFileSync(path.join(outDir, 'orders.json'), JSON.stringify([], null, 2));
console.log(`[gen-preload-fixtures] 写好 ${nSessions} 个会话、每个 ${nMessages} 条消息 → ${outDir}`);
