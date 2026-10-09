// 企微的拉取状态（docs/architecture/03-channels-v2/spec.md R1、R10、不变量 13）：cursor、已认领的 msgid（handled）、在途表、冷启动截止。
// 按账号一个后端，WecomRuntime（src/adapters/wecom.ts）按账号的来源选：
//   FileWecomState      env 账号（文件存储，企微状态「未导入」「已导出」）：var/wecom-cursor.json。02 的文件状态层原样挪过来，
//                       行为逐字节不变（锁定的 wecom.selftest.ts、02 的 wecom-02.selftest.ts 与 quota.selftest.ts 守它）。
//   AccountCursorState  库里的企微账号，第 7 步的过渡后端：cursor 写这个账号自己那一行的 channel_accounts.cursor（列级授权允许），
//                       handled 与在途表只在内存里；不写 var/wecom-cursor.json（不变量 13），几个账号的状态也不混在一起。
//                       第 9 步换成 channel_inbox（与 cursor 同一事务插入、入站状态机）时整个替换掉这个类。
//                       已知缺口（第 9 步补上）：cursor 推进之后、消息处理完之前进程退出，这几条重启后不会再被拉到，也没有在途表可重放，
//                       客户等不到回复；cursor 写库失败时下次从旧 cursor 重拉，handled 已经没了，靠 02 按 msgid 的五种情况去重。
//                       库里的账号要到第 14 步的导入之后才会出现，第 9 步之前只在自测里有。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { withTenant, type Db } from '../db/client.js';
import { updateChannelAccount } from '../db/repo/channel-accounts.js';
import { logError } from '../log.js';

const VAR_DIR = process.env.VAR_DIR ?? path.resolve('var');
/** env 账号的状态文件（锁定的 __test.STATE_FILE 指向它） */
export const STATE_FILE = path.join(VAR_DIR, 'wecom-cursor.json');

export interface KfMessage {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number; // 3=客户发来，4=系统，5=客服人员/接口发出
  msgtype: string;
  // menu_id：客户点了 msgmenu 的某个按钮时企微发来的是一条普通文本消息，按钮 id 在这里（02 第 16 步，官方文档「接收消息」
  // developer.work.weixin.qq.com/document/path/94670；consentMenuButtonId 编码的 category:decision），不是单独的事件类型
  text?: { content: string; menu_id?: string };
  event?: {
    event_type?: string; // 如 enter_session（客户进入会话）、msg_send_fail（消息发送失败）
    welcome_code?: string; // 进入会话事件专用，20s 内单次有效，用于 send_msg_on_event 发欢迎语
    external_userid?: string;
    fail_msgid?: string; // msg_send_fail 专用：发送失败的那条的 msgid（我们随 send_msg 下发的）
    fail_type?: number; // msg_send_fail 专用：4 超过 48 小时、6 超过 5 条，其余见企微文档
  };
}

// msgid → 认领时间。持久化防重启后重复回复；企微消息只留 3 天，去重集同寿命
const HANDLED_TTL_MS = 3 * 24 * 3600 * 1000;
const HANDLED_MAX = 5000;

// 在途表：已认领（cursor 已推进、sync_msg 不会再返回）但还没处理完的客户消息，连同原文落盘。
// 去重是两阶段的：handled 管「认领过没有」，在途表管「处理完没有」。进程死在处理途中
// （停机等待超时、OOM、宿主机重启）时，启动后按原文重放。
//
// 取舍：宁可极少数情况下重复回一次，也不能丢消息。丢消息 = 客户永远等不到回复，
// 且会话最后一条是客户说的，自动跟进也不会去追；重复 = 客户看到同一句话两遍。
// 重复只发生在上次停在发送途中、而那条其实已经送达时：停机等待超时被强制退出（部署时正好
// 碰上一轮超过 8s 的回复），或被硬杀，重启后按「回复已生成」原样再发一次。只有各客户的队头
// 会这样对齐，排在它后面、还没开始处理的消息按新消息派发（见 replayInflight）。
// 正常停机会等处理完再落盘，不会重复。重放也不会重复建单：create_order 对同参数的
// 待支付订单是幂等复用的（tools.ts），转人工状态已落盘、重放时引擎直接静默。
export interface PendingEntry {
  msg: KfMessage;
  /** 已重放次数 */
  tries: number;
}

// 冷启动：没有可用 cursor（首次部署 / 状态文件缺失或损坏）时 sync_msg 会返回近 3 天的全部消息，
// 而去重集也一起没了——不设防就会把 3 天里每个客户的每条旧消息挨个回一遍，给扫过码的人
// 补发欢迎语。启动前 10 分钟之前的消息只标记已处理、不回复；10 分钟的余量吸收两边时钟偏差，
// 也兜住「刚好在重启空档里发来」的新消息。
const COLD_START_GRACE_MS = 10 * 60 * 1000;

