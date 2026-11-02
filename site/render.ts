import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT_NAME, PRODUCT_FOCUS, PUBLIC_SITE_PAGES, type ProductPublishInput } from '../src/shared/product-surface.js';
import { baseUrl, escapeHtml as e } from '../scripts/product-sites/input.js';
import { copyFonts } from '../scripts/product-sites/fonts.js';
import { SCREENSHOTS } from './screenshots.js';

export function buildSite(input: ProductPublishInput, output: string): void {
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  copyFonts(path.join(output, 'assets/fonts'));
  fs.copyFileSync('site/style.css', path.join(output, 'assets/style.css'));
  const logo = `logo${path.extname(input.logoFile)}`;
  const favicon = `favicon${path.extname(input.faviconFile)}`;
  fs.copyFileSync(input.logoFile, path.join(output, 'assets', logo));
  fs.copyFileSync(input.faviconFile, path.join(output, 'assets', favicon));
  const app = e(baseUrl(input.bases.app));
  const docs = e(baseUrl(input.bases.docs));
  const repository = e(input.sourceRepositoryUrl);
  const report = `${repository}/blob/dev/docs/reports/industrial-sim/2026-11-01/report.md`;
  const nav = (active: string) =>
    `<nav aria-label="主导航"><a href="/product/"${active === '/product/' ? ' aria-current="page"' : ''}>产品能力</a><a href="${docs}">使用文档</a><a href="${app}">登录后台 ↗</a><a class="button button-sm" href="/#apply">申请试用</a></nav>`;
  const footer = `<footer><div class="wrap"><nav aria-label="页脚"><a href="${docs}">文档</a><a href="${app}">后台</a><a href="/privacy/">隐私政策</a><a href="/terms/">服务条款</a><a href="${repository}">开源代码</a><a href="${repository}/blob/HEAD/BRAND.md">品牌说明</a></nav><p>单来 · 工业询价。让询价有条理，让报价有依据。</p><p>软件代码采用 MIT 许可；「单来」名称与标识不在 MIT 授权内。商业事项另记。</p></div></footer>`;
  const shell = (route: string, title: string, body: string) =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · ${PRODUCT_NAME}</title><meta name="description" content="单来工业询价：接收询价，匹配型号，查阅产品库库存，按规则试算，审批报价与人工接手。"><link rel="canonical" href="${e(baseUrl(input.bases.www, route.slice(1)))}"><link rel="icon" href="/assets/${favicon}"><link rel="stylesheet" href="/assets/style.css"></head><body><a class="skip" href="#main">跳到正文</a><header><div class="wrap bar"><a class="brand" href="/"><img src="/assets/${logo}" alt="" width="28" height="28">${PRODUCT_NAME}</a>${nav(route)}</div></header><main id="main">${body}</main>${footer}</body></html>`;
  /** 一行报价单：左边是单据内容，右边是这个数字的来处。手机上来处落到内容下面。 */
  const sheetLine = (body: string, source: string) =>
    `<div class="sheet-line"><div class="sheet-cell">${body}</div><p class="sheet-source">${source}</p></div>`;
  const board = `<aside class="board" aria-label="合成询价示例：一张带来源标注的报价单"><p class="bubble"><span>客户 · 微信客服</span>6207-2RS 要 32 件，现货够吗？</p><div class="sheet"><div class="sheet-line"><div class="sheet-cell sheet-head"><strong>报价单</strong><span>衡石工业品（演示）· 合成示例</span></div></div>${sheetLine(
    '<dl><div><dt>型号</dt><dd class="mono">6207-2RS</dd></div><div><dt>数量</dt><dd class="mono">32件</dd></div><div><dt>单价</dt><dd class="mono">13.14元</dd></div></dl>',
    '单价来自产品库 20 件档',
  )}${sheetLine('<dl><div><dt>交期</dt><dd>现货 18 件，其余约 9 天</dd></div></dl>', '交期来自工具查询，顾问再确认')}${sheetLine(
    '<dl><div><dt>合计</dt><dd class="mono total">420.48元</dd></div><div><dt>说明</dt><dd>含税 13% · 运费 0 元</dd></div></dl>',
    '合计由代码算出，模型改不了',
  )}${sheetLine('<span class="status">等待顾问审批报价</span>', '批准之后才发给客户')}</div></aside>`;
  const workflow = `<ol class="steps"><li><span class="number">01 收询价</span><h3>先收齐需求</h3><p>微信客服接收文字、图片与表格，识别多行询价，缺规格就继续确认。</p></li><li><span class="number">02 匹配与试算</span><h3>型号与数量对上</h3><p>匹配产品库中的编码、规格和库存，按阶梯价与起订量计算。</p></li><li><span class="number">03 报价审批</span><h3>确认之后再外发</h3><p>试算形成待审批报价，顾问批准后才能向客户发送正式报价链接。</p></li><li><span class="number">04 人工接手</span><h3>有需要，人来接</h3><p>客户要求真人或需求超出范围时转给顾问，在原渠道继续沟通。</p></li></ol>`;
  const shotOf = (filename: string, className = '') => {
    const shot = SCREENSHOTS.find((item) => item.filename === filename);
    if (!shot) throw new Error(`截图没有登记：${filename}`);
    const source = path.join('site/screenshots', shot.filename);
    let media = `<div class="shot"><strong>${e(shot.title)}</strong><span>合成截图待补 · ${shot.width} × ${shot.height}</span></div>`;
    if (fs.existsSync(source)) {
      if (!fs.lstatSync(source).isFile()) throw new Error('截图必须是登记的普通文件');
      fs.copyFileSync(source, path.join(output, 'assets', shot.filename));
      media = `<div class="shot"><img src="/assets/${shot.filename}" alt="${e(shot.description)}" width="${shot.width}" height="${shot.height}" loading="lazy"></div>`;
    }
    return `<figure class="${className}">${media}<figcaption>${e(shot.description)}</figcaption></figure>`;
  };
  const chapter = (id: string, tag: string, title: string, text: string, points: string[], visual: string) =>
    `<section class="chapter" id="${id}"><div class="wrap"><div class="chapter-copy"><p class="eyebrow">${tag}</p><h2>${title}</h2><p>${text}</p><ul>${points.map((point) => `<li>${point}</li>`).join('')}</ul></div><div class="chapter-visual">${visual}</div></div></section>`;
  const intakeVisual = `<div class="card"><p class="card-title">识别到 6 行，请核对后确认</p><ol class="intake"><li><span class="mono">6205-2RS</span><span class="mono">40件</span></li><li><span class="mono">6206-2RS</span><span class="mono">40件</span></li><li><span class="mono">HS-K01-24</span><span class="mono">3件</span></li><li><span class="mono">HS-K10-24</span><span class="mono">3件</span></li><li><span class="mono">M8×30</span><span class="mono">60件</span></li><li><span class="mono">M8×40</span><span class="mono">60件</span></li></ol><p class="card-foot">确认之后才开始算价，可以直接改某一行。</p></div>`;
  const tierVisual = `<div class="card"><p class="card-title"><span class="mono">6207-2RS</span> 的数量档位</p><table class="tiers"><thead><tr><th scope="col">起订数量</th><th scope="col">含税单价</th></tr></thead><tbody><tr><td class="mono">2件</td><td class="mono">14.60元</td></tr><tr class="is-hit"><td class="mono">20件</td><td class="mono">13.14元<span>32 件落在这一档</span></td></tr><tr><td class="mono">100件</td><td class="mono">11.68元</td></tr><tr><td class="mono">200件</td><td class="mono">10.22元</td></tr></tbody></table><p class="card-foot">低于起订量的行不报价。</p></div>`;
  const chapters = [
    chapter(
      'intake',
      '收询价',
      '微信里怎么发，都接得住。',
      '文字、截图和 Excel 都能进来。多行清单先整理成一张表，客户确认之后才算价，缺规格就接着问。',
      ['别名、全角、空格和大小写都能对上型号', '有多个候选时让客户选，不替客户定', '一次最多处理 30 行'],
      intakeVisual,
    ),
    chapter(
      'pricing',
      '算价格',
      '单价不靠模型记，靠档位算。',
      '阶梯价、起订量和库存都在产品库里。试算由代码完成，模型只负责把结果讲清楚。',
      ['按数量自动选档，不用人工翻价目表', '产品库支持 CSV 批量导入', '库存是产品库快照，ERP 按商家单独开通'],
      tierVisual,
    ),
    chapter(
      'approval',
      '出报价',
      '顾问点头，报价才发出去。',
      'AI 只起草报价单。顾问核对型号、数量和金额后批准，客户才收到正式报价；驳回就转给顾问接手。',
      ['新报价默认人工审批', '客户明确接受后，通知顾问安排收款', '产品不接在线支付，收款由顾问线下完成'],
      shotOf('quote-review.webp'),
    ),
  ].join('');
  const flow = `<section class="flow"><div class="wrap"><div class="section-title"><p class="eyebrow">协作流程</p><h2>重复的整理交给系统，<br>关键的决定留给人。</h2></div>${workflow}</div></section>`;
  const gallery = `<section class="gallery-section"><div class="wrap"><div class="section-title"><p class="eyebrow">工作界面</p><h2>从询价到交接，看得见每一步。</h2><p>以下界面均使用合成数据，不包含真实会话与客户信息。</p></div>${shotOf('rfq-workbench.webp', 'shot-wide')}${shotOf('catalog-list.webp', 'shot-wide')}</div></section>`;
  const trust = `<section class="trust"><div class="wrap"><div class="section-title"><p class="eyebrow">为什么敢交给它</p><h2>钱和承诺，不交给模型。</h2></div><div class="trust-grid"><ul class="trust-list"><li><h3>金额有出处</h3><p>客户收到的每个金额，都要对得上工具结果或已批准的报价单，对不上的句子发不出去。</p></li><li><h3>说错的话拦在出口</h3><p>额外折扣、编造的库存、没依据的交期，在发送前由代码改掉。</p></li><li><h3>全程留痕</h3><p>每一轮的模型原稿、工具调用和护栏改动都记下来，后台可查。</p></li></ul><div class="evidence"><p class="eyebrow">公开的仿真报告</p><dl><div><dt class="mono">116 / 120</dt><dd>段合成询价走到预期结果</dd></div><div><dt class="mono">0</dt><dd>次单价、金额、起订量或审批规则被破坏</dd></div></dl><p class="note">客户由模型扮演，场景是我们自己写的，这不是线上成交率。</p><a href="${report}">读完整报告 ↗</a></div></div></div></section>`;
  const qa = (question: string, answer: string) => `<details><summary>${question}</summary><p>${answer}</p></details>`;
  const faq = `<section class="faq"><div class="wrap"><div class="section-title"><p class="eyebrow">常见问题</p><h2>采购前最常问的几件事。</h2></div><div class="faq-list">${[
    qa('AI 会不会报错价？', '金额由产品库和规则算出，不由模型决定。报价单要顾问批准后才发给客户。'),
    qa('库存是实时的吗？', '默认是已发布产品库的快照，不能当实时库存承诺。ERP 连接器按商家单独开通，共享试用环境没有接入。'),
    qa('客户要找真人怎么办？', '客户要求真人、投诉或需求超出范围时转给顾问。顾问接手后 AI 停止接待，在原渠道继续沟通。'),
    qa('能处理图片和 Excel 吗？', '可以。识别结果先整理成清单让客户确认，确认之后才算价。'),
    qa('支持在线收款吗？', '不支持。报价批准、客户接受后由顾问线下收款，系统只记录状态。'),
    qa('试用要准备什么？', '不用导入数据。共享试用环境已有合成产品库和示例会话，用顾问账号登录就能体验审批和接手。'),
  ].join('')}</div></div></section>`;
  const apply = `<section id="apply" class="apply"><div class="wrap"><div class="apply-panel"><div><p class="eyebrow">开始了解</p><h2>用一条询价，走完一次协作。</h2><p>${e(input.applicationInstructions)}</p><p>试用为普通顾问账号，按需发放。没有自助注册或自动领取入口。</p></div><div class="apply-side"><div class="actions"><a class="button" href="${docs}">先读快速开始</a><a href="${app}">已有账号，登录后台 ↗</a></div><p class="note">共享试用环境：合成种子与试用者自行发送的消息可能被同一试用公司的成员看到，请勿发送个人信息或正式客户资料。真实试用消息、客户资料及追踪记录保留 7 天；手动重置会同时清理种子和试用消息。</p></div></div></div></section>`;
  const spec = (name: string, value: string) => `<div><dt>${name}</dt><dd>${value}</dd></div>`;
  const specs = `<section class="specs"><div class="wrap"><div class="section-title"><p class="eyebrow">能力规格</p><h2>现在能做什么。</h2></div><dl class="spec-sheet">${[
    spec('接入渠道', '企业微信的微信客服'),
    spec('询价输入', '文字、图片和 Excel 表格，单次最多 30 行'),
    spec('产品库', '编码、规格、别名、库存、起订量和阶梯价，支持 CSV 导入'),
    spec('试算', '按数量选档，低于起订量的行不报价'),
    spec('报价单', '默认顾问审批后发给客户，有效期按已发布政策'),
    spec('转人工', '非标、图纸、账期、样品、投诉或客户要真人时转顾问'),
    spec('销售话术', '可编辑语气与异议处理，固定规则由代码核对，发布前自动检查'),
    spec('后台', '会话工作台、AI 记录、审计日志和用量查看'),
    spec('ERP 库存', '连接器按商家单独开通，共享试用环境没有接入'),
  ].join('')}</dl></div></section>`;
  const limits = `<section class="limits"><div class="wrap"><div class="section-title"><p class="eyebrow">使用边界</p><h2>按实际开通范围使用。</h2></div><ul class="limit-list"><li>产品库库存是配置快照，不能视为实时库存承诺。</li><li>用量展示只对授权管理员开放，它不是服务账单。成员与渠道设置本期只读，变更由平台在维护窗口完成。</li><li>共享顾问账号可以处理会话与审批其负责的报价，不能修改产品库、销售话术或管理设置。</li></ul></div></section>`;
  const pages: Record<(typeof PUBLIC_SITE_PAGES)[number], [string, string]> = {
    '/': [
      `${PRODUCT_FOCUS}助手`,
      `<div class="hero"><div class="wrap"><div class="hero-copy"><p class="eyebrow">工业询价助手</p><h1>接住每条询价，<br>把报价交给规则。</h1><p class="lead">客户在微信发来型号和数量，单来核对型号、查库存、按阶梯价试算，起草报价单交顾问批准。金额由规则算，承诺由人定。</p><div class="actions"><a class="button" href="#apply">申请试用账号</a><a href="/product/">了解产品能力 →</a></div><p class="proof"><a href="${report}">120 段合成询价的仿真报告，全文公开 ↗</a></p></div>${board}</div></div>${flow}${chapters}${gallery}${trust}${faq}${apply}`,
    ],
    '/product/': [
      '产品能力',
      `<div class="hero hero-plain"><div class="wrap"><div class="hero-copy"><p class="eyebrow">产品能力</p><h1>询价往前走，<br>边界留得住。</h1><p class="lead">围绕工业销售日常，把接收、匹配、试算、审批和交接串成一条清楚的工作流。金额依据已发布的产品库和工具计算结果，未批准的报价不向客户外发。</p><div class="actions"><a class="button" href="#apply">申请试用账号</a><a href="${docs}catalog.html">了解产品库 →</a></div></div><nav class="jump" aria-label="本页目录"><a href="#intake">收询价</a><a href="#pricing">算价格</a><a href="#approval">出报价</a><a href="#specs">能力规格</a></nav></div></div>${flow}${chapters}<div id="specs">${specs}</div>${limits}${apply}`,
    ],
    '/privacy/': [
      '隐私政策',
      `<article class="prose"><p class="eyebrow">隐私与数据</p><h1>隐私政策</h1><p>版本 ${e(input.legal.version)} · 生效日期 ${e(input.legal.effectiveDate)}</p><div class="legal">${e(fs.readFileSync(input.legal.privacyFile, 'utf8'))}</div></article>`,
    ],
    '/terms/': [
      '服务条款',
      `<article class="prose"><p class="eyebrow">使用约定</p><h1>服务条款</h1><p>版本 ${e(input.legal.version)} · 生效日期 ${e(input.legal.effectiveDate)}</p><div class="legal">${e(fs.readFileSync(input.legal.termsFile, 'utf8'))}</div></article>`,
    ],
  };
  for (const route of PUBLIC_SITE_PAGES) {
    const folder = path.join(output, route.slice(1));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), shell(route, ...pages[route]));
  }
  fs.writeFileSync(
    path.join(output, '404.html'),
    shell(
      '/404.html',
      '页面未找到',
      '<article class="prose"><h1>这页没有找到。</h1><p>地址可能已经变更。可以回到首页，或从使用文档继续。</p><a class="button" href="/">回到首页</a></article>',
    ),
  );
  fs.writeFileSync(path.join(output, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(
    path.join(output, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PUBLIC_SITE_PAGES.map((route) => `<url><loc>${e(baseUrl(input.bases.www, route.slice(1)))}</loc></url>`).join('')}</urlset>`,
  );
}
