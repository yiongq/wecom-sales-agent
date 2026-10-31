# 可观测性与隐私

本文从 README 搬来（2026-10-27）。

DB 存储下，真实会话每轮 trace 与护栏改写落到 `turn_traces`、`guard_events`；trace 含客户原话、模型原稿与工具参数，仅所有者、管理员可读完整内容。模型用量按租户、天、模型、用途累加到 `usage_daily`，每 30 秒及停机时写入；`var/usage.json` 照旧。文件存储与 demo 类会话的 trace 只在内存，不持久化。

所有者、管理员可读 `GET /api/console/metrics?days=<天数>`（只在 DB 会话存储，缓存 60 秒），总览显示：

| 运行数字     | 口径                                             |
| ------------ | ------------------------------------------------ |
| 回复延迟 P90 | 窗口内 `outcome=replied` 的整轮耗时 90 分位      |
| 转人工率     | 有转人工轮次的会话 / 有轮次的会话                |
| AI 出错率    | 模型调用出错或 `outcome=error` 的轮次 / 全部轮次 |
| 模型费用     | `usage_daily` 的今日费用；同时显示窗口累计费用   |

窗口按服务器时区的自然日计算，并截到租户 trace 保留期。结构化日志用 `LOG_FORMAT=json`，请求带 `req`、轮次带 `tenant` / `conv` / `turn`，prod 不记客户原话与原始会话标识；Compose 已启用 JSON 与日志轮转。

应用关键故障通过 `ALERT_WEBHOOK_URL` 推企微告警群；转人工通知用独立的 `NOTIFY_WEBHOOK_URL`。宿主机 [deploy/watch.sh](../../deploy/watch.sh) 巡检重启、健康、磁盘、备份、工业业务拨测，配置在服务器 `.env.ops`，需另装每分钟 cron。线上 demo 已验过停机告警：腾讯云云拨测试用版与主机巡检均在 3 分钟内送达企微群；长期外部拨测用 UptimeRobot，每 5 分钟检测、邮件通知，只判 HTTP 200，未校验响应正文 `ok`。

工业拨测配置 `.env.ops` 的 `PROBE_APP_ORIGIN`、`PROBE_TENANT_SLUG`、`PROBE_EMAIL`、`PROBE_PASSWORD`，可选 `PROBE_EVERY_S`（默认 600 秒）。四项全空跳过，部分配置告警且不请求。账号用 `user-create` 建普通 agent，只属于工业租户，单独受控，不是共享试用账号；`trial-reset` 不改它的口令。env 文件被 `source`，口令用单引号包裹，口令内单引号按 shell 规则转义。默认每 10 分钟正常登录一次，每天约 144 行 `auth.login` 审计。

第五项走工业 app 登录、`/me` 核对租户、读成员资源、带 csrf 退出；中途失败也退出，每请求限时 8 秒，校验证书。失败及恢复观察时每分钟重跑，连续 3 次失败告警、连续 3 次成功恢复，沿用原状态文件与 30 分钟去重。告警只含步骤与 HTTP/curl 结果码，错租户记「租户不符」，不含地址、邮箱、租户 slug、口令、cookie、csrf 或响应体；凭据不进进程参数，私有临时文件结束即删。完整配置与两段上线顺序见[产品门面发布手册](product-surface-deploy.md)。

OpenTelemetry 默认关闭；设 `OTEL_EXPORTER_OTLP_ENDPOINT` 才加载导出器，每轮一条 trace，属性按 GenAI 约定加 Langfuse 会话属性。会话用数据库 `ref`，文件存储与 demo 类会话用进程内匿名引用；任何时候不导出真实企微用户标识。`OTEL_EXPORTER_OTLP_HEADERS` 用于鉴权，只存服务器 env；默认不导出原文，`OTEL_CAPTURE_CONTENT=1` 才导出客户原话、最终回复、工具参数，工具结果始终不导出。02 只做埋点，Langfuse 接收端尚未部署。

OTel 环境变量（完整配置见 `.env.example`）：

| 变量                          | 用途                                                |
| ----------------------------- | --------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP 根端点，设了才启用；导出器补 `/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS`  | 导出鉴权头，按密钥管理                              |
| `OTEL_CAPTURE_CONTENT`        | 仅值为 `1` 时导出原文，开启前配置接收端权限与保留期 |

DB 模式可发布 `/privacy` 隐私说明，记录敏感信息同意与撤回；不同意或撤回后转人工，未重新同意不能交还 AI。保留期按租户配置，默认未成交会话 180 天、客户会话 730 天、trace 90 天；过期清理经受控函数执行。平台按个人请求删除需先停 app，订单保留但断开客户关联，备份副本随备份保留期滚掉。详细前置条件见 02 plan「上线清单」，相关私有内容另记。
