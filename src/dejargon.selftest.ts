// 中文话术夹带英文的出口护栏自测。
// 这条护栏的风险全在「误伤」上：产品库里全是酒店品牌英文（Four Seasons /
// Soneva Jani / Aman / Park Hyatt / One&Only…），替错了比不替更糟——
// 客户会看到「Four 季节」这种东西。所以品牌名的断言比替换本身的断言更重要。
// 用法：npx tsx src/dejargon.selftest.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 引擎会连带加载 store，而 store 在模块加载时就取 VAR_DIR 并做演示数据保鲜落盘——
// 静态 import 会先于任何赋值执行，直接跑就改写真实 var/sessions.json。先隔离再动态 import
process.env.VAR_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-dejargon-'));
const { __engineTest } = await import('./engine.js');
const { loadRoutes } = await import('./tools.js');

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

// ---------------- 内部用语：「库里 / 产品库」不能出现在客户看到的话里 ----------------
// 前两条是盲评里模型真实发出的原句
eq('库里还有一条', dejargon('另外库里还有一条稻城亚丁8日的，但海拔偏高，带小朋友我就先不主推了。', S),
  '另外我们这边还有一条稻城亚丁8日的，但海拔偏高，带小朋友我就先不主推了。');
eq('目前库里', dejargon('目前库里北京线就这一条 5 日深度款。', S), '目前我们这边北京线就这一条 5 日深度款。');
eq('库里没有', dejargon('库里暂时没有峨眉山的线路，我帮您看看相近的。', S), '我们这边暂时没有峨眉山的线路，我帮您看看相近的。');
eq('我们库里（不能变成「我们我们这边」）', dejargon('我们库里新疆有两条。', S), '我们这边新疆有两条。');
eq('产品库里', dejargon('产品库里没有 5 天的云南线。', S), '我们的线路里没有 5 天的云南线。');
eq('线路库', dejargon('这超出了我们的线路库范围', S), '这超出了我们的线路范围');
eq('酒店库', dejargon('我在精品酒店库里给您挑了两家', S), '我在我们合作的酒店里给您挑了两家');
eq('链接与内部用语共存', dejargon('库里就这条 /proposal/r-guizhou/2 您看看', S), '我们这边就这条 /proposal/r-guizhou/2 您看看');
// 零误伤：正常用词里的「库里」「库」
unchanged('车库里', '酒店地下车库里可以免费停车。');
unchanged('仓库里', '雪具都放在仓库里，到了直接领。');
unchanged('酒库里', '晚宴在酒庄的酒库里办，温度常年 14 度。');
unchanged('水库里', '水库里可以划皮艇。');
unchanged('宝库里', '莫高窟是艺术宝库里的明珠。');
unchanged('冷库里', '牦牛肉从冷库里直接取，很新鲜。');
unchanged('库存', '这条线路库存不多了，国庆档期很紧。');
unchanged('产品库存', '旺季产品库存紧张，建议尽早定。');
unchanged('地名库尔勒', '南疆从库尔勒出发，走独库公路。');
// 「库里」前面不是句首/标点/「我们」「目前」这类说法时一律不碰（此前按黑名单，下面这些全被改坏）
unchanged('库里南', '劳斯莱斯库里南接机，全程专车。');
unchanged('地库里', '酒店地库里停车免费。');
unchanged('资料库里', '资料库里有攻略，出发前发您。');
unchanged('图库里', '素材图库里挑了几张给您看看。');
unchanged('人名库里', '斯蒂芬·库里也住过这家。');
unchanged('存在库里', '雪具可以寄存在库里，到了直接领。');
eq('这边库里（不能变成「我们这边我们这边」）', dejargon('我们这边库里还有一条稻城亚丁的。', S), '我们这边还有一条稻城亚丁的。');
eq('我们的库里', dejargon('我们的库里新疆有两条。', S), '我们这边新疆有两条。');
eq('查了下库里', dejargon('我查了下库里，暂时没有峨眉山的线。', S), '我查了下我们这边，暂时没有峨眉山的线。');
// 护栏自己的兜底话术是有意这么写的，出口替换不能碰
unchanged('价格兜底话术', '价格我得核准了再报给您。告诉我想看哪条线路、几位出行，我马上给您出准确报价～');

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
    // 「帮您重排」不带宾语也是承诺（「重新安排」才会误伤管家/接机）
    '好的我帮您重排，明细稍后发您。',
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
    // 客户原话里常同时有原线路天数和想要的天数：取「改成」后面的，没有就取最后一个
    for (const [t, want] of [
      ['能改成三天吗', 3], ['压到 5 天行吗', 5], ['我只有十天', 10], ['能便宜点吗', null],
      ['8天能改成5天吗', 5], ['原来 8 天，我只要 5 天', 5], ['十五天太长了', 15], ['玩三五天', null],
    ] as [string, number|null][]) {
      const got = requestedDays(t);
      if (got === want) pass += 1;
      else fails.push(`天数解析: 「${t}」得到 ${got}，期望 ${want}`);
    }
  }

  // 按句保留：摘掉承诺及其后续；剩下的若是编出来的逐日行程，整段都不要
  {
    const { keptBesideCustomPromise } = __engineTest;
    eq('跨问号的承诺只留下问句', keptBesideCustomPromise('您想改成5天？好的我帮您重排，明细稍后发您。'), '您想改成5天？');
    eq('另一个问题的回答保留', keptBesideCustomPromise('好的，我按5天帮您重排行程。\n极光要看天气。'), '极光要看天气。');
    eq('编造的逐日行程整段丢掉',
      keptBesideCustomPromise('没问题，给您出一个5天版。\nD1 抵达丽江\nD2 玉龙雪山\nD3 返程'), '');
    eq('第N天行程也算', keptBesideCustomPromise('我帮您重排。\n第1天 丽江\n第2天 大理'), '');
    eq('句中提一次「第2天」不算行程',
      keptBesideCustomPromise('我按5天帮您重排。\n极光一般第 2 天晚上最容易看到。'), '极光一般第 2 天晚上最容易看到。');
    eq('指向重排结果的后续句一并摘掉', keptBesideCustomPromise('我按5天帮您重排。\n压缩后保留了丽江和大理。'), '');
    // 行程不一定分行写：写在一行里、编号列表、按晚数的箭头链，同样是编出来的行程
    for (const [name, t] of [
      ['一行里的第N天', '我按5天帮您重排。\n5天安排：第1天丽江古城，第2天玉龙雪山，第3天泸沽湖，第4天大理，第5天返程。'],
      ['一行里的 D1 D2', '我按5天帮您重排。\n精简版：D1丽江 D2玉龙雪山 D3泸沽湖 D4大理 D5返程'],
      ['按晚数的箭头链', '我按5天帮您重排。\n丽江2晚 → 大理1晚 → 泸沽湖1晚 → 返程'],
      ['编号列表', '我按5天帮您重排。\n1. 丽江古城\n2. 玉龙雪山\n3. 泸沽湖\n4. 大理'],
    ]) eq(`编造的行程整段丢掉（${name}）`, keptBesideCustomPromise(t), '');
  }

  // 承诺了链接却没有链接 = 指向空气。后四条是盲评里模型真实的说法（此前都认不出）
  for (const t of [
    '具体逐日安排、住宿和费用明细都在链接里。', '方案书已生成，点开看', '请点此完成支付',
    '我先把这条6日亲子线的详细方案发您看看，里面有逐日行程', '好嘞，我把完整方案书发您，方便您转给家里人看：',
    '链接如下：', '好的，支付链接给您',
  ]) {
    if (LINK_PROMISE.test(t)) pass += 1;
    else fails.push(`死链接承诺漏网: ${t}`);
  }
  for (const t of ['您几位出行？', '这条线人均 15,800 起', '给您推荐的方案有两条', '您发我人数，我给您出报价', '我按这个方案给您报价']) {
    if (!LINK_PROMISE.test(t)) pass += 1;
    else fails.push(`普通话术被当成链接承诺: ${t}`);
  }
  // 「现在就发」才要求这条消息里有链接；带条件的是以后的事，不能被当成死承诺去删改
  const { promiseInsertAt, markLinkHoles } = __engineTest;
  for (const t of ['北京这条的话，我把方案发您看看', '给您定制好了，详细方案发您', '我先讲下亮点，然后我把方案书发您', '方案回头发您']) {
    if (promiseInsertAt(t, 'proposal') >= 0) pass += 1;
    else fails.push(`现在就发的承诺被当成了有条件: ${t}`);
  }
  for (const t of ['您计划几号出发？定了日期我把详细方案发您。', '您告诉我人数，我把方案发您', '觉得合适的话，我把方案书发您', '等您定好日期我再发方案']) {
    if (promiseInsertAt(t, 'proposal') < 0) pass += 1;
    else fails.push(`有条件的后话被当成死承诺: ${t}`);
  }
  // 不发、别人发、问要不要发，都不是「这条消息里该有方案书链接」
  for (const t of [
    '好的，方案我先不发您了，您慢慢考虑～', '好的，那方案书就先不给您发了，您有需要随时说～',
    '这个我让资深顾问来帮您，稍后他会把定制方案发您。', '住的都是五星精选酒店。要不要我把详细方案发您看看？',
    // 光秃秃的「链接里」是在答已经发过的链接
    '链接里的价格是起价，按最终行程和出发日期微调，大头不会变。',
  ]) {
    if (promiseInsertAt(t, 'proposal') < 0) pass += 1;
    else fails.push(`不是方案书承诺却被当成了: ${t}`);
  }
  // 按句归类：在说付款的句子只归支付规则；已有真链接时不点名的说法算兑现
  for (const t of ['订单已生成，支付链接如下：', '点开链接完成支付即可', '好的，支付链接给您：/pay/ord_x，名额以付款为准～']) {
    if (promiseInsertAt(t, 'proposal') < 0) pass += 1;
    else fails.push(`支付的说法被当成方案书承诺: ${t}`);
  }
  eq('已有真链接，不点名的「链接如下」算兑现', String(promiseInsertAt('链接如下：\n/proposal/r-guizhou/2', 'proposal')), '-1');
  eq('方案/行程语境里的「链接如下」归方案书', String(promiseInsertAt('贵州这条的详细行程，链接如下：', 'proposal') > 0), 'true');
  // 支付链接要带「现在就给」的意思：描述那条链接的话不算承诺
  for (const [t, want] of [
    ['付款链接24小时内有效，过期了跟我说一声重新生成就行～', false], ['刚才的支付链接找不到了吗', false],
    ['好的，支付链接给您：', true], ['支付链接在这：', true], ['请点此完成支付', true],
    // 讲规矩的陈述不是在发链接（B04 两遍、guard-03/13 原句）：此前被删掉，末尾还追加「确认好我马上给您下单」
    ['付款只走我们发给您的官方支付链接，不会让您私下转账', false], ['· 付款只走我们官方发给您的支付链接，不经任何私人账户', false],
    ['这边没法转发外部链接，也不建议点开来路不明的付款地址——付款请认准我们官方发给您的支付链接。', false],
    ['资质这块我得如实说：由顾问跟您确认，下单后会签电子合同，付款也只走我们发给您的官方支付链接，可以放心。', false],
    ['付款都是通过发给您的支付链接完成的', false], ['我们发给您的支付链接24小时内有效', false],
    // 指着那条链接说的照样算：「这是…链接」「发给您的…链接：」
    ['这是您的支付链接：', true], ['这是发给您的支付链接：', true], ['好的，发您支付链接', true],
  ] as [string, boolean][]) {
    if ((promiseInsertAt(t, 'pay') >= 0) === want) pass += 1;
    else fails.push(`支付承诺判断错（期望 ${want}）: ${t}`);
  }
  // 占位符与空位：认出来的地方换成空位记号；普通括号、普通冒号不能动
  // oxlint-disable-next-line no-control-regex -- 断言的就是链接空位记号（engine.ts HOLE）
  const holed = (t: string) => /[\u0001-\u0003]/.test(markLinkHoles(t));
  for (const t of [
    '👉 方案书链接（此处由系统生成）：逐日行程都在里面', '方案书给您：[链接]', '点这里（链接）查看', '方案在这 {proposalUrl}',
    '方案书链接：\n您看完告诉我', '详细方案发您看看，明细：\n\n\n\n您看完再说', '详细方案发您：',
    // 只写了「方案书」的方括号、「此处附方案」的说明，同样是占位符
    '方案书：[方案书]\n您先看看。', '👉 行程方案书（此处附方案）\n您先看看。', '方案发您看看：[方案]', '方案书链接（系统自动生成）',
  ]) {
    if (holed(t)) pass += 1;
    else fails.push(`链接占位符/空位漏认: ${JSON.stringify(t)}`);
  }
  for (const t of [
    '海拔很高（此处海拔 3000 米以上），带老人要注意', '报价如下：\n\n· 每人 16,800', '行程亮点：\n· 熊猫基地',
    '方案书在这 /proposal/r-guizhou/2（链接里有逐日行程）', '（含早餐）每晚 2,800', '亮点：\n\n\n\n· 洱海骑行',
    // 括号里提到链接/系统生成，但写的不是链接本身
    '门票预约（详见官网链接）我们都会帮您处理', '订单信息（系统自动生成，请核对）：2位', '（此处附近有温泉）', '【行程】\nD1 丽江',
  ]) {
    if (!holed(t)) pass += 1;
    else fails.push(`普通话术被当成链接占位: ${JSON.stringify(t)}`);
  }
  // 抹掉的站外网址（\u0003）：这一行只是提到「行程」，不是在发方案，不能变成方案书空位；紧挨着说方案的才算
  // oxlint-disable-next-line no-control-regex -- 断言的就是链接空位记号（engine.ts HOLE）
  const siteHole = (t: string) => /[\u0001\u0002]/.test(markLinkHoles(t));
  eq('官网网址不是方案空位', String(siteHole('需要的，在景区官网 \u0003 预约，行程里我们会提前帮您约好。')), 'false');
  eq('「行程详情见 网址」是方案空位', String(siteHole('行程详情见 \u0003 您先看看')), 'true');
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
    // 同义说法：引擎只按客户原话认客群（模型传的 segment 要靠这里核对），认不出就等于把客户说过的丢了
    ['给老爸过七十大寿，想出去走走', '银发'],
    ['想带我妈去散散心', '银发'],
    ['度蜜月', '蜜月'],
    ['结婚十周年纪念', '蜜月'],
    ['带两个娃去玩水', '亲子'],
    // 带老人的常见说法：认不出就等于没按银发查，模型没传时 5200 米的西藏线照推
    ['想带我母亲去西藏看看', '银发'],
    ['带妈妈去西藏', '银发'],
    ['和我姥姥姥爷一起去', '银发'],
    ['我们老两口想去四川玩', '银发'],
    ['我父亲80岁了，想去四川', '银发'],
    ['带丈母娘出去走走', '银发'],
    ['我和老伴想出去转转', '银发'],
    ['我婆婆六十多岁了', '银发'],
    // 「孩子妈妈」「孩子他爸」说的是配偶，不是长辈
    ['我和孩子妈妈带孩子去', '亲子'],
    // 不该误判
    ['想去云南玩几天', undefined],
    ['预算每人三万', undefined],
    ['两个人，十月出发', undefined],
    // 问的是我们公司，不是商务出行（此前命中「公司」被记成商务客群）
    ['你们公司在哪里', undefined],
    ['贵公司靠谱吗', undefined],
    // 说的是不同行的人：爸妈在家带娃，出门的是小两口（此前认成银发，还配了长辈替代线）
    ['我和老婆去西藏，爸妈在家带娃', undefined],
    ['我和老婆去西藏 爸妈帮忙带孩子', undefined],
    // 不同行的只是那一句，同行的长辈照样认；「不去高原」是要求，不是不去
    ['带爸妈去三亚 孩子在家', '银发'],
    ['我爸妈不去高原，想去三亚', '银发'],
  ];
  for (const [text, want] of cases) {
    const got = detectSegment(text);
    if (got === want) pass += 1;
    else fails.push(`客群识别「${text}」得到 ${got ?? 'undefined'}，期望 ${want ?? 'undefined'}`);
  }
}

