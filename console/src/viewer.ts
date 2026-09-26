// 当前是谁在看：成员（带角色与 csrf）、demo 下的匿名只读、要登录、或服务端在文件模式（后台不可用）
import { useQuery } from '@tanstack/react-query';
import type { Me } from '../../src/shared/console-api.js';
import { api, setCsrf } from './api.js';

export type Viewer = { kind: 'member'; me: Me } | { kind: 'anon' } | { kind: 'login' } | { kind: 'disabled' };

export const VIEWER_KEY = ['viewer'] as const;

async function loadViewer(): Promise<Viewer> {
  const me = await api.me.$get();
  if (me.status === 200) {
    const body = await me.json();
    setCsrf(body.csrf);
    return { kind: 'member', me: body };
  }
  setCsrf('');
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
