// 05 入口与体验数据说明；静态准备页和工作台共用。
export const SANDBOX_DATA_COPY = [
  '对话内容会发送给大模型服务商，用于生成AI回复。',
  '体验结束后，这份环境及其会话、订单、配置和微信绑定将整体删除。备份副本随保留期滚动清理：本地7天、异地30天。',
  '企业微信服务器上的聊天记录按企业微信的规则保存，不随这次体验一起删除。请只使用虚构的姓名、手机号等信息。',
] as const;
export const SHOWCASE_COPY = Object.freeze({
  title: '客户在微信里问，AI先接待',
  description: 'AI按你维护的话术和产品库回答、报价；拿不准或客户要找人时，转给你接手。',
});
export interface Showcase {
  src: string;
  alt: string;
}

/** 10 R16：未登录入口按 Host 下发的公开品牌，不携带租户内部配置。 */
export interface PublicEntryBrand {
  name: string;
  subtitle: string;
  image: Showcase | null;
}
