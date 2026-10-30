#!/usr/bin/env bash
# 按 git tag 部署：git archive <tag> → 归档目录里跑四个门禁 → 查服务器 .env → rsync → 服务器上 build →
# 换容器（docker compose：先拉起 db、跑迁移，再换 app）→ 健康检查（revision 必须等于这个 tag），失败回滚到 :prev（不跑迁移）。
# 线上跑的每一版都是一个提交过、过了四个门禁的 tag；工作区里未提交的改动永远上不了线。
# 回到 02 之前的镜像（部署旧 tag、自动回滚到 :prev）之前先过 deploy/rollback-guard.sh：会话在库里时拒绝，先回到文件存储；
# 改过上架条目的内容时拒绝，只能用 02 之后的镜像。
# 回到 03 之前的镜像而渠道状态在库里时也拒绝，先用当前镜像 channel-export。
# 回到 04 之前的镜像而待生效品牌或当前发布品牌快照非空时也拒绝，按两种品牌状态打印恢复步骤。
# 回到 05 之前的镜像而有多租户或沙箱风险时也拒绝，先按提示清理再重跑检查。
# 回到 07 之前的镜像而有退款订单或无法确认时也拒绝，先按提示确认并处理。
# 回到 08 之前的镜像而有非旅游数据或无法确认时也拒绝，先清理并确认四项都为零。
# 服务器上的 .env*（应用、db、migrate、platform 各一份，见 deploy/compose.yml 开头）与 var/（会话、订单、客服二维码）不受影响：
# rsync 既不发送也不删除它们，app 容器把 var/ 挂卷进去。数据库在 compose 的数据卷里，部署不碰它。
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
# 这个脚本按 compose 部署。tag 里没有 compose 与迁移（01 之前的版本）时，要到第 6 步才失败，
# 而第 4 步的 rsync --delete 已经把服务器上的 deploy/、drizzle/ 删掉了。在碰服务器之前拦下
for f in deploy/compose.yml src/db/migrate.ts; do
  if ! git cat-file -e "refs/tags/${TAG}:${f}" 2>/dev/null; then
    echo "错误：${TAG} 里没有 ${f}，是换成 compose 之前的版本，这个 deploy.sh 部署不了它（服务器上什么都没动）。回到文件模式或更早的版本见 README「部署」一节。" >&2
    exit 1
  fi
done

# 服务器地址不进 git：写在 .deploy.env（已 gitignore），或用环境变量覆盖。环境变量优先：先记下，读完文件再盖回去
ENV_SERVER="${SERVER:-}" ENV_REMOTE_DIR="${REMOTE_DIR:-}" ENV_HOST_PORT="${HOST_PORT:-}" ENV_NAME="${NAME:-}" ENV_SANDBOX_PORT="${SANDBOX_PORT:-}"
[[ -f .deploy.env ]] && source .deploy.env
[[ -n "$ENV_SERVER" ]] && SERVER="$ENV_SERVER"
[[ -n "$ENV_REMOTE_DIR" ]] && REMOTE_DIR="$ENV_REMOTE_DIR"
[[ -n "$ENV_HOST_PORT" ]] && HOST_PORT="$ENV_HOST_PORT"
[[ -n "$ENV_NAME" ]] && NAME="$ENV_NAME"
[[ -n "$ENV_SANDBOX_PORT" ]] && SANDBOX_PORT="$ENV_SANDBOX_PORT"
SERVER="${SERVER:?未设置 SERVER。写入 .deploy.env（如 SERVER=root@<服务器IP>）或以环境变量传入}"
LIVE_NAME=wecom-sales-agent LIVE_DIR=/opt/wecom-sales-agent LIVE_PORT=3210 # 线上 demo 实例（宿主 3200 已被别的容器占用）
REMOTE_DIR="${REMOTE_DIR:-$LIVE_DIR}"
HOST_PORT="${HOST_PORT:-$LIVE_PORT}"
NAME="${NAME:-$LIVE_NAME}"