/** 一个账号的拉取状态。运行时只经这几个方法读写，换后端（第 9 步的 channel_inbox）不动收发与处理链 */
export interface WecomStateBackend {
  readonly kind: 'file' | 'account_cursor';
  cursor: string;
  /** 非 0 表示本进程是冷启动，send_time 早于它的消息不回复 */
  coldStartCutoff: number;
  readonly handled: Map<string, number>;
  readonly inflight: Map<string, PendingEntry>;
  /** 启动时加载（运行时保证只调一次）：cursor、去重集、在途表；没有 cursor 时定冷启动截止 */
  load(): Promise<void>;
  /** 推进 cursor 之后、派发之前：把 cursor（与去重集、在途表）写下来，写完才返回；写失败只记日志 */
  save(): Promise<void>;
  /** 一条处理完之后去抖落盘 */
  scheduleSave(): void;
  /** 进程 exit 阶段（只能跑同步代码）：把去抖窗口里的状态写出去 */
  flushSync(): void;
  /** 停机收尾：取消去抖、写最后一次 */
  close(): Promise<void>;
  /** 仅供自测：像 exit 阶段那样写完、等排队的写完，再把内存清回刚启动的样子（写下来的状态保留） */
  resetForTest(): Promise<void>;
}

/** 标记 msgid 已认领；返回 false 表示此前认领过（跳过）。落盘由调用方在推进 cursor 后统一做 */
export function markHandled(state: WecomStateBackend, msgid: string): boolean {
  if (state.handled.has(msgid)) return false;
  state.handled.set(msgid, Date.now());
  return true;
}

/** 封顶淘汰：Map 按插入序，删最旧的一批（此前是整体 clear，会连最新的也丢掉） */
function capHandled(handled: Map<string, number>): void {
  while (handled.size > HANDLED_MAX) {
    handled.delete(handled.keys().next().value as string);
  }
}

// ---------------- env 账号：var/wecom-cursor.json（02 原样） ----------------

export class FileWecomState implements WecomStateBackend {
  readonly kind = 'file' as const;
  cursor = '';
  coldStartCutoff = 0;
  readonly handled = new Map<string, number>();
  readonly inflight = new Map<string, PendingEntry>();
  private saveChain: Promise<void> = Promise.resolve();
  private stateSaveTimer: NodeJS.Timeout | null = null;

  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(STATE_FILE, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[wecom] ⚠️ 状态文件读取失败，按冷启动处理:', e);
      }
    }
    if (text !== null) {
      try {
        const raw = JSON.parse(text) as {
          cursor?: string;
          handled?: [string, number][];
          pending?: PendingEntry[];
        };
        this.cursor = raw.cursor ?? '';
        const cut = Date.now() - HANDLED_TTL_MS;
        for (const [id, ts] of raw.handled ?? []) {
          if (ts > cut) this.handled.set(id, ts);
        }
        for (const p of raw.pending ?? []) {
          if (p?.msg?.msgid) this.inflight.set(p.msg.msgid, { msg: p.msg, tries: Number(p.tries) || 0 });
        }
      } catch (e) {
        // 与 store.ts 一致：损坏文件改名留现场，不能静默当首次启动（下一次落盘就把现场覆盖了）
        const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
        try {
          await rename(STATE_FILE, backup);
          console.error(`[wecom] ⚠️⚠️ ${path.basename(STATE_FILE)} 解析失败，已备份到 ${backup}:`, logError(e));
        } catch {
          console.error(`[wecom] ⚠️⚠️ ${path.basename(STATE_FILE)} 解析失败且无法备份:`, logError(e));
        }
        this.cursor = '';
        this.handled.clear();
        this.inflight.clear();
      }
    }
    // 以「有没有 cursor」为准，而不只看文件在不在：首次同步还没拿到 cursor 就崩了，
    // 文件里只有去重集、cursor 为空，下次启动同样会拉回近 3 天
    if (!this.cursor) {
      this.coldStartCutoff = Date.now() - COLD_START_GRACE_MS;
      console.warn(
        `[wecom] 无可用 cursor（首次启动或状态文件缺失/损坏），冷启动：` +
          `${new Date(this.coldStartCutoff).toLocaleString('zh-CN')} 之前的消息只标记已处理、不回复`,
      );
    }
  }

  private stateJson(): string {
    capHandled(this.handled);
    // handled 保持 [msgid, ts][] 旧格式、在途表放新字段 pending：deploy.sh 回滚到旧镜像时旧代码照样读得懂
    return JSON.stringify({ cursor: this.cursor, handled: [...this.handled], pending: [...this.inflight.values()] });
  }

  /** 落盘排成一条链：拉取、处理完成、停机三处都会写，并发写同一个 .tmp 会互相踩（rename 报 ENOENT） */
  save(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      try {
        await mkdir(VAR_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        await writeFile(tmp, this.stateJson(), 'utf8');
        await rename(tmp, STATE_FILE);
      } catch (err) {
        console.error('[wecom] 状态落盘失败:', err);
      }
    });
    return this.saveChain;
  }

  /** 去抖落盘：同一时段多条消息先后处理完，不必各写一次盘 */
  scheduleSave(): void {
    if (this.stateSaveTimer) return;
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = null;
      void this.save();
    }, 500);
    this.stateSaveTimer.unref();
  }

  /** 进程退出前把去抖窗口里的状态同步写出去。
   *  停机钩子等待超时被强制 process.exit 时，异步的 save 来不及跑；
   *  'exit' 阶段只能跑同步代码，所以这里用 writeFileSync。 */
  flushSync(): void {
    if (!this.stateSaveTimer) return;
    clearTimeout(this.stateSaveTimer);
    this.stateSaveTimer = null;
    try {
      fs.mkdirSync(VAR_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', this.stateJson(), 'utf8');
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (err) {
      console.error('[wecom] 退出前状态落盘失败:', err);
    }
  }

  async close(): Promise<void> {
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
    }
    await this.save();
  }

  async resetForTest(): Promise<void> {
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
      void this.save();
    }
    await this.saveChain;
    this.cursor = '';
    this.handled.clear();
    this.inflight.clear();
    this.coldStartCutoff = 0;
  }
}

