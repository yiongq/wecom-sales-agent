// 登录页（spec「登录」，设计系统 §2.3 的 display 字阶、§3「登录页控件 40」、§5.1）。一栏居中：标题「运营后台」、一句说明、表单；
// 不做半屏品牌色块加表单卡。外面照外壳的样子，是 --frame 底上一块内嵌的内容面板：登录之后侧栏出现，面板还在原处。
// 从匿名演示点「登录」进来时（viewer 带着 demo），表单下方给「返回演示」：左键就地换回原来的匿名视图，不重新载入、地址不变，
// 焦点放回内容面板；它是指向当前地址的真链接，新标签打开照样是这一页的演示。prod 下没有演示，不给这个链接。
// 登录成功后重新判断来者：并发取 /me 与 /pack（shell/boot.ts），进成员外壳；地址不变，登录前在哪一页，登录后还在哪一页
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { type MouseEvent, useEffect, useRef } from 'react';
import { LoginForm } from '../LoginForm.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { documentTitle } from '../shell/model.js';
import { shellViewerOf } from '../shell/PageHeader.js';
import { cjk } from '../typography.js';
import { type AnonViewer, type Viewer, VIEWER_KEY } from '../viewer.js';

export function LoginPage({ demo }: { demo?: AnonViewer }) {
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.publicHref });
  const sv = shellViewerOf(demo);
  useDocumentTitle(sv ? documentTitle(['登录'], sv) : '登录');
  // 「返回演示」时这个链接随登录页一起卸载，焦点不能掉到 body 上：卸载时放到演示页的内容面板（外壳的 main，这时已经挂上了）
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
    <div className="login-page">
      <main id="main" className="login-panel">
        <div className="login-column">
          <h1 className="login-title">运营后台</h1>
          {/* 在逗号处断行：一栏 360 宽放不下一整句，任由它折行会把「它们」拆到两行 */}
          <p className="login-lead">
            {cjk('在这里维护销售话术和产品库，')}
            <br />
            {cjk('企业微信里的AI销售按它们接待客户')}
          </p>
          <LoginForm autoFocus onSuccess={() => void qc.resetQueries({ queryKey: VIEWER_KEY })} />
          {demo && (
            <p className="login-back">
              <a href={href} onClick={backToDemo}>
                返回演示
              </a>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
