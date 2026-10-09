#!/usr/bin/env bash
# 回滚前检查（02、03 spec「导入、导出与切换」）。在服务器上跑：deploy.sh 部署一个旧 tag、
# 以及健康检查失败后自动回滚到 :prev 之前，经 ssh 把本脚本交给 bash -s。
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
#
# 用法：rollback-guard.sh <部署目录> <目标> [<compose 项目名> [<宿主端口>]]
#   <目标> 是镜像名（如 wecom-sales-agent:prev）：自动回滚。看镜像里有没有 /app/src/store/pg-backend.ts；docker 出错、判断不了时按 02 之前算
#   <目标> 是 pre-02：部署旧 tag，调用方已经按 tag 的文件树判定它是 02 之前的（镜像还没建）
#   <目标> 是 pre-03：部署旧 tag，调用方已判定它是 02 之后、03 之前的
# 打印的命令带上项目名与宿主端口（旁路实例的手工命令也要带，见 deploy/compose.yml 开头）。
# 退出码：0 照常回滚；3 拒绝，只有会话在库里（先回到文件存储的步骤打在 stderr）；4 拒绝，有条目版本大于 1 或看不出来
#（只能回到 02 之后的镜像，不打印导出步骤）；5 拒绝，有渠道状态在库里或看不出来（先 channel-export，
# 若目标同时是 02 之前、会话在库里，再回到文件存储）。优先级：4 > 5 > 3。
set -u
dir="$1" target="$2" project="${3:-wecom-sales-agent}" port="${4:-3210}"
marker="$dir/var/sessions-in-db.json"
channel_marker="$dir/var/channels-in-db.json"
env_file="$dir/.env"
# 与 deploy.sh 第 3 步的检查同一种读法（docker --env-file）：行首空白去掉、按第一个 = 分开、同名以最后一行为准
env_val() {
  [ -f "$2" ] || return 0
  awk -v k="$1=" '{ sub(/^[ \t]+/, ""); sub(/\r$/, "") } index($0, k) == 1 { v = substr($0, length(k) + 1) } END { print v }' "$2"
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
# 02 之前的镜像里没有 pg-backend.ts：0 是 02 之后的，1 是 02 之前的，其余是 docker 出错、看不出来
pre02_image() { docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/src/store/pg-backend.ts'; }
pre03_image() { docker run --rm --entrypoint /bin/sh "$1" -c 'test -e /app/src/channels/registry.ts'; }
# 直接问库（与 backup.sh 同一种找法：按项目名找 db 服务，在 / 下执行；超级用户不受 RLS 限制）。打印 t / f / none（表不存在）
db_versioned() {
  local db has
  db=$(env_val AGENT_DB "$dir/.env.db")
  db=${db:-agent}
  has=$( (cd / && docker compose -p "$project" exec -T db psql -U postgres -d "$db" -Atc "select to_regclass('public.catalog_item_versions') is not null") 2>/dev/null) || return 1
  case "$has" in
    f) echo none ;;
    t) (cd / && docker compose -p "$project" exec -T db psql -U postgres -d "$db" -Atc "select exists(select 1 from catalog_item_versions where version > 1)") 2>/dev/null ;;
    *) return 1 ;;
  esac
}
# 全库检查：超级用户跨租户看所有账号，只有默认企微账号且 exported 才能安全回到 env 与文件状态。
# IS NOT TRUE 也把 NULL 前缀算作风险（网页账号的前缀是 NULL）。
db_channels() {
  local db has
  db=$(env_val AGENT_DB "$dir/.env.db")
  db=${db:-agent}
  has=$( (cd / && docker compose -p "$project" exec -T db psql -U postgres -d "$db" -Atc "select to_regclass('public.channel_accounts') is not null") 2>/dev/null) || return 1
  case "$has" in
    f) echo none ;;
    t) (cd / && docker compose -p "$project" exec -T db psql -U postgres -d "$db" -Atc "select exists(select 1 from channel_accounts where (kind = 'wecom_kf' and id_prefix = 'wecom:' and status = 'exported') is not true)") 2>/dev/null ;;
    *) return 1 ;;
  esac
}
# 有条目版本大于 1（02「报价快照」）：先问正在运行的实例，看不出来再问库，库也问不到再看正在跑的是不是 02 之前的镜像
catalog_risk=""
health=$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/healthz" 2>/dev/null)
case "$health" in
  *'"catalogVersioned":false'*) ;;
  *'"catalogVersioned":true'*) catalog_risk="正在运行的实例 /healthz 的 config.catalogVersioned 为 true：有条目版本大于 1（改过上架条目的价格或内容）" ;;
  *)
    versioned=$(db_versioned) || versioned=""
    case "$versioned" in
      f | none) ;;
      t) catalog_risk="取不到 127.0.0.1:${port}/healthz 的 config.catalogVersioned，库里的 catalog_item_versions 有版本大于 1 的条目（改过上架条目的价格或内容）" ;;
      *)
        running=$(docker inspect --format '{{.Image}}' "$project" 2>/dev/null)
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
  pre-03) ;;
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
fi
is_pre03=1
if [ "$is_pre02" = 0 ] && [ "$target" != pre-03 ]; then
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
        running=$(docker inspect --format '{{.Image}}' "$project" 2>/dev/null)
        if [ -z "$running" ] || [ "$(pre03_image "$running" >/dev/null 2>&1; echo $?)" != 1 ]; then
          channel_risk="问不到库，看不出渠道状态是否在库里，按有风险处理"
        fi
        ;;
    esac
  fi
