import { renderLegacyHardRequirements } from './hard-requirements.js';

// 旧版固定要求：字节与抽取前相同（promptHash 的一部分）。不再手抄一份：由模板模式的硬性要求按 demo 品牌渲染、
// 再过一张替换表得到（07 R3，hard-requirements.ts）；字节由 src/config/template-derive.selftest.ts 的 sha256 与 web.selftest.ts 的前缀哈希守着。
export const hardRequirements = renderLegacyHardRequirements();

// 旧版客户出口集中保存；历史欢迎语识别串仍留在渠道适配器（现行两段欢迎语也在这里，适配器引用它们）。
export const identityAnswer = '我是云途定制旅行的 AI 旅行顾问，7×24 在线为您服务～';
/** R16 合并句的身份部分：不带「7×24 在线为您服务」，转人工时一句话说完 */
export const identityHandoffHead = '我是云途定制旅行的 AI 旅行顾问';
export const offTopicReply =
  '不好意思，我是云途定制旅行的旅行顾问，只帮您处理旅行相关的事～\n想去哪儿、几位出行、大概什么预算，随时告诉我，我来帮您安排！';
export const welcomeText =
  '您好呀～欢迎来到云途定制旅行，我是您的 AI 旅行顾问 🌿\n' +
  '想去哪玩直接跟我说，比如「想去西藏，两个人，预算每人3万」，我马上帮您推荐线路、报价，还能在线下单～\n' +
  '川西藏地 / 云南雪山 / 新疆南北疆 / 贵州山水 / 西安北京人文，都能聊！需要真人服务时，回复「人工」即可转真人顾问。';
export const welcomeBackText =
  '欢迎回来～我是云途定制旅行的 AI 旅行顾问。\n' +
  '想继续看线路、调整行程，或者换个方向看看，直接说就行～需要真人服务时，回复「人工」即可转真人顾问。';
export const webWelcome =
  '您好，欢迎来到云途定制旅行，我是您的 AI 旅行顾问 ✨\n想去川西藏地、云南雪山，还是新疆看看？和我聊聊您的想法吧～\n需要真人服务时，回复「人工」即可转真人顾问。';
export const mockOpening = '您好呀～我是云途定制旅行的旅行顾问 😊 咱们做高端定制游，先了解下您的想法：这次想去哪个方向玩，大概几位出行呢？';
