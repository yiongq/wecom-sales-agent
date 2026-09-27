// SOP 页（spec「后台 API 与页面 · SOP」）：左侧节列表（固定规则节只读），右侧编辑可编辑节的正文；顶栏是草稿状态、字符预算、
// 检查 / 发布 / 丢弃；检查结果按 7 个检查项列出，需要 rebase 与冲突时标出；历史列表可以「以此版本回滚」。
// 匿名（demo）只拿到已发布版本的节，全部只读。
// 出错就地显示（ErrorAlert，文案取 ERROR_COPY），成功只报 toast；丢弃走 ConfirmDanger；有没保存的改动时拦下站内跳转。
// 整页的版式随后台 UX spec 第 5–7 步重做
import { LockOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Input,
  Menu,
  Modal,
  Progress,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type {
  AnonSopOverview,
  DraftCheck,
  SectionSpecView,
  SopOverview,
  SopSectionText,
  SopVersion,
  ViolationCode,
} from '../../../src/shared/console-api.js';
import { api, HttpError, unwrap } from '../api.js';
import { type CheckItem, CheckList } from '../parts/CheckList.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { Skeleton, StateView } from '../parts/StateView.js';
import { Status } from '../parts/Status.js';
import { TechDetails } from '../parts/TechDetails.js';
import { toast } from '../parts/toast.js';
import { useUnsavedGuard } from '../parts/UnsavedGuard.js';
import { SectionDiff } from '../SectionDiff.js';
import { TextEditor } from '../TextEditor.js';
import { canEdit, useViewer } from '../viewer.js';

const NL = '\n';
const SOURCE_LABEL: Record<SopVersion['source'], string> = {
  import: '导入',
  console: '后台发布',
  rollback: '回滚',
  rerender: '启动重渲染',
};
const when = (iso: string | null): string => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—');

/** 7 个检查项，名字固定，与 ViolationCode 一一对应（design-system §5.17） */
const SOP_CHECKS: ReadonlyArray<readonly [ViolationCode, string]> = [
  ['structure', '结构完整'],
  ['locked_changed', '固定规则节没改'],
  ['phrase_missing', '必备短语都在'],
  ['phrase_forbidden', '没有禁用短语'],
  ['unknown_tool', '工具名都存在'],
  ['unknown_field', '字段名都存在'],
  ['over_budget', '字数在额度内'],
];

/** 节的正文：去掉「## 标题」和它后面的空行；前言没有标题 */
function bodyOf(text: string, heading: string | null): string {
  if (heading === null) return text;
  const head = `## ${heading}${NL}${NL}`;
  return text.startsWith(head) ? text.slice(head.length) : text;
}
const headingOf = (spec: readonly SectionSpecView[], key: string | null): string =>
  key === null ? '整体' : (spec.find((s) => s.key === key)?.heading ?? '前言');

export function SopPage() {
  const viewer = useViewer();
  const q = useQuery({ queryKey: ['sop'], queryFn: () => unwrap(api.sop.$get()) });
  return (
    <StateView pending={q.isPending} error={q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={11} />}>
      {q.data && ('spec' in q.data ? <MemberSop data={q.data} editable={canEdit(viewer.data)} /> : <AnonSop data={q.data} />)}
    </StateView>
  );
}

function AnonSop({ data }: { data: AnonSopOverview }) {
  const { published } = data;
  const [key, setKey] = useState(published.sections[0]?.key ?? '');
  const title = (s: SopSectionText): string => (s.text.startsWith('## ') ? s.text.slice(3, s.text.indexOf(NL)) : '前言');
  const current = published.sections.find((s) => s.key === key);
  return (
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        v{published.versionNo} · 发布于{when(published.publishedAt)} · prompt {published.promptHash}
      </Typography.Text>
      <Row gutter={16}>
        <Col span={6}>
          <Menu
            mode="inline"
            style={{ border: '1px solid var(--border)', borderRadius: 6 }}
            selectedKeys={[key]}
            onClick={(e) => setKey(e.key)}
            items={published.sections.map((s) => ({ key: s.key, label: title(s) }))}
          />
        </Col>
        <Col span={18}>{current && <TextEditor value={current.text} readOnly />}</Col>
      </Row>
    </Space>
  );
}

/** 检查结果按 7 个检查项列出；服务端的原文（detail）、哈希只在技术详情里 */
function checkItems(spec: readonly SectionSpecView[], violations: DraftCheck['violations']): CheckItem[] {
  return SOP_CHECKS.map(([code, label]) => {
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

function MemberSop({ data, editable }: { data: SopOverview; editable: boolean }) {
  const qc = useQueryClient();
  const { published, draft, spec, budget } = data;
  const current = draft ?? published;
  const [key, setKey] = useState(spec.find((s) => !s.locked)?.key ?? spec[0]!.key);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<DraftCheck | null>(null);
  const [rejected, setRejected] = useState<HttpError | null>(null);
  const [conflict, setConflict] = useState<{ keys: string[]; current: SopSectionText[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const section = spec.find((s) => s.key === key)!;
  const originalBody = (k: string): string => {
    const s = spec.find((x) => x.key === k)!;
    return bodyOf(current.sections.find((x) => x.key === k)?.text ?? '', s.heading);
  };
  const dirty = Object.keys(edits).filter((k) => edits[k] !== originalBody(k));
  const guard = useUnsavedGuard(dirty.length > 0);
  // 检查结果、发布被拒、冲突都是对某一份草稿说的：草稿存了、丢了、发布了或者回滚过，就都作废
  const clearResults = (): void => {
    setCheck(null);
    setRejected(null);
    setConflict(null);
  };
  // 先等新数据回来再清掉本地改动，免得编辑器先闪回旧正文
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['sop'] });
    await qc.invalidateQueries({ queryKey: ['sop-versions'] });
    setEdits({});
  };
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await unwrap(
        api.sop.draft.$put({
          json: {
            basedOn: draft?.basedOn ?? published.id,
            rev: draft?.rev ?? null,
            edits: dirty.map((k) => ({ key: k, body: edits[k]! })),
          },
        }),
      );
      clearResults();
      toast('草稿已保存');
      await refresh();
    });
  const runCheck = () =>
    run(async () => {
      setRejected(null);
      setConflict(null);
      setCheck(await unwrap(api.sop.draft.check.$post()));
    });
  const publish = () =>
    run(async () => {
      setRejected(null);
      setConflict(null);
      try {
        const v = await unwrap(api.sop.draft.publish.$post({ json: { rev: draft!.rev, changeNote: note } }));
        toast(`已发布v${v.versionNo}`);
        setPublishing(false);
        setNote('');
        clearResults();
        await refresh();
      } catch (e) {
        setPublishing(false);
        if (e instanceof HttpError && e.body.error === 'contract') setRejected(e);
        else if (e instanceof HttpError && e.body.error === 'sop_conflict')
          setConflict({ keys: e.body.keys ?? [], current: e.body.current ?? [] });
        else throw e;
      }
    });
  // 失败时也关掉确认框，错误在页面顶上就地显示
  const discard = () =>
    run(async () => {
      try {
        await unwrap(api.sop.draft.discard.$post({ json: { rev: draft!.rev } }));
      } finally {
        setDiscarding(false);
      }
      clearResults();
      toast('草稿已丢弃');
      await refresh();
    });

  const violations = rejected ? (rejected.body.violations ?? []) : (check?.violations ?? null);
  const over = budget.chars > budget.limit;
  const textOf = (v: SopVersion, k: string): string => v.sections.find((s) => s.key === k)?.text ?? '';
  const draftChanged = draft ? spec.filter((s) => !s.locked && textOf(published, s.key) !== textOf(draft, s.key)) : [];
  const items = violations ? checkItems(spec, violations) : [];

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {guard}
      {error !== null && <ErrorAlert error={error} />}
      <Card size="small">
        <Space wrap size="large">
          <span>
            已发布v{published.versionNo}（{when(published.publishedAt)}）
          </span>
          {draft ? (
            <Space>
              <Status kind="draft" />
              {draft.stale && <Typography.Text type="secondary">草稿打开之后发布过新版本，发布时自动合并</Typography.Text>}
            </Space>
          ) : (
            <Tag>没有草稿</Tag>
          )}
          <span style={{ width: 220, display: 'inline-block' }}>
            <Progress
              percent={Math.round((budget.chars / budget.limit) * 100)}
              status={over ? 'exception' : 'normal'}
              size="small"
              format={() => `${budget.chars} / ${budget.limit}字`}
            />
          </span>
          {editable && (
            <Space>
              <PrimaryButton disabled={!dirty.length} loading={busy} onClick={() => void save()}>
                保存草稿{dirty.length ? `（${dirty.length}节）` : ''}
              </PrimaryButton>
              <Button disabled={!draft || dirty.length > 0} loading={busy} onClick={() => void runCheck()}>
                检查
              </Button>
              <Button disabled={!draft || dirty.length > 0} loading={busy} onClick={() => setPublishing(true)}>
                发布
              </Button>
              <Button disabled={!draft} loading={busy} onClick={() => setDiscarding(true)}>
                丢弃
              </Button>
            </Space>
          )}
        </Space>
      </Card>

      {violations && (
        <Card size="small">
          <Space orientation="vertical" style={{ width: '100%' }}>
            {rejected && <ErrorAlert error={rejected} />}
            {check?.rebase.needed && !rejected && (
              <Alert
                type={check.rebase.conflicts.length ? 'error' : 'info'}
                title={
                  check.rebase.conflicts.length
                    ? `这几节在你编辑期间被别人改过：${check.rebase.conflicts.map((k) => headingOf(spec, k)).join('、')}。` +
                      '这份草稿已经发布不了：先把你的改动复制出来，丢弃草稿，再在当前版本上重做。'
                    : '草稿基于的版本已过期，发布时会自动合并别人的改动'
                }
              />
            )}
            <CheckList title="发布前检查" summary={`${items.filter((i) => i.state === 'pass').length}/${items.length}通过`} items={items} />
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
          </Space>
        </Card>
      )}
      {conflict && (
        <Alert
          type="error"
          showIcon
          title={`发布被拒：这几节在你编辑期间被别人改过——${conflict.keys.map((k) => headingOf(spec, k)).join('、')}`}
          description={
            <Space orientation="vertical" style={{ width: '100%' }}>
              {conflict.current
                .filter((s) => conflict.keys.includes(s.key))
                .map((s) => (
                  <div key={s.key}>
                    <Typography.Text type="secondary">当前发布版本的「{headingOf(spec, s.key)}」：</Typography.Text>
                    <TextEditor value={s.text} readOnly />
                  </div>
                ))}
              <span>这份草稿已经发布不了：先把你的改动复制出来，丢弃草稿，再在上面这份当前版本上重做。</span>
            </Space>
          }
        />
      )}

      <Row gutter={16}>
        <Col span={6}>
          <Menu
            mode="inline"
            style={{ border: '1px solid var(--border)', borderRadius: 6 }}
            selectedKeys={[key]}
            onClick={(e) => setKey(e.key)}
            items={spec.map((s) => ({
              key: s.key,
              icon: s.locked ? <LockOutlined title="固定规则节：由代码逐条核对，这里只能看" /> : undefined,
              label: (
                <Space>
                  <span>{s.heading ?? '前言'}</span>
                  {dirty.includes(s.key) && <Tag>未保存</Tag>}
                </Space>
              ),
            }))}
          />
        </Col>
        <Col span={18}>
          {section.locked && (
            <Alert type="info" style={{ marginBottom: 8 }} title="固定规则节：由代码逐条核对，这里改不了，要改请联系技术。" />
          )}
          <TextEditor
            key={key}
            value={edits[key] ?? originalBody(key)}
            readOnly={section.locked || !editable}
            onChange={(v) => setEdits((e) => ({ ...e, [key]: v }))}
          />
        </Col>
      </Row>

      {draft && <DraftDiff spec={spec} published={published} draft={draft} />}

      <History editable={editable} currentId={published.id} onRolledBack={clearResults} />

      <Modal
        destroyOnHidden
        open={publishing}
        title="发布草稿"
        onCancel={() => setPublishing(false)}
        footer={
          <>
            <Button onClick={() => setPublishing(false)}>取消</Button>
            <PrimaryButton disabled={!note.trim()} loading={busy} onClick={() => void publish()}>
              发布
            </PrimaryButton>
          </>
        }
      >
        <Input.TextArea rows={3} placeholder="变更说明（必填）" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
      <ConfirmDanger
        open={discarding}
        title="丢弃草稿？"
        confirmText="丢弃草稿"
        cancelText="保留"
        onConfirm={discard}
        onCancel={() => setDiscarding(false)}
      >
        {draftChanged.length
          ? `草稿里${draftChanged.length}节改动（${draftChanged.map((s) => s.heading ?? '前言').join('、')}）会丢掉，线上v${published.versionNo}不受影响。这一步撤销不了。`
          : `草稿会丢掉，线上v${published.versionNo}不受影响。这一步撤销不了。`}
      </ConfirmDanger>
    </Space>
  );
}

