#!/usr/bin/env bash
# 在应用库里建扩展：以超级用户经本地 socket 连应用库执行旁边的 extensions.sql，可重复执行。
#
# 只在 db 容器里跑，两种时机：
# - 首次初始化：roles.sh（compose 把它挂成 /docker-entrypoint-initdb.d/10-roles.sh）建完角色和库之后调用本脚本，库在才能连。
#   不另挂一个 20-extensions.sh：db 服务的挂载一变，下次 compose up 会重建线上的 db 容器；现在 compose.yml 的 db 服务原样不动。
#   文件必须带可执行位：roles.sh 直接执行它。
# - 现有线上库（07 之前建的）：第一次部署含迁移 0016 的版本之前，owner 手工执行一次，否则 migrate 服务报错、部署停在切换之前：
#   docker compose -f deploy/compose.yml exec db /db-init/extensions.sh
#   deploy.sh 先把 deploy/ 同步到服务器、再跑迁移，所以第一次部署在迁移那一步失败时，这个文件已经在部署目录里，执行上面这条再重新部署即可。
#
# 环境（db 容器的，来自 .env.db）：AGENT_DB 库名，缺省 agent；POSTGRES_USER 超级用户，缺省 postgres（本地 socket 是 trust，不用口令）。
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "extensions.sh 必须作为可执行文件运行（chmod +x），不能被 source" >&2
  return 1
fi
set -euo pipefail

sql="$(cd "$(dirname "$0")" && pwd)/extensions.sql"
[[ -f "$sql" ]] || sql=/db-init/extensions.sql
db="${AGENT_DB:-agent}"

psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$db" -f "$sql"
echo "extensions.sh: 完成：库 $db 里有 vector 扩展"
