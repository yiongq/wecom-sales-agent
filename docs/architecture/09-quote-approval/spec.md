# 09 · 报价审批、报价单页与站内链接（核心）

Status: draft
Revisions: 2026-10-23 起草期评审（一路 Claude Opus，对照 e1433e0 与 08 草稿）之后，原「09 · 工业品询价包」拆成两份：本 spec 只做核心能力，用 08 的证明包验证；工业品询价包与演示租户移到 [10](../10-industrial-rfq-pack/spec.md)。按评审补齐了以下内容：现有 6 个订单入口对报价单的行为（R4），审批到底保护什么（R1），状态 × 动作表（R3），确定性回复的扩展（R11），站内链接改为按包登记（R10）、并保住锁定测试与静态页的约束，提醒的去重与执行体（R8），以及按「组」计数的外发（R5）。
Revisions: 2026-10-23 评审复核（同一路 Opus）之后就地修订，尚无代码依赖：不变量 2 改按「外发那一刻」的状态断言，外发时把状态记进消息的 `extra`（不然先合法发出、后来过期的链接都算违反）；批准通知的正文只有链接，企微只发一张卡片，卡片标题统一由 `siteLinks` 的 `card` 给，删掉 `quoteApprovedCard`，发送条数照账本实际记；R3 与验收 4 的例子改成撤回、重置、另一张单先批准（新的待审单本来就不会取代已批准的单）；确定性回复加 `fixedId`，由引擎核对；`linkKind` 改为字符串，`MessagePart` 加 `title`，静态页只加一次通用分支；`order` 链接的 `allowed` 写明；状态表补「新单当场自动批准」；`richTools` 改读已有的 `ShapePolicy.richTools`；新增 R16 的两个包钩子；回滚改用 `quote-void --all` 作废报价单，不推送；去掉 `shared` 身份；更正审计文件的路径。第三轮确认后再补：网页部件的标题改由可选的 `partTitle` 给，核心与旅游的部件不填，旅游部件逐字节不变；`quote-void` 要停机执行，落成撤回状态；`fixedId` 只对带副作用的确定性回复强制，带变量的句子按登记的模板正则比对；`onQuoteDecided` 只在工作台动作之后调用。
Phase: 8 of the roadmap in [master-reference](../master-reference.md)「分阶段路线」——阶段 8 候选「第二个真实行业包」所需的核心能力。
Depends on: [08 · 核心去旅游化](../08-pack-generalization/spec.md)（开工时须已 implemented）。本文用到的 08 接口名，以 08 实现后的代码为准，出入在开工核对里对齐。另依赖 [02](../02-conversations-workbench/spec.md)：订单动作、工作台、`handoff_notify`、发送账本、审计；[04](../04-industry-packs/spec.md)：`PackRuntime`、步骤表、`preModel`；[06](../06-reply-quality/spec.md)：固定句登记与一致性检查（R21）。
Supersedes in part: [02](../02-conversations-workbench/spec.md)「订单动作只限接手人本人」（02 spec 第 771、984 行，不变量 39）——对报价单的批准与驳回：AI 接待中（没转人工）的会话，agent 也能操作（R7，开放问题 1，owner 定）。被取代条款的行号在开工核对时重核。
Amends: [08](../08-pack-generalization/spec.md) R3：`createLineOrder` 加 `approval` 选项；带审批的通用单另有复用与作废规则（R2、R6）。08 R8：放行集合第 (2) 项只含已批准、或不需要审批的订单（R1）。08 R12：带审批的通用单不走 `/api/orders/:id` 与 `/pay/:id`（R4）。04「`PackRuntime`」：加 `quotes`、`siteLinks`、`onQuoteDecided`、`followupGate`；`DeterministicReply` 加 `fixedId`、`handoff`、`notify`、`statePatch`；`MessagePart` 加 `title`（R10、R11、R16）。02「转人工」：`HandoffKind` 加 `pack`；`handoff_notify` 的原因加 `quote_pending`、`quote_accepted`（R8、R12）。04 R11 与 06 的模拟评测：`handoff` 谓词可以指定 `kind`；`shape` 谓词改读包已有的 `ShapePolicy.richTools`（R12、R13）。

**一句话：** 给 08 的通用订单加上「报价单」这种用法：包可以让自己建的通用单带审批状态。没批准的报价单，链接到不了客户手里，页面不显示金额，任何订单入口都不能确认或标记已付。顾问在工作台批准之后，系统推一张报价单卡片；驳回之后，订单作废并转人工。报价单有自己的页面 `/quote/<订单号>`。顺带把写死的站内链接种类改成按包登记，让确定性回复能转人工、能排提醒，并新增一个通用的转人工类型 `pack`。这些都用 08 的证明包验证，旅游的前缀、锁定套件、v2 结论与客户看到的字节都不变。

## 背景与问题

行号按 `dev` e1433e0，开工核对时重核。

