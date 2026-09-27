# 后台 UX 重做 · 实现计划

对应 [spec.md](spec.md)，视觉细则在 [design-system.md](design-system.md)。只记步骤和状态，不复述设计；步骤里的「验收 n」「不变量 n」「开放问题 n」都指 spec，参数取值一律看 spec 对应的小节。

每一步单独一个 PR 进 `dev`；子步骤可以分开提 PR，某个子步骤阻塞时（如第 1.4 步等开放问题 1），同一步的其余子步骤照常合并。每个 PR 结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。界面改动在 PR 里写 BEFORE/AFTER。新增依赖一律钉精确版本，版本在安装时核实并写进 PR。新加的自测和检查脚本都要串进根 `package.json` 的 `test` 或 `lint`，否则不算做完。括号里是工程日估算，合计约 40 个工程日（不含标「阻塞」的第 18–20 步）。标「阻塞」的步骤等前置条件满足才开工。

- [x] 0. 开工前提
  - [x] 0.0 把这次重写落进仓库（一个 docs PR）：`docs/features/console-ux/` 下的 spec、design-system、references、plan；同一个 PR 里把 01 plan 第 368、380 行的「UX spec 第 10 步」改成第 8 步；在 `docs/spec-driven-dev.md` 注明一个 spec 文件夹可以带配套细则文件（如 references.md、design-system.md），细则不记进度、不定行为，和 spec 冲突时以 spec 为准。
  - [x] 0.1 01 翻为 `implemented`（01 plan 第 20 步）。在那之前本 spec 不开工。
  - [x] 0.2 （owner）在确认 01 验收时定开放问题 1：01 里所有不是新增的改动（安全头两处、页面条款五处、01 验收 16 第 4 条与验收 22）走 01 的就地修订还是另写小 spec；同时答复开放问题 5（匿名是否显示租户名）和开放问题 9（决定 (1) 的范围）。
  - [x] 0.3 写 ADR-004「产品库表单由行业包的字段配置渲染」，取代 ADR-002 决策 1 里「由 zod schema 转成 JSON Schema 自动生成」一条；owner 采纳。
  - [x] 0.4 （owner）审阅 spec 与 design-system，翻为 `ready`。开工时明确说「按 docs/features/console-ux/spec.md 实现」：本 spec 不在自动选活的范围里。
- [ ] 1. 主题与字体地基（4）
  - [ ] 1.1 `console/src/theme/`：两套令牌、`brand.css`（design-system §1.5，含 `data-reduce-motion`）、antd 映射（§8）、`ConfigProvider` 的 `wave`、`requiredMark`、`motion`、Tabs 不带动画；`/console/theme-boot.js` 首帧设 `data-theme` 与 `data-reduce-motion`，外观与「减少动态效果」存 `localStorage`，读写包 try/catch。`theme.selftest.ts` 串进 `pnpm test`（验收 1、不变量 1）。
  - [ ] 1.2 字体：`scripts/fonts/build.ts` 生成 `geist-ui`、`geist-mono-ui`、`noto-sans-sc-ui` 三个 woff2、码位清单和 sha256，并从 `@fontsource-variable/noto-sans-sc` 的清单生成长尾分片的 `@font-face`（声明顺序见 spec「字体与授权义务」）；`console/vite.config.ts` 设 `build.assetsInlineLimit: 0`；Vite 小插件注入两个 preload；`console/public/licenses/` 放三份许可原文；仓库根目录新建 `NOTICE`。字体码位检查串进 `pnpm test`（不变量 30）。
    - 在 Chromium、Firefox、WebKit 上实测开放问题 4：只渲染界面文案时有没有长尾分片请求，连用标点宽度是否符合 P 页。结论记进本文件；不成立就按开放问题 4 改成全量自切，同时在 spec 顶部加一行 `Revisions:`，改「字体与授权义务」「性能」两节和验收 8、23，再继续。
  - [ ] 1.3 标点与间距：全局 `text-spacing-trim` / `text-autospace`；`src/shared/typography.ts` 的 `haltIndices`，自测用 design-system §2.2 核对过的 576 对结果，串进 `pnpm test`；`cjk()` 文本助手与 `Sep`；`console/src/_specimen/` 下的 `/_specimen/type`（P 页）和 `/_specimen` 控件样张，只在 `VITE_SPECIMEN=1` 时注册。
  - [ ] 1.4 （阻塞：开放问题 1）静态资源与安全头：`src/shared/security-headers.ts` 的 `BASE_CSP` 加 `font-src 'self'`，并导出资源头函数；`src/console-api/host.ts` 用它给 `/console/assets/*` 带 `immutable`，JS、CSS 按 `Accept-Encoding` 走 gzip（Hono `compress`）；`console/vite.config.ts` 的 `previewWithCsp` 改用同一个函数。按开放问题 1 定下的文本改 `console.selftest.ts` 里钉死安全头的断言（`CSP` 常量，`secured()` 对 `/console/assets/app-1a2b.js` 与全部 `/api/console` 响应的检查），其余断言不动；新增不变量 26 的断言。
