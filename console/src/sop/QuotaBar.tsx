// 额度条（spec「销售话术 · 额度条」，设计系统 §6.2、B 页）：左边标签「可编辑正文2,303 / 2,658字 · 87% · 还能写355字」和图例，
// 右边一根 6 高的条，每个可编辑节一段（改过的主色），95% 与上限各一根刻度。<95% 中性，95%–100% warning，>100% danger
// 并写「超出38字，发布会被拦下」；超限不拦输入。颜色之外，warning、danger 另有图标。
// 段宽与刻度位置经 React 的 style（CSSOM）写，不是 style 属性，页面 CSP 不拦
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { digits } from '../../../src/shared/format.js';
import { Icon } from '../shell/icons.js';
import { cjk, Sep } from '../typography.js';
import type { QuotaModel } from './outline.js';

const pct = (share: number): string => `${(share * 100).toFixed(3)}%`;

/** 刻度下方的两个字：宽 32 的框，平时居中在刻度下；两根刻度挨得太近时，各自退到两刻度中点的两侧，不叠在一起 */
function tickLabels(m: QuotaModel): { warn: string; limit: string } {
  const mid = (m.warnAt + m.limitAt) / 2;
  return {
    warn: `min(calc(${pct(m.warnAt)} - 16px), calc(${pct(mid)} - 34px))`,
    limit: `max(calc(${pct(m.limitAt)} - 16px), calc(${pct(mid)} + 2px))`,
  };
}

export function QuotaBar({ model: m }: { model: QuotaModel }) {
  const labels = tickLabels(m);
  return (
    <section className={`sop-quota is-${m.tone}`} aria-label="可编辑正文的字数">
      <div className="sop-quota-text">
        <div className="sop-quota-line">
          {m.tone !== 'ok' && <Icon of={m.tone === 'danger' ? CircleAlert : TriangleAlert} size={14} className="sop-quota-icon" />}
          可编辑正文
          <span className="sop-quota-num">
            {digits(m.chars)} / {digits(m.limit)}
          </span>
          字<Sep />
          {m.percent}%<Sep />
          {cjk(m.tail)}
        </div>
        <div className="sop-quota-legend">
          <span>
            <span className="sop-quota-swatch is-changed" aria-hidden="true" />
            改过的节
          </span>
          <span>
            <span className="sop-quota-swatch" aria-hidden="true" />
            没改的节
          </span>
          <span>固定规则节不计入</span>
        </div>
      </div>
      <div className="sop-quota-bar" role="img" aria-label={m.ariaLabel}>
        <div className="sop-quota-track">
          {m.parts.map((s) => (
            <span key={s.key} className={s.changed ? 'is-changed' : undefined} style={{ width: pct(s.share) }} />
          ))}
        </div>
        <span className="sop-quota-tick" style={{ left: pct(m.warnAt) }} />
        <span className="sop-quota-tick" style={{ left: pct(m.limitAt) }} />
        <span className="sop-quota-tick-label" style={{ left: labels.warn }}>
          95%
        </span>
        <span className="sop-quota-tick-label" style={{ left: labels.limit }}>
          上限
        </span>
      </div>
    </section>
  );
}
