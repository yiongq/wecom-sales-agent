// 转人工触发的类型入口。算法在 trigger-rules.ts，词表由包给：引擎用绑定包的 runtime.vocab.handoff 实例化它。
// 原先这里还有一份绑旅游词表的纯函数实例（emergencyOf 等十二个导出）：非自测代码没有值消费者，08 R5（依赖方向收口）把它收走，
// 自测要旧版那一套就自己 createHandoffTriggers(handoffVocab)（src/handoff/handoff.selftest.ts、src/privacy/privacy.selftest.ts）。
export type { EmergencyKind, SensitiveCategory, TurnSignals } from './trigger-rules.js';
