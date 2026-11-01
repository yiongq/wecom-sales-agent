import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import type { Me, UsageView } from '../../../src/shared/console-api.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { cjk } from '../typography.js';
import { settingsQuery } from './queries.js';

/** UsageView 的金额是千分之一元；保留三位，不能把很小的真实费用显示成零。 */
export const usageMoney = (milli: number): string => `${(milli / 1000).toFixed(3)}元`;
const quotaText = (n: number | null, money = false): string =>
  n === null ? '不限' : n === 0 ? '已全拦' : money ? usageMoney(n) : `${n}次`;

export function UsageData({ value }: { value: UsageView }) {
  const blocked =
    value.status === 'suspended'
      ? '企业已停用'
      : value.replies.quota !== null && value.replies.used >= value.replies.quota
        ? '本月回复已达到上限'
        : value.daily.capMilli !== null && value.daily.costMilli >= value.daily.capMilli
          ? '今日费用已达到上限'
          : '';
  return (
    <section aria-label="用量明细">
      <p className="settings-help">{cjk(`${value.month} · 模型用量统计，不是服务账单。日期按服务时区计算。`)}</p>
      <dl className="settings-details settings-section">
        <dt>企业状态</dt>
        <dd>{{ trial: '试用中', active: '使用中', suspended: '已停用' }[value.status]}</dd>
        <dt>本月回复</dt>
        <dd data-usage="replies">{value.replies.used}次</dd>
        <dt>每月上限</dt>
        <dd>{quotaText(value.replies.quota)}</dd>
        <dt>今日费用</dt>
        <dd data-usage="cost">{usageMoney(value.daily.costMilli)}</dd>
        <dt>每日上限</dt>
        <dd>{quotaText(value.daily.capMilli, true)}</dd>
      </dl>
      {blocked && <p role="status">{cjk(`${blocked}，AI回复已暂停。请联系管理员。`)}</p>}
      <h2 className="usage-heading">逐日明细</h2>
      {value.days.length === 0 ? (
        <EmptyBlock level={3} title="本月暂无用量" />
      ) : (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption className="boot-sr">{value.month}逐日用量</caption>
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">回复次数</th>
                <th scope="col">费用（元）</th>
              </tr>
            </thead>
            <tbody>
              {value.days.map((day) => (
                <tr key={day.day}>
                  <th scope="row">
                    <time dateTime={day.day}>{day.day}</time>
                  </th>
                  <td>{day.replies}</td>
                  <td>{usageMoney(day.costMilli)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
export function UsagePage({ me }: { me: Me }) {
  const query = useQuery(settingsQuery(me, 'usage'));
  return (
    <>
      <StateView level={2} pending={query.isPending} error={!query.data ? query.error : undefined} onRetry={() => void query.refetch()}>
        {query.data && (
          <>
            {query.isError && (
              <div className="usage-stale" role="status">
                <span>未更新，以下为上次数据</span>
                <Button onClick={() => void query.refetch()}>重试</Button>
              </div>
            )}
            <UsageData value={query.data} />
          </>
        )}
      </StateView>
      <p className="settings-help">{cjk('每30秒更新，页面隐藏时暂停；回到页面时重取。')}</p>
    </>
  );
}
