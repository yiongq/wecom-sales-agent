import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import { h } from 'vue';
import Search from './Search.vue';
import './style.css';

const GUIDE_NOTES: Record<string, string> = {
  '/bind-wecom.html': '把微信客服接到单来，询价才能进来。',
  '/catalog.html': '维护型号、阶梯价和库存，报价都从这里算。',
  '/sales-sop.html': '调整语气和异议处理，固定规则由代码核对。',
  '/faq.html': '报价、库存、转人工和试用的常见疑问。',
};

export default {
  extends: DefaultTheme,
  Layout: () => {
    const { theme, page } = useData();
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-before': () => h(Search),
      // VitePress 窄屏目录依赖脚本打开；正文内始终保留六类指南入口。
      'doc-before': () =>
        h(
          'nav',
          { class: 'plain-directory', 'aria-label': '指南目录' },
          theme.value.sidebar.map((item: { text: string; link: string }) => h('a', { href: item.link }, item.text)),
        ),
      'doc-footer-before': () =>
        page.value.relativePath === 'index.md'
          ? h(
              'nav',
              { class: 'guide-cards', 'aria-label': '继续阅读' },
              theme.value.sidebar
                .filter((item: { link: string }) => GUIDE_NOTES[item.link])
                .map((item: { text: string; link: string }) =>
                  h('a', { href: item.link }, [h('strong', item.text), h('span', GUIDE_NOTES[item.link])]),
                ),
            )
          : null,
      'layout-bottom': () =>
        h('footer', { class: 'site-foot' }, [
          h('p', '单来 · 工业询价。让询价有条理，让报价有依据。'),
          h('p', '软件代码采用 MIT 许可；「单来」名称与标识不在 MIT 授权内。商业事项另记。'),
        ]),
      'not-found': () =>
        h('main', { class: 'vp-doc not-found' }, [
          h('h1', '页面未找到'),
          h('p', '请从目录重新开始阅读。'),
          h('a', { href: '/' }, '回到首页'),
        ]),
    });
  },
};