fi
[ -n "$channel_risk" ] && risks+=("$channel_risk")
[ ${#risks[@]} -eq 0 ] && exit 0

# 打印的命令里的租户：标记文件的 tenant，没有就取 .env 的 DEFAULT_TENANT_SLUG；字符集不对（或都没有）就留 <slug> 让人填
slug=""
[ -f "$marker" ] && slug=$(sed -n 's/.*"tenant":"\([^"]*\)".*/\1/p' "$marker" | head -n 1)
[ -z "$slug" ] && [ -f "$channel_marker" ] && slug=$(sed -n 's/.*"tenant":"\([^"]*\)".*/\1/p' "$channel_marker" | head -n 1)
[ -n "$slug" ] || slug=$(env_val DEFAULT_TENANT_SLUG "$env_file")
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || slug='<slug>'
dc="APP_CONTAINER=${project} HOST_PORT=${port} docker compose -p ${project} -f deploy/compose.yml"
{
  if [ "$is_pre02" = 1 ]; then
    echo "拒绝回滚：目标是 02 之前的镜像（没有 src/store/pg-backend.ts），而"
  else
    echo "拒绝回滚：目标是 03 之前的镜像（没有 src/channels/registry.ts），而"
  fi
  for r in "${risks[@]}"; do echo "  - ${r}"; done
  if [ -n "$catalog_risk" ]; then
    echo "02 之前的镜像不写条目版本：那期间发出的方案书链接回到 02 之后会按版本 1 显示旧价。回到文件存储也去不掉这一条，"
    echo "要回滚只能回到 02 之后的镜像（会话在库里也不用先导出）。"
    case "$catalog_risk" in *问不到库*) echo "看不出来是因为 /healthz 与库都问不到：确认 db 在跑（docker compose -p ${project} ps db）之后再试。" ;; esac
    # 回到文件存储的步骤帮不上忙，不打印
    exit 4
  fi
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
    if [ "$is_pre02" = 1 ] && [ ${#risks[@]} -gt 1 ]; then
      echo "  4. 目标同时是 02 之前、会话在库里：接着按下面的步骤回到文件存储，再起目标镜像。"
    else
      if [ "$target" = pre-02 ] || [ "$target" = pre-03 ]; then
        echo "  4. 再部署旧 tag。"
      else
        rev=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$target" 2>/dev/null | sed -n 's/^APP_REVISION=//p' | head -n 1)
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
    rev=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$target" 2>/dev/null | sed -n 's/^APP_REVISION=//p' | head -n 1)
    echo "  3. .env 去掉 SESSION_STORE=db，直接起目标镜像并重打 :current（不跑迁移）："
    echo "     APP_IMAGE=${target} ${dc} up -d --no-deps app && docker tag ${target} ${project}:current"
    echo "  4. curl -fsS http://127.0.0.1:${port}/healthz 确认 revision 是 ${rev:-（取不到 ${target} 的 APP_REVISION）}（${target} 的 APP_REVISION）"
  fi
} >&2
[ -n "$channel_risk" ] && exit 5
exit 3
