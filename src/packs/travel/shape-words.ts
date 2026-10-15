// 06 R10：旅游包给 shape_check 的阈值与可删句（核心的 shape_check 经 thresholds.shape 读取）。
// 上限：推荐 / 报价类 6 行、普通类 3 行，字数 300（owner 2026-10-15 定）。可删句只在这里定义，不进 reply-helpers.ts。
import type { ShapePolicy } from '../../core/pack-api.js';
import { HAS_CLOSING, isClosingTurn, type ClosingTurnPatterns } from './closing-words.js';

/** 本轮调过其中任一工具的回复算推荐 / 报价类（线路、报价、方案书、订单） */
const RICH_TOOLS = ['search_routes', 'get_route_detail', 'create_quote', 'generate_proposal', 'create_order'] as const;

// 非收尾轮里的祝福、期待、「有问题随时…」
const BLESS =
  /祝.{0,10}(?:愉快|顺利|开心|旅途|生活)|期待|随时(?:跟|联系|找|告诉|问|call|说|吩咐)|有(?:任何)?(?:问题|疑问|需要).{0,8}(?:随时|告诉|联系|找我)|欢迎(?:随时|继续)|等(?:您|你)(?:的)?(?:消息|回复)/;
const PROPOSAL_NOTE = /方案书/;
// 线路名行：《…》，或「· 云南 丽江大理 6 日」「云南 丽江大理·洱海古城 6 日游」这类以「N 日（游）」收尾的短行
const ROUTE_TITLE = /《[^》]+》|^[·\s]*[^，。：]{2,30}\d+\s*日(?:游)?(?:（[^）]*）)?$/;

export interface TravelShapeSources extends ClosingTurnPatterns {
  PRICE_ASK: RegExp;
}

export const TRAVEL_SHAPE_LIMITS = { richMaxLines: 6, plainMaxLines: 3, maxChars: 300 } as const;

export function createTravelShapePolicy(sources: TravelShapeSources): ShapePolicy {
  return {
    ...TRAVEL_SHAPE_LIMITS,
    richTools: RICH_TOOLS,
    asksPrice: (inputText) => sources.PRICE_ASK.test(inputText),
    isClosingTurn: (inputText) => isClosingTurn(inputText, sources),
    isRouteTitleLine: (line) => ROUTE_TITLE.test(line.trim()),
    isClosingLine: (sentence) => HAS_CLOSING.test(sentence),
    proposalSent: (session) => session.reminders?.proposalSent !== undefined,
    droppable(sentence, info) {
      if (!info.closingTurn && BLESS.test(sentence)) return '祝福/期待/随时';
      if (info.proposalSent && PROPOSAL_NOTE.test(sentence)) return '方案书说明(已发过)';
      if (!info.askedPrice && info.amounts.length && info.amounts.every((a) => info.priorAmounts.has(a))) return '旧报价复述';
      return null;
    },
  };
}