# 这三个会拼进服务器上 root shell 的命令，字符集限死；写法也要唯一，否则「/opt/wecom-sales-agent/」「03210」这种等价写法
# 能绕过下面「和线上不同」的比较
if [[ ! "$NAME" =~ ^[a-z0-9][a-z0-9_.-]*$ || ! "$HOST_PORT" =~ ^[1-9][0-9]{0,4}$ ]] ||
  [[ ! "$REMOTE_DIR" =~ ^(/[A-Za-z0-9_][A-Za-z0-9._-]*)+$ || "$REMOTE_DIR" == *"/."* ]]; then
  echo "错误：NAME / REMOTE_DIR / HOST_PORT 写法不对（现在：${NAME} ${REMOTE_DIR} ${HOST_PORT}）。目录写绝对路径、不带结尾斜杠和 . 段，端口不带前导 0。" >&2
  exit 1
fi

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

# 容器的参数（只绑 127.0.0.1、PORT 写死 3200、var/ 挂卷、停机宽限 10 秒）都在 deploy/compose.yml 的 app 服务里。
# 项目名、容器名用 NAME，宿主端口用 HOST_PORT：旁路实例因此有自己的 compose 项目、数据库卷和容器名，碰不到线上。
# 新版本与回滚只差 APP_IMAGE
compose() { echo "cd ${REMOTE_DIR} && APP_IMAGE=$1 APP_CONTAINER=${NAME} HOST_PORT=${HOST_PORT} docker compose -p ${NAME} -f deploy/compose.yml"; }
# 回滚前检查（02、03「导入、导出与切换」、04 R14、05 R18、07 R20、08 R13、09 R15、10 R17、12 R14）：旧镜像不认识库里的数据或部署状态时拒绝。
# 判断在服务器上做（deploy/rollback-guard.sh 经 ssh 交给 bash -s）；$1 是镜像名，或 pre-02 到 pre-12 的档位（已按 tag 文件树判定）。
# 用的是本地这份脚本：02 之前的 tag 里没有它。项目名与宿主端口传进去：打印的手工命令要带上（旁路实例不能去抢线上的端口）。
# 拒绝的退出码为 3–9，下面的提示按它分开写：3 只有会话在库里（先回到文件存储就能回滚，步骤打在上面）；4 有条目版本大于 1
# 或看不出来（回到文件存储也去不掉，只能用 02 之后的镜像）；5 渠道状态在库里，先 channel-export。
# 6 有品牌风险，按上面打印的品牌状态与部署路径恢复。
# 7 有多租户或沙箱风险；8 有退款订单风险；9 有非旅游数据、报价审批、工业数据或附件风险。按上面打印的步骤确认并处理，检查通过后再部署或回滚。
guard_rollback() { ssh "${SERVER}" bash -s -- "$REMOTE_DIR" "$1" "$NAME" "$HOST_PORT" <deploy/rollback-guard.sh; }
# 05 以前只核对 revision；目标镜像判断失败从严按 pre-05 处理。
pre05_image() { ssh "${SERVER}" "timeout --kill-after=2s 8s docker run --rm --entrypoint /bin/sh $1 -c 'test -e /app/src/tenancy/runtime.ts'"; }
sandbox_compose() { echo "cd ${REMOTE_DIR} && APP_IMAGE=$1 APP_CONTAINER=${NAME} HOST_PORT=${HOST_PORT} SANDBOX_PORT=${SANDBOX_PORT} docker compose -p ${NAME} -f deploy/compose.yml --profile sandbox"; }

# 1) 归档：只取 tag 里提交过的文件。目录权限改成 755：rsync -a 会把源目录的权限带到 REMOTE_DIR 上，mktemp 给的是 700
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
chmod 755 "$BUILD_DIR"
echo "[1/7] git archive ${TAG} -> ${BUILD_DIR}"
git archive "refs/tags/${TAG}" | tar -x -C "$BUILD_DIR"

# 2) 四个门禁在归档目录里跑：查的是要部署的这一版，不是本地工作区。任何一个失败就中止，服务器上什么都不动
echo "[2/7] 归档目录里安装依赖并跑四个门禁"
if ! (cd "$BUILD_DIR" && pnpm install --frozen-lockfile >/dev/null && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test); then
  echo "错误：${TAG} 没过四个门禁，中止部署（服务器上什么都没动）。" >&2
  exit 1
