// 话术的发布前检查（spec「销售话术 · 检查」）：每次自动保存成功以后调一次 POST /sop/draft/check，清单写「上次14:05」。
// 页面按 key 驱动：key 是存下来的那份草稿（id、rev）加线上版本，变了就跑一次——自动保存存上了、载入最新草稿、
// 回滚以后线上换了、打开页面时已经有草稿，都是它变了；没有草稿（没改过、发布或丢弃以后）时是 null，清掉结果。
// 同一时刻可以有几个检查在路上（存得快时），只认最后发出的那一个的结果；没跑成时保留上一次的结果，另记错误，「重试」再跑。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftCheck } from '../../../src/shared/console-api.js';

export interface DraftCheckState {
  result: DraftCheck | null;
  /** 最近一次跑成的时刻（清单的「上次14:05」） */
  at: number | null;
  /** 最近一次没跑成；跑成了就清掉 */
  error: unknown;
}

const EMPTY: DraftCheckState = { result: null, at: null, error: null };

export interface DraftCheckInput {
  /** 能编辑的成员才检查（检查接口只给他们） */
  enabled: boolean;
  /** 存下来的草稿与线上版本；没有草稿是 null */
  key: string | null;
  post(): Promise<DraftCheck>;
  now(): number;
}

export function useDraftCheck(input: DraftCheckInput): DraftCheckState & { retry(): void } {
  const [state, setState] = useState<DraftCheckState>(EMPTY);
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  /** 发出去的第几个；回来时不是最后一个就不认 */
  const seq = useRef(0);
  const run = useCallback((): void => {
    seq.current += 1;
    const n = seq.current;
    latest.current.post().then(
      (result) => {
        if (n === seq.current) setState({ result, at: latest.current.now(), error: null });
      },
      (error: unknown) => {
        if (n === seq.current) setState((s) => ({ ...s, error }));
      },
    );
  }, []);

  const { enabled, key } = input;
  const active = enabled && key !== null;
  // 没有草稿了（发布、丢弃以后）：上一份草稿的结果清掉，之后新建的草稿不会先显示它。在渲染时按上一次渲染的值调整
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) setState(EMPTY);
  }
  useEffect(() => {
    if (enabled && key !== null) run();
    // 还在路上的不认
    else seq.current += 1;
  }, [enabled, key, run]);
  // 卸下以后回来的都不认
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );
  return { ...state, retry: run };
}

/** 存下来的草稿与线上版本（useDraftCheck 的 key） */
export const checkKey = (draft: { id: string; rev: number } | null, publishedId: string): string | null =>
  draft ? `${draft.id}:${draft.rev}:${publishedId}` : null;
