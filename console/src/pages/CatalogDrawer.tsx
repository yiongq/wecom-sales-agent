// 产品库条目的旧抽屉（01 的「后台 API 与页面 · 产品库」）：表单由共用的 RouteSchema / HotelSchema 转成 JSON Schema 自动生成，
// active 条目的锁定字段只读并注明「有报价快照后开放」；保存时只把改过的顶层字段放进 set（删掉的可选字段进 unset）。
// 「新建」生成 draft，「上架」要二次确认。匿名（demo）只看得到 active 条目，全部只读。
// 出错就地显示（ErrorAlert，文案取 ERROR_COPY），成功只报 toast；表单有改动时拦下站内跳转。
// 列表页的「新建」、详情页（第 10.1 步）页头的「在旧表单里改」打开它，按需下载（rjsf 不进产品库页和详情页的块）。
// 只认 CATALOG_SCHEMAS 里的 kind；详情页的保存条（第 10.2 步）与新建、上架（第 10.3 步）到了以后删掉本文件和 @rjsf/*
import Form from '@rjsf/antd';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { Button, Drawer, Modal, Space, Typography } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { ALWAYS_LOCKED, CATALOG_SCHEMAS, LOCKED_WHEN_ACTIVE, type CatalogKind } from '../../../src/shared/catalog.js';
import type { AnonCatalogItem, CatalogItem } from '../../../src/shared/console-api.js';
import { api, HttpError, unwrap } from '../api.js';
import { diffPayload, formPayload, type Payload } from '../catalogForm.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { toast } from '../parts/toast.js';
import { useUnsavedGuard } from '../parts/UnsavedGuard.js';
import { zodValidator } from '../zodValidator.js';

export type Row = AnonCatalogItem & Partial<Pick<CatalogItem, 'status' | 'rev' | 'updatedByName' | 'updatedAt'>>;
const fieldsOf = (r: Row): Payload => r.payload as unknown as Payload;
const fieldLabel = (f: string): string => {
  const [field, member] = f.split(':');
  return member ? `${field}里的「${member}」` : field!;
};

function schemaFor(kind: CatalogKind): RJSFSchema {
  return z.toJSONSchema(CATALOG_SCHEMAS[kind], { target: 'draft-7', io: 'input' }) as RJSFSchema;
}

/**
 * 新条目的初值：必填的数组先给空数组（tags 可以为空，但键得在）；必填的布尔给 false，
 * 让存下来的值就是复选框显示的样子（没勾的框在 antd 里显示成「否」，键却不存在）。其余字段留空，没填就是键不存在
 */
function blankFor(schema: RJSFSchema): Payload {
  const props = (schema.properties ?? {}) as Record<string, RJSFSchema>;
  const initial = (k: string): [string, unknown][] => {
    const type = props[k]?.type;
    if (type === 'array') return [[k, []]];
    if (type === 'boolean') return [[k, false]];
    return [];
  };
  return Object.fromEntries((schema.required ?? []).flatMap(initial));
}

/** 锁定字段只读并注明原因；readOnly（非编辑角色、匿名）整张表单只读；打开的条目没有改动时不画保存按钮 */
function uiSchemaFor(kind: CatalogKind, status: 'draft' | 'active' | null, readOnly: boolean, unchanged: boolean): UiSchema {
  const ui: UiSchema = { 'ui:submitButtonOptions': { norender: readOnly || unchanged, submitText: '保存' } };
  if (readOnly) ui['ui:readonly'] = true;
  if (kind === 'route') ui.itinerary = { items: { detail: { 'ui:widget': 'textarea' } } };
  if (status === null) return ui;
  for (const f of status === 'active' ? LOCKED_WHEN_ACTIVE[kind] : ALWAYS_LOCKED) {
    const [field, member] = f.split(':') as [string, string | undefined];
    const prev = (ui[field] as UiSchema | undefined) ?? {};
    ui[field] = member
      ? { ...prev, 'ui:help': `「${member}」这一项已上架锁定，有报价快照后开放` }
      : { ...prev, 'ui:readonly': true, 'ui:help': status === 'active' ? '已上架，锁定：有报价快照后开放' : '编号建好之后不能改' };
  }
  return ui;
}

/** 保存、上架失败：文案取 ERROR_COPY；共用 schema 的逐条问题列在下面（字段路径随第 10 步换成中文标签） */
function SaveError({ error }: { error: unknown }) {
  const issues = error instanceof HttpError ? (error.body.issues ?? []) : [];
  return (
    <ErrorAlert error={error} ctx={{ fieldLabel }}>
      {issues.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {issues.map((i) => (
            <li key={`${i.path}-${i.message}`}>{`${i.path || '（整条）'}：${i.message}`}</li>
          ))}
        </ul>
      )}
    </ErrorAlert>
  );
}