- **现有的「确认价格」不是审批。**
  - 它只拦「确认收款」，不拦链接：`/pay` 链接在建单当轮就由 AI 发出；公开订单接口不看是否已确认（`src/server.ts:268-298`）；确认之后也不通知客户（`src/payment/orders.ts:61-72`）。
  - 它依赖进程级的付款方式（`src/payment/mode.ts:6-8`）。demo 下是 online，`markPaidByAdvisor` 不检查是否确认过（`src/payment/orders.ts:103`），匿名的模拟支付还能把任意未作废的单标成已付（`src/server.ts:722-745`）。
  - agent 动不了 AI 接待中会话的订单（`src/payment/orders.ts:40-48`）。
  - 退款审批（`src/payment/refunds.ts`）更接近要的东西：有待审批状态、驳回要写原因、审过才通知客户、通知失败追加备注。
- **08 的通用单有六个入口会绕过审批：** `GET /api/orders/:id`、`/pay/:id`、`POST /api/orders/:id/pay`（模拟支付）、console 的确认、确认收款、取消。报价单号就是 `ord_` 订单号。
- **站内链接种类散在各处写死。** 网页渠道的线上格式 `linkKind` 是 `'order' | 'proposal' | 'site'`（`src/shared/channel-types.ts:26`）。写死的地方包括：
  - `src/core/message-parts.ts:10、29`、`src/core/guards/shape.ts:27-28`、`src/core/guards/dejargon.ts:8`、`src/core/guards/text.ts:8`、`src/core/insight.ts:183`；
  - `src/adapters/wecom.ts:566、582、653、669-690、790、1540-1547`；
  - `public/chat.html:413-430`、`public/web.js:54`、`public/admin.html:954、981`；
  - `src/server.ts:1060`（静态页正则）、`src/core/pack-api.ts:802`（`BrandPage`）；
  - `src/tenancy/sandbox/outbound.ts:280、388-392`、`src/tenancy/sandbox/process.ts:302`。

  方案书卡片要用旅游的 `routeForProposal`，放进核心的表就会违反 08 R5 的依赖方向。锁定的 `src/adapters/wecom.selftest.ts:271-283` 经 `__test.extractCard(text, BASE)` 调用，并用正则从 `public/chat.html` 抠出 `stripLink`、再用 `new Function` 运行，所以那个函数必须保持自包含。

- **确定性回复只能回一段文字。** `DeterministicReply` 只有 `text`（`src/core/pack-api.ts:246-248`），引擎拿到后推出文本就以 `done('deterministic')` 结束（`src/core/engine/index.ts:308-315`），没法转人工、排提醒或写会话状态。
- **转人工类型是封闭集合。** `HandoffKind` 里没有「行业包规则触发」（`src/shared/conversation-types.ts:8-35`）。
- **提醒的执行体只认旅游订单与转人工中的会话。** 非订单类原因要求会话在同一次转人工里，否则记 `done('not_in_handoff')`（`src/notify/handoff.ts:106-122`）。
- **模拟评测**：`shape` 谓词写死旅游的 5 个工具名（`eval/sim/judge.ts:31`）；`handoff` 谓词只有布尔值（`eval/sim/goals.ts:17`）。
- **发送窗口**：微信客服在客户发一条消息后 48 小时内最多 5 次 `send_msg`（`src/quota/ledger.ts:72-77`）。正文加卡片是 2 次；`notice` 类外发不预检窗口。

## 目标

1. **报价单。** 包可以让自己建的通用单带审批状态。状态机、6 个订单入口、工作台的批准与驳回、权限、提醒、通知、页面全部定义清楚。
2. **报价单页** `/quote/<订单号>` 与它的数据接口。
3. **站内链接按包登记。** 核心登记 `/pay` 与站内通用页，包登记自己的文档链接（旅游的方案书、10 的报价单）。核心提供一个通用的链接白名单步骤，给新包用。
4. **确定性回复**能转人工（`kind: 'pack'`）、能排提醒、能写会话状态。
5. **评测**：`handoff` 谓词可以指定类型，`shape` 谓词的工具清单由包声明。
6. **证明**：08 的证明包打开审批，在 DB 模式下走完「试算 → 报价单（待审） → 工作台批准 → 推送 → 报价单页 → 确认收款」与驳回、撤回、过期、取代；旅游不变。

## 非目标

- 工业品询价包与演示租户：[10](../10-industrial-rfq-pack/spec.md)。
- 外部业务系统连接器（11）、客户发来的图片与文件（12）。
- 顾问审批时改单价或数量（开放问题 4）。
- 报价单的线上付款：报价单固定走顾问收款流程（R4）。
- 把旅游改成走核心的链接白名单步骤：旅游保留自己的链接步骤与空位修补，字节不变。

## 前置条件

