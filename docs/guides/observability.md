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

应用关键故障通过 `ALERT_WEBHOOK_URL` 推企微告警群；转人工通知用独立的 `NOTIFY_WEBHOOK_URL`。宿主机 [deploy/watch.sh](../../deploy/watch.sh) 巡检重启、健康、磁盘、备份，配置在服务器 `.env.ops`，需另装每分钟 cron。线上 demo 已验过停机告警：腾讯云云拨测试用版与主机巡检均在 3 分钟内送达企微群；长期外部拨测用 UptimeRobot，每 5 分钟检测、邮件通知，只判 HTTP 200，未校验响应正文 `ok`。

OpenTelemetry 默认关闭；设 `OTEL_EXPORTER_OTLP_ENDPOINT` 才加载导出器，每轮一条 trace，属性按 GenAI 约定加 Langfuse 会话属性。会话用数据库 `ref`，文件存储与 demo 类会话用进程内匿名引用；任何时候不导出真实企微用户标识。`OTEL_EXPORTER_OTLP_HEADERS` 用于鉴权，只存服务器 env；默认不导出原文，`OTEL_CAPTURE_CONTENT=1` 才导出客户原话、最终回复、工具参数，工具结果始终不导出。02 只做埋点，Langfuse 接收端尚未部署。

OTel 环境变量（完整配置见 `.env.example`）：

| 变量                          | 用途                                                |
| ----------------------------- | --------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP 根端点，设了才启用；导出器补 `/v1/traces` |
| `OTEL_EXPORTER_OTLP_HEADERS`  | 导出鉴权头，按密钥管理                              |
| `OTEL_CAPTURE_CONTENT`        | 仅值为 `1` 时导出原文，开启前配置接收端权限与保留期 |

DB 模式可发布 `/privacy` 隐私说明，记录敏感信息同意与撤回；不同意或撤回后转人工，未重新同意不能交还 AI。保留期按租户配置，默认未成交会话 180 天、客户会话 730 天、trace 90 天；过期清理经受控函数执行。平台按个人请求删除需先停 app，订单保留但断开客户关联，备份副本随备份保留期滚掉。详细前置条件见 02 plan「上线清单」，相关私有内容另记。
