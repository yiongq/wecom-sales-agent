// 当前是谁在看：成员（带角色与 csrf）、demo 下的匿名只读、要登录、或服务端在文件模式（后台不可用）；
// 成员与匿名都带着当前租户的行业包配置（/pack）。启动时并发取 /me 与 /pack，判定见 shell/boot.ts（spec「外壳 · 启动」）
import { useQuery } from '@tanstack/react-query';
import type { Me } from '../../src/shared/console-api.js';
import type { IndustryPack } from '../../src/shared/pack.js';
import { api, HttpError, unwrap } from './api.js';
import { type Outcome, resolveBoot, type Viewer } from './shell/boot.js';
import { beginMemberSession, isMemberSession, logoutMemberSession } from './session.js';

export type { AnonViewer, Viewer } from './shell/boot.js';

export const VIEWER_KEY = ['viewer'] as const;

async function outcome(req: Promise<{ status: number; json(): Promise<unknown> }>): Promise<Outcome> {
  try {
    const res = await req;
    return { status: res.status, body: await res.json().catch(() => ({ error: 'bad_response' })) };
  } catch (e) {
    return { thrown: e };
  }
}

async function loadViewer(): Promise<Viewer> {
  const [me, pack] = await Promise.all([outcome(api.me.$get()), outcome(api.pack.$get())]);
  const v = resolveBoot(me, pack, isMemberSession());
  if (v.kind === 'member') beginMemberSession(v.me);
  return v;
}

/**
 * 退出登录。退出接口也要 x-csrf：session.ts 先离开成员身份，csrf 留到这个请求结束。服务端回 401（会话本来就没了）也算退出了；
 * 其余失败抛出，仍是成员，由页面就地显示
 */
export function logout(): Promise<void> {
  return logoutMemberSession(() =>
    unwrap(api.auth.logout.$post()).catch((e: unknown) => {
      if (!(e instanceof HttpError && e.status === 401)) throw e;
    }),
  );
}

export function useViewer() {
  return useQuery({ queryKey: VIEWER_KEY, queryFn: loadViewer, staleTime: 60_000 });
}

/** 去登录页（侧栏、⌘K 的「登录」，横幅的「登录后编辑」）：从 demo 匿名来的带上原来的匿名视图，「返回演示」回到它 */
export const toLogin = (prev: Viewer | undefined): Viewer => (prev?.kind === 'anon' ? { kind: 'login', demo: prev } : { kind: 'login' });

/** 就地登录成功后的成员视图：行业包沿用之前拿到的那份（同一个部署、同一个租户） */
export function memberViewer(prev: Viewer | undefined, me: Me): Viewer | undefined {
  return prev && 'pack' in prev ? { kind: 'member', me, pack: prev.pack } : prev;
}

/** 当前租户的行业包；还没判定出来（或要登录、文件模式）时是 undefined */
export function usePack(): IndustryPack | undefined {
  const v = useViewer().data;
  return v && 'pack' in v ? v.pack : undefined;
}

/** 改 SOP、发布、回滚、上新、编辑、上架、看审计：只有 owner / admin */
export const canEdit = (v: Viewer | undefined): boolean => v?.kind === 'member' && (v.me.role === 'owner' || v.me.role === 'admin');
