// 行业包默认快捷回复模板的形状（02 spec「快捷回复管理」、plan 第 22 步）。只有这个类型是共享的——取值在
// src/packs/<包>/quick-reply-defaults.ts，由 src/packs/registry.ts 的 defaultQuickRepliesOf 按 packId 查到，
// 只在服务端用（新租户首次读 /quick-replies 时写入一次），不下发给前端、不进 IndustryPack。
export interface QuickReplyDefault {
  readonly title: string;
  readonly body: string;
}
