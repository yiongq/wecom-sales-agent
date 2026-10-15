// 04 R7：核心通用步骤；行业判断和话术只从本轮 context 取得。
import type { GuardStep, ReplyGuardContext, StepVerdict } from '../pack-api.js';
import { cleanText } from '../../shared/text.js';
import { stripAdvisorPrefix } from '../../shared/conversation.js';
import { FAILURE_WINDOW, failureThresholdReached, pushWindow, turnFailed, type TurnSignals } from '../../handoff/trigger-rules.js';
import { IDENTITY_QUESTION, stripMarkdown, trimDangling } from './text.js';
import { replyStep } from './reply-step.js';
import { shapeCheckStep } from './shape.js';

function dropAdvisorPrefix(ctx: ReplyGuardContext): void {
  const before = ctx.text;
  ctx.text = stripAdvisorPrefix(ctx.text);
  if (ctx.text === before) return;
  ctx.text = ctx.text.trim() || (ctx.session.handedOver ? ctx.handoffFallback : ctx.fallbackReply(ctx.session.stage));
  ctx.recordGuard('advisor_prefix', before, ctx.text, 'strip');
}

export function coreReplySteps<Context extends ReplyGuardContext>(): GuardStep<Context>[] {
  return [
    replyStep('pre_clean', '', [], ['emptyModelReply', 'guardHit', 'handedOverSelfDecided'], (ctx) => {
      ctx.turn.flags.guardHit = null;
      ctx.turn.flags.handedOverSelfDecided = false;
      const usable = ctx.raw
        .replace(/<state>[\s\S]*?<\/state>/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<\/?(?:think|tool_call|arg_key|arg_value)>/gi, '')
        .trim();
      ctx.turn.flags.emptyModelReply = !usable;
      ctx.text = usable || ctx.fallbackReply(ctx.session.stage);
      return ctx.text === ctx.raw ? { action: 'pass' } : { action: usable ? 'strip' : 'replace', text: ctx.text };
    }),
    replyStep('takeover_check:pre', 'pre_clean', [], [], (ctx): StepVerdict => {
      if (ctx.takenOver()) return { action: 'abort' };
      if (ctx.session.handedOver) {
        if (!ctx.isTerminalStage(ctx.session.stage)) ctx.session.stage = 'handoff';
        if (!ctx.modelRequestedHandoff()) return { action: 'abort' };
      }
      return { action: 'pass' };
    }),
    replyStep('stage_advance', 'takeover_check:pre', [], [], (ctx) => {
      const { session, toolSources: calls, inputText: text, stageAtStart } = ctx;
      if (session.handedOver) {
        if (session.stageBeforeHandoff)
          session.stageBeforeHandoff =
            ctx.advanceStage(
              { ...session, stage: session.stageBeforeHandoff },
              { calls, terminal: ctx.isTerminalStage(session.stageBeforeHandoff) },
            ) ?? session.stageBeforeHandoff;
      } else {
        const derived = ctx.advanceStage(
          { ...session, stage: stageAtStart },
          { calls, terminal: ctx.isTerminalStage(stageAtStart), customerText: text },
        );
        session.stage =
          ctx.isTerminalStage(session.stage) && !ctx.isTerminalStage(stageAtStart) ? session.stage : (derived ?? stageAtStart);
        session.profile = ctx.extractProfile(session, calls, text);
      }
    }),
    replyStep('markdown', 'stage_advance', [], [], (ctx) => {
      const before = ctx.text;
      ctx.text = stripMarkdown(ctx.text);
      ctx.recordGuard('markdown', before, ctx.text, 'strip');
    }),
    replyStep('dangling', 'markdown', [], [], (ctx) => {
      const before = ctx.text;
      ctx.text = trimDangling(ctx.text);
      ctx.recordGuard('dangling', before, ctx.text, 'strip');
    }),
    replyStep('advisor_prefix', 'dangling', [], [], dropAdvisorPrefix),
    replyStep('identity', 'advisor_prefix', [], [], (ctx) => {
      const before = ctx.text;
      // 06 R16（customPromise 由旅游包的 custom_promise-a 写，不声明读取：别的包没有这个旗标）：这一轮转人工、客户又在问身份：开头一句话说完。后面的正文已经在讲转接或联系（模型的话，或稍后 custom_promise-b
      // 要接上的定制转人工话术），开头只放一句身份承认；没讲才用合并句（承认 AI 加转接加联系方式）
      if (ctx.handoffThisTurn() && IDENTITY_QUESTION.test(ctx.inputText) && !/AI|ai\b|人工智能/.test(ctx.text)) {
        const talksTransfer = !!ctx.turn.flags.customPromise || /转接|转给|转交|顾问[^。！？\n]{0,8}(?:联系|回复)/.test(ctx.text);
        const head = ctx.handoffReply(ctx.session, ctx.inputText, 'request', { identityOnly: talksTransfer });
        ctx.text = !ctx.text.trim() ? head : talksTransfer ? `${head}\n\n${ctx.text}` : `${head}\n${ctx.text}`;
      } else {
        ctx.text = ctx.answerIdentity(ctx.inputText, ctx.text);
      }
      ctx.recordGuard('identity', before, ctx.text, 'append');
    }),
    shapeCheckStep<Context>(),
    replyStep('takeover_check:post', 'shape_check', ['handedOverSelfDecided'], [], (ctx): StepVerdict =>
      ctx.takenOver() || (ctx.session.handedOver && !ctx.turn.flags.handedOverSelfDecided) ? { action: 'abort' } : { action: 'pass' },
    ),
    replyStep('turn_failure', 'takeover_check:post', ['emptyModelReply', 'guardHit'], [], (ctx) => {
      const { session, inputText: text, toolSources: calls } = ctx;
      if (session.handedOver) return;
      const said = session.messages.filter((m) => m.role === 'customer').map((m) => m.content);
      const signals: TurnSignals = {
        emptyModelReply: ctx.turn.flags.emptyModelReply,
        noRetrievalResult: ctx.retrievalEmpty(calls),
        repeatedQuestion: ctx.repeatedQuestion(text, said.slice(0, -1)),
        guardHit: ctx.turn.flags.guardHit,
      };
      ctx.recordSignals(signals);
      const failed = turnFailed(signals);
      const window = pushWindow(session.turnSignals, failed ? 1 : 0, FAILURE_WINDOW);
      if (window) session.turnSignals = window;
      else delete session.turnSignals;
      if (failed && failureThresholdReached(session.turnSignals ?? [])) {
        const departNote = ctx.departNoteForHandoff(session);
        ctx.enterHandoff({
          kind: 'failure',
          at: Date.now(),
          reason: ctx.failureReason,
          quote: cleanText(text, 200),
          ...(departNote ? { departNote } : {}),
        });
        delete session.turnSignals;
        const before = ctx.text;
        ctx.text = ctx.answerIdentity(text, ctx.handoffReply(session, text, 'request'));
        ctx.recordGuard('turn_failure', before, ctx.text, 'handoff');
        return { action: 'handoff', text: ctx.text, reason: ctx.failureReason };
      }
    }),
    replyStep('final_clean', 'turn_failure', [], [], (ctx) => {
      dropAdvisorPrefix(ctx);
      ctx.text = cleanText(ctx.text);
      ctx.appendMessage({ role: 'agent', content: ctx.text, at: Date.now() });
    }),
  ];
}
