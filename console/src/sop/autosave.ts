// 话术的自动保存（spec「销售话术 · 自动保存」、不变量 20、21，验收 11）：
// - 停止输入 1.5 秒后调 PUT /sop/draft，只带本地改过、还没存进草稿的节；每次都带 rev：首次是 null 加 basedOn（当前线上版本），
//   之后是上一次成功响应的 rev。页面打开时、载入最新草稿以后，本地没有待存的改动时，rev 取服务端给的草稿；
//   有待存的改动时不跟着刷新走（别人的改动要以 409 的形式冒出来，不能被悄悄盖掉）。
// - 同一时刻至多一个请求在路上；路上又有了新的改动，这一个回来以后接着存。
// - 失败：连不上、5xx、429 按 2、5、15 秒退避重试，之后每 15 秒一次，恢复联网（online 事件）时马上试；
//   别的 4xx（格式不对、固定规则节、没有权限、登录过期后没重登）重试也一样，不自动试，等下一次改动或手动「重试」。
// - 409（rev_conflict，以及并发首次保存撞上的 conflict）：不再重试，自动保存停住，由页面冻结编辑器、提示载入最新草稿。
// - ⌘S / Ctrl+S 立即保存；话术页没有「保存草稿」按钮。
// 状态机（createAutosaver）不依赖 React，计时器可以换，自测直接驱动；useAutosave 把它接到页面上。
import { createContext, useContext, useEffect, useState } from 'react';
import type { SopVersion } from '../../../src/shared/console-api.js';
import { HttpError } from '../api.js';

/** 一节要存的正文：编辑器里的原文，服务端存的时候自己规范化 */
export interface DraftEdit {
  key: string;
  body: string;
}

/** 保存带的版本号：rev 为 null 时新建草稿，basedOn 是当前线上版本 */
export interface DraftBase {
  rev: number | null;
  basedOn: string;
}

export interface AutosaveTiming {
  /** 停止输入多久以后保存 */
  debounce: number;
  /** 失败以后依次隔多久重试；用完以后一直按最后一个 */
  backoff: readonly number[];
  /** 「已自动保存14:05」取的时刻 */
  now: () => number;
}

export const AUTOSAVE_TIMING: AutosaveTiming = { debounce: 1500, backoff: [2000, 5000, 15000], now: () => Date.now() };

/** 自测把时间调短、把时钟钉住；页面用默认值 */
export const AutosaveTimingContext = createContext<AutosaveTiming>(AUTOSAVE_TIMING);

/** 第 n 次（从 0 数）失败以后隔多久重试 */
export const retryDelay = (timing: Pick<AutosaveTiming, 'backoff'>, attempt: number): number =>
  timing.backoff[Math.min(attempt, timing.backoff.length - 1)]!;

/** 一次失败怎么办：conflict 停住等载入最新草稿；retry 按退避自动重试；stop 不自动试 */
export type SaveFailure = 'conflict' | 'retry' | 'stop';

export function saveFailure(e: unknown): SaveFailure {
  if (e instanceof HttpError) {
    if (e.status === 409) return 'conflict';
    if (e.status >= 500 || e.status === 429) return 'retry';
    return 'stop';
  }
  // fetch 连不上服务时抛 TypeError
  return 'retry';
}

/** ⌘S 与 Ctrl+S（两个平台都认：Mac 的 Ctrl+S 在文本框和 CodeMirror 里没有别的用处） */
export const isSaveShortcut = (e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S');

export type SaveStatus =
  /** 本次打开页面后还没保存过 */
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  /** retrying：会不会自动重试 */
  | { kind: 'failed'; error: unknown; retrying: boolean }
  /** 409：自动保存停住，等页面载入最新草稿（resume） */
  | { kind: 'conflict'; error: unknown };

type Timer = ReturnType<typeof setTimeout>;

export interface AutosaverDeps {
  timing: () => AutosaveTiming;
  /** 有没有要存的改动 */
  hasPending(): boolean;
  /** 存一次；成功时由它更新 rev 与缓存，失败时抛 */
  send(): Promise<void>;
  onStatus(s: SaveStatus): void;
  /** 收到 409：自动保存已经停住 */
  onConflict(error: unknown): void;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export interface Autosaver {
  /** 编辑器里有了改动：从现在起重新数 1.5 秒 */
  edited(): void;
  /** 马上存（⌘S、「重试」、计时到了）；路上已有一个请求时，等它回来再存 */
  flush(): void;
  /** 恢复联网：在等自动重试的，马上试 */
  online(): void;
  /** 载入最新草稿以后：回到还没保存过的状态，接着自动保存 */
  resume(): void;
  /** 页面挂上与卸下：卸下后清掉计时器，不再发新的请求（路上的那个照常回来） */
  start(): void;
  stop(): void;
  status(): SaveStatus;
}

export function createAutosaver(deps: AutosaverDeps): Autosaver {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: Timer) => clearTimeout(t));
  let debounce: Timer | null = null;
  let retry: Timer | null = null;
  let inFlight = false;
  let again = false;
  let attempt = 0;
  let active = true;
  let status: SaveStatus = { kind: 'idle' };
  /** 上一次存上的时刻：失败以后又改回了存上的样子，状态回到它 */
  let savedAt: number | null = null;
  const set = (s: SaveStatus): void => {
    status = s;
    deps.onStatus(s);
  };
  const clearDebounce = (): void => {
    if (debounce !== null) clearTimer(debounce);
    debounce = null;
  };
  const clearRetry = (): void => {
    if (retry !== null) clearTimer(retry);
    retry = null;
  };

  async function run(): Promise<void> {
    if (!active || status.kind === 'conflict') return;
    if (!deps.hasPending()) {
      // 没保存上的改动已经改回了草稿里的样子：没有要存的了，不再写「没保存上」
      if (status.kind === 'failed') {
        clearRetry();
        attempt = 0;
        set(savedAt === null ? { kind: 'idle' } : { kind: 'saved', at: savedAt });
      }
      return;
    }
    inFlight = true;
    again = false;
    set({ kind: 'saving' });
    try {
      await deps.send();
    } catch (e) {
      inFlight = false;
      const kind = saveFailure(e);
      if (kind === 'conflict') {
        clearDebounce();
        clearRetry();
        set({ kind: 'conflict', error: e });
        deps.onConflict(e);
        return;
      }
      set({ kind: 'failed', error: e, retrying: kind === 'retry' });
      if (kind === 'retry') {
        const ms = retryDelay(deps.timing(), attempt);
        attempt += 1;
        if (active)
          retry = setTimer(() => {
            retry = null;
            flush();
          }, ms);
      } else if (again && debounce === null) {
        // 路上又改过：新的内容可能就改好了，接着试
        void run();
      }
      return;
    }
    inFlight = false;
    attempt = 0;
    savedAt = deps.timing().now();
    set({ kind: 'saved', at: savedAt });
    // 路上又要求存过（计时到了或 ⌘S），而且没有还在数的计时：接着存
    if (again && debounce === null) void run();
  }

  function flush(): void {
    clearDebounce();
    if (status.kind === 'conflict') return;
    if (inFlight) {
      again = true;
      return;
    }
    clearRetry();
    void run();
  }

  return {
    edited() {
      if (!active || status.kind === 'conflict') return;
      clearDebounce();
      debounce = setTimer(() => {
        debounce = null;
        flush();
      }, deps.timing().debounce);
    },
    flush,
    online() {
      if (status.kind === 'failed' && status.retrying && !inFlight) flush();
    },
    resume() {
      attempt = 0;
      again = false;
      savedAt = null;
      set({ kind: 'idle' });
    },
    start() {
      active = true;
    },
    stop() {
      active = false;
      clearDebounce();
      clearRetry();
    },
    status: () => status,
  };
}

