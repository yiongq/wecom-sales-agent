// 07 R14 在引擎里的接线：本轮开始时捕获的已发布 policy 进了 contextNote；政策问法的轮没有工具调用和嵌入请求；
// 没有政策问法的轮 contextNote 里没有条款行；租户改了 policy.json，下一轮的条款跟着变。
// 模型是本机假服务，数据写进临时目录，全程不出本机。问法识别与条款取用的细节在 src/packs/travel/policy-ask.selftest.ts。
import './selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { TurnContext } from './core/pack-api.js';

const root = path.resolve(import.meta.dirname, '..');
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const varDir = fs.mkdtempSync(path.join(varParent, 'wecom-policy-ask-'));
process.env.VAR_DIR = varDir;
process.env.CONFIG_SOURCE = 'file';

interface WireMessage {
  role: string;
  content?: string;
}
const chatRequests: { messages: WireMessage[]; tools?: unknown[] }[] = [];
let embeddingRequests = 0;
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[]; messages?: WireMessage[] };
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      embeddingRequests += 1;
      res.end(
        JSON.stringify({
          data: (body.input ?? []).map(() => ({ embedding: Array.from({ length: 32 }, () => 1) })),
          usage: { prompt_tokens: 0 },
        }),
      );
      return;
    }
    chatRequests.push(body as (typeof chatRequests)[number]);
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '好的，我照条款给您说明。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.LLM_MOCK = '0';
process.env.LLM_PROVIDER = '';
process.env.LLM_BASE_URL = fakeUrl;
process.env.LLM_API_KEY = 'selftest-fake-key'; // gitleaks:allow
process.env.LLM_MODEL = 'selftest-fake';
process.env.EMBED_BASE_URL = fakeUrl;
process.env.EMBED_API_KEY = 'selftest-fake-key'; // gitleaks:allow
process.env.LLM_HEDGE_MODEL = '';
process.env.LLM_MAX_RETRY = '0';

// 租户的 SOP 目录：镜像 data/sop.md，policy.json 由各段自己写
const sopDir = path.join(varDir, 'sop');
fs.mkdirSync(sopDir);
fs.copyFileSync(path.join(root, 'data', 'sop.md'), path.join(sopDir, 'sop.md'));
process.env.SOP_PATH = path.join(sopDir, 'sop.md');
process.env.ROUTES_PATH = path.join(root, 'data', 'routes.json');

const { handleMessage } = await import('./engine.js');
const store = await import('./store.js');
const { createQuote } = await import('./tools.js');
const { currentPack, currentPolicy } = await import('./config/source.js');
const { defaultTravelPolicy } = await import('./packs/travel/policy.js');
const { todayIso } = await import('./env.js');

let seq = 0;
const newSid = (tag: string) => `wecom:selftest-policy-ask-${tag}-${Date.now().toString(36)}-${++seq}`;
const addDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** 发一句话，返回这一轮第一次模型请求里的 contextNote、模型请求数、嵌入请求数 */
async function say(sid: string, text: string) {
  const chatBefore = chatRequests.length;
  const embedBefore = embeddingRequests;
  const reply = await handleMessage(sid, text, 'simulator');
  const mine = chatRequests.slice(chatBefore);
  const note = mine[0]?.messages.find((m, i) => i > 0 && m.role === 'system' && m.content?.startsWith('【当前会话状态】'))?.content;
  return { reply, note, chats: mine, embeddings: embeddingRequests - embedBefore };
}
function paidOrder(sid: string, daysAhead: number): string {
  const session = store.getOrCreateSession(sid, 'simulator');
  const departDate = addDays(todayIso(), daysAhead);
  const q = createQuote({ routeId: 'r-yunnan-mid', travelers: 2, departDate });
  const order = store.createOrder({
    sessionId: sid,
    routeId: 'r-yunnan-mid',
    routeTitle: q.routeTitle,
    travelers: 2,
    departDate,
    totalPrice: q.total,
  });
  store.markOrderPaid(order.id);
  session.orderIds.push(order.id);
  store.saveSession(session);
  return order.id;
}

