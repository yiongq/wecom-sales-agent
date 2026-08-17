# tsx 直跑（demo 规模无需编译产物）。tini 作 PID 1 转发信号，
# 保证 SIGTERM 能到达 node（store 退出 flush、优雅停机依赖它）。
FROM node:22-alpine
# upgrade：拉取 Alpine 安全补丁（基础镜像 tag 常滞后于 CVE 修复）
RUN apk upgrade --no-cache && apk add --no-cache tini tzdata
# 时区必须显式定死：日期校验、访客日预算、今日用量统计全按本地时区算「今天」，
# 容器默认 UTC 会让这些在北京时间早上 8 点跨天，运营看到的数对不上
ENV TZ=Asia/Shanghai
WORKDIR /app
# 用 pnpm-lock.yaml 锁定依赖版本：npm install 按 ^ 范围拉最新版，
# 上游发新版后"零代码改动的重新部署"也可能把服务弄坏且无从对照排查
# pnpm-workspace.yaml 必须一起 COPY：pnpm 10 从这里读 onlyBuiltDependencies，
# 缺了会因 esbuild 构建脚本被忽略而直接失败
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@10 --activate \
  && pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY src ./src
COPY data ./data
COPY public ./public
# assets/ 是运行期读的，不是构建期资源：企微链接卡片的缩略图从这里读。
# 漏了它不会报错——uploadThumb 拿不到文件就静默退回纯文本，客户收到的是一条秃网址，
# 只有对着微信实机看才发现卡片没了。
COPY assets ./assets
# var/ 是唯一数据源（会话/订单/企微 cursor），必须挂卷，否则容器重建即丢单：
#   docker run -v wecom-data:/app/var --env-file .env -p 3200:3200 <image>
RUN mkdir -p /app/var && chown -R node:node /app
USER node
VOLUME /app/var
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3200/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "src/server.ts"]
