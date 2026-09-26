// 启动顺序（docs/architecture/01-pg-config-console/spec.md 裁决 R18）：配置装载成功之后才监听端口，
// 监听成功后再依次做数据预检、建检索索引、起自动跟进、起企微拉取。装载失败时这些一个都不调：
// 企微 cursor 不动，客户消息留到下次成功启动再补拉，而不是被一个读不到配置的进程拉走、答错。
import { ConfigStartupError } from './config/source.js';

export interface BootDeps {
  /** 生产：先校验 CONFIG_SOURCE（非法值报 env_invalid）；是 db 就构造依赖再装载，否则按文件模式 */
  initConfig(): Promise<void>;
  serve(onListening: () => void): void;
  /** 现有的数据文件启动预检 */
  preflight(): void;
  buildIndex(): Promise<void>;
  startFollowUpScheduler(): void;
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
  d.serve(() => {
    d.preflight();
    // buildIndex 内部已兜住异常，这里再补一道 catch：void 掉的 promise 一旦 reject 就是未捕获 rejection，进程直接退出
    d.buildIndex().catch((e) => console.error('[boot] 语义索引构建异常（已降级为关键词匹配）：', e));
    d.startFollowUpScheduler();
    d.startWecom();
  });
}
