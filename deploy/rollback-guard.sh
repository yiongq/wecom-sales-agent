#!/usr/bin/env bash
# 回滚前检查（02、03「导入、导出与切换」、04 R14）。在服务器上跑：deploy.sh 部署一个旧 tag、
# 以及健康检查失败后自动回滚到 :prev 之前，经 ssh 把本脚本交给 bash -s。
# 本脚本经 bash -s 从标准输入读，所有外部命令必须 </dev/null（管道下游只读管道），不能读走后续脚本。
# 01 的镜像不认识 SESSION_STORE、不读库里的会话：真实会话在库里时（var/ 里有 sessions-in-db.json，或 .env 里是
# SESSION_STORE=db）回滚到它，客户历史在应用里全部消失，那期间的新消息也不进库。01 的镜像也不写产品库条目版本：
# 正在运行的实例有条目版本大于 1（/healthz 的 config.catalogVersioned 为 true）时回滚到它，那期间发出的方案书链接不带 v、
# 按当时的内容渲染，回到 02 之后被当成版本 1、显示旧价。所以目标是 02 之前的镜像（镜像里没有 src/store/pg-backend.ts）
# 而有这些风险时拒绝；两个都是 02 之后的镜像时照常回滚。会话在库里可以先回到文件存储再回滚（打印步骤），条目版本回到
# 文件存储也去不掉，只能回到 02 之后的镜像。
# 条目版本先问 /healthz；取不到、或里面没有这个字段时（自动回滚时跑着的是没过健康检查的新容器；跑着的是 01，没有这个字段）
# 直接问库：catalog_item_versions 有没有版本大于 1 的行，这张表还不存在就是 02 之前的库、没有这条风险。库也问不到时，
# 正在跑的容器本身是 02 之前的镜像就不算（这次回滚不会让条目版本更失真），否则按有风险处理。
# 03 之前的镜像不认识库里的渠道状态：标记在、或库里有默认企微 exported 账号以外的行时拒绝，先用当前镜像
# channel-export。库问不到时，仅正在跑的镜像明确没有 registry.ts 才不算风险。两个 03 之后的镜像之间照常回滚。
# 04 之前的镜像不认识模板品牌：所有租户待生效品牌或当前发布快照任一非空就拒绝；发布快照带品牌才需重启重渲染。
# 库问不到时，仅正在跑的镜像明确没有 pack-api.ts 才不算品牌风险。
#
# 用法：rollback-guard.sh <部署目录> <目标> [<compose 项目名> [<宿主端口>]]
#   <目标> 是镜像名（如 wecom-sales-agent:prev）：自动回滚。看镜像里有没有 /app/src/store/pg-backend.ts；docker 出错、判断不了时按 02 之前算
#   <目标> 是 pre-02：部署旧 tag，调用方已经按 tag 的文件树判定它是 02 之前的（镜像还没建）
#   <目标> 是 pre-03：部署旧 tag，调用方已判定它是 02 之后、03 之前的
#   <目标> 是 pre-04：部署旧 tag，调用方已判定它是 03 之后、04 之前的
#   <目标> 是 pre-08：部署旧 tag，调用方已判定它是 07 之后、08 之前的，只查 08 的风险
# 打印的命令带上项目名与宿主端口（旁路实例的手工命令也要带，见 deploy/compose.yml 开头）。
# 退出码：0 照常回滚；3 拒绝，只有会话在库里（先回到文件存储的步骤打在 stderr）；4 拒绝，有条目版本大于 1 或看不出来
#（只能回到 02 之后的镜像，不打印导出步骤）；5 拒绝，有渠道状态在库里或看不出来（先 channel-export，
# 若目标同时是 02 之前、会话在库里，再回到文件存储）；6 拒绝，有品牌风险，按待生效值与发布快照打印恢复步骤。
# 保留旧风险优先级：4 > 5 > 6 > 3；品牌步骤不因同时有旧风险而省略。
# 07 R20：目标早于 07 且库里有退款状态（或无法确认）时退出 8；旧运行镜像豁免规则同 05。
# 08 R13：目标早于 08 且库里有非旅游数据（或无法确认）时退出 9，先清理并确认四项都为零。
# 05 R18：pre-05 另查其他 standard Host、沙箱容器（含已停）与 .env.sandbox；前三项清掉后才以当前镜像
# sandbox purge --all，并重新问库。拒绝以 7 退出，旧风险优先（品牌仍为 6）；查询失败只豁免明确的旧运行镜像。
set -u
dir="$1" target="$2" project="${3:-wecom-sales-agent}" port="${4:-3210}"
marker="$dir/var/sessions-in-db.json"
channel_marker="$dir/var/channels-in-db.json"
env_file="$dir/.env"
# 与 deploy.sh 第 3 步的检查同一种读法（docker --env-file）：行首空白去掉、按第一个 = 分开、同名以最后一行为准
env_val() {
  [ -f "$2" ] || return 0
  awk -v k="$1=" '{ sub(/^[ \t]+/, ""); sub(/\r$/, "") } index($0, k) == 1 { v = substr($0, length(k) + 1) } END { print v }' "$2" </dev/null
}

