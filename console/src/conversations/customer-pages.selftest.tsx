// 08 R12：按锁定套件相同正则抽取 fillPayCard；完整执行 pay.html，验证支付状态、重试、转义及旧 JSON 兼容。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';

const chat = fs.readFileSync('public/chat.html', 'utf8');
const fnSrc = /async function fillPayCard\(card, pay\) \{[\s\S]*?\n {2}\}/.exec(chat)?.[0];
assert.ok(fnSrc);
const display = {
  title: '合成方盒甲等2项',
  summary: '2项 · 共250件',
  totalFen: 133000,
  totalText: '1,330元',
  lines: [
    { title: '合成方盒甲', qtyText: '200件', unitPriceText: '3.65元/件', amountText: '730元', attrs: { 交期: '7天', 备注: '<img src=x>' } },
    { title: '合成方盒乙', qtyText: '50件', unitPriceText: '12元/件', amountText: '600元' },
  ],
};
for (const [status, want] of [
  ['pending_payment', '立即支付'],
  ['paid', '已支付 · 查看订单'],
  ['superseded', '已被新订单替代'],
  ['cancelled', '订单已取消'],
]) {
  const elements = new Map<string, { textContent: string; hidden: boolean; classList: { add: (s: string) => void } }>();
  const card = {
    querySelector(selector: string) {
      if (!elements.has(selector))
        elements.set(selector, {
          textContent: selector === '.pc-btn' ? '立即支付' : selector === '.pc-head' ? '云途定制旅行 · 订单' : '',
          hidden: true,
          classList: { add() {} },
        });
      return elements.get(selector)!;
    },
  };
  const fetch = async () => ({ ok: true, json: async () => ({ status, display, payable: status === 'pending_payment' }) });
  // 仅注入 fetch 与 cnDate，分支不能依赖函数外新增的标识符或 DOM API。
  const fill = new Function('fetch', 'cnDate', `${fnSrc}; return fillPayCard;`)(fetch, (d: string) => d);
  await fill(card, { orderId: 'ord_pages' });
  assert.equal(card.querySelector('.pc-title').textContent, display.title);
  assert.equal(card.querySelector('.pc-head').textContent, '订单');
  assert.ok(card.querySelector('.pc-trip').textContent.includes('交期：7天'));
  assert.ok(card.querySelector('.pc-trip').textContent.includes('备注：<img src=x>'));
  assert.equal(card.querySelector('.pc-num').textContent, '1,330元');
  assert.equal(card.querySelector('.pc-cur').hidden, true);
  assert.equal(card.querySelector('.pc-btn').textContent, want);
  const text = [...elements.values()].map((e) => e.textContent).join('');
  for (const line of display.lines)
    for (const value of [line.title, line.qtyText, line.unitPriceText, line.amountText]) assert.ok(text.includes(value));
  assert.doesNotMatch(text, /出行|出发|线路|¥|NaN|undefined/);
}
console.log('CUSTOMER PAGES PASS：fillPayCard 同锁定正则、仅 fetch/cnDate 桩下渲染通用明细与四种状态');

