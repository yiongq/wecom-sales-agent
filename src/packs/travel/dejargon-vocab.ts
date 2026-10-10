// 旅游出口词表；引擎执行器与包运行时取同一份内容。
import type { DejargonVocab } from '../../core/pack-api.js';

// 中文话术里夹带英文商务词（「我按日期帮您确认 availability」）——一眼就不专业，
// 而且是低频偶发（实测 12 条里 0 条，靠提示词压不住也测不出改进）。这类"偶发但致命"
// 的东西按本项目一贯做法放在代码层。
//
// 不能一刀切抹英文：产品库里全是酒店品牌名（Four Seasons / Soneva Jani / Aman /
// Park Hyatt…）。判据用「被非英文字符包围的孤立英文词」——品牌名都是连续多个英文词，
// 天然不会命中；真正的夹带词则总是孤零零嵌在中文里。
const EN_JARGON: Record<string, string> = {
  availability: '档期',
  available: '有档期',
  schedule: '行程安排',
  budget: '预算',
  package: '套餐',
  option: '选择',
  options: '选择',
  confirm: '确认',
  confirmed: '已确认',
  booking: '预订',
  book: '预订',
  reserve: '预订',
  reservation: '预订',
  deal: '优惠',
  discount: '折扣',
  upgrade: '升级',
  update: '更新',
  price: '价格',
  quote: '报价',
  plan: '方案',
  check: '确认',
  notice: '提醒',
  free: '免费',
  flexible: '灵活',
  customize: '定制',
  customized: '定制',
  highlight: '亮点',
  highlights: '亮点',
  recommend: '推荐',
  itinerary: '行程',
  sorry: '抱歉',
  welcome: '欢迎',
  enjoy: '好好享受',
  tips: '小建议',
  tip: '小建议',
};

// 后台内部用语。盲评里两个模型都频繁说「库里没有…」「库里还有一条…」——照抄的是工具结果和 SOP 里
// 写给它看的话。源头已改（tools.ts / sop.md），出口再兜一道：偶发、低频、提示词压不干净，同 EN_JARGON 的道理。
// 「库里」只在前面是句首/标点/「我们」「目前」「另外」这类说法时才是内部用语。此前反过来列「不能碰」的字
//（车库里、仓库里、水库里…），列不全：「库里南」「地库里」「资料库里」「斯蒂芬·库里」全被改坏，
// 「我们这边库里」还会变成「我们这边我们这边」。漏替一次只是留个内部词，替错一次是一句读不通的话，所以按白名单来。
// 「库存」是库存，「线路库存紧张」不能改成「我们的线路存紧张」。
// 只处理模型写的原文：护栏自己的兜底话术（如「价格我得核准了再报给您」）在这之后才拼上去，不经过这里。
const INTERNAL_TERMS: [RegExp, string][] = [
  [/(?:(?:我们|咱们)的?)?(?:产品|线路)库(?!存)/g, '我们的线路'],
  [/(?:(?:我们|咱们)的?)?(?:精品)?酒店库(?!存)/g, '我们合作的酒店'],
  // 「这边库里」整体收成「我们这边」，不然下一条替完是「我们这边我们这边」
  [/(?:(?:我们|咱们)的?)?这边库里(?!南)/g, '我们这边'],
  // 「存在库里」「放在库里」是放东西的库房，不算
  [
    /(?:(?:我们|咱们)的?)?(?<=^|[\s，。！？、；：,.!?;:（(“"「【]|我们的?|咱们的?|目前|现在|暂时|当前|(?<![存放])在|从|另外|但是?|不过|其实|[查看]了?一?下)库里(?!南)/gm,
    '我们这边',
  ],
];

export const dejargonVocab: DejargonVocab = { english: EN_JARGON, internal: INTERNAL_TERMS };
