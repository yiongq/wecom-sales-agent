import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT_NAME, PRODUCT_FOCUS, PUBLIC_SITE_PAGES, type ProductPublishInput } from '../src/shared/product-surface.js';
import { baseUrl, escapeHtml as e } from '../scripts/product-sites/input.js';
import { copyFonts } from '../scripts/product-sites/fonts.js';
import { GUARD_DEMOS } from './guard-demos.js';
import { SCREENSHOTS } from './screenshots.js';

const icon = (paths: string) => `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
const CHECK = icon('<path d="M3 8.5l3.2 3L13 4.5"></path>');
const TEXT_ICON = icon('<path d="M3 4h10M3 8h10M3 12h6"></path>');
const IMAGE_ICON = icon('<rect x="2.5" y="3" width="11" height="10" rx="1.5"></rect><path d="M3 11l3-3 2.5 2.5L11 8l2 2"></path>');
const SHEET_ICON = icon('<rect x="2.5" y="3" width="11" height="10" rx="1.5"></rect><path d="M2.5 6.5h11M2.5 10h11M7 3v10"></path>');

/** 6207 深沟球轴承的正视线稿：9 粒钢球，保持架慢慢转。 */
const BALLS = Array.from({ length: 9 }, (_, index) => {
  const angle = (index * 2 * Math.PI) / 9;
  return `<circle class="ball" cx="${(120 + 80 * Math.cos(angle)).toFixed(1)}" cy="${(120 + 80 * Math.sin(angle)).toFixed(1)}" r="15"></circle>`;
}).join('');
const RINGS = [108, 104, 94, 66, 56, 52].map((radius) => `<circle cx="120" cy="120" r="${radius}"></circle>`).join('');
const BEARING = `<svg class="bearing" viewBox="0 0 240 240" aria-hidden="true"><path class="centerline" d="M120 4V236M4 120H236"></path>${RINGS}<g class="cage">${BALLS}</g></svg>`;

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
    `<nav aria-label="主导航"><a href="/product/"${active === '/product/' ? ' aria-current="page"' : ''}>产品能力</a><a href="${docs}">使用文档</a><a href="${repository}">开源代码</a></nav><div class="bar-side"><a class="button" href="${app}">登录</a><a class="button primary" href="/#apply">申请试用</a></div>`;
  const footer = `<footer><div class="wrap"><nav aria-label="页脚"><a href="${docs}">文档</a><a href="${app}">后台</a><a href="/privacy/">隐私政策</a><a href="/terms/">服务条款</a><a href="${repository}">开源代码</a><a href="${repository}/blob/HEAD/BRAND.md">品牌说明</a></nav><p>单来 · 工业询价。让询价有条理，让报价有依据。</p><p>软件代码采用 MIT 许可；「单来」名称与标识不在 MIT 授权内。商业事项另记。</p></div></footer>`;
  const shell = (route: string, title: string, body: string) =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · ${PRODUCT_NAME}</title><meta name="description" content="单来工业询价：接收询价，匹配型号，查阅产品库库存，按规则试算，审批报价与人工接手。"><link rel="canonical" href="${e(baseUrl(input.bases.www, route.slice(1)))}"><link rel="icon" href="/assets/${favicon}"><link rel="stylesheet" href="/assets/style.css"></head><body><a class="skip" href="#main">跳到正文</a><header><div class="wrap bar"><a class="brand" href="/"><img src="/assets/${logo}" alt="" width="28" height="28">${PRODUCT_NAME}</a>${nav(route)}</div></header><main id="main">${body}</main>${footer}</body></html>`;
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
  /** 功能格：标题、一句话、一张线稿。文字里只把关键词提亮，其余让位给画面。 */
  const cell = (glyph: string, title: string, text: string, art: string) =>
    `<article class="cell"><h3>${icon(glyph)}${title}</h3><p>${text}</p>${art}</article>`;
  const mapping = (from: string, to: string) => `<div><span>${from}</span><i></i><span class="matched">${to}</span></div>`;
  const features = `<section class="wrap features" aria-label="产品能力"><div class="cells"><article class="cell cell-wide"><div class="cell-text"><h3>${icon('<circle cx="8" cy="8" r="6.2"></circle><circle cx="8" cy="8" r="2.4"></circle>')}工业询价</h3><p>接在<b>企业微信的微信客服</b>上，轴承、紧固件这类询价从进线到报价，都由单来先走一遍。</p><ul class="checks"><li>${CHECK}金额由代码算出</li><li>${CHECK}批准之后才发给客户</li><li>${CHECK}每一轮都留痕可查</li></ul></div>${BEARING}</article>${[
    cell(
      '<circle cx="7" cy="7" r="4.6"></circle><path d="M10.6 10.6L14 14"></path>',
      '型号匹配',
      '<b>别名、全角、空格和大小写</b>，都能对上产品库里的型号。',
      `<div class="mapping mono" aria-hidden="true">${mapping('6205 2rs', '6205-2RS')}${mapping('m8x30', 'M8×30')}${mapping('hs k01 24', 'HS-K01-24')}</div>`,
    ),
    cell(
      '<path d="M2 4h4v4h4v4h4"></path>',
      '阶梯试算',
      '<b>按数量选档</b>，低于起订量的行不报价。单价不靠模型记。',
      '<svg class="stair" viewBox="0 0 280 150" aria-hidden="true"><path class="base" d="M0 136H280"></path><path class="step" d="M0 34H62M62 34V58M142 58V82H212V106H280"></path><path class="hit" d="M62 58H142"></path><circle cx="86" cy="58" r="4"></circle><text class="on" x="66" y="48">32 件 · 13.14元</text><text x="6" y="26">14.60</text><text x="150" y="76">11.68</text><text x="220" y="100">10.22</text></svg>',
    ),
    cell(
      '<path d="M4 2h5l3 3v9H4z"></path><path d="M9 2v3h3"></path>',
      '多种输入',
      '<b>文字、图片和 Excel</b> 都能进来，单次最多 30 行。',
      `<div class="tiles" aria-hidden="true">${[TEXT_ICON, IMAGE_ICON, SHEET_ICON, SHEET_ICON, TEXT_ICON, IMAGE_ICON].map((glyph) => `<span>${glyph}</span>`).join('')}</div>`,
    ),
    cell(
      '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"></path><path d="M5.8 8l1.6 1.6L10.4 6.6"></path>',
      '报价审批',
      '新报价<b>默认人工审批</b>，顾问批准后客户才收到。',
      '<div class="approval"><span class="status">等待顾问审批报价</span><span class="approve" aria-hidden="true">批准报价单</span><svg class="cursor" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 2l11 6-5 1.5L6.5 15z"></path></svg></div>',
    ),
    cell(
      '<rect x="3" y="7" width="10" height="7" rx="1.5"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path>',
      '出口检查',
      '<b>额外折扣、编造的库存</b>，发送前由代码改掉。',
      `<div class="rewrite"><s>${GUARD_DEMOS[0].draft}</s><span>${GUARD_DEMOS[0].sent}</span></div>`,
    ),
    cell(
      '<circle cx="8" cy="5" r="2.8"></circle><path d="M2.8 14c.6-3 2.7-4.4 5.2-4.4s4.6 1.4 5.2 4.4"></path>',
      '人工接手',
      '客户<b>要找真人</b>时转给顾问，在原渠道继续。',
      '<div class="handoff" aria-hidden="true"><span><i></i>AI 接待中</span><span class="on"><i></i>顾问处理中</span></div>',
    ),
  ].join('')}</div><p class="after">系统做整理，顾问做决定。<b>从询价到交接，都在一个后台里。</b></p></section>`;
  const proof = `<section class="proof" id="proof"><div class="wrap"><p class="proof-label">公开的仿真报告</p></div><div class="proof-band"><dl class="wrap stats"><div><dt class="mono">116 / 120</dt><dd>段合成询价走到预期结果</dd></div><div><dt class="mono">0</dt><dd>次单价、金额、起订量或审批规则被破坏</dd></div><div><dt>全文公开</dt><dd><a href="${report}">读完整报告 ↗</a></dd></div></dl></div><div class="wrap"><p class="note">客户由模型扮演，场景是我们自己写的，这不是线上成交率。</p></div></section>`;
  const screens = `<section class="screens"><div class="wrap"><h2>从询价到交接，看得见每一步</h2><p class="sub">以下界面均使用合成数据，不包含真实会话与客户信息。</p>${shotOf('rfq-workbench.webp', 'shot-main')}<div class="shot-pair">${shotOf('quote-review.webp')}${shotOf('catalog-list.webp')}</div></div></section>`;
  /** 单选框加标签做页签：不用脚本，键盘能切，样式失效时四组内容全部展开。 */
  const guard = `<section class="guard"><div class="wrap guard-grid"><div><h2><em>钱和承诺，</em>不交给模型</h2><p class="sub">这些规则写在代码里，模型改不了。右边是护栏的真实输出。</p></div><div class="panel">${GUARD_DEMOS.map(
    (demo, index) =>
      `<input type="radio" name="guard-demo" id="guard-${demo.id}" aria-label="${demo.label}"${index === 0 ? ' checked' : ''}>`,
  ).join(
    '',
  )}<div class="tabs">${GUARD_DEMOS.map((demo) => `<label for="guard-${demo.id}">${demo.label}</label>`).join('')}</div>${GUARD_DEMOS.map(
    (demo) =>
      `<div class="code mono" data-demo="${demo.id}"><p><i>1</i><span class="comment">模型原稿</span></p><p><i>2</i><span class="removed">- ${demo.draft}</span></p><p><i>3</i><span></span></p><p><i>4</i><span class="comment">发给客户</span></p><p><i>5</i><span class="added">+ ${demo.sent}</span></p></div>`,
  ).join('')}</div></div></section>`;
  const qa = (question: string, answer: string) => `<details><summary>${question}</summary><p>${answer}</p></details>`;
  const faq = `<section class="faq"><div class="wrap faq-grid"><h2>采购前最常问的几件事</h2><div class="faq-list">${[
    qa('AI 会不会报错价？', '金额由产品库和规则算出，不由模型决定。报价单要顾问批准后才发给客户。'),
    qa('库存是实时的吗？', '默认是已发布产品库的快照，不能当实时库存承诺。ERP 连接器按商家单独开通，共享试用环境没有接入。'),
    qa('客户要找真人怎么办？', '客户要求真人、投诉或需求超出范围时转给顾问。顾问接手后 AI 停止接待，在原渠道继续沟通。'),
    qa('能处理图片和 Excel 吗？', '可以。识别结果先整理成清单让客户确认，确认之后才算价。'),
    qa('支持在线收款吗？', '不支持。报价批准、客户接受后由顾问线下收款，系统只记录状态。'),
    qa('试用要准备什么？', '不用导入数据。共享试用环境已有合成产品库和示例会话，用顾问账号登录就能体验审批和接手。'),
  ].join('')}</div></div></section>`;
  const apply = `<section id="apply" class="apply"><div class="wrap"><h2>用一条询价<span>走完一次协作</span></h2><p>${e(input.applicationInstructions)}</p><p>试用为普通顾问账号，按需发放。没有自助注册或自动领取入口。</p><div class="actions"><a class="button primary" href="${docs}">先读快速开始</a><a class="button" href="${app}">已有账号，登录后台</a></div><p class="note">共享试用环境：合成种子与试用者自行发送的消息可能被同一试用公司的成员看到，请勿发送个人信息或正式客户资料。真实试用消息、客户资料及追踪记录保留 7 天；手动重置会同时清理种子和试用消息。</p></div></section>`;
  const steps = `<section class="wrap flow"><h2>重复的整理交给系统<em>关键的决定留给人</em></h2><ol class="steps"><li><span class="mono">01</span><h3>先收齐需求</h3><p>微信客服接收文字、图片与表格，识别多行询价，缺规格就继续确认。</p></li><li><span class="mono">02</span><h3>型号与数量对上</h3><p>匹配产品库中的编码、规格和库存，按阶梯价与起订量计算。</p></li><li class="human"><span class="mono">03</span><h3>确认之后再外发</h3><p>试算形成待审批报价，顾问批准后才能向客户发送正式报价链接。</p></li><li><span class="mono">04</span><h3>有需要，人来接</h3><p>客户要求真人或需求超出范围时转给顾问，在原渠道继续沟通。</p></li></ol></section>`;
  const chapter = (id: string, tag: string, title: string, text: string, points: string[], visual: string) =>
    `<section class="chapter" id="${id}"><div class="wrap chapter-grid"><div><p class="tag">${tag}</p><h2>${title}</h2><p class="sub">${text}</p><ul class="checks">${points.map((point) => `<li>${CHECK}${point}</li>`).join('')}</ul></div><div class="chapter-visual">${visual}</div></div></section>`;
  const intakeVisual = `<div class="card"><p class="card-title">识别到 6 行，请核对后确认</p><ol class="rows mono"><li><span>6205-2RS</span><span>40件</span></li><li><span>6206-2RS</span><span>40件</span></li><li><span>HS-K01-24</span><span>3件</span></li><li><span>HS-K10-24</span><span>3件</span></li><li><span>M8×30</span><span>60件</span></li><li><span>M8×40</span><span>60件</span></li></ol><p class="card-foot">确认之后才开始算价，可以直接改某一行。</p></div>`;
  const tierVisual = `<div class="card"><p class="card-title"><span class="mono">6207-2RS</span> 的数量档位</p><table class="tiers mono"><thead><tr><th scope="col">起订数量</th><th scope="col">含税单价</th></tr></thead><tbody><tr><td>2件</td><td>14.60元</td></tr><tr class="is-hit"><td>20件</td><td>13.14元<span>32 件落在这一档</span></td></tr><tr><td>100件</td><td>11.68元</td></tr><tr><td>200件</td><td>10.22元</td></tr></tbody></table><p class="card-foot">低于起订量的行不报价。</p></div>`;
  const chapters = [
    chapter(
      'intake',
      '收询价',
      '微信里怎么发，都接得住',
      '文字、截图和 Excel 都能进来。多行清单先整理成一张表，客户确认之后才算价，缺规格就接着问。',
      ['别名、全角、空格和大小写都能对上型号', '有多个候选时让客户选，不替客户定', '一次最多处理 30 行'],
      intakeVisual,
    ),
    chapter(
      'pricing',
      '算价格',
      '单价不靠模型记，靠档位算',
      '阶梯价、起订量和库存都在产品库里。试算由代码完成，模型只负责把结果讲清楚。',
      ['按数量自动选档，不用人工翻价目表', '产品库支持 CSV 批量导入', '库存是产品库快照，ERP 按商家单独开通'],
      tierVisual,
    ),
    chapter(
      'approval',
      '出报价',
      '顾问点头，报价才发出去',
      'AI 只起草报价单。顾问核对型号、数量和金额后批准，客户才收到正式报价；驳回就转给顾问接手。',
      ['新报价默认人工审批', '客户明确接受后，通知顾问安排收款', '产品不接在线支付，收款由顾问线下完成'],
      shotOf('quote-review.webp'),
    ),
  ].join('');
  const spec = (name: string, value: string) => `<div><dt>${name}</dt><dd>${value}</dd></div>`;
  const specs = `<section class="specs" id="specs"><div class="wrap"><h2>现在能做什么</h2><dl class="spec-sheet">${[
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
  const limits = `<section class="limits"><div class="wrap"><h2>按实际开通范围使用</h2><ul class="limit-list"><li>产品库库存是配置快照，不能视为实时库存承诺。</li><li>用量展示只对授权管理员开放，它不是服务账单。成员与渠道设置本期只读，变更由平台在维护窗口完成。</li><li>共享顾问账号可以处理会话与审批其负责的报价，不能修改产品库、销售话术或管理设置。</li></ul></div></section>`;
  const pages: Record<(typeof PUBLIC_SITE_PAGES)[number], [string, string]> = {
    '/': [
      `${PRODUCT_FOCUS}助手`,
      `<section class="wrap hero"><div><h1>接住每条询价<span>把报价交给规则</span></h1><div class="actions"><a class="button primary" href="#apply">申请试用账号</a><a class="button" href="/product/">了解产品能力</a></div></div><p class="lead">客户在微信发来型号和数量。<br>单来核对型号、查库存、按阶梯价试算，<br>起草报价单，交顾问批准后才发出。</p></section>${features}${proof}${screens}${guard}${faq}${apply}`,
    ],
    '/product/': [
      '产品能力',
      `<section class="wrap hero"><div><h1>询价往前走<span>边界留得住</span></h1><div class="actions"><a class="button primary" href="#apply">申请试用账号</a><a class="button" href="${docs}catalog.html">了解产品库</a></div></div><div><p class="lead">围绕工业销售日常，把接收、匹配、试算、审批和交接串成一条清楚的工作流。金额依据已发布的产品库和工具计算结果，未批准的报价不向客户外发。</p><nav class="jump" aria-label="本页目录"><a href="#intake">收询价</a><a href="#pricing">算价格</a><a href="#approval">出报价</a><a href="#specs">能力规格</a></nav></div></section>${steps}${chapters}${specs}${limits}${apply}`,
    ],
    '/privacy/': [
      '隐私政策',
      `<article class="prose"><p class="tag">隐私与数据</p><h1>隐私政策</h1><p>版本 ${e(input.legal.version)} · 生效日期 ${e(input.legal.effectiveDate)}</p><div class="legal">${e(fs.readFileSync(input.legal.privacyFile, 'utf8'))}</div></article>`,
    ],
    '/terms/': [
      '服务条款',
      `<article class="prose"><p class="tag">使用约定</p><h1>服务条款</h1><p>版本 ${e(input.legal.version)} · 生效日期 ${e(input.legal.effectiveDate)}</p><div class="legal">${e(fs.readFileSync(input.legal.termsFile, 'utf8'))}</div></article>`,
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
      '<article class="prose"><h1>这页没有找到。</h1><p>地址可能已经变更。可以回到首页，或从使用文档继续。</p><a class="button primary" href="/">回到首页</a></article>',
    ),
  );
  fs.writeFileSync(path.join(output, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(
    path.join(output, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PUBLIC_SITE_PAGES.map((route) => `<url><loc>${e(baseUrl(input.bases.www, route.slice(1)))}</loc></url>`).join('')}</urlset>`,
  );
}
