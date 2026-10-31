# 工业询价使用文档

VitePress 固定 1.6.4，独立 package 与锁文件，不加入主 workspace。首次安装：

```sh
pnpm --dir docs-site install --ignore-workspace --frozen-lockfile
pnpm --dir docs-site build --sample
pnpm --dir docs-site build --input "$PRODUCT_PUBLISH_INPUT"
```

构建参数以仓库根目录解析；--sample 为明确的合成本地输入。正式输入与法律模板见 site/README.md，必须来自仓库外，不得将私有发布 JSON 放入源码。

构建只读 PUBLIC_GUIDES 登记的六份 docs/guides 正文，逐文件复制到 .stage/content，拒绝软链接、include/import、HTML、组件及未登记资源，绝不复制整个 docs。快速开始重写为首页，其他五类指南按文件名生成 HTML。构建自动检查资源、锚点、站内链接及所有产物（含本地搜索 JSON、JS、站点地图与二进制元数据），禁止内部材料和 source map。输出在 docs-site/dist；.stage 不得作为静态根。

搜索仅使用这六份正文生成的本地索引，按关键词匹配，无租户 API、外部搜索服务或成员 cookie。空结果可清除；加载失败可重试，正文和目录仍为静态 HTML。404 给回首页入口。主题复用后台设计系统的中性色和字体，字体在构建时携带许可。

内容自测已接主 test 行，不依赖独立 VitePress 安装。完整渲染验证需显式执行：

```sh
pnpm exec tsx scripts/product-sites/sites.selftest.ts --with-docs
```

该模式构建真实官网与文档，检查六页静态正文、搜索索引、跨站链接与 404；没有安装独立依赖时失败，不跳过渲染检查。主 CI 的常规模式仍验证材料完整性、白名单暂存、官网产物、搜索逻辑与泄漏拒绝，不自动联网安装依赖。
