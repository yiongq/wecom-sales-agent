// 外壳用到的几个 hook：视口三档、标签页标题、数字变了闪一次、本机是不是 Mac（⌘K 的提示写法）
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RAIL_MIN, viewportTier, type ViewportTier, WIDE_MIN } from './model.js';

const QUERIES = [`(min-width: ${WIDE_MIN}px)`, `(min-width: ${RAIL_MIN}px)`];

function subscribeViewport(onChange: () => void): () => void {
  const lists = QUERIES.map((q) => window.matchMedia(q));
  for (const l of lists) l.addEventListener('change', onChange);
  return () => {
    for (const l of lists) l.removeEventListener('change', onChange);
  };
}

const viewportSnapshot = (): ViewportTier => viewportTier(window.innerWidth);
const serverViewport = (): ViewportTier => 'wide';

/**
 * 视口三档（spec「可访问性与响应式」）。antd 的 Sider 只接一档断点，所以侧栏改成受控收起，档位由这里统一判断；
 * 只在跨过 992、1280 两条线时重渲
 */
export function useViewport(): ViewportTier {
  return useSyncExternalStore(subscribeViewport, viewportSnapshot, serverViewport);
}

/** 标签页标题（不变量 23）。离开页面时不还原：下一页会写自己的 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/**
 * 轮询后数字变了，背景闪一次 accent-bg（150ms 淡出，只一次；设计系统 §3）。返回一个递增的序号：
 * 调用方把它当作元素的 key，换 key 重挂载，CSS 动画就从头播一次。第一次拿到数、从无到有都不闪
 */
export function useChangeFlash(value: number | undefined): number {
  const prev = useRef(value);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (prev.current !== undefined && value !== undefined && prev.current !== value) setSeq((n) => n + 1);
    prev.current = value;
  }, [value]);
  return seq;
}

/** 本机是不是 Mac：⌘K 的按法与提示按它分（search.ts 的 isPaletteShortcut、paletteShortcut） */
export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
