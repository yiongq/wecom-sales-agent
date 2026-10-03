// 启动顺序（docs/architecture/01-pg-config-console/spec.md 裁决 R18，02 spec「两种会话存储与启动」多一步）：
// 配置装载成功、会话存储就绪之后才监听端口，监听成功后再依次做数据预检、建检索索引、起任务表（db 存储）或跟进扫描器（文件存储）、
// 起企微拉取。
// 任何一步装载失败时后面的一个都不调：企微 cursor 不动，客户消息留到下次成功启动再补拉，
// 而不是被一个读不到配置或会话的进程拉走、答错。
import { ConfigStartupError } from './config/source.js';
import { SessionStoreStartupError } from './store/backend.js';

export interface BootDeps {
  /** 生产：先校验 CONFIG_SOURCE（非法值报 env_invalid）；是 db 就构造依赖再装载，否则按文件模式 */
  initConfig(): Promise<void>;
  /** 文件存储：查 var/ 下的标记文件；db 存储：预载 PG 并换上 PG 后端（store.ts 的 initSessionStore） */
  initSessionStore(): Promise<void>;
  serve(onListening: () => void): void;
  /** 现有的数据文件启动预检 */
  preflight(): void;
  buildIndex(): Promise<void>;
  /** 装上的会话存储（initSessionStore 之后读）：db 起任务表，file 起跟进扫描器 */
  storeMode(): 'file' | 'db';
  /** 文件存储：跟进扫描器 */
  startFollowUpScheduler(): void;
  /** db 存储：任务表（认领与执行、跟进的排程与取消），代替 startFollowUpScheduler（02 spec「两种会话存储与启动」） */
  startJobs(): void;
  startWecom(): void;
  exit(code: number): void;
}

export async function boot(d: BootDeps): Promise<void> {
  try {
    await d.initConfig();
  } catch (e) {
    if (e instanceof ConfigStartupError) console.error(`[boot] 配置装载失败，拒绝启动（${e.reason}）：${e.detail}`);
    else console.error('[boot] 配置装载失败，拒绝启动：', e);
    d.exit(1);
    return;
  }
  try {
    await d.initSessionStore();
  } catch (e) {
    if (e instanceof SessionStoreStartupError) console.error(`[boot] 会话存储装载失败，拒绝启动（${e.reason}）：${e.detail}`);
    else console.error('[boot] 会话存储装载失败，拒绝启动：', e);
    d.exit(1);
    return;
  }
  d.serve(() => {
    d.preflight();
    // buildIndex 内部已兜住异常，这里再补一道 catch：void 掉的 promise 一旦 reject 就是未捕获 rejection，进程直接退出
    d.buildIndex().catch((e) => console.error('[boot] 语义索引构建异常（已降级为关键词匹配）：', e));
    if (d.storeMode() === 'db') d.startJobs();
    else d.startFollowUpScheduler();
    d.startWecom();
  });
}
