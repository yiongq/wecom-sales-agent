# v2 具名快照与更新政策（06 R4）

快照固定某一时刻的黑盒行为，文件配置与 PGlite 配置共用一份。当前默认比对的是 `eval/v2/snapshot.ts` 里常量 `DEFAULT_BASELINE` 指向的文件，现在是 `v2-pre04.json`（04 第 5 步，由未改生产代码的评测树生成，留作 04 的凭证，永远不删）。

## 政策

- 快照不随实现自动更新，更新是显式动作。每个**有意改变行为**的 PR 生成一份新的具名快照 `v2-06-step<N>.json`（N 是 06 plan 的步骤号），并把 `DEFAULT_BASELINE` 改成它；写完用文件与 PGlite 两条路径各比对一次。旧快照一份都不删。
- 新快照与上一份逐条 diff，每条差异写明是哪条 R 引起的、为什么是对的，记进 plan；说不清的差异就是回归，修代码，不写进快照。`eval/cases-v2/reply-verdicts.json` 一类断言裁决序列的用例，同一个 PR 里按新步骤表更新，同样逐条说明。
- **没有改变行为**的 PR 不生成快照：默认基线不重生成照样全绿，就是行为没变的证据。
- 两个 PR 并行时，后合并的那个在合并前基于最新的 `dev` 重新生成快照、重审差异，不能沿用在旧 `dev` 上审过的结论。
- 默认文件不存在时保留旧 runner 行为（不比对）。

## 快照内容

每个 case 按轮保存：客户回复的 SHA-256 与前 40 个 Unicode 字符、`silent`、会话是否已转人工、回复阶段、本轮工具名序列（trace 的全部调用，含预取与护栏补调）、订单数量及最后一张订单的业务字段、按顺序排列的 `guard_events`。

正文哈希覆盖完整归一文本，前缀只供定位；正文有差异时，报告打印快照侧的哈希与前缀、本次的完整归一正文。护栏事件保留 `guard`、`action`、`removed`、`added`；后两者直接存 recorder 给出的每句最多 200 字的摘要，保留顺序和重复句，方便查看具体改写，也避免再存哈希增加体积。只采已有事件，不添加放行裁决。

归一规则（正文、护栏摘要、订单业务字符串相同）：

- 沿用 `values.ts`：`ord_[0-9a-f]{24}` 换成 `ord_NORMALIZED`，去掉 `?v=N` / `&v=N` 方案版本查询参数，保留其它参数。
- 本轮实际观测的会话 id、轮次随机 id、订单 id 与替代订单引用按精确值替换为固定标记。
- 本轮开始、护栏记录、订单创建/付款/确认的实际毫秒时间及对应完整 ISO 字符串按精确值替换为 `TIME_NORMALIZED`。不泛匹配数字或日期；业务出发日、金额、人数和线路 id 保留。
- 订单去掉 `id`、`sessionId`、`createdAt`、`paidAt`、`confirmedAt`。另排除 `catalogVersion`：这是配置条目版本元数据，文件源与数据库源没有相同的版本体系。其它业务字段全部保留；`supersededBy` 的引用归一，是否存在仍参与比对。
- 不保存 trace 的耗时、模型用量、前缀哈希、工具参数/结果、事件 `at` 等运行元数据。

文件按 case id 排序，对象键递归排序，轮次/工具/事件/摘要数组顺序保留。序列化使用仓库固定版本的 oxfmt，宽度 140、两空格缩进、LF 换行，无生成时间。

```sh
# 只跑 v2，全部通过才写文件；写模式不比对旧基线（N 换成 plan 的步骤号）
CONFIG_SOURCE=file LLM_MOCK=1 pnpm exec tsx eval/run.ts \
  --cases-v2 eval/cases-v2 --v2-snapshot-write eval/baselines/v2-06-stepN.json

# 默认先 v1 后 v2；两种配置都自动比对默认快照
CONFIG_SOURCE=file LLM_MOCK=1 pnpm exec tsx eval/run.ts
CONFIG_SOURCE=file CONFIG_TEST_DB=pglite LLM_MOCK=1 pnpm exec tsx eval/run.ts
```

`EVAL_V2_BASELINE=<文件>` 换基线（指定文件不存在/格式错误会失败）；`EVAL_V2_BASELINE=off` 关闭比对。默认文件不存在时保留旧 runner 行为。完整回归同时检查基线 case 是否被删除；显式 `--cases`、`--cases-v2` 或 `--tags` 选择时允许只跑子集，所选 case 必须存在于基线。
