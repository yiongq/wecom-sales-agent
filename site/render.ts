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
  const nav = (active: string) =>
    `<nav aria-label="主导航"><a href="/product/"${active === '/product/' ? ' aria-current="page"' : ''}>产品能力</a><a href="${docs}">使用文档</a><a href="/#apply">申请试用</a><a href="${app}">登录后台 ↗</a></nav>`;
  const footer = `<footer><nav aria-label="页脚"><a href="${docs}">文档</a><a href="${app}">后台</a><a href="/privacy/">隐私政策</a><a href="/terms/">服务条款</a><a href="${repository}">开源代码</a><a href="${repository}/blob/HEAD/BRAND.md">品牌说明</a></nav><p>单来 · 工业询价。让询价有条理，让报价有依据。</p><p>软件代码采用 MIT 许可；「单来」名称与标识不在 MIT 授权内。商业事项另记。</p></footer>`;
  const shell = (route: string, title: string, body: string) =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · ${PRODUCT_NAME}</title><meta name="description" content="单来工业询价：接收询价，匹配型号，查阅产品库库存，按规则试算，审批报价与人工接手。"><link rel="canonical" href="${e(baseUrl(input.bases.www, route.slice(1)))}"><link rel="icon" href="/assets/${favicon}"><link rel="stylesheet" href="/assets/style.css"></head><body><a class="skip" href="#main">跳到正文</a><header><a class="brand" href="/"><img src="/assets/${logo}" alt="" width="28" height="28">${PRODUCT_NAME}</a>${nav(route)}</header><main id="main">${body}</main>${footer}</body></html>`;
  const workflow = `<ol class="steps"><li><span class="number">01 / 收询价</span><h3>先收齐需求</h3><p>微信客服接收文字、图片与表格，识别多行询价，缺规格就继续确认。</p></li><li><span class="number">02 / 匹配与试算</span><h3>型号与数量对上</h3><p>匹配产品库中的编码、规格和库存，按阶梯价与起订量计算。</p></li><li><span class="number">03 / 报价审批</span><h3>确认之后再外发</h3><p>试算形成待审批报价，顾问批准后才能向客户发送正式报价链接。</p></li><li><span class="number">04 / 人工接手</span><h3>有需要，人来接</h3><p>客户要求真人或需求超出范围时转给顾问，在原渠道继续沟通。</p></li></ol>`;
  const apply = `<section id="apply"><div class="section-head"><span class="eyebrow">开始了解</span><div><h2>用一条询价，走完一次协作。</h2><p>${e(input.applicationInstructions)}</p><p>试用为普通顾问账号，按需发放。没有自助注册或自动领取入口。</p><p class="note">共享试用环境：合成种子与试用者自行发送的消息可能被同一试用公司的成员看到，请勿发送个人信息或正式客户资料。真实试用消息、客户资料及追踪记录保留 7 天；手动重置会同时清理种子和试用消息。</p><div class="actions"><a class="button" href="${docs}">先读快速开始</a><a href="${app}">已有账号，登录后台 ↗</a></div></div></div></section>`;
  const pendingShots = SCREENSHOTS.some((shot) => !fs.existsSync(path.join('site/screenshots', shot.filename)));
  const gallery = `<section><div class="section-head"><span class="eyebrow">工作界面</span><div><h2>从询价到交接，看得见每一步。</h2><p>${pendingShots ? '截图将使用合成数据补齐，缺少的画面以文字占位，不是真实后台截图。' : '以下界面均使用合成数据，不包含真实会话与客户信息。'}</p></div></div><div class="gallery">${SCREENSHOTS.map(
    (shot) => {
      const source = path.join('site/screenshots', shot.filename);
      let media = `<div class="shot"><strong>${e(shot.title)}</strong><span>合成截图待补 · ${shot.width} × ${shot.height}</span></div>`;
      if (fs.existsSync(source)) {
        if (!fs.lstatSync(source).isFile()) throw new Error('截图必须是登记的普通文件');
        fs.copyFileSync(source, path.join(output, 'assets', shot.filename));
        media = `<div class="shot"><img src="/assets/${shot.filename}" alt="${e(shot.description)}" width="${shot.width}" height="${shot.height}" loading="lazy"></div>`;
      }
      return `<figure>${media}<figcaption>${e(shot.description)}</figcaption></figure>`;
    },
  ).join('')}</div></section>`;
  const pages: Record<(typeof PUBLIC_SITE_PAGES)[number], [string, string]> = {
    '/': [
      `${PRODUCT_FOCUS}助手`,
      `<div class="hero"><div><p class="eyebrow">单来 / 工业询价助手</p><h1>接住每条询价，<br>把报价交给规则。</h1><p class="lead">认型号、核数量、查库存、做试算。让 AI 整理需求，让顾问把住报价与承诺。</p><div class="actions"><a class="button" href="#apply">申请试用账号</a><a href="/product/">了解产品流程 →</a></div></div><aside class="rfq" aria-label="合成询价流程示例"><p class="eyebrow">一条询价 / 合成示例</p><dl><dt>客户需求</dt><dd>示例轴承 A-204 · 20 件</dd><dt>系统整理</dt><dd>匹配编码 → 核对规格 → 按量试算</dd><dt>下一步</dt><dd><span class="status">等待顾问审批报价</span></dd></dl><p class="note">库存来自已发布产品库；不代表实时 ERP 库存。</p></aside></div><section><div class="section-head"><span class="eyebrow">协作流程</span><h2>重复的整理交给系统，<br>关键的决定留给人。</h2></div>${workflow}</section>${gallery}${apply}`,
    ],
    '/product/': [
      '产品能力',
      `<div class="hero"><div><p class="eyebrow">产品能力</p><h1>询价往前走，<br>边界留得住。</h1><p class="lead">围绕工业销售日常，把接收、匹配、试算、审批和交接串成一条清楚的工作流。</p></div><div><h2>每份报价，都有来处。</h2><p>金额依据已发布的产品库和工具计算结果；模型负责理解与表达。未批准的报价不向客户外发。</p><a href="${docs}catalog.html">了解产品库 →</a></div></div><section>${workflow}</section><section><div class="section-head"><span class="eyebrow">使用边界</span><div><h2>按实际开通范围使用。</h2><p>产品库库存是配置快照。ERP 连接器代码已具备，尚未上线，不能视为实时库存承诺。</p><p>用量展示依赖联合发布验证，尚未上线；它不是服务账单。成员与渠道设置本期只读，变更由平台在维护窗口完成。</p><p>共享顾问账号可以处理会话与审批其负责的报价，不能修改产品库、销售话术或管理设置。</p></div></div></section>${apply}`,
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
