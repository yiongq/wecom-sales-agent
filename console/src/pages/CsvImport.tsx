// 产品库 CSV 导入（spec「后台 API 与页面 · 产品库」，可砍项，没砍）：只建 draft，只收平铺字段，数组用「、」分隔。
// 能用哪些列、这一类能不能导入，都由共用的 schema 推出来（src/shared/catalog-csv.ts）；整份全部合格才建，不合格按行列出问题
import { Alert, App, Button, Input, Modal, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { catalogCsvColumns } from '../../../src/shared/catalog-csv.js';
import type { CatalogKind } from '../../../src/shared/catalog.js';
import type { ApiError } from '../../../src/shared/console-api.js';
import { api, describe, HttpError, unwrap } from '../api.js';

export function CsvImport(props: { kind: CatalogKind; label: string; onDone: () => Promise<void> }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<NonNullable<ApiError['rows']> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shape = catalogCsvColumns(props.kind);

  if (!shape.importable) {
    return (
      <Tooltip title={`${props.label}的必填字段 ${shape.nestedRequired.join('、')} 不是平铺字段，CSV 只收平铺字段，请用「新建」`}>
        <Button disabled>CSV 导入</Button>
      </Tooltip>
    );
  }

  const readFile = async (file: File | undefined): Promise<void> => {
    if (file) setCsv(await file.text());
  };
  const submit = async (): Promise<void> => {
    setBusy(true);
    setRows(null);
    setError(null);
    try {
      const r = await unwrap(api.catalog[':kind']['import-csv'].$post({ param: { kind: props.kind }, json: { csv } }));
      message.success(`已建 ${r.items.length} 条草稿`);
      setOpen(false);
      setCsv('');
      await props.onDone();
    } catch (e) {
      if (e instanceof HttpError && e.body.rows) setRows(e.body.rows);
      else setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>CSV 导入</Button>
      <Modal
        destroyOnHidden
        open={open}
        width={720}
        title={`CSV 导入${props.label}（建成草稿）`}
        okText="导入"
        okButtonProps={{ disabled: !csv.trim(), loading: busy }}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            第一行是表头，用下面这些字段名（id 必填，顺序随意）；数组字段用「、」分隔，布尔写「是 /
            否」。整份都合格才建，一条不合格就一条都不建。
          </Typography.Paragraph>
          <Typography.Text code copyable>
            {shape.columns.join(',')}
          </Typography.Text>
          <input type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} />
          <Input.TextArea rows={8} placeholder="也可以把 CSV 粘贴在这里" value={csv} onChange={(e) => setCsv(e.target.value)} />
          {error && <Alert type="error" title={error} />}
          {rows && (
            <Alert
              type="error"
              title="没导入：下面这些地方不合格"
              description={
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {rows.flatMap((r) =>
                    r.issues.map((i) => (
                      <li key={`${r.row}-${i.path}-${i.message}`}>
                        {r.row === 0 ? '表头' : `第 ${r.row} 行`}
                        {i.path ? ` ${i.path}` : ''}：{i.message}
                      </li>
                    )),
                  )}
                </ul>
              }
            />
          )}
        </Space>
      </Modal>
    </>
  );
}
