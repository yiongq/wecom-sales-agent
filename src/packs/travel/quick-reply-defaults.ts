// 旅游包的快捷回复默认模板（02 spec「快捷回复管理」、plan 第 22 步）：新租户首次读 /quick-replies 时，空表按这份写入。
// 这些是客户会在微信里看到的动态内容（顾问点一条插进输入框），不是界面配置——同 data/sop.md、产品库数据一样处理，
// 不进 UI 优先片扫描（scripts/fonts/ui-text.ts 只扫 console-pack.ts 这一个文件名，这里特意另起文件名避开）。
// 正文不含 markdown（QuickReplyBody 校验过），不写价格或承诺性的说法——价格由产品库与护栏算，这里只给话术骨架。
import type { QuickReplyDefault } from '../../shared/quick-reply-defaults.js';

export const travelQuickReplyDefaults: readonly QuickReplyDefault[] = [
  { title: '开场问候', body: '您好呀，我是云途定制旅行的顾问，看到您在了解旅行计划～方便先说说大概想去哪、和谁一起出行吗？' },
  { title: '问出行日期', body: '为了帮您核对行程安排，能说一下大概的出发日期吗？确定的日子或大概月份都可以，我来帮您看看合适的安排。' },
  { title: '问同行人数', body: '方便告诉我这次一共几位出行、有没有老人或小朋友同行吗？这样我才能帮您挑到更合适的线路。' },
  { title: '收到稍等', body: '您的需求我已经记下来了，正在帮您核对细节，马上给您回复，麻烦您稍等一下～' },
  { title: '致歉久等', body: '不好意思让您等久了，刚才在确认行程细节，现在继续为您安排。' },
  { title: '结束致谢', body: '谢谢您的耐心，有任何问题随时找我，祝您出行顺利！' },
];