- 08 `Status: implemented`，并已上线。
- 开工核对落进 plan 的内容：
  - 08 的实际接口名与本文的对照；
  - 「背景与问题」里列的链接写死处，在开工提交上重核、补全；
  - `HandoffKind` 的全部消费方，以及有没有库约束；
  - 6 个订单入口的现状代码位置；
  - 旅游基准：前缀、08 不变量 4 的四类输出、v2 结论，以及企微卡片与网页部件的字节。

## 开工前裁决

| #   | 主题               | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 审批保护什么       | 聊天里的价是**试算**：由工具声明，受 08 的 `money_provenance` 守出处，不需要审批。审批保护的是**正式报价单**：它的链接、它页面上的金额、它的订单状态流转（确认收款、取消）。<br>08 R8 放行集合的第 (2) 项（本会话订单的金额）收紧为「已批准、或不需要审批的订单」。待审报价单的合计，只能以试算的身份出现（也就是来自工具声明的金额）。<br>「带审批的通用单」下文简称**报价单**。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R2  | 建单与自动批准     | **建单**：包调 `createLineOrder(session, picks, { approval: true })`，建出的通用单带 `approval`（见接口）。包在 `PackRuntime.quotes` 里声明这个包建单时默认带审批，以及有效天数怎么取。<br>**自动批准**：建单时调包的钩子 `autoApprovable(order, session)`，返回 true 就当场批准（`auto: true`）。判定只看建单这一刻的快照，之后库存变了也不撤回。包不实现这个钩子，就全部人审。<br>**工具结果**：待审时，工具返回给模型的只有 `{ state: 'pending' }`，不含订单号、合计与链接；自动批准时返回 `{ state: 'approved', quoteUrl, totalText }`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R3  | 状态 × 动作        | 见下面的「状态表」。所有动作都在会话的写队列里按条件写：读出当前状态，与前置条件比较，相符才写，不符返回 409 及原因码。批准与驳回同时到达时，先写成的那个生效，后到的返回 409 `already_decided`。批准在等提交期间，若被别的动作改了状态（例如顾问撤回、会话重置，或同一会话的另一张报价单先被批准），提交后重读状态：已不是「已批准且有效」的，不推送，接口返回 409 与当时的原因码（`invalid`、`superseded`）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R4  | 六个订单入口       | 对报价单：<br>- `GET /api/orders/:id`、`/pay/:id`、`POST /api/orders/:id/pay`：一律 404。报价单只经 `/quote/:id` 与它的接口展示；<br>- console 的「确认价格」：409 `quote_order`，批准代替确认，批准时写 `confirmedAt` / `confirmedBy`；<br>- 「确认收款」：只对已批准的报价单可用，过期的也可以（顾问判断）；不看进程级付款方式，报价单固定走顾问收款流程；<br>- 「取消」：待审时等同撤回草稿，不通知客户；已批准时叫**撤回**，推 `quoteWithdrawnText`，状态见状态表。<br>不带审批的通用单，照 08 不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R5  | 批准与驳回的执行   | **批准**：<br>1. 按 R3 的条件写入 `approval.state = 'approved'`、`decidedAt`、`decidedBy` 与 `confirmedAt` / `confirmedBy`，并把本会话里更早的、已批准的报价单标为 `superseded`（R6）；<br>2. 记审计 `quote.approve`；<br>3. 等提交完成，重读状态（R3）；<br>4. 推送一条 `notice`，正文只有报价单链接本身，没有别的字。企微照现有的卡片抽取，正文去掉链接后为空，就只发一张卡片，卡片的标题与摘要来自本包 `siteLinks` 里 `quote` 的 `card`（开工核对确认 `sendRich` 现在是否如此；不是的话，在本 spec 里改成这样。旅游的卡片消息都带正文，输出不受影响）。网页渠道是一条带 `quote` 部件的消息，部件带标题。发送账本照实计数：正常是 1 次 `send_msg`；卡片超时或失败、退回成文字时，退回的那次另计；<br>5. 推送失败，照 `markPaidByAdvisor` 的写法追加备注。种子会话（`wecom:cust_*`）不推送。<br>**驳回**：<br>1. 原因必填，最长 120 字；<br>2. 订单 `cancelled`，`cancelReason` 写「顾问驳回：<原因>」，审计 `quote.reject`；<br>3. 推包的 `quoteRejectedText`，原因不发给客户；<br>4. 会话没转人工时，转人工（`kind: 'agent'`），由驳回人接手；已转人工时不改派，只追加一条系统备注。<br>**窗口**：工作台在两个按钮旁显示会话的发送窗口；窗口关着时仍可操作，但先提示「客户 48 小时内没发过消息，报价单发不出去」。                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R6  | 复用、取代与过期   | **复用**：新单的行集合与一张待审报价单相同，就复用它；与一张已批准、未过期的报价单相同，也复用它，并把它的状态与链接返回给工具。过期的不复用。<br>**取代**：<br>- 新的待审报价单，立即取代本会话里更早的待审报价单；<br>- 已批准、未过期的报价单，一直有效，直到本会话有一张更新的报价单被批准；在那之前，客户手里的链接照样能打开。<br>这两条修订 08 R3「同一会话最多一张待付的通用单」：对报价单，待审与已批准各至多一张。<br>**过期**：有效期截至 `decidedAt` 所在日（Asia/Shanghai）往后第 `validDays` 天的 23:59:59。过期是推算出来的，不改订单状态。过期的报价单不计入总览的「待付款」，也不占「各至多一张」的名额；下一次建单时，它被标为 `superseded`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R7  | 权限               | 批准、驳回、撤回：owner、admin、supervisor 可以操作任何报价单；agent 可以操作 AI 接待中（没转人工）的会话的报价单，以及自己接手的会话的报价单；viewer 不能操作。确认收款照 02 的权限。审计动作 `quote.approve`、`quote.reject`、`quote.withdraw` 要补中文标签（`src/shared/ui-labels.ts` 的 `AUDIT_ACTIONS`，`src/shared/audit-text.ts`）。共享工作台身份（`shared`）只出现在宿主的旧接口上，新的三个接口不接受它。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R8  | 提醒与总览         | **`quote_pending`**：建出待审报价单时排，去重键 `quote_pending:<订单号>`。执行体用 `getAnyOrder`，到点时报价单已不在待审就跳过。企微群文案是「有报价单等你审核」。<br>**`quote_accepted`**：由包的确定性回复排（R11），去重键 `quote_accepted:<订单号>`。执行体不要求会话在转人工中。文案是「客户确认了报价单，等你安排付款发货」。<br>两条提醒的标题、正文与时间标签，都写进 `src/shared/conversation.ts` 的通知文案表。<br>**不再重复提醒**：报价单不排 `order_unconfirmed`。总览「需要你处理」里，报价单显示「报价单等你审核」，不显示「等你确认价格」。订单卡对待审报价单高亮。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R9  | 报价单页           | **页面**：`/quote/:orderId` 返回 `public/quote.html`。品牌槽位照 `renderBrandPage`（`BrandPage` 加 `quote`），`/quote.html` 的静态入口同样注入品牌，og 标签不带金额。<br>**接口**：数据来自 `GET /api/quotes/:orderId`，返回 `PublicQuote`，套 `lookupLimit` 限流。<br>**状态映射**：<br>- 待审 → `pending`：只有状态，没有行与金额；<br>- 已批准、未过期 → `approved`：带 08 的 `OrderDisplay`、有效期、包给的说明；<br>- 已批准、已过期 → `expired`；<br>- 已付 → `paid`：带 `OrderDisplay`；<br>- 驳回或撤回 → `invalid`；<br>- 被取代 → `superseded`；<br>- 因重置作废的单、不是报价单的订单号 → 404。<br>页面上没有付款按钮，也没有「¥」。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R10 | 站内链接按包登记   | **核心登记**：放在新文件 `src/core/site-links.ts`，登记两种——`order`（`/pay/<订单号>`，`allowed` 是「属于本会话、不是报价单、没被取代」）与 `site`（隐私说明等站内通用页）。<br>**包登记自己的文档**：`PackRuntime.siteLinks` 每项给出线上格式 `linkKind`（字符串，由包取名；旅游沿用 `'proposal'`）、路径模式、`card(path, session)`（企微卡片的标题和摘要，可以返回 null）、可选的 `partTitle(path, session)`（网页部件的标题；不实现就不给部件填 `title`）、`allowed(session, path)`（这条链接此刻能不能发给这个客户）。旅游登记 `proposal`，`routeForProposal` 留在旅游包里。已有的线上取值 `'order'`、`'proposal'`、`'site'` 不改。<br>**改哪些**：「背景与问题」列的 TypeScript 写死处，全部改成读「核心登记 + 本租户包的登记」。登记按包区分：旅游租户不认 `quote`，模型编出来的 `/quote/…` 在旅游租户里不会变成卡片或部件。<br>**静态页**：`MessagePart` 加可选的 `title`，只有登记时实现了 `partTitle` 的种类才填；核心的 `order`、`site` 与旅游的 `proposal` 都不实现，旅游的部件逐字节不变（`src/web/web.selftest.ts` 按 `{ kind, linkKind, url }` 逐键比较）。正式网页渠道的 `web.js` 只加一次通用分支「部件有 `title` 就用它」，以后再加链接种类不用再改。模拟器 `chat.html` 与 `admin.html` 不读部件，而且只在宿主租户可用，不加 `quote`。`chat.html` 的 `stripLink` 必须保持自包含，对已有输入的输出不变（锁定的 `wecom.selftest.ts` 会把它抠出来运行）。<br>**核心链接白名单步骤** `linkWhitelistStep()`：只放行本租户已登记、且 `allowed()` 为真的链接；其余链接删掉，删完只剩「点这里」之类引导语的句子一并删掉。给新包用，旅游不用。<br>**旅游的字节**：企微卡片、网页部件、08 不变量 4 的四类输出、v2 结论，每一步结束时都与开工基准相同。 |
| R11 | 确定性回复的扩展   | `DeterministicReply` 加三个可选字段（见接口）。引擎的执行顺序：<br>1. 应用 `statePatch`（只能写 `packState`，按包的 schema 校验）；<br>2. 记录并发送回复文字；<br>3. 有 `handoff` 就转人工，`kind: 'pack'`，原因用包给的；<br>4. 有 `notify` 就排提醒任务。<br>确定性回复不经过出口护栏（今天也不经过），所以要用 `fixedId` 指向包在 `fixedReplies` 里登记的固定句（06 R21 的一致性检查覆盖）。带 `handoff`、`notify` 或 `statePatch` 的确定性回复必须带 `fixedId`，其余可以不带（旅游现有的确定性回复不改）。引擎发出之前核对 `fixedId` 已登记，且 `text` 能由登记项生成：没有变量的句子与样例逐字相同，带品牌、数字或 policy 文字的句子由登记项的模板正则匹配（06 R21 的登记项加可选的 `pattern`）；引擎追加的身份声明不算在内。测试与开发环境下不一致就抛错，生产环境记一条错误日志后照常发出。`kind: 'pack'` 只从这条路产生。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R12 | 转人工类型 `pack`  | `HandoffKind` 加 `pack`：行业包的确定性规则触发，原因由包给，最长 120 字。要跟着改的有：`HANDOFF_KIND_SET`、`HANDOFF_NOTICE_TEXT`、`HANDOFF_REASON`、看板的转人工统计（按原因分组）、console 的类型标签、模拟评测 `handoff` 谓词的可选 `kind`。开工核对确认这些里没有库约束；如果有，就补迁移。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R13 | 报价类工具由包声明 | 包的 `ShapePolicy.richTools` 已经存在，出口的 `shape_check` 在用它（`src/core/pack-api.ts:531`，`src/core/guards/shape.ts:192`）。模拟评测的 `shape` 谓词改为读同一份，不再写死 `judge.ts:31` 的 5 个工具名；旅游的结论不变。不新增成员。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R14 | 证明包             | 08 的证明包加上：<br>- 建单带审批，`autoApprovable` 判定「合计 ≤ 100 元且全部有现货」；<br>- `siteLinks` 登记 `quote`，`allowed` 只放行本会话已批准、未过期、未被取代的报价单；<br>- 用 `linkWhitelistStep`；<br>- 一条确定性回复：带 `handoff` 的（证明包的「非标」触发），带 `notify` 的（「确认报价」触发）；<br>- 报价单的固定句与卡片；<br>- `onQuoteDecided` 与 `followupGate` 两个钩子（R16）。<br>每一项都有自测或 v2 case。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R15 | 回滚               | 09 不加表，也不改列：审批状态在 `orders.data` 里，提醒原因在任务的 payload 里。08 的镜像读到报价单时，会当成普通通用单，从 `/api/orders` 交出金额、允许模拟支付，所以必须拦：库里有带 `approval` 的订单（`data->'approval' IS NOT NULL`）时，回滚到 pre-09 以 9 拒绝。镜像的判定：部署旧 tag 时用 `git ls-tree` 看 tag 的文件树，自动回滚时探测镜像里的文件，都看有没有 `src/core/site-links.ts`（R10 新建的文件）。处理步骤是：先停应用（订单在内存的 identity map 里，运行中直接改库会被下一次保存覆盖，同 02 的 `erase-conversation`），再用本 spec 提供的平台命令 `quote-void --all` 把全部报价单作废，然后回滚。作废的落法等同撤回、但不推送：`approval.state = 'withdrawn'`、订单 `cancelled`、审计 `quote.void`；状态表里记作「平台作废」。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R16 | 给包的两个钩子     | **`onQuoteDecided(session, order, event)`**：只在工作台的动作（批准、驳回、撤回）之后、同一次写入里调用，包据此推进阶段（如批准后进入「促成」）；返回新的阶段，或 null 表示不变。AI 回合里发生的变化（当场自动批准、新单取代旧单）不调它，由包的 `advanceStage` 在 `stage_advance` 里照常处理，免得两处争着改阶段。<br>**`followupGate(session, stage)`**：跟进框架在发每条跟进之前调用，返回 false 就跳过这一条（如「有待审报价单时不发报价阶段的跟进」）。没实现时等于返回 true。<br>两个都是可选钩子，旅游不实现，行为不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 状态表

