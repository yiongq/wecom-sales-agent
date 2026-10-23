// 旧版模式（demo）的品牌档案：旧版固定文字里的「云途定制旅行」等字面量由它按模板渲染得来（07 R3），
// 也是 PackRuntime.defaultBrand。identityLine 加「～」就是 legacy.ts 的 identityAnswer（自测守着）。
import type { BrandProfile } from '../../core/pack-api.js';

export const demoBrand: BrandProfile = {
  brandName: '云途定制旅行',
  advisorTitle: '旅行顾问',
  aiTitle: 'AI 旅行顾问',
  scopeNoun: '旅行',
  identityLine: '我是云途定制旅行的 AI 旅行顾问，7×24 在线为您服务',
};
