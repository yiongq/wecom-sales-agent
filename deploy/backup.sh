#!/usr/bin/env bash
# 每晚的备份（01 spec「构建与部署 · 备份与恢复」）。deploy.sh 每次部署都把本脚本装到部署目录之外的
# /usr/local/lib/<NAME>/backup.sh，宿主机 cron 跑那一份、把部署目录作为参数传进来，例如：
#   15 3 * * *  bash /usr/local/lib/wecom-sales-agent/backup.sh /opt/wecom-sales-agent >>/var/log/wecom-backup.log 2>&1
# 不让 cron 直接跑部署目录里的 deploy/backup.sh：用旧版本自己的 deploy.sh 回到 01 之前时，它的 rsync --delete 会删掉
# deploy/，而库和 var/ 仍要每晚备份。同样的原因，脚本不读 deploy/compose.yml，按 compose 项目名找 db 容器。
# 不给参数时取脚本所在仓库的根目录（在仓库里直接 bash deploy/backup.sh）。
#
# 1. 先把 var/（会话、订单、企微 cursor、客服二维码）打成 tar，再导出库（02 R7，03 R19 改回这个顺序）：env 账号的企微 cursor 仍在
#    var/ 里，恢复出的 cursor 要比库旧、不能比库新（旧了只是重拉、按 msgid 去重；新了会跳过库里没有的消息）。归档里另放一个恢复哨兵
#    var/restored-from-backup.json（{ backupAt }，03 R7）：只在归档里，线上 var/ 里没有；恢复解开之后它就在，企微状态在库里时只有
#    channel-account restore-cutoff 删它，没删之前有启用的企微账号应用就拒绝启动（下面恢复步骤的第 7 步）。
# 2. 以超级用户在 db 容器里经本地 socket 导出：pg_dump -Fc，外加 pg_dumpall --globals-only --no-role-passwords。
#    主机上不存超级用户口令。不用任何受 RLS 约束的角色导出，也不加 --enable-row-security：没设租户时它会静默导出 0 行。
# 3. 校验：pg_restore --list 里 01 的四张 RLS 表都有 TABLE DATA；02 的 conversations、messages、orders 与 03 的
#    channel_accounts、channel_inbox 在库里存在时也要有（行数可以为 0：文件存储下库里没有会话，企微状态没导入时没有渠道行）。
#    这几张表不存在时只告警一行、备份照做：deploy.sh 先装新版本脚本、后跑迁移，构建或迁移失败时库停在上一阶段，不能因此
#    每晚的备份整份不出。表在不在是导出之前查的。
#    sop_versions、catalog_items 的行数为 0 就非零退出并告警。
# 4. 三份都在离开本机前用 age 公钥加密，私钥不放在服务器上；明文只在 0700 的临时目录里短暂存在。
#    本地按日期建目录（0700），保留 7 天。
# 5. 异地副本经 rclone 复制到 BACKUP_OFFSITE，保留 30 天。没配异地目标时每次都在 stderr 告警，本地备份照常。
# 6. 告警（02 spec「可观测性与告警」、R24）：任何一步失败（trap 在非零退出时）推一条到企微群机器人，只带失败在哪一步与退出码；
#    成功时把时刻写进 <BACKUP_DIR>/<项目名>/last-success（watch.sh 据此查「上次成功的备份早于 26 小时」），上一次失败过就再推
#    一条「已恢复」。推不出去、没配地址只写 stderr，不改变退出码。
#
# 配置写在部署目录的 .env.backup（不进仓库，deploy.sh 的 rsync 不碰 .env*），之后再读运维 env 文件 .env.ops（watch.sh 读同一份，
# 后读的盖前面的）：
#   BACKUP_AGE_RECIPIENTS  必填，age 公钥（age1…），多个用空格分开
#   BACKUP_DIR             本地备份的根目录，缺省 /var/backups；备份写在 <BACKUP_DIR>/<项目名>/<日期>
#   BACKUP_OFFSITE         rclone 目标（如 remote:bucket/backups），写在 <BACKUP_OFFSITE>/<项目名>/<日期>；地域约束另记
#   COMPOSE_PROJECT        compose 项目名。部署目录是 /opt/wecom-sales-agent 时缺省 wecom-sales-agent；别的目录（旁路实例、
#                          本机演练）必须写明（旁路实例用它自己的 NAME），否则会导出线上的库、配上这个目录的 var/
#   AGENT_DB               库名，缺省 agent
#   ALERT_WEBHOOK_URL      失败告警的企微群机器人地址（等同密钥，一般写在 .env.ops）；不填只写 stderr
#   INSTANCE_LABEL         告警里的实例名（不写域名与 IP），缺省是项目名
# 本地和异地的路径都带项目名：旁路实例抄一份 .env.backup 跑，也不会盖掉线上同一天的备份。
#
# 恢复固定这几步（新集群上，每月演练一次）：
#   1) 在有私钥的机器上解密：age -d -i <私钥> -o agent.dump agent.dump.age（globals.sql、var.tar.gz 同样）
#   2) 起 db：compose 首次初始化时 roles.sh 建角色和库（.env.db 用新口令）
#   3) 以超级用户恢复，不加 --no-owner，属主保持 agent_owner：
#        docker compose -f deploy/compose.yml exec -T db pg_restore -U postgres -d agent --exit-on-error < agent.dump
#   4) 以 agent_owner 跑一次迁移（应为空操作）：docker compose -f deploy/compose.yml run --rm migrate
#   5) 解开 var/：tar -xzf var.tar.gz，并 chown -R 1000:1000 var（里面有恢复哨兵 restored-from-backup.json，第 7 步删它）
#   6) 确认 app 的 env 文件里的 CHANNEL_SECRETS_KEY 有备份时加密渠道凭据用的那把：库里每个账号的 key id
#        docker compose -f deploy/compose.yml exec -T db psql -U postgres -d agent -Atc "select key, secrets_key_id from channel_accounts"
#      都要在 CHANNEL_SECRETS_KEY 里（<id>:<密钥>，逗号隔开）；已轮换掉的从离线保管处取回。库里没有渠道账号就跳过这一步
#   7) 以 app 身份设恢复截止点（03 R7）：截止点之前的客户消息只补记进会话、不调模型、不回复，之前建的没发完的回复与到点的跟进取消，
#      涉及的会话加一条说明，最后删掉恢复哨兵：
#        docker compose -f deploy/compose.yml run --rm app node --import tsx src/cli/channel-account.ts restore-cutoff --tenant <slug> --until <时刻>
#      <时刻> 带时区（如 2026-10-09T03:00:00+08:00）：取旧实例最后一次正常回复的时刻，有告警时从「健康检查失败」「app 反复重启」
#      那一条往前推；拿不准就取恢复开始的时刻（写 now）。宁可漏回（顾问补）不重复回。不跑这一步，有启用的企微账号时应用以
#      channel_restore_pending 拒绝启动；企微状态没导入或已导出时命令什么都不做，哨兵由应用启动时删掉
#   8) 应用以 DB 模式启动（docker compose -f deploy/compose.yml up -d app），核对 /healthz 的 config
set -euo pipefail
umask 077

