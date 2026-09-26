// 客户常点名、我们却没有现成线路的旅行目的地表，以及按整词认地名的口径。从 src/tools.ts 搬出来：
// 后台新建、上架线路时配置层也要查它，而配置层不能 import tools（01 spec「模块与依赖方向」）。只依赖 src/shared
import type { CatalogKind } from './catalog.js';

/**
 * 客户常点名、我们却没有现成线路的旅行目的地。引擎据此预取 search_routes（见 engine.ts planPrefetch）：
 * 此前只认得库里有的目的地，「想去南极」不预取，模型偶尔一个工具都不调，直接编一条「南极深度体验线」
 * 配上别的线路的真实价格发给客户。
 * 来源：实测客户问过的（南极、冰岛、埃及…）、llm.ts 离线脚本里的库外目的地（新西兰、迪拜、意大利、肯尼亚、摩洛哥、法国），
 * 加上出境游常见的国家、海岛和国内热门目的地。口径：
 *   · 只收说出来就是「想去那儿」的叫法。上海、广州、深圳、杭州这类常被说成出发地的大城市不收——
 *     「上海这边两个人想出去玩」被当成目的地，模型会对客户说「我们暂时没有上海的线路」；
 *   · 表里的地名后来有了线路（tools.ts 的 catalogCovers 对得上）自动按库内处理，不必回来删；
 *   · 一个地名是另一个的一部分时加边界：「北海」不吃「北海道」，「北极」不吃「北极光」（说的是极光，北欧线就有），
 *     「蒙古」不吃「内蒙古」，「罗马」不吃「罗马尼亚」。线路的目的地、别名碰上这几个地名时按同样的边界认（mentionsPlace），
 *     后台新建、上架时直接拒（placeNameIssues）。
 *
 * 每组标了类型（kind）：目的地我们没有时，「最接近的现成线路」先挑同类型的（见 tools.ts 的 KIND_ROUTES），再由语义召回补足。
 * 此前只靠语义召回：「马代去过了 想去普吉岛或者斐济 度蜜月」召回的是云南、四川高原线（B08 2/2、回归 retrieval-02 3/3），
 * 巴厘岛一次都没出现——客户要的是海岛，推一条要上 4500 米的线只会让人觉得没在听。
 * 没标类型的（中东非洲、美洲大洋洲、港澳台、印度）我们没有可比的线，照旧交给语义召回。
 */
export type PlaceKind = '海岛' | '极地冰雪' | '欧洲' | '东南亚' | '日韩' | '藏地' | '高原' | '草原戈壁' | '山水' | '古城' | '云南';
export const OFF_CATALOG_GROUPS: { kind?: PlaceKind; abroad: boolean; places: string[] }[] = [
  // 海岛、海滨（境外）
  {
    kind: '海岛',
    abroad: true,
    places: [
      '普吉岛',
      '苏梅岛',
      '长滩岛',
      '薄荷岛',
      '济州岛',
      '冲绳',
      '沙巴',
      '兰卡威',
      '岘港',
      '斯里兰卡',
      '毛里求斯',
      '塞舌尔',
      '马达加斯加',
      '夏威夷',
      '斐济',
      '大溪地',
      '关岛',
      '塞班',
      '圣托里尼',
      '西西里',
    ],
  },
  { kind: '极地冰雪', abroad: true, places: ['南极', '北极(?!光)', '冰岛', '挪威', '瑞典', '阿拉斯加', '贝加尔湖'] },
  {
    kind: '欧洲',
    abroad: true,
    places: [
      '丹麦',
      '英国',
      '伦敦',
      '苏格兰',
      '爱尔兰',
      '法国',
      '巴黎',
      '普罗旺斯',
      '意大利',
      '罗马(?!尼亚)',
      '威尼斯',
      '佛罗伦萨',
      '西班牙',
      '巴塞罗那',
      '葡萄牙',
      '德国',
      '奥地利',
      '捷克',
      '布拉格',
      '匈牙利',
      '荷兰',
      '希腊',
      '克罗地亚',
      '土耳其',
      '伊斯坦布尔',
      '卡帕多奇亚',
      '俄罗斯',
      '格鲁吉亚',
    ],
  },
  { kind: '东南亚', abroad: true, places: ['泰国', '清迈', '越南', '柬埔寨', '吴哥窟', '老挝', '缅甸', '新加坡', '马来西亚', '菲律宾'] },
  // 日本我们有线；北海道不在那几条里
  { kind: '日韩', abroad: true, places: ['韩国', '首尔', '北海道'] },
  // 喜马拉雅那一片，最接近的是西藏
  { kind: '藏地', abroad: true, places: ['尼泊尔', '不丹'] },
  { kind: '草原戈壁', abroad: true, places: ['(?<!内)蒙古'] },
  {
    abroad: true,
    places: [
      '埃及',
      '迪拜',
      '阿联酋',
      '阿布扎比',
      '约旦',
      '以色列',
      '摩洛哥',
      '肯尼亚',
      '坦桑尼亚',
      '南非',
      '非洲',
      '美国',
      '纽约',
      '洛杉矶',
      '黄石',
      '加拿大',
      '墨西哥',
      '古巴',
      '秘鲁',
      '巴西',
      '阿根廷',
      '智利',
      '南美',
      '澳大利亚',
      '澳洲',
      '新西兰',
      // 「印度」不吃「印度尼西亚」（巴厘岛那条的别名）和「印度洋」（马代就在印度洋上）
      '印度(?!尼西亚|洋)',
      '香港',
      '澳门',
      '台湾',
    ],
  },
  // 国内（海南、川西、九寨沟这些我们有线）
  { kind: '海岛', abroad: false, places: ['厦门', '鼓浪屿', '北海(?!道)', '涠洲岛'] },
  { kind: '藏地', abroad: false, places: ['冈仁波齐'] },
  { kind: '高原', abroad: false, places: ['青海湖', '青海', '可可西里'] },
  { kind: '草原戈壁', abroad: false, places: ['甘肃', '敦煌', '张掖', '宁夏', '内蒙古', '呼伦贝尔', '额济纳'] },
  { kind: '极地冰雪', abroad: false, places: ['哈尔滨', '雪乡', '长白山', '漠河'] },
  {
    kind: '山水',
    abroad: false,
    places: ['桂林', '阳朔', '张家界', '黄山', '婺源', '武夷山', '泰山', '华山', '峨眉山', '乐山', '千岛湖', '五台山', '恩施', '神农架'],
  },
  { kind: '古城', abroad: false, places: ['凤凰古城', '乌镇', '平遥'] },
  { kind: '云南', abroad: false, places: ['西双版纳', '泸沽湖', '腾冲'] },
];

