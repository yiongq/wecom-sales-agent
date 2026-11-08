# 可观测性处理手册

公共处理步骤只包含固定错误、计数和检查方法。真实部署地址、租户映射、值班人和凭据另记。以下命令在已授权的运维环境中由人工执行，替换占位符；只读检查不包含 env 或客户正文。SQL 示例的连接参数由运维在受控环境中注入标准 PG 环境变量，使用只读账号；不把连接串或凭据放进命令行、检查结果或日志。UptimeRobot 是独立外部邮件通道，消息格式未统一。

## RB-01 tenant_lock · 租户锁丢失

### 症状

租户锁 lost、被另一进程持有或进程开始停机。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
curl --fail --max-time 5 --silent '<受控健康检查地址>/healthz'
```

### 下一步

先确认只有一个写者，核对部署及锁连接；由授权运维决定恢复进程。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

原持锁进程仍存在、数据库不可达或持锁身份不明。

## RB-02 store · 写库冲突、积压与回放

### 症状

store_conflict、poisoned、spill 回放失败、写库积压或遥测丢失。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
curl --fail --max-time 5 --silent '<受控健康检查地址>/healthz'
```

### 下一步

按错误码区分 P1 冲突/poisoned/回放失败与 P2 积压/遥测丢失；保留 spill，不修改消息账本。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

有其他写者、poisoned、回放失败或发送结果未知；禁止整库回灌和盲目重放。

## RB-03 model_errors · 模型调用失败

### 症状

连续五次模型失败或最近五十轮错误率超过 20%。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT outcome,count(*) FROM turn_traces WHERE tenant_id = '<租户 UUID>' AND started_at >= now() - interval '10 minutes' GROUP BY outcome; ROLLBACK;"
```

### 下一步

只查错误类型、计数和供应商状态；经授权修复连接或额度，不把客户正文发到群里。

### 恢复证据

连续十次模型调用成功，收到已恢复；旧错误窗口重新累计。

### 什么情况下停止自动重试

鉴权、额度或配置错误持续；禁止无界重试及自行切换模型。

## RB-04 wecom_send · 企微发送失败

### 症状

企微取不到 token 或十分钟内三个分段最终发送失败。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT status,errcode,count(*) FROM outbound_sends WHERE tenant_id = '<租户 UUID>' AND sent_at >= now() - interval '10 minutes' GROUP BY status,errcode; ROLLBACK;"
```

### 下一步

按错误码检查 token、渠道配置与发送账本；unknown 不能视为未发。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

发送状态 unknown 或窗口已过期；不得盲目重放。

## RB-05 channel · 渠道收发异常

### 症状

渠道启动校验、拉取、入站积压或发送状态异常。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT state,reason,count(*),min(received_at) FROM channel_inbox WHERE tenant_id = '<租户 UUID>' GROUP BY state,reason; ROLLBACK;"
```

### 下一步

按固定账号别名与原因核对收发账本及错误码，先处理积压源头。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

入站 poison、发送 unknown、恢复截止点或同步校验拒绝。

## RB-06 jobs · 后台任务失败

### 症状

后台任务用完重试次数进入 failed。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT kind,status,count(*) FROM jobs WHERE tenant_id = '<租户 UUID>' GROUP BY kind,status; ROLLBACK;"
```

### 下一步

定位任务种类及错误码，先修复依赖；核对幂等记录后由授权运维决定重新排程。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

超过尝试次数、过期或无法确认此前副作用。

## RB-07 reply_latency · 回复延迟升高

### 症状

三个连续五分钟窗口，每窗至少二十条，回复 p90 超过八秒。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT last_window_end,last_p90_ms,last_samples,bad_streak,good_streak,active,paused FROM ops_latency_state WHERE tenant_id = '<租户 UUID>'; ROLLBACK;"
```

### 下一步

先看定位链接中的真实单轮，再对照队列、模型与数据库耗时；无可用单轮记录时查聚合窗口。

### 恢复证据

两个连续有效五分钟窗口，每窗至少二十条且 p90 不超过六秒；持久 active 变 false 并发恢复。低样本、SQL 失败、缺窗、暂停均不能作为证据。

### 什么情况下停止自动重试

查询失败、样本不足、流量为零或租户 suspended 时停止判断恢复，不能伪报已恢复。

## RB-08 erp · 业务系统连接异常

### 症状

外部业务系统断连、校验失败或熔断。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml images
```

### 下一步

核对错误码与连接器状态，修复租户配置时遵循出站网络边界；凭据不输出。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

地址被出站策略拒绝、鉴权错误、熔断或写入结果未知。

## RB-09 tenant_scope_missing · 租户作用域缺失

### 症状

后台入口缺少租户作用域。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
curl --fail --max-time 5 --silent '<受控健康检查地址>/healthz'
```

### 下一步

按入口错误码定位后台回调，保留作用域拒绝，不用宿主租户兜底。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

缺少作用域或领域事件归属不一致。

## RB-10 sandbox_send_refused · 体验发送边界拒绝

### 症状

体验客服发送边界拒绝请求。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
curl --fail --max-time 5 --silent '<受控健康检查地址>/healthz'
```

### 下一步

检查体验隔离与出站边界配置，拒绝行为保留；不得绕过边界继续发送。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

身份、渠道或租户归属不一致。

## RB-11 sandbox_purge · 体验清理积压

### 症状

