#!/usr/bin/env bash
# 主机上的巡检（02 spec「可观测性与告警 · 告警」、R24）：宿主机的 cron 每分钟跑一次，查五样，出事推到企微群机器人。
# deploy.sh 每次部署把本脚本装到部署目录之外的 /usr/local/lib/<NAME>/watch.sh（与 backup.sh 同一个原因：回到 01 之前的版本时
# rsync --delete 会删掉 deploy/），cron 跑那一份、把部署目录作为参数传进来，例如：
#   * * * * *  bash /usr/local/lib/wecom-sales-agent/watch.sh /opt/wecom-sales-agent >>/var/log/wecom-watch.log 2>&1
# 线上实际的路径、主机与 cron 另记。
#
# 查的五样（触发与恢复照 spec 的表）：
#   重启      app 容器的 RestartCount 10 分钟内增加 2 次以上；30 分钟没有重启恢复
#   健康检查  本机 curl /healthz 连续 3 分钟失败（连不上、HTTP 出错或 ok 为 false）；连续 3 分钟正常恢复
#   磁盘      根分区或数据库数据卷的使用率 ≥ 85%，≥ 95% 再发一次；回到 80% 以下恢复
#   备份      上次成功的备份（backup.sh 成功时写的 <BACKUP_DIR>/<项目名>/last-success）早于 26 小时；有了新的成功恢复。
#             还没有这个文件时（这一版的 backup.sh 还没跑过）按最新的日期目录算
#   业务拨测  工业 app 登录、核对租户、读成员资源、退出；连续 3 次失败告警，连续 3 次成功恢复
# 同一项在条件持续期间 30 分钟内至多推一次（磁盘到 95% 那一次除外），恢复推一条「已恢复」；去重状态存在一个小文件里。
# 推送：企微群机器人的 text 消息「[实例名] 中文说明 · 时间」，只有计数与百分比，不带地址、路径与密钥；curl 5 秒超时、至多重试
# 2 次，推不出去只写 stderr（cron 的日志）。webhook 地址等同密钥：只在 env 文件里，这里任何输出都不打它。
#
# 配置写在部署目录的运维 env 文件里（不进仓库，deploy.sh 的 rsync 不碰 .env*）：先读 .env.backup（BACKUP_DIR、COMPOSE_PROJECT
# 与 backup.sh 同一份），再读 .env.ops（后读的盖前面的）：
#   ALERT_WEBHOOK_URL  告警群机器人的地址；不填只写 stderr
#   INSTANCE_LABEL     告警里的实例名（如 demo），不写域名与 IP；缺省是项目名
#   COMPOSE_PROJECT    compose 项目名。部署目录是 /opt/wecom-sales-agent 时缺省 wecom-sales-agent；别的目录必须写明
#   APP_CONTAINER      app 容器名，缺省同项目名（deploy.sh 用 NAME 做两者）
#   SANDBOX_PORT       沙箱 /healthz 的宿主端口，缺省 3211；有 .env.sandbox 时才查（含重启）
#   HOST_PORT          /healthz 的宿主端口，缺省 3210（线上 demo）；旁路实例写它自己的
#   DISK_PATHS         另外要查的挂载点（空格分开）；根分区与数据库数据卷（<项目名>_db-data）总是查
#   WATCH_STATE        去重状态文件，缺省 /var/lib/<项目名>/watch.state
#   WATCH_BACKUP       设成 0 不查备份（没配备份的实例）
#   PROBE_APP_ORIGIN   工业 app 的 origin；与下面三项全空时跳过，部分配置告警但不请求
#   PROBE_TENANT_SLUG  工业租户 slug
#   PROBE_EMAIL        专属普通 agent 邮箱（不是共享试用账号）
#   PROBE_PASSWORD     专属账号口令；.env.ops 被 source，值必须用单引号
#   PROBE_EVERY_S      健康时的间隔秒数，默认 600；失败/恢复观察时每次巡检都跑
# 自测另用 WATCH_NOW（当作「现在」的秒数）。
set -uo pipefail
umask 077

cd "${1:-$(dirname "$0")/..}" || exit 1
if [[ ! -f .env ]]; then
  echo "watch: $(pwd) 不是部署目录（缺 .env）。用法：watch.sh <部署目录>" >&2
  exit 1
fi
for f in .env.backup .env.ops; do
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
  fi
done
if [[ -z "${COMPOSE_PROJECT:-}" && "$(pwd)" != /opt/wecom-sales-agent ]]; then
  echo "watch: $(pwd) 不是线上部署目录，要在 .env.ops 里写明 COMPOSE_PROJECT" >&2
  exit 1
