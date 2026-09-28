// 话术页右栏的两张卡片（spec「销售话术 · 右栏」，设计系统 B 页）：发布前检查的清单，和「话术里可以点名的工具」。
// 宽 ≥1440 时在右栏；1280–1439 时右栏收掉，检查清单挪到目录下面、工具卡片不画；<1280 时检查清单落到编辑器下面（sop.css）。
// 检查现在还是 01 的做法：点页头的「检查」跑一次，结果列在这里，存过一次草稿就作废（第 6.2 步改成每次自动保存后跑）；
// 没跑过时 7 项都是「还没跑」。工具名与中文名取自行业包的 vocabulary.tools，console 不认识任何一个包的工具。
// 两张卡片都是 memo：话术页每敲一个字整页重渲，它们的属性不变就不跟着重渲
import { memo, useId } from 'react';
import type { DraftCheck, SectionSpecView } from '../../../src/shared/console-api.js';
import { SOP_CHECKS } from '../../../src/shared/ui-labels.js';
import { type CheckItem, CheckList } from '../parts/CheckList.js';
import { TechDetails } from '../parts/TechDetails.js';
import { cjk } from '../typography.js';
import { PREAMBLE_NAME } from './outline.js';

const headingOf = (spec: readonly SectionSpecView[], key: string | null): string =>
  key === null ? '整体' : (spec.find((s) => s.key === key)?.heading ?? PREAMBLE_NAME);

/** 检查结果按 7 个检查项列出（名字固定，见 ui-labels.ts 的 SOP_CHECKS）；还没跑时都是「还没跑」 */
export function checkItems(spec: readonly SectionSpecView[], violations: DraftCheck['violations'] | null): CheckItem[] {
  return SOP_CHECKS.map(([code, label]) => {
    if (!violations) return { key: code, label, state: 'pending' };
    const hits = violations.filter((v) => v.code === code);
    const sections = [...new Set(hits.map((v) => headingOf(spec, v.sectionKey)))];
    return {
      key: code,
      label,
      state: hits.length ? 'fail' : 'pass',
      note: hits.length ? [`${hits.length}处`, sections.join('、')] : undefined,
    };
  });
}

/**
 * 发布前检查。violations 是最近一次检查（或发布被拒）的问题，没跑过是 null；check 是最近一次检查的结果，
 * 服务端的原文与哈希只在折叠的技术详情里
 */
export const CheckCard = memo(function CheckCard({
  spec,
  violations,
  check,
}: {
  spec: readonly SectionSpecView[];
  violations: DraftCheck['violations'] | null;
  check: DraftCheck | null;
}) {
  const items = checkItems(spec, violations);
  return (
    <div className="sop-card sop-check-card">
      <CheckList
        title="发布前检查"
        summary={violations ? `${items.filter((i) => i.state === 'pass').length}/${items.length}通过` : undefined}
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
