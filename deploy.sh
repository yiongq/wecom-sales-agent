#!/usr/bin/env bash
# 按 git tag 部署：git archive <tag> → 归档目录里跑四个门禁 → 查服务器 .env → rsync → 服务器上 build →
# 换容器 → 健康检查（revision 必须等于这个 tag），失败回滚到 :prev。
# 线上跑的每一版都是一个提交过、过了四个门禁的 tag；工作区里未提交的改动永远上不了线。
# 服务器上的 .env（智谱 key / 企微凭据）与 var/（会话、订单、客服二维码）不受影响：
# rsync 既不发送也不删除它们，容器把 var/ 挂卷进去。
#
# 用法：bash deploy.sh <tag>        （tag 必须是本地已有的 refs/tags/<tag>；分支名、提交号、~1 这类写法都不收）
# 可用环境变量覆盖：SERVER / REMOTE_DIR / HOST_PORT / NAME（优先于 .deploy.env）。
# 旁路实例（在同一台服务器上演练回滚，不打断线上 demo）：NAME、REMOTE_DIR、HOST_PORT 三个必须同时换成和线上不同的值，
# 它的 .env 不能配企微凭据，否则会和线上实例抢同一个客服账号的消息。两条脚本都会检查
set -euo pipefail

# 永远以脚本所在目录为仓库目录：git archive 读的是这里的 tag
cd "$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f package.json || ! -f Dockerfile ]]; then
  echo "错误：当前目录不是项目根目录（缺 package.json / Dockerfile），中止部署。" >&2
  exit 1
fi

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "用法：bash deploy.sh <tag>（本地已有的 git tag）" >&2
  exit 1