- [ ] 2. 外壳、通用部件与新增接口（5）
  - [ ] 2.1 服务端与共享代码：`Me.tenantName`；`src/shared/pack.ts` 的类型；`src/packs/travel/console-pack.ts` 与 `src/packs/registry.ts`，`tenant-create` 改读注册表；`GET /pack`；`src/shared/conversation.ts`（`conversationState`、`shortIdOf`）；`ConvQuery.state` / `stage` / `order` 与 `GET /conversations/counts`；`sectionBody`、`editableChars` 连同 `SopStructureError` 等挪到 `src/shared/sop-sections.ts`（做法见 spec「额度条」）。`console.selftest.ts` 加验收 15 的第 1、5、6、7 条。01 implemented 之后在 01 顶部加 `Amended by:`。
  - [ ] 2.2 外壳：启动的加载与出错（spec「外壳 · 启动」）；侧栏由行业包生成（分组、计数、会话软徽标）；租户行与铃铛弹层，含空状态与轮询失败，刷新方式按 spec「外壳 · 计数刷新」；搜索触发器与 ⌘K（键盘、数据来源、各种状态按 spec「外壳 · 搜索触发器」，拼音库懒加载）；用户行（纯 CSS 先藏角色）与用户菜单（外观、减少动态效果、关于、退出）；受控收起与 `useViewport()` 三档；匿名外壳与横幅；非编辑角色的「只读」；跳转链接与地标；`document.title`。
  - [ ] 2.3 通用部件：`StateView`、`ERROR_COPY`（含兜底）、`TechDetails`、`ConfirmDanger`、`Status`、`ActionBar`、`CheckList`、墨色主按钮组件、成功 toast 函数；未保存保护（`useBlocker`）；会话过期的判定与就地重登（spec「会话过期的判定」）；全站去掉 `message.error`。`scripts/check-console-src.ts` 挂进 `pnpm lint`，先覆盖不变量 2–4、6、8、9、28。
  - [ ] 2.4 拆包与预算：各页 `.lazy()`；删掉 `chunkSizeWarningLimit` 覆盖，开 `build.manifest`；确认 `assetsInlineLimit: 0` 已生效；扩展 `scripts/check-console-dist.ts` 的 JS 与字体预算、禁入内容（spec「性能」）。拆包前后的数字记进交接记录；超预算按开放问题 8 请 owner 定，选放宽时在 spec 顶部加 `Revisions:` 并改「性能」和验收 23。
- [ ] 3. 字段渲染器与行业包配置（4）
  - [ ] 3.1 `checkPack`、`checkItem`（含数组的 `min` 与必须项的计数口径，spec「校验」）、`ENTITY_ICONS`；旅游包补全（design-system §9，含 `recommend`、`min`）；假包 `src/shared/pack-fixtures/renovation.ts`；`src/packs/packs.selftest.ts`（不变量 13–15），串进 `pnpm test`。
  - [ ] 3.2 渲染器：11 种字段类型各三种形态（`Record<FieldType, …>`，不变量 12）；实体图标映射；表单状态与 `set` / `unset`；`storeAs` 的 `parse` / `format`；表单网格（design-system §6.0、§6.4）；`console/src/fields/fields.selftest.tsx`（两个包的每个字段；不变量 16 的往返），串进 `pnpm test`；`scripts/check-boundaries.ts` 只给这一个文件开 import `src/packs/registry.ts` 与 `src/shared/pack-fixtures/` 的例外。
  - [ ] 3.3 `check-boundaries.ts` 禁止其余 `console/src` 文件 import `src/packs/**` 与 `src/shared/pack-fixtures/**`；`check-console-src.ts` 加上行业包词汇扫描（不变量 11 的范围与白名单）和不变量 17 的 console 一侧；`check-console-dist.ts` 断言产物里没有假包内容（不变量 25）。
  - [ ] 3.4 `src/shared/ui-labels.ts`（检查项名、角色、`AUDIT_ACTIONS`、`ERROR_COPY` 的文案）与 `src/shared/format.ts`（金额、相对与绝对时间、月份区间）；`AuditQuery.actions`（服务端与验收 15 第 8 条）；`describeAudit(entry, pack, lookups)`（实体名、字段名取自行业包）。总览的「最近变更」和第 14 步都用它们。
