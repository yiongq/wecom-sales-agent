import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import { h } from 'vue';
import Search from './Search.vue';
import './style.css';
export default {
  extends: DefaultTheme,
  Layout: () => {
    const { theme } = useData();
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-before': () => h(Search),
      // VitePress 窄屏目录依赖脚本打开；正文内始终保留六类指南入口。
      'doc-before': () =>
        h(
          'nav',
          { class: 'plain-directory', 'aria-label': '指南目录' },
          theme.value.sidebar.map((item: { text: string; link: string }) => h('a', { href: item.link }, item.text)),
        ),
      'not-found': () =>
        h('main', { class: 'vp-doc not-found' }, [
          h('h1', '页面未找到'),
          h('p', '请从目录重新开始阅读。'),
          h('a', { href: '/' }, '回到首页'),
        ]),
    });
  },
};
