// 产品库列表页（spec「产品库列表（D 页；L 页上半）」，plan 第 9 步）。路由 /catalog/$kind 的 kind 按当前租户的行业包取，
// 包里没有的 kind 是「没有这个页面」。页头：实体名；状态句「共21条 · 销售助手只推荐已上架的」；编辑角色有「新建{实体名}」，
// csvImport 为 true 的实体另有「导入CSV」（不能导入的不渲染这个入口，也不放灰按钮）；非编辑成员和匿名都没有这两个入口。
// 页签、工具条、表格与各种状态在 catalog/CatalogList.tsx，页签、搜索、筛选都写进地址（catalog/params.ts）。
// 名称是链到详情页（/catalog/$kind/$code，第 10.1 步）的链接，任何行业包的实体都一样。
// 「新建」「导入CSV」暂时打开 01 的旧抽屉与导入弹窗，两者都按需下载、不进本页的块：只认共用 schema 里的 kind，
// 第 10.3 步的新建页和第 12 步的导入弹窗按行业包渲染以后换掉（plan「Open」）
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Button } from 'antd';
import { Plus } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { CATALOG_SCHEMAS, type CatalogKind } from '../../../src/shared/catalog.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { catalogKind } from '../api.js';
import { CatalogList } from '../catalog/CatalogList.js';
import { filterFields, listActions, listColumns, type ListRow, statusParts } from '../catalog/list.js';
import type { CatalogSearch } from '../catalog/params.js';
import { type RefItem, refItemsOf } from '../fields/model.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { catalogListQuery } from '../queries.js';
import { Icon } from '../shell/icons.js';
import { PageHeader } from '../shell/PageHeader.js';
import { NotFound } from '../shell/Shell.js';
import { cjk } from '../typography.js';
import { canEdit, usePack, useViewer } from '../viewer.js';

const CatalogDrawer = lazy(() => import('./CatalogDrawer.js').then((m) => ({ default: m.CatalogDrawer })));
const CsvImport = lazy(() => import('./CsvImport.js').then((m) => ({ default: m.CsvImport })));

/** 旧抽屉和旧导入弹窗认得的 kind（有共用 schema 的）。别的行业包的实体（走查用的假包）等第 10、12 步 */
const legacyKind = (kind: string): kind is CatalogKind => Object.hasOwn(CATALOG_SCHEMAS, kind);

/** 列表里引用列、引用筛选要的目标实体（写被引用条目的名称）；没有引用列时不多取 */
function useRefItems(pack: IndustryPack, entity: EntityType, anon: boolean): (kind: string) => readonly RefItem[] | undefined {
  const fields = [...listColumns(entity, anon).flatMap((c) => (c.kind === 'field' ? [c.field] : [])), ...filterFields(entity)];
  const kinds = [...new Set(fields.flatMap((f) => (f.type === 'reference' && f.to ? [f.to] : [])))];
  const lists = useQueries({ queries: kinds.map((k) => catalogListQuery(catalogKind(k))) });
  return (kind) => {
    const i = kinds.indexOf(kind);
    const target = pack.entities.find((e) => e.kind === kind);
    const items = i < 0 ? undefined : lists[i]?.data?.items;
    return target && items ? refItemsOf(target, items) : undefined;
  };
}

function EntityList({ pack, entity }: { pack: IndustryPack; entity: EntityType }) {
  const search: CatalogSearch = useSearch({ from: '/catalog/$kind' });
  const navigate = useNavigate({ from: '/catalog/$kind' });
  const viewer = useViewer().data;
  const editable = canEdit(viewer);
  const anon = viewer?.kind === 'anon';
  const qc = useQueryClient();
  const list = useQuery(catalogListQuery(catalogKind(entity.kind)));
  const rows = list.data?.items as unknown as ListRow[] | undefined;
  // 更新列的「今天」、月份条的当前月：打开页面时取一次（走查钉住时钟）
  const [now] = useState(() => Date.now());
  // 旧抽屉只剩「新建」一个入口（第 10.3 步换成新建页）
  const [drawer, setDrawer] = useState(false);
  const refItems = useRefItems(pack, entity, anon);
  // 旧抽屉与旧导入弹窗认得这个 kind 时是它，否则 null
  const legacy = legacyKind(entity.kind) ? entity.kind : null;
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['catalog', entity.kind] });

  const can = listActions(editable, entity);
  const actions: ReactNode = can.create ? (
    <>
      {can.csv &&
        (legacy !== null ? (
          <Suspense fallback={<Button>导入CSV</Button>}>
            <CsvImport kind={legacy} label={entity.label} onDone={refresh} />
          </Suspense>
        ) : (
          <Button>导入CSV</Button>
        ))}
      <PrimaryButton icon={<Icon of={Plus} />} onClick={() => legacy !== null && setDrawer(true)}>
        新建{entity.label}
      </PrimaryButton>
    </>
  ) : null;
  const empty = rows !== undefined && rows.length === 0;
  const status = statusParts(rows);

  // 名称是真正的链接（spec「产品库列表」）：键盘可达，打开这一条的详情页
  const titleLink = (row: ListRow, children: ReactNode): ReactNode => (
    <Link to="/catalog/$kind/$code" params={{ kind: entity.kind, code: row.code }} className="cell-link">
      {children}
    </Link>
  );

  return (
    <>
      <PageHeader
        title={entity.label}
        // 还没取到（加载、出错）时状态句先占一行：取到以后页签、工具条、表格不往下跳（spec「不跳动」）
        status={
          status ? <span>{cjk(status)}</span> : rows === undefined ? <span className="page-status-pending" aria-hidden="true" /> : undefined
        }
        // 从来没有过条目时，新建与导入放在空状态里，页头不再放一份
        actions={empty ? undefined : actions}
      />
      <CatalogList
        entity={entity}
        rows={rows}
        error={list.error}
        onRetry={() => void list.refetch()}
        anon={anon}
        search={search}
        onSearch={(next, replace) => void navigate({ search: next, replace })}
        now={now}
        titleLink={titleLink}
        refItems={refItems}
        itemLink={(kind, code, children) => (
          <Link to="/catalog/$kind/$code" params={{ kind, code }} className="field-ref-link">
            {children}
          </Link>
        )}
        emptyActions={actions}
      />
      <Suspense fallback={null}>
        {drawer && legacy !== null && (
          <CatalogDrawer
            kind={legacy}
            label={entity.label}
            row={null}
            editable={editable}
            onClose={() => setDrawer(false)}
            // 建好以后打开它的详情页，接着看、接着改
            onSaved={async (item) => {
              setDrawer(false);
              await refresh();
              await navigate({ to: '/catalog/$kind/$code', params: { kind: entity.kind, code: item.code } });
            }}
          />
        )}
      </Suspense>
    </>
  );
}

export function CatalogPage() {
  const { kind } = useParams({ from: '/catalog/$kind' });
  const pack = usePack();
  const entity = pack?.entities.find((e) => e.kind === kind);
  if (!pack) return null;
  if (!entity) return <NotFound />;
  // 换了实体（线路 → 酒店）重新挂载：搜索框、页码、打开的抽屉都不带过去
  return <EntityList key={entity.kind} pack={pack} entity={entity} />;
}
