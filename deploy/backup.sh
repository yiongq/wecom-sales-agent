#!/usr/bin/env bash
# 每晚的备份（01 spec「构建与部署 · 备份与恢复」）。deploy.sh 每次部署都把本脚本装到部署目录之外的
# /usr/local/lib/<NAME>/backup.sh，宿主机 cron 跑那一份、把部署目录作为参数传进来，例如：
#   15 3 * * *  bash /usr/local/lib/wecom-sales-agent/backup.sh /opt/wecom-sales-agent >>/var/log/wecom-backup.log 2>&1
# 不让 cron 直接跑部署目录里的 deploy/backup.sh：用旧版本自己的 deploy.sh 回到 01 之前时，它的 rsync --delete 会删掉
# deploy/，而库和 var/ 仍要每晚备份。同样的原因，脚本不读 deploy/compose.yml，按 compose 项目名找 db 容器。
# 不给参数时取脚本所在仓库的根目录（在仓库里直接 bash deploy/backup.sh）。
#
# 1. 以超级用户在 db 容器里经本地 socket 导出：pg_dump -Fc，外加 pg_dumpall --globals-only --no-role-passwords。
#    主机上不存超级用户口令。不用任何受 RLS 约束的角色导出，也不加 --enable-row-security：没设租户时它会静默导出 0 行。
# 2. 校验：pg_restore --list 里四张 RLS 表都有 TABLE DATA；sop_versions、catalog_items 的行数为 0 就非零退出并告警。
# 3. var/（会话、订单、企微 cursor、客服二维码）打成 tar。
# 4. 两份都在离开本机前用 age 公钥加密，私钥不放在服务器上；明文只在 0700 的临时目录里短暂存在。
#    本地按日期建目录（0700），保留 7 天。
# 5. 异地副本经 rclone 复制到 BACKUP_OFFSITE，保留 30 天。没配异地目标时每次都在 stderr 告警，本地备份照常。
#
# 配置写在部署目录的 .env.backup（不进仓库，deploy.sh 的 rsync 不碰 .env*）：
#   BACKUP_AGE_RECIPIENTS  必填，age 公钥（age1…），多个用空格分开
#   BACKUP_DIR             本地备份的根目录，缺省 /var/backups；备份写在 <BACKUP_DIR>/<项目名>/<日期>
#   BACKUP_OFFSITE         rclone 目标（如 remote:bucket/backups），写在 <BACKUP_OFFSITE>/<项目名>/<日期>；地域约束另记
#   COMPOSE_PROJECT        compose 项目名。部署目录是 /opt/wecom-sales-agent 时缺省 wecom-sales-agent；别的目录（旁路实例、
#                          本机演练）必须写明（旁路实例用它自己的 NAME），否则会导出线上的库、配上这个目录的 var/
#   AGENT_DB               库名，缺省 agent
# 本地和异地的路径都带项目名：旁路实例抄一份 .env.backup 跑，也不会盖掉线上同一天的备份。
#
# 恢复固定这几步（新集群上，每月演练一次）：
#   1) 在有私钥的机器上解密：age -d -i <私钥> -o agent.dump agent.dump.age（globals.sql、var.tar.gz 同样）
#   2) 起 db：compose 首次初始化时 roles.sh 建角色和库（.env.db 用新口令）
#   3) 以超级用户恢复，不加 --no-owner，属主保持 agent_owner：
#        docker compose -f deploy/compose.yml exec -T db pg_restore -U postgres -d agent --exit-on-error < agent.dump
#   4) 以 agent_owner 跑一次迁移（应为空操作）：docker compose -f deploy/compose.yml run --rm migrate
#   5) 解开 var/：tar -xzf var.tar.gz，并 chown -R 1000:1000 var
#   6) 应用以 DB 模式启动（docker compose -f deploy/compose.yml up -d app），核对 /healthz 的 config
set -euo pipefail
umask 077

cd "${1:-$(dirname "$0")/..}"
# 每个部署目录都有应用的 .env（deploy.sh 部署前就查它），01 前后的版本都是
if [[ ! -f .env ]]; then
  echo "backup: $(pwd) 不是部署目录（缺 .env）。用法：backup.sh <部署目录>" >&2
  exit 1
fi
if [[ -f .env.backup ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.backup
  set +a
fi

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
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"
chmod 700 "$ROOT" "$DEST"

# 1) 导出
dc exec -T db pg_dump -U postgres -Fc "$DB" >"$TMP/agent.dump"
dc exec -T db pg_dumpall -U postgres --globals-only --no-role-passwords >"$TMP/globals.sql"

# 2) 校验：四张 RLS 表都有数据段；两张配置表不能是空的（受 RLS 约束的角色没设租户时导出来就是 0 行）
toc="$(dc exec -T db pg_restore --list <"$TMP/agent.dump")"
for t in memberships sop_versions catalog_items audit_log; do
  if ! grep -Eq "TABLE DATA public ${t} " <<<"$toc"; then
    alarm "导出里没有 ${t} 的 TABLE DATA，备份不可用"
    exit 1
  fi
done
counts="$(dc exec -T db psql -U postgres -d "$DB" -Atc 'select (select count(*) from sop_versions), (select count(*) from catalog_items)')"
IFS='|' read -r sop_rows catalog_rows <<<"$counts"
if [[ "${sop_rows:-0}" == 0 || "${catalog_rows:-0}" == 0 ]]; then
  alarm "sop_versions ${sop_rows:-?} 行、catalog_items ${catalog_rows:-?} 行：有一张是空的，备份不可用"
  exit 1
fi

# 3) var/
if [[ -d var ]]; then
  tar -czf "$TMP/var.tar.gz" var
else
  alarm "部署目录里没有 var/，这次没备份会话与订单"
fi

# 4) 加密，写进当天的目录；明文随临时目录一起删掉
age_args=()
for r in $RECIPIENTS; do age_args+=(-r "$r"); done
for f in agent.dump globals.sql var.tar.gz; do
  if [[ -f "$TMP/$f" ]]; then age "${age_args[@]}" -o "$DEST/$f.age" "$TMP/$f"; fi
done
echo "backup: ${DEST}（sop_versions ${sop_rows} 行，catalog_items ${catalog_rows} 行）"

# 本地保留 7 天：只清理按日期命名的目录
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' -mtime +7 -exec rm -rf {} +

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