fi

# 3) 先查服务器 .env 再同步（只读）。运行时不设 profile 会按 demo 跑，生产实例忘了配就成了 demo
# （匿名可付款、「重置」连已付订单一起删），所以防线放在这里。按 docker --env-file 的读法取值（compose 以 format: raw
# 读 env 文件，同一个解析器）：行首空白去掉、按第一个 = 分开、值原样（只去行尾 CR）、同名以最后一行为准——值带引号或空格，容器会拒绝启动
echo "[3/7] 检查 ${SERVER}:${REMOTE_DIR}/.env"
if ! ssh "${SERVER}" bash -s -- "$REMOTE_DIR" "$SIDE" <<'CHECK'; then
set -u
env_file="$1/.env"
# compose 的 db、migrate 各有自己的 env 文件（app 的 .env 里不能有 owner 与超级用户的口令）；platform 的只有跑命令行时才用
for f in "$env_file" "$1/.env.db" "$1/.env.migrate"; do
  if [ ! -f "$f" ]; then
    echo "服务器缺 ${f}（写法见 deploy/compose.yml 开头）" >&2
    exit 1
  fi
done
env_val() { awk -v k="$1=" '{ sub(/^[ \t]+/, ""); sub(/\r$/, "") } index($0, k) == 1 { v = substr($0, length(k) + 1) } END { print v }' "$2" </dev/null; }
val=$(env_val DEPLOY_PROFILE "$env_file")
case "$val" in
  demo | prod) ;;
  *) echo "$env_file 里的 DEPLOY_PROFILE 必须正好是 demo 或 prod（不带引号和空格），现在是「${val}」" >&2; exit 1 ;;
esac
# .env.db 缺口令或设了 POSTGRES_DB，db 首次初始化就会留下一个没有角色（或属主不对）的库：roles.sh 失败时 initdb 已经做完，
# entrypoint 之后见库已存在就不再跑它，改好 .env.db 重新部署也照样失败
for k in POSTGRES_PASSWORD AGENT_OWNER_PASSWORD AGENT_APP_PASSWORD AGENT_PLATFORM_PASSWORD; do
  if [ -z "$(env_val "$k" "$1/.env.db")" ]; then
    echo "$1/.env.db 里的 $k 没写或为空（写法见 deploy/compose.yml 开头）" >&2
    exit 1
  fi
done
if [ -n "$(env_val POSTGRES_DB "$1/.env.db")" ]; then
  echo "$1/.env.db 不能设 POSTGRES_DB（原因见 deploy/compose.yml 开头）" >&2
  exit 1
fi
if [ "$2" = 1 ] && grep -Eq '^[[:space:]]*WECOM_(CORP_ID|APP_SECRET|KF_OPEN_KFID)=[^[:space:]]' "$env_file" </dev/null; then
  echo "旁路实例的 $env_file 配了企微凭据，会和线上实例抢同一个客服账号的消息" >&2
  exit 1
fi
CHECK
  echo "错误：服务器 .env 没过检查，中止部署（服务器上什么都没动）。新实例先创建 .env（参考 .env.example，至少配 LLM_API_KEY、ADMIN_PASS 与 DEPLOY_PROFILE），以及 .env.db、.env.migrate（见 deploy/compose.yml 开头）。" >&2
  exit 1
fi
# 按 tag 文件树判定旧镜像，保留更早的检查：pre-02 → pre-03 → pre-04。在 rsync 之前拦下。
rollback_target=""
# 分开检查命令状态与文件是否存在，不能把 git 查询失败当作一个可放行的旧 tag。
industrial_tree=$(git ls-tree -r --name-only "refs/tags/${TAG}" -- src/packs/industrial/runtime.ts) || {
  echo "错误：无法确认 ${TAG} 是否含 10，拒绝部署（服务器上什么都没动）。" >&2
  echo "前滚修复，或者回滚到另一个含 10 的 tag" >&2
  exit 1
}
attachment_tree=$(git ls-tree -r --name-only "refs/tags/${TAG}" -- src/core/attachments.ts) || {
  echo "错误：无法确认 ${TAG} 是否含 12，拒绝部署（服务器上什么都没动）。" >&2
  echo "前滚修复，或者回滚到另一个含 12 的 tag" >&2
  exit 1
}
if ! git cat-file -e "refs/tags/${TAG}:src/store/pg-backend.ts" 2>/dev/null; then
  rollback_target=pre-02