export interface AutosaveInput {
  /** 能编辑的成员才自动保存 */
  enabled: boolean;
  /** 本地改过、还没存进草稿的节 */
  unsaved: readonly DraftEdit[];
  /** 服务端给的草稿的版本号（没有草稿时 rev 为 null、basedOn 是线上版本） */
  base: DraftBase;
  /** 发一次 PUT /sop/draft，返回服务端的草稿 */
  send(edits: DraftEdit[], base: DraftBase): Promise<SopVersion>;
  /** 存上了：更新缓存 */
  onSaved(draft: SopVersion): void;
  /** 409：lost 是这时还没存上的节（含路上那次以后又改的） */
  onConflict(lost: DraftEdit[], error: unknown): void;
}

export interface Autosave {
  status: SaveStatus;
  /** 立即保存（「重试」按钮） */
  flush(): void;
  /** 编辑器里有了改动 */
  edited(): void;
  /** 载入最新草稿以后接着自动保存 */
  resume(): void;
}

/**
 * 页面上的状态机连同它要读的东西：最新的属性（每次渲染以后由 effect 换上）与下一次保存带的版本号。
 * 计时器到了、按了 ⌘S 才读，渲染时不读
 */
class PageSaver {
  latest: { input: AutosaveInput; timing: AutosaveTiming };
  base: DraftBase;
  readonly saver: Autosaver;
  constructor(input: AutosaveInput, timing: AutosaveTiming, setStatus: (s: SaveStatus) => void) {
    this.latest = { input, timing };
    this.base = input.base;
    this.saver = createAutosaver({
      timing: () => this.latest.timing,
      hasPending: () => this.latest.input.enabled && this.latest.input.unsaved.length > 0,
      send: async () => {
        const { unsaved, send, onSaved } = this.latest.input;
        const v = await send(
          unsaved.map((e) => ({ ...e })),
          this.base,
        );
        this.base = { rev: v.rev, basedOn: v.basedOn ?? this.base.basedOn };
        onSaved(v);
      },
      onStatus: setStatus,
      onConflict: (e) => this.latest.input.onConflict([...this.latest.input.unsaved], e),
    });
  }
  /** 每次渲染以后换上最新的属性 */
  update(input: AutosaveInput, timing: AutosaveTiming): void {
    this.latest = { input, timing };
  }
  /** 下一次保存改带服务端给的版本号 */
  adopt(base: DraftBase): void {
    this.base = base;
  }
}

export function useAutosave(input: AutosaveInput): Autosave {
  const timing = useContext(AutosaveTimingContext);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [page] = useState(() => new PageSaver(input, timing, setStatus));
  useEffect(() => {
    page.update(input, timing);
  });
  const { saver } = page;

  // 本地没有待存的改动、也没有请求在路上时，rev 跟着服务端给的草稿走（打开页面、发布或丢弃以后、载入最新草稿）
  const clean = input.unsaved.length === 0 && status.kind !== 'saving' && status.kind !== 'conflict';
  const serverRev = input.base.rev;
  const serverBasedOn = input.base.basedOn;
  useEffect(() => {
    if (clean) page.adopt({ rev: serverRev, basedOn: serverBasedOn });
  }, [page, clean, serverRev, serverBasedOn]);

  useEffect(() => {
    saver.start();
    const onOnline = (): void => saver.online();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      saver.stop();
    };
  }, [saver]);

  const { enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!isSaveShortcut(e)) return;
      // 浏览器自己的「存储网页」不要
      e.preventDefault();
      saver.flush();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, saver]);

  return { status, flush: saver.flush, edited: saver.edited, resume: saver.resume };
}
