// 总览的趋势（17 spec R10）：KPI 下面的 7/30 天切换、六张小图、「查看数据」。只给所有者、管理员。
// 悬停或方向键选中一天时，六张卡片的数字一起切到那一天，不用另开浮层；同样的数都在数据表里，不靠悬停才看得到。
// 加载是局部骨架；取新数据失败时留着旧图并写明时刻；401、403 清掉旧数据；文件存储只写一句说明，不画假图。
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Segmented } from 'antd';
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DailyOpsPoint, MetricsTrendsView } from '../../../src/shared/console-api.js';
import { clockTime } from '../../../src/shared/format.js';
import { HttpError } from '../api.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { cjk } from '../typography.js';
import { TRENDS_KEY, trendsQuery } from './queries.js';
import {
  columnPath,
  coverageText,
  dayTicks,
  latestIndex,
  PLOT,
  plotOf,
  rangeText,
  reasonNotes,
  shortDay,
  TREND_METRICS,
  TREND_RANGES,
  type TrendDays,
  trendsEmpty,
  type TrendMetric,
} from './trends.js';

const COLUMN_MAX = 24;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

interface ChartProps {
  metric: TrendMetric;
  points: readonly DailyOpsPoint[];
  active: number | null;
  onActive(i: number | null): void;
}