cd "${1:-$(dirname "$0")/..}"
# 每个部署目录都有应用的 .env（deploy.sh 部署前就查它），01 前后的版本都是
if [[ ! -f .env ]]; then
  echo "backup: $(pwd) 不是部署目录（缺 .env）。用法：backup.sh <部署目录>" >&2
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

# 6) 告警：任何一步失败都推一条（只有哪一步与退出码），成功时记下时刻供 watch.sh 查；推送失败不改变退出码
STEP='准备'
ROOT=''
TMP=''
json_escape() {
  local s=${1//\\/\\\\}
  printf '%s' "${s//\"/\\\"}"
}
notify() {
  local content resp rc
  content="[${INSTANCE_LABEL:-${COMPOSE_PROJECT:-wecom-sales-agent}}] $1 · $(date '+%F %T')"
  if [[ -z "${ALERT_WEBHOOK_URL:-}" ]]; then
    echo "backup: ⚠️ 没配 ALERT_WEBHOOK_URL，这条告警只记在这里：${content}" >&2
    return 0
  fi
  resp="$(curl -s -m 5 --retry 2 --retry-delay 1 --retry-connrefused -H 'content-type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$(json_escape "$content")\"}}" "$ALERT_WEBHOOK_URL" 2>/dev/null)"
  rc=$?
  if ((rc != 0)) || [[ "$resp" != *'"errcode":0'* ]]; then echo "backup: ⚠️ 告警没推出去（curl 退出码 ${rc}）：${content}" >&2; fi
  return 0
}
on_exit() {
  local rc=$?
  set +e
  [[ -n "$TMP" ]] && rm -rf "$TMP"
  if ((rc == 0)); then
    if [[ -n "$ROOT" && -d "$ROOT" ]]; then
      date +%s >"$ROOT/last-success.tmp" && mv "$ROOT/last-success.tmp" "$ROOT/last-success"
      if [[ -f "$ROOT/last-failure" ]]; then
        rm -f "$ROOT/last-failure"
        notify "已恢复：备份成功"
      fi
    fi
  else
    [[ -n "$ROOT" && -d "$ROOT" ]] && date +%s >"$ROOT/last-failure"
    notify "备份失败（${STEP}这一步，退出码 ${rc}），这次的备份不可用"
  fi
  exit "$rc"
}
trap on_exit EXIT

RECIPIENTS="${BACKUP_AGE_RECIPIENTS:?backup: 缺 BACKUP_AGE_RECIPIENTS（写在 .env.backup）}"
if [[ -z "${COMPOSE_PROJECT:-}" && "$(pwd)" != /opt/wecom-sales-agent ]]; then
  echo "backup: $(pwd) 不是线上部署目录，要在 .env.backup 里写明 COMPOSE_PROJECT" >&2
  exit 1
fi
PROJECT="${COMPOSE_PROJECT:-wecom-sales-agent}"
ROOT="${BACKUP_DIR:-/var/backups}/${PROJECT}"
DB="${AGENT_DB:-agent}"
command -v age >/dev/null || {
  echo "backup: 主机上没有 age" >&2
  exit 1
}

