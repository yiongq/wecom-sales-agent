// 产品库 CSV 导入弹窗（spec「CSV 导入（H 页）」，设计系统 §5.14、§5.5 与 H 页，plan 第 12 步）。宽 880，五步：
// 1. 下载模板：带 BOM、表头是字段的中文标签；小表写每列怎么填，例子照已有的一条；
// 2. 选文件：拖放或点选，只在本地读（先 UTF-8 严格解码，不成再 GBK）；保留「粘贴」页签。空文件、只有表头停在这一步；
// 3. 校验结果：文件行（「按UTF-8读取 · 8行」）、汇总、逐行「合格 / 要改」，出错的格子标出、原因写在最后一列；
//    超过三条上限写「这份文件太大，请分成N份导入」，不发请求；
// 4. 导入：全部合格是「导入N条草稿」，有不合格是「只导入合格的N行」加「下载不合格的M行（带原因）」，不放禁用的「全部导入」；
//    服务端 422 的逐行问题放回第 3 步的表格；
// 5. 完成：「已建N条草稿」，去草稿页签逐条检查后上架。
// 纯逻辑在 csv-import.ts；行业包只经 props 进来。产品库文本只以文本节点渲染（不变量 28）
import { Alert, Button, Input, Modal, Table, type TableColumnsType, Tabs } from 'antd';
import { Check, CircleCheck, CircleX, Download, FileText, FileUp, LoaderCircle, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { api, catalogKind, HttpError, unwrap } from '../api.js';
import { CsvEncodingError, ENCODING_NAME, readCsvBytes } from '../csvFile.js';
import { saveText } from '../download.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { Icon } from '../shell/icons.js';
import { cjk, Sep } from '../typography.js';
import {
  badRows,
  bigTitle,
  cellText,
  type CsvCheck,
  csvRules,
  type CsvSource,
  csvSummary,
  type CsvTable,
  checkCsv,
  downloadLabel,
  failedCsv,
  failedName,
  goodRows,
  importLabel,
  LIMITS_NOTE,
  lookalikeParts,
  type RowIssue,
  type RowResult,
  STEPS,
  submission,
  tableFields,
  tableHeader,
  templateCsv,
  templateName,
  withServerIssues,
} from './csv-import.js';
import { type ListRow, numeric } from './list.js';

type Step = 1 | 2 | 3 | 4 | 5;

export interface CsvImportDialogProps {
  open: boolean;
  pack: IndustryPack;
  entity: EntityType;
  /** 已载入的列表：查编号是否已经有了、填写规则的例子；还没取到时 undefined（编号由服务端兜底） */
  existing: readonly ListRow[] | undefined;
  onClose(): void;
  /** 建好了草稿：页面让列表失效 */
  onImported(): void;
  /** 「去草稿页签」：页面换到草稿页签（清掉搜索与筛选） */
  onShowDrafts(): void;
}

/** 导入中：右上角「关闭」点不动，点遮罩、按 Esc 都不关（关了照样会建成） */
const CLOSE_BUSY = { disabled: true } as const;
const MASK_IDLE = { closable: true } as const;
const MASK_BUSY = { closable: false } as const;

/** 步骤条：已完成的打勾，当前的实心序号，没到的灰（设计系统 H 页） */
function StepsBar({ step }: { step: Step }) {
  return (
    <ol className="csv-steps" aria-label="导入步骤">
      {STEPS.map((name, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return (
          <li key={name} className={`csv-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="csv-step-mark" aria-hidden="true">
              {state === 'done' ? <Icon of={Check} size={14} /> : n}
            </span>
            <span className="csv-step-name">{name}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 形似数字的字母加波浪线（「2,6OO」里的两个 O） */
function Marked({ text }: { text: string }) {
  return (
    <>
      {lookalikeParts(text).map((p, i) =>
        p.mark ? (
          <span key={i} className="csv-lookalike">
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** 原因一列的一句：数值格写错时，引号里原样的那一段标出形似数字的字母 */
function IssueText({ issue }: { issue: RowIssue }) {
  const quoted = issue.raw === undefined ? -1 : issue.text.lastIndexOf(`「${issue.raw}」`);
  if (quoted < 0) return <>{cjk(issue.text)}</>;
  const raw = issue.raw!;
  return (
    <>
      {cjk(issue.text.slice(0, quoted + 1))}
      <Marked text={raw} />
      {cjk(issue.text.slice(quoted + 1 + raw.length))}
    </>
  );
}

/** 一格：出错的格子 --danger-bg 底、danger 字；数值格写错时标出形似数字的字母 */
function Cell({ text, issues, mono }: { text: string; issues: readonly RowIssue[]; mono?: boolean }) {
  const bad = issues.length > 0;
  const raw = issues.find((i) => i.raw !== undefined)?.raw;
  if (!text && !bad) return null;
  // 空着的出错格子写「—」
  const body = !text ? '—' : raw !== undefined && raw === text ? <Marked text={text} /> : mono ? text : cjk(text);
  return <span className={[bad && 'csv-bad', mono && 'mono'].filter(Boolean).join(' ') || undefined}>{body}</span>;
}

const issuesAt = (row: RowResult, col: string): RowIssue[] => row.issues.filter((i) => i.col === col);

/** 第 3 步的表格：行号 · 结果 · 名称与编号（一列两行）· 字段 · 原因 */
function ResultTable({ entity, table }: { entity: EntityType; table: CsvTable }) {
  const titleField = entity.fields.find((f) => f.key === entity.titleKey);
  const fields = tableFields(entity, table.keys);
  const titleCol = titleField ? (titleField.key === '$code' ? 'id' : titleField.key) : null;
  const columns: TableColumnsType<RowResult> = [
    { key: 'row', title: '行号', width: 52, align: 'right', className: 'csv-col-row', render: (_, r) => r.row },
    {
      key: 'result',
      title: '结果',
      width: 76,
      render: (_, r) =>
        r.issues.length ? (
          <span className="csv-result is-bad">
            <Icon of={CircleX} size={16} />
            要改
          </span>
        ) : (
          <span className="csv-result is-ok">
            <Icon of={CircleCheck} size={16} />
            合格
          </span>
        ),
    },
    {
      key: 'title',
      title: titleField ? (
        <>
          {titleField.label}
          <Sep />
          编号
        </>
      ) : (
        '编号'
      ),
      render: (_, r) => (
        <div className="csv-title">
          {titleField && titleCol ? (
            <div className="csv-title-name">
              <Cell text={cellText(titleField, r, table.keys)} issues={issuesAt(r, titleCol)} />
            </div>
          ) : null}
          <div className="csv-title-code">
            <Cell text={cellText({ key: '$code', type: 'text', label: '', group: '' }, r, table.keys)} issues={issuesAt(r, 'id')} mono />
          </div>
        </div>
      ),
    },
    ...fields.map((f): TableColumnsType<RowResult>[number] => ({
      key: f.key,
      title: cjk(tableHeader(f)),
      align: numeric(f) ? 'right' : undefined,
      render: (_, r) => <Cell text={cellText(f, r, table.keys)} issues={issuesAt(r, f.key)} />,
    })),
    {
      key: 'reason',
      title: '原因',
      className: 'csv-col-reason',
      render: (_, r) =>
        r.issues.length ? (
          <ul className="csv-reasons">
            {r.issues.map((i, k) => (
              <li key={k}>
                <IssueText issue={i} />
              </li>
            ))}
          </ul>
        ) : null,
    },
  ];
  return (
    <Table<RowResult>
      className="csv-table csv-results"
      rowKey="row"
      columns={columns}
      dataSource={table.rows}
      pagination={false}
      scroll={{ x: 'max-content', y: 'max(200px, calc(100vh - 460px))' }}
      rowClassName={(r) => (r.issues.length ? 'is-bad' : '')}
    />
  );
}

/** 文件行：「新签酒店-9月.csv · 按UTF-8读取 · 8行」，右边可以放「换一个文件」 */
function FileRow({ source, rows, action }: { source: CsvSource; rows: number | null; action?: ReactNode }) {
  const meta = [...(source.encoding ? [`按${ENCODING_NAME[source.encoding]}读取`] : []), ...(rows === null ? [] : [`${rows}行`])];
  return (
    <div className="csv-file-row">
      <Icon of={FileText} size={16} className="csv-file-icon" />
      <span className="csv-file-name">{source.name ?? '粘贴的内容'}</span>
      {meta.length ? <span className="csv-file-meta">{cjk(meta)}</span> : null}
      {action ? <span className="csv-file-action">{action}</span> : null}
    </div>
  );
}

export function CsvImportDialog(p: CsvImportDialogProps) {
  const { open, pack, entity, existing, onClose } = p;
  const [step, setStep] = useState<Step>(1);
  const [tab, setTab] = useState<'file' | 'paste'>('file');
  const [paste, setPaste] = useState('');
  const [source, setSource] = useState<CsvSource | null>(null);
  /** 第 2 步文件行下的一句（读不出来、没有要导入的行） */
  const [readError, setReadError] = useState<string | null>(null);
  const [check, setCheck] = useState<CsvCheck | null>(null);
  /** 服务端 422 里整份的问题（第 0 行） */
  const [whole, setWhole] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLButtonElement>(null);

  // 换了一步：焦点放到这一步上（第 2 步的「选文件」页签是「选择文件」按钮，其余是这一步的内容），读屏从这里接着念。
  // 只看步数：同一步里换页签不挪焦点，页签自己管
  const shown = useRef(false);
  const lastStep = useRef<Step>(1);
  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    if (!shown.current) return;
    if (step === 2 && tab === 'file') pick.current?.focus();
    else body.current?.focus();
  }, [step, tab]);

  const table = check?.kind === 'rows' ? check.table : null;
  const rowCount = check === null ? null : check.kind === 'rows' ? check.table.rows.length : check.kind === 'empty' ? 0 : check.rows;

  /** 读进来的一份：空的停在第 2 步，其余去第 3 步 */
  const accept = (src: CsvSource): void => {
    const c = checkCsv(entity, src.text, existing);
    setSource(src);
    setWhole([]);
    if (c.kind === 'empty') {
      setCheck(null);
      setReadError(src.name === null ? '粘贴的内容里没有要导入的行' : '这份文件没有要导入的行');
      return;
    }
    setReadError(null);
    setCheck(c);
    setStep(3);
  };

  // 不用 file.text()：它把解不开的字节静默换成替换符（见 csvFile.ts）
  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      accept({ name: file.name, ...readCsvBytes(bytes) });
    } catch (e) {
      if (!(e instanceof CsvEncodingError)) throw e;
      setSource({ name: file.name, encoding: null, text: '' });
      setCheck(null);
      setReadError(e.message);
    }
  };

  const backToFile = (): void => {
    setCheck(null);
    setSource(null);
    setReadError(null);
    setWhole([]);
    setError(null);
    setStep(2);
  };

  const doImport = async (): Promise<void> => {
    if (!table) return;
    const sub = submission(table);
    setError(null);
    setStep(4);
    setBusy(true);
    try {
      const r = await unwrap(
        api.catalog[':kind']['import-csv'].$post({ param: { kind: catalogKind(entity.kind) }, json: { csv: sub.csv } }),
      );
      setCreated(r.items.length);
      setStep(5);
      p.onImported();
    } catch (e) {
      // 422 invalid_csv：逐行的问题放回表格，回到第 3 步（只导入合格的仍然可用）
      if (e instanceof HttpError && e.body.error === 'invalid_csv' && e.body.rows) {
        const merged = withServerIssues(entity, table, sub.rows, e.body.rows);
        setCheck({ kind: 'rows', table: merged.table });
        setWhole(merged.whole);
        setStep(3);
      } else setError(e);
    } finally {
      setBusy(false);
    }
  };

  const ghostBack = (to: () => void): ReactNode => (
    <Button type="text" onClick={to}>
      上一步
    </Button>
  );

  let content: ReactNode;
  let back: ReactNode = null;
  let actions: ReactNode = null;
  if (step === 1) {
    const rules = csvRules(pack, entity, existing?.[0]?.payload);
    content = (
      <>
        <p className="csv-lead">{cjk(`按模板的表头，一行填一条${entity.label}。导入的都是草稿，逐条检查后再上架`)}</p>
        <Button ref={first} icon={<Icon of={Download} />} onClick={() => saveText(templateName(entity), templateCsv(entity))}>
          下载模板
        </Button>
        <Table
          className="csv-table csv-rules"
          rowKey="key"
          pagination={false}
          dataSource={rules}
          columns={[
            {
              key: 'label',
              title: '表头',
              width: 180,
              render: (_, r) => (
                <>
                  {cjk(r.label)}
                  {r.optional ? <span className="optional-mark">（选填）</span> : null}
                </>
              ),
            },
            { key: 'how', title: '怎么填', render: (_, r) => cjk(r.how) },
            {
              key: 'example',
              title: '例子',
              width: 220,
              render: (_, r) => <span className={r.key === 'id' ? 'mono' : undefined}>{r.example ?? '—'}</span>,
            },
          ]}
        />
      </>
    );
    actions = <PrimaryButton onClick={() => setStep(2)}>选文件</PrimaryButton>;
  } else if (step === 2) {
    const fileTab = (
      <div
        className={dragging ? 'csv-drop is-over' : 'csv-drop'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void readFile(e.dataTransfer.files[0]);
        }}
      >
        <Icon of={FileUp} size={20} className="csv-drop-icon" />
        <div className="csv-drop-title">把CSV文件拖到这里</div>
        <div className="csv-drop-note">只在你的电脑上读取，导入之前不会上传</div>
        <Button ref={pick} onClick={() => fileInput.current?.click()}>
          选择文件
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            // 读之前清掉选中值：改好以后多半还是同一个文件名，不清的话再选它浏览器不发 change
            const file = e.target.files?.[0];
            e.target.value = '';
            void readFile(file);
          }}
        />
      </div>
    );
    const problem =
      readError !== null ? (
        <div className="csv-read-error" role="alert">
          <Icon of={CircleX} size={14} />
          {cjk(readError)}
        </div>
      ) : null;
    content = (
      <Tabs
        className="csv-tabs"
        activeKey={tab}
        onChange={(k) => {
          setTab(k as 'file' | 'paste');
          setReadError(null);
          setSource(null);
        }}
        items={[
          {
            key: 'file',
            label: '选文件',
            children: (
              <>
                {fileTab}
                {source && source.name !== null ? (
                  <>
                    <FileRow source={source} rows={source.encoding ? 0 : null} />
                    {problem}
                  </>
                ) : null}
              </>
            ),
          },
          {
            key: 'paste',
            label: '粘贴',
            children: (
              <>
                <Input.TextArea
                  className="csv-paste"
                  aria-label="粘贴CSV"
                  rows={8}
                  value={paste}
                  placeholder={`例：${entityHeaderLine(entity)}`}
                  onChange={(e) => setPaste(e.target.value)}
                />
                {source && source.name === null ? problem : null}
              </>
            ),
          },
        ]}
      />
    );
    back = ghostBack(() => {
      setReadError(null);
      setSource(null);
      setStep(1);
    });
    if (tab === 'paste') actions = <PrimaryButton onClick={() => accept({ name: null, encoding: null, text: paste })}>校验</PrimaryButton>;
  } else if (step === 3 && source && check) {
    const change = (
      <Button type="link" onClick={backToFile}>
        {source.name === null ? '改粘贴的内容' : '换一个文件'}
      </Button>
    );
    let main: ReactNode = null;
    if (check.kind === 'whole') {
      main = (
        <Alert
          type="error"
          showIcon
          title="无法读取这份文件：表头或格式不对"
          description={
            <ul className="csv-lines">
              {check.lines.map((l, i) => (
                <li key={i}>{cjk(l)}</li>
              ))}
            </ul>
          }
        />
      );
    } else if (check.kind === 'big') {
      main = <Alert type="error" showIcon title={cjk(bigTitle(check.parts))} description={cjk(LIMITS_NOTE)} />;
    } else if (check.kind === 'rows') {
      const s = csvSummary(check.table);
      main = (
        <>
          <Alert type={s.tone} showIcon title={cjk(s.title)} description={cjk(s.note)} />
          {whole.length ? (
            <Alert
              type="error"
              showIcon
              title="无法导入这份文件"
              description={
                <ul className="csv-lines">
                  {whole.map((l, i) => (
                    <li key={i}>{cjk(l)}</li>
                  ))}
                </ul>
              }
            />
          ) : null}
          <ResultTable entity={entity} table={check.table} />
        </>
      );
      const bad = badRows(check.table).length;
      const good = goodRows(check.table).length;
      actions = (
        <>
          {bad ? (
            <Button icon={<Icon of={Download} />} onClick={() => saveText(failedName(entity, source, bad), failedCsv(check.table))}>
              {cjk(downloadLabel(check.table))}
            </Button>
          ) : null}
          {good && !whole.length ? <PrimaryButton onClick={() => void doImport()}>{importLabel(check.table)}</PrimaryButton> : null}
        </>
      );
    }
    content = (
      <>
        <FileRow source={source} rows={rowCount} action={change} />
        {main}
      </>
    );
    back = ghostBack(backToFile);
  } else if (step === 4) {
    content = error ? (
      <ErrorAlert error={error} onRetry={() => void doImport()} />
    ) : (
      <div className="csv-busy" role="status">
        <Icon of={LoaderCircle} size={20} className="csv-busy-icon" />
        {cjk(`正在导入${table ? goodRows(table).length : 0}条草稿`)}
      </div>
    );
    if (!busy) back = ghostBack(() => setStep(3));
  } else if (step === 5) {
    content = (
      <div className="csv-done">
        <Icon of={CircleCheck} size={20} className="csv-done-icon" />
        <div>
          <div className="csv-done-title">{cjk(`已建${created}条草稿`)}</div>
          <div className="csv-done-note">去草稿页签逐条检查后上架</div>
        </div>
      </div>
    );
    actions = (
      <>
        <Button onClick={onClose}>关闭</Button>
        <PrimaryButton onClick={p.onShowDrafts}>去草稿页签</PrimaryButton>
      </>
    );
  }

  return (
    <Modal
      open={open}
      destroyOnHidden
      width={880}
      rootClassName="csv-dialog"
      title={cjk(`从CSV导入${entity.label}`)}
      closeIcon={<Icon of={X} />}
      closable={busy ? CLOSE_BUSY : true}
      mask={busy ? MASK_BUSY : MASK_IDLE}
      keyboard={!busy}
      onCancel={onClose}
      afterOpenChange={(visible) => {
        shown.current = visible;
        if (visible) first.current?.focus();
      }}
      footer={
        <div className="csv-footer">
          <span className="csv-footer-back">{back}</span>
          <span className="csv-footer-actions">{actions}</span>
        </div>
      }
    >
      <StepsBar step={step} />
      <div ref={body} className="csv-body" tabIndex={-1}>
        {content}
      </div>
    </Modal>
  );
}

/** 粘贴框的占位：模板的表头，以「例：」开头 */
const entityHeaderLine = (entity: EntityType): string => templateCsv(entity).slice(1).trim();