function TrendChart({ metric, points, active, onActive }: ChartProps) {
  const { ref, width } = useWidth();
  const plot = plotOf(points, metric, width);
  const columnWidth = Math.min(COLUMN_MAX, Math.max(plot.band - 2, 2));
  const last = points.length - 1;
  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - PLOT.left) / plot.band);
    onActive(Math.max(0, Math.min(last, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? last;
    const next = { ArrowLeft: Math.max(0, from - 1), ArrowRight: Math.min(last, from + 1), Home: 0, End: last }[e.key];
    if (next !== undefined) {
      e.preventDefault();
      onActive(next);
    } else if (e.key === 'Escape') onActive(null);
  };
  const activeY = active === null ? null : (plot.points[active]?.y ?? null);
  return (
    <div
      ref={ref}
      className="ov-chart"
      role="group"
      tabIndex={0}
      aria-label={`${metric.label}，用左右方向键逐日查看`}
      onPointerMove={onPointer}
      onPointerLeave={() => onActive(null)}
      onKeyDown={onKey}
      onFocus={() => onActive(active ?? last)}
      onBlur={() => onActive(null)}
    >
      <svg width={width} height={PLOT.height} aria-hidden="true">
        {[0, 0.5, 1].map((f) => {
          const y = plot.baseline - f * (plot.baseline - PLOT.top);
          return <line key={f} className="ov-chart-grid" x1={PLOT.left} x2={width - PLOT.right} y1={y} y2={y} />;
        })}
        <text className="ov-chart-tick" x={PLOT.left - 6} y={PLOT.top + 4} textAnchor="end">
          {metric.tick(plot.max)}
        </text>
        <text className="ov-chart-tick" x={PLOT.left - 6} y={plot.baseline + 4} textAnchor="end">
          {metric.tick(0)}
        </text>
        {/* 没有数的日子铺一条底色：和有数的 0 区分开 */}
        {plot.points.map((p, i) =>
          p.y === null ? (
            <rect
              key={i}
              className="ov-chart-missing"
              x={p.x - plot.band / 2}
              y={PLOT.top}
              width={plot.band}
              height={plot.baseline - PLOT.top}
            />
          ) : null,
        )}
        {active !== null && (
          <line className="ov-chart-cross" x1={plot.points[active]!.x} x2={plot.points[active]!.x} y1={PLOT.top} y2={plot.baseline} />
        )}
        {metric.form === 'column' ? (
          plot.points.map((p, i) =>
            p.y === null ? null : (
              <path
                key={i}
                className={p.partial ? 'ov-chart-column is-partial' : 'ov-chart-column'}
                d={columnPath(p.x, Math.min(p.y, plot.baseline - 2), columnWidth, plot.baseline)}
              />
            ),
          )
        ) : (
          <>
            {plot.lines.map((s, i) => (
              <line key={i} className={s.dashed ? 'ov-chart-line is-partial' : 'ov-chart-line'} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
            ))}
            {plot.lone.map((i) => (
              <circle key={i} className="ov-chart-dot" cx={plot.points[i]!.x} cy={plot.points[i]!.y!} r={4} />
            ))}
            {activeY !== null && <circle className="ov-chart-dot" cx={plot.points[active!]!.x} cy={activeY} r={4} />}
          </>
        )}
        {dayTicks(points.length).map((i) => (
          <text
            key={i}
            className="ov-chart-tick"
            x={plot.points[i]!.x}
            y={PLOT.height - 6}
            textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
          >
            {shortDay(points[i]!.day)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function TrendCard({
  metric,
  view,
  active,
  onActive,
}: { metric: TrendMetric; view: MetricsTrendsView } & Pick<ChartProps, 'active' | 'onActive'>) {
  const shown = active ?? latestIndex(view.points, metric.key);
  const point = shown === null ? null : view.points[shown]!;
  const value = point ? point[metric.key] : null;
  return (
    <div className="ov-trend">
      <span className="ov-trend-label">{cjk(metric.label)}</span>
      <span className="ov-trend-value">{value === null ? '—' : metric.format(value)}</span>
      <span className="ov-trend-caption">
        {point ? cjk(`${shortDay(point.day)} · ${coverageText(point, view.toDay)}`) : '这段时间没有数据'}
      </span>
      <TrendChart metric={metric} points={view.points} active={active} onActive={onActive} />
    </div>
  );
}

function TrendTable({ view }: { view: MetricsTrendsView }) {
  return (
    <div className="ov-trend-table-wrap" role="region" aria-label="趋势数据表" tabIndex={0}>
      <table className="ov-trend-table">
        <thead>
          <tr>
            <th scope="col">日期</th>
            <th scope="col">完整程度</th>
            {TREND_METRICS.map((m) => (
              <th key={m.key} scope="col">
                {cjk(m.label)}
              </th>
            ))}
            <th scope="col">轮次</th>
            <th scope="col">回复样本</th>
          </tr>
        </thead>
        <tbody>
          {[...view.points].reverse().map((p) => (
            <tr key={p.day}>
              <th scope="row">{p.day}</th>
              <td>{cjk(coverageText(p, view.toDay))}</td>
              {TREND_METRICS.map((m) => {
                const v = p[m.key];
                return <td key={m.key}>{v === null ? '—' : m.format(v)}</td>;
              })}
              <td>{p.turns ?? '—'}</td>
              <td>{p.replySamples ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrendBody({ view }: { view: MetricsTrendsView }) {
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (trendsEmpty(view)) return <EmptyBlock title="这段时间没有可统计的接待" level={3} />;
  const notes = reasonNotes(view.partialReasons);
  return (
    <>
      <div className="ov-trends">
        {TREND_METRICS.map((m) => (
          <TrendCard key={m.key} metric={m} view={view} active={active} onActive={setActive} />
        ))}
      </div>
      <p className="ov-trend-notes">
        {cjk(
          [
            '接待是当天有落库轮次的去重会话，排除种子与模拟访客。',
            '回复p90是引擎回复耗时，不是微信端到端送达耗时。',
            '费用是租户全部模型费用（含测试）。',
            '已付订单数含后续退款。',
            ...notes,
          ].join(''),
        )}
      </p>
      <Button type="text" size="small" className="ov-trend-toggle" aria-expanded={table} onClick={() => setTable(!table)}>
        {table ? '收起数据' : '查看数据'}
      </Button>
      {table && <TrendTable view={view} />}
    </>
  );
}

export function TrendsBlock({ editor }: { editor: boolean }) {
  const [days, setDays] = useState<TrendDays>(7);
  const qc = useQueryClient();
  const q = useQuery({ ...trendsQuery(days), enabled: editor, placeholderData: keepPreviousData, staleTime: 60_000 });
  const status = q.error instanceof HttpError ? q.error.status : null;
  const denied = status === 401 || status === 403;
  useEffect(() => {
    if (denied) qc.removeQueries({ queryKey: [TRENDS_KEY] });
  }, [denied, qc]);
  if (!editor || denied) return null;
  const fileMode = q.error instanceof HttpError && q.error.body.error === 'store_file_mode';
  const view = q.data;
  return (
    <section className="ov-block ov-trends-block" aria-labelledby="ov-trends">
      <div className="ov-head">
        <h2 id="ov-trends" className="ov-title">
          {cjk('客户接待趋势，排除种子')}
        </h2>
        {view && !fileMode && <span className="ov-count">{cjk(rangeText(view))}</span>}
        <div className="ov-view-switch">
          {/* tabIndex -1：同「成交与转人工」的视图切换 */}
          <Segmented<TrendDays> aria-label="趋势的时间范围" tabIndex={-1} options={[...TREND_RANGES]} value={days} onChange={setDays} />
        </div>
      </div>
      {fileMode ? (
        <p className="ov-note">{cjk('趋势只在会话存入数据库时可用。')}</p>
      ) : view ? (
        <div className={q.isPlaceholderData ? 'is-refreshing' : undefined}>
          {q.isError ? (
            <p className="ov-trend-stale" role="status">
              {cjk(`没取到新数据，显示的是${clockTime(view.computedAt)}的结果。`)}
              <Button type="link" size="small" onClick={() => void q.refetch()}>
                重试
              </Button>
            </p>
          ) : (
            <p className="ov-trend-computed">{cjk(`计算于${clockTime(view.computedAt)}，最多约一分钟延迟。`)}</p>
          )}
          <TrendBody key={view.requestedDays} view={view} />
        </div>
      ) : q.isError ? (
        <StateView error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Skeleton rows={3} rowHeight={72} />
      )}
    </section>
  );
}