// ---------------- 库里的账号：第 7 步的过渡后端（第 9 步换成 channel_inbox） ----------------

const SYSTEM_ACTOR = { kind: 'system' as const, userId: null, name: null, ip: null };

export class AccountCursorState implements WecomStateBackend {
  readonly kind = 'account_cursor' as const;
  cursor = '';
  coldStartCutoff = 0;
  readonly handled = new Map<string, number>();
  readonly inflight = new Map<string, PendingEntry>();
  private saveChain: Promise<void> = Promise.resolve();
  /** 库里这个账号的 cursor：启动时是 initChannels 那一刻读出的，之后是最近一次写进库的（没变就不再发 UPDATE） */
  private savedCursor: string;

  /**
   * @param initialCursor initChannels 那一刻读出的 channel_accounts.cursor（null 表示冷启动）
   * @param log 日志前缀（带账号 key，不带 corp_id、open_kfid）
   */
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly accountId: string,
    initialCursor: string | null,
    private readonly log: string,
  ) {
    this.savedCursor = initialCursor ?? '';
  }

  async load(): Promise<void> {
    this.cursor = this.savedCursor;
    if (!this.cursor) {
      this.coldStartCutoff = Date.now() - COLD_START_GRACE_MS;
      console.warn(
        `${this.log} 无可用 cursor（库里这个账号还没拉过），冷启动：` +
          `${new Date(this.coldStartCutoff).toLocaleString('zh-CN')} 之前的消息只标记已处理、不回复`,
      );
    }
  }

  /** cursor 写进这个账号自己那一行（withTenant(account.tenantId)，R20）；按先后排成一条链，旧的写不会盖掉新的 */
  save(): Promise<void> {
    capHandled(this.handled);
    this.saveChain = this.saveChain.then(async () => {
      const cursor = this.cursor;
      if (!cursor || cursor === this.savedCursor) return;
      try {
        await withTenant(this.db, { tenantId: this.tenantId, actor: SYSTEM_ACTOR }, (tx) =>
          updateChannelAccount(tx, this.accountId, { cursor, cursorAt: new Date() }),
        );
        this.savedCursor = cursor;
      } catch (err) {
        // 不带 SQL 参数（参数里有 cursor）：只记错误名与 SQLSTATE
        const code = (err as { code?: string } | null)?.code;
        console.error(`${this.log} cursor 写库失败（${code ?? (err instanceof Error ? err.name : 'unknown')}），下一页再写`);
      }
    });
    return this.saveChain;
  }

  /** handled 与在途表不落库（过渡后端只在内存里），cursor 已在 save 里写过 */
  scheduleSave(): void {}

  flushSync(): void {}

  async close(): Promise<void> {
    await this.save();
  }

  async resetForTest(): Promise<void> {
    await this.saveChain;
    this.cursor = '';
    this.handled.clear();
    this.inflight.clear();
    this.coldStartCutoff = 0;
  }
}
