// 渠道装载的拒绝启动（docs/architecture/03-channels-v2/spec.md「接口与数据流 · 渠道账号与凭据」的 ChannelStartupError）。
// 定义在这里、由 registry.ts 原样再导出：boot.ts 要认它，又不该为此带上 registry 连带的适配器、store 与库驱动（同 02 的
// SessionStoreStartupError 放在 src/store/backend.ts 的理由）。detail 里只有账号 key、key id、文件名与处理办法，没有凭据与标识
export type ChannelStartupReason =
  | 'channel_key_missing'
  | 'channel_key_invalid'
  | 'channel_decrypt'
  /** 从备份恢复之后还没跑 restore-cutoff（var/ 里有恢复哨兵） */
  | 'channel_restore_pending'
  /** 库里有企微账号，var/ 里还有没导入的 wecom-cursor.json：跑 channel-import（回退过就加 --resync） */
  | 'channel_state_in_file'
  /** var/ 里有 channels-in-db.json 而状态不在库里能用：文件存储下（先 channel-export），或导出没做完（重跑 channel-export 或 channel-import --resync） */
  | 'channel_state_in_db';

export class ChannelStartupError extends Error {
  constructor(
    readonly reason: ChannelStartupReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'ChannelStartupError';
  }
}
