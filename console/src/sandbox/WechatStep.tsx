// R22：签码只留在当前页面；二维码在浏览器生成，不请求外部图片。
import { Button } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { QrCodeGenerateResult } from 'uqr';
import { HttpError } from '../api.js';
import { Skeleton } from '../parts/StateView.js';
import { csrfHeader, sessionFetch } from '../session.js';
import { cjk } from '../typography.js';
import type { SandboxInfo } from './Sandbox.js';

interface Code {
  code: string;
  expiresAt: string;
  contactLink: string;
}
type ReadyCode = Code & { href: string; qr: QrCodeGenerateResult };
type CodeState = { kind: 'loading' } | { kind: 'error' } | { kind: 'full' } | { kind: 'ready'; value: ReadyCode; attempt: number };

function codeHref(value: Code): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(value.code) || !(Date.parse(value.expiresAt) > Date.now()))
    throw new Error('bad_response');
  const url = new URL(value.contactLink);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('bad_response');
  url.searchParams.set('scene_param', value.code.replace('-', ''));
  return url.href;
}

function SimulatorFallback({ full }: { full: boolean }) {
  return (
    <>
      {full && <p role="status">微信体验名额已满</p>}
      <p>{cjk('以客户的身份发一句，等AI回复。')}</p>
      <a href="/chat.html" target="_blank" rel="noopener noreferrer">
        打开模拟器
      </a>
    </>
  );
}

export function WechatStep({ wechat, expanded = true }: { wechat: SandboxInfo['wechat']; expanded?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CodeState>({ kind: 'loading' });
  const [slow, setSlow] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const lastAttempt = useRef(-1);
  const code = useRef<ReadyCode | null>(null);
  const enabled = expanded && visible;
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const requestCode = () => {
    if (!expanded || document.visibilityState === 'hidden') return;
    lastAttempt.current = -1;
    setState({ kind: 'loading' });
    setSlow(false);
    setAttempt((a) => a + 1);
  };
  const wantsCode = wechat === 'unbound' || (wechat === 'bound' && attempt > 0);
  const inWechat = /MicroMessenger/i.test(navigator.userAgent);

  useEffect(() => {
    if (!wantsCode || !enabled) return;
    // 成功的有效码继续用；失败后只接受用户点重试，不在恢复可见时自动重试。
    if (lastAttempt.current === attempt && (!code.current || Date.parse(code.current.expiresAt) > Date.now())) return;
    let active = true;
    let settled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      if (active) {
        settled = true;
        setState({ kind: 'error' });
      }
    }, 15_000);
    void (async () => {
      await Promise.resolve();
      if (!active || document.visibilityState === 'hidden') return;
      lastAttempt.current = attempt;
      code.current = null;
      setState({ kind: 'loading' });
      setSlow(false);
      try {
        const res = await sessionFetch('/api/sandbox/wechat/code', {
          method: 'POST',
          headers: csrfHeader(),
          signal: controller.signal,
        });
        const body = await res.json();
        if (!res.ok) throw new HttpError(res.status, body);
        const value = body as Code;
        const href = codeHref(value);
        const { encode } = await import('uqr');
        const qr = encode(href, { border: 4, ecc: 'M' });
        if (!active || controller.signal.aborted) return;
        const remaining = Date.parse(value.expiresAt) - Date.now();
        if (remaining <= 0) throw new Error('bad_response');
        settled = true;
        code.current = { ...value, href, qr };
        setState({ kind: 'ready', value: code.current, attempt });
      } catch (error) {
        if (active) {
          settled = true;
          setState({ kind: error instanceof HttpError && error.body.error === 'sandbox_wecom_full' ? 'full' : 'error' });
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      if (!settled) lastAttempt.current = -1;
    };
  }, [wantsCode, attempt, enabled]);

  useEffect(() => {
    if (!enabled || !wantsCode || state.kind !== 'ready') return;
    const remaining = Date.parse(state.value.expiresAt) - Date.now();
    // 恢复时已过期的码由取码 effect 换新，不能再启动第二个请求。
    if (remaining <= 0) return;
    const expiry = setTimeout(() => {
      if (document.visibilityState === 'hidden') return;
      setState({ kind: 'loading' });
      setSlow(false);
      setAttempt((a) => a + 1);
    }, remaining);
    const hint = setTimeout(() => setSlow(true), Math.max(0, remaining - 7 * 60_000));
    return () => {
      clearTimeout(expiry);
      clearTimeout(hint);
    };
  }, [enabled, wantsCode, state]);

  if (wechat === 'off' || wechat === 'full')
    return (
      <>
        <h3>打开模拟器发一句</h3>
        <SimulatorFallback full={wechat === 'full'} />
      </>
    );
  return (
    <div className="sandbox-wechat">
      <h3>{wechat === 'unbound' && state.kind === 'full' ? '打开模拟器发一句' : '用微信给AI发一句'}</h3>
      {wechat === 'bound' && <p role="status">已连上你的微信</p>}
      {wechat === 'bound' && !wantsCode && (
        <Button size="small" onClick={requestCode}>
          换一个微信
        </Button>
      )}
      {wantsCode &&
        (state.kind === 'loading' ? (
          <div role="status" aria-label="正在取微信体验码">
            <Skeleton rows={2} />
          </div>
        ) : state.kind === 'full' ? (
          <SimulatorFallback full />
        ) : state.kind === 'error' ? (
          <div role="alert">
            <p>没取到微信体验码</p>
            <Button size="small" onClick={requestCode}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <p>{cjk('用微信扫码，给AI发一句。')}</p>
            <svg
              className={`sandbox-qr${inWechat ? ' is-wechat' : ''}`}
              role="img"
              aria-label="微信体验二维码"
              viewBox={`0 0 ${state.value.qr.size} ${state.value.qr.size}`}
            >
              <rect width="100%" height="100%" fill="white" />
              <path
                fill="black"
                d={state.value.qr.data.flatMap((row, y) => row.flatMap((black, x) => (black ? [`M${x},${y}h1v1h-1z`] : []))).join('')}
              />
            </svg>
            {inWechat && (
              <a className="sandbox-open-wechat" href={state.value.href} rel="noreferrer">
                在微信里打开
              </a>
            )}
            <p>
              {cjk('也可以在微信里发送这个码：')}
              <br />
              <code className="sandbox-wechat-code">{state.value.code}</code>
            </p>
            <p>{cjk('码过期会自动换新。')}</p>
            {slow && wechat === 'unbound' && (
              <p role="status">
                {cjk('扫码没反应？先用模拟器体验')}
                <br />
                <a href="/chat.html" target="_blank" rel="noopener noreferrer">
                  打开模拟器
                </a>
              </p>
            )}
          </>
        ))}
      {wechat === 'bound' && wantsCode && (
        <Button size="small" onClick={() => setAttempt(0)}>
          收起二维码
        </Button>
      )}
    </div>
  );
}
