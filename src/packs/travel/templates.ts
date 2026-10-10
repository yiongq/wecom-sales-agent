// 第 20 步的客户出口模板。锁定节与硬性要求的模板发布仍由第 22 步接通。
import type { BrandTemplates } from '../../core/pack-api.js';
import { travelQuickReplyDefaults } from './quick-reply-defaults.js';
import { webWelcome } from './legacy.js';

const webWelcomeTemplate =
  '您好，欢迎来到{brandName}，我是您的 {aiTitle} ✨\n想去川西藏地、云南雪山，还是新疆看看？和我聊聊您的想法吧～\n需要真人服务时，回复「人工」即可转真人顾问。';
const brandSlot = { legacy: '云途定制旅行', template: '{brandName}', context: 'html-text' } as const;
const chatTitle = { legacy: '云途定制旅行顾问', template: '{brandName} · {advisorTitle}', context: 'html-text' } as const;

export const travelTemplates: BrandTemplates = {
  preamble: [
    '# {brandName} · 销售 SOP',
    '',
    '你是「{brandName}」的资深{advisorTitle}，接待来访咨询的客户。目标：了解需求 → 推荐线路 → 报价 → 促成下单。专业、真诚、不油腻，像一个懂行的朋友。',
    '',
    '**主营国内高端定制**：核心目的地是四川、新疆、西藏、云南、贵州、西安、北京，也做三亚与部分境外线路。',
    '客户没说方向时，优先往国内这几个目的地引；国内线的优势要讲到点上——不用签证、不倒时差、',
    '说走就走、老人小孩都吃得住，同样预算住得比境外更好。',
    '',
    '',
  ].join('\n'),
  identityAnswer: '{identityLine}～',
  offTopicReply:
    '不好意思，我是{brandName}的{advisorTitle}，只帮您处理{scopeNoun}相关的事～\n想去哪儿、几位出行、大概什么预算，随时告诉我，我来帮您安排！',
  welcomeText:
    '您好呀～欢迎来到{brandName}，我是您的 {aiTitle} 🌿\n' +
    '想去哪玩直接跟我说，比如「想去西藏，两个人，预算每人3万」，我马上帮您推荐线路、报价，还能在线下单～\n' +
    '川西藏地 / 云南雪山 / 新疆南北疆 / 贵州山水 / 西安北京人文，都能聊！需要真人服务时，回复「人工」即可转真人顾问。',
  welcomeBackText:
    '欢迎回来～我是{brandName}的 {aiTitle}。\n想继续看线路、调整行程，或者换个方向看看，直接说就行～需要真人服务时，回复「人工」即可转真人顾问。',
  webWelcome: webWelcomeTemplate,
  mockOpening: '您好呀～我是{brandName}的{advisorTitle} 😊 咱们做高端定制游，先了解下您的想法：这次想去哪个方向玩，大概几位出行呢？',
  quickReplies: travelQuickReplyDefaults.map((q, i) =>
    i === 0
      ? { ...q, body: '您好呀，我是{brandName}的{advisorTitle}，看到您在了解{scopeNoun}计划～方便先说说大概想去哪、和谁一起出行吗？' }
      : q,
  ),
  pages: {
    pay: [
      brandSlot,
      {
        legacy: '价格已确认 · 请按顾问在微信里发的方式付款',
        template: '价格已确认 · 请按顾问发来的方式付款',
        context: 'js-string',
      },
      {
        legacy: '订单已提交 · 顾问会在微信里跟您核对价格，并发来收款方式',
        template: '订单已提交 · 顾问会跟您核对价格，并发来收款方式',
        context: 'js-string',
      },
    ],
    proposal: [
      {
        legacy: '<title>行程方案书 · 云途定制旅行</title>',
        template: '<title>行程方案书 · {brandName}</title>',
        context: 'html-text',
      },
      {
        legacy: 'alt="云途定制旅行"',
        template: 'alt="{brandName}"',
        context: 'js-template',
        htmlContext: 'attribute',
      },
      {
        legacy: '云途定制旅行 · 行程方案书',
        template: '{brandName} · 行程方案书',
        context: 'js-template',
        htmlContext: 'text',
      },
      {
        legacy: '如需调整酒店档次、人数或日期，直接在微信里告诉顾问即可。',
        template: '如需调整酒店档次、人数或日期，直接告诉顾问即可。',
        context: 'js-template',
        htmlContext: 'text',
      },
    ],
    chat: [
      chatTitle,
      { ...brandSlot, context: 'js-string', htmlContext: 'text' },
      { legacy: '云途定制旅行顾问 · AI', template: '{brandName} · {aiTitle}', context: 'js-string', htmlContext: 'text' },
      { legacy: '云</span>', template: '{brandInitial}</span>', context: 'js-string', htmlContext: 'text' },
      { legacy: webWelcome.replaceAll('\n', '\\n'), template: webWelcomeTemplate, context: 'js-string' },
      {
        legacy: 'Demo：模拟企业微信会话。生产环境经企微回调接入，界面即企业微信本身。',
        template: 'Demo：模拟客户咨询会话。生产环境经已配置的接待渠道接入。',
        context: 'html-text',
      },
    ],
    web: [{ legacy: 'AI 旅行顾问 · 可转真人', template: '{aiTitle} · 可转真人', context: 'html-text' }],
  },
};
