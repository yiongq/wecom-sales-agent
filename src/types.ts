// 全项目共享契约。构建各模块时以此为准，不要私自改动已有字段。

/** 销售阶段，由引擎在每轮回复后判定 */
export type SalesStage =
  | 'greeting' // 开场破冰
  | 'discovery' // 问需：目的地/人数/日期/预算
  | 'recommend' // 推荐线路
  | 'quote' // 报价
  | 'objection' // 异议处理
  | 'closing' // 促成下单
  | 'paid' // 已支付
  | 'handoff'; // 已转人工

export interface ChatMessage {
  role: 'customer' | 'agent' | 'system';
  content: string;
  at: number;
}

/** 从对话中沉淀的客户画像，引擎每轮增量更新 */
/** 客群五分类。高端定制旅行行业通行分法 */
export type SalesSegment = '家庭' | '亲子' | '蜜月' | '商务' | '银发';
export const SALES_SEGMENTS: SalesSegment[] = ['家庭', '亲子', '蜜月', '商务', '银发'];

export interface CustomerProfile {
  destinationInterest?: string;
  /** 客群：从客户原话识别（带娃/爸妈/蜜月/团建…），用于选线与后台分层 */
  segment?: SalesSegment;
  travelers?: string;
  dates?: string;
  budget?: string;
  notes?: string[];
  /** 微信昵称/头像，企微渠道经 kf/customer/batchget 拉取，后台展示用 */
  nickname?: string;
  avatar?: string;
}

export interface Session {
  id: string;
  channel: string; // 'simulator' | 'wecom'
  stage: SalesStage;
  profile: CustomerProfile;
  messages: ChatMessage[];
  orderIds: string[];
  handedOver: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * 最近一次报价的线路上下文，用于成单安全网（引擎兜底调 create_order）。
   * perPerson/total/departDate 三个字段同时喂给价格护栏：护栏的白名单只按写死的
   * 定价规则枚举，枚举不到的真实报价（如 20 人以上团）会被自己的护栏判成「编造价格」，
   * 而 price-guard 里本来就有读这两个字段的分支——不写就是死代码。
   */
  lastQuote?: {
    routeId: string;
    routeTitle: string;
    travelers: number;
    perPerson?: number;
    total?: number;
    departDate?: string;
  };
  /**
   * 被转人工「吸」走之前的销售阶段，交还 AI 时原样还原。
   * 没有它就只能从 orderIds/lastQuote 反推，而反推对「阶段已经推进、但推进过程
   * 不是本系统记录的」会话必然失真——比如种子演示会话 stage=quote 却没有 lastQuote，
   * 一次「接管→交还」就把客户从报价打回问需，漏斗数字跟着倒退且不可逆。
   */
  stageBeforeHandoff?: SalesStage;
}

/** data/routes.json 的条目结构 */
export interface Route {
  id: string;
  title: string;
  destination: string;
  days: number;
  priceFrom: number; // 每人起价，元
  hotelLevel: string; // 如「五星/奢华度假村」
  bestSeason: string;
  highlights: string[];
  tags: string[]; // 如「蜜月」「亲子」「海岛」
  /** 适配客群。高端定制旅行普遍按家庭/亲子/蜜月/商务/银发五类讲产品，这是独立于
   *  自由标签的一个维度：银发看的是海拔与节奏，商务看的是天数与场面，不能混在 tags 里。 */
  segments: SalesSegment[];
  /** 逐日行程。定制旅行的核心交付物是行程书，不能让模型凭 highlights 现编 */
  itinerary?: { day: number; title: string; detail: string; hotel: string; meals: string }[];
  inclusions?: string[];
  exclusions?: string[];
}

/** data/hotels.json 的条目结构（独立酒店库，供酒店推荐） */
export interface Hotel {
  id: string;
  name: string;
  destination: string;
  stars: string; // 如「五星」「奢华」
  nightlyFrom: number; // 每晚起价，元
  roomType: string; // 主推房型，如「水上别墅」「海景套房」
  highlights: string[];
  tags: string[]; // 如「蜜月」「亲子」「一价全包」
}

export interface Order {
  id: string;
  sessionId: string;
  routeId: string;
  routeTitle: string;
  travelers: number;
  departDate: string;
  totalPrice: number; // 元
  status: 'pending_payment' | 'paid' | 'cancelled';
  createdAt: number;
  paidAt?: number;
}

/** 引擎对一条客户消息的处理结果 */
export interface AgentReply {
  text: string;
  stage: SalesStage;
  handoff?: boolean;
  orderId?: string; // 本轮创建了订单时携带
  silent?: boolean; // true 时不应向客户发送任何消息（转人工后 AI 沉默）
}

/**
 * 渠道适配器：模拟器和企微都实现它。
 * push 用于服务端主动推消息（如支付成功后的跟进），
 * 模拟器经 SSE 下发，企微经 API 发送。
 */
export interface ChannelAdapter {
  name: string;
  /** 返回 false 表示确定发送失败（如企微 API 报错），调用方据此提示操作者 */
  push(sessionId: string, text: string): Promise<boolean>;
}
