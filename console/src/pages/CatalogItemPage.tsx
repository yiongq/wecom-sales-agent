// 产品库的一条（/catalog/$kind/$code）与新建（/catalog/new/$kind），plan 第 10.1、10.2 步。kind 按当前租户的行业包取，
// 包里没有的是「没有这个页面」；条目取 GET /catalog/:kind/:code（匿名得到线上快照里的那一条），各种状态照 spec 状态表：
// 加载是两栏骨架；不存在写「没有这条{实体名}」加「回到{实体名}列表」；出错就地写「没取到」加重试。
// 页面本身在 catalog/CatalogDetail.tsx；这里给它字段渲染器要的外部数据（引用候选、文字联想、引用名称的链接），
// 和保存要的两个请求：PATCH 补丁（存好以后放进缓存，列表失效）、409 之后重取这一条。
// 第 10.3 步的上架确认到之前，草稿由这里打开 01 旧抽屉（带着详情页上的改动）去上架，按需下载
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { ERROR_COPY } from '../../../src/shared/ui-labels.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { api, catalogKind, HttpError, unwrap } from '../api.js';
import { legacyKind } from '../catalogForm.js';
import { Breadcrumb, CatalogDetail, type DetailItem, DetailSkeleton, type PatchBody } from '../catalog/CatalogDetail.js';
import { distinctValues, referencedKinds } from '../catalog/detail.js';
import { type FieldEnv, FieldEnvContext } from '../fields/env.js';
import { type Payload, refItemsOf } from '../fields/model.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { catalogItemQuery, catalogListQuery } from '../queries.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { documentTitle } from '../shell/model.js';
import { PageHeader, shellViewerOf } from '../shell/PageHeader.js';
import { NotFound } from '../shell/Shell.js';
import { canEdit, usePack, useViewer } from '../viewer.js';
import type { Row } from './CatalogDrawer.js';

const CatalogDrawer = lazy(() => import('./CatalogDrawer.js').then((m) => ({ default: m.CatalogDrawer })));

/**
 * 字段渲染器的外部数据：引用字段指向的实体取列表当候选（和列表页、侧栏共用缓存），本实体的列表给文字联想，
 * 引用的名称链到那一条的详情
 */
function useDetailEnv(pack: IndustryPack, entity: EntityType, now: number): FieldEnv {
  const kinds = referencedKinds(entity);
  const own = useQuery(catalogListQuery(catalogKind(entity.kind)));
  const lists = useQueries({ queries: kinds.map((k) => catalogListQuery(catalogKind(k))) });
  return {
    now,
    refItems: (kind) => {
      const target = pack.entities.find((e) => e.kind === kind);
      const items = lists[kinds.indexOf(kind)]?.data?.items;
      return target && items ? refItemsOf(target, items) : undefined;
    },
    distinct: (key) => distinctValues(own.data?.items, key),
    itemLink: (kind, code, children) => (
      <Link to="/catalog/$kind/$code" params={{ kind, code }} className="field-ref-link">
        {children}
      </Link>
    ),
  };
}

/** 行业包里有这个实体才往下画，没有的是「没有这个页面」（不拿包里的第一个实体顶上） */
function EntityGate({ kind, render }: { kind: string; render: (pack: IndustryPack, entity: EntityType) => ReactNode }) {
  const pack = usePack();
  const entity = pack?.entities.find((e) => e.kind === kind);
  if (!pack) return null;
  if (!entity) return <NotFound />;
  return <>{render(pack, entity)}</>;
}

/** 没有这一条（404，或匿名打开草稿）：「没有这条线路」加「回到线路列表」 */
function ItemNotFound({ entity }: { entity: EntityType }) {
  const viewer = shellViewerOf(useViewer().data);
  const title = `没有这条${entity.label}`;
  useDocumentTitle(viewer ? documentTitle([title], viewer) : title);
  return (
    <EmptyBlock
      title={title}
      description="可能已被删除或地址写错了"
      link={
        <Link to="/catalog/$kind" params={{ kind: catalogKind(entity.kind) }}>
          {`回到${entity.label}列表`}
        </Link>
      }
    />
  );
}

