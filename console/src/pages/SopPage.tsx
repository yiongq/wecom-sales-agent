// SOP 页（spec「后台 API 与页面 · SOP」）：左侧节列表（锁定节只读），右侧编辑可编辑节的正文；顶栏是草稿状态、字符预算、
// 检查 / 发布 / 丢弃；检查结果按节列出 violation，需要 rebase 与冲突时标出；历史列表可以「以此版本回滚」。
// 匿名（demo）只拿到已发布版本的节，全部只读。
import { LockOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Input,
  Menu,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type {
  AnonSopOverview,
  ContractViolation,
  DraftCheck,
  SectionSpecView,
  SopOverview,
  SopSectionText,
  SopVersion,
} from '../../../src/shared/console-api.js';
import { api, describe, HttpError, unwrap } from '../api.js';
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
  if (q.isPending) return <Spin />;
  if (q.isError) return <Alert type="error" title={describe(q.error)} />;
  return 'spec' in q.data ? <MemberSop data={q.data} editable={canEdit(viewer.data)} /> : <AnonSop data={q.data} />;
}

function AnonSop({ data }: { data: AnonSopOverview }) {
  const { published } = data;
  const [key, setKey] = useState(published.sections[0]?.key ?? '');
  const title = (s: SopSectionText): string => (s.text.startsWith('## ') ? s.text.slice(3, s.text.indexOf(NL)) : '前言');
  const current = published.sections.find((s) => s.key === key);
  return (
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        v{published.versionNo} · 发布于 {when(published.publishedAt)} · prompt {published.promptHash}
      </Typography.Text>
      <Row gutter={16}>
        <Col span={6}>
          <Menu
            mode="inline"
            style={{ border: '1px solid #f0f0f0', borderRadius: 6 }}
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

function MemberSop({ data, editable }: { data: SopOverview; editable: boolean }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { published, draft, spec, budget } = data;
  const current = draft ?? published;
  const [key, setKey] = useState(spec.find((s) => !s.locked)?.key ?? spec[0]!.key);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<DraftCheck | null>(null);
  const [rejected, setRejected] = useState<ContractViolation[] | null>(null);
  const [conflict, setConflict] = useState<{ keys: string[]; current: SopSectionText[] } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const section = spec.find((s) => s.key === key)!;
  const originalBody = (k: string): string => {
    const s = spec.find((x) => x.key === k)!;
    return bodyOf(current.sections.find((x) => x.key === k)?.text ?? '', s.heading);
  };
  const dirty = Object.keys(edits).filter((k) => edits[k] !== originalBody(k));
  // 先等新数据回来再清掉本地改动，免得编辑器先闪回旧正文
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['sop'] });
    await qc.invalidateQueries({ queryKey: ['sop-versions'] });
    setEdits({});
  };
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      message.error(describe(e));
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
      setCheck(null);
      message.success('草稿已保存');
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
        message.success(`已发布 v${v.versionNo}`);
        setPublishing(false);
        setNote('');
        setCheck(null);
        await refresh();
      } catch (e) {
        setPublishing(false);
        if (e instanceof HttpError && e.body.error === 'contract') setRejected(e.body.violations ?? []);
        else if (e instanceof HttpError && e.body.error === 'sop_conflict')
          setConflict({ keys: e.body.keys ?? [], current: e.body.current ?? [] });
        else throw e;
      }
    });
  const discard = () =>
    run(async () => {
      await unwrap(api.sop.draft.discard.$post({ json: { rev: draft!.rev } }));
      setCheck(null);
      message.success('草稿已丢弃');
      await refresh();
    });

  const violations = rejected ?? check?.violations ?? null;
  const over = budget.chars > budget.limit;

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap size="large">
          <span>
            已发布 v{published.versionNo}（{when(published.publishedAt)}）
          </span>
          {draft ? (
            <Space>
              <Tag color="blue">草稿 rev {draft.rev}</Tag>
              {draft.stale && <Tag color="orange">已过期：草稿打开之后发布过新版本，发布时自动合并</Tag>}
            </Space>
          ) : (
            <Tag>没有草稿</Tag>
          )}
          <span style={{ width: 220, display: 'inline-block' }}>
            <Progress
              percent={Math.round((budget.chars / budget.limit) * 100)}
              status={over ? 'exception' : 'normal'}
              size="small"
              format={() => `${budget.chars} / ${budget.limit} 字`}
            />
          </span>
          {editable && (
            <Space>
              <Button type="primary" disabled={!dirty.length} loading={busy} onClick={() => void save()}>
                保存草稿{dirty.length ? `（${dirty.length} 节）` : ''}
              </Button>
              <Button disabled={!draft || dirty.length > 0} loading={busy} onClick={() => void runCheck()}>
                检查
              </Button>
              <Button disabled={!draft || dirty.length > 0} loading={busy} onClick={() => setPublishing(true)}>
                发布
              </Button>
              <Popconfirm title="丢弃草稿？" description="草稿里的改动都会丢掉" disabled={!draft} onConfirm={() => void discard()}>
                <Button danger disabled={!draft} loading={busy}>
                  丢弃
                </Button>
              </Popconfirm>
            </Space>
          )}
        </Space>
      </Card>

      {violations && (
        <Card size="small" title={rejected ? '发布被拒：过不了契约检查' : '检查结果'}>
          {check?.rebase.needed && !rejected && (
            <Alert
              style={{ marginBottom: 12 }}
              type={check.rebase.conflicts.length ? 'error' : 'info'}
              title={
                check.rebase.conflicts.length
                  ? `这几节在你编辑期间被别人改过：${check.rebase.conflicts.map((k) => headingOf(spec, k)).join('、')}`
                  : '草稿基于的版本已过期，发布时会自动合并别人的改动'
              }
            />
          )}
          {violations.length === 0 ? (
            <Alert
              type="success"
              title={`没有问题 · ${check?.chars ?? ''} / ${check?.limit ?? ''} 字 · prompt ${check?.promptHash.slice(0, 12) ?? ''}`}
            />
          ) : (
            <Space orientation="vertical">
              {violations.map((v, i) => (
                <Space key={`${v.code}-${v.sectionKey ?? ''}-${i}`}>
                  <Tag color="red">{v.code}</Tag>
                  <b>{headingOf(spec, v.sectionKey)}</b>
                  <span>{v.detail}</span>
                </Space>
              ))}
            </Space>
          )}
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
              <span>把需要的内容合进草稿后再发布，或者丢弃草稿重来。</span>
            </Space>
          }
        />
      )}

      <Row gutter={16}>
        <Col span={6}>
          <Menu
            mode="inline"
            style={{ border: '1px solid #f0f0f0', borderRadius: 6 }}
            selectedKeys={[key]}
            onClick={(e) => setKey(e.key)}
            items={spec.map((s) => ({
              key: s.key,
              icon: s.locked ? <LockOutlined title="锁定节：归代码所有，后台只读" /> : undefined,
              label: (
                <Space>
                  <span>{s.heading ?? '前言'}</span>
                  {dirty.includes(s.key) && <Tag color="gold">未保存</Tag>}
                </Space>
              ),
            }))}
          />
        </Col>
        <Col span={18}>
          {section.locked && (
            <Alert type="info" style={{ marginBottom: 8 }} title="锁定节：代码依赖它，内容以镜像里的 data/sop.md 为准，后台只读" />
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

      <History editable={editable} currentId={published.id} />

      <Modal
        destroyOnHidden
        open={publishing}
        title="发布草稿"
        okText="发布"
        okButtonProps={{ disabled: !note.trim(), loading: busy }}
        onOk={() => void publish()}
        onCancel={() => setPublishing(false)}
      >
        <Input.TextArea rows={3} placeholder="变更说明（必填）" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </Space>
  );
}