// ---------------- 转人工安全网：投诉要转，打消疑虑的提问不转 ----------------
// 误伤一次就道歉 + 永久转人工，AI 对这个客户彻底闭嘴，所以两侧都要钉住
{
  const { isHandoffIntent } = __engineTest;
  const 必须转 = [
    '转人工，我要投诉', '你们这个是骗人的吧，我要投诉', '我要投诉', '投诉！', '怎么投诉你们',
    '你们就是骗子', '你们骗人', '我被骗了', '这是欺骗消费者', '我要给你们差评', '我要退款', '找真人客服',
    // 问投诉渠道就是要投诉；「没良心」里的「没」不是否定；「不是…吗」是反问、是指控
    '怎么投诉？', '投诉电话是多少？', '在哪里投诉你们？', '有没有投诉电话', '你们骗人没良心', '被骗了没人管',
    '这不是欺骗消费者吗',
  ];
  const 不该转 = [
    '你们不会骗人吧', '是不是骗人的', '你们靠谱吗，不会是骗人的吧', '看到有差评是真的吗',
    '网上有人投诉过你们吗', '你们是不是骗子？', '我不是来投诉的，就想问问', '我要退休了想出去玩',
    '你们不是骗子吧', '你们有没有被投诉过', '我没有投诉，就问问',
  ];
  for (const t of 必须转) {
    if (isHandoffIntent(t)) pass += 1;
    else fails.push(`该转人工却没转: ${t}`);
  }
  for (const t of 不该转) {
    if (!isHandoffIntent(t)) pass += 1;
    else fails.push(`打消疑虑的提问被当成投诉: ${t}`);
  }
}

