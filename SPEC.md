# wecom-sales-agent 构建规格（初始版本存档）

> 本文是动工前的初始规格，保留作演进对照：线路数、销售阶段判定方式等均已在实现中迭代
> （如 stage 已从「模型输出 JSON 自报」改为「从工具调用反推」）。**当前事实以 README 为准。**

一个「企业微信 AI 旅游销售 Agent」demo：客户在聊天里被 AI 接待——识别需求 → 推荐线路 → 报价 → 生成订单 → mock 支付 → 支付后主动跟进；支持关键词/风险转人工。渠道层可插拔：本地用「模拟器」（企微风格网页聊天），真企微通过 adapter 接入。

技术栈：Node 20+ / TypeScript / Hono / tsx 直跑，无数据库（JSON 落盘到 `var/`），无前端框架（原生 HTML+JS）。LLM 走 OpenAI 兼容协议（默认智谱），支持 function calling。共享类型在 `src/types.ts`，是唯一契约，不得改动已有字段（可加字段）。

## 模块与文件归属

### 1. 业务数据（`data/`）
- `data/routes.json`：`Route[]`，14 条高端定制旅行线路（马尔代夫、瑞士、日本、新西兰、北欧极光、迪拜、巴厘岛、意大利、肯尼亚 safari、南极、三亚、新疆、摩洛哥、法国），价格 1.5w–16w/人量级，字段见 types.ts。内容要像真产品：highlights 具体到酒店名/体验项目。
- `data/sop.md`：销售 SOP，供引擎注入 system prompt。包含：各销售阶段的目标与话术原则（一次只问 1–2 个问题、先共情再推荐、报价必须来自工具结果不得编造、每人价 × 人数 = 总价）、异议处理套路（价格贵 → 拆价值/给替代）、转人工条件（客户明确要求、投诉、退款、连续两轮听不懂）、微信语气规范（口语化、短句、适度 emoji、不堆砌）。

### 2. 引擎（`src/store.ts`、`src/llm.ts`、`src/tools.ts`、`src/engine.ts`）
- `store.ts`：内存 Map + JSON 落盘（`var/sessions.json`、`var/orders.json`，写时防抖即可）。导出：`getOrCreateSession(id, channel)`、`getSession(id)`、`listSessions()`、`saveSession(s)`、`createOrder(o)`、`getOrder(id)`、`markOrderPaid(id)`、`listOrders()`。
- `llm.ts`：OpenAI 兼容 chat completions 封装（fetch，读 env：LLM_BASE_URL/LLM_API_KEY/LLM_MODEL），支持 `tools` 参数与多轮 tool 调用循环（最多 5 轮）。`LLM_MOCK=1` 时返回确定性脚本：按用户消息关键词依次走「问需 → 推荐(调 search_routes) → 报价(调 create_quote) → 下单(调 create_order)」，保证离线冒烟能跑通全链路。
- `tools.ts`：function calling 工具集，实现 + JSON Schema 定义：
  - `search_routes({destination?, tags?, maxBudgetPerPerson?, days?})` → 匹配的 Route 摘要列表（最多 3 条）
  - `get_route_detail({routeId})` → 完整 Route
  - `create_quote({routeId, travelers, departDate?})` → `{routeTitle, perPerson, travelers, total, note}`（旺季 bestSeason 命中 +10%，4 人及以上 95 折，规则写死）
  - `create_order({routeId, travelers, departDate})` → 创建 Order（pending_payment），返回 `{orderId, payUrl: "/pay/"+orderId, total}`
  - `handoff_to_human({reason})` → 标记 session.handedOver
- `engine.ts`：核心导出 `handleMessage(sessionId: string, text: string, channel: string): Promise<AgentReply>`。职责：取/建 session → 追加客户消息 → 组装 system prompt（sop.md + 当前画像 + 阶段 + 最近 30 条历史）→ LLM 工具循环 → 更新 stage 与 profile（让 LLM 在回复末尾以约定 JSON 块输出 stage/profile 增量，引擎解析后剥离，解析失败则沿用旧值）→ 追加 agent 消息 → 落盘 → 返回 AgentReply。已 handedOver 的会话不再走 LLM，返回固定话术「已为您转接人工顾问」。另导出 `notifyPaid(orderId): Promise<{sessionId, text} | null>`：支付成功后生成跟进话术（LLM 或模板），由调用方负责经 adapter push。