- [ ] 4. 总览（1.5）：路由 `/` 取代重定向；需要你处理、系统状态、业务数、客户停在哪一步、最近变更，各块独立加载与出错；匿名总览（验收 10）。`scripts/seed-demo.py` 加 `--scenario console-ux` 与 `--now`（验收 4「走查种子与时钟」），不带这两个参数时输出不变。
- [ ] 5. 销售话术一：编辑（3）
  - [ ] 5.1 状态句、额度条（用第 2.1 步挪好的 `src/shared/sop-sections.ts`）、目录（分段筛选、锁定原因、键盘、URL 的 `section`、窄屏下拉）。
  - [ ] 5.2 编辑器：按 spec「编辑器」（字阶、markdown 装饰、工具与字段芯片、✗ ✓ 图标、改动沟槽与新增高亮、回退时的 `halt` 装饰、`aria-label`、`phrases` 汉化）；固定规则节只读说明。
  - [ ] 5.3 自动保存按 spec「自动保存」（防抖、`rev`、退避、`⌘S`、409 停住并保留对比）；离开保护；1280–1439 与 <1280 的布局。
- [ ] 6. 销售话术二：检查与发布（2.5）
  - [ ] 6.1 `ContractViolation.match`：`checkSopContract` 在四类违规里填值，`console.selftest.ts` 加验收 15 第 2 条。
  - [ ] 6.2 每次自动保存后检查；检查清单与定位；行内提醒与「改成…」（候选范围按 spec「检查 · 行内提醒」）。
  - [ ] 6.3 常驻发布条（禁用原因、成功结果与「回滚到vN」）；发布抽屉（检查、替换说明、逐节差异与行内 / 并排切换、覆盖 `@codemirror/merge` 的红色、预填说明）。
- [ ] 7. 销售话术三：版本记录与回滚（2）：版本记录抽屉（说明在前、技术详情折叠、翻页、加载 / 出错 / 到底）、「查看改动」、回滚确认（后果按有无交集分两种、固定规则提示、差异、必填原因）、「载入到草稿再改」、「更多」里的丢弃确认。
- [ ] 8. 销售话术四：冲突合并（2）：`SaveDraftBody.rebaseOnto`（服务端与验收 15 第 3、4 条）；合并模式界面（`revertControls`、汉化、「完成合并」后回到发布抽屉）。落地后在 01 plan 的 Open 里把「冲突后只能丢弃重做」那条标成已解决，指向本步。
- [ ] 9. 产品库列表（1.5）：列、首列两行、筛选按字段类型生成、页签与计数、搜索、URL 状态、分页、各种状态、匿名与非编辑成员。
- [ ] 10. 产品库详情与编辑（3.5）
  - [ ] 10.1 路由 `/catalog/$kind/$code` 与 `/catalog/new/$kind`；两栏；分组卡片、锁定 Tag 与原因、只读形态、「已改」与撤销；副栏（状态与锁定组、上架前检查、最近更新）。
  - [ ] 10.2 保存条与补丁提交；422 报错落到字段、只显示碰过的字段；409；`src/shared/catalog.ts` 的报错去掉英文键（验收 15 第 10 条）。
  - [ ] 10.3 上架确认（必须项没过时跳到字段）；复制为新草稿；「预览」页签；新建。删除旧的抽屉和 `@rjsf/*` 依赖。
- [ ] 11. 有序子项与引用（2）：通用有序子项编辑器（节点、条数提醒、上移下移、自动编号、锁定条数）；引用字段的分组联想、`allowFree` 提示、「复制上一{itemNoun}的…」；长文本 `softMax` 提示。
- [ ] 12. CSV 导入（2）：五步弹窗；中文表头模板与 BOM；UTF-8 严格解码加 `gb18030` 兜底；空文件与只有表头；前端预检与三条上限；「只导入合格的N行」；下载不合格行时防公式注入；`prepareCatalogCsv` 接受中文表头、去掉本系统加的前缀（验收 15 第 9 条）。
- [ ] 13. 会话列表（1）：I 页（页签与阶段条来自同一次 counts、`order=waiting_first`、最后动静的时间写法）；`public/admin.html` 的 `#s=<id>` 深链，登录流程中保留 hash。
- [ ] 14. 审计日志（1.5）：用第 3.4 步的 `AuditQuery.actions` 与 `describeAudit`；筛选写进 URL；按天分组的时间线与连续同类记录合并；详情抽屉；「加载更早的记录」。
- [ ] 15. 登录页（0.5）：一栏布局、「密码」文案（`PasswordBusyError` 与登录失败的 `detail` 同步改）、错误就地显示、「返回演示」。
- [ ] 16. 可访问性与响应式收尾（1）：焦点顺序、目录方向键、点击目标、375 宽只读页、992–1279 图标栏、减少动态效果（验收 24）。
- [ ] 17. 走查（2）
  - [ ] 17.1 假包「后加」：按验收 5 第一条往假包里加新字段，这次提交不碰 `console/src/`。
  - [ ] 17.2 本地真实 Postgres 加 preview（`VITE_SPECIMEN=1`），种子与时钟按验收 4「走查种子与时钟」；浅色、深色各一轮，截图存 `walkthrough/{light,dark}/`；每个路由的计算样式扫描与同 URL 刷新比对；渲染后对比度与 axe；假包走查；四种状态一致；三个引擎的标点宽度；字体请求与许可；工程信息扫描；LCP、CLS。缓存与 gzip 在真实 host 上测（验收 23）。走查脚本放在仓库外。结果记进下方「验收记录」（验收 2、4–11、22–24）。
