// 令牌落到 antd 6.6.5（design-system §8），亮暗各一份。antd 的种子色会被算法重新派生，页签、分页、默认按钮的悬停与按下、
// 焦点框默认都取 colorPrimary 系，所以这里在全局和组件两层显式写值，不靠算法（spec「视觉与字体 · 主题」）。
// 对比度自测（theme.selftest.ts）读的就是这两份配置经 theme.getDesignToken() 算出来的结果和这里写的组件令牌
import { type MappingAlgorithm, theme, type ThemeConfig } from 'antd';
import { SHARED, TOKENS, type ThemeMode, type Tokens } from './tokens.js';

type ComponentsConfig = NonNullable<ThemeConfig['components']>;

/** §8 里按主题写死、不在 brand.css 里的几个值（「生成器：accent 的 L −0.05 / −0.10」与默认按钮的悬停、按下底） */
const EXTRA: Readonly<Record<ThemeMode, Readonly<Record<string, string>>>> = {
  light: { primaryHover: '#1D53D5', primaryActive: '#0E42C3', defaultHoverBg: '#F5F5F5', defaultActiveBg: '#EBEBEB' },
  dark: { primaryHover: '#2158DA', primaryActive: '#1247C8', defaultHoverBg: '#1E1E20', defaultActiveBg: '#2A2A2C' },
};

const px = (v: string): number => Number.parseFloat(v);
/** CSS 变量里的字体栈用单引号，antd 的 fontFamily 照 §8 用双引号，内容相同 */
const dq = (v: string): string => v.replaceAll("'", '"').replaceAll(', ', ',');

/**
 * 反相 toast 上成功以外的图标（message.error / info / warning / loading，第 2.3 步只留成功 toast 之前页面里还有）。
 * 底是 --text，本主题的语义色叠上去不到 3:1（浅色 danger 2.69），所以和 --toast-icon 一样取另一套主题的同类色：
 * 浅色取深色的圆点色，深色取浅色的字色（浅色圆点叠 #EDEDEF 不够 3:1）
 */
const TOAST_ICON: Readonly<Record<ThemeMode, Readonly<Record<'error' | 'info' | 'warning', string>>>> = {
  light: { error: TOKENS.dark['danger-dot'], info: TOKENS.dark['info-dot'], warning: TOKENS.dark['warning-icon'] },
  dark: { error: TOKENS.light.danger, info: TOKENS.light.info, warning: TOKENS.light.warning },
};

/** 三档动效时长全部归零 */
const ZERO_MOTION = { motionDurationFast: '0s', motionDurationMid: '0s', motionDurationSlow: '0s' } as const;

/**
 * 算法的最后一步：把种子色钉回令牌值。colorPrimary、colorLink 和四个语义色是 antd 的种子，token 里写的值只当输入，
 * 深色算法会把它们和底色混一遍（#2F68EB 出来是 #2B5BCB，#FF9B8F 出来是 #DC877D），不钉住就和 brand.css 对不上
 */
const pinSeeds =
  (t: Tokens): MappingAlgorithm =>
  (_seed, map) => ({
    ...map!,
    colorPrimary: t.accent,
    colorLink: t['accent-text'],
    colorSuccess: t.success,
    colorWarning: t.warning,
    colorError: t.danger,
    colorInfo: t.info,
  });

