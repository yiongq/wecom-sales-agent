# wecom-sales-agent · 单来

[English](README.md) | 简体中文

企业微信里的工业询价 AI 助手：收询价、认型号、查产品库库存、按数量规则试算、提交报价审批、转给顾问接手。价格、订单、链接与承诺由确定性代码核对，模型负责理解需求和组织回复。

成员工作台把会话、报价审批和顾问回复放在一起。文字、图片与表格可以协助整理询价，识别结果需要核对。库存来自已发布产品库快照；ERP 连接器与用量展示已有代码，**尚未上线**，不能当作已开通的服务。

Node 22 · Hono · TypeScript（tsx 直接运行）· PostgreSQL 17 + pgvector · React 后台 · MIT 软件许可。

## 申请试用账号

向介绍本项目的人申请，账号按需发放。没有公开密码、自动领取或自助注册入口，后台地址随账号提供。

共享试用账号是普通顾问 agent：处理自己负责的会话与审批报价，不能修改产品库、销售话术或进入管理设置。试用内容为合成种子与试用者自行发送的消息，同一试用公司的其他成员可能看到这些消息，**勿发送个人信息、凭据或正式客户资料**。真实试用消息、客户资料与追踪记录保留 7 天；手动重置会同时清理试用消息与合成种子。

发送合成询价前请读[快速开始](docs/guides/quick-start.md)。试用互动不构成购买、付款或交付承诺。

## 从询价到审批报价

1. 客户从已开通的微信客服渠道发送型号、规格与数量。
2. 系统匹配产品库，缺规格或有多个候选时继续确认；图片和表格识别结果需要核对。
3. 报价工具按起订量、包装倍数与阶梯价试算。产品库库存是配置快照，不是实时 ERP 承诺。
4. 报价等待顾问审批，批准后才向客户外发正式链接；驳回则作废并转人工。
5. 客户要求真人或需求超出范围时，顾问在原渠道接手回复，AI 在人工处理期间停止接待。

权限与操作见[产品库](docs/guides/catalog.md)、[销售话术](docs/guides/sales-sop.md)和[常见问题](docs/guides/faq.md)。组织、成员与渠道设置本期只读，变更由平台通过既有命令在维护窗口完成。正式产品发布以[更新日志](docs/guides/changelog.md)为准。

## 开发者安装

使用 Node 22 与 pnpm 10，精确 pnpm 版本见 package.json。

```sh
pnpm install
DEPLOY_PROFILE=demo CONFIG_SOURCE=file SESSION_STORE=file LLM_MOCK=1 pnpm start
```

该离线冒烟配置使用仓库的默认参考包。在本机 3200 端口打开 /chat.html 扮演客户，/admin.html 查看演示会话；模拟收银台不扣款。数据库成员后台 /console/ 需要数据库配置和账号，见[本地跑法](docs/guides/local-dev.md)与[账号权限](docs/guides/console-access.md)。

平台以租户隔离和行业包支持多行业。工业包负责型号匹配、数量规则与报价人审。旅游作为第二个行业包和回归基线保留在开发者仓库中，不作为另一条对外产品主线。源码 demo 档继续支持重置、匿名只读后台、种子保鲜和访客清理；产品托管使用 prod 与普通登录，源码准备完成不代表已经部署。

租户表采用 FORCE 行级安全，登录表例外见 [ADR-001](docs/adr/adr-001-postgres-drizzle.md)；会话消息只追加。当前运行时仍要求单实例，不能因为存储在数据库就部署多副本。行业逻辑留在包里，SOP 版本内系统前缀保持字节一致，逐轮状态独立传递。

```text
src/core/        引擎、工具、护栏与模型客户端
src/packs/       行业包与注册表
src/tenancy/     租户运行时、Host 路由与 demo 沙箱
src/db/          schema、数据访问与隔离自测
console/         成员工作台
site/            产品官网与公开法律模板
docs-site/       独立 VitePress 构建，不加入主 workspace
docs/guides/     使用指南；仅六份白名单进入公开文档站
scripts/         检查、自测与静态站构建
```

官网与文档的实际链接、品牌素材和审定法律正文由私有构建输入提供。真实部署标识与试用凭据不得写入源码。合成构建与截图清单见 [site/README.md](site/README.md)，文档构建见 [docs-site/README.md](docs-site/README.md)。名称与标识按 [BRAND.md](BRAND.md) 管理，不在软件许可内。

## 开发门禁与参考

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

自测是普通 tsx 脚本，数据库自测通常用 PGlite；真实 PG 验证使用一次性容器。真实模型评测会花钱，单独执行，不在 CI 运行。贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)，编码规则见 [AGENTS.md](AGENTS.md)；[架构总参考](docs/architecture/master-reference.md)、[规格与计划](docs/architecture/)和 [ADR](docs/adr/)是开发状态依据。开发与运维材料留在仓库，不进入公开文档站。

## 许可

软件代码采用 [MIT](LICENSE) 许可。「单来」名称、Logo 与正式品牌标识**不在 MIT 授权内**，详见 [BRAND.md](BRAND.md)。第三方内容许可见 [NOTICE](NOTICE)。市场、定价与客户事项另记。
