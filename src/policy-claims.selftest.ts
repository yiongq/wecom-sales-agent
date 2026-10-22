// 07 R22 在引擎里的接线：模型是本机假服务按脚本吐回复，看客户最终收到什么、后台记了几条「待顾问确认」备注、有没有转人工；
// 本轮捕获的已发布 policy（租户的 policy.json）是核对的依据。三条规则各自的正反例在 src/packs/travel/policy-claims.selftest.ts。
// 全程不出本机、不调真实模型，数据写进临时目录。
import './selftest-env.js'; // 必须第一个 import：把部署 profile 钉成 demo，本机 .env 进不来（见 selftest-env.ts）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const varParent = process.env.VAR_DIR ?? os.tmpdir();
fs.mkdirSync(varParent, { recursive: true });
const varDir = fs.mkdtempSync(path.join(varParent, 'wecom-policy-claims-'));
process.env.VAR_DIR = varDir;
process.env.CONFIG_SOURCE = 'file';

// ---------------- 本机假模型：每次请求从队列取一段回复 ----------------
const replies: string[] = [];
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] };
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      res.end(
        JSON.stringify({
          data: (body.input ?? []).map(() => ({ embedding: Array.from({ length: 32 }, () => 1) })),
          usage: { prompt_tokens: 0 },
        }),
      );
      return;
    }
    const content = replies.shift() ?? '（假模型脚本已耗尽）';
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
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

const sopDir = path.join(varDir, 'sop');
fs.mkdirSync(sopDir);
fs.copyFileSync(path.join(root, 'data', 'sop.md'), path.join(sopDir, 'sop.md'));
process.env.SOP_PATH = path.join(sopDir, 'sop.md');
process.env.ROUTES_PATH = path.join(root, 'data', 'routes.json');

const { defaultTravelPolicy } = await import('./packs/travel/policy.js');
const { INSURANCE_REPLY } = await import('./packs/travel/claim-words.js');
const { handleMessage } = await import('./engine.js');
const store = await import('./store.js');

const policy = defaultTravelPolicy;
const routes = JSON.parse(fs.readFileSync(process.env.ROUTES_PATH!, 'utf8')) as { id: string; title: string }[];
const xian = routes.find((r) => r.id === 'r-xian')!; // 含里有「全程旅行意外保险」；线路出处里原样出现它的标题
const T1 = '出发前30天及以上取消，退全款（退改条款第1条）';
const T2 = '出发前15–29天取消，退订单金额的80%（退改条款第2条）';
const T3 = '出发前7–14天取消，退订单金额的50%（退改条款第3条）';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------- 引擎里：客户最终收到什么、备注几条、转没转人工 ----------------
let seq = 0;
const newSid = (tag: string) => `wecom:selftest-policy-claims-${tag}-${Date.now().toString(36)}-${++seq}`;
async function say(sid: string, text: string, model: string) {
  replies.push(model);
  const r = await handleMessage(sid, text, 'simulator');
  const session = store.getSession(sid)!;
  const notes = session.messages.filter((m) => m.role === 'system').map((m) => m.content);
  return { r, session, notes };
}
const pendingNotes = (notes: string[]): string[] => notes.filter((n) => n.startsWith('待顾问'));

// 规则 1：脚本模型写「出发前 7 天也能全额退」→ 第3条原句；不转人工，不记备注（K18）
{
  const sid = newSid('refund');
  const { r, session, notes } = await say(sid, '万一临时去不了，退改怎么算？', '出发前 7 天也能全额退。');
  check('引擎：出发前 7 天也能全额退 → 第3条原句', r.text === `${T3}。`, r.text);
  check('引擎：不转人工、不记备注', !r.handoff && !session.handedOver && notes.length === 0, JSON.stringify(notes));
  const ok = await say(sid, '那 30 天以上呢', '出发前30天及以上取消，退全款。');
  check('引擎：写对了的只补出处', ok.r.text === `${T1}。`, ok.r.text);
}