fi
# 只收精确的 tag 名：rev-parse 会把「v1~1」「v1^」解析成没打 tag 的祖先提交；字符集也限死，
# 因为 tag 会被拼进服务器上 root shell 的命令里
if [[ ! "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || ! git show-ref --verify -q "refs/tags/${TAG}"; then
  echo "错误：${TAG} 不是本地已有的 tag（只收字母、数字和 ._-）。只按 tag 部署，分支名和提交号都不收（先 git tag <名字> <提交> 再部署）。" >&2
  exit 1
fi

# 服务器地址不进 git：写在 .deploy.env（已 gitignore），或用环境变量覆盖。环境变量优先：先记下，读完文件再盖回去
ENV_SERVER="${SERVER:-}" ENV_REMOTE_DIR="${REMOTE_DIR:-}" ENV_HOST_PORT="${HOST_PORT:-}" ENV_NAME="${NAME:-}"
[[ -f .deploy.env ]] && source .deploy.env
[[ -n "$ENV_SERVER" ]] && SERVER="$ENV_SERVER"
[[ -n "$ENV_REMOTE_DIR" ]] && REMOTE_DIR="$ENV_REMOTE_DIR"
[[ -n "$ENV_HOST_PORT" ]] && HOST_PORT="$ENV_HOST_PORT"
[[ -n "$ENV_NAME" ]] && NAME="$ENV_NAME"
SERVER="${SERVER:?未设置 SERVER。写入 .deploy.env（如 SERVER=root@<服务器IP>）或以环境变量传入}"
LIVE_NAME=wecom-sales-agent LIVE_DIR=/opt/wecom-sales-agent LIVE_PORT=3210 # 线上 demo 实例（宿主 3200 已被别的容器占用）
REMOTE_DIR="${REMOTE_DIR:-$LIVE_DIR}"
HOST_PORT="${HOST_PORT:-$LIVE_PORT}"
NAME="${NAME:-$LIVE_NAME}"

# 三个里只改了一两个，旁路演练就会打到线上：忘了 NAME 会用演练的镜像换掉线上容器，
# 忘了 REMOTE_DIR 会把演练的代码同步进线上目录、和线上容器共用 var/ 与企微凭据
SIDE=0
if [[ "$NAME" != "$LIVE_NAME" || "$REMOTE_DIR" != "$LIVE_DIR" || "$HOST_PORT" != "$LIVE_PORT" ]]; then
  if [[ "$NAME" == "$LIVE_NAME" || "$REMOTE_DIR" == "$LIVE_DIR" || "$HOST_PORT" == "$LIVE_PORT" ]]; then
    echo "错误：旁路实例要同时换 NAME、REMOTE_DIR、HOST_PORT，三个都不能等于线上的值（现在：${NAME} ${REMOTE_DIR} ${HOST_PORT}）。" >&2
    exit 1
  fi
  SIDE=1
fi
echo "目标：${NAME} @ ${SERVER}:${REMOTE_DIR}，宿主端口 ${HOST_PORT}$([[ $SIDE == 1 ]] && echo '（旁路实例）')"

# 新容器与回滚容器共用同一套参数，只差镜像 tag。
# -p 绑 127.0.0.1：只让本机的 Caddy 反代进来。绑 0.0.0.0 时 docker-proxy 会绕过
# ufw 把 3210 直接暴露在公网明文 HTTP 上（后台免密时等于全网可读客户对话）。
# -e PORT=3200 放在 --env-file 之后强制生效：端口映射/HEALTHCHECK 都写死 3200，
# .env 里误改 PORT 会让容器"活着但外部完全不可达"，极难排查。
RUN_OPTS="-d --name ${NAME} -p 127.0.0.1:${HOST_PORT}:3200 -v ${REMOTE_DIR}/var:/app/var --env-file ${REMOTE_DIR}/.env -e PORT=3200 --restart unless-stopped"

# 1) 归档：只取 tag 里提交过的文件。目录权限改成 755：rsync -a 会把源目录的权限带到 REMOTE_DIR 上，mktemp 给的是 700
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
chmod 755 "$BUILD_DIR"
echo "[1/6] git archive ${TAG} -> ${BUILD_DIR}"
git archive "refs/tags/${TAG}" | tar -x -C "$BUILD_DIR"

# 2) 四个门禁在归档目录里跑：查的是要部署的这一版，不是本地工作区。任何一个失败就中止，服务器上什么都不动
echo "[2/6] 归档目录里安装依赖并跑四个门禁"
if ! (cd "$BUILD_DIR" && pnpm install --frozen-lockfile >/dev/null && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test); then
  echo "错误：${TAG} 没过四个门禁，中止部署（服务器上什么都没动）。" >&2
  exit 1
fi

# 3) 先查服务器 .env 再同步（只读）。运行时不设 profile 会按 demo 跑，生产实例忘了配就成了 demo
# （匿名可付款、「重置」连已付订单一起删），所以防线放在这里。按 docker --env-file 的读法取值：
# 行首空白去掉、按第一个 = 分开、值原样（只去行尾 CR）、同名以最后一行为准——值带引号或空格，容器会拒绝启动
echo "[3/6] 检查 ${SERVER}:${REMOTE_DIR}/.env"
if ! ssh "${SERVER}" bash -s -- "$REMOTE_DIR" "$SIDE" <<'CHECK'; then
set -u
env_file="$1/.env"
if [ ! -f "$env_file" ]; then
  echo "服务器缺 $env_file" >&2
  exit 1
fi
val=$(awk '{ sub(/^[ \t]+/, ""); sub(/\r$/, "") } /^DEPLOY_PROFILE=/ { v = substr($0, 16) } END { print v }' "$env_file")
case "$val" in
  demo | prod) ;;
  *) echo "$env_file 里的 DEPLOY_PROFILE 必须正好是 demo 或 prod（不带引号和空格），现在是「$val」" >&2; exit 1 ;;
esac
if [ "$2" = 1 ] && grep -Eq '^[[:space:]]*WECOM_[A-Z_]*=[^[:space:]]' "$env_file"; then
  echo "旁路实例的 $env_file 配了企微凭据，会和线上实例抢同一个客服账号的消息" >&2
  exit 1
fi
CHECK
  echo "错误：服务器 .env 没过检查，中止部署（服务器上什么都没动）。新实例先创建 .env（参考 .env.example，至少配 LLM_API_KEY、ADMIN_PASS 与 DEPLOY_PROFILE）。" >&2
  exit 1
fi