# 回滚到 02 之前的镜像有风险的情况，一条一行
risks=()
if [ -f "$marker" ]; then
  risks+=("数据目录里有 var/sessions-in-db.json：真实会话在库里（db 存储）")
fi
# 没经过 import-sessions、直接以 db 存储起的实例，在 02 补写标记文件之前起过的可能没有标记文件
if [ "$(env_val SESSION_STORE "$env_file")" = db ]; then
  risks+=(".env 里是 SESSION_STORE=db：真实会话在库里（db 存储）")
fi
session_risk_count=${#risks[@]}
# 02 之前的镜像里没有 pg-backend.ts：0 是 02 之后的，1 是 02 之前的，其余是 docker 出错、看不出来
pre02_image() { docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/src/store/pg-backend.ts' </dev/null; }
pre03_image() { docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/src/channels/registry.ts' </dev/null; }
pre04_image() { docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/src/core/pack-api.ts' </dev/null; }
pre07_image() { timeout --kill-after=2s 8s docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/drizzle/0015_order_refund_status.sql' </dev/null; }
pre08_image() { timeout --kill-after=2s 8s docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/src/core/order-view.ts' </dev/null; }
pre05_image() { timeout --kill-after=2s 8s docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/src/tenancy/runtime.ts' </dev/null; }
# 所有探测与风险查询共用时限：锁等至多 2 秒、SQL 至多 5 秒；连接或 docker 卡住也在 8 秒后终止，2 秒后强杀。
# PGOPTIONS 传进容器里的 psql，ON_ERROR_STOP 保证 SQL 超时/错误不会被当成成功的空结果。
db_query() {
  local db
  db=$(env_val AGENT_DB "$dir/.env.db")
  db=${db:-agent}
  (cd / && timeout --kill-after=2s 8s docker compose -p "$project" exec -T \
    -e PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=2000' db \
    psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -Atc "$1" </dev/null) 2>/dev/null
}
# 直接问库（与 backup.sh 同一种找法：按项目名找 db 服务，在 / 下执行；超级用户不受 RLS 限制）。打印 t / f / none（表不存在）
db_versioned() {
  local has
  has=$(db_query "select to_regclass('public.catalog_item_versions') is not null") || return 1
  case "$has" in
    f) echo none ;;
    t) db_query "select exists(select 1 from catalog_item_versions where version > 1)" ;;
    *) return 1 ;;
  esac
}
# 全库检查：超级用户跨租户看所有账号，只有默认企微账号且 exported 才能安全回到 env 与文件状态。
# IS NOT TRUE 也把 NULL 前缀算作风险（网页账号的前缀是 NULL）。
db_channels() {
  local has
  has=$(db_query "select to_regclass('public.channel_accounts') is not null") || return 1
  case "$has" in
    f) echo none ;;
    t) db_query "select exists(select 1 from channel_accounts where (kind = 'wecom_kf' and id_prefix = 'wecom:' and status = 'exported') is not true)" ;;
    *) return 1 ;;
  esac
}
# 超级用户跨租户检查；published 是每个租户唯一的当前发布行，历史 archived 与草稿不算。
# 先独立探测两种输入的表与列：空库/旧库缺这一项时没有风险，连接/查询失败仍向上传递。
# 旧快照缺 brand 与 JSON null 都是旧版模式；一项缺失不能跳过另一项。
db_brand() {
  local has pending=f published=f
  has=$(db_query "select to_regclass('public.tenants') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'brand')") || return 1
  case "$has" in
    f) ;;
    t) pending=$(db_query "select exists(select 1 from public.tenants t where coalesce(t.brand::jsonb, 'null'::jsonb) <> 'null'::jsonb)") || return 1 ;;
    *) return 1 ;;
  esac
  # 已查到待生效风险仍查询快照以区分恢复步骤；另一项失败不能让旧镜像豁免冲掉确定的风险。
  case "$pending" in
    t | f) ;;
    *) return 1 ;;
  esac
  has=$(db_query "select to_regclass('public.sop_versions') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sop_versions' and column_name = 'render_inputs')") || has=unknown
  case "$has" in
    f) ;;
    t) published=$(db_query "select exists(select 1 from public.sop_versions where status = 'published' and coalesce(render_inputs->'brand', 'null'::jsonb) <> 'null'::jsonb)") || published=unknown ;;
    *) published=unknown ;;
  esac
  case "$published" in
    t | f) echo "$pending $published" ;;
    *) [ "$pending" = t ] && echo 't unknown' || return 1 ;;
  esac
}
# 有条目版本大于 1（02「报价快照」）：先问正在运行的实例，看不出来再问库，库也问不到再看正在跑的是不是 02 之前的镜像
catalog_risk=""
health=$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/healthz" </dev/null 2>/dev/null)
case "$health" in
  *'"catalogVersioned":false'*) ;;
  *'"catalogVersioned":true'*) catalog_risk="正在运行的实例 /healthz 的 config.catalogVersioned 为 true：有条目版本大于 1（改过上架条目的价格或内容）" ;;
  *)
    versioned=$(db_versioned) || versioned=""
    case "$versioned" in
      f | none) ;;
      t) catalog_risk="取不到 127.0.0.1:${port}/healthz 的 config.catalogVersioned，库里的 catalog_item_versions 有版本大于 1 的条目（改过上架条目的价格或内容）" ;;
      *)
        running=$(docker inspect --format '{{.Image}}' "$project" </dev/null 2>/dev/null)
        if [ -z "$running" ] || [ "$(pre02_image "$running" >/dev/null 2>&1; echo $?)" != 1 ]; then
          catalog_risk="取不到 127.0.0.1:${port}/healthz 的 config.catalogVersioned，也问不到库，看不出有没有条目版本大于 1，按有风险处理"
        fi
        ;;
    esac
    ;;