- [ ] 18. （阻塞：02；由谁实现见开放问题 2）02 之后的页面：
  - 共享类型与判定：`conversationState` 加第四种状态 `assigned`（顾问处理中），`human` 改为转人工且没有接手人；`ConvQuery.state`、`ConversationCounts.byState` 加 `assigned`；服务端过滤、计数与 `console.selftest.ts` 的对应用例同步（spec「依赖 02 的后端」第 2 项）。
  - 会话列表（I 页）加「顾问处理中」页签，行里补上 02 的字段（原因、等待时长、接手人）；总览、徽标、铃铛按四种状态更新。
  - 会话工作台（J 页，路由 `/conversations/$id`）；总览的 A2 部分；铃铛与标签页标题的实时更新和浏览器通知；接手与交还；快捷回复（「依赖 02 的后端」第 13 项）（验收 26）。
- [ ] 19. （阻塞：后端，归属见开放问题 3）系统页（N 页）：平台管理员身份、只读诊断接口、各卡片标明数据来源（验收 27 前半）。
- [ ] 20. （阻塞：后端，归属见开放问题 3）租户品牌色：主色生成器与单元测试（design-system §1.3）、撞色提醒、品牌设置页、服务端按租户注入主题 CSS（验收 27 后半）。
- [ ] 21. 对照 spec 当前的全部验收标准逐条验证，结果记进本文件「验收记录」。
- [ ] 22. 清理临时探针和测试产物：仓库外的走查库与脚本、下载的浏览器、`VITE_SPECIMEN` 构建；确认工作区干净，没有遗留进程。
- [ ] 23. owner 确认验收通过后，把 spec 的 `Status` 更新为 `implemented`。

## 砍法

工期偏紧时按顺序砍，每砍一项都在 spec 顶部加一行 `Revisions:`，写明改了哪些目标、接口和验收编号：

1. 第 10.3 步的「预览」页签（验收 4 的「线路预览」状态改成只读编辑页签）。
2. ⌘K 的拼音与首字母搜索，只留中文子串匹配。
3. 第 11 步引用字段的分组联想，只留普通的自由输入加「复制上一{itemNoun}的…」。

不能砍：行业包配置与渲染器（第 3 步）、字体与许可（第 1.2 步）、`rebaseOnto`（第 8 步）、四种状态与同源计数（第 2.1 步）：这些决定页面结构和对外义务，以后补的代价比现在做大。

## 交接记录

（按日期追加：已完成 / 半成品状态 / 阻塞 / 下一步）

### 2026-09-27

- 已完成：spec、design-system、references 按 v4「利落」方向整份重写，本文件同步重排。上一稿的步骤一步都没开工，编号全部作废；01 plan「Open」里指向「UX spec 第 10 步」的 `rebaseOnto`，现在是第 8 步（第 0.0 步里改 01 plan 的两处）。
- 设计样张 A–P（含 owner 2026-09-27 四项决定之后重画的 E、J、N 和新补的 P）已经在仓库外完成并通过 QA；仓库里只以 design-system.md 为准。样张 A、F、G 上的「必须项9/9」没有重画，design-system 已改为 13/13（§10.0 修正 10）。
- 同日按规格、代码核对、决定三路评审修订了 spec、design-system 和本文件（spec 顶部 `Revisions:` 有摘要）。UI 优先片按文中配方重切：1,124 个码位、243,600 B。
- 半成品：无，没有代码改动。
- 阻塞：第 0 步的五项。
- 下一步：第 0.0 步把这次重写落进仓库；然后 owner 确认 01 验收（01 plan 第 20 步），同时定开放问题 1、5、9；再写 ADR-004、审阅本 spec 并翻 `ready`。

## 验收记录

（按验收编号追加：通过或不通过、证据位置）
