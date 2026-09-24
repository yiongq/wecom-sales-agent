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
# 新容器与回滚容器共用同一套参数，只差镜像 tag。
# -p 绑 127.0.0.1：只让本机的 Caddy 反代进来。绑 0.0.0.0 时 docker-proxy 会绕过
# ufw 把 3210 直接暴露在公网明文 HTTP 上（后台免密时等于全网可读客户对话）。
# -e PORT=3200 放在 --env-file 之后强制生效：端口映射/HEALTHCHECK 都写死 3200，
# .env 里误改 PORT 会让容器"活着但外部完全不可达"，极难排查。
RUN_OPTS="-d --name ${NAME} -p 127.0.0.1:${HOST_PORT}:3200 -v ${REMOTE_DIR}/var:/app/var --env-file ${REMOTE_DIR}/.env -e PORT=3200 --restart unless-stopped"

# tsx 运行时不做类型检查：import 路径写错、类型对不上，要到容器启动（或客户发来消息）
# 才炸。rsync 之前先在本地拦住，别把坏代码推上去再靠回滚兜。
echo "[0/3] 本地 typecheck"
if ! pnpm -s typecheck; then
  echo "错误：typecheck 未通过，中止部署（服务器上什么都没动）。" >&2
  exit 1
fi

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
  # build 会把 ${NAME} 这个 tag 挪到新镜像上，旧镜像变成无名的 <none>，出事时无从回滚。
  # 先给「正在跑的容器」所用的镜像打 :prev——取容器的镜像而不是 :latest：上次部署若已回滚，
  # :latest 指向的是那个坏镜像，拿它当 :prev 等于把好镜像丢了。
  PREV_IMAGE=\$(docker container inspect --format '{{.Image}}' ${NAME} 2>/dev/null || true)
  if [ -n \"\$PREV_IMAGE\" ]; then docker tag \"\$PREV_IMAGE\" ${NAME}:prev; fi
  docker build -t ${NAME} .
  # 必须走 SIGTERM 而不是 docker rm -f（SIGKILL）：进程收到 SIGTERM 会先等进行中的
  # 企微回复发完（store.ts 停机钩子，最多 8s）再落盘退出，直接杀会让处理到一半的消息
  # 靠重启后重放兜底、丢掉去抖窗口里的会话变更。-t 10 必须大于那 8s，两处要一起改
  docker stop -t 10 ${NAME} 2>/dev/null || true
  docker rm ${NAME} 2>/dev/null || true
  docker run ${RUN_OPTS} ${NAME}
  docker ps --filter name=${NAME} --format '  {{.Names}}  {{.Status}}  {{.Ports}}'"

# 约 30s 内 /healthz 通过即视为起来了
health_ok() {
  for _ in $(seq 1 10); do
    if ssh "${SERVER}" "curl -fsS --max-time 3 http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null; then
      echo ""
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "[3/3] health check (http://127.0.0.1:${HOST_PORT}/healthz via ssh)"
if health_ok; then
  echo "OK. 部署成功。"
  exit 0
fi
echo "错误：健康检查失败——容器可能起来即崩。最近日志：" >&2
ssh "${SERVER}" "docker logs --tail 40 ${NAME}" >&2 || true

# 自动回滚到 :prev。新容器在 --restart unless-stopped 下只会反复崩溃重启，
# 不回滚的话企微回调全部 502，要一直停摆到有人手工修好重新部署。
# 无论回滚成败都以非零退出：这次部署本身是失败的，不能让调用方当成功。
echo "[rollback] 回滚到上一个镜像 ${NAME}:prev" >&2
if ! ssh "${SERVER}" "docker image inspect ${NAME}:prev >/dev/null 2>&1"; then
  echo "错误：服务器上没有 ${NAME}:prev（首次部署？），无法自动回滚，服务当前不可用！" >&2
  exit 1
fi
if ssh "${SERVER}" "set -e
  docker stop -t 10 ${NAME} 2>/dev/null || true
  docker rm ${NAME} 2>/dev/null || true
  docker run ${RUN_OPTS} ${NAME}:prev" >&2 && health_ok; then
  echo "已回滚到 ${NAME}:prev，服务恢复；新版本未上线，请排查上面的日志后重新部署。" >&2
else
  echo "错误：回滚后健康检查仍失败，服务当前不可用，需立即人工处理！" >&2
  ssh "${SERVER}" "docker logs --tail 40 ${NAME}" >&2 || true
fi
exit 1
