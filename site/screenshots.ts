// A 路合入后由协调者用合成数据补图；不接收真实后台截图。
export const SCREENSHOTS = [
  {
    filename: 'rfq-workbench.webp',
    width: 1600,
    height: 1000,
    title: '询价工作台',
    description: '合成多行询价与待补规格；显示接手入口，不含客户信息。',
  },
  {
    filename: 'quote-review.webp',
    width: 1600,
    height: 1000,
    title: '报价审批',
    description: '合成型号、数量与试算明细；展示待审批及批准后外发的边界。',
  },
  {
    filename: 'settings-readonly.webp',
    width: 1600,
    height: 1000,
    title: '只读设置',
    description: '合成组织与渠道状态；不展示邮箱、回调地址、真实标识或凭据。',
  },
] as const;
