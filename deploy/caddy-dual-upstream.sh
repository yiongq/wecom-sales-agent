#!/usr/bin/env bash
# 只读部署目录的 owner 确认开关；stdout 仅 0/1，不能输出 .env.ops 的其他内容。
# deploy.sh 经 ssh stdin 执行本地这份；容器演练使用自己的临时目录。
set -euo pipefail
cd "${1:?缺少部署目录}"
project="${2:?缺少 compose project}"
value=''
if [ -f .env.ops ]; then
  # 不 source 运维凭据；仅解析这个字面量，兼容 export、引号、注释和 CRLF。
  value=$(awk '
    { sub(/\r$/, "") }
    /^[ \t]*(export[ \t]+)?CADDY_DUAL_UPSTREAM[ \t]*=/ {
      sub(/^[^=]*=[ \t]*/, ""); sub(/[ \t]+#.*/, ""); sub(/[ \t]+$/, ""); value=$0
    }
    END { print value }
  ' .env.ops)
fi
case "$value" in
  1 | "'1'" | '"1"') mode=1 ;;
  *) mode=0 ;;
esac
if [ "$mode" = 0 ]; then
  echo 'Caddy 未确认双上游，本次不启用备用' >&2
  if ! standby=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=app-standby </dev/null); then
    echo '错误：无法确认 app-standby 是否运行，拒绝部署；旧应用未替换。' >&2
    exit 1
  fi
  if [ -n "$standby" ]; then
    echo '错误：Caddy 未确认双上游，但本项目已有 app-standby 运行，拒绝部署；按手册完成 Caddy 确认并设置 .env.ops 的 CADDY_DUAL_UPSTREAM=1，或先退回单容器。' >&2
    exit 1
  fi
fi
printf '%s\n' "$mode"
