// 话术页右栏的两张卡片（spec「销售话术 · 右栏」「检查」，设计系统 B 页、§5.17）：发布前检查的清单，和「话术里可以点名的工具」。
// 宽 ≥1440 时在右栏；1280–1439 时右栏收掉，检查清单挪到目录下面、工具卡片不画；<1280 时检查清单落到编辑器下面（sop.css）。
// 检查在每次自动保存以后跑（sop/check.ts），清单下一行写「每次自动保存都会跑 · 上次14:05」，没跑成时写「没检查上 · 重试」；
// 没跑过时 7 项都是「还没跑」。没过的项右边写「1处 · 话术原则」，整行是按钮，点了由页面定位（切到那一节、选中第一处）；
// 「字数在额度内」右边写百分比，超了写「超出N字」。工具名与中文名取自行业包的 vocabulary.tools，console 不认识任何一个包的工具。
// 两张卡片都是 memo：话术页每敲一个字整页重渲，它们的属性不变就不跟着重渲（属性都只在检查、保存以后变）
import { memo, useId } from 'react';
import type { DraftCheck, SectionSpecView, ViolationCode } from '../../../src/shared/console-api.js';
import { clockTime, digits } from '../../../src/shared/format.js';
import { SOP_CHECKS } from '../../../src/shared/ui-labels.js';
import { type CheckItem, CheckList } from '../parts/CheckList.js';
import { TechDetails } from '../parts/TechDetails.js';
import { cjk, Sep } from '../typography.js';
import { PREAMBLE_NAME, quotaPercent } from './outline.js';
import type { LocatedViolation, ProblemTarget } from './problems.js';

const nameOf = (spec: readonly SectionSpecView[], key: string): string => spec.find((s) => s.key === key)?.heading ?? PREAMBLE_NAME;

/** 「字数在额度内」那一项的字数：检查算的（没有检查结果时用 /sop 的） */
export interface CheckBudget {
  chars: number;
  limit: number;
}

/**
 * 检查结果按 7 个检查项列出（名字固定，见 ui-labels.ts 的 SOP_CHECKS）；还没跑时都是「还没跑」。
 * 没过的项写「N处 · 节名」（节按问题落在的节，见 problems.ts），给了 onLocate 就可以点，去这一项第一个有去处的问题
 */
export function checkItems(
  spec: readonly SectionSpecView[],
  located: readonly LocatedViolation[] | null,
  budget: CheckBudget | null = null,
  onLocate?: (t: NonNullable<ProblemTarget>) => void,
): CheckItem[] {
  return SOP_CHECKS.map(([code, label]: readonly [ViolationCode, string]) => {
    if (!located) return { key: code, label, state: 'pending' };
    const hits = located.filter((v) => v.code === code);
    if (!hits.length) {
      return code === 'over_budget' && budget && budget.limit > 0
        ? { key: code, label, state: 'pass', note: `${quotaPercent(budget.chars, budget.limit)}%` }
        : { key: code, label, state: 'pass' };
    }
    const sections = [...new Set(hits.flatMap((v) => (v.section === null ? [] : [nameOf(spec, v.section)])))];
    const note =
      code === 'over_budget' && budget && budget.chars > budget.limit
        ? `超出${digits(budget.chars - budget.limit)}字`
        : [`${hits.length}处`, ...sections];
    const target = hits.find((v) => v.target !== null)?.target ?? null;
    return { key: code, label, state: 'fail', note, onClick: target && onLocate ? () => onLocate(target) : undefined };
  });
}

/** 清单下一行：「每次自动保存都会跑 · 上次14:05」；没跑成时最后一段是 danger 的「没检查上 · 重试」 */
function CheckMeta({ at, failed, onRetry }: { at: number | null; failed: boolean; onRetry: () => void }) {
  return (
    <>
      {cjk(!failed && at !== null ? ['每次自动保存都会跑', `上次${clockTime(at)}`] : '每次自动保存都会跑')}
      {failed && (
        <>
          <Sep />
          <span className="sop-check-failed">
            没检查上
            <Sep />
            <button type="button" className="sop-save-retry" onClick={onRetry}>
              重试
            </button>
          </span>
        </>
      )}
    </>
  );
}

/**
 * 发布前检查。located 是最近一次检查（或发布被拒）的问题，没跑过是 null；violations 是它们的原文，check 是最近一次检查的结果，
 * 服务端的原文与哈希只在折叠的技术详情里。onLocate、onRetry 要是不变的函数（memo）
 */
export const CheckCard = memo(function CheckCard({
  spec,
  located,
  violations,
  check,
  budget,
  at,
  failed,
  onRetry,
  onLocate,
}: {
  spec: readonly SectionSpecView[];
  located: readonly LocatedViolation[] | null;
  violations: DraftCheck['violations'] | null;
  check: DraftCheck | null;
  budget: CheckBudget | null;
  at: number | null;
  failed: boolean;
  onRetry: () => void;
  onLocate: (t: NonNullable<ProblemTarget>) => void;
}) {
  const items = checkItems(spec, located, budget, onLocate);
  return (
    <div className="sop-card sop-check-card">
      <CheckList
        title="发布前检查"
        summary={located ? `${items.filter((i) => i.state === 'pass').length}/${items.length}通过` : undefined}
        meta={<CheckMeta at={at} failed={failed} onRetry={onRetry} />}
        items={items}
      />
      {violations && (
        <TechDetails
          violations={violations}
          rows={
            check
              ? [
                  ['prompt', check.promptHash.slice(0, 12)],
                  ['chars', `${check.chars}/${check.limit}`],
                ]
              : undefined
          }
        />
      )}
    </div>
  );
});

/** 话术里可以点名的工具：每行一个芯片「中文名 原名」，卡底说明写别的名字的后果。行业包没有工具时不画 */
export const ToolsCard = memo(function ToolsCard({ tools }: { tools: Readonly<Record<string, string>> }) {
  const titleId = useId();
  const list = Object.entries(tools);
  if (list.length === 0) return null;
  return (
    <section className="sop-card sop-tools-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="sop-card-title">
        {cjk('话术里可以点名的工具')}
      </h3>
      <ul className="sop-tools-list">
        {list.map(([name, label]) => (
          <li key={name} className="sop-tool-chip">
            <span className="sop-tool-label">{label}</span>
            <span className="sop-tool-name">{name}</span>
          </li>
        ))}
      </ul>
      <p className="sop-tools-note">{cjk('写别的名字模型会当成不存在')}</p>
    </section>
  );
});
