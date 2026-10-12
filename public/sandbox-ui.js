// 仅由沙箱页面加载；宿主的页面源码和品牌自测基准保持不变。
// 服务端在原页面内联脚本之后插入同源 script 标签，并对渲染后的内联脚本生成 CSP hash。
(() => {
  // 支付页的事件属性不在 CSP 的放行范围；改用本脚本的监听器。
  for (const link of document.querySelectorAll('a[onclick="closeWebview()"]')) {
    link.removeAttribute('onclick');
    link.setAttribute('href', '#');
    link.addEventListener('click', (event) => {
      event.preventDefault();
      window.closeWebview?.();
    });
  }

  const messages = document.getElementById('msgs');
  if (!messages) return;
  const banner = document.createElement('div');
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', '体验环境');
  banner.id = 'sandboxBanner';
  banner.style.cssText =
    'flex:none;display:flex;align-items:flex-start;gap:10px;padding:10px 16px;background:var(--info-bg,#edf2f9);color:var(--text,#18181b);text-autospace:normal';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.style.cssText =
    'width:16px;height:16px;flex:none;margin-top:3px;fill:none;stroke:var(--info,#35598f);stroke-width:2;stroke-linecap:round;stroke-linejoin:round';
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 16v-4 M12 8h.01');
  icon.append(circle, path);
  const copy = document.createElement('div');
  copy.style.cssText = 'min-width:0;flex:1';
  const summary = document.createElement('div');
  summary.id = 'sandboxSummary';
  summary.style.cssText = 'font-size:14px;line-height:22px;font-weight:500';
  summary.textContent = '体验环境 · 你在扮演客户';
  const privacy = document.createElement('div');
  privacy.style.cssText = 'font-size:13px;line-height:20px;color:var(--text-2,#4d4d55)';
  privacy.textContent = '这里的回复只出现在网页上，不会发给任何人';
  copy.append(summary, privacy);
  const back = document.createElement('a');
  back.setAttribute('href', '/console/');
  back.style.cssText = 'flex:none;font-size:14px;line-height:22px;color:var(--accent-text,#255cdf)';
  back.textContent = '回工作台';
  banner.append(icon, copy, back);
  messages.before(banner);
})();
