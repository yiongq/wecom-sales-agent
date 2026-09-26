// 产品库 CSV 导入（spec「后台 API 与页面 · 产品库」，可砍项，没砍）：只建 draft，只收平铺字段，数组用「、」分隔。
// 能用哪些列、这一类能不能导入，都由共用的 schema 推出来（src/shared/catalog-csv.ts）；整份全部合格才建，不合格按行列出问题
import { Alert, App, Button, Input, Modal, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { catalogCsvColumns } from '../../../src/shared/catalog-csv.js';
import type { CatalogKind } from '../../../src/shared/catalog.js';
import type { ApiError } from '../../../src/shared/console-api.js';
import { api, describe, HttpError, unwrap } from '../api.js';
import { decodeCsvFile } from '../csvFile.js';

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

  // 不用 file.text()：它把非 UTF-8 的字节静默换成替换符（见 csvFile.ts）
  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setRows(null);
    setError(null);
    try {
      setCsv(decodeCsvFile(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      setCsv('');
      setError(describe(e));
    }
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
      <Button
        onClick={() => {
          // 上回的报错和不合格清单不带进这回（文件框随弹窗重建，已经是空的）；粘贴的 CSV 留着
          setError(null);
          setRows(null);
          setOpen(true);
        }}
      >
        CSV 导入
      </Button>
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
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              // 读之前清掉选中值：另存成 UTF-8 后多半还是同一个文件名，不清的话再选它浏览器不发 change，报错就一直挂着
              const file = e.target.files?.[0];
              e.target.value = '';
              void readFile(file);
            }}
          />
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