elif ! git cat-file -e "refs/tags/${TAG}:src/channels/registry.ts" 2>/dev/null; then
  rollback_target=pre-03
elif ! git cat-file -e "refs/tags/${TAG}:src/core/pack-api.ts" 2>/dev/null; then
  rollback_target=pre-04
elif ! git cat-file -e "refs/tags/${TAG}:src/tenancy/runtime.ts" 2>/dev/null; then
  rollback_target=pre-05
elif ! git cat-file -e "refs/tags/${TAG}:drizzle/0015_order_refund_status.sql" 2>/dev/null; then
  rollback_target=pre-07
elif ! git cat-file -e "refs/tags/${TAG}:src/core/order-view.ts" 2>/dev/null; then
  rollback_target=pre-08
elif ! git ls-tree -r --name-only "refs/tags/${TAG}" -- src/core/site-links.ts | grep -qx 'src/core/site-links.ts'; then
  rollback_target=pre-09
elif ! printf '%s\n' "$industrial_tree" | grep -qx 'src/packs/industrial/runtime.ts'; then
  rollback_target=pre-10
elif ! printf '%s\n' "$attachment_tree" | grep -qx 'src/core/attachments.ts'; then
  rollback_target=pre-12
fi
if [ -n "$rollback_target" ]; then
  guard_rollback "$rollback_target" || {
    case $? in
      3) echo "错误：${TAG} 是 02 之前的版本，拒绝部署（服务器上什么都没动）。会话在库里：按上面的步骤先回到文件存储，再部署它。" >&2 ;;
      4) echo "错误：${TAG} 是 02 之前的版本，拒绝部署（服务器上什么都没动）。改过上架条目的内容（或看不出改没改过）：回到 02 之前的镜像会让已发出的方案书链接显示旧价，只能部署 02 之后的 tag。" >&2 ;;
      5) echo "错误：${TAG} 是 03 之前的版本，拒绝部署（服务器上什么都没动）。渠道状态在库里：按上面的步骤先 channel-export，再部署它。" >&2 ;;
      6) echo "错误：${TAG} 是 04 之前的版本，拒绝部署（服务器上什么都没动）。有品牌风险：按上面对应品牌状态的步骤恢复，检查通过后再部署它。" >&2 ;;
      8) echo "错误：${TAG} 是 07 之前的版本，退款订单回滚检查拒绝部署（服务器上什么都没动）。按上面提示确认并处理后重试。" >&2 ;;
      9) echo "错误：${TAG} 是旧版本，非旅游数据、报价单、工业数据或附件回滚检查拒绝部署（服务器上什么都没动）。按上面的步骤处理后重试。" >&2 ;;
      7) echo "错误：${TAG} 是 05 之前的版本，拒绝部署（服务器上什么都没动）。按上面对应原因的步骤检查与处理，检查通过后再部署它。" >&2 ;;
      *) echo "错误：${TAG} 是旧版本，回滚前检查没跑完，拒绝部署（服务器上什么都没动）。" >&2 ;;
    esac
    exit 1
  }