esac
[ -n "$catalog_risk" ] && risks+=("$catalog_risk")
is_pre02=0
case "$target" in
  pre-02) is_pre02=1 ;;
  pre-03 | pre-04 | pre-05 | pre-07 | pre-08) ;;
  *)
    if [ ${#risks[@]} -gt 0 ]; then
      pre02_image "$target" >/dev/null 2>&1
      case $? in
        0) ;;
        1) is_pre02=1 ;;
        *) is_pre02=1; echo "rollback-guard: 看不出 ${target} 是不是 02 之前的镜像（docker 出错），按 02 之前处理" >&2 ;;
      esac
    fi
    ;;
esac
if [ "$is_pre02" = 0 ]; then
  risks=()
  catalog_risk=""
  session_risk_count=0
fi
is_pre03=1
if [ "$target" = pre-04 ] || [ "$target" = pre-05 ] || [ "$target" = pre-07 ] || [ "$target" = pre-08 ]; then
  is_pre03=0
elif [ "$is_pre02" = 0 ] && [ "$target" != pre-03 ]; then
  pre03_image "$target" >/dev/null 2>&1
  case $? in
    0) is_pre03=0 ;;
    1) ;;
    *) echo "rollback-guard: 看不出 ${target} 是不是 03 之前的镜像（docker 出错），按 03 之前处理" >&2 ;;
  esac
fi
channel_risk=""
if [ "$is_pre03" = 1 ]; then
  if [ -f "$channel_marker" ]; then
    channel_risk="数据目录里有 var/channels-in-db.json：渠道状态在库里"
  elif [ -z "$catalog_risk" ]; then
    channels=$(db_channels) || channels=""
    case "$channels" in
      f | none) ;;
      t) channel_risk="库里的 channel_accounts 有不是默认企微账号且 exported 的行：渠道状态在库里（active、disabled、第二个企微账号与网页账号都算）" ;;
      *)
        running=$(docker inspect --format '{{.Image}}' "$project" </dev/null 2>/dev/null)
        if [ -z "$running" ] || [ "$(pre03_image "$running" >/dev/null 2>&1; echo $?)" != 1 ]; then
          channel_risk="问不到库，看不出渠道状态是否在库里，按有风险处理"
        fi
        ;;
    esac
  fi
fi
[ -n "$channel_risk" ] && risks+=("$channel_risk")
is_pre04=1
if [ "$target" = pre-05 ] || [ "$target" = pre-07 ] || [ "$target" = pre-08 ]; then
  is_pre04=0
elif [ "$is_pre03" = 0 ] && [ "$target" != pre-04 ]; then
  pre04_image "$target" >/dev/null 2>&1
  case $? in
    0) is_pre04=0 ;;
    1) ;;
    *) echo "rollback-guard: 看不出 ${target} 是不是 04 之前的镜像（docker 出错），按 04 之前处理" >&2 ;;
  esac
fi
brand_risk="" brand_pending=unknown brand_published=unknown
if [ "$is_pre04" = 1 ]; then
  brand=$(db_brand) || brand=""
  case "$brand" in
    'f f') ;;
    't f') brand_pending=t; brand_published=f; brand_risk="库里有租户的 tenants.brand 不为空；当前发布版本没有品牌快照" ;;
    'f t') brand_pending=f; brand_published=t; brand_risk="所有租户待生效品牌已为空；当前发布版本的 render_inputs.brand 仍带品牌快照（clear 但未重启）" ;;
    't t') brand_pending=t; brand_published=t; brand_risk="库里有租户的 tenants.brand 不为空，且当前发布版本的 render_inputs.brand 带品牌快照" ;;
    't unknown') brand_pending=t; brand_risk="库里有租户的 tenants.brand 不为空；问不到库里的当前发布品牌快照，按有品牌风险处理" ;;
    *)
      running=$(docker inspect --format '{{.Image}}' "$project" </dev/null 2>/dev/null)
      if [ -z "$running" ] || [ "$(pre04_image "$running" >/dev/null 2>&1; echo $?)" != 1 ]; then
        brand_risk="问不到库，看不出待生效品牌与当前发布品牌快照，按有品牌风险处理"
      fi
      ;;
  esac
