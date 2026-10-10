// 旅游主动跟进的阶段间隔、兜底话术与生成提示。
import type { FollowupTemplates, SalesStage } from '../../core/pack-api.js';

/** 各阶段沉默多久算「该追了」（分钟）。不在表里的阶段不追。 */
const IDLE_MINUTES: Partial<Record<SalesStage, number>> = {
  quote: 120, // 报价后沉默 2 小时：最该追的时刻
  closing: 180, // 订单已建但没付
  objection: 240, // 提了异议没下文
  recommend: 360, // 看过线路没反应，隔久一点再问
};

/** 兜底话术：LLM 不可用时按阶段发，每条都得是能直接发给客户的正经话。
 *  线路的天数和住宿是固定的（sop.md 能力边界），只提真做得到的：换出发日期或人数重新报价、看别的现成线路。
 *  此前写着「酒店档次都可以再商量」「换个思路搭配、出个新方案」，客户照着回就接不住 */
const TEMPLATE: Partial<Record<SalesStage, string>> = {
  quote: '前两天给您报的价格，不知道您还有什么顾虑？出发日期或人数有变化的话跟我说，我按新的给您重新报～',
  closing: '您的订单我还给您留着呢～名额是以付款为准的，要是日期或人数需要改，跟我说一声我重新安排。',
  // 不用「要不要我…」这种是非问句（sop.md 话术原则）：客户只会答「可以」，还得再问一轮
  objection: '上次您提到的顾虑我记着呢——您更在意价格，还是出发时间？告诉我，我按这个帮您挑别的现成线路，或换个日期重新报价～',
  recommend: '之前给您看的几条线路，感觉哪条更对味一些？或者告诉我哪里不合适，我再帮您挑～',
};

const DEFAULT_TEMPLATE = '想起您之前的行程，还有什么我能帮上忙的随时说～';

const SYSTEM =
  '你是高端定制旅行的销售顾问。客户在这轮对话后沉默了一段时间，写一条主动跟进的微信消息把他拉回来。' +
  '要求：≤60 字；提一个具体的、能让他一句话回复的问题（不要「在吗」「考虑得怎么样」这种空话）；' +
  '不要催付款、不要制造焦虑、不要用感叹号堆情绪；不出现价格数字和链接；' +
  '线路的天数和住宿是固定的，不要提缩短天数、换酒店档次、重新搭配行程；只输出消息正文。';

export const followupTemplates: FollowupTemplates = {
  idleMinutes: IDLE_MINUTES,
  byStage: TEMPLATE,
  fallback: DEFAULT_TEMPLATE,
  system: SYSTEM,
};