const html = fs.readFileSync('public/pay.html', 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(script);
assert.match(html, /order\.status === 'superseded'[\s\S]{0,200}show\('err'\)/);
function element(page: Window, id: string) {
  const node = page.document.getElementById(id);
  assert.ok(node instanceof page.HTMLElement);
  return node;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
async function mount(initial: object, options: { advisor?: boolean; failed?: boolean; conflict?: boolean } = {}) {
  const page = new Window({ url: 'http://localhost/pay/ord_pages' });
  page.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ''));
  if (options.advisor) {
    const meta = page.document.createElement('meta');
    meta.name = 'payment-mode';
    meta.content = 'advisor';
    page.document.head.append(meta);
  }
  let posts = 0;
  const alerts: string[] = [];
  const fetch = async (_url: string, init?: { method?: string }) => {
    if (init?.method !== 'POST') return { ok: true, json: async () => initial };
    posts++;
    if (options.failed && posts === 1) return { ok: false, status: 503 };
    const status = options.conflict ? 'superseded' : 'paid';
    return {
      ok: !options.conflict,
      status: options.conflict ? 409 : 200,
      json: async () => ({ order: { ...initial, status, payable: false } }),
    };
  };
  const context = {
    document: page.document,
    window: page,
    location: page.location,
    navigator: page.navigator,
    history: page.history,
    URLSearchParams,
    fetch,
    alert: (s: string) => alerts.push(s),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    requestAnimationFrame() {},
    console,
  };
  vm.runInNewContext(script!, context);
  await pause();
  await pause();
  return {
    page,
    alerts,
    posts: () => posts,
    async click() {
      const button = page.document.querySelector('#payView button');
      assert.ok(button);
      (button as unknown as { click(): void }).click();
      await pause();
      await pause();
    },
    async close() {
      await page.happyDOM.close();
    },
  };
}
const initial = { id: 'ord_pages', status: 'pending_payment', display, payable: true };
{
  const m = await mount(initial, { failed: true });
  try {
    const view = element(m.page, 'payView');
    assert.equal(view.style.display, 'block');
    for (const line of display.lines)
      for (const value of [line.title, line.qtyText, line.unitPriceText, line.amountText]) assert.ok(view.textContent.includes(value));
    assert.doesNotMatch(view.textContent, /出行|出发|线路|¥|NaN|undefined/);
    assert.ok(view.textContent.includes('交期：7天'));
    assert.ok(view.textContent.includes('备注：<img src=x>'));
    assert.equal(view.querySelector('img'), null);
    assert.ok(view.querySelector('small'));
    await m.click();
    assert.equal(m.posts(), 1);
    assert.equal(m.alerts.length, 1);
    assert.equal(view.querySelector('button')!.disabled, false);
    assert.equal(view.querySelector('button')!.textContent, '支付1,330元');
    await m.click();
    assert.equal(m.posts(), 2);
    const success = element(m.page, 'successView');
    assert.equal(success.style.display, 'block');
    assert.ok(success.textContent.includes('1,330元'));
    assert.doesNotMatch(success.textContent, /行程|出行|出发|线路|¥|NaN|undefined/);
  } finally {
    await m.close();
  }
}
for (const status of ['superseded', 'cancelled', 'paid']) {
  const m = await mount({ ...initial, status, payable: false });
  try {
    assert.equal(element(m.page, status === 'paid' ? 'successView' : 'errView').style.display, 'block');
  } finally {
    await m.close();
  }
}
for (const advisor of [false, true]) {
  const m = await mount({ ...initial, payable: false }, { advisor });
  try {
    const view = element(m.page, 'payView');
    assert.equal(view.querySelector('button'), null);
    assert.ok(view.textContent.includes('请在会话里与顾问核对付款方式'));
  } finally {
    await m.close();
  }
}
{
  const m = await mount(initial, { conflict: true });
  try {
    await m.click();
    assert.equal(element(m.page, 'errView').style.display, 'block');
    assert.ok(element(m.page, 'errView').textContent.includes('已被新订单替代'));
  } finally {
    await m.close();
  }
}
{
  const m = await mount({ ...initial, display: { ...display, lines: [{ ...display.lines[0], title: '<img src=x onerror=alert(1)>' }] } });
  try {
    assert.equal(m.page.document.querySelector('#payView img'), null);
    assert.ok(element(m.page, 'payView').textContent.includes('<img src=x onerror=alert(1)>'));
  } finally {
    await m.close();
  }
}
for (const advisor of [false, true]) {
  const m = await mount(
    { id: 'ord_pages', status: 'pending_payment', totalPrice: 33600, routeTitle: '合成旅游', travelers: 2, departDate: '2026-12-10' },
    { advisor },
  );
  try {
    const prefix = advisor ? 'a' : '';
    assert.equal(element(m.page, advisor ? 'aAmount' : 'amount').textContent, '33,600.00');
    assert.equal(element(m.page, advisor ? 'aRouteTitle' : 'routeTitle').textContent, '合成旅游');
    assert.equal(element(m.page, advisor ? 'aTravelers' : 'travelers').textContent, '2 人');
    assert.equal(element(m.page, advisor ? 'aDepartDate' : 'departDate').textContent, '2026-12-10');
    assert.equal(element(m.page, prefix ? 'advisorView' : 'payView').style.display, 'block');
  } finally {
    await m.close();
  }
}
console.log('CUSTOMER PAGES PASS：完整支付页多行、状态、顾问模式、失败重试与409、动态文字安全；无 display 的旅游 JSON 保持原样');