fi
PROJECT="${COMPOSE_PROJECT:-wecom-sales-agent}"
CONTAINER="${APP_CONTAINER:-$PROJECT}"
PORT="${HOST_PORT:-3210}"
LABEL="${INSTANCE_LABEL:-$PROJECT}"
STATE="${WATCH_STATE:-/var/lib/${PROJECT}/watch.state}"
NOW="${WATCH_NOW:-$(date +%s)}"
DEDUPE_S=1800

# ---------------- 状态文件：一行一个 名字=值（只认小写名字与数字、空格、冒号） ----------------
STATE_KEYS=()
get() {
  local v="st_$1"
  printf '%s' "${!v:-}"
}
put() {
  printf -v "st_$1" '%s' "$2"
  [[ " ${STATE_KEYS[*]-} " == *" $1 "* ]] || STATE_KEYS+=("$1")
}
if [[ -f "$STATE" ]]; then
  while IFS='=' read -r k v; do
    if [[ "$k" =~ ^[a-z0-9_]+$ && "$v" =~ ^[0-9\ :]*$ ]]; then put "$k" "$v"; fi
  done <"$STATE"
fi
save_state() {
  mkdir -p "$(dirname "$STATE")" || return 0
  local k
  {
    for k in "${STATE_KEYS[@]-}"; do [[ -n "$k" ]] && printf '%s=%s\n' "$k" "$(get "$k")"; done
  } >"${STATE}.tmp" && mv "${STATE}.tmp" "$STATE"
}

# ---------------- 推送 ----------------
stamp() { date -d "@$NOW" '+%F %T' 2>/dev/null || date -r "$NOW" '+%F %T'; }
json_escape() {
  local s=${1//\\/\\\\}
  printf '%s' "${s//\"/\\\"}"
}
post() {
  if [[ -z "${ALERT_WEBHOOK_URL:-}" ]]; then
    echo "watch: ⚠️ 没配 ALERT_WEBHOOK_URL，这条告警只记在这里：$1" >&2
    return 0
  fi
  local resp rc
  resp="$(curl -s -m 5 --retry 2 --retry-delay 1 --retry-connrefused -H 'content-type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$(json_escape "$1")\"}}" "$ALERT_WEBHOOK_URL" 2>/dev/null)"
  rc=$?
  if ((rc == 0)) && [[ "$resp" == *'"errcode":0'* ]]; then
    echo "watch: 已推送：$1"
  else
    echo "watch: ⚠️ 告警没推出去（curl 退出码 ${rc}）：$1" >&2
  fi
}
# alert <项> <说明> [escalate]：同一项在告警中、30 分钟内推过就不推（escalate 除外）
alert() {
  local active last
  active="$(get "a_${1}_active")"
  last="$(get "a_${1}_last")"
  if [[ "$active" == 1 && -z "${3:-}" ]] && ((NOW - ${last:-0} < DEDUPE_S)); then return 0; fi
  put "a_${1}_active" 1
  put "a_${1}_last" "$NOW"
  post "[${LABEL}] $2 · $(stamp)"
}
# resolve <项> <说明>：这一项在告警中才推「已恢复」
resolve() {
  [[ "$(get "a_${1}_active")" == 1 ]] || return 0
  put "a_${1}_active" 0
  post "[${LABEL}] 已恢复：$2 · $(stamp)"
}