行是报价单当前的状态，列是动作；格子里是结果，或者接口返回的 409 原因码。

| 当前状态        | 批准             | 驳回                  | 撤回（取消）     | 确认收款           | 本会话建了新报价单                                   | 会话重置              |
| --------------- | ---------------- | --------------------- | ---------------- | ------------------ | ---------------------------------------------------- | --------------------- |
| 待审            | 已批准，推送     | 已驳回，推送并转人工  | 作废，不推送     | 409 `not_approved` | 被取代（新单待审或当场批准都一样）                   | 作废（02 的重置规则） |
| 已批准、有效    | 幂等，不再推送   | 409 `already_decided` | 已撤回，推送     | 已付               | 新单待审时不变；新单被批准（含当场自动批准）时被取代 | 作废                  |
| 已批准、过期    | 幂等，不再推送   | 409 `already_decided` | 已撤回，不推送   | 已付               | 被取代                                               | 作废                  |
| 已驳回 / 已撤回 | 409 `invalid`    | 409 `invalid`         | 幂等             | 409 `invalid`      | 不变                                                 | 不变                  |
| 被取代          | 409 `superseded` | 409 `superseded`      | 409 `superseded` | 409 `superseded`   | 不变                                                 | 不变                  |
| 已付            | 409 `paid`       | 409 `paid`            | 409 `paid`       | 幂等               | 不变                                                 | 不变                  |