fi
# 以文件是否存在为准；无文件时不启用 profile，也不改变宿主与备份路径。
SANDBOX_ENABLED=$(ssh "${SERVER}" "if [ -f ${REMOTE_DIR}/.env.sandbox ]; then echo 1; else echo 0; fi")
case "$SANDBOX_ENABLED" in 0 | 1) ;; *) echo "错误：无法确认沙箱是否启用，中止部署。" >&2; exit 1 ;; esac
SANDBOX_PORT="${SANDBOX_PORT:-3211}"
if [ "$SANDBOX_ENABLED" = 1 ] && { [[ ! "$SANDBOX_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || ((SANDBOX_PORT > 65535)) || [[ "$SANDBOX_PORT" = "$HOST_PORT" ]]; }; then
  echo "错误：SANDBOX_PORT 必须是与 HOST_PORT 不同的有效端口。" >&2
  exit 1
fi

# 4) 同步。--checksum：git archive 把所有文件的修改时间都设成提交时间，按「大小 + 修改时间」可能漏掉改过的文件。
# P 规则保护服务器上本来就有的东西不被 --delete 删掉：.env 与它的备份、var/、日志、万一有的 .git/
echo "[4/7] rsync ${TAG} -> ${SERVER}:${REMOTE_DIR}（不动 .env* / var / *.log / .git）"
rsync -az --checksum --delete \
  --filter='P /.env*' --filter='P /var/' --filter='P *.log' --filter='P /.git/' \
  --exclude='node_modules' --exclude='/.env' --exclude='/var/' \
  "$BUILD_DIR/" "${SERVER}:${REMOTE_DIR}/"

# 5) 构建，旧容器此时还在跑。失败就中止：线上照旧，只多了一个 :prev 标签
echo "[5/7] 服务器上构建镜像（revision ${TAG}），并用新镜像试读 .env"
if [ "$SANDBOX_ENABLED" = 1 ]; then
  # 只接受明确赋值，避免 docker 与 compose 对裸变量采用不同来源；错误只报行号。
  if ! ssh "${SERVER}" bash -s -- "${REMOTE_DIR}/.env.sandbox" <<'SANDBOX_ENV'
awk '
  { sub(/\r$/, ""); sub(/^[ \t]+/, "") }
  $0 == "" || substr($0, 1, 1) == "#" { next }
  {
    eq = index($0, "=")
    name = eq > 1 ? substr($0, 1, eq - 1) : ""
    if (eq < 2 || name !~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
      printf "sandbox_env_format line=%d\n", NR > "/dev/stderr"
      failed = 1
    }
  }
  END { exit failed }
' "$1" </dev/null
SANDBOX_ENV
  then
    echo "错误：.env.sandbox 格式检查失败，中止部署（旧容器照常运行）。" >&2
    exit 1
  fi
fi
if ! ssh "${SERVER}" "set -e; cd ${REMOTE_DIR}
  # var/ 必须归容器内 node(1000) 所有：root 属主时应用写不进去，
  # 会话/订单只活在内存、重启即丢（且表面看不出任何异常）
  mkdir -p ${REMOTE_DIR}/var && chown -R 1000:1000 ${REMOTE_DIR}/var
  # cron 跑的备份脚本装在部署目录之外（见 deploy/backup.sh 开头）：用旧版本自己的 deploy.sh 回到 01 之前时，
  # 它的 rsync --delete 会删掉 deploy/，而 var/ 与库仍要每晚备份
  mkdir -p /usr/local/lib/${NAME} && install -m 755 ${REMOTE_DIR}/deploy/backup.sh /usr/local/lib/${NAME}/backup.sh
  # 每分钟的巡检（重启、健康检查、磁盘、备份是否过期，见 deploy/watch.sh 开头）同样装在部署目录之外；
  # 部署 02 第 17 步之前的 tag 时没有它，留着上一次装的那份
  if [ -f ${REMOTE_DIR}/deploy/watch.sh ]; then install -m 755 ${REMOTE_DIR}/deploy/watch.sh /usr/local/lib/${NAME}/watch.sh; fi
  # build 会把 ${NAME} 这个 tag 挪到新镜像上，旧镜像变成无名的 <none>，出事时无从回滚。
  # 先给「正在跑的容器」所用的镜像打 :prev——取容器的镜像而不是 :latest：上次部署若已回滚，
  # :latest 指向的是那个坏镜像，拿它当 :prev 等于把好镜像丢了。
  PREV_IMAGE=\$(docker container inspect --format '{{.Image}}' ${NAME} 2>/dev/null || true)
  if [ -n \"\$PREV_IMAGE\" ]; then docker tag \"\$PREV_IMAGE\" ${NAME}:prev; fi
  docker build --build-arg APP_REVISION=${TAG} -t ${NAME} .
  # docker 自己解析 env 文件（格式不对就报错），compose 以 format: raw 读时用的是同一个解析器。
  # 在停掉旧容器之前试一次，别等旧容器没了才失败
  docker run --rm --env-file ${REMOTE_DIR}/.env --entrypoint /bin/true ${NAME}"; then
  echo "错误：构建、.env 试读或安装备份脚本失败，中止部署（旧容器照常运行）。" >&2
  exit 1
fi
# 同一个新镜像解析沙箱环境，并复用 R16 的启动校验；禁止项按存在判断（空值也拒绝），五项体验客服变量必须齐全。
# 在迁移、停止或更换任何容器之前完成；错误只输出校验短码，不打印 env 内容。
if [ "$SANDBOX_ENABLED" = 1 ] && ! ssh "${SERVER}" "docker run --rm --env-file ${REMOTE_DIR}/.env.sandbox -e APP_ROLE=sandbox --entrypoint node ${NAME} --import tsx --input-type=module -e 'import { resolveRole } from \"./src/tenancy/sandbox/role.ts\"; try { resolveRole(process.env); } catch (e) { console.log(e.reason || \"env_invalid\"); process.exit(1); }' 2>/dev/null"; then
  echo "错误：.env.sandbox 没过试读与 R16 检查，中止部署（旧容器照常运行）。" >&2
  exit 1
fi

# 约 30s 内 /healthz 通过即视为起来了。给了 revision 时还要对得上：打错实例或新容器没换上，不能报成功
health_ok() {
  local want="${1:-}" role="${2:-}" port="${3:-$HOST_PORT}" body
  local attempts=10 deadline=$((SECONDS + ${4:-90})) curl_limit=3
  [ "$role" = sandbox ] && attempts=45
  for _ in $(seq 1 "$attempts"); do
    if [ "$role" = sandbox ]; then
      ((SECONDS < deadline)) || return 1
      local remaining=$((deadline - SECONDS))
      curl_limit=3
      ((remaining < curl_limit)) && curl_limit=$remaining
    fi
    local probe=(ssh "${SERVER}" "curl -fsS --max-time ${curl_limit} http://127.0.0.1:${port}/healthz")
    # 沙箱的总时限包含 ssh 等待；宿主仍用原来的十拍检查。
    if [ "$role" = sandbox ]; then probe=(perl -e 'alarm shift; exec @ARGV' "$remaining" "${probe[@]}"); fi
    if body=$("${probe[@]}" 2>/dev/null); then
      if [ "$role" = sandbox ] && ((SECONDS >= deadline)); then return 1; fi
      if [[ -z "$want" || "$body" == *"\"revision\":\"${want}\""* ]] &&
        [[ -z "$role" || "$body" == *"\"role\":\"${role}\""* ]]; then
        echo "$body"
        return 0
      fi
    fi
    if [ "$role" != sandbox ] || ((SECONDS + 2 < deadline)); then sleep 2; fi
  done
  return 1
}

# 6) 迁移，旧容器此时还在跑。compose run 顺带拉起 db（首次起库时 roles.sh 建角色和库）。迁移一次跑完、失败整批回退，
# 所以失败就中止：线上旧容器照常，不走下面的回滚
echo "[6/7] 迁移（顺带拉起 db）"
if ! ssh "${SERVER}" "set -e; $(compose "${NAME}:latest") run --rm migrate"; then
  echo "错误：迁移失败，中止部署（旧容器照常运行，库没有变化）。" >&2
  # 第 3 步挡住了缺口令的 .env.db，roles.sh 仍可能因别的原因在首次初始化时失败；那之后 entrypoint 不会再跑它
  echo "如果是第一次起库、日志里 roles.sh 报错或 agent_owner 口令不对：roles.sh 在首次初始化时失败的话，数据卷已经建好，" >&2
  echo "entrypoint 不会再跑它。改好 .env.db / .env.migrate（两边 owner 口令要一致）后在服务器上补跑一次（可重复执行），再重新部署：" >&2
  echo "  cd ${REMOTE_DIR} && docker compose -p ${NAME} -f deploy/compose.yml up -d db && docker compose -p ${NAME} -f deploy/compose.yml exec db /db-init/roles.sh" >&2
  exit 1
fi

# 7) 换容器：compose 按 stop_grace_period 10s 发 SIGTERM 换掉 app（依赖的 migrate 会再跑一遍，已是最新，空操作）。
# 必须走 SIGTERM 而不是 SIGKILL：进程收到 SIGTERM 会先等进行中的企微回复发完（store.ts 停机钩子，最多 8s）再落盘退出，
# 直接杀会让处理到一半的消息靠重启后重放兜底、丢掉去抖窗口里的会话变更。10s 必须大于那 8s，两处要一起改。
# 第一次换成 compose 时，原来 docker run 起的同名容器不归 compose 管（没有 compose 的项目标签），先按同样的方式停掉删掉
echo "[7/7] 换容器并做健康检查（http://127.0.0.1:${HOST_PORT}/healthz via ssh，revision 应为 ${TAG}）"
HOST_ROLE=host
case "$rollback_target" in
  pre-02 | pre-03 | pre-04 | pre-05) HOST_ROLE='' ;;
esac
# set -e：compose up 失败时 ssh 就报失败，直接去回滚，不再白等一整轮健康检查
if ssh "${SERVER}" "set -e
  if docker container inspect ${NAME} >/dev/null 2>&1 &&
    [ -z \"\$(docker container inspect --format '{{index .Config.Labels \"com.docker.compose.project\"}}' ${NAME})\" ]; then
    docker stop -t 10 ${NAME} && docker rm ${NAME}
  fi
  $(compose "${NAME}:latest") up -d app
  # :current 总是 app 容器正在用的镜像：compose 文件缺省取它，手工的 compose 命令不带 APP_IMAGE 也不会换错镜像
  docker tag ${NAME}:latest ${NAME}:current
  docker ps --filter name=^/${NAME}\$ --format '  {{.Names}}  {{.Status}}  {{.Ports}}'" && health_ok "$TAG" "$HOST_ROLE"; then
  if [ "$SANDBOX_ENABLED" = 1 ]; then
    echo "[sandbox] 换沙箱并做健康检查（总时限 90 秒）"
    if ! ssh "${SERVER}" "$(sandbox_compose "${NAME}:latest") up -d --no-deps sandbox" ||
      ! health_ok "$TAG" sandbox "$SANDBOX_PORT" 90; then
      echo "错误：沙箱换容器或健康检查失败。宿主已上线、沙箱已停；修好之后重新部署。" >&2
      # 服务端 8 秒后终止、再给 2 秒强杀；本地 ssh 12 秒封顶，取日志失败也继续删除。
      perl -e 'alarm 12; exec @ARGV' ssh "${SERVER}" "timeout --kill-after=2s 8s docker logs --tail 40 ${NAME}-sandbox" >&2 || true
      perl -e 'alarm 12; exec @ARGV' ssh "${SERVER}" "cd ${REMOTE_DIR} && APP_IMAGE=${NAME}:latest APP_CONTAINER=${NAME} HOST_PORT=${HOST_PORT} SANDBOX_PORT=${SANDBOX_PORT} timeout --kill-after=2s 8s docker compose -p ${NAME} -f deploy/compose.yml --profile sandbox rm -sfv sandbox" >&2 || {
        echo "错误：删除沙箱容器失败，需立即人工处理。" >&2
      }
      exit 1
    fi
  fi
  echo "OK. ${TAG} 部署成功。"
  exit 0
fi
echo "错误：换容器或健康检查失败——容器可能起来即崩。最近日志：" >&2
ssh "${SERVER}" "docker logs --tail 40 ${NAME}" >&2 || true

# 自动回滚到 :prev（--no-deps，不跑迁移：迁移只增不删，旧镜像的迁移是新镜像的子集）。新容器在 restart: unless-stopped 下只会反复崩溃重启，
# 不回滚的话企微回调全部 502，要一直停摆到有人手工修好重新部署。
# 无论回滚成败都以非零退出：这次部署本身是失败的，不能让调用方当成功。
echo "[rollback] 回滚到上一个镜像 ${NAME}:prev" >&2
if ! ssh "${SERVER}" "docker image inspect ${NAME}:prev >/dev/null 2>&1"; then
  echo "错误：服务器上没有 ${NAME}:prev（首次部署？），无法自动回滚，服务当前不可用！" >&2
  exit 1
fi
PREV_ROLE=host
PREV_REVISION=''
if pre05_image "${NAME}:prev"; then
  PREV_ROLE=host
else
  probe_rc=$?
  if [ "$probe_rc" != 1 ]; then
    echo "错误：无法确认上一版是否为 pre-05，没有自动回滚，沙箱未动。" >&2
    exit 1
  fi
  PREV_ROLE=''
  # 仅自动回滚替人清理。手工部署旧 tag 在第 3 步拒绝并打印步骤。
  if ! ssh "${SERVER}" "set -e
    cd ${REMOTE_DIR}
    containers=\$(timeout --kill-after=2s 8s docker container ls -aq --filter 'name=^/${NAME}-sandbox\$')
    if [ -n \"\$containers\" ]; then docker rm -fv ${NAME}-sandbox; fi
    if [ -f .env.sandbox ]; then mv .env.sandbox .env.sandbox.off; fi"; then
    echo "错误：pre-05 回滚前清理沙箱失败，没有自动回滚。" >&2
    exit 1
  fi
fi
# 回滚也核对目标镜像声明的 revision；role 仅在目标为 05 及以后时核对。
PREV_REVISION=$(ssh "${SERVER}" "docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${NAME}:prev" | sed -n 's/^APP_REVISION=//p' | head -n 1)
if [[ ! "$PREV_REVISION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "错误：无法确认上一版 revision，没有自动回滚。" >&2
  exit 1
fi
guard_rollback "${NAME}:prev" || {
  case $? in
    3) echo "错误：${NAME}:prev 是 02 之前的镜像而会话在库里，没有自动回滚，服务当前不可用！按上面的步骤人工处理。" >&2 ;;
    4) echo "错误：${NAME}:prev 是 02 之前的镜像，而改过上架条目的内容（或看不出改没改过），没有自动回滚，服务当前不可用！回到它会让已发出的方案书链接显示旧价：修好之后部署 02 之后的 tag。" >&2 ;;
    5) echo "错误：${NAME}:prev 是 03 之前的镜像而渠道状态在库里，没有自动回滚，服务当前不可用！按上面的步骤先 channel-export，再起它。" >&2 ;;
    6) echo "错误：${NAME}:prev 是 04 之前的镜像而有品牌风险，没有自动回滚，服务当前不可用！按上面对应品牌状态的步骤恢复，检查通过后再起它。" >&2 ;;
    8) echo "错误：${NAME}:prev 是 07 之前的镜像，退款订单回滚检查拒绝，没有自动回滚，服务当前不可用！按上面的步骤人工处理。" >&2 ;;
    9) echo "错误：${NAME}:prev 是旧镜像，非旅游数据、报价单、工业数据或附件回滚检查拒绝，没有自动回滚，服务当前不可用！按上面的步骤人工处理。" >&2 ;;
    7) echo "错误：${NAME}:prev 是 05 之前的镜像而有多租户或沙箱风险，没有自动回滚，服务当前不可用！按上面的步骤人工处理。" >&2 ;;
    *) echo "错误：回滚前检查没跑完，没有自动回滚到 ${NAME}:prev，服务当前不可用！" >&2 ;;
  esac
  exit 1
}
if ssh "${SERVER}" "set -e
  $(compose "${NAME}:prev") up -d --no-deps app
  docker tag ${NAME}:prev ${NAME}:current" >&2 && health_ok "$PREV_REVISION" "$PREV_ROLE"; then
  echo "已回滚到 ${NAME}:prev（/healthz 的 revision 是上一版的 tag），服务恢复；${TAG} 未上线，请排查上面的日志后重新部署。" >&2
else
  echo "错误：回滚后健康检查仍失败，服务当前不可用，需立即人工处理！" >&2
  ssh "${SERVER}" "docker logs --tail 40 ${NAME}" >&2 || true
fi
exit 1