# ---------------- 1. 反复重启 ----------------
check_restart() {
  local CONTAINER="$1" prefix="$2" service="$3" count kept prev base s t c inc last
  count="$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null)"
  if [[ "$count" =~ ^[0-9]+$ ]]; then
    kept=() prev='' base=''
    for s in $(get "${prefix}restart_hist"); do
      t=${s%%:*} c=${s##*:}
      ((NOW - t <= 1800)) || continue
      kept+=("$s")
      prev=$c
      if [[ -z "$base" ]] && ((NOW - t <= 600)); then base=$c; fi
    done
    # 容器重建过（部署换了新容器）：计数从 0 重来，之前的样本作废
    if [[ -n "$prev" ]] && ((count < prev)); then kept=() prev='' base=''; fi
    [[ -n "$prev" ]] && ((count > prev)) && put "${prefix}restart_last" "$NOW"
    kept+=("${NOW}:${count}")
    put "${prefix}restart_hist" "${kept[*]}"
    inc=$((count - ${base:-$count}))
    last="$(get "${prefix}restart_last")"
    if ((inc >= 2)); then
      alert "${prefix}restart" "${service} 容器 10 分钟内重启了 ${inc} 次"
    elif [[ -n "$last" ]] && ((NOW - last >= 1800)); then
      resolve "${prefix}restart" "${service} 容器 30 分钟没有重启"
    fi
  fi

}

check_health() {
  local PORT="$1" prefix="$2" label="$3" body rc why
  body="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)"
  rc=$?
  if ((rc == 0)) && [[ "$body" == *'"ok":true'* ]]; then
    put "${prefix}health_bad" 0
    put "${prefix}health_good" $(($(get "${prefix}health_good") + 1))
    (($(get "${prefix}health_good") >= 3)) && resolve "${prefix}health" "${label}健康检查连续 3 分钟正常"
  else
    why='ok 为 false'
    ((rc == 0)) || why="连不上或 HTTP 出错，curl 退出码 ${rc}"
    put "${prefix}health_good" 0
    put "${prefix}health_bad" $(($(get "${prefix}health_bad") + 1))
    (($(get "${prefix}health_bad") >= 3)) && alert "${prefix}health" "${label}健康检查连续 $(get "${prefix}health_bad") 分钟失败（${why}）"
  fi

}

check_restart "$CONTAINER" "" app
check_health "$PORT" "" ""
# 05：用独立的状态键与告警键；停用后不再探测沙箱。
if [[ -f .env.sandbox ]]; then
  check_restart "${CONTAINER}-sandbox" sandbox_ sandbox
  check_health "${SANDBOX_PORT:-3211}" sandbox_ "沙箱"
fi

# ---------------- 3. 磁盘 ----------------
vol="$(docker volume inspect -f '{{.Mountpoint}}' "${PROJECT}_db-data" 2>/dev/null)"
max=-1 which=''
for p in / ${vol:+"$vol"} ${DISK_PATHS:-}; do
  # 设备名过长时（overlay2、LVM、NFS 长挂载）df -P 会把它单独占一行，数据挪到下一行、少了设备名那一列：
  # 一条路径只有一个条目，数据永远是最后一行；Capacity 永远是倒数第二列（正常行多一列设备名，自然往后挪一位）
  pct="$(df -P "$p" 2>/dev/null | awk 'END { v = $(NF - 1); sub("%", "", v); print v }')"
  [[ "$pct" =~ ^[0-9]+$ ]] || continue
  if ((pct > max)); then
    max=$pct
    if [[ "$p" == / ]]; then which='根分区'; elif [[ "$p" == "$vol" ]]; then which='数据库数据卷'; else which='另一个挂载点'; fi
  fi
done
if ((max >= 0)); then
  level="$(get disk_level)"
  level=${level:-0}
  if ((max >= 85)); then
    esc=''
    if ((max >= 95 && level < 95)); then
      esc=1
      put disk_level 95
    elif ((level < 85)); then
      put disk_level 85
    fi
    alert disk "磁盘使用率 ${max}%（${which}）" "$esc"
  elif ((max < 80)); then
    put disk_level 0
    resolve disk "磁盘使用率回到 80% 以下（${max}%）"
  fi
fi

# ---------------- 4. 备份 ----------------
if [[ "${WATCH_BACKUP:-1}" != 0 ]]; then
  root="${BACKUP_DIR:-/var/backups}/${PROJECT}"
  ok=''
  if [[ -f "$root/last-success" ]]; then ok="$(head -c 20 "$root/last-success" | tr -cd 0-9)"; fi
  if [[ -z "$ok" ]]; then
    # 这一版的 backup.sh 还没成功跑过：按最新的日期目录（之前的备份）算
    newest="$(find "$root" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' 2>/dev/null | sort | tail -1)"
    [[ -n "$newest" ]] && ok="$(date -r "$newest" +%s 2>/dev/null)"
  fi
  if [[ ! "$ok" =~ ^[0-9]+$ ]]; then
    alert backup "没有找到成功的备份（备份没跑过，或从没成功过）"
  elif ((NOW - ok > 26 * 3600)); then
    alert backup "上次成功的备份是 $(((NOW - ok) / 3600)) 小时前（超过 26 小时）"
  else
    resolve backup "备份成功（$(((NOW - ok) / 3600)) 小时前）"
  fi
fi

# ---------------- 5. 工业业务拨测 ----------------
# 单次最多四个请求，每个 8 秒（含连接），不重试、不跟随跳转；总网络期限 32 秒。
# 所有凭据只在私有文件或 curl 配置 stdin 中；不打印响应，EXIT/信号清理也覆盖 curl 超时。
probe_run() (
  local csrf='' body code rc why='' slug
  # bash 3.2 在显式 exit 前销毁 local；临时目录留在这个隔离子 shell 中供 EXIT trap 使用。
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/watch-probe.XXXXXXXX")" || { printf '登录，curl 退出码 23'; exit; }
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM
  probe_json() {
    local s=${1//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n} s=${s//$'\r'/\\r} s=${s//$'\t'/\\t}
    s=${s//$'\b'/\\b} s=${s//$'\f'/\\f}
    printf '%s' "$s"
  }
  probe_request() {
    local endpoint="$1" method="$2"
    # csrf 仅接纳 API 的 base64url 令牌，不能向配置注入换行/引号。
    code="$(
      { [[ -z "$csrf" ]] || printf 'header = "x-csrf: %s"\n' "$csrf"; } |
        curl -q -s --max-time 8 --connect-timeout 5 -K - -X "$method" \
          -H 'content-type: application/json' -H "origin: ${PROBE_APP_ORIGIN%/}" \
          -b "$tmp/cookies" -c "$tmp/cookies" -o "$tmp/body" -w '%{http_code}' \
          ${3:+--data-binary} ${3:+@"$3"} \
          "${PROBE_APP_ORIGIN%/}/api/console/$endpoint" 2>/dev/null
    )"
    rc=$?
    if ((rc != 0)); then result="curl 退出码 ${rc}"; return 1; fi
    result="HTTP ${code}"
    [[ "$code" == 200 ]]
  }
  probe_csrf() {
    local re='"csrf"[[:space:]]*:[[:space:]]*"([A-Za-z0-9_-]{43})"'
    [[ "$1" =~ $re ]] && csrf=${BASH_REMATCH[1]}
  }
  printf '{"email":"%s","password":"%s"}' "$(probe_json "$PROBE_EMAIL")" "$(probe_json "$PROBE_PASSWORD")" >"$tmp/login"
  # 退出没有请求体，也要发 Content-Length: 0，否则全站请求体上限回 411。
  : >"$tmp/empty"
  local result
  if ! probe_request auth/login POST "$tmp/login"; then printf '登录，%s' "$result"; exit; fi
  body="$(cat "$tmp/body")"
  probe_csrf "$body" || why='登录，HTTP 200'
  if [[ -z "$why" ]]; then
    if ! probe_request me GET; then
      why="身份，${result}"
    else
      body="$(cat "$tmp/body")"
      local re='"tenantSlug"[[:space:]]*:[[:space:]]*"([a-z0-9-]+)"'
      slug=''
      [[ "$body" =~ $re ]] && slug=${BASH_REMATCH[1]}
      if [[ "$slug" != "$PROBE_TENANT_SLUG" ]]; then
        why='身份，租户不符'
      elif ! probe_csrf "$body"; then
        why='身份，HTTP 200'
      elif ! probe_request conversations/counts GET; then
        why="成员资源，${result}"
      fi
    fi
  fi
  # 即使 /me 或资源失败也用登录返回的 csrf 尽力退出；退出失败不覆盖首次失败。
  if ! probe_request auth/logout POST "$tmp/empty"; then [[ -n "$why" ]] || why="退出，${result}"; fi
  printf '%s' "$why"
)
check_probe() {
  local configured=0 value every last why
  for value in "${PROBE_APP_ORIGIN:-}" "${PROBE_TENANT_SLUG:-}" "${PROBE_EMAIL:-}" "${PROBE_PASSWORD:-}"; do
    [[ -z "$value" ]] || configured=$((configured + 1))
  done
  ((configured > 0)) || return 0
  if ((configured != 4)); then alert probe_config '业务拨测配置不完整'; return 0; fi
  resolve probe_config '业务拨测配置已补齐'
  every="${PROBE_EVERY_S:-600}"
  [[ "$every" =~ ^[1-9][0-9]{0,7}$ ]] || every=600
  last="$(get probe_last)"
  if [[ -n "$last" && "$(get probe_retry)" != 1 ]] && ((NOW - last < every)); then return 0; fi
  put probe_last "$NOW"
  why="$(probe_run)"
  if [[ -z "$why" ]]; then
    put probe_bad 0
    put probe_good $(($(get probe_good) + 1))
    if (($(get probe_good) >= 3)); then
      put probe_retry 0
      resolve probe '业务拨测连续 3 次成功'
    fi
  else
    put probe_retry 1
    put probe_good 0
    put probe_bad $(($(get probe_bad) + 1))
    (($(get probe_bad) >= 3)) && alert probe "业务拨测连续 $(get probe_bad) 次失败（${why}）"
  fi
}
check_probe
save_state
exit 0