体验过期超过一小时未删或清理连续失败。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT status,count(*) FROM jobs WHERE tenant_id = '<租户 UUID>' AND kind = 'retention_purge' GROUP BY status; ROLLBACK;"
```

### 下一步

核对清理任务错误码、持锁状态与数据库可用性；按受控生命周期函数处理。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

锁归属不明或删除函数失败；禁止直接删除业务表。

## RB-12 usage_limit · 模型用量提醒

### 症状

租户模型用量达到提醒阈值。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT day,sum(calls) AS calls,sum(cost_milli_cny) AS cost_milli FROM usage_daily WHERE tenant_id = '<租户 UUID>' AND day >= current_date - 7 GROUP BY day ORDER BY day; ROLLBACK;"
```

### 下一步

只核对后台用量和预算配置，额度变更由授权成员决定。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

额度耗尽、租户暂停或未获授权；不自动恢复额度。

## RB-13 attachment_limit · 附件额度提醒

### 症状

附件达到当日份数上限。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml images
```

### 下一步

核对附件计数与日期；客户可改用文字提供型号和数量。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

已达到上限；不得自动扩容或重复拉取附件。

## RB-14 sandbox_pool · 体验资源池提醒

### 症状

体验池预算或资源逼近上限。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml images
```

### 下一步

核对池预算和资源计数，由运维决定容量，不自动增加额度。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

池满、预算不足或体验开关关闭。

## RB-15 sandbox_wecom_full · 微信体验名额已满

### 症状

微信体验名额用尽并退回模拟器。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml images
```

### 下一步

核对体验名额及清理任务，观察回退是否可用。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

名额已满；不重复分配同一体验。

## RB-16 host_restart · 主机服务反复重启

### 症状

服务在原巡检窗口内反复重启。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml images
```

### 下一步

核对健康检查、退出码、资源压力及写者锁，授权后修复根因。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

持续退出、锁冲突或启动恢复失败，不能循环重启。

## RB-17 host_health · 主机健康检查失败

### 症状

主备两个端口连续三分钟都不健康，或两个端口都在服务。恰好一个 `ok: true` 正常，备用连不上不告警。

主备切换、回滚与首次 Caddy 配置见[部署手册](../guides/deployment.md#18-主备切换滚动发布与回滚)。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
curl --fail --max-time 5 --silent '<受控健康检查地址>/healthz'
```

### 下一步

检查进程、数据库与只读健康信息，核对当前版本；不要仅凭 HTTP 200 认定业务恢复。

### 恢复证据

原故障条件消失，已有恢复通知与只读检查结果相互印证；无恢复通知的提醒以计数和任务终态核对。

### 什么情况下停止自动重试

启动失败、数据库不可达或健康持续失败。

## RB-18 host_disk · 磁盘空间不足

### 症状

磁盘达到 85% 为 P2、达到 95% 为 P1；低于 80% 才恢复。

### 只读检查命令

```bash
df -P
docker system df
```

### 下一步

先用只读命令确认卷与归档占用，由授权运维按留存策略清理，保留数据库与未回放 spill。

### 恢复证据

占用低于 80%，收到恢复，原告警级别保留。

### 什么情况下停止自动重试

空间临界或文件归属不明；不自动删数据库、备份或运行状态。

## RB-19 host_backup · 备份失败或过期

### 症状

备份脚本失败、无成功备份或上次成功早于二十六小时。

### 只读检查命令

```bash
stat <备份目录>/last-success
stat <备份目录>/last-failure
```

### 下一步

核对失败步骤、加密产物和异地复制结果；恢复演练只能在隔离环境。

### 恢复证据

备份脚本完成校验及加密，last-success 更新且收到恢复；另核对异地副本。

### 什么情况下停止自动重试

校验失败、加密失败、异地结果不明；不以不完整文件覆盖有效备份。

## RB-20 host_probe · 业务拨测失败

### 症状

业务拨测连续三次失败或配置不完整。

### 只读检查命令

```bash
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml images
```

### 下一步

核对登录、身份、租户、成员资源和退出步骤的状态码；账号与凭据另记。

### 恢复证据

连续三次完整登录、租户身份、成员资源、CSRF 退出成功并收到恢复。

### 什么情况下停止自动重试

配置不完整、鉴权失败或租户不符；禁止取消 TLS 检验。

## RB-21 daily_digest · 每日摘要发送异常

### 症状

日摘要账本 failed 或 unknown；群里没有消息不能据此认定发送失败。

### 只读检查命令

```bash
psql -X -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SET LOCAL app.tenant_id = '<租户 UUID>'; SELECT day,status,attempts,resend_count,error_code FROM ops_daily_reports WHERE tenant_id = '<租户 UUID>' ORDER BY day DESC LIMIT 7; ROLLBACK;"
```

### 下一步

unknown 表示可能已发送，永不自动重发；failed 先查 error_code、发送日截止点及配置。确认重复风险后才执行下列人工命令。

下面是会改变状态的人工命令，使用 platform 身份，应用负责实际发送；先确认重复风险和当前发送日期，真实租户映射另记。

```bash
node --import tsx src/cli/ops-report.ts retry --tenant <slug> --day <YYYY-MM-DD> --ack-duplicate-risk
node --import tsx src/cli/ops-report.ts prepare-rollback --tenant <slug>
```

回滚前先关闭新功能排程、停止新进程并等待在途结束，再执行 `prepare-rollback`：取消未完成摘要任务，sending 归 unknown，保留日账本。旧镜像须包含阶段 14 R6、15 删除与重置保护；在保留期内安排受控清理，不能 drop 新表或恢复整库。重新前滚不得重发 sent/unknown。

### 恢复证据

账本 sent 与接收端接受证据一致；unknown 保持 unknown，不能由消息缺失推断未发。

### 什么情况下停止自动重试

unknown、sending 恢复为 unknown、超过发送日截止点或 attempts 耗尽时停止自动重试。
