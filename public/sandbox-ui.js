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
  banner.setAttribute('role', 'note');
  banner.id = 'sandboxBanner';
  banner.style.cssText =
    'flex:none;padding:10px 16px;border-bottom:1px solid #d1ddce;background:#eef5e9;color:#365637;font-size:12px;line-height:1.6';
  const summary = document.createElement('strong');
  summary.id = 'sandboxSummary';
  summary.textContent = '体验环境 · 只进模拟器';
  const privacy = document.createElement('div');
  privacy.textContent =
    '不要输入真实个人信息。体验最长 24 小时，闲置会提前结束。备份保留本地 7 天、异地 30 天；企微记录按企微规则保存，不随沙箱删除。';
  banner.append(summary, privacy);
  messages.before(banner);
  fetch('/api/console/me', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) return;
      const { sandbox } = await response.json();
      if (!sandbox) return;
      const hours = Math.max(0, Math.ceil((Date.parse(sandbox.expiresAt) - Date.now()) / 3600000));
      const remaining = Number.isFinite(hours) ? ' · 剩余 ' + hours + ' 小时' : '';
      summary.textContent = '体验环境' + remaining + (sandbox.wechat === 'off' ? ' · 只进模拟器' : ' · 回复只发到你自己的微信');
    })
    .catch(() => {});
})();