const CLAUSE_HEADER = '可引用的条款（照原文说，说到哪条就在句末写出处）：';
const DEFAULT_TIERS = [
  '（退改条款第1条）出发前30天及以上取消，退全款',
  '（退改条款第2条）出发前15–29天取消，退订单金额的80%',
  '（退改条款第3条）出发前7–14天取消，退订单金额的50%',
  '（退改条款第4条）出发前0–6天取消，不能自助退，由顾问为您处理',
  '（改期条款）出发前15天及以上可以改期一次，由顾问为您办理',
];
let passed = 0;
const ok = (cond: unknown, msg: string): void => {
  assert.ok(cond, msg);
  passed++;
};

// 验收 7 第一条：没有订单问「退改怎么算」——contextNote 有全部档位条款，没有嵌入请求，也没有工具调用
{
  const sid = newSid('no-order');
  const first = await say(sid, '想去西藏');
  ok(first.note, '有模型请求就有 contextNote');
  ok(!first.note!.includes('可引用的条款') && !first.note!.includes('您这张单'), '只说「想去西藏」：没有条款行（验收 7 最后一条）');
  const turn = await say(sid, '如果临时去不了，退改怎么算？');
  assert.equal(turn.chats.length, 1, '政策问法这一轮只有一次模型请求（没有工具往返）');
  assert.equal(turn.embeddings, 0, '政策问法这一轮没有嵌入请求');
  assert.equal((turn.chats[0]!.tools ?? []).length > 0, true, '工具定义照旧在请求里（前缀不变）');
  passed += 3;
  const lines = turn.note!.split('\n');
  const at = lines.indexOf(CLAUSE_HEADER);
  ok(at > 0, '条款并进同一条 contextNote，排在已有各行之后');
  assert.deepEqual(lines.slice(at), [CLAUSE_HEADER, ...DEFAULT_TIERS], '全部档位条款加改期条款，末尾没有别的');
  passed++;
  ok(
    lines.slice(0, at).every((l) => !l.startsWith('（')),
    '条款行之前的是已有各行',
  );
  ok(!turn.note!.includes('您这张单'), '没有订单：没有适用那一行');
  assert.equal(
    chatRequests.filter((r) => r.messages.filter((m) => m.role === 'system' && m.content?.startsWith('【当前会话状态】')).length > 1)
      .length,
    0,
    '条款没有新增一条 system 消息',
  );
  passed++;
  // 前缀：第一条 system 消息（提示词）不含条款，工具定义没有新增。能力边界节教出处格式时写的是「第N条」，不算条款
  ok(!/退改条款第\d+条/.test(turn.chats[0]!.messages[0]!.content!), '提示词前缀里没有条款');
}

// 有订单：订单行不变，适用那一行用本轮的 todayIso() 算天数；只给条款与天数，不给金额
{
  const sid = newSid('order');
  paidOrder(sid, 55);
  // 问规则（不是「这张单能退多少」）：已付款订单也走模型，R18 的自助退款只接具体的退款意图
  const turn = await say(sid, '退改规则怎么算');
  const lines = turn.note!.split('\n');
  ok(
    lines.some((l) => l.startsWith('订单: ')),
    '订单行还在',
  );
  ok(lines.findIndex((l) => l.startsWith('订单: ')) < lines.indexOf(CLAUSE_HEADER), '订单行在条款行之前（只追加）');
  assert.equal(lines.at(-1), '您这张单离出发55天，适用退改条款第1条');
  passed++;
  ok(!/¥|33,?600|30,?000/.test(turn.note!), '不给金额');
  const near = newSid('order-near');
  paidOrder(near, 6);
  assert.equal((await say(near, '改期的规则是什么')).note!.split('\n').at(-1), '您这张单离出发6天，适用退改条款第4条');
  passed++;
  // 保险、费用主题：一句口径，不带适用那一行
  const ins = (await say(sid, '这条线含保险吗')).note!.split('\n');
  assert.deepEqual(ins.slice(ins.indexOf(CLAUSE_HEADER)).length, 2, '保险主题只多两行：首行和一句口径');
  ok(!ins.join('\n').includes('您这张单'), '保险主题不标适用条款');
  passed++;
}

