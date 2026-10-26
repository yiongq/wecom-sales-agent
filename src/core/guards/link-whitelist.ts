// 09 R10：新包选用的出口步骤；旅游继续走自己的链接修补规则。
import type { FollowupGuardContext, GuardStep, ReplyGuardContext, StepVerdict } from '../pack-api.js';
import { linkCandidates, linkDef, ownLinkPath } from '../site-links.js';
import { publicBase } from '../../tenancy/hosts.js';
import { sentenceUnits } from '../parse/sentences.js';

// 删掉链接后只剩动作/标签的句子没有信息；实质说明（如交期）仍保留。
const POINTER =
  /^(?:(?:请|您|可以|可|直接|再|先|点击|点|打开|查看|浏览|访问|这里|这儿|此处|以下|下方|这个|链接|入口|详情|明细|报价单|订单|支付|付款|见|在|是|的|吧|哦|呀|呢|看一下|看看|查阅|通过)|[\s，,。.!！?？：:；;、→👉（）()【】[\]「」“”])+$/u;

// 旅游的旧步骤也叫 link_whitelist；按核心工厂的执行函数识别接入，不能只看同名 id。
function runWhitelist(ctx: FollowupGuardContext): StepVerdict {
  let text = ctx.text;
  let changed = false;
  // 从后往前删，保留偏移；不归一 URL，穿越/编码/站外均不能借登记放行。
  for (const { raw, index } of linkCandidates(ctx.text).toReversed()) {
    const path = ownLinkPath(raw, publicBase());
    const def = path === null ? undefined : linkDef(path);
    if (def && def.allowed(ctx.session, path!)) continue;
    text = text.slice(0, index) + '\u0000' + text.slice(index + raw.length);
    changed = true;
  }
  if (!changed) return { action: 'pass' };
  text = sentenceUnits(text)
    .map(({ start, end }) => {
      const unit = text.slice(start, end);
      const rest = unit.replaceAll('\u0000', '');
      return unit.includes('\u0000') && (!rest.trim() || POINTER.test(rest)) ? '' : rest;
    })
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  ctx.recordGuard('link_whitelist', ctx.text, text, 'strip');
  return { action: 'strip', text };
}
function whitelist<Context extends FollowupGuardContext>(): GuardStep<Context> {
  return { id: 'link_whitelist', run: runWhitelist };
}
export function usesLinkWhitelist(steps: readonly GuardStep<ReplyGuardContext>[]): boolean {
  return steps.some((step) => step.id === 'link_whitelist' && step.run === runWhitelist);
}

export function linkWhitelistStep(): GuardStep<ReplyGuardContext> {
  return whitelist<ReplyGuardContext>();
}
export function linkWhitelistFollowupStep(): GuardStep<FollowupGuardContext> {
  return whitelist<FollowupGuardContext>();
}
