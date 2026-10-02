#!/usr/bin/env bash
# 回滚前检查（02 spec「导入、导出与切换 · 回滚到 02 之前的镜像」）。在服务器上跑：deploy.sh 部署一个 02 之前的 tag、
# 以及健康检查失败后自动回滚到 :prev 之前，经 ssh 把本脚本交给 bash -s。
# 01 的镜像不认识 SESSION_STORE、不读库里的会话：真实会话在库里时（var/ 里有 sessions-in-db.json）回滚到它，
# 客户历史在应用里全部消失，那期间的新消息也不进库。所以目标是 02 之前的镜像（镜像里没有 src/store/pg-backend.ts）
# 而有这种风险时拒绝，并打印先回到文件存储的步骤；两个都是 02 之后的镜像时照常回滚。
#
# 用法：rollback-guard.sh <部署目录> <目标> [<compose 项目名>]
#   <目标> 是镜像名（如 wecom-sales-agent:prev）：看镜像里有没有 /app/src/store/pg-backend.ts；docker 出错、判断不了时按 02 之前算
#   <目标> 是 pre-02：调用方已经按 tag 的文件树判定它是 02 之前的（部署旧 tag 时镜像还没建）
# 退出码：0 照常回滚；3 拒绝（步骤打在 stderr）
set -u
dir="$1" target="$2" project="${3:-wecom-sales-agent}"

# 回滚到 02 之前的镜像有风险的情况，一条一行
risks=()
if [ -f "$dir/var/sessions-in-db.json" ]; then
  risks+=("数据目录里有 var/sessions-in-db.json：真实会话在库里（db 存储）")
fi
# 第 8 步在这里加第二条：正在运行的实例 /healthz 的 config.catalogVersioned 为 true（有条目版本大于 1，改过价之后回滚，
# 那期间发出的链接回来后按版本 1 显示旧价）。到时多一个宿主端口参数，curl 127.0.0.1:<端口>/healthz 判断
[ ${#risks[@]} -eq 0 ] && exit 0

if [ "$target" != pre-02 ]; then
  docker run --rm --entrypoint /bin/sh "$target" -c 'test -e /app/src/store/pg-backend.ts'
  case $? in
    0) exit 0 ;; # 02 之后的镜像：照常回滚
    1) ;;        # 镜像里没有 pg-backend.ts：02 之前的
    *) echo "rollback-guard: 看不出 ${target} 是不是 02 之前的镜像（docker 出错），按 02 之前处理" >&2 ;;
  esac
fi

dc="APP_CONTAINER=${project} docker compose -p ${project} -f deploy/compose.yml"
{
  echo "拒绝回滚：目标是 02 之前的镜像（没有 src/store/pg-backend.ts），而"
  for r in "${risks[@]}"; do echo "  - ${r}"; done
  echo "先用 02 的镜像回到文件存储，再部署旧 tag（在 ${dir} 下）："
  echo "  1. ${dc} stop app"
  echo "  2. install -d -o 1000 -g 1000 /root/sessions-keep-<日期>"
  echo "     ${dc} run --rm -v /root/sessions-keep-<日期>:/keep app \\"
  echo "       node --import tsx src/cli/export-sessions.ts --tenant <slug> --keep /keep --var /app/var"
  echo "     （退出码 0、删掉了 var/sessions-in-db.json 才算导出完）"
  echo "  3. .env 去掉 SESSION_STORE=db，${dc} up -d app，确认 /healthz 的 store.mode = file"
  echo "  4. 再部署旧 tag"
} >&2
exit 3
