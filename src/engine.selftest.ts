// 引擎离线自测：LLM_MOCK=1 下跑「问需→推荐→报价→下单→支付跟进」+ 转人工。
// 数据全部写进临时目录（VAR_DIR 覆盖），跑多少遍都不会污染真实 var/ 与后台看板。
// 用法：npx tsx src/engine.selftest.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const root = process.cwd();
const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-selftest-'));
process.env.VAR_DIR = varDir; // store/wecom 均在（动态 import 后的）模块加载时读取

process.env.LLM_MOCK = '1';

if (!fs.existsSync(path.join(root, 'data', 'routes.json'))) {
  const fixture = path.join(varDir, 'routes.fixture.json');
  fs.writeFileSync(
    fixture,
    JSON.stringify(
      [
        {
          id: 'r-maldives-fixture',
          title: '马尔代夫沃木里瑞吉 6 日蜜月之旅',
          destination: '马尔代夫',
          days: 6,
          priceFrom: 32000,
          hotelLevel: '奢华度假村',
          bestSeason: '11月-次年4月',
          highlights: ['瑞吉水上别墅', '专属管家服务', '双人日落巡航'],
          tags: ['蜜月', '海岛'],
        },
        {
          id: 'r-swiss-fixture',
          title: '瑞士少女峰湖光山色 8 日',
          destination: '瑞士',
          days: 8,
          priceFrom: 45000,
          hotelLevel: '五星湖景酒店',
          bestSeason: '6-9月',
          highlights: ['少女峰观景火车', '琉森湖游船', '米其林晚宴'],
          tags: ['蜜月', '自然'],
        },
      ],
      null,
      2,
    ),
  );
  process.env.ROUTES_PATH = fixture;
  console.log('[selftest] data/routes.json 缺失，使用 fixture:', fixture);
}

if (!fs.existsSync(path.join(root, 'data', 'sop.md'))) {
  const fixture = path.join(varDir, 'sop.fixture.md');
  fs.writeFileSync(
    fixture,
    '# 销售 SOP（selftest fixture）\n一次只问 1-2 个问题；报价必须来自工具；客户要求人工时转接。\n',
  );
  process.env.SOP_PATH = fixture;
  console.log('[selftest] data/sop.md 缺失，使用 fixture:', fixture);
}

// env 就绪后再加载引擎（引擎均为调用时读 env，动态 import 双保险）
const { handleMessage, notifyPaid, historyWindow } = await import('./engine.js');
const { markOrderPaid, getSession } = await import('./store.js');

const sid = 'selftest-' + Date.now();
const say = async (text: string) => {
  const r = await handleMessage(sid, text, 'simulator');
  console.log(`\n>> ${text}\n<< [${r.stage}]${r.orderId ? ' order=' + r.orderId : ''} ${r.text}`);
  return r;
};

const r1 = await say('你好');
assert.equal(r1.stage, 'discovery', '第 1 轮应进入 discovery');

const r2 = await say('想去马尔代夫蜜月');
assert.equal(r2.stage, 'recommend', '第 2 轮应进入 recommend');

const r3 = await say('两个人，预算每人3万');
assert.equal(r3.stage, 'quote', '第 3 轮应进入 quote');

const r4 = await say('就订这个');
assert.equal(r4.stage, 'closing', '第 4 轮应进入 closing');
assert.ok(r4.orderId, '第 4 轮应携带 orderId');
assert.ok(r4.text.includes('/pay/' + r4.orderId), '回复应含相对 payUrl');

const s = getSession(sid);
assert.ok(s, 'session 应存在');
assert.equal(s.profile.destinationInterest, '马尔代夫', '画像应沉淀目的地');
assert.equal(s.profile.travelers, '2人', '画像应沉淀人数');

// 重复下单防护：同参数再触发 create_order 应复用待支付原单，而不是再建一单
const r5 = await say('就订这个');
assert.equal(getSession(sid)!.orderIds.length, 1, '重复下单指令不应新建订单');
assert.ok(r5.text.includes('/pay/' + r4.orderId), '应复用原订单的支付链接');

assert.ok(markOrderPaid(r4.orderId!), '订单应可标记已支付');
const paid = await notifyPaid(r4.orderId!);
assert.ok(paid, 'notifyPaid 应返回跟进消息');
console.log(`\n[paid push -> ${paid!.sessionId}] ${paid!.text}`);
assert.equal(getSession(sid)!.stage, 'paid', '支付后 stage 应为 paid');

// 转人工分支
const sid2 = sid + '-handoff';
const h1 = await handleMessage(sid2, '转人工，我要投诉', 'simulator');
assert.equal(h1.stage, 'handoff');
assert.equal(h1.handoff, true);
const h2 = await handleMessage(sid2, '在吗', 'simulator');
assert.equal(h2.stage, 'handoff', '已转人工的会话不再走 LLM');

// ---------- 历史窗口按块推进（前缀缓存的前提）----------
// 这几条断言钉的是「起点在块内不动」。改成 slice(-30) 一样能跑通全流程、一样不报错，
// 只是长会话每轮多付一遍历史的钱——没有断言就永远不会有人发现它被改回去了。
{
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => i);
  assert.deepEqual(historyWindow(msgs(30)), msgs(30), '未超上限时应原样返回');
  assert.deepEqual(historyWindow(msgs(5)), msgs(5), '短会话应原样返回');

  let starts = 0;
  // 拿第一个窗口的起点做基准，否则「从无到有」会被算成一次移动
  let prevStart = historyWindow(msgs(31))[0] as number;
  for (let n = 31; n <= 120; n++) {
    const w = historyWindow(msgs(n));
    assert.ok(w.length >= 30 && w.length <= 39, `窗口长度应在 30~39（n=${n} 实际 ${w.length}）`);
    assert.equal(w[w.length - 1], n - 1, `最新一条永远不能被丢掉（n=${n}）`);
    if (w[0] !== prevStart) { starts += 1; prevStart = w[0] as number; }
  }
  // 90 轮里起点只该动 9 次（每 10 轮一次）。逐条滑动的话这里会是 90。
  assert.equal(starts, 9, `起点应每 10 轮才移动一次，实际移动了 ${starts} 次`);
}

console.log('SELFTEST PASS: 历史窗口按块推进（90 轮内起点仅移动 9 次，缓存前缀稳定）');
console.log('\nSELFTEST PASS: greeting→discovery→recommend→quote→closing→paid + handoff 全通');
