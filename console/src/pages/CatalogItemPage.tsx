// 产品库的一条（/catalog/$kind/$code）与新建（/catalog/new/$kind），plan 第 10.1–10.3 步。kind 按当前租户的行业包取，
// 包里没有的是「没有这个页面」；条目取 GET /catalog/:kind/:code（匿名得到线上快照里的那一条），各种状态照 spec 状态表：
// 加载是两栏骨架；不存在写「没有这条{实体名}」加「回到{实体名}列表」；出错就地写「没取到」加重试。
// 页面本身在 catalog/CatalogDetail.tsx；这里给它字段渲染器要的外部数据（引用候选、文字联想、引用名称的链接），
// 地址上的页签（tab，匿名默认「预览」），和几个请求：PATCH 补丁（存好以后放进缓存，列表失效）、409 之后重取这一条、
// 上架（activate）、复制为新草稿与新建（POST /catalog/:kind，建好以后去新草稿的详情，那一页焦点在标题上、读屏念一句）
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import type { CatalogItem } from '../../../src/shared/console-api.js';
import { ERROR_COPY } from '../../../src/shared/ui-labels.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { api, catalogKind, HttpError, unwrap } from '../api.js';
import { Breadcrumb, CatalogDetail, type DetailItem, DetailSkeleton, type PatchBody } from '../catalog/CatalogDetail.js';
import { type ItemTab, tabOf, tabSearch } from '../catalog/actions.js';
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

/**
 * 刚建好、刚复制出来的一条：页面随后去它的详情，那一页打开时念这一句、焦点放在标题上（CatalogDetail 的 arrival）。
 * 只用一次：取过就清掉，后退、再打开同一条都不再念
 */
let arrivalFor: { kind: string; code: string; text: string } | null = null;
function takeArrival(kind: string, code: string): string | undefined {
  const a = arrivalFor;
  if (a?.kind !== kind || a.code !== code) return undefined;
  arrivalFor = null;
  return a.text;
}

/**
 * 字段渲染器的外部数据：引用字段指向的实体取列表当候选（和列表页、侧栏共用缓存），本实体的列表给文字联想，
 * 引用的名称链到那一条的详情，实体名给联想的分组标题（「酒店库 · 贵州」）
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
    entityLabel: (kind) => pack.entities.find((e) => e.kind === kind)?.label,
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
      level={1}
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
  const anon = viewer?.kind === 'anon';
  const search = useSearch({ from: '/catalog/$kind/$code' });
  const navigate = useNavigate({ from: '/catalog/$kind/$code' });
  const own = useQuery(catalogListQuery(kind));
  const [arrival] = useState(() => takeArrival(entity.kind, code));
  /** 存好、上架的条目放进这一条的缓存，列表（名称、状态、更新时间、联想）重新取 */
  const keep = (item: CatalogItem): DetailItem => {
    qc.setQueryData(catalogItemQuery(kind, code).queryKey, item);
    void qc.invalidateQueries({ queryKey: catalogListQuery(kind).queryKey, exact: true });
    return item as unknown as DetailItem;
  };
  const save = async (body: PatchBody): Promise<DetailItem> =>
    keep(await unwrap(api.catalog[':kind'][':code'].$patch({ param: { kind, code }, json: body })));
  /** 409 之后载入最新版本：不看缓存，重取 */
  const loadLatest = async (): Promise<DetailItem> =>
    (await qc.fetchQuery({ ...catalogItemQuery(kind, code), staleTime: 0 })) as unknown as DetailItem;
  const activate = async (rev: number): Promise<DetailItem> =>
    keep(await unwrap(api.catalog[':kind'][':code'].activate.$post({ param: { kind, code }, json: { rev } })));
  /**
   * 复制为新草稿：建好以后去它的详情。有没保存的改动时，详情页在建之前已经问过要不要离开（答「留下」就不建），
   * 所以这里跳过离开保护：建好了再拦，「留下」以后新草稿已经在库里，页面上却什么也没说
   */
  const copy = async (_code: string, payload: Payload): Promise<void> => {
    const item = await unwrap(api.catalog[':kind'].$post({ param: { kind }, json: { payload } }));
    qc.setQueryData(catalogItemQuery(kind, item.code).queryKey, item);
    void qc.invalidateQueries({ queryKey: catalogListQuery(kind).queryKey, exact: true });
    arrivalFor = { kind: entity.kind, code: item.code, text: '已复制为新草稿' };
    void navigate({ to: '/catalog/$kind/$code', params: { kind: entity.kind, code: item.code }, search: {}, ignoreBlocker: true });
  };
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
  const editable = canEdit(viewer);
  return (
    <FieldEnvContext.Provider value={env}>
      <CatalogDetail
        groupName={pack.nav.catalogGroup}
        entity={entity}
        item={q.data as unknown as DetailItem}
        canEdit={editable}
        anon={anon}
        now={now}
        onSave={editable ? save : undefined}
        onLoadLatest={loadLatest}
        onActivate={editable ? activate : undefined}
        onCopy={editable ? copy : undefined}
        codes={own.data?.items.map((i) => i.code)}
        // 页签记一步浏览历史（与列表页的页签一样）；默认的那一个不写进地址
        tab={tabOf(search, anon)}
        onTab={(t: ItemTab) => void navigate({ search: tabSearch(t, anon) })}
        arrival={arrival}
      />
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

/**
 * 新建（spec「新建」）：空表单，编号可以填。只给能编辑的人；别人打开这个地址写「你的角色无法执行这项操作」。
 * 保存即建草稿：建好以后换成它的详情页（replace：后退不回到这张空表单），表单里的内容已经存上，不经离开保护
 */
function NewItem({ pack, entity }: { pack: IndustryPack; entity: EntityType }) {
  const viewer = useViewer().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [now] = useState(() => Date.now());
  const env = useDetailEnv(pack, entity, now);
  const kind = catalogKind(entity.kind);
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
  const create = async (payload: Payload): Promise<DetailItem> => {
    const item = await unwrap(api.catalog[':kind'].$post({ param: { kind }, json: { payload } }));
    qc.setQueryData(catalogItemQuery(kind, item.code).queryKey, item);
    void qc.invalidateQueries({ queryKey: catalogListQuery(kind).queryKey, exact: true });
    arrivalFor = { kind: entity.kind, code: item.code, text: '已建草稿' };
    void navigate({
      to: '/catalog/$kind/$code',
      params: { kind: entity.kind, code: item.code },
      replace: true,
      ignoreBlocker: true,
    });
    return item as unknown as DetailItem;
  };
  return (
    <FieldEnvContext.Provider value={env}>
      <CatalogDetail groupName={pack.nav.catalogGroup} entity={entity} item={null} canEdit anon={false} now={now} onCreate={create} />
    </FieldEnvContext.Provider>
  );
}

export function CatalogNewPage() {
  const { kind } = useParams({ from: '/catalog/new/$kind' });
  return <EntityGate kind={kind} render={(pack, entity) => <NewItem key={entity.kind} pack={pack} entity={entity} />} />;
}
