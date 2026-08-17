// 中文话术夹带英文的出口护栏自测。
// 这条护栏的风险全在「误伤」上：产品库里全是酒店品牌英文（Four Seasons /
// Soneva Jani / Aman / Park Hyatt / One&Only…），替错了比不替更糟——
// 客户会看到「Four 季节」这种东西。所以品牌名的断言比替换本身的断言更重要。
import { __engineTest } from './engine.js';
import { loadRoutes } from './tools.js';

const { dejargon } = __engineTest;
const S = 'selftest';

let pass = 0;
const fails: string[] = [];
function eq(name: string, got: string, want: string): void {
  if (got === want) pass += 1;
  else fails.push(`${name}\n      得到: ${got}\n      期望: ${want}`);
}
function unchanged(name: string, text: string): void {
  const got = dejargon(text, S);
  if (got === text) pass += 1;
  else fails.push(`${name}（不该改动却被改了）\n      得到: ${got}\n      原文: ${text}`);
}

// ---------------- 该替换的：孤立嵌在中文里的商务英文 ----------------
eq('availability', dejargon('我按日期帮您确认 availability 和准确报价。', S),
  '我按日期帮您确认 档期 和准确报价。');
eq('budget', dejargon('您的 budget 大概多少？', S), '您的 预算 大概多少？');
eq('大小写不敏感', dejargon('这个 Package 含接送', S), '这个 套餐 含接送');
eq('紧贴中文无空格', dejargon('确认档期后我发您option两条', S), '确认档期后我发您选择两条');
eq('句首', dejargon('Confirm 一下出发日期', S), '确认 一下出发日期');
eq('多个词', dejargon('先看 options，再定 price', S), '先看 选择，再定 价格');

// ---------------- 绝不能碰的：产品库里的酒店/线路品牌名 ----------------
{
  // 从真实产品库里把所有含英文的名称捞出来逐一验证
  const names: string[] = [];
  for (const r of loadRoutes()) {
    for (const d of r.itinerary ?? []) {
      if (d.hotel && /[A-Za-z]{2,}/.test(d.hotel)) names.push(d.hotel);
    }
    if (/[A-Za-z]{2,}/.test(r.title)) names.push(r.title);
  }
  const uniq = [...new Set(names)];
  let hurt = 0;
  for (const n of uniq) {
    const sentence = `今晚住 ${n}，含双早。`;
    if (dejargon(sentence, S) !== sentence) {
      hurt += 1;
      if (fails.length < 6) fails.push(`产品库名称被误伤: ${n} → ${dejargon(sentence, S)}`);
    }
  }
  if (!hurt) pass += 1;
  console.log(`  产品库含英文的名称共 ${uniq.length} 条，误伤 ${hurt} 条`);
}

unchanged('多词品牌名 Four Seasons', '入住 Four Seasons Resort Bali at Sayan，推窗是雨林。');
unchanged('多词品牌名 Soneva Jani', '住 Soneva Jani Barefoot Retreat，滑梯直接下海。');
unchanged('单词品牌名 Aman', '北京住 Aman 颐和安缦，专属侧门进园。');
unchanged('可接受缩写 SPA/VIP', '含 SPA 一次，VIP 通道进场。');
unchanged('可接受缩写 AI', '我是云途定制旅行的 AI 旅行顾问。');
unchanged('纯中文不动', '您好，想去哪儿玩呢？我帮您看看线路。');

// ---------------- 链接里的英文不能被替换 ----------------
{
  const t = '方案书在这 /proposal/r-guizhou/2 点开看逐日行程';
  unchanged('方案书链接原样保留', t);
}
{
  const t = '付款链接：/pay/ord_08b08606 名额以付款为准';
  unchanged('支付链接原样保留', t);
}
{
  // 链接 + 夹带词同时出现：链接不动，夹带词要替
  const got = dejargon('方案在这 /proposal/r-guizhou/2 我再帮您确认 availability', S);
  eq('链接与夹带词共存', got, '方案在这 /proposal/r-guizhou/2 我再帮您确认 档期');
}

// ---------------- 边界 ----------------
unchanged('单字母不动', '房型是 A 区还是 B 区？');
eq('空字符串', dejargon('', S), '');