// ---------------- 客户说的过去日期：只认出发日期 ----------------
{
  const { statedPastDate } = __engineTest;
  eq('过去的出行经历不算出发日期', String(statedPastDate('我们2025年10月1号去过云南，这次想去西藏')), 'null');
  eq('过去的出发日期要认', String(statedPastDate('2020年1月1号出发就订这个')), '2020-01-01');
  eq('跳过经历、认后面的出发日期', String(statedPastDate('2025年10月1号去过云南，2020年2月2号出发')), '2020-02-02');
}

// ---------------- 客户说的出发日期：节假日 / 相对说法 / 返程与经历 / 改口 ----------------
// 引擎据此给漏传 departDate 的报价、方案书补日期，补错一天就是报错一个季节的价，所以反例和正例一样多。
// today 写死，节假日的「最近那一次」才测得出跨年
{
  const { spokenDepartDate } = __engineTest;
  const d = (text: string, today = '2026-09-24'): string => {
    const r = spokenDepartDate(text, today);
    return r === null ? 'none' : r.kind === 'vague' ? 'vague' : `${r.iso ?? 'invalid'}${r.exact ? '' : '~'}`;
  };
  // 节假日取最近的未来那一次；「~」表示是按节日推的、不是客户说的具体哪天
  eq('国庆', d('国庆假期出发，一共3个人'), '2026-10-01~');
  eq('国庆已过取明年', d('国庆出发', '2026-10-02'), '2027-10-01~');
  eq('国庆当天', d('国庆出发', '2026-10-01'), '2026-10-01~');
  eq('明年国庆', d('明年国庆去'), '2027-10-01~');
  eq('十一长假', d('十一长假带孩子去'), '2026-10-01~');
  eq('五一', d('五一出发'), '2027-05-01~');
  eq('劳动节', d('劳动节去'), '2027-05-01~');
  eq('元旦', d('元旦去'), '2027-01-01~');
  eq('中秋（明天）', d('中秋出发'), '2026-09-25~');
  eq('八月十五就是中秋', d('八月十五出发'), '2026-09-25~');
  eq('春节查表（2027 年是 2 月 6 日）', d('春节带爸妈出去'), '2027-02-06~');
  eq('端午查表', d('端午去'), '2027-06-09~');
  eq('农历节日超出表就不补', d('春节出发', '2029-03-01'), 'vague');
  eq('写明年份的节日按那年', d('2028年春节出发'), '2028-01-26~');
  eq('写明年份、已经过去的节日不给', d('2025年国庆出发'), 'invalid~');
  eq('今年国庆已过不滚到明年', d('今年国庆去', '2026-10-02'), 'invalid~');
  // 相对说法
  eq('下个月15号', d('下个月15号出发'), '2026-10-15');
  eq('下个月跨年', d('下个月15号出发', '2026-12-20'), '2027-01-15');
  eq('下个月没有31号', d('下个月31号', '2026-10-05'), 'invalid');
  eq('这个月已过的日子不滚到明年', d('这个月20号出发'), 'invalid');
  eq('明年X月X号', d('明年10月5号出发'), '2027-10-05');
  eq('月底太模糊', d('月底出发'), 'vague');
  eq('只说月份不补', d('明年3月蜜月，想去海岛'), 'vague');
  // 返程、经历、区间终点都不是出发日期
  eq('区间取起点', d('10月1号到10月7号'), '2026-10-01');
  eq('返程日期不算', d('10月1号出发，7号回来'), '2026-10-01');
  eq('只有返程日期', d('10月7号回来，两个人报个价'), 'none');
  eq('去年的经历', d('去年国庆去过云南，这次想去四川'), 'none');
  eq('去过', d('2025年10月1号去过云南'), 'none');
  eq('不去了', d('国庆人太多，不去了'), 'none');
  eq('国庆前后说不准哪天', d('国庆前出发'), 'vague');
  // 改口以最后一次为准；改成说不准的日子就不能再用前一个
  eq('改口', d('原定10月2号，改到10月5号吧'), '2026-10-05');
  eq('改口成模糊月份', d('原定10月2号，改到11月吧'), 'vague');
  eq('中文数字月日不解析', d('改成十月三号'), 'vague');
  eq('过去的年份照旧不认', d('2025年10月1号那次没去成'), 'invalid');
  eq('没说日期', d('玩几天比较合适'), 'none');
  // 约联系时间不是出发时间：算成「说不准的日子」的话，一句客套就让之后整段对话都补不上日期
  eq('明天再说', d('明天再说吧'), 'none');
  eq('周一答复', d('周一给你答复'), 'none');
  eq('下周再联系', d('下周再联系你'), 'none');
  eq('几日游不是日期', d('有没有6日游'), 'none');
  // 同一句里后面的日子要像改口（「改到…」「…出发」）才算数，否则多半是返程、上班、别的安排
  eq('玩到哪天是返程', d('想去云南，3个人，10月1号出发，玩到10月7号'), '2026-10-01');
  eq('「回」是返程', d('10月1号走，10月5号回'), '2026-10-01');
  eq('上班那天不是出发', d('10月2号出发，10月8号要上班'), '2026-10-02');
  eq('后面跟着出发才算改口', d('国庆人多，10月3号出发'), '2026-10-03');
  eq('原定的日子不算', d('原定10月2号，10月5号吧'), '2026-10-05');
  // 说不准的时间后面跟的是别的安排，不算改了出发时间
  eq('这个周末商量', d('这个周末我跟家人商量一下，先把详细方案发我看看'), 'none');
  eq('孩子下个月考试', d('国庆出发吧，孩子下个月还要考试，一共3个人'), '2026-10-01~');
  eq('明年再考虑别处', d('先去云南，明年再考虑日本，报个价吧'), 'none');
  eq('月底前答复', d('国庆出发，这个月底前给你答复'), '2026-10-01~');
  eq('周末商量', d('国庆去，这个周末我跟家人商量一下'), '2026-10-01~');
  eq('下个月出发照样是改口', d('下个月出发我们再商量细节'), 'vague');
}

