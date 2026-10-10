// system prompt 的渲染：SOP 全文 + 代码里写死的【硬性要求】（01 spec「渲染与哈希」）。
// 纯函数：不读 profile、环境变量、时间。同一份 SOP 永远渲染出同一串字节，DB 模式在发布时渲染一次、每轮原样复用，
// 文件模式每轮现渲染，两种模式的结果逐字节相同。
//
// 拼装顺序是**按前缀缓存优化过的**，改动前先看这段说明。
//
// 智谱与 DeepSeek 都做隐式前缀缓存：按 messages 的公共前缀匹配，命中的输入 token
// 打折计费（各模型的缓存价见 usage.ts），触发下限 512 token。这个 system prompt
// ——SOP 约 3000 token + 下面的硬性要求约 700 token——排在所有消息最前面，
// 所以它必须**逐字节不变**：变一个字，后面整段历史都吃不到缓存。
//
// 每轮会变的会话状态（日期/阶段/画像/最近查到的线路）因此不在这里，见 engine.ts 的 buildContextNote：
// 它作为一条独立的 system 消息插在最新一条客户消息之前，请求结构是
// [tools][本 system][历史…][会话状态][本轮客户消息]，历史前缀只在 historyWindow 按块推进时才变。
// 此前状态拼在本 system 的末尾、排在全部历史之前：阶段或画像一变（一段典型的 10 轮对话里
// 有 8 轮会变），整段历史就按全价重算。顺带的好处：状态离客户消息更近，模型更注意得到。
import { renderSystemPrompt as render } from '../core/prompt.js';
import { hardRequirements } from '../packs/travel/legacy.js';

export function renderSystemPrompt(sop: string): string {
  return render(sop, hardRequirements);
}
