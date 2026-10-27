import { renderBrandTemplate, FIXED_REPLY_MODES, type FixedReply, type ConsistencyRule } from '../../core/pack-api.js';
import { templates } from './sop.js';
import { followupTemplates } from './auxiliary.js';
import { defaultIndustrialPolicy, taxInvoiceText } from './policy.js';
import { FIXED } from './turn.js';
import { INVENTORY_FALLBACK, SUBSTITUTE_FALLBACK, TRIM_FALLBACK, trimNote } from './guards.js';
const nonTextHints: Record<string, string> = {
  image: '图片收到了，我暂时看不了图片内容，请把型号和数量打字发来，型号铭牌上的文字也可以打给我。',
  voice: '语音我暂时听不了，请把型号和数量打字发来，我帮您查询。',
  video: '视频我暂时看不了，请把型号和数量打字发来，我帮您查询。',
  file: '文件我暂时打不开，请把需要的型号和数量打字发来，我帮您查询。',
  link: '链接收到了，请把需要的型号和数量打字发来，我帮您查询。',
  location: '位置收到了，请把交货城市、型号和数量打字发来，我帮您查询。',
  other: '这条消息我暂时处理不了，请把型号和数量打字发来，我帮您查询。',
};
export const fixedReplies: readonly FixedReply[] = [
  ...Object.entries(nonTextHints).map(([type, text]): FixedReply => ({
    id: `non-text.${type}`,
    source: 'src/packs/industrial/fixed-replies.ts',
    kind: 'plain',
    producedBy: { outside: '非文字消息由企微适配器直发，不经模型回复管线' },
    samples: () => FIXED_REPLY_MODES.map((mode) => ({ mode, text })),
  })),
  ...Object.entries(FIXED).map(([key, text]): FixedReply => ({
    id: `industrial.${key}`,
    source: 'src/packs/industrial/turn.ts',
    kind: 'plain',
    producedBy: { outside: 'preModel 确定性出口，核心校验全文及副作用' },
    samples: () => FIXED_REPLY_MODES.map((mode) => ({ mode, text })),
  })),
  ...[
    ['industrial.empty', '请告诉我型号和数量。', 'rfq_trim'],
    ['industrial.tax', taxInvoiceText(defaultIndustrialPolicy), 'industrial_claims'],
    ['industrial.inventory', INVENTORY_FALLBACK + '。', 'industrial_claims'],
    ['industrial.substitute', SUBSTITUTE_FALLBACK + '。', 'industrial_claims'],
    ['industrial.trim.fallback', TRIM_FALLBACK, 'rfq_trim'],
    ['industrial.trim.note', trimNote(5), 'rfq_trim'],
    ['industrial.money', '金额需要先试算，请告诉我型号和数量。', 'money_provenance'],
  ].map(([id, text, step]): FixedReply => ({
    id: id!,
    source: 'src/packs/industrial/guards.ts',
    kind: 'plain',
    ...(id === 'industrial.trim.note' ? { pattern: /^另外 [1-9]\d* 行已算好，需要的话我出一份正式报价单$/ } : {}),
    producedBy: { pipeline: 'reply', step: step! },
    samples: () => FIXED_REPLY_MODES.map((mode) => ({ mode, text: text! })),
  })),
  ...Object.entries({
    ...Object.fromEntries(
      ['identityAnswer', 'offTopicReply', 'welcomeText', 'welcomeBackText', 'webWelcome', 'mockOpening'].map((key) => [
        key,
        templates[key as 'identityAnswer'],
      ]),
    ),
    ...Object.fromEntries(templates.quickReplies.map((reply, i) => [`quick.${i}`, reply.body])),
    'followup.quote': followupTemplates.byStage.quote!,
    'followup.closing': followupTemplates.byStage.closing!,
    'quote.rejected': '这份报价需要顾问再核对一下，顾问会直接联系您',
    'quote.withdrawn': '这份报价单已撤回，顾问会跟您重新确认',
  }).map(([id, text]): FixedReply => ({
    id: `industrial.${id}`,
    source: 'src/packs/industrial/runtime.ts',
    kind: 'plain',
    producedBy: { outside: '品牌模板、快捷回复、跟进模板或工作台通知；由对应出口处理' },
    samples: () =>
      FIXED_REPLY_MODES.map((mode) => ({
        mode,
        text: renderBrandTemplate(text, {
          brandName: '衡石工业品（虚构）',
          advisorTitle: '顾问',
          aiTitle: 'AI 询价顾问',
          scopeNoun: '工业品询价',
          identityLine: '我是衡石工业品的 AI 询价顾问',
        }),
      })),
  })),
];
export const consistencyRules: readonly ConsistencyRule[] = [
  {
    id: 'industrial.approval',
    a: '新建缺省人审，按三条件自动批准；复用不重审',
    b: '待审直接发链接或重新审批已批准的复用单',
    scope: ['fixed', 'tool-note', 'sop'],
    why: '审批口径必须与工具状态一致',
  },
  {
    id: 'industrial.claims',
    a: '工具与政策支持的事实',
    b: '无依据的库存、替代、税票与价格承诺',
    scope: ['fixed', 'wordlist', 'sop'],
    why: '承诺由代码决定',
  },
];
