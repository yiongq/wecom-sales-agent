// 产品库的一条（/catalog/$kind/$code）与新建（/catalog/new/$kind），plan 第 10.1 步。kind 按当前租户的行业包取，
// 包里没有的是「没有这个页面」；条目取 GET /catalog/:kind/:code（匿名得到线上快照里的那一条），各种状态照 spec 状态表：
// 加载是两栏骨架；不存在写「没有这条{实体名}」加「回到{实体名}列表」；出错就地写「没取到」加重试。
// 页面本身在 catalog/CatalogDetail.tsx；这里给它字段渲染器要的外部数据：引用候选、文字联想、引用名称的链接
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { ERROR_COPY } from '../../../src/shared/ui-labels.js';
import type { EntityType, IndustryPack } from '../../../src/shared/pack.js';
import { catalogKind, HttpError } from '../api.js';
import { Breadcrumb, CatalogDetail, type DetailItem, DetailSkeleton } from '../catalog/CatalogDetail.js';
import { distinctValues, referencedKinds } from '../catalog/detail.js';
import { type FieldEnv, FieldEnvContext } from '../fields/env.js';
import { refItemsOf } from '../fields/model.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { catalogItemQuery, catalogListQuery } from '../queries.js';
import { useDocumentTitle } from '../shell/hooks.js';
import { documentTitle } from '../shell/model.js';
import { PageHeader, shellViewerOf } from '../shell/PageHeader.js';
import { NotFound } from '../shell/Shell.js';
import { canEdit, usePack, useViewer } from '../viewer.js';

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
  const q = useQuery(catalogItemQuery(catalogKind(entity.kind), code));
  // 「今天10:12」、月份条的当前月：打开页面时取一次（走查钉住时钟）
  const [now] = useState(() => Date.now());
  const env = useDetailEnv(pack, entity, now);
  if (q.error instanceof HttpError && q.error.status === 404) return <ItemNotFound entity={entity} />;
  if (q.error) {
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
        groupName={pack.nav.catalogGroup}
        entity={entity}
        item={q.data as unknown as DetailItem}
        canEdit={canEdit(viewer)}
        anon={viewer?.kind === 'anon'}
        now={now}
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