# 按项目名找 db 服务，不用 compose 文件（见开头）。在 / 下执行：否则 compose 会把当前目录里应用的 .env
# 当成它自己的变量文件去解析
dc() { (cd / && docker compose -p "$PROJECT" "$@"); }
alarm() { echo "backup: ⚠️ $*" >&2; }

DAY="$(date +%F)"
DEST="${ROOT}/${DAY}"
TMP="$(mktemp -d)"
mkdir -p "$DEST"
chmod 700 "$ROOT" "$DEST"

STEP='打包 var/'
# 1) 先打包 var/、再导出库（见开头）。哨兵在临时目录里摆成 var/restored-from-backup.json、用 -C 加进同一个归档，线上 var/ 不碰；
#    线上 var/ 里本来就有哨兵（恢复之后企微账号全部停用、哨兵留着）时归档里有两条同名的，解开时后面这条盖掉前面的
SENTINEL='restored-from-backup.json'
mkdir -p "$TMP/sentinel/var"
printf '{"backupAt":"%s"}\n' "$(date -u +%FT%TZ)" >"$TMP/sentinel/var/${SENTINEL}"
if [[ -d var ]]; then
  tar -czf "$TMP/var.tar.gz" var -C "$TMP/sentinel" "var/${SENTINEL}"
else
  alarm "部署目录里没有 var/，这次没备份会话与订单（归档里只有恢复哨兵）"
  tar -czf "$TMP/var.tar.gz" -C "$TMP/sentinel" "var/${SENTINEL}"
fi

STEP='导出'
# 2) 导出。先查两张配置表的行数，以及 02 的会话三张表、03 的渠道两张表里库里已有的（空格分开）：在导出之前查，导出之后才建的表
#    这次不要求
probe="$(dc exec -T db psql -U postgres -d "$DB" -Atc "select (select count(*) from sop_versions), (select count(*) from catalog_items), (select coalesce(string_agg(t, ' ' order by o), '') from unnest(array['conversations', 'messages', 'orders', 'channel_accounts', 'channel_inbox']) with ordinality as u(t, o) where to_regclass('public.' || t) is not null)")"
IFS='|' read -r sop_rows catalog_rows session_tables <<<"$probe"
dc exec -T db pg_dump -U postgres -Fc "$DB" >"$TMP/agent.dump"
dc exec -T db pg_dumpall -U postgres --globals-only --no-role-passwords >"$TMP/globals.sql"

STEP='校验'
# 3) 校验：这几张 RLS 表都有数据段（空表也有）；两张配置表不能是空的（受 RLS 约束的角色没设租户时导出来就是 0 行）
required=(memberships sop_versions catalog_items audit_log)
absent=()
for t in conversations messages orders channel_accounts channel_inbox; do
  if [[ " ${session_tables:-} " == *" ${t} "* ]]; then required+=("$t"); else absent+=("$t"); fi
done
if ((${#absent[@]})); then
  alarm "库里还没有 ${absent[*]}（02 或 03 的迁移没跑成？），这次不查它们的数据段，备份照做"
fi
toc="$(dc exec -T db pg_restore --list <"$TMP/agent.dump")"
for t in "${required[@]}"; do
  if ! grep -Eq "TABLE DATA public ${t} " <<<"$toc"; then
    alarm "导出里没有 ${t} 的 TABLE DATA，备份不可用"
    exit 1
  fi
done
if [[ "${sop_rows:-0}" == 0 || "${catalog_rows:-0}" == 0 ]]; then
  alarm "sop_versions ${sop_rows:-?} 行、catalog_items ${catalog_rows:-?} 行：有一张是空的，备份不可用"
  exit 1
fi

STEP='加密'
# 4) 加密，写进当天的目录；明文随临时目录一起删掉
age_args=()
for r in $RECIPIENTS; do age_args+=(-r "$r"); done
for f in agent.dump globals.sql var.tar.gz; do
  if [[ -f "$TMP/$f" ]]; then age "${age_args[@]}" -o "$DEST/$f.age" "$TMP/$f"; fi
done
echo "backup: ${DEST}（sop_versions ${sop_rows} 行，catalog_items ${catalog_rows} 行）"

# 本地保留 7 天：只清理按日期命名的目录
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' -mtime +7 -exec rm -rf {} +

STEP='异地复制'
# 5) 异地，保留 30 天
if [[ -z "${BACKUP_OFFSITE:-}" ]]; then
  alarm "没有配异地目标（BACKUP_OFFSITE），这份备份只在本机"
  exit 0
fi
command -v rclone >/dev/null || {
  alarm "配了 BACKUP_OFFSITE 但主机上没有 rclone"
  exit 1
}
OFFSITE="${BACKUP_OFFSITE}/${PROJECT}"
rclone copy "$DEST" "${OFFSITE}/${DAY}"
rclone delete --min-age 30d "$OFFSITE"
rclone rmdirs --leave-root "$OFFSITE"
echo "backup: 已复制到异地 ${OFFSITE}/${DAY}"
