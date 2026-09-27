// 两个样张页共用的外框：没有外壳，--frame 底上一块内容面板（设计系统 P 页）。
// ?theme=light|dark 等于在用户菜单里切外观（会记住），走查脚本按它截两套主题
import { useSearch } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { setAppearance } from '../theme/prefs.js';
import './specimen.css';

export function Frame({ title, children }: { title: string; children: ReactNode }) {
  const { theme } = useSearch({ strict: false });
  useEffect(() => {
    if (theme === 'light' || theme === 'dark') setAppearance(theme);
  }, [theme]);
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <div className="spec-page">
      <main className="spec-panel">{children}</main>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="spec-section">
      <h2 className="spec-h">{title}</h2>
      {children}
    </section>
  );
}
