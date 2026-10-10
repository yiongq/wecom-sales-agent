import type { PriceThresholds } from '../../core/pack-api.js';

// 04 第 8 步：旅游日期与人数政策，保持抽取前默认值。
export const travelDateThresholds = {
  maxTravelers: 50,
  bookableYears: 3,
} as const;

// 04 第 9 步：金额识别、出处容差与定价/低海拔政策，默认值等于抽取前。
// 千/万位权与差额取整仍是解析算法，不跟金额识别下限混用。
export const travelPriceThresholds: Readonly<PriceThresholds> = {
  minimumAmount: 1000,
  precisionTolerance: 0.5,
  tierTolerance: 5000,
  maxTravelers: travelDateThresholds.maxTravelers,
  groupMinimum: 4,
  groupDiscount: 0.95,
  peakMultiplier: 1.1,
  lowlandMaxAltitude: 2500,
};
