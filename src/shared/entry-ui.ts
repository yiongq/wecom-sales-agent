// 05 入口与体验数据说明；静态准备页和工作台共用。
export const SANDBOX_DATA_COPY = [
  '体验结束后，这份环境及其会话、订单、配置和微信绑定将整体删除。备份副本随保留期滚动清理：本地7天、异地30天。',
  '企微服务器上的聊天记录按企微的规则保存，不随沙箱删除。请只使用虚构的姓名、手机号等信息。',
] as const;
export const SHOWCASE_COPY = Object.freeze({
  title: '客户在微信里问，AI先接待',
  description: 'AI按你维护的话术和产品库回答、报价；拿不准或客户要找人时，转给你接手。',
});
export interface Showcase {
  src: string;
  alt: string;
}