/** 草稿与已发布版本的逐节对比：只列改过的可编辑节，展开才建编辑器 */
function DraftDiff({ spec, published, draft }: { spec: readonly SectionSpecView[]; published: SopVersion; draft: SopVersion }) {
  const textOf = (v: SopVersion, key: string): string => v.sections.find((s) => s.key === key)?.text ?? '';
  const changed = spec.filter((s) => !s.locked && textOf(published, s.key) !== textOf(draft, s.key));
  return (
    <Card size="small" title={`与已发布 v${published.versionNo} 的逐节对比`}>
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
                beforeLabel={`已发布 v${published.versionNo}`}
                afterLabel={`草稿 rev ${draft.rev}`}
              />
            ),
          }))}
        />
      )}
    </Card>
  );
}

function History({ editable, currentId }: { editable: boolean; currentId: string }) {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const q = useQuery({ queryKey: ['sop-versions'], queryFn: () => unwrap(api.sop.versions.$get({ query: { limit: '50' } })) });
  const [target, setTarget] = useState<SopVersion | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const rollback = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    try {
      const v = await unwrap(api.sop.versions[':id'].rollback.$post({ param: { id: target.id }, json: { changeNote: note } }));
      setTarget(null);
      setNote('');
      await qc.invalidateQueries({ queryKey: ['sop'] });
      await qc.invalidateQueries({ queryKey: ['sop-versions'] });
      if (v.sameHashAsTarget) message.success(`已回滚：新版本 v${v.versionNo}，prompt 与 v${target.versionNo} 相同`);
      else {
        modal.info({
          title: `已回滚：新版本 v${v.versionNo}`,
          content: `新版本的 prompt_hash 与 v${target.versionNo} 不同：v${target.versionNo} 之后锁定节、硬性要求或工具定义变过，回滚只恢复可编辑节，锁定部分取当前镜像。`,
        });
      }
    } catch (e) {
      message.error(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card size="small" title="版本历史">
      {q.isError ? (
        <Alert type="error" title={describe(q.error)} />
      ) : (
        <Table<SopVersion>
          size="small"
          rowKey="id"
          loading={q.isPending}
          dataSource={q.data?.items ?? []}
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
                  <Tag color="green">当前</Tag>
                ) : null,
            },
          ]}
        />
      )}
      <Modal
        destroyOnHidden
        open={!!target}
        title={`回滚到 v${target?.versionNo ?? ''}`}
        okText="回滚"
        okButtonProps={{ disabled: !note.trim(), loading: busy }}
        onOk={() => void rollback()}
        onCancel={() => setTarget(null)}
      >
        <Descriptions
          size="small"
          column={1}
          items={[{ label: '说明', children: '取这个版本的可编辑节、当前镜像的锁定节，生成并发布一个新版本；已有的草稿不动。' }]}
        />
        <Input.TextArea rows={3} placeholder="变更说明（必填）" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </Card>
  );
}