function ItemLoader({ pack, entity, code }: { pack: IndustryPack; entity: EntityType; code: string }) {
  const viewer = useViewer().data;
  const qc = useQueryClient();
  const q = useQuery(catalogItemQuery(catalogKind(entity.kind), code));
  // 「今天10:12」、月份条的当前月：打开页面时取一次（走查钉住时钟）
  const [now] = useState(() => Date.now());
  const env = useDetailEnv(pack, entity, now);
  const kind = catalogKind(entity.kind);
  /** 保存：存好的条目放进这一条的缓存，列表（名称、更新时间、联想）重新取 */
  const save = async (body: PatchBody): Promise<DetailItem> => {
    const item = await unwrap(api.catalog[':kind'][':code'].$patch({ param: { kind, code }, json: body }));
    qc.setQueryData(catalogItemQuery(kind, code).queryKey, item);
    void qc.invalidateQueries({ queryKey: catalogListQuery(kind).queryKey, exact: true });
    return item as unknown as DetailItem;
  };
  /** 409 之后载入最新版本：不看缓存，重取 */
  const loadLatest = async (): Promise<DetailItem> =>
    (await qc.fetchQuery({ ...catalogItemQuery(kind, code), staleTime: 0 })) as unknown as DetailItem;
  // 过渡（第 10.3 步删）：旧抽屉开着时是交给它的表单内容和眼下的条目；在旧抽屉里存好、上架以后 reloads 加一，
  // 详情页按新内容重新打开
  const [legacyOpen, setLegacyOpen] = useState<{ draft: Payload; row: Row } | null>(null);
  const [reloads, setReloads] = useState(0);
  const legacy = legacyKind(entity.kind) ? entity.kind : null;
  // 整页的 404 与出错态只给还没取到这一条的时候。打开着、正在改时重取失败（「载入最新版本」连不上）查询也会带上错误，
  // 这时照旧画详情页：失败由它就地显示、可以重试，没保存的改动还在
  if (!q.data && q.error instanceof HttpError && q.error.status === 404) return <ItemNotFound entity={entity} />;
  if (!q.data && q.error) {
    return (
      <>
        <PageHeader
          title={code}
          docTitle={[code, entity.label]}
          breadcrumb={<Breadcrumb group={pack.nav.catalogGroup} entity={entity} current={code} />}
        />
        <StateView error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  if (!q.data) return <StateView pending skeleton={<DetailSkeleton entity={entity} />} />;
  return (
    <FieldEnvContext.Provider value={env}>
      <CatalogDetail
        key={reloads}
        groupName={pack.nav.catalogGroup}
        entity={entity}
        item={q.data as unknown as DetailItem}
        canEdit={canEdit(viewer)}
        anon={viewer?.kind === 'anon'}
        now={now}
        onSave={canEdit(viewer) ? save : undefined}
        onLoadLatest={loadLatest}
        // opened 就是接口给的那一条（DetailItem 只写了详情页用到的字段），带着 kind 与 rev
        onLegacyEdit={legacy === null ? undefined : (draft, opened) => setLegacyOpen({ draft, row: opened as unknown as Row })}
      />
      <Suspense fallback={null}>
        {legacyOpen && legacy !== null && (
          <CatalogDrawer
            kind={legacy}
            label={entity.label}
            row={legacyOpen.row}
            draft={legacyOpen.draft}
            editable={canEdit(viewer)}
            onClose={() => setLegacyOpen(null)}
            onSaved={async () => {
              setLegacyOpen(null);
              await qc.invalidateQueries({ queryKey: ['catalog', entity.kind] });
              setReloads((n) => n + 1);
            }}
          />
        )}
      </Suspense>
    </FieldEnvContext.Provider>
  );
}

export function CatalogItemPage() {
  const { kind, code } = useParams({ from: '/catalog/$kind/$code' });
  // 换一条（⌘K、引用链接）重新挂载：表单状态、改动与打开时的内容都不带过去
  return (
    <EntityGate
      kind={kind}
      render={(pack, entity) => <ItemLoader key={`${entity.kind}:${code}`} pack={pack} entity={entity} code={code} />}
    />
  );
}

/** 新建（spec「新建」）：空表单，编号可以填。只给能编辑的人；别人打开这个地址写「你的角色无法执行这项操作」 */
function NewItem({ pack, entity }: { pack: IndustryPack; entity: EntityType }) {
  const viewer = useViewer().data;
  const [now] = useState(() => Date.now());
  const env = useDetailEnv(pack, entity, now);
  if (!canEdit(viewer)) {
    const copy = ERROR_COPY.forbidden!;
    return (
      <>
        <PageHeader
          title={`新建${entity.label}`}
          breadcrumb={<Breadcrumb group={pack.nav.catalogGroup} entity={entity} current={`新建${entity.label}`} />}
        />
        <EmptyBlock
          title={copy.title as string}
          description={copy.next ?? undefined}
          link={
            <Link to="/catalog/$kind" params={{ kind: catalogKind(entity.kind) }}>
              {`回到${entity.label}列表`}
            </Link>
          }
        />
      </>
    );
  }
  return (
    <FieldEnvContext.Provider value={env}>
      <CatalogDetail groupName={pack.nav.catalogGroup} entity={entity} item={null} canEdit anon={false} now={now} />
    </FieldEnvContext.Provider>
  );
}

export function CatalogNewPage() {
  const { kind } = useParams({ from: '/catalog/new/$kind' });
  return <EntityGate kind={kind} render={(pack, entity) => <NewItem key={entity.kind} pack={pack} entity={entity} />} />;
}
