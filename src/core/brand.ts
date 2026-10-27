// R4、R6：只接收捕获的品牌快照，不读租户表或配置源。
import type { BrandPage, BrandPageSlot, BrandProfile, BrandTexts, PackRuntime } from './pack-api.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function renderBrandTemplate(template: string, brand: BrandProfile, escape: (s: string) => string = (s) => s): string {
  const values = { ...brand, brandInitial: graphemes.segment(brand.brandName)[Symbol.iterator]().next().value?.segment ?? '' };
  return template.replace(/\{(brandName|advisorTitle|aiTitle|scopeNoun|identityLine|brandInitial)\}/g, (_match, key: keyof typeof values) =>
    escape(values[key]),
  );
}

export function brandTexts(runtime: PackRuntime, brand: BrandProfile | null): BrandTexts {
  if (brand === null) return runtime.legacy;
  const t = runtime.templates;
  return {
    identityAnswer: renderBrandTemplate(t.identityAnswer, brand),
    offTopicReply: renderBrandTemplate(t.offTopicReply, brand),
    welcomeText: renderBrandTemplate(t.welcomeText, brand),
    welcomeBackText: renderBrandTemplate(t.welcomeBackText, brand),
    webWelcome: renderBrandTemplate(t.webWelcome, brand),
    mockOpening: renderBrandTemplate(t.mockOpening, brand),
    quickReplies: t.quickReplies.map((q) => ({ title: q.title, body: renderBrandTemplate(q.body, brand) })),
  };
}

const htmlEscape = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
// 片段插在既有 JS 字符串里；同时防止 HTML 的 script 提前结束。
const jsEscape = (s: string): string =>
  JSON.stringify(s)
    .slice(1, -1)
    .replaceAll("'", '\\u0027')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
const jsTemplateEscape = (s: string): string => jsEscape(s).replaceAll('`', '\\`').replaceAll('${', '\\${');

/** 旧版直接返回源文件；模板模式按包声明的槽位一次替换，品牌文本按所在上下文转义。 */
export function renderBrandPage(html: string, page: BrandPage, runtime: PackRuntime, brand: BrandProfile | null): string {
  if (brand === null && runtime.id === 'travel') return html;
  const effectiveBrand = brand ?? runtime.defaultBrand;
  // 旧旅游页面保持字节；新包未声明的公共页面槽用中性文本，不能泄漏模板里的其他品牌。
  const defaults: BrandPageSlot[] =
    runtime.id === 'travel'
      ? []
      : page === 'web'
        ? [
            { legacy: 'AI 旅行顾问 · 可转真人', template: '{aiTitle} · 可转真人', context: 'html-text' },
            { legacy: '想去哪儿玩？聊聊您的旅行计划…', template: '请描述您的需求…', context: 'html-attribute' },
            { legacy: '想去西藏，两个人', template: '我想了解产品', context: 'html-attribute' },
            { legacy: '西藏两人游', template: '了解产品', context: 'html-text' },
          ]
        : page === 'quote'
          ? [{ legacy: '方盒核验社', template: '{brandName}', context: 'html-text' }]
          : [];
  const slots = [...defaults, ...(runtime.templates.pages[page] ?? [])];
  if (!slots.length) return html;
  const byText = new Map(slots.map((slot) => [slot.legacy, slot]));
  const pattern = [...byText.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return html.replace(new RegExp(pattern, 'g'), (matched) => {
    const slot = byText.get(matched)!;
    const isHtml = slot.context === 'html-text' || slot.context === 'html-attribute';
    const text = renderBrandTemplate(slot.template, effectiveBrand, isHtml || slot.htmlContext ? htmlEscape : (s) => s);
    if (isHtml) return text;
    return slot.context === 'js-template' ? jsTemplateEscape(text) : jsEscape(text);
  });
}