// 不是政策问法：有没有订单，contextNote 里都没有条款行
{
  const sid = newSid('plain');
  paidOrder(sid, 40);
  for (const t of ['想去西藏', '我想退款', '保险起见，先看看', '走路多不多', '谢谢']) {
    const turn = await say(sid, t);
    if (!turn.note) continue; // 确定性回复（转人工等）不发模型请求，没有 contextNote
    ok(!turn.note.includes('可引用的条款') && !turn.note.includes('您这张单'), `不是政策问法：「${t}」没有条款行`);
  }
}

// 引擎把本轮捕获的 policy 与 policyHash 交给包（同品牌的做法），整轮沿用
{
  const runtime = currentPack().runtime;
  const original = runtime.contextNote;
  const seen: TurnContext[] = [];
  runtime.contextNote = (ctx) => {
    seen.push(ctx);
    return original.call(runtime, ctx);
  };
  try {
    const turn = await say(newSid('ctx'), '退改怎么算');
    ok(turn.note?.includes(CLAUSE_HEADER), '换了壳的 contextNote 照常出条款');
    assert.equal(seen.length, 1, '一轮只取一次 contextNote');
    const snapshot = currentPolicy();
    assert.deepEqual(seen[0]!.policy, snapshot.policy);
    assert.equal(seen[0]!.policyHash, snapshot.policyHash);
    assert.deepEqual(seen[0]!.policy, defaultTravelPolicy, '没有 policy.json：包默认');
    passed += 3;
  } finally {
    runtime.contextNote = original;
  }
}

// 租户的 policy.json：条款、编号和适用条款都跟着本轮的快照走；下一轮改了文件，下一轮的条款就变
{
  const tenant = {
    ...defaultTravelPolicy,
    refund: {
      ...defaultTravelPolicy.refund,
      tiers: [
        { id: 'd30', minDays: 30, maxDays: null, percent: 100 },
        { id: 'd15', minDays: 15, maxDays: 29, percent: 80 },
        { id: 'd10', minDays: 10, maxDays: 14, percent: 60 },
        { id: 'd3', minDays: 3, maxDays: 9, percent: 30 },
      ],
    },
  };
  fs.writeFileSync(path.join(sopDir, 'policy.json'), JSON.stringify(tenant));
  const sid = newSid('tenant');
  paidOrder(sid, 12);
  const first = await say(sid, '退改怎么算');
  const lines = first.note!.split('\n');
  const at = lines.indexOf(CLAUSE_HEADER);
  assert.equal(lines[at + 3], '（退改条款第3条）出发前10–14天取消，退订单金额的60%');
  assert.equal(lines[at + 5], '（退改条款第5条）出发前0–2天取消，不能自助退，由顾问为您处理');
  assert.equal(lines.at(-1), '您这张单离出发12天，适用退改条款第3条');
  passed += 3;
  fs.writeFileSync(path.join(sopDir, 'policy.json'), JSON.stringify(defaultTravelPolicy));
  const second = await say(sid, '退改怎么算');
  const again = second.note!.split('\n');
  assert.deepEqual(again.slice(again.indexOf(CLAUSE_HEADER), -1), [CLAUSE_HEADER, ...DEFAULT_TIERS], '下一轮取到改回默认的快照');
  assert.equal(again.at(-1), '您这张单离出发12天，适用退改条款第3条');
  passed += 2;
}

fake.close();
fs.rmSync(varDir, { recursive: true, force: true });
console.log(`POLICY ASK ENGINE SELFTEST PASS: ${passed} 项断言全通`);
process.exit(0);