fi
[ -n "$brand_risk" ] && risks+=("$brand_risk")
# 不在旧风险拒绝前执行 purge：品牌风险与沙箱风险同时存在时先报 6，且没有删除副作用。
is_pre05=1
case "$target" in
  pre-02 | pre-03 | pre-04 | pre-05) ;;
  pre-07 | pre-08) is_pre05=0 ;;
  *) pre05_image "$target" >/dev/null 2>&1; [ $? = 0 ] && is_pre05=0 ;;
esac
# 07 R20：先只读检查退款状态，避免拒绝前执行沙箱 purge。
is_pre07=1
case "$target" in
  pre-02 | pre-03 | pre-04 | pre-05 | pre-07) ;;
  pre-08) is_pre07=0 ;;
  *) pre07_image "$target" >/dev/null 2>&1; [ $? = 0 ] && is_pre07=0 ;;
esac
if [ "$is_pre07" = 1 ] && [ ${#risks[@]} -eq 0 ]; then
  refund=unknown
  has=$(db_query "select to_regclass('public.orders') is not null") || has=unknown
  case "$has" in
    f) refund=f ;;
    t) refund=$(db_query "select exists(select 1 from public.orders where status in ('refund_pending', 'refunded'))") || refund=unknown ;;
  esac
  case "$refund" in
    f) ;;
    t) ;;
    *)
      running=$(docker inspect --format '{{.Image}}' "$project" </dev/null 2>/dev/null)
      if [ -n "$running" ] && [ "$(pre07_image "$running" >/dev/null 2>&1; echo $?)" = 1 ]; then
        refund=f
      fi ;;
  esac
  if [ "$refund" != f ]; then
    echo "拒绝回滚：目标是 07 之前的镜像，库里有退款订单或查询结果无法确认。" >&2
    echo "先在后台把退款中的订单办完或驳回；旧镜像会把退款中、已退款的单当成待付款显示在支付页上，成交统计也会漏算，确认能接受再回滚" >&2
    [ "$refund" = t ] || echo "库问不到时从严拒绝；先确认 db 与查询结果，再重跑检查。" >&2
    exit 8
  fi
fi
# 08 R13：四项独立只读检查，不能在拒绝前执行沙箱 purge；保留 02–07 的旧风险优先级。
is_pre08=1
case "$target" in
  pre-02 | pre-03 | pre-04 | pre-05 | pre-06 | pre-07 | pre-08) ;;
  *) if pre08_image "$target" >/dev/null 2>&1; then is_pre08=0; fi ;;