// 规则 3：问「这条线含保险吗」，线路的「含」里没有保险，模型说「含的」
{
  const sid = newSid('insurance');
  const first = await say(sid, '贵州荔波那条线怎么样', '贵州荔波小七孔·西江千户苗寨 6 日，每人 12,800 元起，您几位出行？');
  check('引擎：先让贵州那条线出场', !first.r.handoff);
  const { r, session, notes } = await say(sid, '这条线含保险吗', '含的～');
  check('引擎：「含的」换成口径句', r.text === INSURANCE_REPLY, r.text);
  check('引擎：不转人工', !r.handoff && !session.handedOver);
  check(
    '引擎：恰好一条待顾问确认的备注，带着客户的问法',
    pendingNotes(notes).length === 1 && pendingNotes(notes)[0]!.startsWith('待顾问确认') && pendingNotes(notes)[0]!.includes('含保险吗'),
    JSON.stringify(notes),
  );
  check('引擎（K17）：回复与备注都不含「转接」「稍候」', !/转接|稍候/.test(r.text + notes.join()));
  // 同一条线：模型老老实实说没列
  const honest = await say(sid, '那保险呢，含不含', '费用说明里没有列保险，具体由顾问跟您确认。');
  check('引擎：本来就是口径的话原样留着', honest.r.text === '费用说明里没有列保险，具体由顾问跟您确认。', honest.r.text);
  check('引擎：一轮只记一条（备注总共两条，每轮一条）', pendingNotes(honest.notes).length === 2, JSON.stringify(honest.notes));
}
// 线路的「含」里有保险：说含是真话，只补出处
{
  const sid = newSid('insurance-ok');
  await say(sid, '西安兵马俑那条线怎么样', '西安 兵马俑·大唐不夜城 5 日，您几位出行？');
  const { r, notes } = await say(sid, '这条线含保险吗', '含的，全程旅行意外保险。');
  check('引擎：「含」里有保险，说含不换、补线路出处', r.text === `含的，全程旅行意外保险（《${xian.title}》费用说明）。`, r.text);
  check('引擎：没有待顾问备注', pendingNotes(notes).length === 0, JSON.stringify(notes));
}
// 不是政策问法：一个字不动（K20）
{
  const sid = newSid('plain');
  await say(sid, '贵州荔波那条线怎么样', '贵州荔波小七孔·西江千户苗寨 6 日，您几位出行？');
  const { r, notes } = await say(sid, '行，我再看看', '含保险的哦～');
  check(
    '引擎（K20）：不是政策问法，模型说什么就是什么',
    r.text.startsWith('含保险的哦～') && !r.text.includes(INSURANCE_REPLY) && notes.length === 0,
    `${r.text} ${JSON.stringify(notes)}`,
  );
}
// 否定说法（K14）
{
  const sid = newSid('negative');
  const { r, notes } = await say(sid, '瑞士那条费用含机票吗', '这条费用不含国际机票和签证。');
  check(
    '引擎（K14）：不含国际机票原样留着',
    r.text === '这条费用不含国际机票和签证。' && notes.length === 0,
    `${r.text} ${JSON.stringify(notes)}`,
  );
}
// 运行时只读本轮捕获的已发布 policy：租户的 policy.json 改了档位，下一轮的核对跟着变
{
  const tenant = {
    ...policy,
    refund: {
      ...policy.refund,
      tiers: [
        { id: 'd20', minDays: 20, maxDays: null, percent: 100 },
        { id: 'd10', minDays: 10, maxDays: 19, percent: 60 },
      ],
    },
  };
  fs.writeFileSync(path.join(sopDir, 'policy.json'), JSON.stringify(tenant));
  const sid = newSid('tenant');
  const a = await say(sid, '退改怎么算', '出发前25天取消，可以退全款。');
  check('引擎：租户 policy.json 的档位在本轮生效', a.r.text === '出发前25天取消，可以退全款（退改条款第1条）。', a.r.text);
  fs.writeFileSync(path.join(sopDir, 'policy.json'), JSON.stringify(policy));
  const b = await say(sid, '那取消的规则呢', '出发前25天取消，可以退全款。');
  check('引擎：改回默认，下一轮取到默认的档位（25 天在默认里是第2条 80%）', b.r.text === `${T2}。`, b.r.text);
}

fake.close();
fs.rmSync(varDir, { recursive: true, force: true });
if (failures.length) {
  console.error(`POLICY CLAIMS ENGINE SELFTEST FAIL: ${failures.length} 项\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
assert.ok(passed > 15);
console.log(
  `POLICY CLAIMS ENGINE SELFTEST PASS: ${passed} 项断言全通（换句 / 补出处 / 一轮一条待顾问确认备注 / 不转人工 / 否定句与非政策问法不动 / 租户 policy.json）`,
);
process.exit(0);