/** 带边界写法的地名（「北海(?!道)」「(?<!内)蒙古」…）：去掉边界的本名 → 按边界认的正则，以及它是哪几个更长地名的一截 */
const BOUNDED_PLACES = new Map(
  OFF_CATALOG_GROUPS.flatMap((g) => g.places)
    .filter((p) => p.includes('(?'))
    .map((p) => {
      const name = p.replace(/\(\?<?[=!][^)]*\)/g, '');
      const before =
        /\(\?<!([^)]*)\)/
          .exec(p)?.[1]
          ?.split('|')
          .map((x) => x + name) ?? [];
      const after =
        /\(\?!([^)]*)\)/
          .exec(p)?.[1]
          ?.split('|')
          .map((x) => name + x) ?? [];
      return [name, { re: new RegExp(p), longer: [...before, ...after] }] as const;
    }),
);

/**
 * text 里有没有 word 这个地名。word 是上表里带边界写法的地名时按同样的边界认：「北海道」里的「北海」、「内蒙古」里的「蒙古」、
 * 「罗马尼亚」里的「罗马」都不算；其余照旧按子串。tools.ts 拿线路的目的地、别名、标题去对关键词都经这里，与认库外地名同一个口径
 */
export function mentionsPlace(text: string, word: string): boolean {
  const b = BOUNDED_PLACES.get(word);
  return b ? b.re.test(text) : text.includes(word);
}

/**
 * 线路的目的地、别名不能是另一个更长地名的一截（「北海」之于「北海道」，「蒙古」之于「内蒙古」）。引擎按子串在客户原话里认目的地和别名
 * （engine.ts destinationMentions），这样的线路一上架，客户说「想去北海道滑雪」就被当成点了这条线，预取、推荐、价格护栏跟着认错；
 * 这两个字段上架后锁定，只能停机用 catalog-fix 改。所以后台新建与上架时就拒（src/config/catalog.ts）。酒店不查
 */
export function placeNameIssues(kind: CatalogKind, payload: Record<string, unknown>): { path: string; message: string }[] {
  if (kind !== 'route') return [];
  const aliases = Array.isArray(payload.aliases) ? (payload.aliases as unknown[]) : [];
  const names: [string, unknown][] = [
    ['destination', payload.destination],
    ...aliases.map((a, i): [string, unknown] => [`aliases.${i}`, a]),
  ];
  return names.flatMap(([path, v]) => {
    const b = typeof v === 'string' ? BOUNDED_PLACES.get(v.trim()) : undefined;
    if (!b) return [];
    const message = `「${v}」是「${b.longer.join('」「')}」的一截，客户说那个地方时会被认成这条线；请写成不会被误认的全称，比如带上省份或国家`;
    return [{ path, message }];
  });
}