function build(mode: ThemeMode, t: Tokens): ThemeConfig {
  const x = EXTRA[mode];
  return {
    algorithm: [mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm, pinSeeds(t)],
    token: {
      colorPrimary: t.accent,
      colorPrimaryHover: x.primaryHover,
      colorPrimaryActive: x.primaryActive,
      colorPrimaryBg: t['accent-bg'],
      colorPrimaryBorder: t.focus,
      colorPrimaryText: t['accent-text'],
      colorLink: t['accent-text'],
      colorLinkHover: t['accent-text'],
      // §8 没写；不写时 antd 取 colorPrimaryActive，深色下链接按住那一下只有 2:1 左右
      colorLinkActive: t['accent-text'],
      colorBgSolid: t.primary,
      colorBgSolidHover: t['primary-hover'],
      colorBgSolidActive: t['primary-active'],
      colorText: t.text,
      colorTextSecondary: t['text-2'],
      colorTextTertiary: t['text-3'],
      colorTextQuaternary: t['text-3'],
      colorTextPlaceholder: t['text-3'],
      colorTextDisabled: t['text-3'],
      colorBorder: t['control-border'],
      colorBorderSecondary: t.border,
      colorSplit: t.divider,
      colorBgLayout: t.frame,
      colorBgContainer: t.panel,
      colorBgElevated: t.raised,
      colorBgSpotlight: t.text,
      colorBgMask: t.mask,
      colorFillQuaternary: t.hover,
      colorFillTertiary: t.subtle,
      colorFillSecondary: t.selected,
      colorFill: t.pressed,
      colorFillAlter: 'transparent',
      controlItemBgHover: t.hover,
      controlItemBgActive: t.selected,
      controlItemBgActiveHover: t.pressed,
      colorSuccess: t.success,
      colorWarning: t.warning,
      colorError: t.danger,
      colorInfo: t.info,
      colorSuccessBg: t['success-bg'],
      colorWarningBg: t['warning-bg'],
      colorErrorBg: t['danger-bg'],
      colorInfoBg: t['info-bg'],
      fontFamily: dq(SHARED.font),
      fontFamilyCode: dq(SHARED.mono),
      fontSize: 14,
      fontSizeSM: 13,
      fontSizeLG: 16,
      fontSizeHeading1: 24,
      fontSizeHeading2: 16,
      fontSizeHeading3: 15,
      lineHeight: 22 / 14,
      fontWeightStrong: 600,
      controlHeight: 32,
      controlHeightSM: 28,
      controlHeightLG: 40,
      borderRadiusXS: px(SHARED['r-xs']),
      borderRadiusSM: px(SHARED['r-sm']),
      borderRadius: px(SHARED['r-sm']),
      borderRadiusLG: px(SHARED['r-lg']),
      borderRadiusOuter: px(SHARED['r-sm']),
      boxShadow: t['shadow-modal'],
      boxShadowSecondary: t['shadow-menu'],
      boxShadowTertiary: t.ring,
      motionDurationFast: '0.1s',
      motionDurationMid: '0.16s',
      motionDurationSlow: '0.2s',
      wireframe: false,
    },
    components: {
      Layout: { siderBg: t.frame, bodyBg: t.frame, headerBg: t.frame, headerHeight: 52 },
      Menu: {
        itemHeight: 32,
        itemBorderRadius: 6,
        itemMarginInline: 0,
        itemMarginBlock: 2,
        itemPaddingInline: 8,
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemColor: t['text-2'],
        itemHoverColor: t.text,
        itemHoverBg: t.hover,
        itemSelectedBg: t.selected,
        itemSelectedColor: t.text,
        itemActiveBg: t.pressed,
        activeBarWidth: 0,
        activeBarBorderWidth: 0,
        iconSize: 16,
        iconMarginInlineEnd: 8,
        groupTitleColor: t['text-3'],
        groupTitleFontSize: 13,
        collapsedWidth: 56,
      },
      Button: {
        fontWeight: 500,
        paddingInline: 14,
        paddingInlineSM: 10,
        defaultBg: t.panel,
        defaultColor: t.text,
        defaultBorderColor: t['btn-border'],
        defaultHoverBorderColor: t['btn-border'],
        defaultHoverColor: t.text,
        defaultHoverBg: x.defaultHoverBg,
        defaultActiveBg: x.defaultActiveBg,
        // §8 没写这两个；不写时按下默认按钮，字和描边会变成 colorPrimaryActive（深色下 #1247C8 叠在 #2A2A2C 上不到 2:1）
        defaultActiveColor: t.text,
        defaultActiveBorderColor: t['btn-border'],
        defaultShadow: '0 1px 2px rgba(9,9,11,.05)',
        primaryShadow: 'none',
        dangerShadow: 'none',
        solidTextColor: t['on-primary'],
        textHoverBg: t.hover,
        textTextColor: t['text-2'],
      },
      Input: {
        paddingInline: 10,
        hoverBorderColor: t['text-3'],
        activeBorderColor: t.accent,
        activeShadow: `0 0 0 3px ${t['accent-ring']}`,
        errorActiveShadow: `0 0 0 3px ${t['danger-ring']}`,
      },
      Select: {
        optionHeight: 32,
        optionPadding: '5px 8px',
        optionSelectedBg: 'transparent',
        optionSelectedFontWeight: 500,
        optionActiveBg: t.hover,
        hoverBorderColor: t['text-3'],
        activeBorderColor: t.accent,
        activeOutlineColor: t['accent-ring'],
      },
      Table: {
        headerBg: 'transparent',
        headerColor: t['text-3'],
        headerSplitColor: 'transparent',
        headerBorderRadius: 0,
        borderColor: t.divider,
        rowHoverBg: t.hover,
        rowSelectedBg: t.selected,
        rowSelectedHoverBg: t.pressed,
        // 单行：10.5 + 22 + 10.5 + 1px 下边框 = 44；首列两行的行用 className 把上下内边距改成 5.5（§8）
        cellPaddingBlock: 10.5,
        cellPaddingInline: 12,
        headerSortActiveBg: 'transparent',
        headerSortHoverBg: t.hover,
        bodySortBg: 'transparent',
      },
      // 页签不带动画（§3「导航、页签……0ms」、§8「Tabs 统一 animated={false}」）：ConfigProvider 给不了 Tabs 的 animated，
      // 在组件层把时长归零，墨条、页签文字的颜色过渡和面板切换一起没了，页面里不用逐个传 animated
      Tabs: {
        inkBarColor: t.text,
        itemColor: t['text-2'],
        itemHoverColor: t.text,
        itemSelectedColor: t.text,
        itemActiveColor: t.text,
        horizontalItemGutter: 24,
        horizontalItemPadding: '9px 0',
        titleFontSize: 14,
        ...ZERO_MOTION,
      },
      Segmented: {
        trackBg: t.subtle,
        trackPadding: 2,
        itemColor: t['text-2'],
        itemHoverColor: t.text,
        itemHoverBg: 'transparent',
        itemSelectedBg: t.thumb,
        itemSelectedColor: t.text,
      },
      Tag: { defaultBg: t.subtle, defaultColor: t['text-2'] },
      // 后面七个内边距与底栏令牌 antd 6.6.5 在运行时认（modal/style 的 prepareComponentToken 给默认值，配置可以覆盖），
      // 但公开的 ComponentToken 类型里没写，所以整块断言成 Modal 的配置类型
      Modal: {
        contentBg: t.raised,
        headerBg: t.raised,
        footerBg: t.frame,
        titleFontSize: 16,
        titleLineHeight: 24 / 16,
        contentPadding: 0,
        headerPadding: '20px 24px 0',
        bodyPadding: '12px 24px 20px',
        footerPadding: '12px 24px',
        footerBorderTop: `1px solid ${t.divider}`,
        footerBorderRadius: '0 0 12px 12px',
        footerMarginTop: 0,
      } as ComponentsConfig['Modal'],
      Drawer: { footerPaddingBlock: 14, footerPaddingInline: 24 },
      Switch: { trackHeight: 18, trackMinWidth: 32, handleSize: 14, handleBg: '#FFFFFF' },
      // Tooltip 是 --text 底、--panel 色字（§5.15）。antd 的字色取 colorTextLightSolid（白），深色主题下白字叠在浅底上看不见
      Tooltip: { maxWidth: 240, colorTextLightSolid: t.panel },
      // 反相 toast（§5.15）：--text 底、--panel 色字，成功图标用 --toast-icon。§8 原写「字色在 className 里设」，
      // 改在组件令牌里设，现有页面里的 message 调用不用逐个加 className
      // 6.6.5 的 message 与 notification 共用样式，提示文字走 colorTextHeading（标题），两个都设。
      // contentBg 按 §8 对所有 message 生效，其余类型的图标色也在这里换掉（TOAST_ICON；loading 图标取 colorInfo）
      Message: {
        contentBg: t.text,
        contentPadding: '9px 14px 9px 12px',
        colorText: t.panel,
        colorTextHeading: t.panel,
        colorSuccess: t['toast-icon'],
        colorError: TOAST_ICON[mode].error,
        colorInfo: TOAST_ICON[mode].info,
        colorWarning: TOAST_ICON[mode].warning,
      },
      // 分页的当前页（§5.5）：--selected 底、text 字。antd 默认取 colorPrimary 做字色，深色下只有 3.83:1。其余样式随第 9 步
      Pagination: { itemActiveBg: t.selected, itemActiveColor: t.text, itemActiveColorHover: t.text },
    },
  };
}

export const ANTD_THEMES: Readonly<Record<ThemeMode, ThemeConfig>> = {
  light: build('light', TOKENS.light),
  dark: build('dark', TOKENS.dark),
};

/**
 * 交给 ConfigProvider 的主题：「减少动态效果」（菜单开关或系统设置）开着时 token.motion 传 false（§1.5、§8），
 * antd 由 JS 驱动的入场退场一起关掉；CSS 过渡另由 brand.css 按 data-reduce-motion 与 prefers-reduced-motion 归零，这里的时长也归零
 */
export function antdTheme(mode: ThemeMode, reduceMotion: boolean): ThemeConfig {
  const base = ANTD_THEMES[mode];
  return reduceMotion ? { ...base, token: { ...base.token, ...ZERO_MOTION, motion: false } } : base;
}