### 3. 服务与界面（`src/server.ts`、`src/adapters/simulator.ts`、`src/adapters/wecom.ts`、`public/chat.html`、`public/pay.html`、`public/admin.html`）
- `server.ts`：Hono app，端口 env.PORT（默认 3200）。路由：
  - `GET /` → 302 到 `/chat.html`；静态托管 `public/`
  - `POST /api/chat` `{sessionId?, text}` → `{sessionId, reply: AgentReply}`（无 sessionId 则生成）
  - `GET /api/stream/:sessionId` → SSE，simulator adapter 的 push 通道
  - `GET /api/sessions` / `GET /api/sessions/:id` → admin 用
  - `POST /api/sessions/:id/handoff` → 人工接管（置 handedOver）
  - `POST /api/sessions/:id/reply` `{text}` → 人工以顾问身份回复（写入 messages 并 push）
  - `GET /api/orders`、`GET /api/orders/:id`
  - `POST /api/orders/:id/pay` → markOrderPaid → `engine.notifyPaid` → adapter.push
  - `POST /wecom/callback` + `GET /wecom/callback`：企微回调占位（见 adapters/wecom.ts）
- `adapters/simulator.ts`：实现 ChannelAdapter；维护 sessionId → SSE 连接集合，push 即下发。
- `adapters/wecom.ts`：企业微信「微信客服」（kf）轮询适配器，完整实现但仅在配齐 env（WECOM_CORP_ID / WECOM_APP_SECRET / WECOM_KF_OPEN_KFID）时启动：
  - access_token 获取与缓存（gettoken，7200s 提前 300s 刷新）；
  - `kf/sync_msg` 轮询循环（cursor 持久化到 `var/wecom-cursor.json`，间隔 env.WECOM_POLL_INTERVAL_MS 默认 3000，不配回调 URL——官方允许纯轮询，频率受限但 demo 够用）；
  - 收到文本消息 → sessionId 用 `wecom:` + external_userid → `engine.handleMessage` → `kf/send_msg` 回复文本（回复里的 /pay/ 链接拼上 env.PUBLIC_BASE_URL 变成完整 URL）；
  - 实现 ChannelAdapter.push（send_msg）；非文本消息回固定话术。
  - 文件头注释写清接入步骤：注册企微 → 开通微信客服建客服账号 → 建自建应用并在「微信客服-可调用接口的应用」里绑定 → 配企业可信 IP → 填 env。此通道未配 env 时完全静默，不影响模拟器。
- `public/chat.html`：企微风格聊天页（手机宽度居中、白底气泡、右侧绿色客户气泡、左侧白色 AI 气泡、头像「云途旅行顾问·AI」、顶部导航栏）。功能：发消息调 /api/chat、SSE 收 push、AI 回复里的 `/pay/xxx` 链接可点、打字中指示、sessionId 存 localStorage、右上角「新会话」。**回复中的换行要渲染**。底部小字：「Demo：模拟企业微信会话。生产环境经企微回调接入，界面即企业微信本身。」
- `public/pay.html`：`/pay/:orderId` 由 server 重写到此页（或用 query 传 id）。展示订单摘要（线路、人数、出发日期、总价）+ 大按钮「微信支付 ¥xxx」（mock）→ POST pay → 成功态「支付成功，顾问将与您确认行程」。样式仿微信支付收银台（绿色主题）。
- `public/admin.html`：销售后台。左侧会话列表（阶段徽标颜色区分），右侧选中会话：客户画像卡（目的地/人数/日期/预算）、当前销售阶段进度条（greeting→…→paid）、消息流、订单列表、「接管会话」按钮 + 接管后的回复输入框。轮询刷新即可（2s）。这一页是「销售阶段判断 + 画像沉淀 + 人工接管」的核心演示面。

## 验收（集成阶段执行）
1. `pnpm install` 后 `pnpm typecheck` 零错误。
2. `LLM_MOCK=1 pnpm start` 起服务，curl 依次发「你好」「想去马尔代夫蜜月」「两个人，预算每人3万」「就订这个」走完 greeting→discovery→recommend→quote→closing，最终拿到 orderId；`POST /api/orders/:id/pay` 后 session 出现支付跟进消息且 stage=paid。
3. chat.html / pay.html / admin.html 三页在浏览器可用（用 chrome-devtools 或 playwright 截图核验布局不破）。
4. README.md：一句话定位、架构图（ASCII）、本地跑法、企微接入生产路径（占位，后续补认证政策细节）、demo 话术示例。