/** 草稿与已发布版本的逐节对比：只列改过的可编辑节，展开才建编辑器 */
function DraftDiff({ spec, published, draft }: { spec: readonly SectionSpecView[]; published: SopVersion; draft: SopVersion }) {
  const textOf = (v: SopVersion, key: string): string => v.sections.find((s) => s.key === key)?.text ?? '';
  const changed = spec.filter((s) => !s.locked && textOf(published, s.key) !== textOf(draft, s.key));
  return (
    <Card size="small" title={`与已发布v${published.versionNo}的逐节对比`}>
      {changed.length === 0 ? (
        <Typography.Text type="secondary">草稿里的可编辑节与已发布版本相同</Typography.Text>
      ) : (
        <Collapse
          items={changed.map((s) => ({
            key: s.key,
            label: s.heading ?? '前言',
            children: (
              <SectionDiff
                before={bodyOf(textOf(published, s.key), s.heading)}
                after={bodyOf(textOf(draft, s.key), s.heading)}
                beforeLabel={`已发布v${published.versionNo}`}
                afterLabel="草稿"
              />
            ),
          }))}
        />
      )}
    </Card>
  );
}

const VERSIONS_PAGE = 50;

function History({ editable, currentId, onRolledBack }: { editable: boolean; currentId: string; onRolledBack: () => void }) {
  const qc = useQueryClient();
  // 每一个已发布或归档的版本都要能回滚，所以按版本号倒序往前翻（before 游标）；
  // 接口不给下一页的游标：满一页就以这一页最小的版本号接着翻，不满一页就是到头了
  const q = useInfiniteQuery({
    queryKey: ['sop-versions'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(api.sop.versions.$get({ query: { limit: String(VERSIONS_PAGE), ...(pageParam ? { before: String(pageParam) } : {}) } })),
    getNextPageParam: (last) => (last.items.length < VERSIONS_PAGE ? undefined : (last.items.at(-1)?.versionNo ?? undefined)),
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const [target, setTarget] = useState<SopVersion | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** 回滚后的新版本与目标版本的固定规则不同（sameHashAsTarget 为 false）时的说明 */
  const [notice, setNotice] = useState<string | null>(null);

  const rollback = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const v = await unwrap(api.sop.versions[':id'].rollback.$post({ param: { id: target.id }, json: { changeNote: note } }));
      setTarget(null);
      setNote('');
      onRolledBack();
      await qc.invalidateQueries({ queryKey: ['sop'] });
      await qc.invalidateQueries({ queryKey: ['sop-versions'] });
      toast(`已回滚到v${target.versionNo}：新版本v${v.versionNo}`);
      setNotice(
        v.sameHashAsTarget
          ? null
          : `v${target.versionNo}之后代码里的固定规则改过，固定规则节用的是现在的写法，所以v${v.versionNo}不会和v${target.versionNo}完全一样。`,
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    setTarget(null);
    setError(null);
  };

  return (
    <Card size="small" title="版本历史">
      {notice && (
        <Alert type="warning" showIcon closable={{ onClose: () => setNotice(null) }} style={{ marginBottom: 12 }} title={notice} />
      )}
      <StateView pending={q.isPending} error={q.data ? null : q.error} onRetry={() => void q.refetch()} skeleton={<Skeleton rows={3} />}>
        <Table<SopVersion>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: <Empty description="没有版本" /> }}
          columns={[
            { title: '版本', dataIndex: 'versionNo', render: (n: number) => `v${n}` },
            { title: '来源', dataIndex: 'source', render: (s: SopVersion['source']) => SOURCE_LABEL[s] },
            { title: '发布人', render: (_: unknown, v) => v.publishedByName ?? v.createdByName ?? '系统' },
            { title: '时间', dataIndex: 'publishedAt', render: when },
            {
              title: 'prompt',
              dataIndex: 'promptHash',
              render: (h: string | null) => <Typography.Text code>{h?.slice(0, 12)}</Typography.Text>,
            },
            { title: '变更说明', dataIndex: 'changeNote' },
            {
              title: '',
              render: (_: unknown, v) =>
                editable && v.id !== currentId ? (
                  <Button size="small" onClick={() => setTarget(v)}>
                    以此版本回滚
                  </Button>
                ) : v.id === currentId ? (
                  <Status kind="live" />
                ) : null,
            },
          ]}
        />
      </StateView>
      {q.data && q.isFetchNextPageError && <ErrorAlert error={q.error} onRetry={() => void q.fetchNextPage()} />}
      {q.hasNextPage && (
        <Button style={{ marginTop: 12 }} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          更早的
        </Button>
      )}
      <Modal
        destroyOnHidden
        open={!!target}
        title={`回滚到v${target?.versionNo ?? ''}`}
        onCancel={close}
        footer={
          <>
            <Button onClick={close}>再看看</Button>
            <PrimaryButton disabled={!note.trim()} loading={busy} onClick={() => void rollback()}>
              回滚到v{target?.versionNo ?? ''}
            </PrimaryButton>
          </>
        }
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Descriptions
            size="small"
            column={1}
            items={[{ label: '说明', children: '取这个版本的可编辑节、现在的固定规则节，生成并发布一个新版本；已有的草稿不动。' }]}
          />
          <Input.TextArea rows={3} placeholder="变更说明（必填）" value={note} onChange={(e) => setNote(e.target.value)} />
          {error !== null && <ErrorAlert error={error} />}
        </Space>
      </Modal>
    </Card>
  );
}