表外还有一个运维动作「平台作废」（R15，停机执行）：待审与已批准的报价单都落成撤回的状态，不推送；其余状态不变。

## 接口与数据流

```ts
// src/core/order-view.ts（08）加
export interface QuoteApproval {
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  requestedAt: number;
  auto?: boolean;
  decidedAt?: number;
  decidedBy?: { userId: string | null; name: string };
  reason?: string; // 驳回或撤回的原因，≤ 120 字，只给顾问看
}
// LineOrder 加 approval?: QuoteApproval
// 08 的 createLineOrder 加第三个参数，返回值不变（成功是 { order, reused }，有行被拒是 { rejected }）
export function createLineOrder(
  session: Session,
  picks: readonly LinePick[],
  opts?: { approval?: boolean },
): ReturnType<typeof createLineOrder08>;
export function quoteState(o: LineOrder, now: number): 'pending' | 'approved' | 'expired' | 'invalid' | 'superseded' | 'paid';

// src/core/pack-api.ts 加
export interface SiteLinkDef {
  linkKind: string; // 线上格式，由包取名；核心自己管 'order' 与 'site'，旅游沿用 'proposal'
  pattern: RegExp; // 站内路径，如 /^\/quote\/ord_[0-9a-f]{24}$/
  card?(path: string, session: Session): { title: string; desc: string } | null; // 企微卡片
  partTitle?(path: string, session: Session): string | null; // 网页部件的标题；不实现就不填 title
  allowed(session: Session, path: string): boolean;
}
export interface DeterministicReply {
  text: string;
  fixedId?: string; // 包在 fixedReplies 里登记的 id；带 handoff、notify、statePatch 的回复必须有
  handoff?: { reason: string }; // kind 固定为 'pack'
  notify?: { reason: 'quote_accepted'; orderId: string };
  statePatch?: Record<string, unknown>; // 只写 packState，过包的 schema
}
export interface PackRuntime {
  // …已有成员不变…
  quotes?: {
    approval: true;
    validDays(policy: unknown): number;
    autoApprovable?(order: LineOrder, session: Session): boolean;
  };
  siteLinks?: readonly SiteLinkDef[];
  onQuoteDecided?(session: Session, order: LineOrder, event: 'approved' | 'rejected' | 'withdrawn' | 'superseded'): SalesStage | null; // R16
  followupGate?(session: Session, stage: SalesStage): boolean; // R16
}
export interface EnginePackHooks {
  // …已有成员不变…
  quoteRejectedText?(order: LineOrder): string;
  quoteWithdrawnText?(order: LineOrder): string;
}
export function linkWhitelistStep(): GuardStep;
// src/shared/channel-types.ts：MessagePart 加 title?: string（R10）

// src/shared/conversation-types.ts
export type HandoffKind = ExistingHandoffKind | 'pack'; // ExistingHandoffKind 指今天的 11 种
// src/jobs/notify.ts
export type HandoffNotifyReason = 'started' | 'unclaimed' | 'window' | 'order_unconfirmed' | 'quote_pending' | 'quote_accepted';

// GET /api/quotes/:orderId
export interface PublicQuote {
  id: string;
  state: 'pending' | 'approved' | 'expired' | 'paid' | 'invalid' | 'superseded';
  brandName: string;
  display?: OrderDisplay; // 只在 approved、paid 时有（08）
  validUntil?: number;
  notes?: string[]; // 包给出的说明，如是否含税、交期以顾问确认为准
}
```

