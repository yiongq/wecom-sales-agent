// 产品库页（spec「后台 API 与页面 · 产品库」）：线路 / 酒店两个表；表单由共用的 RouteSchema / HotelSchema 转成 JSON Schema 自动生成，
// active 条目的锁定字段只读并注明「有报价快照后开放」；保存时只把改过的顶层字段放进 set（删掉的可选字段进 unset）。
// 「新建」生成 draft，「上架」要二次确认。匿名（demo）只看得到 active 条目，全部只读。
import Form from '@rjsf/antd';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Alert, App, Button, Drawer, Popconfirm, Space, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { ALWAYS_LOCKED, CATALOG_SCHEMAS, LOCKED_WHEN_ACTIVE, sameValue, type CatalogKind } from '../../../src/shared/catalog.js';
import type { AnonCatalogItem, CatalogItem } from '../../../src/shared/console-api.js';
import { api, describe, HttpError, unwrap } from '../api.js';
import { canEdit, useViewer } from '../viewer.js';
import { zodValidator } from '../zodValidator.js';

type Row = AnonCatalogItem & Partial<Pick<CatalogItem, 'status' | 'rev' | 'updatedByName' | 'updatedAt'>>;
type Payload = Record<string, unknown>;
const fieldsOf = (r: Row): Payload => r.payload as unknown as Payload;

const KIND_LABEL: Record<CatalogKind, string> = { route: '线路', hotel: '酒店' };
const fieldLabel = (f: string): string => {
  const [field, member] = f.split(':');
  return member ? `${field} 里的「${member}」` : field!;
};

function schemaFor(kind: CatalogKind): RJSFSchema {
  return z.toJSONSchema(CATALOG_SCHEMAS[kind], { target: 'draft-7', io: 'input' }) as RJSFSchema;
}

/** 新条目的初值：必填的数组先给空数组（tags 可以为空，但键得在）；其余字段留空，没填就是键不存在 */
function blankFor(schema: RJSFSchema): Payload {
  const props = (schema.properties ?? {}) as Record<string, RJSFSchema>;
  return Object.fromEntries((schema.required ?? []).filter((k) => props[k]?.type === 'array').map((k) => [k, []]));
}

/** 锁定字段只读并注明原因；readOnly（非编辑角色、匿名）整张表单只读 */
function uiSchemaFor(kind: CatalogKind, status: 'draft' | 'active' | null, readOnly: boolean): UiSchema {
  const ui: UiSchema = { 'ui:submitButtonOptions': { norender: readOnly, submitText: '保存' } };
  if (readOnly) ui['ui:readonly'] = true;
  if (kind === 'route') ui.itinerary = { items: { detail: { 'ui:widget': 'textarea' } } };
  if (status === null) return ui;
  for (const f of status === 'active' ? LOCKED_WHEN_ACTIVE[kind] : ALWAYS_LOCKED) {
    const [field, member] = f.split(':') as [string, string | undefined];
    const prev = (ui[field] as UiSchema | undefined) ?? {};
    ui[field] = member
      ? { ...prev, 'ui:help': `「${member}」这一项已上架锁定，有报价快照后开放` }
      : { ...prev, 'ui:readonly': true, 'ui:help': status === 'active' ? '已上架，锁定：有报价快照后开放' : 'code 建好之后不能改' };
  }
  return ui;
}

/** 与原条目比：改过的顶层字段整体放进 set，原来有、现在没了的放进 unset */
function diffPayload(prev: Payload, next: Payload): { set: Payload; unset: string[] } {
  const set: Payload = {};
  for (const [k, v] of Object.entries(next)) if (v !== undefined && !sameValue(prev[k], v)) set[k] = v;
  const unset = Object.keys(prev).filter((k) => next[k] === undefined);
  return { set, unset };
}

function problems(e: unknown): string[] {
  if (!(e instanceof HttpError)) return [describe(e)];
  if (e.body.fields?.length) return [`这些字段已锁定，不能改：${e.body.fields.map(fieldLabel).join('、')}`];
  if (e.body.issues?.length) return e.body.issues.map((i) => `${i.path || '（整条）'}：${i.message}`);
  return [describe(e)];
}

