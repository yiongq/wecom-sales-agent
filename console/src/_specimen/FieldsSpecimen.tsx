// 字段渲染器样张：路由 /_specimen/fields，只在 VITE_SPECIMEN=1 的构建里注册（plan 第 3.2 步）。渲染器接进产品库页之前
// （第 9、10 步），在这里对照设计系统 §6 与 D、E、G、L 页看三种形态和表单网格。和产品页一样只经接口认识行业包：
// 取 /pack 和各实体的列表（走查时由 Playwright 拦截，换成旅游包或假包），不 import 任何包模块。
// ?kind=route&code=r-sichuan-lux&as=active|draft|new|readonly&theme=light|dark
//   as：active 按已上架的锁定规则、draft 草稿（有输入框）、new 新建（空表单，编号可填）、readonly 没有编辑权限；默认按条目自己的状态。
// 表单下面实时写出补丁（set / unset）与上架前检查的计数：打开不做改动时补丁为空（不变量 16）。
// 匿名的列表没有状态、更新两列（spec「产品库列表」的匿名一行）：接口给的条目都没有状态时就是匿名投影
import { useQueries, useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import type { CatalogItem } from '../../../src/shared/console-api.js';
import { relativeTime } from '../../../src/shared/format.js';
import { checkItem, type EntityType, type FieldDef, type IndustryPack } from '../../../src/shared/pack.js';
import { api, catalogKind, unwrap } from '../api.js';
import { type FieldEnv, FieldEnvContext } from '../fields/env.js';
import { FieldGrid } from '../fields/FieldGrid.js';
import '../fields/fields.css';
import { formState, type ItemContext, type Payload, readValue, refItemsOf, submission } from '../fields/model.js';
import { FieldCell } from '../fields/renderers.js';
import { catalogListQuery } from '../queries.js';
import { Frame, Section } from './Frame.js';

type As = ItemContext['status'] | 'readonly';
/** 前端把条目的 payload 一律当 Record<string, unknown> 读（spec「下发」）；匿名的列表没有状态与更新人 */
type Row = Pick<CatalogItem, 'code'> & Partial<Pick<CatalogItem, 'status' | 'updatedAt' | 'updatedByName'>> & { payload: Payload };

/** 列表列里的键 → 字段；$updated 不是字段（第 9 步的列表页画「小林 · 今天13:40」） */
const columnField = (e: EntityType, key: string): FieldDef | undefined => e.fields.find((f) => f.key === key);

function cellValue(key: string, row: Row): unknown {
  if (key === '$code') return row.code;
  if (key === '$status') return row.status;
  return readValue(row.payload, key);
}

/** suggest: 'distinct' 的联想：本实体各条目在这个字段上已有的值（数组展开），去重 */
function distinctOf(rows: readonly Row[], key: string): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const v = readValue(r.payload, key);
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) out.add(x);
  }
  return [...out];
}

function Specimen({ pack }: { pack: IndustryPack }) {
  const search: { kind?: string; code?: string; as?: string } = useSearch({ strict: false });
  const entity = pack.entities.find((e) => e.kind === search.kind) ?? pack.entities[0]!;
  const lists = useQueries({ queries: pack.entities.map((e) => catalogListQuery(catalogKind(e.kind))) });
  const rowsOf = (kind: string): Row[] | undefined => {
    const i = pack.entities.findIndex((e) => e.kind === kind);
    return lists[i]?.data?.items as unknown as Row[] | undefined;
  };
  const rows = rowsOf(entity.kind);
  // 走查时 Playwright 钉住时钟；打开页面时取一次
  const [now] = useState(() => Date.now());
  const env: FieldEnv = {
    now,
    refItems: (kind) => {
      const target = pack.entities.find((e) => e.kind === kind);
      const r = rowsOf(kind);
      return target && r ? refItemsOf(target, r) : undefined;
    },
    distinct: (key) => distinctOf(rows ?? [], key),
    entityLabel: (kind) => pack.entities.find((e) => e.kind === kind)?.label,
  };
  if (!rows) return <p className="spec-label">正在取{entity.label}列表…</p>;
  const row = rows.find((r) => r.code === search.code) ?? rows[0];
  const anon = rows.every((r) => r.status === undefined);
  const columns = entity.list.columns.filter((k) => !(anon && (k === '$status' || k === '$updated')));
  return (
    <FieldEnvContext.Provider value={env}>
      <Section title={`列表单元格 · ${entity.label}`}>
        <div className="spec-table-wrap">
          <table className="spec-table">
            <thead>
              <tr>
                {columns.map((k) => (
                  <th key={k}>{columnField(entity, k)?.label ?? (k === '$updated' ? '更新' : k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.code}>
                  {columns.map((k) => {
                    const f = columnField(entity, k);
                    return (
                      <td key={k} className={f && (f.type === 'money' || f.type === 'intUnit') ? 'is-num' : undefined}>
                        {f ? (
                          <FieldCell field={f} value={cellValue(k, r)} row={r.payload} />
                        ) : r.updatedAt ? (
                          `${r.updatedByName ?? '系统导入'} · ${relativeTime(r.updatedAt, now)}`
                        ) : (
                          '—'
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      {row ? <ItemForm key={`${entity.kind}:${row.code}:${search.as ?? ''}`} entity={entity} row={row} as={search.as} /> : null}
    </FieldEnvContext.Provider>
  );
}

function ItemForm({ entity, row, as }: { entity: EntityType; row: Row; as?: string }) {
  const mode: As = as === 'active' || as === 'draft' || as === 'new' || as === 'readonly' ? as : (row.status ?? 'active');
  // 新建是空表单
  const [original] = useState<Payload>(() => (mode === 'new' ? {} : row.payload));
  const [state, setState] = useState<Payload>(() => formState(original));
  const ctx: ItemContext = mode === 'readonly' ? { status: row.status ?? 'active', canEdit: false } : { status: mode, canEdit: true };
  const patch = submission(original, state, entity.fields);
  const check = checkItem(entity, state);
  const changed = [...Object.keys(patch.set), ...patch.unset.map((k) => `-${k}`)];
  return (
    <Section title={`表单 · ${row.code} · ${mode}`}>
      <div className="spec-form-cols">
        <div className="spec-form-main">
          {entity.groups.map((g) => (
            <section key={g.key} className="spec-card" aria-label={g.label}>
              <h3 className="spec-card-title">{g.label}</h3>
              <FieldGrid entity={entity} group={g.key} state={state} ctx={ctx} onChange={setState} />
            </section>
          ))}
        </div>
        <aside className="spec-form-side">
          <p className="spec-note" data-testid="patch">
            {changed.length ? `改动：${changed.join('、')}` : '改动：无'}
          </p>
          <p className="spec-note" data-testid="check">
            {`必须项${check.requiredPassed}/${check.requiredTotal} · 建议${check.recommended.length}条没做`}
          </p>
          <ul className="spec-issues">
            {[...check.required, ...check.recommended].map((i) => (
              <li key={`${i.path}:${i.message}`} className="spec-label">{`${i.label}：${i.message}`}</li>
            ))}
          </ul>
        </aside>
      </div>
    </Section>
  );
}

export function FieldsSpecimen() {
  const pack = useQuery({ queryKey: ['specimen', 'pack'], queryFn: () => unwrap(api.pack.$get()) });
  return (
    <Frame title="字段渲染器样张">
      {pack.data ? (
        <Specimen pack={pack.data as IndustryPack} />
      ) : (
        <p className="spec-label">{pack.isError ? '没取到 /pack' : '正在取 /pack…'}</p>
      )}
    </Frame>
  );
}
