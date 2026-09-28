// 话术页加载时的骨架（spec「销售话术 · 状态」）：额度条、目录（分段控件加每节一行）、中栏（节标题、说明行、编辑卡片），
// 尺寸与成品一致。目录的行数取行业包的话术节数：包在启动时已经到了，/sop 还没回来。
// 匿名的成品没有额度条和分段控件，骨架也不画。节标题下那一行（成员的说明行、固定规则节的锁定说明）按要打开的节画：
// 匿名打开可编辑节时没有这一行
import { useViewport } from '../shell/hooks.js';

export function SopSkeleton({ sections, quota, filter, meta }: { sections: number; quota: boolean; filter: boolean; meta: boolean }) {
  const wide = useViewport() === 'wide';
  return (
    <div aria-hidden="true">
      {quota && (
        <div className="sop-quota sop-skel-quota">
          <div>
            <div className="skeleton-bar" style={{ width: 300 }} />
            <div className="skeleton-bar" style={{ width: 240, marginTop: 10 }} />
          </div>
          <div className="sop-skel-track skeleton-bar" />
        </div>
      )}
      <div className={`sop-body${wide ? '' : ' is-narrow'}`}>
        {wide ? (
          <div className="sop-toc">
            {filter && <div className="sop-skel-filter" />}
            <div className="sop-toc-list">
              {Array.from({ length: sections }, (_, i) => (
                <div key={i} className="sop-skel-row">
                  <div className="skeleton-bar" style={{ width: `${[56, 72, 64, 48][i % 4]}%` }} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="sop-skel-select" />
        )}
        {/* 中栏：节标题、说明行或锁定说明（匿名打开的可编辑节没有）、编辑卡片 */}
        <div className="sop-pane">
          <div className="sop-skel-title">
            <div className="skeleton-bar" style={{ width: 96 }} />
          </div>
          {meta && (
            <div className="sop-skel-meta">
              <div className="skeleton-bar" style={{ width: 200 }} />
            </div>
          )}
          <div className="sop-skel-editor" />
        </div>
      </div>
    </div>
  );
}
