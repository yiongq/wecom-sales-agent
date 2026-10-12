// 登录页（05 spec「界面 · 登录页」，2026-10-12 owner 定的设计稿 B；设计系统 §2.3 display、§3「登录页控件 40」）。
// demo：左栏字标、标题「登录」、一句说明、表单，下方一行「没有账号？免登录体验」（没配沙箱时是「只看演示数据」）；
// 右栏是产品画面图，图与 alt 由 /api/console/entry 下发，console 源码不出现行业词。prod：单栏卡片，没有右栏与体验入口。
// 登录成功后重新判断来者：并发取 /me 与 /pack（shell/boot.ts），进成员外壳；地址不变，登录前在哪一页，登录后还在哪一页
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { type MouseEvent, useEffect, useRef } from 'react';
import { LoginForm } from '../LoginForm.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { SHOWCASE_COPY, type Showcase } from '../../../src/shared/entry-ui.js';
import { cjk } from '../typography.js';
import { type AnonViewer, type Viewer, VIEWER_KEY } from '../viewer.js';

export function LoginPage({
  demo,
  tryUrl,
  showcase,
  returning: back = false,
}: {
  demo?: AnonViewer;
  tryUrl?: string | null;
  showcase?: Showcase | null;
  returning?: boolean;
}) {
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.publicHref });
  useDocumentTitle('AI销售工作台');
  // 进入匿名视图时链接随登录页卸载，焦点放到已挂载的外壳 main。
  const returning = useRef(false);
  useEffect(
    () => () => {
      if (returning.current) document.getElementById('main')?.focus();
    },
    [],
  );

  const backToDemo = (e: MouseEvent<HTMLAnchorElement>): void => {
    // 带修饰键或中键是要新开标签页，交给浏览器
    if (!demo || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    returning.current = true;
    qc.setQueryData<Viewer>(VIEWER_KEY, demo);
  };

  return (
    <div className={`login-page ${demo ? 'login-demo' : 'login-prod'}`}>
      <main id="main" className="login-panel">
        <div className="entry-wordmark">AI销售工作台</div>
        <div className="login-column">
          <h1 className="login-title">登录</h1>
          <p className="login-lead">{cjk('AI在企业微信里接待客户，你在这里管话术、产品和会话。')}</p>
          <LoginForm autoFocus onSuccess={() => void qc.resetQueries({ queryKey: VIEWER_KEY })} />
          {demo && (
            <p className="login-back">
              没有账号？
              {tryUrl ? (
                <a href={`${tryUrl}?start=1`} rel="nofollow">
                  免登录体验
                </a>
              ) : (
                <a href="/console/?view=demo" onClick={backToDemo}>
                  只看演示数据
                </a>
              )}
            </p>
          )}
          {demo && back && tryUrl && (
            <p className="login-back">
              <a href={href} onClick={backToDemo}>
                返回演示
              </a>
            </p>
          )}
        </div>
      </main>
      {demo && showcase && (
        <aside className="entry-showcase" aria-label="产品画面">
          <div className="entry-showcase-content">
            <img src={showcase.src} alt={showcase.alt} width="460" />
            <h2>{SHOWCASE_COPY.title}</h2>
            <p>{SHOWCASE_COPY.description}</p>
          </div>
        </aside>
      )}
    </div>
  );
}