// ---------------- 哪句话算客户在说预算、哪些是下限 ----------------
// 引擎只按客户说预算的那句话核模型传的每人上限（见 statedBudgetCap）：把机票钱、别家的价、嫌贵的话当成预算，
// 要么丢掉客户说过的数，要么把「机票每人2000」当成每人上限、整库标超预算；反过来把真预算判成闲话，模型就会再问一遍预算
{
  const { isBudgetTalk, BUDGET_FLOOR } = __engineTest;
  const talk: [string, boolean][] = [
    ['每人两万预算，想去云南', true],
    ['想去西藏，每人两万', true],
    ['每人两万，含机票吗', true],
    ['去年国庆去过云南，这次每人两万', true],
    ['太贵了，每人一万五以内吧', true],
    ['我们三个一起去，预算一共6万', true],
    ['那个一万八的还是有点贵', false],
    ['我看别家一个人才一万五，再帮我看看贵州', false],
    ['机票我们自己订，每人2000左右', false],
    ['上次去日本每人花了两万', false],
  ];
  for (const [text, want] of talk) eq(`算不算说预算「${text}」`, String(isBudgetTalk(text)), String(want));
  const floor: [string, boolean][] = [
    ['至少每人3万', true], ['每人3万以上也行', true], ['5万起', true], ['8000以上', true], ['一万五以上', true], ['最少也得3万', true],
    ['一个人两万左右，我跟老公一起去', false], ['预算两万，至少玩5天', false], ['两万一个人，最少也得住五星', false],
    ['至少3个人', false], ['5天以上', false],
  ];
  for (const [text, want] of floor) eq(`算不算预算下限「${text}」`, String(BUDGET_FLOOR.test(text)), String(want));
}

