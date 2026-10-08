// 转人工记录（docs/architecture/02-conversations-workbench/spec.md「转人工记录与四种状态」、R9）。
// 五条入口（确定性安全网、模型调工具、改行程承诺、回复里说了转接、后台接手）都经 enterHandoff，带上类型与原因；
// 02 新增的紧急情况、交互失败、负面情绪（第 11 步，src/handoff/triggers.ts）同样经它。
// 从 tools.ts 搬来，tools.ts 再导出；判「阶段是不是终态」的帮手也在这里，引擎和旧接口共用。
import { configMode, currentTenant } from '../config/source.js';
import { packById } from '../packs/registry.js';
import { terminalStages } from '../shared/conversation.js';
import type { IndustryPack } from '../shared/pack.js';
import { handoffNotifyOps } from '../jobs/notify.js';
import { sendWindow } from '../quota/ledger.js';
import { emitAfterCommit, queueJobs } from '../store.js';
import type { HandoffKind, HandoffRecord, SalesStage, Session } from '../types.js';
import type { EmergencyKind } from './triggers.js';

/**
 * 按类型写的固定原因（model 取模型给的原因，这里的只在模型没给时兜底）。
 * 不用「待人工」「已转人工」「待接管」「需要介入」这类状态词：界面上会话状态只有四种叫法（设计系统 §11）
 */
export const HANDOFF_REASON = {
  request: '客户要找顾问',
  complaint: '客户投诉',
  refund: '客户要退款或改订单',
  model: 'AI 判断要请顾问处理',
  promise: '回复里答应了改行程，要顾问重排',
  claimed: '回复里答应了转接顾问（引擎补记）',
  agent: '共享工作台转人工',
  emergency: '客户遇到紧急情况',
  failure: '客户的问题 AI 几轮都没答上',
  sentiment: '客户情绪不满',
  consent: '客户不同意处理敏感个人信息',
} as const satisfies Partial<Record<HandoffKind, string>>;

/** 紧急情况的类型写进原因，顾问一眼看出是哪一类（R15） */
const EMERGENCY_LABEL: Record<EmergencyKind, string> = {
  altitude: '高反',
  injury: '受伤',
  medical: '急病',
  documents: '证件丢失',
  stranded: '被困或走失',
};
export function emergencyReason(kind: EmergencyKind): string {
  return `${HANDOFF_REASON.emergency}（${EMERGENCY_LABEL[kind]}）`;
}

/** 判阶段用的行业包：DB 配置模式取启动时装载的租户包，文件模式取注册表里的旅游包 */
export function activePack(): IndustryPack {
  if (configMode() === 'db') return currentTenant().pack;
  const travel = packById('travel');
  if (!travel) throw new Error('行业包注册表里没有 travel');
  return travel;
}

/** 阶段是不是行业包的终态（标了 terminal 的阶段）：停在这里的会话算已成交 */
export function isTerminalStage(stage: string): boolean {
  return terminalStages(activePack()).some((s) => s.key === stage);
}

/**
 * 写「已成交」时用的阶段：行业包的第一个终态。Session.stage 的类型仍是旅游包的阶段（03 再放宽），
 * 本阶段只有旅游包，取到的就是 'paid'；多终态的包写哪个本阶段不处理
 */
export function terminalStageKey(): SalesStage {
  const first = terminalStages(activePack())[0];
  if (!first) throw new Error(`行业包 ${activePack().id} 没有终态阶段`);
  return first.key as SalesStage;
}

/**
 * 进入转人工。已在转人工中：record 只在 kind 为 emergency 而原记录不是时覆盖（升级），其余保留第一次的记录，计数不加。
 * 从「未转人工」进入时：assignee = null；首次进入时 firstHandoffAt = record.at；handoffCount + 1。
 * stageBeforeHandoff 的写法与 02 之前相同：已在转人工中不覆盖，否则记下的会是 handoff 本身，原阶段永久丢失。
 * 阶段是行业包终态时保留终态（R9，开放问题 12 选 A：成交统计不变），否则改成 handoff。
 * 每次进入或升级都 emitAfterCommit({ type: 'handoff.started', … })，事件随这个会话的下一次落盘（落库）发出；
 * db 存储下同时排 handoff_notify 任务（src/jobs/notify.ts），随同一次落库提交
 */
export function enterHandoff(
  session: Session,
  record: HandoffRecord,
  prevStage: SalesStage = session.stage,
  opts: { assigned?: boolean } = {},
): void {
  const terminal = isTerminalStage(session.stage);
  if (session.stage !== 'handoff' && prevStage !== 'handoff') session.stageBeforeHandoff = prevStage;
  if (!terminal) session.stage = 'handoff';
  let escalated = false;
  if (!session.handedOver) {
    session.handedOver = true;
    session.assignee = null;
    session.handoff = record;
    session.firstHandoffAt ??= record.at;
    session.handoffCount = (session.handoffCount ?? 0) + 1;
  } else if (record.kind === 'emergency' && session.handoff?.kind !== 'emergency') {
    session.handoff = record;
    escalated = true;
  } else {
    return;
  }
  emitAfterCommit(session.id, {
    type: 'handoff.started',
    id: session.id,
    kind: record.kind,
    at: record.at,
    escalated,
    paidCustomer: terminal,
    // 发出时是否已有接手人（02 第 19 步审查第 2 条）：升级分支（已 handedOver 再遇紧急情况）这一刻 session.assignee
    // 就是真实情况；首次进入分支 enterHandoff 自己刚把它清成 null（见上面 82 行），调用方（takeover()）如果紧接着
    // 就要赋接手人，传 { assigned: true } 覆盖，不然会照实报 false
    assigned: opts.assigned ?? session.assignee != null,
  });
  // 转人工通知（02 spec「任务表与跟进」）：立即一个、10 分钟仍没人接手再一个，企微会话另排窗口剩不到 4 小时的那一个（到点重判），
  // 随这次转人工的落库提交（db 存储的真实会话；其余丢弃）
  queueJobs(
    session.id,
    handoffNotifyOps(session.id, record.at, {
      escalated,
      kind: record.kind,
      handoffCount: session.handoffCount,
      windowClosesAt: !escalated && session.channel === 'wecom' ? sendWindow(session.id, record.at).closesAt : null,
    }),
  );
}