console 接口：`POST /orders/:id/quote/approve`、`POST /orders/:id/quote/reject`（`{ reason }`）、`POST /orders/:id/quote/withdraw`（`{ reason? }`）。工作台订单卡的 `can` 加 `approveQuote`、`rejectQuote`、`withdrawQuote`。

### 数据流

1. 模型调包的报价工具，由工具调 `createLineOrder(..., { approval: true })`。
2. 核心调 `autoApprovable`：
   - 返回 false：报价单待审，工具结果只有 `{ state: 'pending' }`，模型回包给的固定句；同时排 `quote_pending`。
   - 返回 true：当场批准，工具结果带链接，链接经包的 `allowed` 放行。
3. 顾问在工作台批准：按 R3 条件写入 → 审计 → 等提交 → 重读 → 推一张卡片（R5）。
4. 客户打开 `/quote/<订单号>`，页面按 R9 的状态映射显示。
5. 客户确认：包的确定性回复带 `notify: quote_accepted`（R11）。顾问线下安排付款，然后在工作台确认收款。

## 不变量

1. 旅游租户的 `PREFIX sha256`、锁定套件、v2 结论、08 不变量 4 的四类输出、企微卡片与网页部件的字节，每一步结束时都与开工时相同。
2. 外发的那一刻：任何外发（AI 回复、跟进、确定性回复、`notice`）里出现的 `/quote/<id>`，所指的报价单在那一刻都是「已批准、有效」。外发时在消息的 `extra` 里记下链接所指报价单当时的状态，断言按这条记录做，不按报价单现在的状态。后来被取代、过期或撤回的报价单，之前合法发出的链接不算违反。
3. 任何时刻：不是「已批准、有效」或「已付」的报价单，`GET /api/quotes/<id>` 的响应里没有它的金额；`GET /api/orders/<id>`、`/pay/<id>`、模拟支付对任何报价单都返回 404。
4. 一次批准恰好触发一次推送（种子会话为零次）；重复批准不再推送。正常情况下，企微的这次推送是 1 次 `send_msg`。
5. 报价单的状态只沿状态表变化；表外的动作返回 409，状态不变。
6. 报价单的行与金额从建单起就不再改变。
7. 没批准过的报价单，状态不会变成 `paid`。
8. `kind: 'pack'` 的转人工只来自确定性回复，原因 ≤ 120 字。
9. 带 `handoff`、`notify` 或 `statePatch` 的确定性回复都有 `fixedId`，且已在包的 `fixedReplies` 里登记，`text` 能由登记项生成（样例逐字相同，或匹配登记的模板正则）。
10. 驳回与撤回的原因不出现在发给客户的任何文字里。

