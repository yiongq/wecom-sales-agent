// 设置数据只在内存中。失权状态独立于查询：401 等待重登期间也不能继续显示旧数据。
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { subscribeConsoleAccess } from '../api.js';
import { isMemberSession, isSessionExpired, subscribeSession } from '../session.js';
import { VIEWER_KEY, type Viewer } from '../viewer.js';
import { canReadSettings, settingsIdentity } from './model.js';

type Access = 401 | 403 | null;
interface Snapshot {
  status: Access;
  identity: string | null;
}
interface AccessState {
  snapshot: Snapshot;
  listeners: Set<() => void>;
}
const clients = new WeakMap<QueryClient, AccessState>();
function stateOf(qc: QueryClient): AccessState {
  let state = clients.get(qc);
  if (!state) {
    state = { snapshot: { status: null, identity: null }, listeners: new Set() };
    clients.set(qc, state);
  }
  return state;
}
function publish(qc: QueryClient, status: Access, identity = stateOf(qc).snapshot.identity): void {
  const state = stateOf(qc);
  if (state.snapshot.status === status && state.snapshot.identity === identity) return;
  state.snapshot = { status, identity };
  for (const listener of state.listeners) listener();
}
export function clearSettings(qc: QueryClient): void {
  void qc.cancelQueries({ queryKey: ['settings'] });
  qc.removeQueries({ queryKey: ['settings'] });
}
export function retrySettings(qc: QueryClient): void {
  publish(qc, null);
}

/** Shell 整个生命周期只安装一次，包含登录页、退出和切换身份。 */
export function watchSettingsCache(qc: QueryClient): () => void {
  const state = stateOf(qc);
  const identityChanged = () => {
    const viewer = qc.getQueryData<Viewer>(VIEWER_KEY);
    const identity = viewer?.kind === 'member' && canReadSettings(viewer) ? settingsIdentity(viewer.me) : '';
    if (state.snapshot.identity === identity) return;
    clearSettings(qc);
    publish(qc, null, identity);
  };
  identityChanged();
  const unquery = qc.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === VIEWER_KEY[0]) identityChanged();
  });
  const unaccess = subscribeConsoleAccess((status, path) => {
    publish(qc, status);
    clearSettings(qc);
    if (status === 403 && path.startsWith('/api/console/settings/')) void qc.invalidateQueries({ queryKey: VIEWER_KEY });
  });
  const unsession = subscribeSession(() => {
    if (isSessionExpired() || !isMemberSession()) {
      publish(qc, 401);
      clearSettings(qc);
    } else publish(qc, null);
  });
  return () => {
    unquery();
    unaccess();
    unsession();
  };
}
export function useSettingsCache(): void {
  const qc = useQueryClient();
  useEffect(() => watchSettingsCache(qc), [qc]);
}
export function useSettingsAccess(): Snapshot {
  const state = stateOf(useQueryClient());
  return useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => void state.listeners.delete(listener);
    },
    () => state.snapshot,
    () => state.snapshot,
  );
}
