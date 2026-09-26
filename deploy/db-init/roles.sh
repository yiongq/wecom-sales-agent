#!/usr/bin/env bash
# 建 / 更新三个角色和库：以超级用户经本地 socket 执行旁边的 roles.sql（spec「数据库 · 角色 / DDL」），可重复执行。
#
# 只在 db 容器里跑，两种时机：
# - 首次初始化：compose 把本脚本单独挂成 /docker-entrypoint-initdb.d/10-roles.sh，空数据卷上由 entrypoint 执行一次。
#   文件必须带可执行位：entrypoint 执行可执行的 *.sh，不可执行的会被 source 进它自己的 shell（下面拒绝这种情况）。
# - 轮换口令：改服务器上 .env.db 里的口令 → docker compose up -d db（env 变了会重建容器）→
#   docker compose exec db /db-init/roles.sh。已存在的角色走 ALTER ROLE，只更新口令与属性；库已存在就跳过。
#
# compose 另把整个 db-init/ 挂到 /db-init，roles.sh 与 roles.sql 在那里并排。roles.sql 不能进 initdb.d：
# entrypoint 会把那里的 *.sql 直接交给 psql，没有口令变量必然失败。所以从钩子位置执行时旁边没有它，改取 /db-init/roles.sql。
#
# 环境（db 容器的，来自 .env.db）：AGENT_OWNER_PASSWORD、AGENT_APP_PASSWORD、AGENT_PLATFORM_PASSWORD 必填；
# AGENT_DB 库名，缺省 agent；POSTGRES_USER 超级用户，缺省 postgres（本地 socket 是 trust，不用口令）。
# 口令经 psql 的 \getenv 读入，不上命令行（ps 里看不到），也不回显。
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "roles.sh 必须作为可执行文件运行（chmod +x），不能被 source" >&2
  return 1
fi
set -euo pipefail

for v in AGENT_OWNER_PASSWORD AGENT_APP_PASSWORD AGENT_PLATFORM_PASSWORD; do
  if [[ -z "${!v:-}" ]]; then
    echo "roles.sh: 环境变量 $v 为空。写进服务器上的 .env.db，再 docker compose up -d db 让容器拿到它" >&2
    exit 1
  fi
done

sql="$(cd "$(dirname "$0")" && pwd)/roles.sql"
[[ -f "$sql" ]] || sql=/db-init/roles.sql
db="${AGENT_DB:-agent}"

psql_su() {
  psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres "$@"
}

# roles.sql 的约定：每条语句一行。已存在的角色把行首 CREATE ROLE 换成 ALTER ROLE，已存在的库删掉 CREATE DATABASE 那行
edits='' done_msg=''
roles_now="$(psql_su -At -c 'select rolname from pg_roles')"
while read -r r; do
  if grep -qxF "$r" <<<"$roles_now"; then
    edits+="s/^CREATE ROLE $r /ALTER ROLE $r /;"
    done_msg+=" 更新 $r"
  else
    done_msg+=" 新建 $r"
  fi
done < <(sed -nE 's/^CREATE ROLE ([a-z_]+) .*/\1/p' "$sql")
if psql_su -At -c 'select datname from pg_database' | grep -qxF "$db"; then
  edits+='/^CREATE DATABASE /d;'
  done_msg+="；库 $db 已存在"
else
  done_msg+="；新建库 $db"
fi

# terse：出错时不带「LINE 1: …」的语句摘录；log_min_error_statement：出错的语句不写进服务端日志（docker logs）。
# 两者都是为了失败时口令不外露
{
  printf '%s\n' '\set VERBOSITY terse' 'SET log_min_error_statement = panic;' \
    '\getenv owner_password AGENT_OWNER_PASSWORD' \
    '\getenv app_password AGENT_APP_PASSWORD' \
    '\getenv platform_password AGENT_PLATFORM_PASSWORD'
  sed "$edits" "$sql"
} | psql_su -v db_name="$db"
echo "roles.sh: 完成：${done_msg# }"