esac
if [ "$is_pre08" = 1 ] && [ ${#risks[@]} -eq 0 ]; then
  nontravel_tables=(tenants orders catalog_items kb_chunks)
  nontravel_predicates=("pack_id <> 'travel'" "data->>'v' = '2'" "kind not in ('route','hotel')" "source <> 'route'")
  nontravel_labels=("非旅游租户（tenants.pack_id <> 'travel'）" "通用单（orders.data->>'v' = '2'）" "非旅游条目（catalog_items.kind 不在 route / hotel）" "非旅游知识块（kb_chunks.source <> 'route'）")
  nontravel_states=() nontravel_counts=()
  nontravel_risk=0 nontravel_unknown=0
  for i in 0 1 2 3; do
    table="${nontravel_tables[$i]}" predicate="${nontravel_predicates[$i]}"
    has=t
    if [ "$table" = kb_chunks ]; then
      has=$(db_query "select to_regclass('public.kb_chunks') is not null") || has=unknown
    fi
    state=unknown count=无法确认
    case "$has" in
      f) state=f ;;
      t) state=$(db_query "select exists(select 1 from public.${table} where ${predicate})") || state=unknown ;;
    esac
    case "$state" in
      f) count=0 ;;
      t)
        nontravel_risk=1
        count=$(db_query "select count(*) from public.${table} where ${predicate}") || count=无法确认
        [[ "$count" =~ ^[0-9]+$ ]] || count=无法确认 ;;
      *) state=unknown; nontravel_unknown=1 ;;
    esac
    nontravel_states+=("$state") nontravel_counts+=("$count")
  done
  if [ "$nontravel_unknown" = 1 ]; then
    running=$(docker inspect --format '{{.Image}}' "$project" </dev/null 2>/dev/null)
    if [ -z "$running" ] || [ "$(pre08_image "$running" >/dev/null 2>&1; echo $?)" != 1 ]; then
      nontravel_risk=1
    fi
  fi
  if [ "$nontravel_risk" = 1 ]; then
    echo "拒绝回滚：目标是 08 之前的镜像，不认识非旅游数据；库里存在以下风险或查询结果无法确认：" >&2
    for i in 0 1 2 3; do
      echo "  - ${nontravel_labels[$i]}：${nontravel_counts[$i]}" >&2
      [ "${nontravel_states[$i]}" != t ] || echo "    已确认存在，旧镜像不支持。" >&2
    done
    echo "先停用并清理非旅游租户，清理遗留的通用单、非旅游条目与非旅游知识块；确认上述四项都为零后再回滚。" >&2
    [ "$nontravel_unknown" = 0 ] || echo "库问不到或查询结果无法确认时从严拒绝；先确认 db 与四项查询结果，再重跑检查。" >&2
    [ "$nontravel_unknown" = 0 ] || echo "若这是库还没建、四项都无法确认的新服务器，先部署 08 之后的 tag，或确认库里确实没有这四类数据后再处理。" >&2
    case "$target" in
      pre-02 | pre-03 | pre-04 | pre-05 | pre-06 | pre-07 | pre-08)
        echo "四项都为零、重跑回滚检查通过后，再部署旧 tag。" >&2 ;;
      *)
        echo "四项都为零、重跑回滚检查退出码 0 后，直接起目标镜像并重打 :current（不跑迁移）：" >&2
        echo "  APP_IMAGE=${target} APP_CONTAINER=${project} HOST_PORT=${port} docker compose -p ${project} -f deploy/compose.yml up -d --no-deps app && docker tag ${target} ${project}:current" >&2
        echo "  curl -fsS http://127.0.0.1:${port}/healthz" >&2
        echo "  （确认 revision 是 ${target} 的 APP_REVISION）" >&2 ;;
    esac
    exit 9
  fi