export function CatalogPage() {
  const { kind } = useParams({ from: '/catalog/$kind' });
  const viewer = useViewer();
  const editable = canEdit(viewer.data);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['catalog', kind], queryFn: () => unwrap(api.catalog[':kind'].$get({ param: { kind } })) });
  const [open, setOpen] = useState<{ row: Row | null } | null>(null);
  const rows: Row[] = q.data?.items ?? [];

  if (q.isError) return <Alert type="error" title={describe(q.error)} />;
  return (
    <Space orientation="vertical" style={{ width: '100%' }}>
      {editable && (
        <Button type="primary" onClick={() => setOpen({ row: null })}>
          新建{KIND_LABEL[kind]}
        </Button>
      )}
      <Table<Row>
        rowKey="code"
        size="small"
        loading={q.isPending}
        dataSource={rows}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        onRow={(row) => ({ onClick: () => setOpen({ row }), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'code', dataIndex: 'code' },
          { title: '标题', render: (_: unknown, r) => String(fieldsOf(r).title ?? fieldsOf(r).name ?? '') },
          { title: '目的地', render: (_: unknown, r) => String(fieldsOf(r).destination ?? '') },
          { title: '起价', render: (_: unknown, r) => `¥${String(fieldsOf(r).priceFrom ?? fieldsOf(r).nightlyFrom ?? '')}` },
          ...(viewer.data?.kind === 'member'
            ? [
                {
                  title: '状态',
                  render: (_: unknown, r: Row) => (r.status === 'active' ? <Tag color="green">已上架</Tag> : <Tag>草稿</Tag>),
                },
                { title: '更新人', render: (_: unknown, r: Row) => r.updatedByName ?? '—' },
                { title: '更新时间', render: (_: unknown, r: Row) => (r.updatedAt ? dayjs(r.updatedAt).format('YYYY-MM-DD HH:mm') : '—') },
              ]
            : []),
        ]}
      />
      {open && (
        <ItemDrawer
          kind={kind}
          row={open.row}
          editable={editable}
          onClose={() => setOpen(null)}
          onSaved={async (item) => {
            setOpen({ row: item });
            await qc.invalidateQueries({ queryKey: ['catalog', kind] });
          }}
        />
      )}
    </Space>
  );
}

function ItemDrawer(props: {
  kind: CatalogKind;
  row: Row | null;
  editable: boolean;
  onClose: () => void;
  onSaved: (item: CatalogItem) => Promise<void>;
}) {
  const { kind, row, editable } = props;
  const { message } = App.useApp();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const status = row ? (row.status ?? 'active') : null;
  const schema = useMemo(() => schemaFor(kind), [kind]);
  const validator = useMemo(() => zodValidator(CATALOG_SCHEMAS[kind]), [kind]);
  const ui = useMemo(() => uiSchemaFor(kind, status, !editable), [kind, status, editable]);
  // 每次渲染都给新对象会让表单重置成初值，所以要记住
  const initial = useMemo(() => row?.payload ?? blankFor(schema), [row, schema]);

  const run = async (fn: () => Promise<CatalogItem | null>): Promise<void> => {
    setBusy(true);
    setErrors([]);
    try {
      const item = await fn();
      if (item) await props.onSaved(item);
    } catch (e) {
      setErrors(problems(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (formData: Payload) =>
    run(async () => {
      if (!row) {
        const item = await unwrap(api.catalog[':kind'].$post({ param: { kind }, json: { payload: formData } }));
        message.success(`已建草稿 ${item.code}`);
        return item;
      }
      const { set, unset } = diffPayload(fieldsOf(row), formData);
      if (!Object.keys(set).length && !unset.length) {
        message.info('没有改动');
        return null;
      }
      const item = await unwrap(
        api.catalog[':kind'][':code'].$patch({
          param: { kind, code: row.code },
          json: { rev: row.rev!, set, ...(unset.length ? { unset } : {}) },
        }),
      );
      message.success('已保存');
      return item;
    });
  const activate = () =>
    run(async () => {
      const item = await unwrap(
        api.catalog[':kind'][':code'].activate.$post({ param: { kind, code: row!.code }, json: { rev: row!.rev! } }),
      );
      message.success(`${item.code} 已上架`);
      return item;
    });

  return (
    <Drawer
      open
      size={720}
      title={row ? `${KIND_LABEL[kind]} ${row.code}` : `新建${KIND_LABEL[kind]}（草稿）`}
      onClose={props.onClose}
      destroyOnHidden
    >
      <Space orientation="vertical" style={{ width: '100%' }}>
        {row && status === 'draft' && editable && (
          <Popconfirm
            title="上架这一条？"
            description={`上架后这些字段就锁定了：${LOCKED_WHEN_ACTIVE[kind].map(fieldLabel).join('、')}`}
            onConfirm={() => void activate()}
          >
            <Button type="primary" ghost loading={busy}>
              上架
            </Button>
          </Popconfirm>
        )}
        {errors.length > 0 && (
          <Alert
            type="error"
            title="没保存"
            description={
              <ul>
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            }
          />
        )}
        <Form
          key={`${row?.code ?? 'new'}-${row?.rev ?? 0}`}
          schema={schema}
          uiSchema={ui}
          validator={validator}
          formData={initial}
          disabled={busy}
          showErrorList="top"
          // 可选对象（intensity）里的必填字段会带上 HTML 的 required，浏览器会拦下整张表单；校验只交给 schema
          noHtml5Validate
          // 只给必填的数组预填 minItems 个空项；可选的数组和对象（aliases、intensity 之类）不动，没填就是键不存在
          experimental_defaultFormStateBehavior={{ arrayMinItems: { populate: 'requiredOnly' }, emptyObjectFields: 'skipDefaults' }}
          onSubmit={({ formData }) => void save(formData as Payload)}
        />
      </Space>
    </Drawer>
  );
}
