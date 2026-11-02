/** 官网写的是「护栏的真实输出」：每一条都由 src/industrial-domain.selftest.ts 跑真实护栏核对。 */
export const GUARD_DEMOS = [
  { id: 'discount', label: '折扣', draft: '这批给您打九折。', sent: '价格按数量档位执行，额外优惠需要顾问确认。' },
  { id: 'stock', label: '库存和交期', draft: '库存 200 件，明天就能发。', sent: '库存和交期以顾问确认为准。' },
  { id: 'shipping', label: '运费', draft: '运费另计。', sent: '运费0元。' },
  { id: 'payment', label: '收款', draft: '货款打给顾问就行。', sent: '收款账户以顾问提供的公司账户为准。' },
] as const;
