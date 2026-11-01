// 运维手册（17 spec R9）：告警里的手册链接落到这里。内容是公共手册 docs/ops/observability.md 的同名小节，只给所有者、管理员；
// 手册的写法是固定的三级标题、段落和代码块，这里只认这三种，不引入 Markdown 库。
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { BookOpen } from 'lucide-react';
import { Fragment } from 'react';
import { api, HttpError, unwrap } from '../api.js';
import { EmptyBlock, Skeleton, StateView } from '../parts/StateView.js';
import { Icon } from '../shell/icons.js';
import { PageHeader } from '../shell/PageHeader.js';
import { cjk } from '../typography.js';
import { canEdit, useViewer } from '../viewer.js';
import { runbookBlocks } from './runbook.js';

const runbookQuery = (key: string) =>
  queryOptions({
    queryKey: ['runbook', key] as const,
    queryFn: () => unwrap(api.ops.runbooks[':key'].$get({ param: { key } })),
    staleTime: Infinity,
  });

function Runbook({ name }: { name: string }) {
  const q = useQuery(runbookQuery(name));
  if (q.error instanceof HttpError && q.error.status === 404) {
    return (
      <>
        <PageHeader title="运维手册" />
        <EmptyBlock level={2} icon={<Icon of={BookOpen} size={20} />} title="没有这份手册" link={<Link to="/">回到总览</Link>} />
      </>
    );
  }
  const book = q.data;
  return (
    <>
      <PageHeader title={book ? book.title : '运维手册'} status={book ? <span>{book.code}</span> : undefined} />
      <StateView pending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={6} />}>
        {book && (
          <article className="rb-body">
            {runbookBlocks(book.body).map((b, i) => (
              <Fragment key={i}>
                {b.kind === 'heading' && <h2 className="rb-heading">{cjk(b.text)}</h2>}
                {b.kind === 'text' && <p className="rb-text">{cjk(b.text)}</p>}
                {b.kind === 'code' && (
                  <pre className="rb-code" tabIndex={0}>
                    <code>{b.text}</code>
                  </pre>
                )}
              </Fragment>
            ))}
          </article>
        )}
      </StateView>
    </>
  );
}

export function RunbookPage() {
  const { key } = useParams({ from: '/ops/runbooks/$key' });
  const viewer = useViewer().data;
  if (canEdit(viewer)) return <Runbook name={key} />;
  return (
    <>
      <PageHeader title="运维手册" />
      <EmptyBlock
        level={2}
        icon={<Icon of={BookOpen} size={20} />}
        title={viewer?.kind === 'member' ? '你的角色看不到运维手册' : '登录后才能看运维手册'}
        description="运维手册只给所有者、管理员看"
      />
    </>
  );
}
