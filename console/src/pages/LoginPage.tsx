// 登录页（05 spec「界面 · 登录页」，2026-10-12 owner 定的设计稿 B；设计系统 §2.3 display、§3「登录页控件 40」）。
// demo：左栏字标、标题「登录」、一句说明、表单，下方一行「没有账号？免登录体验」（没配沙箱时是「只看演示数据」）；
// 右栏是产品画面图，图与 alt 由 /api/console/entry 下发，console 源码不出现行业词。
// prod：左栏表单，右栏用一条询价的流程说明产品（窄屏隐藏），没有体验入口。
// 登录成功后重新判断来者：并发取 /me 与 /pack（shell/boot.ts），进成员外壳；地址不变，登录前在哪一页，登录后还在哪一页
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { type MouseEvent, useEffect, useRef } from 'react';
import { LoginForm } from '../LoginForm.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { type PublicEntryBrand, type Showcase } from '../../../src/shared/entry-ui.js';
import { cjk } from '../typography.js';
import { type AnonViewer, type Viewer, VIEWER_KEY } from '../viewer.js';

const STORY_STEPS = [
  { title: '收到询价', note: '文字、图片和表格都能接', state: '已整理', tone: 'done' },
  { title: '匹配与试算', note: '核对规格和数量，按规则算价', state: '已完成', tone: 'done' },
  { title: '报价审批', note: '顾问确认后才会发给客户', state: '待审批', tone: 'pending' },
  { title: '发给客户', note: '需要时由顾问接手', state: '下一步', tone: 'next' },
] as const;

function LoginStory() {
  return (
    <aside className="login-story" aria-label="产品说明">
      <h2>
        {cjk('接住每条询价，')}
        <br />
        {cjk('把报价交给规则。')}
      </h2>
      <p className="login-story-lead">{cjk('让AI整理需求，让顾问把住报价与承诺。')}</p>
      <ol className="login-story-steps">
        {STORY_STEPS.map((step) => (
          <li key={step.title}>
            <div>
              <strong>{step.title}</strong>
              <span>{cjk(step.note)}</span>
            </div>
            <em data-tone={step.tone}>{step.state}</em>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function LoginPage({
  demo,
  tryUrl,
  showcase,
  entryBrand: brand,
  returning: back = false,
}: {
  demo?: AnonViewer;
  tryUrl?: string | null;
  showcase?: Showcase | null;
  entryBrand?: PublicEntryBrand;
  returning?: boolean;
}) {
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.publicHref });
  useDocumentTitle(brand?.name ? `登录 · ${brand.name} · 单来` : '登录 · 单来');
  const image = brand ? brand.image : showcase;
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
        {/* prod 的卡片标题已是产品名，再放字标就重复了。 */}
        {demo && <div className="entry-wordmark">单来</div>}
        <div className="login-column">
          <h1 className="login-title">单来</h1>
          <p className="login-lead">
            {brand ? (
              cjk(brand.name)
            ) : (
              <>
                {cjk('在企业微信里接收工业询价，')}
                <br />
                {cjk('匹配产品、试算报价、审批与人工接手。')}
              </>
            )}
          </p>
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
      {!demo && <LoginStory />}
      {demo && image && (
        <aside className="entry-showcase" aria-label="产品画面">
          <div className="entry-showcase-content">
            <img src={image.src} alt={image.alt} width="460" />
            <h2>单来</h2>
            <p>接收工业询价，匹配产品、试算报价、审批与人工接手</p>
          </div>
        </aside>
      )}
    </div>
  );
}
