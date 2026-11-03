// A 路合入后由协调者用合成数据补图；不接收真实后台截图。
export const SCREENSHOTS = [
  {
    filename: 'rfq-workbench.webp',
    width: 2368,
    height: 1400,
    title: '询价工作台',
    description: '合成询价会话与工作台：对话、客户信息和快捷回复，不含真实客户信息。',
  },
  {
    filename: 'quote-review.webp',
    width: 592,
    height: 744,
    title: '报价审批',
    description: '合成报价单：待顾问审批，批准之后才发给客户。',
  },
  {
    filename: 'catalog-list.webp',
    width: 2368,
    height: 1100,
    title: '产品库',
    description: '合成产品库：型号、单价、现货数量和上架状态。',
  },
] as const;
