#!/usr/bin/env bash
# 一键部署：rsync 本地代码 → 服务器 docker build + run。
# 服务器上的 .env（智谱 key / 企微凭据）与 var/（会话订单数据）不受影响：
# rsync 显式排除它们，容器把 var/ 挂卷进去。
#
# 用法：bash deploy.sh
# 可用环境变量覆盖：SERVER / REMOTE_DIR / HOST_PORT
set -euo pipefail

# 永远以脚本所在目录为源目录。否则从别处（比如 $HOME）执行时，
# rsync 会把整个当前目录（含 ~/.ssh 等私密文件）推上服务器，且 --delete 会清掉远端代码。
cd "$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f package.json || ! -f Dockerfile ]]; then
  echo "错误：当前目录不是项目根目录（缺 package.json / Dockerfile），中止部署。" >&2
  exit 1
fi

# 服务器地址不进 git：写在 .deploy.env（已 gitignore），或用环境变量 SERVER 覆盖
[[ -f .deploy.env ]] && source .deploy.env
SERVER="${SERVER:?未设置 SERVER。写入 .deploy.env（如 SERVER=root@<服务器IP>）或以环境变量传入}"
REMOTE_DIR="${REMOTE_DIR:-/opt/wecom-sales-agent}"
HOST_PORT="${HOST_PORT:-3210}"   # 宿主端口（容器内固定 3200，3200 已被别的容器占用）
NAME=wecom-sales-agent

echo "[1/3] rsync -> ${SERVER}:${REMOTE_DIR} (exclude .env / var / .git / node_modules)"
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='var' \
  --exclude='scratchpad' \
  --exclude='.playwright-mcp' \
  --exclude='*.log' \
  ./ "${SERVER}:${REMOTE_DIR}/"

echo "[2/3] build + run on server (host ${HOST_PORT} -> container 3200)"
ssh "${SERVER}" "set -e; cd ${REMOTE_DIR}
  # .env 必须先于删旧容器检查：否则旧服务已被打下线，新容器又起不来
  if [ ! -f ${REMOTE_DIR}/.env ]; then
    echo '错误：服务器缺 ${REMOTE_DIR}/.env，先创建（参考 .env.example，至少配 LLM_API_KEY 与 ADMIN_PASS）' >&2
    exit 1
  fi
  # var/ 必须归容器内 node(1000) 所有：root 属主时应用写不进去，
  # 会话/订单只活在内存、重启即丢（且表面看不出任何异常）
  mkdir -p ${REMOTE_DIR}/var && chown -R 1000:1000 ${REMOTE_DIR}/var
  docker build -t ${NAME} .
  # 必须走 SIGTERM 而不是 docker rm -f（SIGKILL）：store 的退出 flush、企微
  # msgid 去重集的落盘都挂在退出钩子上，直接杀会丢掉去抖窗口里的会话变更，
  # 并让重启后的企微回调重复回复客户已经回过的消息
  docker stop -t 10 ${NAME} 2>/dev/null || true
  docker rm ${NAME} 2>/dev/null || true
  docker run -d --name ${NAME} \
    -p 127.0.0.1:${HOST_PORT}:3200 \
    -v ${REMOTE_DIR}/var:/app/var \
    --env-file ${REMOTE_DIR}/.env \
    -e PORT=3200 \
    --restart unless-stopped \
    ${NAME}
  docker ps --filter name=${NAME} --format '  {{.Names}}  {{.Status}}  {{.Ports}}'"
# -p 绑 127.0.0.1：只让本机的 Caddy 反代进来。绑 0.0.0.0 时 docker-proxy 会绕过
# ufw 把 3210 直接暴露在公网明文 HTTP 上（后台免密时等于全网可读客户对话）。
# -e PORT=3200 放在 --env-file 之后强制生效：端口映射/HEALTHCHECK 都写死 3200，
# .env 里误改 PORT 会让容器"活着但外部完全不可达"，极难排查。

echo "[3/3] health check (http://127.0.0.1:${HOST_PORT}/healthz via ssh)"
for i in $(seq 1 10); do
  if ssh "${SERVER}" "curl -fsS --max-time 3 http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null; then
    echo ""
    echo "OK. 部署成功。"
    exit 0
  fi
  sleep 2
done
echo "错误：健康检查失败——容器可能起来即崩。最近日志：" >&2
ssh "${SERVER}" "docker logs --tail 40 ${NAME}" >&2 || true
exit 1
