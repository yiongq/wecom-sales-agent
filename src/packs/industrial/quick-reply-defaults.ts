import type { QuickReplyDefault } from '../../core/pack-api.js';
export const industrialQuickReplies: readonly QuickReplyDefault[] = [
  { title: '收集需求', body: '您好，请按每行一个型号和数量发给我，我帮您核对。' },
  { title: '确认型号', body: '请确认具体型号和规格，候选型号需要您选定后才能准确试算。' },
  { title: '正式报价', body: '需要正式报价单的话，请确认本次型号与数量，我帮您起草交顾问审核。' },
  { title: '库存交期', body: '库存与交期以顾问确认为准，我请顾问继续跟您核对。' },
  { title: '票据与收款', body: '开票信息和付款安排由顾问与您确认，请勿向未经确认的账户付款。' },
];
