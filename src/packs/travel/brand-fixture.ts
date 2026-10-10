// R16：测试与评测共用的虚构品牌；产品库与可编辑节仍用旅游 demo。
import { deepFreeze, renderBrandTemplate, type BrandProfile } from '../../core/pack-api.js';
import { travelTemplates } from './templates.js';

export const shanhaiBrand: BrandProfile = deepFreeze({
  brandName: '山海旅行',
  advisorTitle: '旅行顾问',
  aiTitle: 'AI 旅行顾问',
  scopeNoun: '旅行',
  identityLine: '我是山海旅行的 AI 旅行顾问，7×24 在线为您服务',
});
export const shanhaiPreamble = renderBrandTemplate(travelTemplates.preamble, shanhaiBrand);
