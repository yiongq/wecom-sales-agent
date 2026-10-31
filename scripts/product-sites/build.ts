import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PUBLIC_GUIDES, PRODUCT_NAME } from '../../src/shared/product-surface.js';
import { readPublishInput, baseUrl } from './input.js';
import { createSample } from './sample.js';
import { copyFonts } from './fonts.js';
import { GUIDE_TITLES, guideHref, stageGuides } from './content.js';
import { checkArtifacts } from './check.js';
import { buildSite } from '../../site/render.js';

export async function buildProductSites(mode: 'all' | 'site' | 'docs', filename: string, outputRoot = '.'): Promise<void> {
  // 在删除旧产物前完成材料验证；缺项不产生可发布的新目录。
  const input = readPublishInput(filename);
  const siteDist = path.resolve(outputRoot, 'site/dist');
  const docsDist = path.resolve(outputRoot, 'docs-site/dist');
  const roots: { directory: string; base: string }[] = [];
  try {
    if (mode !== 'docs') {
      fs.rmSync(siteDist, { recursive: true, force: true });
      buildSite(input, siteDist);
      roots.push({ directory: siteDist, base: input.bases.www });
    }
    if (mode !== 'site') {
      const stage = path.resolve('docs-site/.stage');
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(path.join(stage, '.vitepress'), { recursive: true });
      stageGuides('docs/guides', path.join(stage, 'content'));
      fs.cpSync('docs-site/.vitepress/theme', path.join(stage, '.vitepress/theme'), { recursive: true });
      const publicDir = path.join(stage, 'content/public');
      fs.mkdirSync(publicDir, { recursive: true });
      copyFonts(path.join(publicDir, 'fonts'));
      const licenses = path.join(publicDir, 'licenses');
      fs.mkdirSync(licenses, { recursive: true });
      fs.copyFileSync('docs-site/NOTICE', path.join(licenses, 'NOTICE.txt'));
      fs.copyFileSync('docs-site/node_modules/vitepress/LICENSE', path.join(licenses, 'VitePress-MIT.txt'));
      const dependency = createRequire(fs.realpathSync('docs-site/node_modules/vitepress/package.json'));
      for (const name of ['vue', '@vueuse/core', '@vueuse/shared']) {
        const packageDir = path.dirname(dependency.resolve(`${name}/package.json`));
        fs.copyFileSync(path.join(packageDir, 'LICENSE'), path.join(licenses, `${name.replace(/[@/]/g, '-')}-MIT.txt`));
      }
      fs.copyFileSync(input.logoFile, path.join(publicDir, `logo${path.extname(input.logoFile)}`));
      fs.copyFileSync(input.faviconFile, path.join(publicDir, `favicon${path.extname(input.faviconFile)}`));
      const links = PUBLIC_GUIDES.map((file, index) => ({ text: GUIDE_TITLES[index], link: guideHref(file) }));
      const search = PUBLIC_GUIDES.map((file, index) => ({
        title: GUIDE_TITLES[index],
        href: guideHref(file),
        text: fs
          .readFileSync(path.join(stage, 'content', file), 'utf8')
          .replace(/[#*`]/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/\s+/g, ' ')
          .trim(),
      }));
      fs.writeFileSync(path.join(publicDir, 'search-index.json'), JSON.stringify(search));
      fs.writeFileSync(path.join(publicDir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
      const config = {
        srcDir: 'content',
        outDir: docsDist,
        lang: 'zh-CN',
        title: `${PRODUCT_NAME}文档`,
        description: '工业询价使用指南：从接收询价到审批与接手。',
        appearance: false,
        lastUpdated: false,
        cleanUrls: false,
        rewrites: { 'quick-start.md': 'index.md' },
        sitemap: { hostname: input.bases.docs },
        head: [['link', { rel: 'icon', href: `/favicon${path.extname(input.faviconFile)}` }]],
        themeConfig: {
          logo: `/logo${path.extname(input.logoFile)}`,
          siteTitle: `${PRODUCT_NAME}文档`,
          nav: [
            { text: '官网', link: baseUrl(input.bases.www) },
            { text: '登录后台', link: baseUrl(input.bases.app) },
          ],
          sidebar: links,
          outline: { label: '本页内容' },
          docFooter: { prev: '上一篇', next: '下一篇' },
          darkModeSwitchLabel: '主题',
          sidebarMenuLabel: '目录',
          returnToTopLabel: '回到顶部',
          notFound: { title: '页面未找到', quote: '可以从目录重新开始阅读。', linkLabel: '回到首页', linkText: '回到首页' },
          footer: { message: '软件代码采用 MIT 许可；单来名称与标识不在 MIT 授权内。', copyright: '工业询价使用指南' },
        },
        vite: { build: { sourcemap: false, assetsInlineLimit: 0, emptyOutDir: true } },
      };
      fs.writeFileSync(path.join(stage, '.vitepress/config.mts'), `export default ${JSON.stringify(config, null, 2)};\n`);
      const result = spawnSync(process.execPath, ['node_modules/vitepress/bin/vitepress.js', 'build', '.stage'], {
        cwd: 'docs-site',
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 2_000_000,
      });
      if (result.status !== 0) {
        fs.rmSync(docsDist, { recursive: true, force: true });
        // 构建失败不打印配置、地址或法律正文。仅保留非私有的状态。
        throw new Error('文档构建失败；请检查指南链接及独立 VitePress 安装');
      }
      // VitePress 默认生成的 404 只有客户端挂载壳；替换为无 JS 可读的错误页。
      fs.writeFileSync(
        path.join(docsDist, '404.html'),
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>页面未找到 · 单来文档</title><link rel="stylesheet" href="/fonts/fonts.css"><style>body{font-family:Geist,"Noto Sans SC",sans-serif;color:#18181b;background:#f6f6f7;margin:10%;line-height:1.8}h1{font-weight:600}a{color:#255cdf}a:focus-visible{outline:3px solid #2b63e6;outline-offset:4px}</style></head><body><main><h1>页面未找到</h1><p>这个地址没有对应的指南，请从目录重新开始阅读。</p><a href="/">回到首页</a></main></body></html>',
      );
      roots.push({ directory: docsDist, base: input.bases.docs });
    }
    checkArtifacts(roots, input);
  } catch (error) {
    for (const directory of [mode !== 'docs' && siteDist, mode !== 'site' && docsDist]) {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (mode !== 'site') fs.rmSync('docs-site/.stage', { recursive: true, force: true });
  }
  console.log(`产品静态站构建通过：${mode}；白名单、资源和锚点检查通过`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const requestedMode = args[0];
  process.chdir(fileURLToPath(new URL('../..', import.meta.url)));
  try {
    if (!['all', 'site', 'docs'].includes(requestedMode)) throw new Error('构建模式必须是 all、site 或 docs');
    const inputIndex = args.indexOf('--input');
    const filename = args.includes('--sample') ? createSample('var/product-sites/sample') : args[inputIndex + 1];
    if ((inputIndex < 0 && !args.includes('--sample')) || !filename)
      throw new Error('缺少必填发布输入；使用 --input 指定私有 JSON，或显式 --sample 本地验证');
    await buildProductSites(requestedMode as 'all' | 'site' | 'docs', filename);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '静态站构建失败');
    process.exitCode = 1;
  }
}