## 兼容与迁移

- 不加表，也不改列。若开工核对发现 `HandoffKind` 或任务原因有库约束，补迁移，序号接在 08 之后。
- 先做站内链接登记表（R10）并跑通旅游的字节基准，再做审批（R2–R9），最后做确定性回复与 `pack`（R11、R12）。
- 回滚见 R15。

## 安全、隐私与性能

- **凭据**：报价单页与接口靠不可猜的订单号做凭据，同 `/pay`，并照样限流；没批准时不返回金额。报价单从六个订单入口一律拿不到。
- **钱**：报价单的金额来自 08 的 `priceLine`；审批只改状态，不改金额；确认收款前必须批准过。
- **隐私**：驳回与撤回的原因只给顾问看。
- **外发预算**：批准通知正常只占 1 次 `send_msg`（只发卡片）；窗口关着时先提示，推送失败追加备注，不重试。

## 验收标准

1. **旅游不变。** 照 08 验收 1；另加企微卡片与网页部件的字节基准，相同。
2. **六个入口。** 证明包的待审报价单：
   - `GET /api/orders/:id`、`/pay/:id`、`POST /api/orders/:id/pay` 返回 404；
   - console 确认价格返回 409 `quote_order`，确认收款返回 409 `not_approved`；
   - 批准之后，确认收款成功，且与进程的付款方式无关（online 与 advisor 各验一次）。
3. **试算与正式。** 证明包一段 mock 对话：试算的价照常发出，并有出处；要报价单时，工具结果里没有订单号与合计，AI 回复里没有 `/quote` 链接。
4. **状态表。** 状态表的每一格都有一条测试，结果或 409 原因码与表一致；批准与驳回并发，恰有一个成功；批准等提交期间被撤回、被重置、或同会话另一张单先被批准时，不推送，返回 409 与对应的原因码。
5. **批准与驳回。**
   - agent 在 AI 接待中的会话上批准成功，企微只收到一张卡片、没有单独的文字，发送账本记 1 次；重复批准不再推送；消息的 `extra` 记下了当时的状态 `approved`；
   - viewer 返回 403；
   - 窗口关着时，工作台先提示，推送失败后会话里有备注；
   - 驳回：原因为空被拒；填了原因后，订单 `cancelled`，客户收到固定句，会话转给驳回人，原因不在客户收到的文字里；已转人工给别人的会话被驳回时，不改派、追加备注；
   - 撤回已批准的报价单：客户收到固定句，页面显示 `invalid`。
6. **复用、取代、过期。**
   - 同样的行再要报价单，复用；
   - 已有已批准的单时再建一张：旧单在新单被批准前一直能打开，新单批准后旧单显示 `superseded`；
   - 有效期按 Asia/Shanghai 自然日计算，用注入的时钟验证边界（最后一天 23:59:59 有效，下一秒过期）；
   - 过期的单不计入总览的「待付款」。