fi
# 超级用户跨租户检查；旧库没有新列就没有这类数据风险。
tenancy_state() {
  local has host rows
  has=$(db_query "select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'kind')") || return 1
  case "$has" in
    f) echo 'f f' ;;
    t)
      host=$(env_val DEFAULT_TENANT_SLUG "$env_file")
      [[ "$host" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || return 1
      rows=$(db_query "select exists(select 1 from public.tenants where kind = 'standard' and public_host is not null and slug <> '${host}') as other_hosts, exists(select 1 from public.tenants where kind = 'sandbox') as sandboxes") || return 1
      printf '%s\n' "$rows" | tr '|' ' ' ;;
    *) return 1 ;;
  esac
}
if [ "$is_pre05" = 1 ] && [ ${#risks[@]} -eq 0 ]; then
  sandbox_refuse() {
    echo "拒绝回滚：目标是 05 之前的镜像（没有 src/tenancy/runtime.ts）：$1" >&2
    case "$1" in
      '宿主以外的 standard 租户仍设了 public_host')
        echo "查库确认宿主以外哪些 standard 租户有 public_host；先 tenant-host clear 这些租户，并从反向代理摘掉它们的域名。" >&2 ;;
      '沙箱容器仍存在（包括已停的容器）' | '.env.sandbox 仍存在')
        if [ "$1" != '.env.sandbox 仍存在' ]; then
          echo "删掉沙箱容器及其匿名卷（只 stop sandbox 不够）：" >&2
          echo "  APP_CONTAINER=${project} HOST_PORT=${port} docker compose -p ${project} -f deploy/compose.yml --profile sandbox rm -sfv sandbox" >&2
        fi
        if [ -f "$dir/.env.sandbox" ]; then
          echo "把沙箱环境文件改名，避免再次启用沙箱：" >&2
          echo "  mv .env.sandbox .env.sandbox.off" >&2
        fi
        echo "从反向代理摘掉沙箱站点；只清理沙箱自己的匿名卷，不删除宿主、db 的命名卷或 var/ 绑定挂载。" >&2 ;;
      'sandbox purge --all 失败')
        echo "查看上方 CLI 错误码（如 sandbox_tenant_lock_held、sandbox_already_running）；通常是沙箱进程还在跑或有挂住的事务。查沙箱进程与数据库锁、事务，处理后再试。" >&2 ;;
      '当前镜像不能执行 sandbox purge --all')
        echo "确认当前容器镜像是可运行 sandbox purge --all 的 05 之后版本，再重跑检查。" >&2 ;;
      'purge 后库里仍有沙箱行或库问不到')
        echo "重新查库确认 kind=sandbox 的行是否残留，以及 db 连接与查询是否正常；确认 purge 结果后再试。" >&2 ;;
      '无法确认沙箱容器是否存在')
        echo "确认 Docker 可达，查 docker container ls -a 中的 ${project}-sandbox（包括已停的容器），再重跑检查。" >&2 ;;
      *)
        echo "确认 db 在跑（docker compose -p ${project} ps db），检查数据库连接、tenants 的 kind/public_host 与 .env 的 DEFAULT_TENANT_SLUG，能确认查询结果后再试。" >&2
        if [ -z "${running:-}" ]; then
          all_containers=$(timeout --kill-after=2s 8s docker container ls -aq --filter "label=com.docker.compose.project=${project}" </dev/null 2>/dev/null) &&
            if [ -z "$all_containers" ]; then
              echo "若这是没有任何容器、库不可达的空服务器，pre-05 tag 也会从严拒绝；新服务器先部署 05 之后的 tag，或确认库后再试。" >&2
            fi
        fi ;;
    esac
    echo "处理上述原因后再重跑检查；有沙箱行时由当前镜像 sandbox purge --all，库里没有沙箱行才放行。" >&2
    exit 7
  }
  tenancy=$(tenancy_state) || tenancy=unknown
  case "$tenancy" in
    't t' | 't f') sandbox_refuse '宿主以外的 standard 租户仍设了 public_host' ;;
    'f f' | 'f t') ;;
    *)
      running=$(docker inspect --format '{{.Image}}' "$project" </dev/null 2>/dev/null)
      [ -n "$running" ] && [ "$(pre05_image "$running" >/dev/null 2>&1; echo $?)" = 1 ] || sandbox_refuse '库不可达或查询结果无法确认'
      tenancy='f f' ;;
  esac
  containers=$(timeout --kill-after=2s 8s docker container ls -aq --filter "name=^/${project}-sandbox$" </dev/null 2>/dev/null) || sandbox_refuse '无法确认沙箱容器是否存在'
  [ -z "$containers" ] || sandbox_refuse '沙箱容器仍存在（包括已停的容器）'
  [ ! -f "$dir/.env.sandbox" ] || sandbox_refuse '.env.sandbox 仍存在'
  if [ "$tenancy" = 'f t' ]; then
    running=$(docker inspect --format '{{.Image}}' "$project" </dev/null 2>/dev/null)
    [ -n "$running" ] && pre05_image "$running" >/dev/null 2>&1 || sandbox_refuse '当前镜像不能执行 sandbox purge --all'
    # 显式用当前容器的镜像；:latest 或 :prev 可能已指向旧镜像。CLI 使用宿主的 app 环境、不需要 .env.sandbox。
    (cd "$dir" && APP_IMAGE="$running" APP_CONTAINER="$project" HOST_PORT="$port" \
      timeout --kill-after=2s 120s docker compose -p "$project" -f deploy/compose.yml run --rm --no-deps app \
      node --import tsx src/cli/sandbox.ts purge --all </dev/null) || sandbox_refuse 'sandbox purge --all 失败'
    tenancy=$(tenancy_state) || tenancy=unknown
    [ "$tenancy" = 'f f' ] || sandbox_refuse 'purge 后库里仍有沙箱行或库问不到'
  fi