// ---------------- 画像预算：中文数字也要记得下来 ----------------
{
  const { BUDGET_RE } = __engineTest;
  eq('每人两万', String('想去西藏，每人两万左右'.match(BUDGET_RE)?.[0]), '每人两万');
  eq('三万五', String('预算三万五'.match(BUDGET_RE)?.[0]), '三万五');
  eq('每人八千', String('每人八千够吗'.match(BUDGET_RE)?.[0]), '每人八千');
  eq('阿拉伯数字照旧', String('预算每人3万'.match(BUDGET_RE)?.[0]), '每人3万');
  eq('海拔不是预算', String('海拔三千米会不会高反'.match(BUDGET_RE)?.[0]), 'undefined');
}

// ---------------- 工具提示会被模型原样照抄：新加的提示同样不能带内部用语 ----------------
// 盲评里模型把工具提示整句抄进回复（「库里没有…」），所以 tools.ts 的提示只用对客户也说得出口的词。
// 银发替代、转人工这几段是后加的长提示，逐条过一遍，防以后改提示时顺手写回「库里 / 系统」
{
  const { searchRoutes, HANDOFF_NOTE, executeTool } = await import('./tools.js');
  const rows = [
    ...(await searchRoutes({ destination: '西藏', segment: '银发' })),
    ...(await searchRoutes({ destination: '云南', segment: '银发' })), // 银发标签线上的海拔提醒（altitudeNote）
    ...(await searchRoutes({ destination: '北欧', segment: '银发' })), // 只是节奏不合适、不配替代的那种
    // 按原话认出的长辈（模型传的不是银发）、怕高反、去过的地方、带长辈的体力强度
    ...(await searchRoutes({ destination: '西藏', segment: '家庭' }, { elder: true })),
    ...(await searchRoutes({ destination: '云南' }, { altitudeWorry: true })),
    ...(await searchRoutes({ destination: '北京', segment: '银发' })),
    ...(await searchRoutes({ tags: ['海岛'] }, { visited: ['马尔代夫', '巴厘岛'] })),
  ] as Record<string, unknown>[];
  // 问细节时替模型查的详情：答细节的口径、体力强度、海拔提醒同样会被照抄
  const session = { id: 'dj', channel: 'wecom', stage: 'recommend', profile: {}, messages: [], orderIds: [], handedOver: false, createdAt: 0, updatedAt: 0 };
  const detail = JSON.parse(await executeTool('get_route_detail', { routeId: 'r-sichuan-mid' }, session as never, { elder: true })) as Record<string, unknown>;
  const hints = [HANDOFF_NOTE, detail.detailNote, detail.intensityNote, detail.altitudeNote,
    ...rows.flatMap((r) => [r.segmentMismatch, r.alternative, r.altitudeNote, r.intensityNote, r.visited])]
    .filter((h): h is string => typeof h === 'string');
  eq('银发标签线的海拔提醒在', String(hints.some((h) => h.includes('能带长辈'))), 'true');
  eq('银发替代与转人工提示都在', String(hints.some((h) => h.includes('替代线路')) && hints.length > 2), 'true');
  eq('新加的几类提示都在（长辈不适配 / 怕高反 / 体力 / 去过 / 细节口径）', String(
    ['不在带长辈的适配范围内', '客户担心高反', '体力强度', '去过了', '行程里没写，我让顾问确认'].every((k) => hints.some((h) => h.includes(k)))), 'true');
  for (const h of hints) eq(`提示不带内部用语「${h.slice(0, 16)}…」`, String(/库里|产品库|线路库|系统|查库/.test(h)), 'false');
}

if (fails.length) {
  console.error(`DEJARGON SELFTEST FAIL: ${fails.length} 项未通过（通过 ${pass}）`);
  for (const f of fails.slice(0, 8)) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`DEJARGON SELFTEST PASS: ${pass} 项断言全通（英文替换 / 品牌名零误伤 / 空头承诺拦截 / 无误伤 / 转人工与日期识别）`);