# 4) 同步。--checksum：git archive 把所有文件的修改时间都设成提交时间，按「大小 + 修改时间」可能漏掉改过的文件。
# P 规则保护服务器上本来就有的东西不被 --delete 删掉：.env 与它的备份、var/、日志、万一有的 .git/
echo "[4/6] rsync ${TAG} -> ${SERVER}:${REMOTE_DIR}（不动 .env* / var / *.log / .git）"
rsync -az --checksum --delete \
  --filter='P /.env*' --filter='P /var/' --filter='P *.log' --filter='P /.git/' \
  --exclude='node_modules' --exclude='/.env' --exclude='/var/' \
  "$BUILD_DIR/" "${SERVER}:${REMOTE_DIR}/"

# 5) 构建，旧容器此时还在跑。失败就中止：线上照旧，只多了一个 :prev 标签
echo "[5/6] 服务器上构建镜像（revision ${TAG}），并用新镜像试读 .env"
if ! ssh "${SERVER}" "set -e; cd ${REMOTE_DIR}
  # var/ 必须归容器内 node(1000) 所有：root 属主时应用写不进去，
  # 会话/订单只活在内存、重启即丢（且表面看不出任何异常）
  mkdir -p ${REMOTE_DIR}/var && chown -R 1000:1000 ${REMOTE_DIR}/var
  # build 会把 ${NAME} 这个 tag 挪到新镜像上，旧镜像变成无名的 <none>，出事时无从回滚。
  # 先给「正在跑的容器」所用的镜像打 :prev——取容器的镜像而不是 :latest：上次部署若已回滚，
  # :latest 指向的是那个坏镜像，拿它当 :prev 等于把好镜像丢了。
  PREV_IMAGE=\$(docker container inspect --format '{{.Image}}' ${NAME} 2>/dev/null || true)
  if [ -n \"\$PREV_IMAGE\" ]; then docker tag \"\$PREV_IMAGE\" ${NAME}:prev; fi
  docker build --build-arg APP_REVISION=${TAG} -t ${NAME} .
  # docker 自己解析 env 文件（格式不对就报错）。在停掉旧容器之前试一次，别等旧容器没了 docker run 才失败
  docker run --rm --env-file ${REMOTE_DIR}/.env --entrypoint /bin/true ${NAME}"; then
  echo "错误：构建或 .env 试读失败，中止部署（旧容器照常运行）。" >&2
  exit 1
fi

# 约 30s 内 /healthz 通过即视为起来了。给了 revision 时还要对得上：打错实例或新容器没换上，不能报成功
health_ok() {
  local want="${1:-}" body
  for _ in $(seq 1 10); do
    if body=$(ssh "${SERVER}" "curl -fsS --max-time 3 http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null); then
      if [[ -z "$want" || "$body" == *"\"revision\":\"${want}\""* ]]; then
        echo "$body"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

# 6) 换容器。必须走 SIGTERM 而不是 docker rm -f（SIGKILL）：进程收到 SIGTERM 会先等进行中的
# 企微回复发完（store.ts 停机钩子，最多 8s）再落盘退出，直接杀会让处理到一半的消息
# 靠重启后重放兜底、丢掉去抖窗口里的会话变更。-t 10 必须大于那 8s，两处要一起改
echo "[6/6] 换容器并做健康检查（http://127.0.0.1:${HOST_PORT}/healthz via ssh，revision 应为 ${TAG}）"
if ssh "${SERVER}" "docker stop -t 10 ${NAME} 2>/dev/null || true
  docker rm ${NAME} 2>/dev/null || true
  docker run ${RUN_OPTS} ${NAME} >/dev/null
  docker ps --filter name=^/${NAME}\$ --format '  {{.Names}}  {{.Status}}  {{.Ports}}'" && health_ok "$TAG"; then
  echo "OK. ${TAG} 部署成功。"
  exit 0
fi
echo "错误：换容器或健康检查失败——容器可能起来即崩。最近日志：" >&2
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
  echo "已回滚到 ${NAME}:prev（/healthz 的 revision 是上一版的 tag），服务恢复；${TAG} 未上线，请排查上面的日志后重新部署。" >&2
else
  echo "错误：回滚后健康检查仍失败，服务当前不可用，需立即人工处理！" >&2
  ssh "${SERVER}" "docker logs --tail 40 ${NAME}" >&2 || true
fi
exit 1