export function CatalogDrawer(props: {
  kind: CatalogKind;
  /** 实体名（行业包给的，如「线路」） */
  label: string;
  row: Row | null;
  /** 打开时表单里的内容（详情页上没保存的改动），和 row 比出改动；不给就是 row 的原文 */
  draft?: Payload;
  editable: boolean;
  onClose: () => void;
  onSaved: (item: CatalogItem) => Promise<void>;
}) {
  const { kind, row, editable } = props;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [activating, setActivating] = useState(false);
  const recheckRef = useRef<HTMLButtonElement>(null);
  const status = row ? (row.status ?? 'active') : null;
  const schema = useMemo(() => schemaFor(kind), [kind]);
  const required = useMemo(() => schema.required ?? [], [schema]);
  const validator = useMemo(() => zodValidator(CATALOG_SCHEMAS[kind], (d) => formPayload(d as Payload, required)), [kind, required]);
  // 每次渲染都给新对象会让表单重置成初值，所以要记住
  const initial = useMemo(() => (row ? fieldsOf(row) : blankFor(schema)), [row, schema]);
  // 表单是受控的：rjsf 在任何 prop 变了时（比如保存中的 disabled）都按 formData 这个 prop 重建状态，
  // 不受控时没保存的改动会被冲回初值；「上架」也要据此知道有没有没保存的改动。换了条目或 rev（即表单的 key）就回到初值
  const formKey = `${row?.code ?? 'new'}-${row?.rev ?? 0}`;
  const [edited, setEdited] = useState<{ key: string; data: Payload } | null>(() =>
    props.draft ? { key: formKey, data: props.draft } : null,
  );
  const formData = edited?.key === formKey ? edited.data : initial;
  // 与打开时比：现有条目比库里的内容，新建比空表单（rjsf 挂载时会先回调一次预填的默认值，不算改动）
  const pending = diffPayload(formPayload(initial, required), formPayload(formData, required));
  const dirty = Object.keys(pending.set).length > 0 || pending.unset.length > 0;
  const ui = useMemo(() => uiSchemaFor(kind, status, !editable, !!row && !dirty), [kind, status, editable, row, dirty]);
  const guard = useUnsavedGuard(editable && dirty);

  const run = async (fn: () => Promise<CatalogItem | null>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const item = await fn();
      if (item) await props.onSaved(item);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = (formData: Payload) =>
    run(async () => {
      if (!row) {
        const item = await unwrap(api.catalog[':kind'].$post({ param: { kind }, json: { payload: formData } }));
        toast(`已建草稿${item.code}`);
        return item;
      }
      const { set, unset } = diffPayload(fieldsOf(row), formData);
      if (!Object.keys(set).length && !unset.length) return null;
      const item = await unwrap(
        api.catalog[':kind'][':code'].$patch({
          param: { kind, code: row.code },
          json: { rev: row.rev!, set, ...(unset.length ? { unset } : {}) },
        }),
      );
      toast('已保存');
      return item;
    });
  const activate = () =>
    run(async () => {
      try {
        const item = await unwrap(
          api.catalog[':kind'][':code'].activate.$post({ param: { kind, code: row!.code }, json: { rev: row!.rev! } }),
        );
        toast(`${item.code}已上架`);
        return item;
      } finally {
        setActivating(false);
      }
    });

  return (
    <Drawer
      open
      size={720}
      title={row ? `${props.label} ${row.code}` : `新建${props.label}（草稿）`}
      onClose={props.onClose}
      destroyOnHidden
    >
      <Space orientation="vertical" style={{ width: '100%' }}>
        {guard}
        {/* 上架只认库里存着的内容：表单里没保存的改动带不上去，上架后锁定字段又只能停机用命令行改，所以有改动时先保存 */}
        {row && status === 'draft' && editable && (
          <Space>
            <Button loading={busy} disabled={dirty} onClick={() => setActivating(true)}>
              上架
            </Button>
            {dirty && <Typography.Text type="secondary">表单里有没保存的改动，先保存再上架</Typography.Text>}
          </Space>
        )}
        {error !== null && <SaveError error={error} />}
        <Form
          key={formKey}
          schema={schema}
          uiSchema={ui}
          validator={validator}
          formData={formData}
          onChange={(e) => setEdited({ key: formKey, data: e.formData as Payload })}
          disabled={busy}
          showErrorList="top"
          // 可选对象（intensity）里的必填字段会带上 HTML 的 required，浏览器会拦下整张表单；校验只交给 schema
          noHtml5Validate
          // 只给必填的数组预填 minItems 个空项；可选的数组和对象（aliases、intensity 之类）不动，没填就是键不存在
          experimental_defaultFormStateBehavior={{ arrayMinItems: { populate: 'requiredOnly' }, emptyObjectFields: 'skipDefaults' }}
          onSubmit={(e) => void save(formPayload(e.formData as Payload, required))}
        />
      </Space>
      <Modal
        open={activating}
        width={480}
        title="上架这一条？"
        onCancel={() => setActivating(false)}
        afterOpenChange={(visible) => {
          if (visible) recheckRef.current?.focus();
        }}
        footer={
          <>
            <Button ref={recheckRef} onClick={() => setActivating(false)}>
              再检查一下
            </Button>
            <PrimaryButton loading={busy} onClick={() => void activate()}>
              上架
            </PrimaryButton>
          </>
        }
      >
        {`上架后这些字段就锁定了：${LOCKED_WHEN_ACTIVE[kind].map(fieldLabel).join('、')}`}
      </Modal>
    </Drawer>
  );
}
