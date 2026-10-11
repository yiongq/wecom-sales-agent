// 登录页（spec「登录」，设计系统 §2.3 的 display 字阶、§3「登录页控件 40」、§5.1）。一栏居中：标题「运营后台」、一句说明、表单；
// 不做半屏品牌色块加表单卡。外面照外壳的样子，是 --frame 底上一块内嵌的内容面板：登录之后侧栏出现，面板还在原处。
// 05 R23：demo 首次进入也先登录；「只看演示数据」左键就地进匿名外壳，焦点放回内容面板。
// 新标签打开仍先登录；免登录体验通过宿主 /try 跳转，prod 没有两个演示入口。
// 登录成功后重新判断来者：并发取 /me 与 /pack（shell/boot.ts），进成员外壳；地址不变，登录前在哪一页，登录后还在哪一页
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { Button } from 'antd';
import { type MouseEvent, useEffect, useRef } from 'react';
import { LoginForm } from '../LoginForm.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { cjk } from '../typography.js';
import { type AnonViewer, type Viewer, VIEWER_KEY } from '../viewer.js';

export function LoginPage({ demo, tryUrl }: { demo?: AnonViewer; tryUrl?: string | null }) {
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.publicHref });
  useDocumentTitle('wecom-sales-agent · 企业微信AI销售助手');
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
    <div className="login-page">
      <main id="main" className="login-panel">
        <div className="login-column">
          <img className="login-cover" src="/share-cover.png" alt="企业微信AI销售助手" width="96" height="96" />
          <h1 className="login-title">运营后台</h1>
          {/* 在逗号处断行：一栏 360 宽放不下一整句，任由它折行会把「它们」拆到两行 */}
          <p className="login-lead">
            {cjk('在这里维护销售话术和产品库，')}
            <br />
            {cjk('企业微信里的AI销售按它们接待客户')}
          </p>
          <LoginForm autoFocus onSuccess={() => void qc.resetQueries({ queryKey: VIEWER_KEY })} />
          {demo && tryUrl && (
            <div className="login-try">
              <Button block href={tryUrl} className="login-try-button">
                免登录体验
              </Button>
              <p className="login-try-note">临时环境、24小时后删除、回复只发到你自己的微信</p>
            </div>
          )}
          {demo && (
            <p className="login-back">
              <a href={href} onClick={backToDemo}>
                只看演示数据
              </a>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
