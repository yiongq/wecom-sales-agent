// 话术页加载时的骨架（spec「销售话术 · 状态」）：额度条、目录（分段控件加每节一行）、编辑器，尺寸与成品一致。
// 目录的行数取行业包的话术节数：包在启动时已经到了，/sop 还没回来
import { useViewport } from '../shell/hooks.js';

export function SopSkeleton({ sections, quota }: { sections: number; quota: boolean }) {
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
            <div className="sop-skel-filter" />
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
        <div className="sop-skel-editor" />
      </div>
    </div>
  );
}
