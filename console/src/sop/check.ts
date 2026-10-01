// 话术的发布前检查（spec「销售话术 · 检查」）：每次自动保存成功以后调一次 POST /sop/draft/check，清单写「上次14:05」。
// 页面按 key 驱动：key 是存下来的那份草稿（id、rev）加线上版本，变了就跑一次——自动保存存上了、载入最新草稿、
// 回滚以后线上换了、打开页面时已经有草稿，都是它变了；没有草稿（没改过、发布或丢弃以后）时是 null，清掉结果。
// 同一时刻可以有几个检查在路上（存得快时），只认最后发出的那一个的结果；没跑成时保留上一次的结果，另记错误，「重试」再跑。
// 结果的类型由调用方定（R）：话术页在草稿跟不上线上版本时另带一份那时的线上版本。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftCheck } from '../../../src/shared/console-api.js';

export interface DraftCheckState<R extends DraftCheck = DraftCheck> {
  result: R | null;
  /** 最近一次跑成的时刻（清单的「上次14:05」） */
  at: number | null;
  /** 最近一次没跑成；跑成了就清掉 */
  error: unknown;
  /** 最后发出的那一个还在路上（发布抽屉等它回来才让发布） */
  running: boolean;
}

const EMPTY: DraftCheckState<never> = { result: null, at: null, error: null, running: false };

export interface DraftCheckInput<R extends DraftCheck = DraftCheck> {
  /** 能编辑的成员才检查（检查接口只给他们） */
  enabled: boolean;
  /** 存下来的草稿与线上版本；没有草稿是 null */
  key: string | null;
  post(): Promise<R>;
  now(): number;
}

export function useDraftCheck<R extends DraftCheck = DraftCheck>(input: DraftCheckInput<R>): DraftCheckState<R> & { retry(): void } {
  const { enabled, key } = input;
  /** 要检查的那份草稿；没有（没有草稿、不能编辑）是 null */
  const active = enabled ? key : null;
  const [state, setState] = useState<DraftCheckState<R>>(() => (active === null ? EMPTY : { ...EMPTY, running: true }));
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  /** 发出去的第几个；回来时不是最后一个就不认 */
  const seq = useRef(0);
  /** 发一个检查；running 由调用方先置上 */
  const issue = useCallback((): void => {
    seq.current += 1;
    const n = seq.current;
    latest.current.post().then(
      (result) => {
        if (n === seq.current) setState({ result, at: latest.current.now(), error: null, running: false });
      },
      (error: unknown) => {
        if (n === seq.current) setState((s) => ({ ...s, error, running: false }));
      },
    );
  }, []);
  const retry = useCallback((): void => {
    setState((s) => (s.running ? s : { ...s, running: true }));
    issue();
  }, [issue]);

  // 草稿变了：在渲染时按上一次渲染的值调整。没有草稿了（发布、丢弃以后）：上一份草稿的结果清掉，之后新建的草稿不会先显示它；
  // 换了一份：结果先留着，记上正在检查（下面的 effect 发出去）
  const [was, setWas] = useState(active);
  if (active !== was) {
    setWas(active);
    setState((s) => (active === null ? EMPTY : s.running ? s : { ...s, running: true }));
  }
  useEffect(() => {
    if (active !== null) issue();
    // 还在路上的不认
    else seq.current += 1;
  }, [active, issue]);
  // 卸下以后回来的都不认
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );
  return { ...state, retry };
}

/** 存下来的草稿与线上版本（useDraftCheck 的 key） */
export const checkKey = (draft: { id: string; rev: number } | null, publishedId: string): string | null =>
  draft ? `${draft.id}:${draft.rev}:${publishedId}` : null;
