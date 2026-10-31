import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PUBLIC_GUIDES, PUBLIC_SITE_PAGES, type ProductPublishInput } from '../../src/shared/product-surface.js';
import { buildProductSites } from './build.js';
import { checkArtifacts, filesUnder } from './check.js';
import { stageGuides, guideHref } from './content.js';
import { createSample } from './sample.js';
import { readPublishInput } from './input.js';
import { loadSearch, searchGuides, type SearchEntry } from '../../docs-site/.vitepress/theme/search.js';
import { SCREENSHOTS } from '../../site/screenshots.js';

fs.mkdirSync('var/product-sites', { recursive: true });
const directory = fs.mkdtempSync('var/product-sites/selftest-');
const withDocs = process.argv.includes('--with-docs');
let assertions = 0;
function check(name: string, run: () => void): void {
  run();
  assertions++;
  console.log(`PASS ${name}`);
}
try {
  const filename = createSample(path.join(directory, 'input'));
  const sample = JSON.parse(fs.readFileSync(filename, 'utf8')) as ProductPublishInput;
  const input = readPublishInput(filename);
  check('15 验收 10：合成输入遵循冻结 ProductPublishInput，三个 HTTPS 根分离', () =>
    assert.equal(new Set(Object.values(input.bases)).size, 3),
  );
  const badFile = path.join(directory, 'input/bad.json');
  const invalid = (change: (value: Record<string, unknown>) => void) => {
    const value = structuredClone(sample) as unknown as Record<string, unknown>;
    change(value);
    fs.writeFileSync(badFile, JSON.stringify(value));
    assert.throws(() => readPublishInput(badFile), /发布输入/);
  };
  check('15 验收 10：每一必填材料缺失均失败，不回落公开地址或法律模板', () => {
    for (const key of ['bases', 'logoFile', 'faviconFile', 'legal', 'applicationInstructions', 'sourceRepositoryUrl'])
      invalid((value) => {
        delete value[key];
      });
    for (const key of ['www', 'app', 'docs'])
      invalid((value) => {
        delete (value.bases as Record<string, unknown>)[key];
      });
    for (const key of ['privacyFile', 'termsFile', 'version', 'effectiveDate'])
      invalid((value) => {
        delete (value.legal as Record<string, unknown>)[key];
      });
    invalid((value) => {
      value.logoFile = 'missing.png';
    });
    invalid((value) => {
      (value.bases as Record<string, unknown>).app = 'http://app.example.test';
    });
    invalid((value) => {
      (value.bases as Record<string, unknown>).app = sample.bases.www;
    });
    invalid((value) => {
      (value.legal as Record<string, unknown>).effectiveDate = '2026-02-30';
    });
    invalid((value) => {
      (value.legal as Record<string, unknown>).privacyFile = path.resolve('site/legal-templates/privacy.txt');
    });
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/product-sites/build.ts', 'all'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /缺少必填发布输入/);
  });
  const source = path.join(directory, 'guides');
  fs.mkdirSync(source);
  for (const file of PUBLIC_GUIDES) fs.copyFileSync(path.join('docs/guides', file), path.join(source, file));
  fs.writeFileSync(path.join(source, 'private.md'), 'INTERNAL_ONLY_SENTINEL');
  const stage = path.join(directory, 'stage');
  stageGuides(source, stage);
  check('15 验收 1：仅六份批准正文进入暂存，不复制同目录的其他材料', () =>
    assert.deepEqual(fs.readdirSync(stage).toSorted(), [...PUBLIC_GUIDES].toSorted()),
  );
  check('15 验收 1：include、import、HTML、资源越界及软链接被拒绝', () => {
    const original = fs.readFileSync(path.join(source, PUBLIC_GUIDES[0]), 'utf8');
    for (const bad of [
      '\n<!--@include: ../private.md-->',
      '\nimport x from "../private.md"',
      '\n<script>alert(1)</script>',
      '\n[内部](../architecture/spec.md)',
      '\n![图](../../private.png)',
    ]) {
      fs.writeFileSync(path.join(source, PUBLIC_GUIDES[0]), original + bad);
      assert.throws(() => stageGuides(source, stage), /指南/);
    }
    fs.unlinkSync(path.join(source, PUBLIC_GUIDES[0]));
    fs.symlinkSync(path.resolve('docs/guides/quick-start.md'), path.join(source, PUBLIC_GUIDES[0]));
    assert.throws(() => stageGuides(source, stage), /白名单/);
  });
  await buildProductSites(withDocs ? 'all' : 'site', filename, directory);
  const site = path.join(directory, 'site/dist');
  const docs = path.join(directory, 'docs-site/dist');
  const roots = [{ directory: site, base: input.bases.www }];
  if (withDocs) roots.push({ directory: docs, base: input.bases.docs });
  check('15 验收 1：四类官网无 JS 可读，内链、锚点及资源存在', () => {
    checkArtifacts(roots, input);
    for (const route of PUBLIC_SITE_PAGES) {
      const html = fs.readFileSync(path.join(site, route, 'index.html'), 'utf8');
      assert.doesNotMatch(html, /<script|document\.cookie|\/api\//);
      assert.match(html, /<h1>/);
      assert.match(html, /跳到正文/);
    }
    const home = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
    assert.match(home, /工业询价/);
    assert.match(home, /等待顾问审批报价/);
    for (const shot of SCREENSHOTS) {
      assert.match(home, new RegExp(shot.description));
      if (fs.existsSync(path.join('site/screenshots', shot.filename))) assert.ok(home.includes(`/assets/${shot.filename}`));
      else assert.match(home, /合成截图待补/);
    }
    const css = fs.readFileSync(path.join(site, 'assets/style.css'), 'utf8');
    assert.match(css, /max-width: 760px/);
    assert.match(css, /focus-visible/);
  });
  check('15 验收 1：产物无内部文档、源码映射、真实标识或未登记主线', () => {
    const rendered = roots
      .flatMap((root) =>
        filesUnder(root.directory)
          .filter((file) => /\.(html|json|xml|js)$/.test(file))
          .map((file) => fs.readFileSync(file, 'utf8')),
      )
      .join('\n');
    assert.doesNotMatch(rendered, /INTERNAL_ONLY_SENTINEL|定制游|旅游|\/try(?:["'/]|\.html)|\/chat\.html|\/admin\.html/);
  });
  if (withDocs) {
    check('15 验收 1：真实 VitePress 六类指南与 404 无 JS 可读，跨站链接与本地索引完整', () => {
      const htmlFiles = filesUnder(docs).filter((file) => file.endsWith('.html'));
      assert.equal(htmlFiles.length, 7);
      for (const file of PUBLIC_GUIDES) {
        const html = fs
          .readFileSync(path.join(docs, guideHref(file) === '/' ? 'index.html' : guideHref(file).slice(1)), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        assert.match(html, /<h1[^>]*>/);
        assert.match(html, /class="vp-doc(?:\s|")/);
      }
      assert.match(fs.readFileSync(path.join(docs, '404.html'), 'utf8'), /回到首页/);
      const index = JSON.parse(fs.readFileSync(path.join(docs, 'search-index.json'), 'utf8')) as SearchEntry[];
      assert.equal(index.length, 6);
      assert.ok(searchGuides(index, '报价审批').length > 0);
      assert.deepEqual(searchGuides(index, '无匹配的合成词'), []);
      assert.deepEqual(searchGuides(index, ' '), []);
      assert.ok(searchGuides(index, '产品库 库存').length > 0);
      assert.equal(new Set(index.map((entry) => entry.href)).size, 6);
      for (const file of PUBLIC_GUIDES) {
        const html = fs.readFileSync(path.join(docs, guideHref(file) === '/' ? 'index.html' : guideHref(file).slice(1)), 'utf8');
        assert.match(html, /aria-label="指南目录"/);
      }
    });
  } else console.log('独立文档构建未执行：安装 docs-site 依赖后以 --with-docs 验证；主 CI 的内容自测不引入 VitePress');
  const fixture: SearchEntry[] = [{ title: '报价审批', href: '/faq.html', text: '产品库 库存' }];
  const index = await loadSearch(async () => new Response(JSON.stringify(fixture)), '/search-index.json');
  assert.equal(index.length, 1);
  assert.equal(searchGuides(index, '报价审批').length, 1);
  assert.deepEqual(searchGuides(index, '无匹配的合成词'), []);
  assert.deepEqual(searchGuides(index, ' '), []);
  assert.equal(searchGuides(index, '产品库 库存').length, 1);
  await assert.rejects(loadSearch(async () => new Response('', { status: 503 }), '/search-index.json'));
  await assert.rejects(loadSearch(async () => new Response('{}'), '/search-index.json'));
  check('15 验收 1：搜索失败可重试，空结果有清除入口，正文不依赖搜索', () => {
    const component = fs.readFileSync('docs-site/.vitepress/theme/Search.vue', 'utf8');
    assert.match(component, /重试搜索/);
    assert.match(component, /清除搜索/);
    assert.match(component, /aria-live/);
  });
  check('15 验收 1：泄漏或坏链接即使在资源、搜索或站点地图中也阻断', () => {
    const target = path.join(site, 'probe.json');
    for (const text of ['docs/architecture/internal.md', 'spec.md', 'ADR-006', 'postgresql://synthetic']) {
      fs.writeFileSync(target, text);
      assert.throws(() => checkArtifacts(roots, input), /内部或敏感/);
    }
    fs.unlinkSync(target);
    fs.writeFileSync(path.join(site, 'probe.map'), '{}');
    assert.throws(() => checkArtifacts(roots, input), /禁止的产物路径/);
    fs.unlinkSync(path.join(site, 'probe.map'));
    const broken = path.join(site, 'broken.html');
    fs.writeFileSync(broken, '<html lang="zh-CN"><main><a href="/missing/">坏链接</a></main></html>');
    assert.throws(() => checkArtifacts(roots, input), /内链或资源不存在/);
    fs.writeFileSync(broken, '<html lang="zh-CN"><main><a href="/#missing">坏锚点</a></main></html>');
    assert.throws(() => checkArtifacts(roots, input), /锚点不存在/);
    fs.unlinkSync(broken);
  });
  check('15 验收 2：双语 README 申请试用、不公开地址密码，开发者才讲第二行业包', () => {
    for (const [file, heading, developer] of [
      ['README.md', 'Request a trial account', 'Developer setup'],
      ['README.zh-CN.md', '申请试用账号', '开发者安装'],
    ]) {
      const body = fs.readFileSync(file!, 'utf8');
      assert.match(body, new RegExp(`## ${heading}`));
      assert.doesNotMatch(body, /https?:\/\/|在线体验|## Online demo|免登录体验/);
      assert.doesNotMatch(body.split(`## ${developer}`)[0]!, /旅游|travel/i);
      assert.match(body, /BRAND\.md/);
      assert.match(body, /MIT/);
      assert.match(body, /7/);
    }
    assert.match(fs.readFileSync('BRAND.md', 'utf8'), /不在 MIT 授权/);
  });
  console.log(`PRODUCT SITES SELFTEST PASS: ${assertions} 组；15 验收 1、2、10 内容部分`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
  if (withDocs) fs.rmSync('docs-site/.stage', { recursive: true, force: true });
}