// ---------------- 空头承诺护栏 ----------------
// 系统没有重排行程的能力，模型却会说「我按 5 天帮您重排…减掉了 XX」。
// 这是对真实客户做出公司交付不了的承诺，必须拦住。
// 同样要防误伤：正常的推荐/报价话术里也会出现天数和「调整」二字。
{
  const { CUSTOM_PROMISE, LINK_PROMISE } = __engineTest;
  const 必须拦 = [
    '好的，我按 5 天帮您重排，先出方案书给您看：',
    '5 天版保留丽江+香格里拉，减掉了滇金丝猴追踪和部分过渡行程。',
    '我帮您重新规划一版更紧凑的行程',
    '可以缩到 6 天，我给您重新安排一下',
    '为您重排后的逐日安排在链接里',
    '砍掉了第五天的丹寨行程，费用也降下来了',
    '我重新安排一版行程给您',
    '给您重新规划路线，把丹寨去掉',
    // 线上实际发生过的原文（云南松赞环线，客户问「能改成五天吗」），收紧正则后必须仍然拦住
    '好的，我按 5 天帮您重排，先出方案书给您看：',
    '5 天版保留丽江+香格里拉松赞林寺+梅里山居守日照金山这几个核心，减掉了滇金丝猴追踪和部分过渡行程。',
  ];
  const 不该拦 = [
    // 以下五条是第一版正则实际误伤过的，必须永久钉住
    '这条线是按 8 天的节奏定制的',
    '我们按 6 天定制的行程，住宿都排好了',
    '为您重新安排一位管家对接',
    '给您重新安排出发的接机时间',
    '接机时间我帮您重新安排一下',
    '这条线是 6 天的，比您说的五天多一天，我先发您看看',
    '这条线在人均 1.5 万左右这个档，含 5 晚住宿',
    '少一天的话会砍掉茂兰原始森林或丹寨手作中的一项，您更想保留哪部分？',
    '我按日期给您出准确报价',
    '您计划几号出发？我按出发月份确认价格',
    '这条 8 天的行程节奏不赶，精华都在中后段',
    '同一目的地我们还有 5 天的线路，我帮您找找',
  ];
  for (const t of 必须拦) {
    if (CUSTOM_PROMISE.test(t)) pass += 1;
    else fails.push(`空头承诺漏网: ${t}`);
  }
  for (const t of 不该拦) {
    if (!CUSTOM_PROMISE.test(t)) pass += 1;
    else fails.push(`正常话术被误拦: ${t}`);
  }
  // 兜底文案的天数必须来自客户原话，不能写死
  const { requestedDays } = __engineTest as any;
  if (typeof requestedDays === 'function') {
    for (const [t, want] of [['能改成三天吗', 3], ['压到 5 天行吗', 5], ['我只有十天', 10], ['能便宜点吗', null]] as [string, number|null][]) {
      const got = requestedDays(t);
      if (got === want) pass += 1;
      else fails.push(`天数解析: 「${t}」得到 ${got}，期望 ${want}`);
    }
  }

  // 承诺了链接却没有链接 = 指向空气
  for (const t of ['具体逐日安排、住宿和费用明细都在链接里。', '方案书已生成，点开看', '请点此完成支付']) {
    if (LINK_PROMISE.test(t)) pass += 1;
    else fails.push(`死链接承诺漏网: ${t}`);
  }
  for (const t of ['您几位出行？', '这条线人均 15,800 起']) {
    if (!LINK_PROMISE.test(t)) pass += 1;
    else fails.push(`普通话术被当成链接承诺: ${t}`);
  }
}


// ---------------- 客群五分类识别 ----------------
// 客群是选线的硬约束（银发不能推 4000 米线路），认错比认不出更危险。
{
  const { detectSegment } = __engineTest as any;
  const cases: [string, string | undefined][] = [
    ['想带我爸妈去转转', '银发'],
    ['我们带孩子，六岁', '亲子'],
    ['蜜月旅行，两个人', '蜜月'],
    ['公司团建，二十来人', '商务'],
    ['我们一家人出去玩', '家庭'],
    // 混合场景：更受限的银发优先——带娃可以去高原，带老人不行
    ['带孩子和爸妈一起', '银发'],
    // 不该误判
    ['想去云南玩几天', undefined],
    ['预算每人三万', undefined],
    ['两个人，十月出发', undefined],
  ];
  for (const [text, want] of cases) {
    const got = detectSegment(text);
    if (got === want) pass += 1;
    else fails.push(`客群识别「${text}」得到 ${got ?? 'undefined'}，期望 ${want ?? 'undefined'}`);
  }
}

if (fails.length) {
  console.error(`DEJARGON SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 8)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`DEJARGON SELFTEST PASS: ${pass} 项断言全通（英文替换 / 品牌名零误伤 / 空头承诺拦截 / 无误伤）`);
