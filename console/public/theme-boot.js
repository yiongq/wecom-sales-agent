// 首帧之前把外观与「减少动态效果」设到 <html> 上（console UX spec「视觉与字体 · 主题」、design-system §1.5），深色刷新不闪白。
// 页面 CSP 是 script-src 'self'，不能写内联脚本，所以是这个静态文件：index.html 的 <head> 里同步加载，早于样式和应用脚本。
// 读不到 localStorage（无痕模式、禁用了存储）时按默认：浅色、不减少动效。键名、取值与判定和 console/src/theme/prefs.ts 相同，
// theme.selftest.ts 两边对拍；页面起来以后由 prefs.ts 接管（跟随系统、用户菜单的开关）
(() => {
  const root = document.documentElement;
  const read = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const appearance = read('console.appearance');
  let dark = appearance === 'dark';
  if (appearance === 'system') {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      dark = false;
    }
  }
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (read('console.reduceMotion') === 'true') root.setAttribute('data-reduce-motion', 'true');
  else root.removeAttribute('data-reduce-motion');
})();