fi
[ ${#risks[@]} -eq 0 ] && exit 0

# 打印的命令里的租户：标记文件的 tenant，没有就取 .env 的 DEFAULT_TENANT_SLUG；字符集不对（或都没有）就留 <slug> 让人填
slug=""
[ -f "$marker" ] && slug=$(sed -n 's/.*"tenant":"\([^"]*\)".*/\1/p' "$marker" </dev/null | head -n 1)
[ -z "$slug" ] && [ -f "$channel_marker" ] && slug=$(sed -n 's/.*"tenant":"\([^"]*\)".*/\1/p' "$channel_marker" </dev/null | head -n 1)
[ -n "$slug" ] || slug=$(env_val DEFAULT_TENANT_SLUG "$env_file")
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || slug='<slug>'
dc="APP_CONTAINER=${project} HOST_PORT=${port} docker compose -p ${project} -f deploy/compose.yml"
{
  if [ "$is_pre02" = 1 ]; then
    echo "拒绝回滚：目标是 02 之前的镜像（没有 src/store/pg-backend.ts），而"
  elif [ "$is_pre03" = 1 ]; then
    echo "拒绝回滚：目标是 03 之前的镜像（没有 src/channels/registry.ts），而"
  else
    echo "拒绝回滚：目标是 04 之前的镜像（没有 src/core/pack-api.ts），而"
  fi
  for r in "${risks[@]}"; do echo "  - ${r}"; done
  if [ -n "$brand_risk" ]; then
    brand_auto=0
    case "$target" in pre-02 | pre-03 | pre-04) ;; *) brand_auto=1 ;; esac
    echo "品牌恢复步骤（在 ${dir} 下，对所有有品牌风险的租户处理）："
    if [ "$brand_auto" = 1 ]; then
      echo "这是健康检查失败后的自动回滚：${project}:current 是坏的新镜像，${target} 是 pre-04。"
      if [ "$brand_published" != f ]; then
        echo "坏的新镜像起不来，${target} 不支持品牌重渲染；先部署一个已知可用的 04 之后的 tag，或用服务器上已有的 04 之后镜像恢复服务。"
        echo "以下用已有镜像（把占位 tag 换成已知可用的 04 之后镜像，不用 :current、:latest 或 ${target}）："
        echo "  RECOVERY_IMAGE='${project}:<已知可用的04之后tag>'"
        echo "  APP_IMAGE=\${RECOVERY_IMAGE} ${dc} up -d --no-deps app && docker tag \"\${RECOVERY_IMAGE}\" ${project}:current"
        echo "  curl -fsS http://127.0.0.1:${port}/healthz"
      fi
    fi
    if [ "$brand_pending" = f ]; then
      echo "待生效品牌已经为空，无需再次 tenant-brand clear。"
    else
      [ "$brand_pending" = unknown ] && echo "先确认待生效品牌；若仍非空，对这些租户执行 tenant-brand clear："
      [ "$brand_pending" = t ] && echo "先 tenant-brand clear，清空所有非空的待生效品牌（用 04 之后的镜像执行）："
      echo "  ${dc} run --rm platform node --import tsx src/cli/tenant-brand.ts clear --tenant <slug>"
    fi
    if [ "$brand_published" = f ]; then
      echo "当前发布版本没有品牌快照，clear 后无需重启或重渲染。"
    else
      echo "clear 只改待生效值：用 04 之后的镜像重启一次，按原因 brand 重渲染，当前发布快照的 brand 也须为空。"
      if [ "$brand_auto" = 1 ]; then
        echo "  ${dc} stop app"
        echo "  APP_IMAGE=\${RECOVERY_IMAGE} ${dc} up -d --no-deps app"
      else
        echo "  ${dc} restart app"
      fi
      echo "  curl -fsS http://127.0.0.1:${port}/healthz"
      echo "  （确认 promptHash 回到该租户旧版模式的值）"
    fi
    echo "再重跑回滚检查，确认品牌风险已消除；其他风险也须按对应步骤消除。"
    if [ "$is_pre05" = 1 ]; then
      echo "处理完品牌风险后再跑，还可能因沙箱风险以 7 拒绝（以下只读探测，不执行 purge）："
      tenancy=$(tenancy_state) || tenancy=unknown
      case "$tenancy" in
        't t' | 't f') echo "  - 宿主以外的 standard 租户有 public_host" ;;
        'f f' | 'f t') ;;
        *) echo "  - 库不可达或查询结果无法确认：需确认其他 standard 的 public_host 与沙箱行" ;;
      esac
      case "$tenancy" in 't t' | 'f t') echo "  - 库里仍有沙箱行，前置风险消除后需 purge；purge 失败或删除后仍有行也以 7 拒绝" ;; esac
      containers=$(timeout --kill-after=2s 8s docker container ls -aq --filter "name=^/${project}-sandbox$" </dev/null 2>/dev/null) || containers=unknown
      if [ "$containers" = unknown ]; then
        echo "  - 沙箱容器是否存在无法确认"
      elif [ -n "$containers" ]; then
        echo "  - 沙箱容器仍存在（包括已停的容器）"
      fi
      [ ! -f "$dir/.env.sandbox" ] || echo "  - .env.sandbox 仍存在"
    fi
    if [ "$brand_auto" = 1 ]; then
      echo "检查退出码 0 后，直接起目标镜像并重打 :current（不跑迁移）："
      echo "  APP_IMAGE=${target} ${dc} up -d --no-deps app && docker tag ${target} ${project}:current"
      echo "  curl -fsS http://127.0.0.1:${port}/healthz"
      echo "  （确认 revision 是 ${target} 的 APP_REVISION）"
    else
      echo "完成上面的品牌恢复步骤、回滚检查通过后，再部署旧 tag。"
    fi
    case "$brand_risk" in *问不到库*) echo "先确认 db 在跑（docker compose -p ${project} ps db），能查库之后再确认所有租户的两种品牌值。" ;; esac
  fi
  if [ -n "$catalog_risk" ]; then
    echo "02 之前的镜像不写条目版本：那期间发出的方案书链接回到 02 之后会按版本 1 显示旧价。回到文件存储也去不掉这一条，"
    echo "要回滚只能回到 02 之后的镜像（会话在库里也不用先导出）。"
    case "$catalog_risk" in *问不到库*) echo "看不出来是因为 /healthz 与库都问不到：确认 db 在跑（docker compose -p ${project} ps db）之后再试。" ;; esac
    # 回到文件存储的步骤帮不上忙，不打印
    exit 4
  fi
  if [ -n "$brand_risk" ] && [ ${#risks[@]} -eq 1 ]; then exit 6; fi
  if [ -n "$channel_risk" ]; then
    echo "先用当前（03 之后的）镜像导出渠道状态（在 ${dir} 下）："
    if [ "$target" != pre-02 ] && [ "$target" != pre-03 ]; then
      echo "这是健康检查失败后的自动回滚：${project}:current 已是这次没过健康检查的新镜像，导出用它。"
    fi
    echo "  1. ${dc} stop app"
    echo "  2. install -d -o 1000 -g 1000 /root/channels-keep-<日期>"
    echo "     ${dc} run --rm -v /root/channels-keep-<日期>:/keep app \\"
    echo "       node --import tsx src/cli/channel-export.ts --tenant ${slug} --var /app/var --keep /keep"
    echo "     （不带 APP_IMAGE，用当前 ${project}:current 镜像里的 channel-export；被拒时照提示处理。"
    echo "      有默认企微账号以外的任何账号，不论状态，只能回到 03 之后的镜像；部分送达或未发的人工回复、通知需以 03 起一次、恢复发完、正常停机再导出。）"
    echo "  3. 确认退出码 0、var/channels-in-db.json 没了、默认企微账号（kind = wecom_kf、id_prefix = wecom:）是 exported，.env 里的 WECOM_* 还在。"
    case "$channel_risk" in *问不到库*) echo "     先确认 db 在跑（docker compose -p ${project} ps db），能查库之后再确认上述状态。" ;; esac
    if [ "$is_pre02" = 1 ] && [ "$session_risk_count" -gt 0 ]; then
      echo "  4. 目标同时是 02 之前、会话在库里：接着按下面的步骤回到文件存储，再起目标镜像。"
    else
      if [ "$target" = pre-02 ] || [ "$target" = pre-03 ]; then
        # 先用当前镜像把应用起来顶住，部署旧 tag（拉镜像、构建）期间不停机（第 20 步演练停了 7 分钟，owner 10-10 定）
        echo "  4. 先用当前镜像把应用起来顶住（已导出，照 02 走 .env 的 WECOM_* 与 var/wecom-cursor.json）："
        echo "     ${dc} up -d app，curl -fsS http://127.0.0.1:${port}/healthz 确认 channels.mode = env"
        echo "  5. 再部署旧 tag。"
      else
        rev=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$target" </dev/null 2>/dev/null | sed -n 's/^APP_REVISION=//p' | head -n 1)
        echo "  4. 直接起目标镜像并重打 :current（不跑迁移）："
        echo "     APP_IMAGE=${target} ${dc} up -d --no-deps app && docker tag ${target} ${project}:current"
        echo "     curl -fsS http://127.0.0.1:${port}/healthz 确认 revision 是 ${rev:-（取不到 ${target} 的 APP_REVISION）}（${target} 的 APP_REVISION）"
      fi
      echo "再切回 03：stop app → channel-import --resync --keep <var 之外的目录> → up -d app。"
      exit 5
    fi
  fi
  if [ "$target" = pre-02 ]; then
    echo "先用 02 的镜像回到文件存储，再部署旧 tag（在 ${dir} 下）："
  else
    echo "这是健康检查失败后的自动回滚：${project}:current 已是这次没过健康检查的新镜像。先用它导出、回到文件存储，再直接起 ${target}（在 ${dir} 下）："
  fi
  echo "  1. ${dc} stop app"
  echo "  2. install -d -o 1000 -g 1000 /root/sessions-keep-<日期>"
  echo "     ${dc} run --rm -v /root/sessions-keep-<日期>:/keep app \\"
  echo "       node --import tsx src/cli/export-sessions.ts --tenant ${slug} --keep /keep --var /app/var"
  if [ "$target" != pre-02 ]; then
    echo "     （不带 APP_IMAGE，用的是 ${project}:current，也就是这次的新镜像里的 export-sessions）"
  fi
  echo "     （退出码 0、删掉了 var/sessions-in-db.json 才算导出完）"
  if [ "$target" = pre-02 ]; then
    echo "  3. .env 去掉 SESSION_STORE=db，${dc} up -d app，curl -fsS http://127.0.0.1:${port}/healthz 确认 store.mode = file"
    echo "  4. 再部署旧 tag"
  else
    rev=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$target" </dev/null 2>/dev/null | sed -n 's/^APP_REVISION=//p' | head -n 1)
    echo "  3. .env 去掉 SESSION_STORE=db，直接起目标镜像并重打 :current（不跑迁移）："
    echo "     APP_IMAGE=${target} ${dc} up -d --no-deps app && docker tag ${target} ${project}:current"
    echo "  4. curl -fsS http://127.0.0.1:${port}/healthz 确认 revision 是 ${rev:-（取不到 ${target} 的 APP_REVISION）}（${target} 的 APP_REVISION）"
  fi
} >&2
[ -n "$channel_risk" ] && exit 5
[ -n "$brand_risk" ] && exit 6
exit 3
