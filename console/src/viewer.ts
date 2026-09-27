// 当前是谁在看：成员（带角色与 csrf）、demo 下的匿名只读、要登录、或服务端在文件模式（后台不可用）
import { useQuery } from '@tanstack/react-query';
import type { ApiError, Me } from '../../src/shared/console-api.js';
import { api, HttpError } from './api.js';
import { beginMemberSession, isMemberSession } from './session.js';

export type Viewer = { kind: 'member'; me: Me } | { kind: 'anon' } | { kind: 'login' } | { kind: 'disabled' };

export const VIEWER_KEY = ['viewer'] as const;

async function loadViewer(): Promise<Viewer> {
  const me = await api.me.$get();
  if (me.status === 200) {
    const body = await me.json();
    beginMemberSession(body);
    return { kind: 'member', me: body };
  }
  // 成员身份下 /me 没成功（就地登录框被关掉，或服务出错）：不降成匿名，页面留着原来的身份（spec「会话过期的判定」）
  if (isMemberSession()) throw new HttpError(me.status, (await me.json().catch(() => ({ error: 'bad_response' }))) as ApiError);
  if (me.status === 503) return { kind: 'disabled' };
  // 没有会话：demo 下 /status 匿名可读（只有 mode），prod 下 401
  const status = await api.status.$get();
  return status.status === 200 ? { kind: 'anon' } : { kind: 'login' };
}

export function useViewer() {
  return useQuery({ queryKey: VIEWER_KEY, queryFn: loadViewer, staleTime: 60_000 });
}

/** 改 SOP、发布、回滚、上新、编辑、上架、看审计：只有 owner / admin */
export const canEdit = (v: Viewer | undefined): boolean => v?.kind === 'member' && (v.me.role === 'owner' || v.me.role === 'admin');
