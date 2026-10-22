// 07 R7：结果只属于启动它的草稿；离页、换 rev 或运行结束就停止轮询。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiError, GateRunView, StartGateResult } from '../../../src/shared/console-api.js';
import { api, HttpError, unwrap } from '../api.js';

export const GATE_POLL_MS = 3000;
export type GateState = { run: GateRunView | null; error: unknown; starting: boolean; own: boolean; id: string | null };
const empty = (): GateState => ({ run: null, error: null, starting: false, own: false, id: null });
export const gateActive = (run: GateRunView | null): boolean => run?.status === 'queued' || run?.status === 'running';

export function useGate(key: string | null, rev: number | null) {
  const [saved, setSaved] = useState<{ key: string | null; state: GateState }>(() => ({ key, state: empty() }));
  const current = useRef(key);
  useLayoutEffect(() => {
    current.current = key;
  }, [key]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (saved.key !== key) setSaved({ key, state: empty() });
  const state = saved.key === key ? saved.state : empty();
  const update = (fn: (s: GateState) => GateState): void => {
    if (mounted.current && current.current === key) setSaved((s) => (s.key === key ? { key, state: fn(s.state) } : s));
  };
  const { id } = state;
  useEffect(() => {
    if (!key || !id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async (): Promise<void> => {
      try {
        const run = await unwrap(api.sop['gate-runs'][':id'].$get({ param: { id } }, { init: { signal: abort.signal } }));
        if (stopped) return;
        setSaved((s) =>
          s.key === key && s.state.id === id ? { ...s, state: { ...s.state, run, error: gateActive(run) ? s.state.error : null } } : s,
        );
        if (gateActive(run)) timer = setTimeout(() => void poll(), GATE_POLL_MS);
      } catch (error) {
        if (!stopped)
          setSaved((s) => (s.key === key && s.state.id === id ? { ...s, state: { ...s.state, error, id: null, run: null } } : s));
      }
    };
    void poll();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [key, id]);
  const start = async (): Promise<void> => {
    if (!key || rev === null || state.starting || gateActive(state.run)) return;
    update(() => ({ ...empty(), starting: true }));
    try {
      // 此接口是 202，不能用只接受 200 的 unwrap。
      const res = await api.sop.draft.gate.$post({ json: { rev } });
      const body = await res.json();
      if (res.status !== 202) throw new HttpError(res.status, body as unknown as ApiError);
      update(() => ({ ...empty(), id: (body as StartGateResult).runId, own: true }));
    } catch (error) {
      if (error instanceof HttpError && error.body.error === 'gate_active' && error.body.runId) {
        // 活动运行可能对应旧 rev；没有草稿身份的返回值只能展示，不能当本草稿的通过凭证。
        update(() => ({ ...empty(), id: error.body.runId!, error }));
      } else update(() => ({ ...empty(), error }));
    }
  };
  const passed = state.own && state.error === null && state.run?.status === 'done' && state.run.verdict === 'pass';
  return {
    ...state,
    passed,
    gateRunId: passed ? state.run!.id : undefined,
    start,
    reject: (error: unknown) => update((s) => ({ ...s, error, own: false, id: null })),
  };
}
export type GateController = ReturnType<typeof useGate>;

export function gateError(error: string | null): string {
  switch (error) {
    case 'budget_stop':
      return '回归费用已到上限，请重新跑或请所有者填写原因强制发布';
    case 'timeout':
      return '回归等待太久，已停止，请稍后重试';
    case 'child_exit':
      return '回归进程意外退出，请重新跑';
    case 'child_spawn':
      return '回归暂时启动不了，请稍后重试';
    case 'report_invalid':
      return '回归结果不完整，请重新跑';
    case 'cancelled':
      return '回归已取消，请重新跑';
    default:
      return '回归出错了，请稍后重试';
  }
}
