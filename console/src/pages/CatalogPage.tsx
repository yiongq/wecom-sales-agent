// 产品库列表页（spec「产品库列表（D 页；L 页上半）」，plan 第 9 步）。路由 /catalog/$kind 的 kind 按当前租户的行业包取，
// 包里没有的 kind 是「没有这个页面」。页头：实体名；状态句「共21条 · 销售助手只推荐已上架的」；编辑角色有「新建{实体名}」，
// csvImport 为 true 的实体另有「导入CSV」（不能导入的不渲染这个入口，也不放灰按钮）；非编辑成员和匿名都没有这两个入口。
// 页签、工具条、表格与各种状态在 catalog/CatalogList.tsx，页签、搜索、筛选都写进地址（catalog/params.ts）。
// 名称是链到详情页（/catalog/$kind/$code，第 10.1 步）的链接，「新建」去新建页（/catalog/new/$kind，第 10.3 步），
// 任何行业包的实体都一样。「导入CSV」打开按行业包渲染的导入弹窗（catalog/CsvImportDialog.tsx，第 12 步），
// 第一次点时才下载它的块（CSV 的解析与预检都在里面，spec「性能」）
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Button } from 'antd';
import { FileUp, Plus } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useRef, useState } from 'react';
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

const CsvImportDialog = lazy(() => import('../catalog/CsvImportDialog.js').then((m) => ({ default: m.CsvImportDialog })));

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
  const refItems = useRefItems(pack, entity, anon);
  // 导入弹窗：第一次点「导入CSV」才挂上（才下载它的块）；关上以后留着挂载（关的动画照常），下次打开不再等。
  // 每次打开换一个 key，从第1步重新来
  const [csv, setCsv] = useState({ round: 0, open: false });
  // 关上以后焦点回到「导入CSV」。antd 还给打开它的那个按钮，但从空状态导入的，建好以后空状态卸了、那个按钮不在了，
  // 焦点会掉到 body；这时页头已经有了一份。导入按钮同一时刻只挂一份，ref 指着挂着的那份
  const importButton = useRef<HTMLButtonElement>(null);
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['catalog', entity.kind] });

  const can = listActions(editable, entity);
  const actions: ReactNode = can.create ? (
    <>
      {can.csv && (
        <Button ref={importButton} icon={<Icon of={FileUp} />} onClick={() => setCsv((c) => ({ round: c.round + 1, open: true }))}>
          导入CSV
        </Button>
      )}
      <PrimaryButton icon={<Icon of={Plus} />} onClick={() => void navigate({ to: '/catalog/new/$kind', params: { kind: entity.kind } })}>
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
      {csv.round ? (
        <Suspense fallback={null}>
          <CsvImportDialog
            key={csv.round}
            open={csv.open}
            pack={pack}
            entity={entity}
            existing={rows}
            onClose={() => setCsv((c) => ({ ...c, open: false }))}
            onImported={() => void refresh()}
            onShowDrafts={() => {
              setCsv((c) => ({ ...c, open: false }));
              // 新建的草稿都在草稿页签：搜索与筛选一并清掉，免得把它们筛走
              void navigate({ search: { status: 'draft' } });
            }}
            afterClose={() => importButton.current?.focus()}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export function CatalogPage() {
  const { kind } = useParams({ from: '/catalog/$kind' });
  const pack = usePack();
  const entity = pack?.entities.find((e) => e.kind === kind);
  if (!pack) return null;
  if (!entity) return <NotFound />;
  // 换了实体（线路 → 酒店）重新挂载：搜索框、页码都不带过去
  return <EntityList key={entity.kind} pack={pack} entity={entity} />;
}
