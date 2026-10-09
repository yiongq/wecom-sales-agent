// 启动顺序（docs/architecture/01-pg-config-console/spec.md 裁决 R18，02 spec「两种会话存储与启动」多一步，03 spec「接口与数据流」
// 的启动顺序再多一步）：配置装载成功、会话存储就绪、渠道账号装载之后才监听端口，监听成功后再依次做数据预检、建检索索引、
// 起渠道（startChannels，代替 02 的 startWecom）、起任务表（db 存储）或跟进扫描器（文件存储）、挂上告警的订阅（02 spec R24）。
// LOG_FORMAT=json 时最先把 console.* 接到 pino。
// 任何一步装载失败时后面的一个都不调：企微 cursor（文件或库里的）不动，客户消息留到下次成功启动再补拉，
// 而不是被一个读不到配置、会话或渠道账号的进程拉走、答错。
import { ChannelStartupError } from './channels/startup-error.js';
import { ConfigStartupError } from './config/source.js';
import { installJsonConsole } from './log.js';
import { SessionStoreStartupError } from './store/backend.js';

export interface BootDeps {
  /** 生产：先校验 CONFIG_SOURCE（非法值报 env_invalid）；是 db 就构造依赖再装载，否则按文件模式 */
  initConfig(): Promise<void>;
  /** 文件存储：查 var/ 下的标记文件；db 存储：预载 PG 并换上 PG 后端（store.ts 的 initSessionStore） */
  initSessionStore(): Promise<void>;
  /**
   * 03：渠道账号装载（src/channels/registry.ts 的 initChannels）。文件存储拼 env 账号；db 存储按库里本租户的企微账号判企微状态（R1），
   * 六种拒绝以 ChannelStartupError reject
   */
  initChannels(): Promise<void>;
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
  /** 03：代替 02 的 startWecom——在任务与跟进扫描器之前起渠道（这一步只起 env 账号的企微拉取，库里账号的运行时第 7 步接上） */
  startChannels(): void;
  exit(code: number): void;
  /**
   * OpenTelemetry（02 spec R24，默认关闭）：只在设了 OTEL_EXPORTER_OTLP_ENDPOINT 时调，在会话存储就绪之后、监听之前。
   * 生产是 src/ops/otel.ts 的 startOtelExport（动态 import 导出器、订阅 onTurnEnd）；失败只记日志，照常启动、不导出
   */
  startOtel?(): Promise<void>;
  /**
   * 告警（02 spec R24）：起渠道之后挂上各处的订阅（模型、企微、租户锁、写库、任务），两种存储都挂。生产是 src/ops/alert.ts 的
   * startAlerts；推送只在后台，不阻塞启动
   */
  startAlerts?(): void;
  /**
   * 隐私说明（02 spec「隐私说明…」，R23）：initConfig 成功之后读进内存、起 60 秒后台轮询；文件配置模式什么都不做。
   * 失败只记日志（先当没发布过），不影响启动
   */
  startPrivacy?(): Promise<void>;
}

export async function boot(d: BootDeps): Promise<void> {
  // LOG_FORMAT=json：console.* 接到 pino（profile-boot 在导入期已接过，这里照 spec 再调一次，接过就什么都不做）
  installJsonConsole();
  try {
    await d.initConfig();
  } catch (e) {
    if (e instanceof ConfigStartupError) console.error(`[boot] 配置装载失败，拒绝启动（${e.reason}）：${e.detail}`);
    else console.error('[boot] 配置装载失败，拒绝启动：', e);
    d.exit(1);
    return;
  }
  // 隐私说明不影响启动：读不到就先当没发布过，60 秒后台轮询会再试
  await d.startPrivacy?.();
  try {
    await d.initSessionStore();
  } catch (e) {
    if (e instanceof SessionStoreStartupError) console.error(`[boot] 会话存储装载失败，拒绝启动（${e.reason}）：${e.detail}`);
    else console.error('[boot] 会话存储装载失败，拒绝启动：', e);
    d.exit(1);
    return;
  }
  // 03：spill 的回放在 initSessionStore 里、先于这一步，启动恢复读到的已是回放之后的入站与出站
  try {
    await d.initChannels();
  } catch (e) {
    if (e instanceof ChannelStartupError) console.error(`[boot] 渠道装载失败，拒绝启动（${e.reason}）：${e.detail}`);
    else console.error('[boot] 渠道装载失败，拒绝启动：', e);
    d.exit(1);
    return;
  }
  // 没设端点时这里只有一次判断：不加载任何 @opentelemetry/*、启动不多花时间（不变量 49）
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() && d.startOtel) {
    try {
      await d.startOtel();
    } catch (e) {
      console.error('[boot] OpenTelemetry 没起来（不导出，对话照常）：', e instanceof Error ? e.message : e);
    }
  }
  d.serve(() => {
    d.preflight();
    // buildIndex 内部已兜住异常，这里再补一道 catch：void 掉的 promise 一旦 reject 就是未捕获 rejection，进程直接退出
    d.buildIndex().catch((e) => console.error('[boot] 语义索引构建异常（已降级为关键词匹配）：', e));
    // 渠道先于任务与跟进扫描器：库里账号的启动恢复做完之前，到期的跟进经 push 排队等它（03 spec「重启、崩溃与恢复」）
    d.startChannels();
    if (d.storeMode() === 'db') d.startJobs();
    else d.startFollowUpScheduler();
    d.startAlerts?.();
  });
}