7. **报价单页。** 七种状态（含 404）各一张截图，文字与 R9 一致；og 标签里没有金额；页面上没有「¥」，也没有付款按钮。
8. **提醒与总览。** 建出待审报价单：企微群收到「有报价单等你审核」一次（去重），总览出现「报价单等你审核」，不出现「等你确认价格」，也没有排 `order_unconfirmed`；客户确认：收到 `quote_accepted` 提醒一次（多次确认只提醒一次），会话不在转人工里也照常发。
9. **链接登记表。** 旅游的四类输出、企微卡片、网页部件不变；证明包的 `quote` 链接在网页渠道显示为带标题的卡片、在企微是一张卡片；旅游租户的回复里出现 `/quote/…` 时，它不会变成企微卡片，也不会变成网页部件；`linkWhitelistStep` 删掉没登记、或 `allowed` 为假的链接，并删掉只剩引导语的句子；锁定的 `wecom.selftest.ts` 全绿。
10. **确定性回复与 `pack`。** 证明包的「非标」触发：会话转人工，`kind: 'pack'`，原因对，看板按原因统计里出现它；「确认报价」触发：`packState` 按 `statePatch` 改了，提醒排上。测试环境下，确定性回复的 `fixedId` 没登记、或 `text` 与登记的样例不一致时，引擎抛错。
11. **评测。** 模拟评测的 `handoff` 谓词能断言 `kind: 'pack'`；`shape` 谓词读包的 `ShapePolicy.richTools`，证明包的清单生效；旅游的 `shape` 结论不变。
12. **两个钩子。** 证明包：报价单批准后阶段按 `onQuoteDecided` 推进；有待审报价单时，`followupGate` 让报价阶段的跟进跳过（注入时钟验证）。
13. **回滚。** 有报价单时部署 08 的 tag：检查脚本以 9 拒绝，并打印处理步骤；停应用、执行 `quote-void --all` 之后，全部报价单落成撤回状态、客户没收到任何推送，回滚放行；自动回滚同样经过这道检查。

## 开放问题

1. **agent 能不能审 AI 接待中的会话的报价单。** 推荐能（R7）：询价审批通常发生在 AI 还在接待的时候，只限接手人本人，就等于只有主管能审，报价会卡住。代价是比退款审批（主管以上）宽，所以只放开批准、驳回、撤回这三个动作。备选是只给 supervisor 以上。
2. **撤回已批准的报价单要不要通知客户。** 推荐通知（R4）：客户手里的链接会变成「已失效」，不说一声体验更差。
3. **有效期按自然日还是按小时。** 推荐按 Asia/Shanghai 自然日（R6），客户说「7 天内有效」时，理解的就是自然日。
4. **顾问审批时能不能改单价或数量。** 推荐本 spec 不做：驳回后由顾问在对话里重新报，或者让 AI 重新出单。改价涉及另一套审计与权限，留给后续 spec。
5. **过期的报价单还能不能确认收款。** 推荐能（R4）：客户在过期后才付了款的情况真实存在，由顾问判断。

## 被否决的方案

- **用 02 的「确认价格」当报价审批。** 它不拦链接外发、依赖进程级的付款方式、确认后不通知客户、agent 动不了 AI 接待中的会话。
- **把任意一条 AI 回复挂起，等人审过再发。** 要改引擎、渠道与发送账本，还会把每一轮的延迟变成「等人」。人审的对象应该是报价单这个结果，不是每一句话。
- **全局的站内链接表。** 方案书卡片要用旅游的函数，全局表会让核心依赖旅游；旅游回复里编出来的 `/quote/…` 也会被当成合法链接。改成按包登记。
- **让旅游也改走核心的链接白名单步骤。** 旅游的空位与修补机制钉在锁定断言里；改走新步骤，只能靠字节比对证明没变，收益只是代码统一。
- **新的待审报价单立即作废客户手里有效的已批准报价单。** 客户会拿着一个失效的链接，而新单可能几小时后才审。
- **为每个包单开一种转人工类型。** 一个通用的 `pack` 加上包给的原因，统计与文案只需改一次。

## 分批

1. **批 A**：开工核对与基准。
2. **批 B**：站内链接按包登记与核心链接白名单步骤（R10），跑通旅游的字节基准。
3. **批 C**：报价单的状态、建单、复用与取代、6 个入口、过期（R1–R4、R6）。
4. **批 D**：工作台的批准、驳回、撤回，权限，推送，提醒与总览（R5、R7、R8）。
5. **批 E**：报价单页（R9）。
6. **批 F**：确定性回复与 `pack`（R11、R12）、`richTools` 的评测读法（R13）、两个钩子（R16）、证明包收口（R14）、回滚（R15）、验收、上线。

步骤、依赖与工作量见 [plan](plan.md)。
