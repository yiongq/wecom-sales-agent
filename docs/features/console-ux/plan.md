# 后台 UX 重做 · 实现计划

对应 [spec.md](spec.md)，视觉细则在 [design-system.md](design-system.md)。只记步骤和状态，不复述设计；步骤里的「验收 n」「不变量 n」「开放问题 n」都指 spec，参数取值一律看 spec 对应的小节。

每一步单独一个 PR 进 `dev`；子步骤可以分开提 PR，某个子步骤阻塞时（如第 1.4 步等开放问题 1），同一步的其余子步骤照常合并。每个 PR 结束时仓库都是绿的：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`。界面改动在 PR 里写 BEFORE/AFTER。新增依赖一律钉精确版本，版本在安装时核实并写进 PR。新加的自测和检查脚本都要串进根 `package.json` 的 `test` 或 `lint`，否则不算做完。括号里是工程日估算，合计约 40 个工程日（不含标「阻塞」的第 18–20 步）。标「阻塞」的步骤等前置条件满足才开工。

- [x] 0. 开工前提
  - [x] 0.0 把这次重写落进仓库（一个 docs PR）：`docs/features/console-ux/` 下的 spec、design-system、references、plan；同一个 PR 里把 01 plan 第 368、380 行的「UX spec 第 10 步」改成第 8 步；在 `docs/spec-driven-dev.md` 注明一个 spec 文件夹可以带配套细则文件（如 references.md、design-system.md），细则不记进度、不定行为，和 spec 冲突时以 spec 为准。
  - [x] 0.1 01 翻为 `implemented`（01 plan 第 20 步）。在那之前本 spec 不开工。
  - [x] 0.2 （owner）在确认 01 验收时定开放问题 1：01 里所有不是新增的改动（安全头两处、页面条款五处、01 验收 16 第 4 条与验收 22）走 01 的就地修订还是另写小 spec；同时答复开放问题 5（匿名是否显示租户名）和开放问题 9（决定 (1) 的范围）。
  - [x] 0.3 写 ADR-004「产品库表单由行业包的字段配置渲染」，取代 ADR-002 决策 1 里「由 zod schema 转成 JSON Schema 自动生成」一条；owner 采纳。
  - [x] 0.4 （owner）审阅 spec 与 design-system，翻为 `ready`。开工时明确说「按 docs/features/console-ux/spec.md 实现」：本 spec 不在自动选活的范围里。
- [x] 1. 主题与字体地基（4）
  - [x] 1.1 `console/src/theme/`：两套令牌、`brand.css`（design-system §1.5，含 `data-reduce-motion`）、antd 映射（§8）、`ConfigProvider` 的 `wave`、`requiredMark`、`motion`、Tabs 不带动画；`/console/theme-boot.js` 首帧设 `data-theme` 与 `data-reduce-motion`，外观与「减少动态效果」存 `localStorage`，读写包 try/catch。`theme.selftest.ts` 串进 `pnpm test`（验收 1、不变量 1）。
  - [x] 1.2 字体：`scripts/fonts/build.ts` 生成 `geist-ui`、`geist-mono-ui`、`noto-sans-sc-ui` 三个 woff2、码位清单和 sha256，并从 `@fontsource-variable/noto-sans-sc` 的清单生成长尾分片的 `@font-face`（声明顺序见 spec「字体与授权义务」）；`console/vite.config.ts` 设 `build.assetsInlineLimit: 0`；Vite 小插件注入两个 preload；`console/public/licenses/` 放三份许可原文；仓库根目录新建 `NOTICE`。字体码位检查串进 `pnpm test`（不变量 30）。
    - 在 Chromium、Firefox、WebKit 上实测开放问题 4：只渲染界面文案时有没有长尾分片请求，连用标点宽度是否符合 P 页。结论记进本文件；不成立就按开放问题 4 改成全量自切，同时在 spec 顶部加一行 `Revisions:`，改「字体与授权义务」「性能」两节和验收 8、23，再继续。
  - [x] 1.3 标点与间距：全局 `text-spacing-trim` / `text-autospace`；`src/shared/typography.ts` 的 `haltIndices`，自测用 design-system §2.2 核对过的 576 对结果，串进 `pnpm test`；`cjk()` 文本助手与 `Sep`；`console/src/_specimen/` 下的 `/_specimen/type`（P 页）和 `/_specimen` 控件样张，只在 `VITE_SPECIMEN=1` 时注册。
  - [x] 1.4 （阻塞：开放问题 1）静态资源与安全头：`src/shared/security-headers.ts` 的 `BASE_CSP` 加 `font-src 'self'`，并导出资源头函数；`src/console-api/host.ts` 用它给 `/console/assets/*` 带 `immutable`，JS、CSS 按 `Accept-Encoding` 走 gzip（Hono `compress`）；`console/vite.config.ts` 的 `previewWithCsp` 改用同一个函数。按开放问题 1 定下的文本改 `console.selftest.ts` 里钉死安全头的断言（`CSP` 常量，`secured()` 对 `/console/assets/app-1a2b.js` 与全部 `/api/console` 响应的检查），其余断言不动；新增不变量 26 的断言。
- [x] 2. 外壳、通用部件与新增接口（5）
  - [x] 2.1 服务端与共享代码：`Me.tenantName`；`src/shared/pack.ts` 的类型；`src/packs/travel/console-pack.ts` 与 `src/packs/registry.ts`，`tenant-create` 改读注册表；`GET /pack`；`src/shared/conversation.ts`（`conversationState`、`shortIdOf`）；`ConvQuery.state` / `stage` / `order` 与 `GET /conversations/counts`；`sectionBody`、`editableChars` 连同 `SopStructureError` 等挪到 `src/shared/sop-sections.ts`（做法见 spec「额度条」）。`console.selftest.ts` 加验收 15 的第 1、5、6、7 条。01 implemented 之后在 01 顶部加 `Amended by:`。
  - [x] 2.2 外壳：启动的加载与出错（spec「外壳 · 启动」）；侧栏由行业包生成（分组、计数、会话软徽标）；租户行与铃铛弹层，含空状态与轮询失败，刷新方式按 spec「外壳 · 计数刷新」；搜索触发器与 ⌘K（键盘、数据来源、各种状态按 spec「外壳 · 搜索触发器」，拼音库懒加载）；用户行（纯 CSS 先藏角色）与用户菜单（外观、减少动态效果、关于、退出）；受控收起与 `useViewport()` 三档；匿名外壳与横幅；非编辑角色的「只读」；跳转链接与地标；`document.title`。走查时核对：用户菜单里切外观，下一帧就是终值颜色，没有渐变（主题切换 0ms，靠第 1.1 步的 `data-theme-switching`）。
  - [x] 2.3 通用部件：`StateView`、`ERROR_COPY`（含兜底）、`TechDetails`、`ConfirmDanger`、`Status`、`ActionBar`、`CheckList`、墨色主按钮组件、成功 toast 函数；未保存保护（`useBlocker`）；会话过期的判定与就地重登（spec「会话过期的判定」）；全站去掉 `message.error`。`scripts/check-console-src.ts` 挂进 `pnpm lint`，先覆盖不变量 2–4、6、8、9、28。`Status`、`ConfirmDanger` 做好后加进 `/_specimen` 控件样张（第 1.3 步）。
  - [x] 2.4 拆包与预算：各页 `.lazy()`；删掉 `chunkSizeWarningLimit` 覆盖，开 `build.manifest`；确认 `assetsInlineLimit: 0` 已生效；扩展 `scripts/check-console-dist.ts` 的 JS 与字体预算、禁入内容（spec「性能」）。拆包前后的数字记进交接记录；超预算按开放问题 8 请 owner 定，选放宽时在 spec 顶部加 `Revisions:` 并改「性能」和验收 23。
- [x] 3. 字段渲染器与行业包配置（4）
  - [x] 3.1 `checkPack`、`checkItem`（含数组的 `min` 与必须项的计数口径，spec「校验」）、`ENTITY_ICONS`；旅游包补全（design-system §9，含 `recommend`、`min`）；假包 `src/shared/pack-fixtures/renovation.ts`；`src/packs/packs.selftest.ts`（不变量 13–15），串进 `pnpm test`。
  - [x] 3.2 渲染器：11 种字段类型各三种形态（`Record<FieldType, …>`，不变量 12）；实体图标映射；表单状态与 `set` / `unset`；`storeAs` 的 `parse` / `format`；表单网格（design-system §6.0、§6.4）；`console/src/fields/fields.selftest.tsx`（两个包的每个字段；不变量 16 的往返），串进 `pnpm test`；`scripts/check-boundaries.ts` 只给这一个文件开 import `src/packs/registry.ts` 与 `src/shared/pack-fixtures/` 的例外。
  - [x] 3.3 `check-boundaries.ts` 禁止其余 `console/src` 文件 import `src/packs/**` 与 `src/shared/pack-fixtures/**`；`check-console-src.ts` 加上行业包词汇扫描（不变量 11 的范围与白名单）和不变量 17 的 console 一侧；`check-console-dist.ts` 断言产物里没有假包内容（不变量 25）。
  - [x] 3.4 `src/shared/ui-labels.ts`（检查项名、角色、`AUDIT_ACTIONS`、`ERROR_COPY` 的文案）与 `src/shared/format.ts`（金额、相对与绝对时间、月份区间）；`AuditQuery.actions`（服务端与验收 15 第 8 条）；`describeAudit(entry, pack, lookups)`（实体名、字段名取自行业包）。总览的「最近变更」和第 14 步都用它们。
- [x] 4. 总览（1.5）：路由 `/` 取代重定向；需要你处理、系统状态、业务数、客户停在哪一步、最近变更，各块独立加载与出错；匿名总览（验收 10）。`scripts/seed-demo.py` 加 `--scenario console-ux` 与 `--now`（验收 4「走查种子与时钟」），不带这两个参数时输出不变。
- [x] 5. 销售话术一：编辑（3）
  - [x] 5.1 状态句、额度条（用第 2.1 步挪好的 `src/shared/sop-sections.ts`）、目录（分段筛选、锁定原因、键盘、URL 的 `section`、窄屏下拉）。
  - [x] 5.2 编辑器：按 spec「编辑器」（字阶、markdown 装饰、工具与字段芯片、✗ ✓ 图标、改动沟槽与新增高亮、回退时的 `halt` 装饰、`aria-label`、`phrases` 汉化）；固定规则节只读说明。
  - [x] 5.3 自动保存按 spec「自动保存」（防抖、`rev`、退避、`⌘S`、409 停住并保留对比）；离开保护；1280–1439 与 <1280 的布局。
- [x] 6. 销售话术二：检查与发布（2.5）
  - [x] 6.1 `ContractViolation.match`：`checkSopContract` 在四类违规里填值，`console.selftest.ts` 加验收 15 第 2 条。
  - [x] 6.2 每次自动保存后检查；检查清单与定位；行内提醒与「改成…」（候选范围按 spec「检查 · 行内提醒」）。
  - [x] 6.3 常驻发布条（禁用原因、成功结果与「回滚到vN」）；发布抽屉（检查、替换说明、逐节差异与行内 / 并排切换、覆盖 `@codemirror/merge` 的红色、预填说明）；中栏说明行末尾的「查看本节改动」（设计系统 B 页，打开这一节的逐节差异，第 5.2 步没做）。
- [x] 7. 销售话术三：版本记录与回滚（2）：版本记录抽屉（说明在前、技术详情折叠、翻页、加载 / 出错 / 到底）、「查看改动」、回滚确认（后果按有无交集分两种、固定规则提示、差异、必填原因）、「载入到草稿再改」、「更多」里的丢弃确认。
- [x] 8. 销售话术四：冲突合并（2）：`SaveDraftBody.rebaseOnto`（服务端与验收 15 第 3、4 条）；合并模式界面（`revertControls`、汉化、「完成合并」后回到发布抽屉）。落地后在 01 plan 的 Open 里把「冲突后只能丢弃重做」那条标成已解决，指向本步。
- [x] 9. 产品库列表（1.5）：列、首列两行、筛选按字段类型生成、页签与计数、搜索、URL 状态、分页、各种状态、匿名与非编辑成员。
- [x] 10. 产品库详情与编辑（3.5）
  - [x] 10.1 路由 `/catalog/$kind/$code` 与 `/catalog/new/$kind`；两栏；分组卡片、锁定 Tag 与原因、只读形态、「已改」与撤销；副栏（状态与锁定组、上架前检查、最近更新）。
  - [x] 10.2 保存条与补丁提交；422 报错落到字段、只显示碰过的字段；409；`src/shared/catalog.ts` 的报错去掉英文键（验收 15 第 10 条）。
  - [x] 10.3 上架确认（必须项没过时跳到字段）；复制为新草稿；「预览」页签；新建。删除旧的抽屉和 `@rjsf/*` 依赖。
- [x] 11. 有序子项与引用（2）：通用有序子项编辑器（节点、条数提醒、上移下移、自动编号、锁定条数；多字段子项的增删、增删后重排编号、条数锁定时不画增删已在第 10.3 步第二轮评审之后做了）；引用字段的分组联想、`allowFree` 提示、「复制上一{itemNoun}的…」；长文本 `softMax` 提示。
- [x] 12. CSV 导入（2）：五步弹窗；中文表头模板与 BOM；UTF-8 严格解码加 `gb18030` 兜底；空文件与只有表头；前端预检与三条上限；「只导入合格的N行」；下载不合格行时防公式注入；`prepareCatalogCsv` 接受中文表头、去掉本系统加的前缀（验收 15 第 9 条）。
- [x] 13. 会话列表（1）：I 页（页签与阶段条来自同一次 counts、`order=waiting_first`、最后动静的时间写法）；`public/admin.html` 的 `#s=<id>` 深链，登录流程中保留 hash。
- [x] 14. 审计日志（1.5）：用第 3.4 步的 `AuditQuery.actions` 与 `describeAudit`；筛选写进 URL；按天分组的时间线与连续同类记录合并；详情抽屉；「加载更早的记录」。抽屉的两种去处 2026-10-01 都照 spec 改完：产品库到条目详情（「实施记录 · 跨线收尾：条目链接」），话术到那条记录生成的那一版的查看改动（「实施记录 · 跨线收尾：审计里的话术版本」）。
- [x] 15. 登录页（0.5）：一栏布局、「密码」文案（`PasswordBusyError` 与登录失败的 `detail` 同步改）、错误就地显示、「返回演示」。
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

## Open

- 第 2.2 步（第 9、10.3、12 步已解决列表、详情与导入）：`/catalog/$kind`、`/catalog/$kind/$code`、`/catalog/new/$kind` 的 kind 都按当前租户的行业包取，包里没有的出「没有这个页面」；旧抽屉第 10.3 步删了，`LEGACY` 随之清空并删掉，两个包的「新建」都去新建页。「导入CSV」第 12 步换成按行业包渲染的弹窗，假包的主材也能导入，这一条全部解决了。
- 第 4 步：`conversationState` 只把 `stage === 'paid'` 算已成交。终态 key 不是 `paid` 的包（家装假包的 `deposit`「已付定金」）里，停在终态的会话算 AI 接待中：总览的已成交格是 0，阶段条把它们归进「其他」（阶段条不含终态，各行之和仍等于 AI 接待中），会话列表的页签也一样。两种改法：`conversationState` 按包的 `terminal` 判定（改不变量 17 与接口的口径，要改 spec、owner 定），或 `checkPack` 要求终态 key 是 `paid`（假包随之改）。第 17 步假包走查前定。总览的已成交格现在只写 `conversationState` 认作已成交的阶段名，没有时写「已成交的会话」，不把「已付定金」写成口径。
- 待 owner（第 1.4 步）：spec「性能」一节写「preview 不压缩」，与实测不符。vite 8.3.1 的 preview 自带 `@polka/compression`，1 KB 以上的 text、JS、JSON 响应按 `Accept-Encoding` 走 gzip，所以 preview 上 `/console/assets/*` 的 JS、CSS 也是压缩的。它不加 `Vary: Accept-Encoding`，这些响应又带 immutable 长缓存，`Vary` 只有 `Origin`。影响只在本地 preview：真实 host 由 Hono `compress` 加 `Vary`，验收 23 也以 host 为准，所以没改代码。建议在 spec 顶部 `Revisions:` 记一笔，把那句改成「preview 上的压缩是 vite 自带的，不作验收依据」。如果要 preview 的头与 host 完全一致，可以在 `previewWithCsp` 里给 JS、CSS 资源补上 `Vary: Accept-Encoding`。
- 第 15 步：axe 开上 wcag22aa 与 best-practice 时，成员外壳报一条 `region`（moderate）：侧栏的租户名 `.tenant-name` 不在任何地标里。第 2.2 步以来如此，登录页一步没碰外壳的这部分。第 16 步的无障碍收尾一并处理（例如租户行放进侧栏的地标）。
- 第 14 步：全站主题（`theme/antd.ts`）的 Segmented 选中段是 antd 默认的淡阴影、字重 400，焦点框也是 antd 默认的；Switch 关着是 `colorTextQuaternary`（text-3）。设计系统 §5.4、§5.20 要的是选中段 1px `--control-border` 的圈、500，焦点 2px `--focus`、外移 2，开关关着 `--control-border`。审计页在 `audit.css` 里就地按 §5.4 改了，话术页和样张也用这两个控件。建议第 16 步改全站主题（`theme.selftest.ts` 的对比度对子随之加），改完删掉 `audit.css` 里那几条。另外，rc-segmented 1.4.0 给整条轨道也加了 `tabIndex=0`：Tab 先停在轨道上，这一站方向键不起作用，要再按一次 Tab 才进选中的那一段。审计页给 Segmented 传了 `tabIndex={-1}`，其余用到 Segmented 的地方（话术页、样张、表单里的单选 enum 与选填 boolean）仍多这一站，第 16 步的键盘走查一并处理。

## 砍法

工期偏紧时按顺序砍，每砍一项都在 spec 顶部加一行 `Revisions:`，写明改了哪些目标、接口和验收编号：

1. 第 10.3 步的「预览」页签（验收 4 的「线路预览」状态改成只读编辑页签）。
2. ⌘K 的拼音与首字母搜索，只留中文子串匹配。
3. 第 11 步引用字段的分组联想，只留普通的自由输入加「复制上一{itemNoun}的…」。

不能砍：行业包配置与渲染器（第 3 步）、字体与许可（第 1.2 步）、`rebaseOnto`（第 8 步）、四种状态与同源计数（第 2.1 步）：这些决定页面结构和对外义务，以后补的代价比现在做大。

## 实施记录

按步骤号记下实施中的实测结论与偏离 spec 的取舍；不复述 spec。

### 第 1.1 步（2026-09-27）

- 做了什么：`console/src/theme/` 下 `tokens.ts`（两套令牌，键即 `brand.css` 的变量名）、`brand.css`（§1.5）、`antd.ts`（§8，亮暗各一份）、`prefs.ts`（外观与「减少动态效果」的读写，全部 try/catch）、`ThemeProvider.tsx`（`ConfigProvider` 的 `theme`、`wave`、`form.requiredMark`，跟着 `<html>` 的两个属性走）；`console/public/theme-boot.js` 在 `<head>` 里同步加载；`theme.selftest.ts` 串进 `pnpm test`，排在 `console.selftest.ts` 之后。
- antd 的深色算法会把种子色和底色混一遍：`colorPrimary` `#2F68EB` 出来是 `#2B5BCB`，`colorLink` 与四个语义色同样变了，写进 token 也不生效。算法链末尾加一步 `pinSeeds` 把这六个钉回令牌值；自测断言写进 token 的每个值都原样出现在 `getDesignToken()` 里。
- 自测：1,582 条断言，约 1 秒；跑法带 `--tsconfig console/tsconfig.json`（要渲染 `ThemeProvider.tsx`，得按 react-jsx 编译）。两套主题各算一遍：brand.css 值 105 对、换成 antd 全局令牌 226 对、组件令牌 55 对。组件键没有显式写值也算失败，因为 antd 会从 `colorPrimary` 派生。复算的 §1.2 主表与文档逐格一致。嵌套底（深色 subtle·subtle·raised）算出 10.30 / 5.10 / 3.85，文档是 10.38 / 5.14 / 3.88，差在逐层取整，结论不变。`theme-boot.js` 在 `node:vm` 里跑，和 `prefs.ts` 在 48 种组合上对拍，另有存储被禁用、往返、系统减少动效几条。另外三块见下面「评审后补的」。
- 变异（隔离副本）共 29 处，全部失败并点名（评审后又加 22 处，见下）。验收 1 列的四种改动占 8 处：浅色 `--text-3` 改 `#8C8C8C`（改 brand.css、改 tokens.ts 各一处）、深色 `--control-border` 改 `#52525B`、深色 `Tabs.itemSelectedColor` 改主色，brand.css 变量改值、缺一个、多一个共 4 处。其余 21 处：去掉 `pinSeeds`，Tooltip、Message、按钮按下的字色，Tabs 时长，`motion`，boot 与 prefs 的键名、默认值和 try/catch，以及 dist 检查的 6 种。
- preview 实测（CSP 与线上相同，接口用 Playwright 拦截）：存了深色或「跟随系统」加系统深色时，`DOMContentLoaded` 时 `data-theme=dark`，body 已是 `#09090B`，不闪白。运行中改 `data-theme`、切系统配色，antd 都跟着换。「减少动态效果」（菜单值或系统设置）开着时按钮的 `transition-duration` 是 0s。Modal 的内边距与底栏、抽屉、Tooltip、反相 toast 的颜色两套主题都对。登录页的必填项不再画星号。两套主题下 `securitypolicyviolation` 都是 0 次。
- 偏离与取舍：
  - §8 之外补了几个显式值。`colorLinkActive`：深色下按住链接只有约 2:1。`Button.defaultActiveColor` / `defaultActiveBorderColor`：不写就取 `colorPrimaryActive`。`Tooltip.colorTextLightSolid = panel`：§5.15 要 panel 色字，深色下白字叠浅底看不见。`Pagination.itemActive*`：§5.5，深色当前页原来 3.83:1。
  - 反相 toast 的字色写在 `Message` 的组件令牌里（`colorText` 与 `colorTextHeading`；6.6.5 的提示文字实际取后者，走查时发现只设前者字和底同色），不用 §8 说的 className，现有的 `message` 调用不用逐个改。
  - 「Tabs 不带动画」用 Tabs 组件层的三档时长归零实现：`ConfigProvider` 给不了 Tabs 的 `animated`，而且 `animated={false}` 只关墨条，关不掉页签文字的颜色过渡。
  - Modal 的七个内边距与底栏令牌 6.6.5 在运行时认，但公开类型里没有，整块断言成 Modal 的配置类型，渲染后实测生效。
  - brand.css 比 §1.5 多两处：`color-scheme: light` / `dark`（深色下原生滚动条和表单控件跟着变）；`.optional-mark`（「（选填）」13 text-3）。
  - `console/vite.config.ts` 的 `previewWithCsp` 原来把 `/console/` 下除 assets 以外的路径都回退成 index.html，`theme-boot.js` 在 preview 上拿到的是 `text/html`，不执行（实测）。现在 dist 根目录里真实存在的文件按文件返回，带同一套安全头；第 1.2 步的许可文本也靠这条。`host.ts` 本来就按文件返回，没改。`scripts/check-console-dist.ts` 加查：`theme-boot.js` 在产物里，在 `<head>` 里同步加载且排在应用脚本前，页面没有内联脚本。
  - `ThemeProvider` 挂载时再设一次属性，兜底 `theme-boot.js` 没加载成的情况。
  - 现有页面只改了写死的浅色：Shell 页头的 `#fff`、两个编辑器和话术页的边框，都换成 CSS 变量。
  - 反相 toast 上成功以外的图标（`Message.colorError` / `colorInfo` / `colorWarning`，loading 也取 `colorInfo`）照 `--toast-icon` 的思路取另一套主题的同类色：浅色取深色的圆点色，深色取浅色的字色。§8 的 `contentBg` 本来就对所有 message 生效，不补这三个，现有的 `message.error` / `info` 图标在反相底上不到 3:1。
  - brand.css 比 §1.5 再多一条：`:root[data-theme-switching]` 下 `*`、`::before`、`::after` 都 `transition: none !important`（主题切换 0ms）。
  - 产品库抽屉的「上架」从 `type="primary" ghost` 改成默认按钮：ghost 的字色取 `colorPrimary` 系，深色下叠在 raised 上 3.52（悬停 2.84、按下 2.26）。
- 评审后补的（同日）：
  - 主题切换 0ms：`prefs.ts` 的 `applyPrefs` 在 `data-theme` 真变了时先挂 `data-theme-switching`，两帧后拿掉，连着切以最后一次为准。preview 实测（Chromium，CSP 同线上）：运行中切换（走 `storage` 监听）和「跟随系统」下系统换深色，切换后第一帧输入框底就是 `rgb(18,18,20)`、主按钮 `rgb(47,104,235)`，逐帧没有中间值；下一帧按钮的 `transition-duration` 回到 0.16s。修之前输入框底要约 196ms 才渐变到终值。
  - 自测加三块：切换属性的挂与拿（假的 `requestAnimationFrame` 逐帧推）和 brand.css 那条规则；扫 `console/src` 每个 `<Button>` 开始标签，禁 `ghost` 与 `color="primary"` 的非实心变体；用 `react-dom/server` 渲染 `ThemeProvider`（亮暗 × 减少动效四种），核对 antd 实际拿到的全局令牌（含 `motion` 与三档时长）、`wave.disabled`、必填项不画星号不加「（选填）」、选填项加。为此 `useSyncExternalStore` 补了第三个参数。组件配对加 `Message` 三个图标色和 `danger` 默认按钮的悬停、按下字色（算法派生，现在 4.97 / 9.35 与 9.99 / 4.55）。
  - 变异 22 处，全部失败并点名：切换属性 4 处（不挂、只等一帧、去掉序号、主题没变也挂）、brand.css 规则 3 处、Message 图标 4 处、按钮变体 4 处（含 `{'primary'}` 写法）、ThemeProvider 7 处（忽略减少动效、忽略主题、去掉 `wave`、`wave` 打开、去掉 `form`、必填项也加「（选填）」、去掉服务端快照）。浅色 warning 图标换成浅色自己的 `warning-icon` 是等价变异（叠 `#18181B` 仍过 3:1），换成浅色 `warning` 字色（2.91）则失败。反例 `color="primary" variant="solid"` 加箭头函数属性照常通过。
  - 真实的 `message.error`（preview 里把退出接口拦成 500）：浅色图标 `#FF6B5E` 叠 `#18181B`，深色 `#B42318` 叠 `#EDEDEF`，字色分别为 panel 白与 `#121214`；两套主题 `securitypolicyviolation` 都是 0 次。
- 留给后面的步骤：
  - rjsf 的表单不在 antd `Form` 里，`requiredMark` 管不到，产品库抽屉仍画星号、不标「（选填）」（第 10.3 步删 rjsf）。
  - 深色下 CodeMirror 仍是默认浅色主题（第 5.2 步）。
  - 现有的 `message.error` / `info` 仍是反相底（图标已换成过 3:1 的颜色）；第 2.3 步去掉 `message.error`，只留成功 toast。
  - 外观与「减少动态效果」还没有界面入口，由第 2.2 步的用户菜单调 `setAppearance` / `setReduceMotion`。
  - 侧栏仍是 antd 浅色 Sider（panel 底，第 2.2 步换外壳）。

### 第 1.2 步（2026-09-27）

- 依赖：`@fontsource-variable/noto-sans-sc` 5.3.0（console，精确版本，安装时是 npm 的 latest）。本机工具不进仓库：fonttools 4.66.0、brotli 1.2.0（`FONTTOOLS_PYTHON` 可指到装了它们的 python）。
- 来源：三款字体和两份 OFL 原文都钉在 google/fonts 的提交 `9e25e2b`（Geist 1.800、Geist Mono 1.701、Noto Sans SC 2.004）；lucide 的许可取 `lucide-icons/lucide` 的 tag 1.48.0，与 npm 包 lucide-react 1.48.0 里的 LICENSE 逐字节相同。lucide-react 现在还不是依赖（`NOTICE` 写的是「将经它引入」）：接图标的步骤（第 3.2 步起）加依赖时钉 1.48.0，并核对包里的 LICENSE 与 `lucide-ISC.txt` 相同；换版本就同步换许可原文和它的 sha256。sha256 都钉在 `scripts/fonts/build.ts`。Geist 与 Geist Mono 的 OFL.txt 逐字节相同，只发布一份。
- 产物：`geist-ui` 11,884 B，`geist-mono-ui` 7,972 B，`noto-sans-sc-ui` 579 个码位（397 个汉字、176 个 CJK 标点、6 个符号）112,188 B；两个 preload 合计 124,072 B。脚本设了 `SOURCE_DATE_EPOCH`，重跑结果逐字节相同（评审修订时重跑，两个 Geist 文件没变）。spec 的 1,124 个码位、243,600 B 是按当前仓库加设计系统的全部文案切的，即界面做完时的量；现在的界面文案还没写到那么多，后面的步骤加文案后重跑脚本就会涨上去（spec 与设计系统 §2.6 已注明）。
- 构建：产物里 104 个 woff2（101 片长尾加 3 个自切的），CSS 里 `url(data:` 0 处；两个 preload 带 `crossorigin`，注入在 `index.html` 的 head 末尾。字体栈、`text-spacing-trim` 这些还没接（第 1.1、1.3 步），在那之前页面只预载这两个文件。
- 合并顺序：第 1.1 步（接字体栈）先合进 dev，或与本步一起合。只合本步的话，页面仍用 antd 默认字体栈，两个 preload 每次整页加载都下载 124,072 B 却一个字也不画（评审在 Chromium 里实测：`document.fonts` 里没有一个 face 是 loaded，`#root` 的计算字体不含 Geist 和 Noto Sans SC）；第 1.4 步之前 `/console/*` 又是 `no-store`，每次都重下。
- 与 spec 原文不同的三处，已写进 spec 顶部的 `Revisions:`、「字体与授权义务」和设计系统 §2.2、§2.6：
  1. 用字来源：spec 原来只收 `console/src/**` 和注册行业包配置。可 `src/shared/**` 的报错与格式化文案、antd zh_CN 语言包里的空状态、分页、确认按钮、zod zh-CN 语言包的校验消息（`setup.ts` 调了 `z.config(z.locales.zhCN())`，表单显示 `issue.message`；评审补上，多出 21 个字）也会显示在页面上，不收的话验收 8 的「长尾分片 0 个」过不了，所以这三处也收。服务端 `ApiError.detail` 不收：spec 定了它只出现在默认折叠的「技术详情」里（不变量 8），现在 `api.ts` 的 `describe()` 直接显示它是 01 的写法，后面的步骤换成 `ERROR_COPY`；技术详情里出现界面没用过的字，按需下一片长尾是预期的回退。不变量 30 的原文按字面会连注释一起算，与这里的取法矛盾，已随 `Revisions:` 改成同一取法。只收字符串字面量、模板字符串的文字段、JSX 文本、CSS 去掉注释后的部分。注释和 `*.selftest.*` 不收：算上注释，console/src 是 476 个字，只算字符串是 261 个。假包 `pack-fixtures/` 不收；行业包按 `src/packs/<包>/console-pack.ts` 找（第 2.1 步建）。
  2. GSUB 加上 `ccmp`：`locl` 先把 U+2014 换成 U+2015，再由 `ccmp` 把两个 U+2015 连成一个两字宽的字形。照原来的特性表切，三个引擎里「——」都分成两段、中间有缝；加上 `ccmp` 后连成一条，文件只大 80 B。
  3. 长尾的 `unicode-range` 去掉控制字符（U+0000–001F、U+007F–009F）：fontsource 的 latin 片从 U+0000 起，WebKit 在拉丁字母后面遇到换行符（`white-space: normal` 也一样）就去下载它。去掉以后三个引擎都不再下载。
- 其他：`fonts.css` 是生成文件，加进 `.oxfmtrc.json` 的 `ignorePatterns`，因为 oxfmt 会给 unicode-range 折行，检查要按生成结果逐字比对。
- 检查：`scripts/check-fonts.ts` 串在 `pnpm test` 里、console 构建之前（CI 注释同步）。除不变量 30 的两条外，还查三份许可原文的 sha256（不变量 31 的内容部分）。第一版只靠「`fonts.css` 与按清单重算的结果逐字相同」来钉声明顺序和长尾去控制字符，评审指出这是拿生成函数比生成函数：改坏 `css.ts` 再重新生成就照样通过。修订后加了几条直接读提交文件、不经过生成函数的断言：
  - 用 Node 自带的 brotli 解开 woff2、读 cmap（`scripts/fonts/woff2.ts`），三个文件的 cmap 等于清单记的码位，字节数也等于清单；
  - 解析 `fonts.css`：自切的三个文件各一条，`unicode-range` 等于该文件的 cmap；最后一条 Noto Sans SC 是 UI 优先片、其余都是长尾分片；长尾范围里没有 U+0000–001F、U+007F–009F；
  - 界面文字里汉字以外的字符（控制字符除外）都要由 Geist 或 UI 优先片画，这样验收 8 的「长尾 0 个」才有门禁。例外写在 `OUTSIDE_OK` 里、各带理由：`CatalogPage.tsx` 的「¥」（打开产品库会多下 latin 片，不变量 7 要求第 9、10 步去掉）、`src/shared/csv.ts` 的 BOM（解析 CSV 时用来去掉开头的 BOM，不上页面）。出处里没了这个字符，检查会要求删掉那一条。
- 变异（隔离副本，29 例全部符合预期；每例都核对了报错点名的内容，不只看退出码）：
  - 在字符串、JSX 文本、模板、CSS `content`、`src/shared`、行业包配置、`index.html` 里加一个新字，都失败，并点名这个字和它所在的文件；只在注释、自测、假包里加字，照样通过；
  - woff2 改一个字节（sha256 不符，cmap 读不出）、删掉 Geist 子集、清单少一段标点、清单少一个界面汉字、清单的 `codepoints` 或 `bytes` 改错、改许可原文、手改 `fonts.css` 的顺序或范围，都失败；
  - 评审给的三例现在都失败：改 `fontsCss` 让 UI 优先片排在长尾前面再重新生成，报「最后一条 Noto Sans SC 是 …latin…」；`isControl` 恒为 false 再重新生成，报长尾范围含控制字符；清单多记 U+9F98、重新生成、界面加「龘」，报清单与 cmap 不符。让 `fontsCss` 给自切文件多写一个码位再重新生成，报 `unicode-range` 与 cmap 不一致；
  - 界面字符串里加「✓ ↓ €」，点名三个字符（修订前退出码 0）；在别的文件里加「¥」失败（白名单只认 `CatalogPage.tsx`）；`CatalogPage.tsx` 去掉「¥」，失败并要求删掉白名单那条；只在注释里加「€」照样通过；清单去掉 zod 语言包独有的「串」，点名 `zod/v4/locales/zh-CN.js`。
- 开放问题 4 实测：
  - 环境：Chromium 153.0.8010.12、Firefox 155.0、WebKit 26.6，都是 Playwright 1.63.0 自带的版本。本地静态服务托管生产构建，每次新开上下文，不走缓存。实验脚本放在仓库外，不提交。
  - 只渲染界面文字（上面取法的全部字符串，去掉白名单上的「¥」和 BOM，400、500、600 各渲染一遍，`white-space` 取 `normal` 和 `pre-wrap` 各一轮）：三个引擎都只请求 `geist-ui` 和 `noto-sans-sc-ui` 两个文件，长尾 0 个（这是去掉控制字符之后的结果，之前 WebKit 会多下 latin 片，见上面第 3 条）。第一版记录没写去掉这两个字符，评审照原样复测：不去掉时三个引擎都为「¥」下载 latin 片，WebKit 还为 U+FEFF 多下 110 号片；只去掉「¥」时，Chromium 仍下 latin 片。评审修订后（UI 优先片 579 个码位）复测，结果相同。
  - 同时落在 UI 优先片和长尾分片里的字符，单独渲染（三种字重）时也是长尾 0 个：「」『』，。（）：；！？“”‘’、【】《》～——…×–→⌘㎡℃。页面上出现一个界面没用过的字（龘）时，三个引擎都只多下载一片，这是验收 8 第二条要的行为。
  - 标点宽度（20px）：Chromium 原生挤压，「）、」「（「」「），」都是 30px（1.5em），单独的「，」是 20px。Firefox、WebKit 不支持 `text-spacing-trim`，按设计系统 §2.5 的 `haltIndices` 包上 `.halt` 以后，宽度也一样。整句宽度三个引擎依次是：状态句「改了2节（话术原则、异议处理）· 有1个问题要改」433.03、433.02、433.02px，「关于」那句 1085.67、1085.65、1085.66px。「…」的墨迹中心与「中」相差 0em；「——」加上 `ccmp` 以后连成一条。评审修订后复测（不开 `text-autospace`，所以整句比上面窄）：四组标点宽度不变；状态句 419.09、419.08、419.08px，「关于」那句三个引擎都是 1067.92px；按截图数墨迹，「…」的中心与「中」相差 0.006em，「——」中线上的墨迹没有断点（Chromium、Firefox 宽 1.6em，WebKit 宽 1.88em）。
  - 给第 1.3 步的提醒：回退时，不加 `halt` 的连续文字要放在同一个文本节点里。实验中逐字拆成独立文本节点时，WebKit 的状态句比 Chromium 窄 5px；按段放在同一个节点里就一致。
  - 结论：声明顺序的做法在三个引擎上都成立，不改成全量自切。spec 的开放问题 4 已标为「已定」，「性能」一节和验收 8、23 不用改。

### 第 1.3 步（2026-09-27）

- 做了什么：
  - `src/shared/typography.ts` 的 `haltIndices`（照设计系统 §2.5）；`src/shared/typography.selftest.ts` 串进 `pnpm test`，排在 `theme.selftest.ts` 之后。
  - `console/src/typography.tsx`：`needsTrimFallback`（加载时测一次）、`cjk(text)`（收字符串或字符串数组，数组的各段之间放 `Sep`，挤压在拼好的串上算；不加 halt 的连续文字留在同一个文本节点里）、`Sep`。`console/src/typography.selftest.ts` 核对标记和全局样式的约定（根元素 `lang`、body 上的两项、不写 `space-all` / `palt` / `chws`、`font-feature-settings` 只在 `.halt` 里），同样串进 `pnpm test`。
  - 全局的 `text-spacing-trim` / `text-autospace` 第 1.1 步已按 §1.5 写在 brand.css 的 body 上，本步没改，只加了 `.sep-sr` 并实测生效（见下）。
  - `console/src/_specimen/`：`/_specimen/type`（P 页）和 `/_specimen`（控件样张），`router.tsx` 只在 `VITE_SPECIMEN=1` 时注册，走查构建的根组件对这两个路由不套外壳、不请求 `/me`；`?theme=light|dark` 调 `setAppearance`。`scripts/check-console-dist.ts` 加查：生产产物里没有 `_specimen`、`spec-panel`、`space-all`（不变量 25 的样张部分）。
  - 样张页独有的字不进 UI 优先片（评审后改，见下），UI 优先片仍是第 1.2 步的 579 个码位、112,188 B。
- 576 对的期望值：原来的核对结果没留在仓库里（设计系统只记了结论），本步重测。Chromium 153.0.8010.12（Playwright 1.63.0），20px，「字{前}{后}字」在 `normal` 与 `space-all` 下用 Range 逐字量宽，UI 优先片和完整源字体各一遍，结果相同。字符扩到 `haltIndices` 里的全部 33 个（576 对之外另有［］｛｝〔〕〖〗・），共 1,089 对，加 10 句真实文案、4 组 `Sep` 拼接：
  - 整串宽度，Chromium 原生挤压与包 `.halt` 的回退 0 处不同；Firefox 155、WebKit 26.6 上回退每个 halt 正好少半个字，与 Chromium 原生相差最多 0.031px（1,180 次测量）。
  - 逐字看，只有「收标点 + 开标点」这一类（1,089 对里 204 对，576 对里 104 对）Chromium 把半字算在开标点上，回退挤收标点。两字的墨迹位置相同；换行正好断在两字之间时，回退留在行首的开标点仍是全宽，与 `normal` 的「行首开括号不挤」一致，所以不改函数。自测把量到的位置按这一条换算后与 `haltIndices` 逐对比较，开、收标点也从表里读，不照抄实现的字表。
- P 页实测（`VITE_SPECIMEN=1` 构建，preview 的 CSP 同线上，三个引擎，浅色、深色各一轮）：
  - 「不挤压 → 本规范」四组：Chromium 362.44 → 354.44、288 → 272、464 → 440、272 → 264；Firefox、WebKit 的第一组是 362.42 → 354.42，其余三组相同。前三组与设计系统 P 页的参考值一致。
  - 「）、」「（「」都是 24px（1.5em），单独的「，」16px（1em），三个引擎相同。
  - `securitypolicyviolation` 0 次，控制台错误 0 条，没有 `/api` 请求；字体只请求 `geist-ui`、`noto-sans-sc-ui`、`geist-mono-ui`，长尾 0 片（第一版，样张的字当时在 UI 优先片里；评审修订后的复测见下）。Chromium 里 antd 的 Alert、弹窗正文的计算值 `text-spacing-trim: normal`、`text-autospace: normal`。
- 偏离与取舍：
  - `Sep` 给读屏的「，」：设计系统原写 `position:absolute` 的 sr-only。实测 WebKit 26.6 的一行里只要有 absolute 的盒子，整行的 `text-autospace` 都失效：状态句窄 8px，正好是 4 处中西交界。改成空 span 的生成内容替代文字 `.sep-sr::before { content: '' / '，' }`：三个引擎的宽度与不带「，」时相同，Chromium 的无障碍树里是 StaticText「，」、没有「·」；不支持替代文字的浏览器什么也不念。设计系统 §2.5、§5.19 已改。
  - `ThemeProvider` 加 `button={{ autoInsertSpace: false }}`：antd 默认把两个汉字的按钮写成「关 闭」「发 布」，与 §2.5「中文不手打空格」相悖（走查截图里看到的）。设计系统 §8 已补，`theme.selftest.ts` 渲染一个「关闭」按钮断言。
  - P 页「标点挤压」多一组「先问人数（大人、小孩）、日期和预算」：验收 7 要在 P 页上量「）、」，设计系统列的三组里没有。
  - `scripts/check-fonts.ts` 的 `OUTSIDE_OK` 加「・」（U+30FB）：`haltIndices` 字表里的字符，不上页面。
  - `?theme=` 会记住（`setAppearance`）：`ThemeProvider` 挂载时的 `applyPrefs()` 在子组件的 effect 之后跑，不写进偏好就会被改回存的值。
  - 「关于」样张的「查看字体许可」指向 `OFL-Geist.txt`：许可原文有两份（Geist、Noto Sans SC），一个链接只能指一份，第 2.2 步做真的「关于」时定。
- 变异（隔离副本，23 例全部失败并点名，撤掉后照常通过）：`haltIndices` 7 例（字表少〖、少・、「！」算收标点、收 + 开改挤开标点、收标点后的间隔号不挤、开 + 开不挤、错一位）；`cjk` / `Sep` 4 例（逐字拆节点、按段各算不拼串、`Sep` 换回 absolute、不回退时不插 `Sep`）；全局样式 7 例（去掉 `text-autospace`、body 改 `space-all`、样张外写 `space-all`、全局 `palt`、组件里 style 改 `fontFeatureSettings`、根元素 `lang="en"`、`.sep-sr` 改 absolute）；按钮插空格 1 例；产物 2 例（样张条件改成运行时的值、用 `VITE_SPECIMEN=1` 构建生产目录）；字体 2 例（去掉「・」的白名单、样张里加「龘」；后一例在评审修订后按设计照常通过，见下）。第一轮「逐字拆节点」只被别的断言拦下：`renderToStaticMarkup` 不在相邻文本节点之间插 `<!-- -->`，拆碎检查改用 `renderToString` 后点名。
- 评审后补的（同日）：
  - 样张的字不进 UI 优先片：第一版照 spec 原来的取法把 `console/src/_specimen/` 也算进界面文字，UI 优先片从 579 涨到 646 个码位、112,188 涨到 128,280 B。多出的 67 个字全只出现在样张里，生产构建里又没有样张页，每个访客每次整页加载都多预载 16,092 B（+14%）。`scripts/fonts/ui-text.ts` 改为跳过这个目录（与不变量 9、实体名扫描对样张的处理一致），重跑 `build.ts`：`noto-sans-sc-ui.woff2`、`manifest.json`、`fonts.css` 与第 1.2 步的产物逐字节相同。spec 顶部加一行 `Revisions:`，「字体与授权义务」、设计系统 §2.6 和 P 页同步改。
  - P 页复测（同一个探测脚本，三个引擎、两套主题）：四组「不挤压 → 本规范」，「）、」「（「」24px，单独的「，」16px，都与上面相同。样张独有的字按需下 10 片长尾（三个引擎都是第 107、109、111–118 片，合计 566,520 B，只在走查构建里）。`document.fonts` 里已加载的家族仍只有三款，`securitypolicyviolation` 0 次，控制台错误 0 条。
  - 文档对齐：设计系统 §2.2「Chromium 的挤压规则」一行原写回退与 Chromium「0 处不同」「一模一样」，与 §2.5 和上面的逐字结果矛盾，改成整串宽度、墨迹位置一致，「收 + 开」一类挤的字不同。spec「标点与间距」的「576 对，结果一致」同样写细（记进同一行 `Revisions:`）。`typography.ts` 开头的「24×24 = 576 对」改成「33×33 = 1,089 对（含 576 对）」。
  - 变异（隔离副本）3 例，都符合预期：样张里加「龘」照常通过；登录页的字符串里加「龘」失败，点名文件和字；去掉 `_specimen/` 的过滤失败，点名两个样张文件、共 67 个字。
- 留给后面的步骤：
  - `/_specimen` 还没有 `Status`、`ConfirmDanger`（第 2.3 步做好后加进来）；Alert 仍是 antd 带描边的样子（§5.12，第 2.3 步）。
  - 现有页面还没用 `cjk()`：PageHeader、渲染器、Alert 这些接入点随各自的步骤重写；话术编辑器的 halt 装饰在第 5.2 步。
  - WebKit 里两个预载字体各出现两次 `request` 事件，是否真的下了两遍，第 17.2 步用 HAR 核对（验收 8「字体请求只有两个」）。
  - 本机有 `https_proxy`，preview 默认只监听 `::1`；走查脚本用 `--host 127.0.0.1` 并按 IP 访问，不然偶发整页卡住。

### 第 1.4 步（2026-09-27）

- 按开放问题 1 的 A 路（01 已于 2026-09-27 就地修订）。`BASE_CSP` 末尾加 `font-src 'self'`，页面 CSP 随之带上。新导出 `consoleAssetHeaders(rel)`：安全头、缓存头和 `Content-Type`，host 的 MIME 表挪了进去，host 与 preview 共用。`assets/` 下的文件 `public, max-age=31536000, immutable`，其余（`theme-boot.js`、许可文本等）仍是 `no-store`；不存在的资源 404 照旧 `no-store`。
- 「带内容哈希」按位置判定：vite 只往 `assets/` 写带哈希的产物。为让这一点成立，`check-console-dist.ts` 加了一条：`dist/assets/` 下的文件名都要是 `<name>-<8 位哈希>.<ext>`（不变量 26）。往 `dist/assets/` 放一个 `unhashed.js`，检查失败并点名这个文件。
- 压缩：Hono `compress` 只挂 `/console/assets/*`，`encoding: 'gzip'`，类型只认 `text/javascript` 与 `text/css`。Hono 的默认类型表还会压 svg、json，spec 只写了 JS、CSS。`threshold: 0`：验收 23 要求 `/console/assets/*.js` 都带 gzip，没有大小例外，拆包以后不到 1 KB 的 chunk 也要压。评审前的初稿给文件响应补了 `Content-Length`，让 compress 默认的 1 KB 门槛生效，这与验收 23 的字面冲突，已经改回。
- 真实构建（当前单包）经 host：`index-D71W9cL0.js` 原样 2,053,982 B，gzip 后 654,503 B，带 `Content-Encoding: gzip`、`Vary: Accept-Encoding` 和 immutable；index.html 在 `Accept-Encoding: gzip` 下不压缩、`no-store`。
- preview：vite 的静态服务会保留先设好的头，所以仍是「先设头、再交给它」；多了一步判断文件存不存在，不存在只带安全头。实测：现有资源的 CSP、缓存头、`nosniff`、`Content-Type` 与 host 相同（改前是 `no-store`）；vite preview 会自己 gzip 交给它的资源（与 spec「preview 不压缩」不符，见 Open），index.html 不压。不存在的资源在 preview 上被 vite 回退成 HTML（200、`no-cache`），01 以来一直如此，host 是 404；两边都不带 immutable。
- `console.selftest.ts` 238 → 245 条。改动的断言：`CSP` 常量加 `font-src 'self'`，全部 `/api/console` 响应的 `secured()` 随之按新常量检查；`/console/assets/app-1a2b.js` 改用 `securedAsset()`（immutable）。其余断言不动。`call()` 默认带 `Accept-Encoding: gzip, deflate, br`，和浏览器一样。新增 7 条：
  - 不变量 26：全部 `/api/console` 响应都没有 `Content-Encoding`，也不带 immutable，其中有超过 4 KB 的响应；index.html 的三种路径不压缩、不带 immutable；`theme-boot.js` 是 `no-store`，也不压缩（压缩只挂在 `assets/` 上）。
  - 压缩：JS、CSS 走 gzip（含 23 B 的 `app-1a2b.js`），解压后与原文件相同，带 `Vary`；不收 gzip 时原样返回；woff2 不压缩。
  - 页面 CSP 等于接口 CSP 加上 nonce 的 style-src。原有断言只查前缀和后缀，变异发现页面丢掉 `font-src` 也能过，所以补了这一条。
- 变异在仓库外的副本里做，评审修正之后整组重跑了一遍。以下 16 个全部变红：
  - 头：CSP 不加 `font-src`；只有页面不加；assets 不给 immutable；所有静态文件都 immutable；immutable 缺 `max-age`；资源回到旧的 `no-store`；缺资源的 404 也 immutable；`woff2` 类型错。
  - 压缩的范围：去掉 compress；compress 挂到整个 `/console/*` 并用默认类型表；同样挂到整个 `/console/*` 但类型过滤不变；compress 也压字体。
  - 接口：接口带 immutable；接口也压缩；只压 `/me`。「接口也压缩」让 JSON 解析失败，套件在走到不变量 26 之前就崩了，所以补了「只压 `/me`」，由不变量 26 那条点名。
  - 门槛：回到评审前的初稿，即补上 `Content-Length`、门槛用默认的 1 KB。由 `app-1a2b.js` 那条点名。
- 更正评审前这里的记录。初稿写的是「14 个变异全部变红，含 compress 挂到整个 `/console/*`」，但类型过滤不变时这个变异其实不变红。index.html 不压，是因为类型过滤排除了 `text/html`，与挂载范围无关；`theme-boot.js` 那条当时也不查 `Content-Encoding`。补上这一项之后才变红。
- 另有两个等价变异，不变红，符合预期：
  - 只去掉 `threshold: 0`：`c.body` 不带 `Content-Length`，compress 根本不比门槛。
  - 只补 `Content-Length`、门槛仍为 0。
- `threshold: 0` 的作用，是让以后谁给文件响应加上 `Content-Length` 时，小文件照样压缩。
- 高负载（load 110）下，口令排队超时那组原有断言会偶发失败，与本步无关。变异结果以负载降下来之后的那一轮为准。
- 没有新增依赖（`hono/compress` 在已钉的 hono 4.13.9 里）。

### 第 2.1 步（2026-09-27）

- 做了什么：
  - `src/shared/pack.ts`：设计系统 §9 的类型（`FieldType`、`FieldDef`、`EntityType`、`IndustryPack`，阶段与话术节另起了名字 `SalesStageDef`、`SopSectionDef`），外加 `ItemCheck`、`CheckIssue`。`checkPack`、`checkItem`、`ENTITY_ICONS` 留给第 3.1 步。
  - `src/packs/travel/console-pack.ts`：按设计系统 §9.1 整份写好，含 `recommend`、`min`，所以第 3.1 步的「补全」只剩逐项核对（`packs.selftest.ts`）。纯数据，只 import 类型。`src/packs/registry.ts`：`PACK_IDS` 与 `packById()`，包对象递归冻结；只认自有属性，`toString`、`__proto__` 查不到。
  - `/me` 的 `tenantName` 与 `GET /pack` 都取启动时装载的租户行（`Loaded` 多存 `tenantName`、`pack`，经 `currentTenant()` 读），不查库。`/pack` 挂 `canRead`：成员与 demo 匿名 200（匿名挂查询限流），prod 匿名 401。
  - 启动装载第 3 步解析租户之后、取锁之前查注册表，查不到以新原因 `pack_unknown` 拒绝启动（spec 顶部 `Revisions:`，`Amends:` 补「两种模式与启动装载」，「接口改动 · /pack」一条写全原因与检查位置）。`tenant-create` 的 `--pack` 读 `PACK_IDS`，用法和报错都列出注册的包。
  - `src/shared/conversation.ts`：`conversationState`、`shortIdOf`（与 `public/admin.html` 同一规则）。`console-api.ts` 加 `CONVERSATION_STATES` 与 `ConversationState`，`ConvQuery.state` 与 `ConversationCounts.byState` 都从它来，第 18 步加 `assigned` 只改这一处和判定函数。
  - 会话列表：先按 `state`、`stage` 过滤，再排序、分页，`total` 是过滤后的条数。`waiting_first` 在等人接手的组内也按 (updatedAt desc, id)，照设计系统 §10.0 修正 1（I 页里 F01 在 A01 前）。`GET /conversations/counts`：同一批会话（去掉 `sim-`）同步遍历一次；`aiByStage` 只列有会话的阶段，界面按行业包的 `stages` 补 0；`updatedToday` 按服务器时区的今天 0 点，时钟取 app 的 `clock()`。
  - `sectionBody`、`editableChars`、`SopStructureError`、`SopSection`、`SectionSpec` 挪到 `src/shared/sop-sections.ts`；`sectionBody` 用到的 `headingLine` 一起挪（`rebuildSection` 也用它）。`src/sop/sections.ts` 再导出同一个类，`editableChars` 包一层补默认节表，现有调用处没改。
  - 01 spec 顶部加 `Amended by:`。
- 字体：旅游包的标签、帮助、锁定原因，加上挪进 `src/shared` 的一句报错（「加」字），让 check-fonts 报缺 139 个字，按第 1.2 步的做法重跑 `scripts/fonts/build.ts`（fonttools 4.66.0、brotli 1.2.0 装在仓库外的 venv 里；缓存目录用完删掉）。UI 优先片 579 → 718 个码位、112,188 → 144,992 B，两个 preload 合计 124,072 → 156,876 B；两个 Geist 文件逐字节不变。界面用字 536 个汉字。
- 偏离设计系统：§9.1 有三句帮助写了中文与数字之间的空格（「4 人以下」「上浮 10%」「建议 3–5 条」），与不变量 9 冲突（它管行业包配置的标签、帮助、说明；第 2.3 步的检查会拦），包里写成不带空格，§9.1 同步改。`placeholder` 里照抄产品数据的空格按不变量 9 的例外保留。
- `console.selftest.ts` 245 → 268 条（新增 23 条，原有断言一条没改）。测试租户名改成与 slug 不同的「云途定制旅行」（在 `installSeededConfig` 之前先插租户行），不然 `/me` 返回 slug 也能过。新增：
  - 第 1 条：`/me` 的 `tenantName` 是 tenants.name。
  - 第 5 条：`state` 三个取值逐页翻完，`total` 之和等于全部，三组的行拼起来正好是全部会话，每行按 spec 的规则（测试里逐条写出，不调 `conversationState`）满足对应状态；付款后又转人工的算已成交，stage 不是 handoff 的也能是等人接手；`ConversationRow` 只有 6 个键。`waiting_first` 与独立排出的顺序逐个相同，逐页翻完一致，第一页先列完等人接手的；不带 `order` 仍是 01 的顺序；与 `state` 一起用只在过滤后的结果里排。`stage` 独立过滤（含 stage 是 quote 的等人接手会话），与 `state=ai` 同时满足。`state`、`stage`、`order` 不合规 400。
  - 第 6 条：不变量 18；`total`、各 `byState` 等于列表的 `total`，`aiByStage` 每一项等于 `state=ai&stage=…` 的 `total`；0 点前 1 毫秒的会话不计、0 点整的计；agent 200，demo 与 prod 匿名 401。
  - 第 7 条：所有者、只读成员与 demo 匿名拿到的 `/pack` 与注册表逐字段相同；响应里没有租户名、slug、租户 id、成员姓名和 UUID；prod 匿名 401、成员 200。
  - 另外：注册表只有 travel、原型上的名字查不到；租户的包不在注册表里时以 `pack_unknown` 拒绝启动（用一份新的配置源模块实例装载，不动已装好的）；`tenant-create --pack renovation` 退出码 1 并列出 travel，`--pack travel` 过了包名检查、走到缺连接串；`conversationState` 的优先级；`shortIdOf` 与 `admin.html` 里的函数（从页面源码取出来在 `node:vm` 里跑）在 11 个 id 上逐个相同。
- 变异（仓库外的隔离副本，24 例全部变红，每例都核对了点名的断言，不只看退出码）：
  - 接口 7 例：`tenantName` 取成 slug；`/pack` 改挂 `signedIn`（demo 匿名 401）；`/pack` 不挂权限（prod 匿名 200）；`/pack` 带上租户名（相等与不变量 27 两条都点名）；非编辑成员拿 `/pack` 403；counts 改挂 `canRead`（demo 匿名 200）；`stage` 的取值不校验。
  - 判定与排序 6 例：先看转人工再看付款（P02 被算成等人接手，5 条点名）；列表忽略 `state`；`stage` 只在 AI 接待中里筛；忽略 `waiting_first`；等人接手的组内改成最后动静早的在前；先分页再排序（只排本页）。
  - 计数 4 例：counts 算上 `sim-` 会话；`aiByStage` 数了全部会话；`updatedToday` 用 `>`；按 UTC 的 0 点。
  - 其余 7 例：启动不查包（报 `no_published_sop`，不是 `pack_unknown`）；注册表按原型链查；`tenant-create` 不查包名；短码的 `cust_?` 改成 `cust_`（靠补上的 `wecom:custA1`，第一版的 id 列表里没有能区分的例子）、短码不转大写；`sections.ts` 自己另定义一个 `SopStructureError`（config 自测里契约检查接不住 shared 抛的错，整份崩掉）；shared 的 `editableChars` 连锁定节也算（config 自测点名）。
  - 评审修订：`updatedToday` 那条第一版用机器自己的时区算 0 点，本机是 CST 才抓得到「按 UTC 的 0 点」；CI 跑在 UTC 下，两个 0 点是同一刻，这个变异会漏。改成测试里把 `process.env.TZ` 钉成 `Asia/Shanghai`（测完还原），并断言本地 0 点不等于 UTC 0 点；隔离副本里 `TZ=UTC`、`America/Los_Angeles` 和不设 TZ 三种下这个变异都点名变红，`>` 在 `TZ=UTC` 下也变红。
  - 变异发现的一处测试缺陷，已改：`/pack` 的「只读成员」第一版用的是 `READER`，它在前面的用例里被停用、会话失效，请求其实是按匿名放行的；改成另建一个只读成员登录，并断言它的 `/me` 是 200。
- 没有新增依赖。console 代码没改（第 2.2 步起接 `/pack` 与 counts）。

### 第 2.3 步（2026-09-27）

- 做了什么：
  - `console/src/parts/`：`StateView`（加 `Skeleton`、`EmptyBlock`）、`errors.ts` 的 `ERROR_COPY` 与 `errorCopy()`（网络失败和表外 5xx 是「服务暂时连不上」，其余表外的 error 走兜底）、`ErrorAlert`、`TechDetails`、`ConfirmDanger`、`Status`、`ActionBar`、`CheckList`、`PrimaryButton`、`toast()` 与 `ToastHost`、`useUnsavedGuard`（`useBlocker`，确认框用 `ConfirmDanger`）。样式在 `parts/parts.css`，由 `main.tsx` 全局引一次；部件本身不 import CSS，自测才能在 Node 里直接 import。
  - 会话过期：`console/src/session.ts` 把所有请求包一层（`hc` 的 `fetch` 选项）。成员身份下三条判据成立时，请求停在这里，弹 `SessionExpiredDialog` 就地登录，登录后换上新的 csrf、原样重放，调用方只拿到重放的结果。所以缓存不清、页面不卸载，匿名形状的数据也进不了缓存。每个 GET 一个 `isAnonShape`，判别键用类型钉住：匿名投影哪天也带上这个键，typecheck 就失败。登录框被关掉时，等着的请求拿到 401 `unauthorized`，匿名形状的 200 也换成 401，页面就地写「登录已过期 · 重新登录」，点了重发，就再弹一次。`viewer.ts` 在成员身份下遇到 `/me` 失败时抛错，不降成匿名；`Shell` 在 viewer 已经有值时照旧按原来的身份渲染。退出登录先离开成员身份，再调退出接口，csrf 留到退出请求结束（见下面的评审修订）。登录表单抽成 `LoginForm`，登录页和就地登录框共用，标签改成「密码」。
  - Alert 按 §5.12 改：`ConfigProvider` 的 `alert` 配置（`variant: 'filled'`、描线图标、标题 14/22/500 text、说明 13/20 text-2），加上 `antd.ts` 的 Alert 组件令牌（圆角 8、内边距 10 12、图标 16、warning 图标用 `--warning-icon`）。`theme.selftest.ts` 加一对 `Alert.colorWarning` 叠 `colorWarningBg`，1,582 → 1,601 条断言。
  - 现有页面只改不变量要求的地方，版式不动：去掉 `describe()`（它读 `detail`），`HttpError.message` 只写状态码和机器码；出错一律 `ErrorAlert` / `StateView` 就地显示；成功走 `toast()`；`type="primary"` 换 `PrimaryButton`；Modal 都写 footer，主按钮用 `PrimaryButton`；话术页的「丢弃」换成 `ConfirmDanger`；上架的 `Popconfirm` 换成 Modal，默认聚焦「再检查一下」；带 color 的 Tag 换 `Status`；检查结果换 `CheckList`（7 个固定检查项），服务端原文和哈希收进技术详情；回滚后固定规则变过时，原来的 `modal.info` 换成版本历史卡里的 warning Alert；产品库打开的条目没改动时不画保存按钮（原来点了弹 `message.info('没有改动')`）；话术页与产品库抽屉挂 `useUnsavedGuard`；界面字符串去掉中文与字母、数字之间手打的空格。文件模式页和「演示只读」横幅里的「SOP」「data/」随这次改掉，外壳的其余部分留给第 2.2 步。
  - `scripts/check-console-src.ts` 挂进 `pnpm lint`，覆盖不变量 2、3、4、6、8、9、28，逐处点名「文件:行:列」和不变量编号。夹具自测 `scripts/check-console-src.selftest.ts`（46 条）与 `console/src/session.selftest.ts`（38 条，评审修订后 52 条）、`console/src/parts/errors.selftest.ts`（77 条）串进 `pnpm test`，排在 `typography.selftest.ts` 之后；CI 注释同步。
  - `/_specimen` 控件样张加上各种 `Status`、`ConfirmDanger`（点按钮打开）、出错与空状态、技术详情、检查清单、保存条和成功 toast，主按钮换成 `PrimaryButton`（含 `blocked`）。
- 检查脚本的范围比不变量原文宽的几处：
  - 不变量 2：除了查 `type="primary"`，还查 `<Modal>` 没写 footer、`Popconfirm`、`modal.confirm` 这类快捷弹窗，因为它们自带 antd 的 primary 按钮。`variant="solid"` 只准出现在 `PrimaryButton` 和 `ConfirmDanger` 里。「每个操作区至多一个」静态查同一父元素下的 `<PrimaryButton>`：条件分支取较多的一支，`&&` 算一个；样张页不查；运行时的主按钮计数仍由验收 4 管。
  - 不变量 3：对象字面量里值可能为真的 `danger` 键（`true`、变量、表达式），这是菜单项的配法；字符串值不算，如 `ALERT_TYPE` 的 `danger: 'error'`。
  - 不变量 4：`message` 与 `notification` 只准在 `parts/toast.tsx` 里出现（import、从 `useApp()` 取、直接调）；`message.error(` 在这个文件里也不行。
  - 不变量 6：`<Badge status>` 与 `count` 同样算违规。
  - 不变量 9：查字符串与插值相接的一侧，如「第 ${n} 行」「共 {n} 条」。JSX 文本先按 JSX 的空白规则折叠。日期与时刻的例外只认「日」后面接时刻；`placeholder` 的例外只认「例：」开头；`*.selftest.*` 不查。行业包配置按 `src/packs/<包>/console-pack.ts` 找，第 2.1 步建好后自动纳入。
  - 不变量 28：另查 `innerHTML`、`outerHTML`、`insertAdjacentHTML`。
- 字体：UI 优先片 579 → 603 个码位，112,188 → 118,424 B（+6,236 B），用本机 fonttools 4.66.0、brotli 1.2.0 重跑 `scripts/fonts/build.ts`（源文件的 sha256 与脚本钉的相同）。两个 Geist 文件、许可文本逐字节不变。**与第 2.1 步合并时**：那边加的界面文字（行业包配置、`src/shared`）同样会改 UI 优先片，两个分支的 `noto-sans-sc-ui.woff2`、`manifest.json`、`fonts.css` 会冲突。后合并的一方在合并结果上重跑 `build.ts`，再跑 `check-fonts.ts`。
- 变异在仓库外的副本里做，46 例中 45 例失败并点名：
  - 真代码里造违规 13 例，不变量 2、3、4、6、8、9、28 各一到三例：`Shell` 的 `type="primary"`、CSV 弹窗去掉 footer、发布弹窗两个主按钮、「丢弃」加 `danger`、菜单项 `danger: true`、`message.error(`、从 `App.useApp()` 取 `message`、会话列表的 `<Tag color>`、产品库读 `error.body.detail`、「已发布 v」、「已建草稿 ${…}」、`dangerouslySetInnerHTML`、`setAttribute('style'`。`pnpm lint` 都失败，并点名文件、行、列和不变量编号，撤掉后照常通过（验收 3 的这几条）。
  - 检查脚本 15 例：逐条关掉规则、放宽日期与 placeholder 的例外、去掉样张与 toast 文件的豁免、不扫行业包，夹具自测都失败。第一轮有两例没变红：关掉「插值后的空格」这一侧，被模板前半段的规则兜住；`message.error` 的专门规则关掉以后，被「message 只在 toast 文件里」兜住。所以补了只有前导空格的夹具，和「toast 文件里的 message.error」一轮。
  - 会话过期 9 例：匿名身份也判过期、去掉 `/me` 判据、关掉登录框后交出匿名数据、重放不换 csrf、登录与退出接口不豁免、话术的匿名形状判断失效、空列表算匿名、收起登录框时不复位、非 GET 也按形状判。第一版自测遇到请求停住会整个挂住，退出码非 0，却点不出是哪一条；改成停住 300ms 就记为 stuck。
  - 错误文案与部件 9 例：改一条文案、表外 5xx 走兜底、`in` 代替 `Object.hasOwn`（`toString` 被当成表里有）、删一行、CSV 只数 `issues`、ErrorAlert 在技术详情外显示 detail、技术详情默认展开、中性错误画成红色 Alert。另有 1 例是等价变异：去掉「没给回调就不画按钮」的一道判断，渲染处还有一道。
- preview 实测（Chromium，Playwright 1.63.0，CSP 同线上，接口由 `page.route` 拦截，浅色、深色各一轮，走查脚本在仓库外）：
  - 样张：`ConfirmDanger` 打开后焦点在「保留」；危险按钮浅色是 `#B42318` 底、`#FFFFFF` 字，深色是 `#FF9B8F` 底、`#121214` 字，与 §5.1 相同。toast 浅色是 `rgb(24,24,27)` 底、白字，深色是 `rgb(237,237,239)` 底、`#121214` 字。`blocked` 的主按钮是 `--subtle` 底、`--text-3` 字，`aria-disabled="true"`，仍可聚焦。Alert 无可见描边（filled 变体的 1px 边框是透明的），圆角 8，内边距 10 12，标题 14/500。「等人接手」胶囊高 22、全圆、`--warning-bg` 底。
  - 话术页：编辑后点保存，PUT 返回 401 `unauthorized`，页面不卸载，弹「登录已过期」；此时编辑器里仍是改过的正文。登录后同一个 PUT 带新的 csrf（`c1` → `c2`）、原样的请求体重放成功，toast「草稿已保存」。
  - 未保存保护：再改一处，`beforeunload` 被拦下；点侧栏「线路」弹「有改动还没保存」，焦点在「留下」；点「留下」停在 `/console/sop`，再点「放弃改动并离开」到 `/console/catalog/route`。
  - 酒店列表的 GET 返回匿名形状时弹登录框；关掉以后就地显示「登录已过期 · 重新登录」，匿名投影的条目一条也没上页面。点「重新登录」、登录后列出成员数据。
  - 会话接口 500 时就地显示「没取到 · 服务暂时连不上」，带「重试」和折叠的技术详情。
  - 两套主题下 `securitypolicyviolation` 都是 0 次。控制台只有浏览器自己记的两条「Failed to load resource」，对应故意造的 401 和 500，页面代码没有报错。
- 偏离与取舍：
  - `ERROR_COPY` 在 spec 的表外多一行 `invalid_credentials`（spec 顶部 `Revisions:`，表里已补）：登录页的文案要取 `ERROR_COPY`，原表里没有登录失败这一行。
  - 未保存保护的确认框用 `ConfirmDanger`（同一行 `Revisions:`）。
  - 图标先用 `@ant-design/icons` 里描线的那一套（Alert、检查清单、技术详情的箭头），没有加 `lucide-react`：第 1.2 步记的是第 3.2 步起加这个依赖，钉 1.48.0。
  - 发布、回滚的成功仍报 toast：spec 要求写进发布条，发布条在第 6.3 步。
  - `ActionBar` 做好了，在样张里演示，页面还没用：保存条在第 10.2 步，发布条在第 6.3 步。吸底在内容面板里要贴满宽度，这要等第 2.2 步的面板。
  - rjsf 表单内部的数组按钮（antd 的 primary + danger）不在 `console/src`，查不到，第 10.3 步删 rjsf 时一起没。
  - `PrimaryButton` 的 `blocked` 就是 §5.1 说的 `aria-disabled` 主按钮；现有的发布、回滚弹窗照旧用 `disabled`，第 6、7 步改。
- 留给后面的步骤：`ERROR_COPY` 的文案挪进 `src/shared/ui-labels.ts`（第 3.4 步）；`locked_field` 的中文字段名由页面按行业包传 `fieldLabel`，现在产品库传的仍是英文键（第 10 步）；会话列表的「等人接手」仍按 `handedOver` 与 `stage` 画，第 13 步换成 `conversationState`，第 3.3 步的检查会拦下 console 里读 `handedOver`。
- 评审修订（同日）：
  - 退出登录失效：原来先清 csrf 再发 `POST /auth/logout`，请求不带 `x-csrf`，服务端回 403 `csrf`，错误被吞掉，接着 `/me` 仍是 200，人又回到成员视图，服务端的会话没删，也没写 `auth.logout`。现在 `session.ts` 的 `logoutMemberSession` 先离开成员身份，csrf 留到退出请求结束；退出接口回 401（会话本来就没了）也算退出，其余失败回到成员身份，`Shell` 在内容区顶上就地显示「没退出登录」和「重试」。退出的请求抽成 `viewer.ts` 的 `logout()`。
  - 就地登录的换了一个人：原来照样重放上一个人等着的请求，发布、回滚这类写会记到新登录的人名下。现在记下请求开始等重登时是谁的会话，登录回来的不是同一个人就不重放，等着的请求按 401 结束，其余查询按新身份重取。这时保存处就地写的仍是「登录已过期」，没有另加一行文案（`ERROR_COPY` 按 spec 的表）；再点一次保存就按新身份存。
  - 会话列表：转人工以后成交的会话，引擎不清 `handedOver`，原来也画成「等人接手」。现在按设计系统 §5.6 只有没成交的画「等人接手」，成交的画「已成交」；阶段 `handoff` 写「—」，页面上不再出现「已转人工」（验收 6）。
  - 自测：`session.selftest.ts` 38 → 52 条。新加的第 8 节走 `api.ts` 导出的真客户端，`globalThis.fetch` 换成照 `guardWrites` 验 csrf 的假服务端：过期、重登、重放一轮，退出带着当前的 `x-csrf` 并删掉会话，之后 `/me` 的 401 不弹登录框，退出失败仍是成员，退出接口 401 也算退出。第 7 节是换人不重放，以及等着时身份变了的情况。
  - 变异在仓库外的副本里做，9 例都失败并点名：退出前清 csrf、`hc` 不经 `sessionFetch`（评审复现的那一例）、换人也重放、拿当前 userId 比、退出失败不回到成员、退出失败被吞、退出的 401 不算退出、退出成功后不清 csrf、每次等待都覆盖「开始等的人」。第一轮有两例是因为假 fetch 没准备响应，整个自测崩掉才变红，点不出名字。补上备用响应以后改成按名字失败。
  - preview 实测（同上的 CSP 与拦截方式，浅色、深色各一轮）：退出请求带 `x-csrf: c1`，假服务端删了会话、记了 `auth.logout`，页面回到「演示只读」，没弹登录框；退出接口 500 时仍是成员，就地显示「没退出登录 · 服务暂时连不上」和「重试」，点重试后退出成功；保存时会话失效，就地登录换成「小林」，PUT 只发了原来那一次，编辑器里的改动还在，页头是「小林 管理员」；会话列表里转人工后成交的一行写「已成交」，`handoff` 的阶段写「—」，「已转人工」0 处。CSP 违规 0 次，控制台只有浏览器对故意造的 500、401 记的「Failed to load resource」。

### 第 2.2 步（2026-09-27）

- 合并：分支从 `dev` 起，先后合入第 2.1、2.3 步。三个字体文件冲突，按第 2.3 步记的做法在合并结果上重跑 `scripts/fonts/build.ts`（fonttools 4.66.0、brotli 1.2.0），UI 优先片 730 个码位、148,716 B。合并后第 2.3 步的 `check-console-src.ts` 开始扫第 2.1 步的旅游包，话术节的 heading「转人工条件（满足任一立即调用 handoff_to_human）」被报成手打空格。它照抄 SOP 文件的标题，节表按它对上，不属于不变量 9 说的标签、帮助、说明。检查脚本给行业包配置里键为 `heading` 的字符串开例外，夹具加两条：行业包里的这种写法通过，console 里叫 `heading` 的字符串照样报（46 → 48 条）。
- 做了什么（都在 `console/src/shell/`，旧的 `console/src/Shell.tsx` 删掉）：
  - 启动：`viewer.ts` 并发取 `/me` 与 `/pack`，判定是纯函数 `boot.ts` 的 `resolveBoot`，照 spec「外壳 · 启动」的表。`Viewer` 的成员与匿名都带着 `pack`，`usePack()` 从这里取，不再用 `/status` 分匿名和登录页。两个请求都没回来时是侧栏加面板的骨架，300ms 后才看得见；`not_ready` 与网络失败、5xx 整页 `StateView`；`db_disabled` 整页中性说明，没有按钮。登录页登录后重新判定（重置 viewer 查询）；就地登录沿用已有的 `pack`（`memberViewer`）。
  - 侧栏由行业包生成（`model.ts` 的 `buildNav`）：销售话术、`{nav.catalogGroup}` 下按 `nav.entities` 排的实体、运营（会话只给成员，审计日志只给所有者、管理员）。实体右侧的条目数取自列表，查询写在新的 `console/src/queries.ts`，列表页、侧栏、⌘K 共用同一份缓存；会话右侧是等人接手的软徽标。选中项按整段路径取最长匹配，每个路由恰好一个。
  - 租户行与铃铛：租户名取 `Me.tenantName`，匿名写「演示」；logo 兜底是主色底上的首字。`GET /conversations/counts` 与 `?state=human` 在页面可见时每 30 秒取一次（React Query 的 `refetchIntervalInBackground: false`），软徽标、铃铛徽标都取 counts 的 `byState.human`，数字变了闪一次。弹层里有空状态，轮询失败时徽标保留上一次的数、顶部一行「没取到最新的」加「重试」。
  - 搜索触发器与 ⌘K：匹配、分组、键盘都是纯函数（`search.ts`）；拼音库 `pinyin-match` 在第一次打开时动态 import。会话组只搜最近 100 个，按短码匹配。匿名没有会话组。
  - 用户行：名字和角色放在同一个 22 高、可换行、裁掉溢出的容器里，纯 CSS 先藏角色。用户菜单有身份块、外观子菜单、减少动态效果开关（点了菜单不收起）、关于、退出登录。「关于」弹窗照 P 页的样张。
  - 收起受控：每页有默认（销售话术收起），用户在这一页切过就按切的，换页回到默认。`useViewport()` 用两条 `matchMedia` 判三档：≥1280 展开、992–1279 固定 56 的图标栏（悬停出标签，没有切换按钮）、<992 是 52 高的顶栏加左侧抽屉（换地址就关上）。
  - `PageHeader`（§4.3）写标签页标题「页名 · 租户名」，非编辑角色在状态句末尾挂「只读」胶囊（悬停「你的角色是坐席，只能查看」），匿名在页头下挂 info 横幅（「去体验对话」到 `/chat.html`，「登录后编辑」进登录页）。现有四页都加了页头，产品库的新建、CSV 导入挪进页头右侧；404 页也写标题。页面的其余版式不动。
  - 跳到主要内容是每页第一个可聚焦元素，聚焦 `main`；侧栏导航是 `nav` 地标。面板自己滚动，换地址回到顶上。
  - `ActionBar` 用外壳给的 `--panel-px` / `--panel-pb` 抵掉面板内边距，吸底时贴满面板宽（第 2.3 步记的「要等第 2.2 步的面板」）。
- 依赖：`lucide-react` 1.48.0（ISC，版本与第 1.2 步钉的许可原文同号，包里的 `LICENSE` 与 `console/public/licenses/lucide-ISC.txt` 逐字节相同，`NOTICE` 第 3 条同步改）；`pinyin-match` 1.2.10（MIT，没有依赖，ESM 版 28 KB，没有 `eval` / `Function`）。都是安装时 npm 的 latest。第 1.2 步原记 lucide 从第 3.2 步起加，外壳的图标就要用，提前到这一步；实体图标集合（§7 的 24 个）的映射在 `shell/icons.tsx`，第 3.1 步定 `ENTITY_ICONS` 后把键的类型换成它。Alert 等部件里的 `@ant-design/icons` 留给第 3.2 步一起换。
- 修了第 1.1 步的一处：antd 的 `MotionWrapper` 只在 `motion` 第一次与上层不同时才包一层 `MotionProvider`，所以运行中第一次打开「减少动态效果」时整棵树换了结构、全部重挂载（走查里用户菜单一点就收起；在话术页会丢掉编辑中的内容）。`ThemeProvider` 外面垫一层 motion 与首帧相反的 `ConfigProvider`，里面那层从第一帧起就包着；`antdTheme` 不减少动效时显式写 `motion: true`，免得继承外层。`theme.selftest.ts` 随之多核对这个键（1,601 → 1,607 条）。另按 §5.15 在 `ThemeProvider` 设 Tooltip 不带箭头。重挂载只在浏览器里看得出来，Node 里的自测测不到，靠下面的 preview 实测。
- 字体：外壳新加的文字让 check-fonts 报缺 24 个字，重跑 `build.ts`：UI 优先片 730 → 754 个码位，148,716 → 154,088 B（+5,372），两个 preload 合计 165,972 B；两个 Geist 文件、许可原文逐字节不变。界面用字 572 个汉字。缓存目录用完删掉。
- 构建：入口 JS 2,079.49 → 2,092.65 kB（gzip 668.80 → 673.52 kB，+4.7 kB，lucide 图标与外壳）；拼音库单独一块 28.13 kB（gzip 20.09 kB），只在第一次打开 ⌘K 时下载。拆包与预算是第 2.4 步。
- 自测与检查：
  - `console/src/shell/shell.selftest.ts`（122 条）串进 `pnpm test`，排在 `parts/errors.selftest.ts` 之后，CI 注释同步。覆盖启动表的每一行（含成员身份下 `/me` 失败不降成匿名、表外组合、db_disabled 与 not_ready 先于网络失败）、五种角色与匿名的侧栏、每个路由恰一个选中项、标签页标题各不相同且以「 · 租户名」「 · 演示」结尾、搜索占位、徽标文字、头像取色（按 UTF-16 码元，😀 是 2 不是 5）、会话标签、相对时间（钉 `Asia/Shanghai`，今天 0 点、昨天最后一刻、跨年）、视口三档、默认收起、轮询参数、⌘K 的匹配（真实的 `pinyin-match`：jd、xianlu、kh、dyam）、分组顺序、各组的加载与出错、会话按短码、J / K 与输入法组字，以及画出来的页头（只读胶囊、演示横幅是 info）与用户行（角色在 DOM 里）。
  - `scripts/check-console-dist.ts` 加一条：`index.html` 直接加载的模块脚本与 modulepreload 里没有拼音库的字典，产物里另有一块带着它（字典写法变了就报，不会空过）。
- 变异（仓库外的隔离副本，39 例）：38 例失败并点名，1 例是等价变异。
  - 启动 7 例：pack 的 db_disabled 不认、成员身份下降成匿名、prod 两个 401 进匿名、pack 网络失败或 5xx 不当出错、not_ready 当网络失败、`/me` 200 配 `/pack` 401 也进成员。第一轮「pack 5xx」「not_ready」两例没变红：后面的分支照样抛出同样的错。补了「/me 403 配 /pack 5xx」「成员身份下 /me 401 配 /pack 5xx」「not_ready 与网络失败同时来」三条，之后都点名。
  - 侧栏、标题、徽标、时间、视口 14 例：审计给所有成员、匿名有会话、不按 `nav.entities` 排、选中项按子串前缀比、匿名标题、匿名占位写会话、徽标 100、头像按码点、客户叫法写死、今天 0 点算昨天、1280 算图标栏、图标栏能展开、话术页不收起、隐藏时照样轮询。
  - ⌘K 10 例：组字时 Enter 打开、响应 J、没输入也列实体组、会话按标签匹配、操作排到实体前、每组不限条数、拼音库不参与、↑↓ 不循环、带 Shift 也打开；`Object.hasOwn` 换成 `in` 是等价变异（JSON 条目的原型上没有字符串或数字属性，两种写法取值相同）。
  - 页头与用户行 4 例：编辑角色也有只读胶囊、横幅用黄色、说明不写角色的中文名、用户行不渲染角色。
  - 检查脚本 4 例：heading 的例外拿掉、例外扩到 console；拼音库静态 import 进入口、字典标记写错（检查不能空过）。
- preview 实测（Chromium，Playwright 1.63.0，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`，浅色、深色各一轮，走查脚本在仓库外）：
  - 1440×900 的几何与设计系统 §4 一致：侧栏 240（收起 56）；面板 x 240、y 8、宽 1192、高 884，圆角 12；租户行 40；搜索触发器 y 54、高 32，下方 8 处开始导航；导航项 32；标题 x 272、y 32，24/32/600；铃铛 28×28，实心徽标 16×16、top −3、right −4，镂空是 `--frame`；软徽标 18 高；分组标题 13/500 text-3、上 16。选中项 `--selected` 底、500；收起时选中项另有一圈 `--control-border`。
  - 每个路由 `aria-current="page"` 恰好 1 个，标签页标题依次是「线路 · 云途定制旅行」「酒店 · …」「销售话术 · …」「会话 · …」「审计日志 · …」「没有这个页面 · …」，匿名是「线路 · 演示」，登录页「登录」。Tab 第一下落在「跳到主要内容」，回车后焦点在 `main`。
  - 铃铛：两行「企微客户·A01 / 26分钟前有新动静」「企微客户·F01 / 8分钟前有新动静」，「打开工作台」是 `/admin.html#s=wecom%3Acust_A01`、`target=_blank`。轮询失败（快进 31 秒）后徽标仍是 2，弹层顶部「没取到最新的 · 重试」；点重试、多一个等人接手后两处徽标都是 3，闪了一次；全部接手后弹层只剩「没有等人接手的会话」和底部链接，两个徽标都不画。
  - ⌘K：打开前没有下载拼音块，打开后下载 1 次；焦点在输入框；输入「jd」列出页面「酒店」和线路、酒店条目，输入框里就是 jd（J / K 没被拦）；「贵州」按目的地命中两条线路、一家酒店；「f01」只命中会话 F01，组底「只搜最近100个会话」；「zzzz」写「没有找到「zzzz」」和「换个说法，或者用拼音首字母」；↑↓ 加 Enter 打开「酒店」页并关掉 ⌘K。弹窗 640 宽、距顶 120，输入行 48，行 36。
  - 用户菜单向上弹出，宽 240，左边与用户行对齐；身份块「老板 / 所有者」。在外观子菜单里选另一种主题，下一帧的 `body`、搜索触发器底色和图标按钮字色与 600ms 后完全相同（没有渐变），偏好写进 `localStorage`。点「减少动态效果」菜单不收起，`data-reduce-motion="true"`，图标按钮的 `transition-duration` 是 0s；再点一次拿掉。「关于」焦点在「关闭」，两个许可链接 200、`text/plain`。
  - 用户行：「一二三四五六七」名字完整、角色被裁掉，Tooltip「一二三四五六七·所有者」；「老板」「技术支持 主管」名字和角色都在。主管登录：页头有「只读」胶囊，悬停「你的角色是主管，只能查看」；没有审计日志入口，也没有新建、导入。
  - 收起：手动收起后 56 宽；进销售话术页默认收起，面板 x 56、宽 1376；在这一页展开后去会话页，仍是展开（会话页默认展开）。
  - 视口：1100 宽是 56 的图标栏、没有切换按钮、内容内边距 24；800 与 375 宽是 52 高的顶栏，面板 x 8、y 52，内边距 16，抽屉 240 宽，点导航后抽屉关上；三档的 `scrollWidth` 都等于 `innerWidth`。
  - 匿名：租户行「演示」，没有铃铛、会话和审计入口，用户行是「登录」「关于」「收起侧栏」；页头下 info 横幅，右侧「去体验对话」「登录后编辑」；没有发出任何会话请求；⌘K 搜「a0」没有会话组。点「登录后编辑」到登录页，登录后进成员外壳，退出后回到演示。
  - 启动：`/me` 晚 1.2 秒时，100ms 时骨架不可见、500ms 时可见，之后进页面；`/me` 503 `not_ready` 是「系统正在启动」加「重试」；`/pack` 500、`/pack` 连不上（`/me` 401）都是「没取到 · 服务暂时连不上」加「重试」，不按匿名显示；`db_disabled` 只有一句说明；两个 401 进登录页。
  - 两套主题下 `securitypolicyviolation` 都是 0 次，页面代码的控制台错误 0 条；另有浏览器自己记的「Failed to load resource」，对应故意造的 401、500 和匿名的 `/me` 401。
- 偏离与取舍（spec 顶部 `Revisions:` 记了前两条）：
  - 用户菜单的身份块只写名字和角色：设计系统 §4.2 要写邮箱，`Me` 没有邮箱字段，spec 的接口增补也没加。
  - 搜索触发器的 Tooltip 在 Mac 上写「⌘K」，其余写「Ctrl+K」；快捷键按平台只认一种（评审之后改，见下）。
  - ⌘K 的实体结果在条目详情路由（第 10 步）之前打开这个实体的列表页，改的是 `Shell.tsx` 的 `openEntity` 一处。
  - 侧栏还没有「总览」：`/` 仍重定向到销售话术，第 4 步加路由时在 `buildNav` 最前面加一项。
  - 「操作」组放外观三项、减少动态效果、关于、退出登录（匿名是登录）；spec 只说是静态的。
  - 相对时间先放在 `shell/model.ts` 的 `sinceText`，第 3.4 步的 `src/shared/format.ts` 接手后换掉；角色的中文名 `ROLE_LABEL` 同样等第 3.4 步挪进 `ui-labels.ts`。
  - 产品库页的页名取行业包的实体名，包没到时退回旧的 `KIND_LABEL`，第 9 步重做列表时去掉。
- 评审之后（同日，12 条意见接受 11 条，1 条只接受一半）：
  - 行业包通用：`api.ts` 的 `catalogKind` 原来拿接口的 `route | hotel` 枚举筛，别的包的实体在侧栏、⌘K、计数里整个消失，侧栏只剩一个空的分组标题。改成只转类型、不筛（spec「下发」只要求转换）。实体表由 `model.ts` 的 `packEntities` 一处给出，侧栏、搜索占位、⌘K 同源。走查：kind 为 `package` / `material` 的假包，侧栏「产品库 · 装修套餐 20 / 主材 23」，占位「搜索装修套餐、主材、会话…」，发出 `/catalog/package`、`/catalog/material`，⌘K 搜「贵州」出这两组。路由 `params.parse` 仍把非 hotel 的 kind 当成 route（见「Open」）。
  - 读屏：收起时用户按钮的名字是「老板，所有者」（原来没有名字）；收起的租户 logo 是 `role="img"`、名字是租户名；收起的导航标签改成视觉隐藏（原来是 `display: none` 加 `aria-label`），「会话」读作「会话 等人接手2个」。用户菜单的外观三项是 `menuitemradio`、减少动态效果是 `menuitemcheckbox`，都带 `aria-checked`，切换后读屏状态跟着变；子菜单箭头换成 lucide 的 `chevron-right`（aria-hidden），外观项的名字不再带 antd 图标的「right」。⌘K 弹窗的名字是「搜索」（标题只给读屏，1×1 裁掉）。
  - ⌘K 的数据：各实体列表 `staleTime: Infinity`，只取还没载入的，刷新归侧栏与列表页；最近 100 个会话 30 秒内再开不重取（`queries.ts` 的 `paletteListQuery`、`paletteConversationsQuery`）。实测：打开前 2 个请求，第一次打开后 3 个（只多了最近会话，线路、酒店已经在侧栏的缓存里），再开关三次还是 3 个（评审测的是 5、8、11）。
  - ⌘K 与铃铛的组内骨架套上 `state-skeleton`：60ms 时 `visibility: hidden`，400ms 时 visible，两套主题相同。
  - 快捷键按平台只认一种：Mac 只认 ⌘K，其余只认 Ctrl+K，已被别处 `preventDefault` 的按键不接；`aria-keyshortcuts` 同样按平台写。实测：话术编辑器里按 Ctrl+K 删到行尾、⌘K 不打开，⌘K 照常打开。spec 顶部第 2.2 步的 `Revisions:` 改写了第二条。
  - 页头吸顶（设计系统 §4.3，原来没做）：还是同一个 `header`，滚出面板顶部后加 `is-stuck`，`position: sticky`，高 52、贴满面板宽、页名 15/22/600、藏起状态句、`--panel` 底、`inset 0 -1px 0 var(--divider)`；缩起时用下外边距补回原高，下面的内容不跳。是否滚出由页头前 1px 的哨兵加 `IntersectionObserver`（root 是面板的滚动区）判断。h1 与操作按钮都只有一份，没有复制。产品库与审计页的页头挪出 antd `Space`（Space 给每个子元素包一层 div，吸顶吸不住），页头到下一块因此由 28 变成设计系统写的 20。实测（酒店列表 29 行，滚到 300）：1440 宽 1128×32 → 1192×52，在 (240, 8)，表格顶在滚动内容里的位置 100 → 100；主管（有只读胶囊，原高 58）126 → 126；800 宽 784×52 在 (8, 52)；匿名的横幅位置 80 → 80；滚回顶部后复原。两套主题的底色分别是 `#fff`、`#121214`。
  - 「关于」的许可链接拆成三个：「查看Geist许可」「查看思源黑体许可」「查看图标许可」，思源黑体的版权声明原来从界面上打不开（第 1.3 步留下的问题）；三个都 200、`text/plain`，首行分别是 Geist Project Authors、Adobe、ISC License。spec「关于」、验收 8 第 4 条、设计系统 §2.6 与 P 页同步改，记进 `Revisions:`；样张页的关于弹窗跟着改。
  - 自测补上接线：画一次 `Bell`，查询缓存里计数与等人接手两个查询的选项是 30 秒、后台不轮询；`TenantRow`（侧栏与窄屏顶栏共用）匿名没有铃铛；用户按钮的名字；菜单项的 role 与 `aria-checked`；快捷键按平台；⌘K 的数据用真的 `QueryObserver` 加假 fetch 数请求；另一个行业包的侧栏、占位、实体表与 kind 原样。删掉原第 186 行空转的断言。122 → 143 条。
  - 变异（仓库外的隔离副本，19 例全部失败并点名）：kind 又按枚举筛、实体表不按 nav 排、⌘K 列表不设 staleTime、⌘K 列表关着也取、⌘K 会话每次都取、铃铛列表 `refetchInterval: false`、计数不轮询、后台也轮询、匿名也画铃铛（后两例是评审复现的那两个）、收起的 logo 没有 role、用户按钮没有名字或不带角色、减少动态效果不是 checkbox 或 `aria-checked` 写反、外观项不标当前、Mac 也认 Ctrl+K、Windows 认 Win+K、不看 `defaultPrevented`、`aria-keyshortcuts` 两种都写。
  - 走查中另外发现、一并修掉的：指针停在搜索触发器上时，⌘K 打开后很快按的第一下 Esc 被触发器的 Tooltip 吃掉（它排到 antd 的 Esc 栈顶），⌘K 关不上；评审时的构建 c0bc50e 上同样能复现。⌘K 开着时把这个 Tooltip 关掉（铃铛已经这么做），之后开关三轮都能关。
  - preview 实测（同上的 CSP 与拦截方式，浅色、深色各一轮）：以上各项；两套主题的 `securitypolicyviolation` 都是 0 次，页面代码的控制台错误 0 条。入口 JS 2,092.65 → 2,094.01 kB（gzip 673.52 → 673.93 kB）。
  - 没照做的一条：评审指出合并提交 77b0214 里含了 `check-console-src.ts` 的 heading 例外，它不在两个父提交里。这一改动本记录的「合并」一条已经写明，PR 描述里点名；分支没推送，但改写已有的合并提交要动历史，不做。

### 第 2.4 步（2026-09-27）

- 做了什么：
  - 各页 `.lazy()`：`console/src/pages/{sop,catalog,conversations,audit}.lazy.tsx` 各导出 `createLazyRoute(id)({ component })`，`router.tsx` 只留路径与参数。样张页同样改成 `_specimen/{controls,type}.lazy.tsx`（原来是 `lazyRouteComponent`），仍只在 `VITE_SPECIMEN=1` 时注册。登录页不是路由（外壳直接渲染），留在入口。
  - 路由加 `defaultPendingComponent`（`StateView` 的骨架）与 `defaultErrorComponent`（重试是整页重新载入）。拆包以后多了一种失败：页面块取不到（断网，或发版后旧块已经不在了）。不配的话，TanStack 显示自带的英文「Something went wrong!」。等待时间与出错文案在评审之后改过，见下方「评审之后」。
  - `console/vite.config.ts`：删掉 `chunkSizeWarningLimit: 4096`，开 `build.manifest`，`assetsInlineLimit: 0` 保留。新加构建插件（评审之后叫 `buildMeta`），写出每个 JS 块的模块清单 `modules.json`：manifest 只记块与块的引用，不记模块，`@codemirror` 的去向要按模块查。清单与 manifest 评审之后都挪出了 dist，见下。
  - `scripts/check-console-dist.ts`（仍挂在 `pnpm test` 末尾、紧跟构建）加的检查：
    - 首屏 JS：入口集合加总览路由块，gzip ≤420,000 B。index.html 直接加载的脚本都要在入口集合里，防止少算。
    - 换页：每个路由块连同静态依赖、去掉入口集合已有的，gzip ≤250,000 B。
    - 入口集合里没有 `src/pages/` 的模块（`LoginPage.tsx` 除外），也没有 `@codemirror`。产物里要能找到 `@codemirror`，检查不会空过。评审之后另查带 `@codemirror` 的块只经话术页下载。
    - 任何块里没有 `src/_specimen/` 与 `src/shared/pack-fixtures/` 的模块。
    - 三个字体各自的上限；preload 的正好是 `geist-ui` 与 `noto-sans-sc-ui`，合计 ≤300,000 B。
    - 文本扫描跳过 woff2，查 `fonts.googleapis.com` / `fonts.gstatic.com`；CSS 里查 `url(data:`（评审之后带引号的也查）。
- 拆包前后（同一种算法：gzip 取 zlib 默认级别，与 host 的 Hono `compress` 实际发出的一样；vite 构建日志里的 gzip 数字算法不同，不作准）：
  - 前（6933c29）：入口一个块 2,094,010 B，gzip 667,875 B；拼音块 28,136 B（gzip 20,079）。
  - 后：入口集合 4 个块（入口；rolldown 运行时；antd、React、路由等的共用块；Typography 块），共 966,223 B，gzip 315,554 B。这是拆包前的 47%，目标 6 要求 2/3 以下，预算 420,000。换页额外下载：产品库 246,983 B（预算 250,000，余 3,017 B，块里有 rjsf）、话术 201,625 B、审计 87,885 B、会话 86,184 B。三页共用的 antd Table 块（85,256 B）算在每一页的换页里。拼音块不变。
  - 字体：`geist-ui` 11,884 B、`geist-mono-ui` 7,972 B、`noto-sans-sc-ui` 154,088 B，preload 合计 165,972 B（预算依次 16,384 / 12,288 / 280,000 / 300,000）。产物里 104 个 woff2（101 片长尾加 3 个自切），CSS 里 `url(data:` 0 处，`assetsInlineLimit: 0` 生效（变异里改回默认值，CSS 里就出现 `url(data:`）。
  - 没有超预算：开放问题 8 不用请 owner 定，spec 不改。
- 首屏的口径：spec 算「入口集合加总览路由块」，总览在第 4 步。在那之前检查只算入口集合，输出里写明。`OVERVIEW` 常量指 `src/pages/overview.lazy.tsx`，第 4 步用这个文件名，它就自动算进首屏。变异里建了一个带着话术页的 `overview.lazy`，首屏 517,339 B，被拦下。现在 `/` 仍重定向到销售话术，直接打开 `/console/` 实际下载入口集合加话术页，gzip 共 517,179 B，超过 420,000；第 4 步落地时 `/` 换成总览，这个问题随之解决。
- preview 实测（Chromium，Playwright 1.63.0，CSP 同线上，接口由 `page.route` 拦截，浅色、深色各一轮，探针在仓库外）：
  - 直接打开 `/console/sop`：JS 只有 `theme-boot.js`、入口集合 4 块、话术页块和它的依赖（Table、UnsavedGuard、useInfiniteQuery），CodeMirror 正常。按 preview 自带的 gzip 计，入口集合 315,775 B，话术页 201,625 B。
  - 依次点侧栏：酒店只多下产品库块，会话只多下会话块，审计日志只多下审计块；再回线路、销售话术，不再下载。标签页标题照旧（「酒店 · 云途定制旅行」等）。直接打开 `/console/catalog/hotel` 不下话术页的块。
  - 审计块慢 2.5 秒：点侧栏后选中项和地址马上变，上一页留着；1.5 秒时面板是看得见的骨架（约 1 秒时换上，`state-skeleton` 再等 300ms），块到了出页面。首次打开时会话块慢：外壳先出来，面板里是骨架。（评审之后等待时间改了，复测见下。）
  - 审计块被断开：外壳还在，面板里是「没取到 · 服务暂时连不上」、折叠的技术详情和「重试」，没有英文错误页。点重试，整页重新载入后进审计日志。控制台有一条 React 报的 `TypeError: Failed to fetch dynamically imported module`，对应故意造的失败。
  - 匿名：话术页和横幅照常；⌘K 第一次打开时才下拼音块。
  - 两套主题下 `securitypolicyviolation` 都是 0 次，除上面故意造的那一条外，控制台错误 0 条。
- 变异（仓库外的隔离副本，19 例全部失败并点名，还原后照常通过）：
  - 拆包 5 例：话术页、审计页、产品库页各改回静态 import（审计页那例预算照样过，只由「入口集合里有页面模块」点名）；入口里 import `@codemirror/state`；会话块里带上产品库页和话术页（换页 362,998 B）。
  - 首屏 1 例：带着话术页的 `overview.lazy`。
  - 配置 3 例：关掉 manifest、去掉 `chunkModules`、`assetsInlineLimit` 回到默认。
  - 禁入 5 例：CSS 里写 `data:` 图片、CSS 引 `fonts.gstatic.com`、脚本里写 `fonts.googleapis.com`、用 `VITE_SPECIMEN=1` 构建生产目录、console 引假包模块。
  - 字体 4 例：`geist-ui` 超 16 KB（preload 合计同时超）、`geist-mono-ui` 超 12 KB、preload 多一个 `geist-mono-ui`、preload 少了 UI 优先片。
  - 检查自身 1 例：闭包不递归，入口集合漏算 modulepreload 的块，由「index.html 加载了它，manifest 的入口集合里却没有」点名。
  - 第一轮有两例是变异本身写错了，改正后都点名：`geist-mono-ui` 那例用 11,884 B 的 `geist-ui` 覆盖它，本来就没超；总览那例其实已被拦下，只是期望的文字只在检查通过时才打印。
- 偏离与取舍（除第一条外是 spec 没写到的细节，spec 不改）：
  - 下载页面块时的骨架是通用的整页骨架（页头一行加表格 8 行），不是「和成品同尺寸」：块到之前，页面自己的骨架还没下载下来；按页定制就得在入口里给每页另写一份骨架，并随各页的版式同步修改。块到了以后各页照旧放自己的骨架。这一条改了 spec「通用部件 · StateView」，spec 顶部有 `Revisions:`（评审之后）。
  - 路由的 `defaultPendingMs` 设 0 以后，在已经下过的页之间换页，TanStack 也会先提交一次等待态再换成页面：MutationObserver 每次换页都看到一次整页骨架（6 次换页 6 次）。按 `requestAnimationFrame` 逐帧看，134 帧里没有一帧画出骨架或空面板，所以不改。它的一个后果：线路与酒店之间换页（同一路由换参数），产品库页会重新挂载，页内状态（打开的抽屉等）不留；以前 1 秒的等待下它不重新挂载。只换查询参数时不会出现等待态。
  - 换页预算只管路由块（`src/pages/*.lazy.tsx`）。拼音块这类按需加载的块不算站内导航，仍由原有的检查管着不进入口集合。
  - vite 构建会报默认 500 kB 的块大小告警：共用块 609.83 kB、产品库块 503.81 kB（rjsf）。spec 要求删掉覆盖，由预算把关，所以不再压这条告警。
  - 共用块被 rolldown 按其中一个模块命名为 `PageHeader-*.js`，只影响文件名。
- 评审之后（同日，5 条意见全部接受）：
  - 路由接住的错误分两种（`parts/StateView.tsx` 的 `RouteError`）。初稿对页面渲染时抛的错也写「没取到 · 服务暂时连不上」：`errorCopy` 把所有 TypeError 当成 fetch 连不上，页面代码里常见的「Cannot read properties of undefined」就是 TypeError。改成：页面块没取到仍是「没取到 · 服务暂时连不上」，接口错误照 `ERROR_COPY`；别的都包成 `PageCrash`，不是 TypeError，走兜底「无法完成这项操作」，不写「没取到」，技术详情里是原来的类型与消息。`errors.ts` 的 `isChunkLoadError` 认四种消息：三个引擎 import() 失败的消息，与 TanStack 的 `isModuleNotFoundError` 同一组；另加 vite 预载 CSS 失败，它是普通的 Error，`errorCopy` 随之把它也算成连不上。`errors.selftest.ts` 加 22 条（77 → 99）。
  - 等待态：路由的 `defaultPendingMs`、`defaultPendingMinMs` 都设 0。默认值是 1 秒和 0.5 秒：换页后先留着上一页 1 秒，侧栏和地址已经换了，面板还是上一页，还能点；再加上 `state-skeleton` 的 300ms，骨架约 1.3 秒才看得见。现在一换页就换下上一页，骨架照 StateView 的规矩 300ms 后才看得见；块一到就出页面，不为防闪硬留 0.5 秒。骨架由 3 行换成 `PageSkeleton`：页头一行，与页名同高 32、下距 20；下面是表格 8 行。
  - 构建元数据不随产物发布：初稿的 `dist/.vite/manifest.json` 与 `modules.json` 随 dist 进镜像，host 按文件返回 `/console/.vite/*`，每个部署都公开依赖的确切版本（如 `zod@4.6.5`）。现在 `buildMeta` 插件在构建开始时清掉 `console/build-meta/`，写完产物后把 manifest 从 `dist/.vite/` 挪过去、删掉 `dist/.vite`，模块清单直接写在那里。检查从那里读，并查 `dist/.vite` 不存在；`console/build-meta/` 进 `.gitignore` 和 `.dockerignore`。没改 host 和 Dockerfile。
  - `@codemirror` 只经话术页：初稿只查入口集合。评审的变异是审计页引 `TextEditor`，CodeMirror 单独成块、进了审计页的换页，预算照样过。现在检查找出带 `@codemirror` 模块的每一块，要求两条：从话术页的块出发，按 manifest 的静态与动态引用能到它；从入口出发、不进话术页的块就到不了它。别的页、共用块和 ⌘K 这类按需加载的块都在这条里。输出里写明它在哪一块（现在是 `sop.lazy-*.js`）。
  - CSS 的 data: 地址用 `/url\(\s*['"]?\s*data:/i` 查。data: 里有空格时压缩后保留引号，初稿按字面找 `url(data:` 会漏。CSP 没写 `img-src`，这种图片同样被 `default-src 'self'` 拦下。
  - 数字：入口集合 gzip 315,829 B（+275 B，`RouteError`、`PageCrash`、`PageSkeleton`）；换页最多仍是产品库，247,077 B，余 2,923 B；preload 字体不变。产物 122 个文件，少了 `.vite` 下的两个。
  - preview 复测（Chromium，Playwright 1.63.0，CSP 同线上，浅色、深色各一轮）：
    - 审计块慢 2.5 秒：100ms 与 220ms 时上一页已经不可见，面板里的骨架还没显示出来；450ms、1.5 秒时整页骨架可见。骨架的页头在 y=32、高 32、下距 20，8 行。块到后真实页名也在 y=32，页面不跳。骨架条的底色，浅色是 `rgba(9,9,11,.05)`，深色是 `rgba(255,255,255,.06)`，圆角 4px，与设计系统 §4.5 的 `--subtle`、`--r-xs` 相同。
    - 首次打开时会话块慢：1.2 秒时整页骨架可见；页面出来后，页名的位置与骨架的页头相同。
    - 块被断开：「没取到 · 服务暂时连不上」、折叠的技术详情、「重试」，点重试后进审计日志。
    - 审计块换成渲染时抛 TypeError 的模块：「无法完成这项操作」、技术详情「TypeError: Cannot read properties of undefined (reading 'rows')」、「重试」，外壳还在，没有「没取到」和英文错误页。
    - 两套主题的 `securitypolicyviolation` 都是 0 次。控制台错误只有这两处故意造的：`Failed to fetch dynamically imported module` 和那条 TypeError。
  - 变异（仓库外的隔离副本，14 例全部失败并点名）：
    - 产物检查 8 例：审计页引 `TextEditor`（评审的那一例）；外壳按需 `import('./TextEditor.js')`；CSS 里带引号的 data: SVG（评审的那一例）；不带引号的 data: 图片；`assetsInlineLimit` 回到默认；`buildMeta` 不挪 manifest、不删 `dist/.vite`；去掉 `buildMeta`；关掉 `build.manifest`。
    - `errors.selftest` 6 例：`RouteError` 不分类；接口错误也包成 `PageCrash`；认不出 WebKit 的消息；vite 预载 CSS 失败不算连不上；`PageCrash` 不保留原来的类型名；`PageSkeleton` 只有 3 行。
    - 另有 1 例按预期存活：`buildMeta` 构建开始时不清上一次的清单，同时关掉 manifest，检查读到的是上一次的 manifest。这说明构建开始时的清理是必要的，关掉 manifest 那一例靠它才被拦下。
- 没有新增依赖。worktree 里的依赖用 `pnpm install --frozen-lockfile` 装（主工作区的 `node_modules` 没有第 2.2 步加的 `lucide-react`），锁文件没变。
- 留给后面的步骤：
  - 第 4 步：总览的懒加载文件叫 `src/pages/overview.lazy.tsx`（检查按这个名字找），加上以后把检查里「总览还没有，只算入口集合」的分支改成失败。
  - 第 9、10 步：产品库的换页只剩 2,923 B 余量，rjsf 到第 10.3 步才删。在那之前往产品库页加代码（渲染器、列表重做），先看 `pnpm test` 末尾的换页数字；超了按开放问题 8 请 owner 定。
  - 第 12 步：CSV 解析要进导入弹窗自己的块（spec「性能」）。现在 `CsvImport` 静态打在产品库块里：它只在客户端解码文件，解析在服务端。
  - 第 3.3 步：假包按文字查（这一步只按模块路径查）。

### 第 3.1 步（2026-09-27）

- 做了什么：
  - `src/shared/pack.ts`：`ENTITY_ICONS`（设计系统 §7 的 24 个名字，冻结，另导出类型 `EntityIcon`）、`checkPack`（不变量 13）、`checkItem`（spec「校验」）。`console/src/shell/icons.tsx` 的图标表键类型换成 `EntityIcon`（第 2.2 步留的），集合加减一个名字、这张表不跟着改，`pnpm typecheck` 就失败；运行时没变。
  - `checkPack` 查：实体 kind、字段 key、分组、阶段、话术节不重复；`nav.entities`、字段的 `group`、`lockGroup`、`showWhen`、`countFrom`（要指向 intUnit）、`unitFrom`（要指向单选 enum）、`reference.to`、`filterBy`（本实体和对方都要有）、`titleKey`、副标题、列表的列、筛选、搜索、`activateLine` 的占位都指向存在的项；实体图标在集合里；上架后锁定的字段要有锁定组；按类型的配置项（enum 要有不重复的 options，`storeAs` 只用在多选 enum，`recommend` 的条数只用在数组字段）；有序子项里的字段不分组，不支持 `showWhen`、`countFrom`、`recommend`、锁定、`unitFrom` 和再嵌一层；`$` 开头的只能是三个系统字段；锁定的话术节要写原因，只有第一节可以没有标题。
  - `checkItem` 的规则：必填的缺了报「没填」（enum、boolean 报「没选」）；数组类型的必填只要求键在，`min` 拦上架；`showWhen` 没显示的字段不查也不计；`countFrom` 的条数一致单独算一项，报「还差1天」「多了1天」；有序子项的每处缺漏一条问题，标签是中文路径「逐日行程 · 第3天 · 当晚住宿」，都挂在逐日行程这一项下；`autoIndexKey` 要等于序号；各类型的格式照 schema（文字非空且存得下，`$code` 照 `CATALOG_CODE`，金额是正整数，intUnit 是不小于 `min`（默认 0）的整数，月份区间与 schema 共用 `monthsReadable`，enum 在 options 里，按字符串存的多选只要求非空，规则之外的旧值照原文放过）。建议项：`recommend: true` 没填报「没填」，给了条数报「建议3–5条」「建议至少5条」「建议不超过2个」；同一个字段必须项已经没过时不再提建议。
  - 共用而不复制：`src/shared/catalog.ts` 导出 `CATALOG_CODE`，`src/shared/season.ts` 加 `monthsReadable`，`RouteSchema` 的 bestSeason 改用它，行为不变。
  - 旅游包：第 2.1 步已按 §9.1 整份写好。本步逐个字面量比对，除去第 2.1 步记的三处空格，与 §9.1 相同，没改。
  - 假包 `src/shared/pack-fixtures/renovation.ts` 照 §9.2，纯数据，只 import 类型。不进注册表（自测断言），产物检查早已按模块路径拦（第 2.4 步）。
  - `src/packs/packs.selftest.ts` 串进 `pnpm test`，排在 `console.selftest.ts` 之后，CI 注释同步。
- 自测：216 条断言，约 0.3 秒（评审之后的数，初版 195 条）。
  - 实体图标集合从设计系统 §7 那一行读出来比，不照抄实现。
  - 不变量 13：两个包过 `checkPack`；另有 59 种改坏的副本，每种都要点出对应的问题；3 种合规的改法（`recommend` 的条数写在多选引用、多选 enum、标签上）要照常通过。
  - 不变量 14：工具名、`SOP_KNOWN_FIELDS`、节表（key、heading、locked、顺序）、锁定表（`lockedWhenActive` 的字段加上永远只读的编号，等于 `LOCKED_WHEN_ACTIVE`；`tags:国内` 按 `members` 展开）、阶段（写成 `Record<SalesStage, true>`，SalesStage 加减取值时 typecheck 失败；包里正好是除去 handoff 的全部）。schema 按 zod 的 `shape`、`element`、`unwrap` 走出属性路径，与字段配置一一对应（两个方向都比），枚举的 options 与 schema 相同，顶层键与子字段的选填与 schema 的 optional 相同。
  - 不变量 15：data/ 下 20 条线路、23 家酒店，按字段配置生成变异，共 3,405 例，其中 schema 通过 669 例。每例比两边结论，写明预期的也比预期。变异包括 spec 列的五类，外加各类型的格式、NUL、编号格式与长度、序号、条数加减、「全年」和跨年区间、餐食的旧写法、金额与 intUnit 的安全整数边界。
  - 计数口径钉在 r-guizhou-5d 上（按设计系统 §10.0 从 r-guizhou 造）：13/13，建议 1 条「体力强度没填」；第3天缺住宿 12/13；两处缺漏仍是 12/13；天数 6 报「还差1天」；填了体力强度 13/14，写了最累的一段 14/14。另有逐类型的说法、只认自有属性，以及假包上旅游包没有的配置：多选引用、boolean、多字段子项不带 countFrom、选填子字段。
- 变异（仓库外的隔离副本，66 例全部失败，每例都由具名断言点出，没有一例是崩掉的）：
  - `checkItem` 28 例：选填没填也查、去掉条数一致、还差与多了写反、空数组算没填、不查 min、金额允许 0、金额收数字字符串、不查月份、单选不查 options、storeAs 严查、忽略 showWhen、没显示的也计数、选填写错不拦、选填写错拦但不计数、不查序号、子字段选填当必填、没过也提建议、建议用连字符、第几项从 0 数、走原型链、编号不查格式、不查存得下、intUnit 允许负数、requiredPassed 不减、tags 不查空串、多选不查 options、boolean 收字符串、「没选」写成「没填」，以及 `monthsReadable` 去掉「全年」。
  - `checkPack` 18 例：逐条关掉规则，由对应的改坏副本点名。这 18 例没覆盖全部规则，评审又找出 6 条关掉后自测照过，补法见「评审之后」。
  - `ENTITY_ICONS` 少一个、多一个：自测点名，console 的 typecheck 也报 `icons.tsx`。
  - 旅游包与假包 16 例：少一个工具、少一个话术字段、话术节换顺序、少一节、锁定改掉、最高海拔不锁、只锁的标签写错、阶段加 handoff、少 closing、字段 key 写错、客群少一个选项、其他叫法改必填、餐食改选填、行程亮点去掉 min、线路图标不在集合里、酒店少一个字段；假包 unitFrom 写错、引用指向不存在的实体。
  - 第一轮「话术节换顺序」写成了删一节，自测在改坏副本那段按 key 找「tone」时抛了 TypeError，没有点名。改坏副本的几例改成不依赖具体 key（往末尾加节、加阶段）后，换顺序与删一节都由节表那条断言点名。
- 字体：`checkItem` 的「还差N天」用到「差」，按第 1.2 步的做法重跑 `scripts/fonts/build.ts`（fonttools 4.66.0、brotli 1.2.0）。UI 优先片 754 → 755 个码位，154,088 → 154,192 B（+104）；两个 preload 合计 166,076 B。两个 Geist 文件、许可原文逐字节不变。`checkPack` 的话给开发者看，但 `src/shared` 的字符串都算界面用字，所以只用界面已有的字。初稿的「（设计系统 §7）」带进「设」和「§」，删掉了，没为它们涨字体。
- 构建：入口集合 gzip 315,830 B（+1，字体文件名变了，引用跟着变）；换页最多仍是产品库，247,083 B（+6，`catalog.ts` 改用共用的判定），余 2,917 B。
- 界面：console 只改了图标表的键类型，运行时不变；新字形还没有页面用。所以本步没做 preview 走查。
- 偏离与取舍：
  - `ItemCheck` 加 `requiredTotal`、`requiredPassed`（spec 顶部 `Revisions:`，「配置结构」的接口与「校验」同步改）。有序子项的每处缺漏各是一条 `CheckIssue`，一项里可以有几条问题，两个数组算不出「必须项12/13」。`CheckIssue.message` 是跟在字段名后面的半句，建议项的「（不拦上架）」由界面加。
  - 选填字段填了却写得不对，一样拦上架，并且单独算一项（同一行 `Revisions:`）。不这样，`checkItem` 与 schema 在这类 payload 上判得不同。选填字段写成空值（`""`、`[]`）不查：表单把清空的选填字段删键，这种 payload 只由服务端拦，变异里也不造。
  - 数值的 `max` 不算检查项，只是输入框的上限（spec 列的必须项来源里没有它）。天数 31 两边都放过，自测里有一例。
  - `checkItem` 不查的两种由服务端兜底，已在代码注释里写明：payload 里没有对应字段配置的键；`showWhen` 没显示出来的字段却带着值（如只有 `intensity.hardest`）。表单都造不出这两种。
  - 假包照 §9.2，去掉中文与数字、字母之间手打的空格（「提前4周」「节点{n}」「ENF级」「E0级」「E1级」），§9.2 同步改，与第 2.1 步对 §9.1 的处理相同。验收 5 写的「节点 3」是画出来的样子，中间的空隙由 `text-autospace` 补。「节点3」只有 3 个字符，按 §6.3 原来的判定会写进节点，评审之后改了判定，见下。
- 评审之后（同日，五处，都改了）：
  - 金额与 intUnit 要是安全整数：zod 4 的 `int()` 不收绝对值超过 2^53-1 的数，原来的 `Number.isInteger` 放过 2^53，界面显示必须项全过、保存却 422（不变量 15 走偏，生成器也没造这种值）。改用 `Number.isSafeInteger`，超出报「数字太大」；生成器给金额与 intUnit 各加「超出安全整数」「等于最大安全整数」两例，另有起价、最高海拔、天数三条具名断言。
  - `$code` 的说法补上长度：「只能是小写字母、数字和连字符，以字母或数字开头，最长64位」，与 schema 的说法一致；原来 65 位的合规字符被说成字符不对。生成器加「长65位」「长64位」。
  - 条数一致这一项在 `countFrom` 指向的字段自己有问题时不报：原来只排除负数和小数，天数为 0（低于 `min` 1）时天数报「至少1天」、逐日行程又报「多了5天」，一个错算两项。现在用 `fieldIssues` 查那个字段，有问题就不比条数；「天数为0」的断言改成只有天数一条、12/13。
  - `checkPack` 补齐改坏的副本（47 → 59 种）：子字段 key 重复、单值子项写 `autoIndexKey`、子字段逐个写 `ITEM_UNSUPPORTED` 的六种配置（原来只有 `showWhen`）、子字段是 status 类型、`filterBy` 本实体没有、锁定组没写标签、阶段的 `branchOf` 指向自己、`recommend` 的条数写在按字符串存的多选 enum 上；另加 3 种照常通过的改法钉住「数组字段」的判定。`checkItem` 加金额 `min` 的两例（两个包都没用到，在副本上配）。
  - 设计系统 §6.3「节点里写什么」：原判定「`indexLabel` 展开后不超过 3 个字符」改为「只有字母和数字、不超过 3 个字符」。假包去掉空格后的「节点3」正好 3 个字符，按原判定要写进节点，与验收 5 和 L 页的「节点里只写序号」相悖；13 号的汉字一个就宽 13，直径 22 的节点也放不下。spec 顶部第 3.1 步那行 `Revisions:` 补记，验收 5 不改。没有改回带空格的「节点 {n}」：§2.5 与不变量 9 不许手打空格，第 3.3 步的检查也要扫假包。
  - 变异（隔离副本）：评审点名的 6 例加这次新写的规则共 23 例，全部失败并由具名断言点出（子字段 key 重复、单值子项 autoIndexKey、`ITEM_UNSUPPORTED` 整体只剩 showWhen 与逐个去掉六种、子字段 status、filterBy 本实体、锁定组 tag、金额 min、金额和 intUnit 去掉安全整数、安全整数写成 `isFinite`、编号说法去掉长度、条数一致回到只看负数、不看天数自己的问题、`branchOf` 指向自己、数组字段判定的三个分支）。另把 `checkPack` 里 39 处 `out.push` 逐处关掉，39 处全部由自测点名。
  - 新文案「数字太大」「最长64位」的字都已在 UI 优先片里，字体没重切；入口集合、换页、preload 字体的字节数不变（315,830 / 247,083 / 166,076 B）。
- 留给后面的步骤：
  - 第 11 步：节点里写什么按 §6.3 的新判定（只有字母和数字、不超过 3 个字符才写进节点），家装包的「节点3」节点里只写「3」。
  - 第 3.2 步：表单按 `FieldDef.key` 取值、写回，可以把 `pack.ts` 里的 `valueAt` 导出来共用（它只认自有属性，`$code` 取 id）；`storeAs` 的 `parse` / `format` 在那一步。`checkItem` 只要求按字符串存的餐食非空，规则之外的旧值照原文放过，与 spec「表单状态与提交」一致。
  - 第 3.3 步：产物里按文字查假包（第 2.4 步只按模块路径查）；`check-console-src.ts` 的行业包词汇扫描要把假包的实体、字段、阶段也算进去。
  - 第 10 步：副栏写「必须项{requiredPassed}/{requiredTotal}」。「第3天：当晚住宿没填」由 label 的后两段拼成；字段下方写「{字段标签}：{message}」。

### 第 3.4 步（2026-09-27）

- 做了什么：
  - `src/shared/ui-labels.ts`：`ROLE_LABEL` 与 `roleLabel()`（认不出的写「其他角色」）、话术检查项 `SOP_CHECK_LABEL` / `SOP_CHECKS`（`Record<ViolationCode, string>`，少一项 typecheck 报错）、`AUDIT_ACTIONS`（17 种动作的中文、类别、lucide 图标名）与 `auditAction()`、`auditGroups(pack)`（产品库那一类的名字取 `pack.nav.catalogGroup`，与侧栏分组名相同）、`auditActionsParam(类别, 显示登录记录)`、非人操作者的「命令行」「系统」、启动重渲染原因的中文，以及 `ERROR_COPY` 整张表（连同形式、颜色、按钮，一条记录不拆开）和 `NETWORK_COPY`、`FALLBACK_COPY`、按钮文字。`console/src/parts/errors.ts` 只留按错误挑文案的逻辑，原来的导出名照旧转出去，调用处没改。
  - `src/shared/format.ts`：`digits`、`money`（「42,800元」「13,800元/人」）、`quantity`；`relativeTime`（第 2.2 步的 `sinceText` 原样挪来，外壳的铃铛与 ⌘K 改用它）、`absoluteTime`（「9月26日 14:02」，跨年加年份）、`fullTime`（「2026-09-26 10:12:44」）、`dayTime`（时间线的「今天 13:40」）、`dayHeading`（K 页组标题「今天 · 9月26日 周六」的各段）、`dateText`、`weekday`、`dateWithWeekday`、`dayKey`；月份区间 `parseMonthRange`（能不能解析与 schema 共用 `src/shared/season.ts` 的 `bestSeasonParses`，`catalog.ts` 的 refine 改调它，规则不变）、`monthSegments`、`monthRangeText`（「5–10月」「4–6、9–11月」「11月–次年4月」「全年」取 `yearRoundLabel`）、`monthRangeSpoken`（读屏「5月到10月」）。时间都按本机时区，浏览器里就是看的人的时区。
  - `src/shared/audit-text.ts`：`describeAudit(entry | 一组, pack, lookups)` 返回操作者（`human` 为 false 时画方块图标）、句子各段（对象标 500）、`tail`（总览一行写完时的补充「的住宿档次、行程亮点」）、`summary`（K 页第二行「改了：住宿档次、行程亮点」）、整句、类别、图标、条数。实体名、字段名（diff 的顶层键按包里字段的顺序，`id` 是编号；嵌套对象比较 diff 里的 [原来, 现在]，只写真正变了的子字段，形状认不出才取第一个子字段的标签）、话术节名都取自传进来的包；对象名依次取 diff 里的新名字、`lookups.itemName`、编号。另有 `auditRuns` 合并连续同类记录。
  - `AuditQuery.actions` 按 spec 原文（正则、至多 32 个、与 `action` 同给 400）；`readAudit` 加一个数组参数 `action = any($1::text[])`，`listAudit` 与接口透传。
  - console 一侧：`shell/model.ts` 删掉 `ROLE_LABEL`、`sinceText`，`PageHeader`、`UserMenu`、`Bell`、`CommandPalette` 改取 `src/shared`；话术页的 7 个检查项取 `SOP_CHECKS`；审计页的动作下拉取 `AUDIT_ACTIONS` 的键（表按原来下拉的顺序排），操作者列的非人操作者取共用的 `ACTOR_KIND_LABEL`（整页第 14 步重做）。页面上的字只变了一处：没有名字的命令行操作者由「平台」改写「命令行」（设计系统 §11）。
- 自测：
  - `src/shared/format.selftest.ts`（48 条）与 `src/shared/audit-text.selftest.ts`（42 条）串进 `pnpm test`，排在 `src/shared/typography.selftest.ts` 之后，CI 注释同步。时区钉成 `Asia/Shanghai`，并断言它真的生效（UTC 16:00 是次日 0 点），CI 跑在 UTC 下也测得出按本地日历算。月份区间把 1–12 月的 4,096 种组合都切一遍：段展开正好是原来的月份、段是最长的、按起始月排、跨年段至多一个。审计句子用设计系统 §10.0 的 8 条（合并后）逐字比对，再拿同样的记录换一个改了名字的包，句子跟着换；每种动作的句子里，对象与版本号以外没有英文；diff 是 null、字符串、数组、类型不对时不抛。审计句子的测试用文件里的包夹具：`src/shared` 只能 import `src/shared`（check-boundaries）。
  - `shell.selftest.ts` 的 11 条相对时间挪进 `format.selftest.ts`，另加一条：审计动作的图标名都在 lucide-react 1.48.0 的图标表里（143 → 133 条）。
  - `console.selftest.ts` 268 → 276 条（原有断言一条没改）。验收 15 第 8 条：挑日志里稀疏的 `sop.discard,catalog.activate`（12 条，相邻两条之间最多隔 41 条别的），`limit=2` 逐页翻完，与全部记录里挑出来的逐条相同，除最后一页外每页都是 2 条；只给一个动作与 `action=` 结果相同；同给、大写、空项、空串、33 个、单项超过 64 个字符都 400，32 个 200。另有三条：`AUDIT_ACTIONS` 与 `src/` 里 `writeAudit` 写的 action 字面量逐个相同（不多不少）；「全部、不显示登录记录」换算出的请求等于全部记录去掉登录与退出；这一整轮写进库的真实审计记录（14 种动作）用真实的旅游包写成句子，每条都有类别，对象与版本号以外没有英文，没有「另N项」「另N节」。
- 字体：新文案让 check-fonts 报缺 14 个字（「账修初租设停移记」「三六」「命令求义」），重跑 `scripts/fonts/build.ts`（fonttools 4.66.0、brotli 1.2.0 装在仓库外的 venv 里；在仓库外的副本里跑，缓存不写进共用的 `node_modules/.cache`，用完删掉）。UI 优先片 754 → 768 个码位，154,088 → 157,280 B（+3,192），两个 preload 合计 169,164 B；两个 Geist 文件、许可原文逐字节不变；界面用字 586 个汉字。**与第 3.1–3.3 步合并时**，三个字体文件照旧会冲突，后合并的一方在合并结果上重跑 `build.ts`。
- 构建：入口集合 gzip 315,829 → 316,692 B（+863：`ui-labels.ts` 整个进了入口，因为 `errors.ts` 在入口里）；换页最多仍是产品库 247,076 B。
- 变异（仓库外的隔离副本，31 例全部失败并点名，还原后与 worktree 逐字节相同）：
  - 接口 7 例：库里不按 `actions` 过滤；接口不往下传；库里不过滤、取回来在 JS 里按页过滤（「翻页不出空页」点名，每页条数 0,0,0,0,0,2,…）；去掉互斥；放宽到 33 个；`AUDIT_ACTIONS` 少一种、多一种（源码扫描点名）。第一轮「JS 里过滤」的写法让空页抛 500，自测的翻页函数跟着抛，只崩不点名；翻页函数改成记下出错、由断言点名，变异也改成照常算 `nextBefore`，之后按名字失败。
  - 格式 8 例：千分位按四位分、金额与单位间加空格、「昨天」放宽到前天、日期不写年份、12 月不接 1 月、区间用连字符、时刻按 UTC、组标题没有「昨天」。
  - 审计句子与标签 14 例：字段按 diff 的键序、实体名写 kind、命令行写命令名、产品库字段写原名（两个自测都点名）、相隔正好 5 分钟不合、登录也合并、不看操作者也合并、动作表与角色按原型链查、不显示登录记录时也带登录、对象名先取缓存（补了「改了名写新名字」一条才拦得住）、检查项换顺序、话术节写 key、兜底句子带动作编码。
  - 另 2 例：图标名写错（shell 自测）；挪过去的错误文案改一个字（`errors.selftest.ts` 照旧对着 spec 的表逐条比）。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`，浅色、深色各一轮，探针在仓库外）：铃铛两行「8分钟前有新动静」「26分钟前有新动静」；用户菜单「老板 / 所有者」；⌘K 搜「d02」，会话行右侧「昨天21:40」；主管的「只读」胶囊悬停「你的角色是主管，只能查看」；话术页点「检查」列出 7 个检查项，「6/7通过」；审计页的动作下拉与原来相同；会话接口 500 时「没取到 · 服务暂时连不上」，服务端原文只在折叠的技术详情里。两套主题 `securitypolicyviolation` 都是 0 次，控制台错误 0 条。
- 取舍（spec 没写到的细节，spec 不改）：
  - 审计类别：销售话术是 `sop.*`；产品库是 `catalog.*`；账号与登录是 `auth.*` 和平台命令行的五种账号、成员操作；平台与配置是 `platform.tenant_create`、`config.import`。登录记录是 `auth.login`、`auth.logout`。
  - 「全部」且显示登录记录时不带 `actions`，表里还没有的新动作也列得出来；其余组合只列表里的动作，所以新动作在补进 `AUDIT_ACTIONS` 之前只在这一种组合下出现。`console.selftest.ts` 的源码扫描保证现有的每种动作都在表里。
  - 连续同类记录只合并产品库的四种动作（spec 说「同一实体」，实体是行业包的实体）；`describeAudit` 收一组时写「新建了6条酒店草稿」这类句子。合并本是第 14 步的事，总览（第 4 步）的「最近变更」同样要写这句（设计系统 A 页第 2 行），所以放在这一步。
  - 句子里操作者后面留一个空格（设计系统 A、K 页的写法，操作者与对象用 500），中文与数字、邮箱之间不留。
  - `AUDIT_ACTIONS` 里有 8 个图标不在设计系统 §7 的表里（`refresh-cw`、`log-in`、`user-plus`、`key-round`、`user-x`、`user-cog`、`user-minus`、`building`），§7 的表下补了一句。审计动作的图标不取实体图标集合里的名字：建租户原用 `building-2`，它在集合里，改用 `building`。表外的动作用 `circle-dashed`（§7 的「没跑」）。
  - 审计页现在的动作下拉仍把动作编码当选项显示（不变量 7 的「动作编码」），第 14 步换成类别筛选时去掉，这一步没动页面。
- 评审之后（同一分支，六条都改了）：
  - 数据如实：`auditFieldLabels(entity, diff)` 改收整个 diff。只改了 `intensity.hardest` 时原来写「体力强度」（第一个子字段），现在写「最累的一段」；新加、删掉嵌套对象时写它里面有的子字段；认得出形状、包里的子字段却都没变（只换了键序，或包外的子键变了）时不点名，算进「另N项」。
  - `toSorted` 不进 console 的包：Vite 8.3.1 默认构建目标含 Firefox 114，它没有 ES2023 的 `toSorted`。`format.ts`、`audit-text.ts` 改成在拷贝上 `sort`。`unicorn/no-array-sort` 原本会把 `sort` 报成警告（`--deny-warnings`），`.oxlintrc.json` 对 `console/src/**`、`src/shared/**`、`src/packs/*/console-pack.ts` 关掉它和 `no-array-reverse`，改用 `no-restricted-properties` 禁 `toSorted`、`toReversed`、`toSpliced`（自测照旧可用）。没有改 `build.target`。
  - 月份区间与 schema 同进退：「13月」「0月」「99月」这类只写越界月份的，schema 按 01 的规则（`peakMonths` 至少一个）放行，原来的 `parseMonthRange` 却返回 null，第 3.1 步的 `checkItem` 用它就过不了验收 15。现在判定取同一个 `bestSeasonParses`，越界月份不画（`months` 为空，文字写「—」）。没有收紧 schema：那是 01 已实现的规则，也会改变服务端对现有数据的校验。
  - `auditGroups(pack)` 取代写死「产品库」的 `AUDIT_GROUPS`；审计页下拉恢复原来的顺序；建租户的图标换成 `building`；审计页的操作者改用共用表。
  - 自测：`format.selftest.ts` 48 → 51 条（schema 夹具、12 种写法与 schema 逐个对照、越界月份的文字）；`audit-text.selftest.ts` 42 → 46 条（只改一个子字段、新加删掉、键序与包外子键、「只改了最累的一段」的整句、换包后类别名跟着换）；`shell.selftest.ts` 133 → 134 条（审计动作的图标与 24 个实体图标不重名）。
  - 变异（仓库外的隔离副本，10 例全部失败并点名，还原后与 worktree 逐字节相同）：嵌套字段总取第一个子字段、新加的对象认不出、包里子字段都没变时点名第一个、子路径多截一个字符、产品库类别写死、`parseMonthRange` 回到只认 1–12 月（第一轮在自测里的非空断言上崩了，改成空值安全的写法后按名字失败）、schema 收紧越界月份、只剩越界月份时写空串、建租户图标换回 `building-2`、`format.ts` 写回 `toSorted`（lint 点名）。
  - preview 实测（Chromium，CSP 同线上，接口由 `page.route` 拦截，浅色、深色各一轮）：审计页下拉用方向键走完 17 项，与原来的顺序逐项相同；操作者列「小林 / 命令行 / 系统」；`securitypolicyviolation` 0 次，控制台错误 0 条。入口集合 gzip 316,692 → 316,716 B，换页最多仍是产品库 247,054 B。
- 没有新增依赖。
- 留给后面的步骤：
  - 第 3.2 步：MonthStrip 用 `parseMonthRange` / `monthSegments` / `monthRangeText` / `monthRangeSpoken`，金额与带单位的整数用 `money` / `quantity`。`months` 可能为空（只写了越界月份），这时不画任何月份，文字写「—」。
  - 第 3.1 步：`checkItem` 的「月份区间能解析」用 `parseMonthRange(text) !== null`，与 schema 同进退。
  - 第 4 步：「最近变更」请求 `auditActionsParam('all', false)`，`auditRuns` 合并后 `describeAudit(run, pack, lookups).text`，时间列 `dayTime` 与 `clockTime`；状态句的日期 `dateWithWeekday`。
  - 第 13 步：「最后动静」用 `relativeTime`，悬停 `absoluteTime`。
  - 第 14 步：类别筛选用 `auditGroups(pack)`；图标名到 lucide 组件的映射（名字在 `AUDIT_ACTIONS`）；`lookups.itemName` 从 `queries.ts` 的产品库缓存取；组标题 `dayHeading`，详情抽屉 `fullTime`、`money`；`sop.rollback` 的 `sameHashAsTarget` 提示仍按 spec 写在抽屉里。

### 第 3.2 步（2026-09-27）

- 合并：分支从 `dev` 起，先后合入第 3.1、3.4 步。三个字体文件冲突，在合并结果上重跑 `build.ts`（769 个码位、157,444 B）；`package.json` 的 `test` 取两边的并集；本文件两边的记录都留。两步给同一个月份判定各起了名字（第 3.1 步的 `monthsReadable`、第 3.4 步的 `bestSeasonParses`），`season.ts` 留一份实现、另一个名字是它的别名，调用处都没改。合并后 `shell/icons.tsx` 的 `ENTITY_ICON_NAMES` 仍指着第 3.4 步那边的旧表名，typecheck 报错，改成 `ENTITY_ICON_COMPONENTS`，并进合并提交。合并结果四道门禁都过。
- 做了什么（都在 `console/src/fields/`）：
  - `model.ts`，纯逻辑、不依赖 React：表单状态 `formState`（`structuredClone`，保留键序）；`readValue` 与上架前检查同一个 `valueAt`（`src/shared/pack.ts` 导出了它和 `filled`）；`writeValue` 按 spec「表单状态与提交」写回：选填清空删键，必填清空留空串或空数组，删空的嵌套对象连对象删，以它为 `showWhen` 的字段跟着删（评审之后改成留在表单状态里、提交时剔除，见下），所以体力强度选「不填」时整个 `intensity` 进 `unset`；`submission` 用 01 的 `sameValue` 比顶层键，算 `set` / `unset`。`parseStored` / `formatStored`：只认 `formatStored` 写得出的写法，所以 `format(parse(x)) === x`；写回按选项排，规则之外的旧值原样保留。控件读写表 `CODECS` 与网格规则表 `LAYOUT` 也是 `Record<FieldType, …>`。另有 `fieldMode`（edit / locked / readonly）、`lockedMembers`、`locksOnActivate`、`groupGrid`（4 列规则）、`enumControl`（5 / 6 项的界线）、`keepLockedMembers`、`moveItem`、`togglePick`，以及引用候选 `refItemsOf` / `resolveRef`。
  - `renderers.tsx`：`RENDERERS: Record<FieldType, FieldRenderer>`，每种字段类型有 `Cell`、`View`、`Form` 三种形态（不变量 12）。另有 `MonthStrip.tsx`（S、L 两号，只用 class）、`FormField.tsx`（标签、「（选填）」、锁、帮助与报错）、`FieldGrid.tsx`（一张分组卡片的卡片体）、`env.ts`（页面给渲染器的当前时刻、引用候选、联想和链接）和 `fields.css`。
  - 实体图标映射：第 2.2 步已经放在 `shell/icons.tsx`，第 3.1 步换成了 `EntityIcon` 键。本步只在自测里核对两个包的实体图标都画得出来，集合里只有 `box` 落到兜底。
  - 样张 `/_specimen/fields?kind&code&as&theme`（只在 `VITE_SPECIMEN=1` 时注册）：经 `/pack` 与列表接口认识行业包，画列表单元格和各分组的表单网格，页面上实时写出补丁（「改动：无」）与上架前检查的计数。spec 的路由表加一行，顶部加 `Revisions:`。
  - `scripts/check-boundaries.ts`：`console/src` 里只有 `fields.selftest.tsx` 能 import `src/packs/registry.ts` 和 `src/shared/pack-fixtures/`。注册表本来就在 `src/shared` 之外、被拦着，这里是开例外；假包原来对 `console/src` 全放开，现在别的文件 import 它也报。
  - `fields.selftest.tsx`（963 条，约 2 秒）串进 `pnpm test`，排在 `shell.selftest.ts` 之后，CI 注释同步。
- 自测覆盖：
  - 三张表的键正好是 11 种字段类型；两个包合起来用到全部 11 种。
  - 不变量 16：data/ 下 20 条线路（加 r-guizhou-5d）、23 家酒店和假包的 9 条样例，打开不改时补丁为空。每个字段（含有序子项的子字段）经控件读出、原样写回，值不变，补丁仍为空，序列化逐字节相同。餐食的 6 种写法都满足 `format(parse(x)) === x`；7 种规则之外的写法认不出，原样往返。
  - 写回规则逐条核对。锁定与只读的四种上下文。4 列只给整卡只读（评审之后改为整卡锁定）、3 个及以上的 text / intUnit / money / 单选 enum，多一个是否、多选 enum、长文本或单选引用就是两列。
  - 两个包每个字段、子字段的三种形态都画一遍，共 189 项（63 个字段与子字段乘三种形态），画了 812 次，约 0.15 秒；空值的表单也画一遍，都不许在画的时候写值。另逐类型核对写法，例如月份条逐格的 class、分段控件选中哪一段、多选片的 `aria-pressed`、标签的锁与删除按钮、时间轴节点、引用的「草稿」，以及 label 与控件怎么连（下拉用 `for`，分段控件用 `aria-labelledby`）。
- 字体：新文案「这里的写法不标准」「添加一条」带进「准添」，重跑 `build.ts`（fonttools 4.66.0、brotli 1.2.0，仓库外的 venv）。UI 优先片 769 → 771 个码位，157,444 → 157,920 B（+476），两个 preload 合计 169,804 B。两个 Geist 文件、许可原文逐字节不变。
- 构建：渲染器还没接进产品页，生产产物里没有它们。入口集合 gzip 316,719 B，与合并后相同；换页最多仍是产品库，247,051 B（+1，字体文件名变了）。`fields.css` 现在只由样张引用。
- preview 实测（`VITE_SPECIMEN=1` 构建，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`；7 个场景，浅色、深色各一轮，探针在仓库外）：
  - 已上架 r-sichuan-lux 的「基本信息」4 列，宽 169 / 247 / 110 / 97（设计系统 E 页记的是 178 / 244 / 108 / 95），线路名称没有截断。没有编辑权限时同样 4 列；主材只读 4 列，宽 182 / 187 / 128 / 128（这两处评审之后改为两列）；草稿、新建、酒店已上架都是两列。
  - 只读值的计算颜色等于 `--text`，标签等于 `--text-2`（不变量 5）。混合卡「适合谁去」挂 3 把锁；草稿标 3 处「上架后锁定」。
  - 字号只有 12.5、13、14、15、16，字重只有 400、500、600（不变量 10）；1440 宽没有横向滚动。
  - 交互后补丁都回到「改动：无」：草稿里点一片餐食（「改动：itinerary」）再点回来；住宿档次敲一个字再删掉；体力强度选「较累」（「改动：intensity」，最累的一段显示出来，必须项 13/14）再选「不填」；行程亮点下移再上移。第一条的「上移」是 `aria-disabled`。新建时必填的境内 / 境外一段都不选，点了「境外」后是「改动：overseas」。
  - Chromium、Firefox 两套主题 `securitypolicyviolation` 都是 0 次，控制台错误 0 条。WebKit 在加载、交互、文本域增高各阶段都是 0 次；探针截图时每截一张记一条 style-src 违规（Playwright 截图注入的样式），与页面无关。
  - 第一轮走查发现 antd TextArea 的 `autoSize` 在页面 CSP 下失效：它量高度时对隐藏的 textarea 调 `setAttribute('style', …)`，被 style-src 拦下，每页一条违规，隐藏的 textarea 留在页面底上。改成渲染器自己按 `scrollHeight` 经 CSSOM 写 `style.height`（3–12 行，不给手动拖）。实测 82 → 280（12 行，出现滚动条）→ 82 px。自测加了一条「渲染器不用 autoSize」。
- 变异（仓库外的隔离副本，46 例，还原后与 worktree 逐字节相同）：45 例失败并由具名断言点出，1 例是等价变异。
  - 表与读写 13 例：渲染器表少一种（typecheck 与自测都点名）、多选片按点选顺序写回、`parseStored` 不查写法、一项都不选写空串、选填清空不删键、必填清空也删键、删空的对象留着、`showWhen` 的字段不跟着删、补丁用 `!==` 比、打开时按键排序、金额清空写 0、storeAs 不格式化。
  - 锁定与网格 12 例：编号在草稿里可改、没有编辑权限也按锁定算、2 个短值也排 4 列、有输入框也排 4 列、是否也算短值、没有编辑权限也锁成员、已上架也标「上架后锁定」、5 / 6 项界线各挪一格、锁住的成员删得掉或加得上、第一项还能上移。
  - 渲染 17 例：月份条 12 月接 1 月、不标当前月、「全年」不用行业包的写法、月份说明丢掉、选填单选没有「不填」、必填是否默认选中、多选片取消不了、标签单元格不限 3 个、引用草稿不跟「草稿」、节点里总写完整标签、金额单元格总带单位、换回 `autoSize`、表单画的时候写值、只读也写帮助、只读也标「（选填）」、整卡锁定也挂锁、实体图标落到兜底。
  - 边界 4 例：拿掉渲染器自测的例外、别的 console 文件 import 注册表、别的 console 文件 import 假包，这三例 lint 都点名文件与行。「假包那条规则谁也不管」在干净的树上是等价变异，要有违规的 import 才看得出；上一例就是这种 import，照常被拦。
  - 第一轮有 3 例存活，都补了断言：「全年」的文字在 aria-label 里也有，改成查文字那一格；多选片的点选只在组件里，抽成 `togglePick` 再测；逐字段画的时候值都有，空值的表单没画过，所以补画了一遍。另有 1 例是崩掉的：渲染器表少一种时，自测在后面逐字段画的时候抛错，没点名。改成先报「键正好是 11 种」再退出。
- 偏离与取舍：
  - 文本域不用 antd 的 `autoSize`（见上），高度由渲染器算。
  - 4 列原先按设计系统 §6.4「全是只读的」算，没有编辑权限的只读卡也排 4 列。评审指出 spec 与开放问题 9（owner 已定）都是「整卡锁定」，§6.4 那句也写在「整卡锁定」的条件下面，改回 spec，Open 里那条删掉。
  - 必填的是否是两段分段控件，先 `falseLabel` 后 `trueLabel`（「境内 / 境外」，与验收 16 的写法一致）；设计系统没定顺序。
  - 只读形态不写帮助，也不标「（选填）」：它们是填写的指引。
  - 月份区间的表单自己报「没认出月份：写成…」（设计系统 §6 表）。第 10.2 步把 `checkItem` 的同一个问题落到字段下方时，这个字段不要再写一遍。
  - 金额单元格：单位是固定的（`unit`）时只写数，单位写在表头；单位取另一个字段（`unitFrom`）时每行的单位不同，表头写不了，数后面带单位。
  - 引用名称的链接由页面经 `env.itemLink` 给（详情路由在第 10.1 步），没给时是纯文本。
  - 第 2.2 步记的「Alert 等部件里的 `@ant-design/icons` 留给第 3.2 步一起换」没做：它不在本步的条目里，还会动入口集合和产品库换页（余 2,949 B）的预算。改留给第 10 步（`CheckList` 随详情页重做）与第 16 步（`ThemeProvider` 的 Alert 图标、`TechDetails`）。
- 没有新增运行时依赖（评审之后加了开发依赖 happy-dom，见下）。
- 留给后面的步骤：
  - 第 9、10 步：由 `main.tsx` 全局引 `fields.css`（与 `parts.css` 一样；渲染器本身不 import CSS，自测才能在 Node 里 import）。列表用 `RENDERERS[type].Cell`，首列两行、`$updated` 列、表头单位（`FieldDef.unit`）归列表页。详情用 `FieldGrid`：卡片头的锁定 Tag 与原因由页面画，说明的 id 传给 `lockNoteId`；`errors` 按 `FieldDef.key` 给；`env.itemLink` 给路由的 `Link`；`env.distinct` 从列表缓存取。提交用 `submission(original, state)`。
  - 第 11 步：多字段的有序子项现在只能改每一项的文字。竖轴与节点状态、条数提醒、增删与上移下移（`moveItem` 已有）、`autoIndexKey` 重排、条数锁定、「复制上一天的…」、引用的分组联想与 `filterBy`、`allowFree` 的提示、长文本 `softMax` 的提示都在第 11 步。新建时多字段的有序子项还没有「添加一天」。G 页要求卡片第一行是「当天标题、当晚住宿」，现在子字段按包里的顺序排（标题、安排、住宿、餐食），第 11 步排卡片时处理。
  - 第 3.3 步：「别的 console 文件不能 import 假包」已随例外一起加了；两边都改这条规则时，按本步的写法合并（`PACK_SELFTEST` 与 `PACK_FIXTURES` 两个常量）。
- 评审之后（10 条意见，全部接受）：
  - 4 列只给整卡锁定的卡片：`groupGrid` 从「没有输入框」改为 `c.mode === 'locked'`。没有编辑权限、匿名看到的只读卡回到两列，自测里两条对应断言改成两列。spec 不改，plan「Open」的那条删掉。
  - showWhen：体力强度误点「不填」再选回来，「最累的一段」原文不再丢失。`writeValue` 不再连带删依赖字段，值留在表单状态里、不显示；新加的 `pruneHidden` 在 `submission(original, state, fields)` 里剔除不显示的字段，所以「不填」时整个 `intensity` 仍进 `unset`，选回原值后补丁为空。`checkItem` 本来就不查不显示的字段。
  - 选填的是否：由开关改为三段的分段控件「不填 / 否 / 是」，与选填的单选 enum 一致。开关表示不了没填：旁边的文字只能写 `falseLabel`，打开再关上写成 `false`，回不到删键。spec 顶部加 `Revisions:`，设计系统 §6 表同步修改；两个包里现在没有选填的是否。
  - 状态渲染器只认 `draft`、`active`，别的值（匿名投影里没有状态，是 undefined）写「—」，原来画成「草稿」。样张页在匿名数据下不画状态、更新两列（spec「产品库列表」的匿名一行）。
  - 无障碍：月份认不出时输入框设 `aria-invalid`，报错的 id 拼进 `aria-describedby`，和字段下方的帮助写在一起；「这里的写法不标准」同样连到输入框。
  - 文本域增高：原来只在文字变化时量高度，现在宽度变化（容器变窄、挂载时看不见）和 `document.fonts.ready` 之后也会重量。`ResizeObserver` 只看宽度，改高度放到下一帧做；在回调里直接改的话，WebKit 报「ResizeObserver loop completed with undelivered notifications」（第一轮走查发现）。
  - 控件的值到存储值：抽出 `enumFromSegment`、`boolSegment`、`boolFromSegment`、`replaceAt`、`removeAt` 放进 `model.ts`，组件只调用它们，自测逐个断言。
  - 自测在 DOM 里挂载（第 7 节）：新增开发依赖 `happy-dom` 20.14.5（MIT，只是 DOM 实现，不是测试框架；console 的 devDependencies，锁文件另外带进 whatwg-mimetype、ws、entities、buffer-image-size 和两个类型包；生产产物不含）。`console/src/fields/selftest-dom.ts` 是 `fields.selftest.tsx` 的第一个 import：antd 与 rc 组件在模块加载时判断有没有 DOM，DOM 装晚了，挂载后的输入框收不到 input 事件（原型实测）。有了 DOM 之后，前 6 节的 SSR 断言照常通过。
    - 7.1：两个包 63 个字段、子字段的表单形态各挂载两次（有值一次、空值一次）。effect、挂载时排下的定时器和 requestAnimationFrame 都跑完后，写回次数为 0；8 种条目和上下文组合的每张分组卡片也一样。这一节约 0.9 秒。
    - 7.2：经组件点击、输入、删除，逐项核对写回的表单状态和补丁：体力强度的「不填」与选回来、境内境外、选填是否的「不填」；标签按退格删不掉锁住的「国内」、点「删除贵州」、敲「国内，」加不上；行程亮点按下标修改、上移、删除、添加；第 2 天的餐食片和住宿自由输入只动第 2 天；节点3 删掉唯一的主材（选填清空，删键，不留 `[]`）、改节点2 的名称；套餐主材删掉一个芯片。
  - 边界：`config.selftest.ts` 的 check-boundaries 夹具补了三种情况：渲染器自测 import 注册表和假包不报；它直接 import `src/packs/travel/console-pack.ts` 要报；别的 console 文件 import 注册表、旅游包、假包都要报。
  - 自测不再写死 data/ 的条数和餐食写法的种数，只打印出来；每种现有写法仍逐个核对 `format(parse(x)) === x`。
  - 数字：`fields.selftest.tsx` 从 963 条增加到 1018 条，用时约 4 秒（原来约 2 秒，多出的时间主要花在挂载后等定时器）。`config.selftest.ts` 多 2 条，共 448 条。UI 字体子集没有变化（771 个码位、157,920 B），没有新文案要收字。产物：入口集合 316,719 B，换页最多 247,051 B，都与评审前相同。
  - 变异：在仓库外的隔离副本里做了 30 例，全部由具名断言点出；还原后与 worktree 逐字节相同。评审点名的 7 例组件接线全在其中：分段控件「不填」写成 `$none`、是否的段值反着解析、标签绕过 `keepLockedMembers`、子项用展开代替 `writeValue`、删除总删第 1 条、修改总写第 1 条、引用下拉不写回。另有挂载时在 layout effect 里写值、挂载后在定时器里写值；把 4 列放宽回「没有输入框」；状态把别的值画成草稿或已上架；提交时不剔除不显示的字段、`pruneHidden` 不删、写回时连带删依赖字段；月份报错不标 `aria-invalid`、不接进 `aria-describedby`、写法提示不连控件；五个纯函数各改坏一处；选填是否少了「不填」段；多选片按点选顺序追加；引用自由输入写空串。边界 3 例（由 `config.selftest.ts` 点名）：例外放宽到所有 console 文件；自测可以直接 import 各个包；假包那条规则谁也不管。
  - preview 走查（`VITE_SPECIMEN=1` 构建，CSP 与线上相同，7 个场景，浅色、深色，Chromium、Firefox、WebKit，探针在仓库外）：
    - E 页「基本信息」仍是 4 列，宽 169 / 247 / 110 / 97。没有编辑权限的线路和主材「基本信息」是两列。
    - 体力强度点「不填」后显示「改动：-intensity」，选回「较累」后回到「改动：无」，最累的一段原文还在。
    - 文本域在 662 宽时高 82，把主栏收到 420 宽后是 126，放回原宽又是 82；每次 `scrollHeight` 都等于 `clientHeight`，内容没有被裁掉。
    - 月份写「旺季」时 `aria-invalid="true"`，读屏读到的说明就是那句报错。
    - 把旅游包的「境内还是境外」临时改成选填：显示三段，没填时选中「不填」；点「境外」后显示「改动：overseas」，点回「不填」后显示「改动：无」。
    - 匿名数据的列表没有「状态」「更新」两列，也没有状态胶囊。
    - Chromium、Firefox 的 CSP 违规和控制台错误都是 0。WebKit 截图之前也都是 0；截图时每截一张记一条 style-src 违规，与第 3.2 步记的相同，是探针的问题。

### 第 3.3 步（2026-09-28）

- 做了什么：
  - `scripts/check-boundaries.ts`（不变量 11 第一层）：第 3.2 步已经加了渲染器自测的例外和「别的 console 文件不能 import 假包」。这一步把 `src/packs/**` 单拆成一条写明不变量 11 的规则（只有渲染器自测能 import `src/packs/registry.ts`，`import type` 也算），console 的通用规则不再对行业包重复报，一处 import 只报一行。另加一条：`src/` 里的非自测代码不能 import 假包。console 可以 import `src/shared/`，假包经 `src/shared` 转一手就能进 console 和构建产物；假包目录自己和各处自测不管。`config.selftest.ts` 的边界夹具 448 → 451 条：`import type` 旅游包、三种 import 各报一次并写明不变量 11、`src/shared/leak.ts` 被拦而假包目录与自测不拦。
  - `scripts/check-console-src.ts` 的词汇扫描（不变量 11 第二层）：词表取自本仓库的注册表和 `src/shared/pack-fixtures/` 下导出的每个包（自测夹具也用这份真词表）。收实体 kind、实体名、工具原名、字段 key（含有序子项的子字段，带点的 key 另算每一段）、字段标签、阶段 key，现在 126 个词。扫 `console/src` 的字符串字面量（含类型位置和带引号的属性名）、模板字符串的各个文字段、JSX 文本，去掉首尾空白后整串比对；不扫注释、标识符、模块名（import、export、`import()`、`require`、类型位置的 `import()`、`declare module`）、自测和样张。排除 `$` 开头的系统字段 key、会话状态值 `ai` / `human` / `paid`、`GENERIC` 里的 5 个通用词（`title`、`name`、`tags`、「状态」「标签」，每项写明理由），以及 `LEGACY` 里旧页面的几处（见「偏离」）。报错写明是哪个包的什么，如「写死了行业包的词「quote」（旅游包的阶段 key、家装整装包（假包）的阶段 key）」。`GENERIC` 里的词不再是任何包的词、`LEGACY` 里的词在那个文件里没了，都让 `pnpm lint` 失败并要求删掉这一项；词表里没有注册包或没有假包也失败。
  - 不变量 17 的 console 一侧，同一个脚本：读 `handedOver`（`.handedOver`、`?.handedOver`、解构，以及按名字引用的字符串 `'handedOver'`，覆盖 `r['handedOver']`、表格的 `dataIndex`、`Pick<…>`）；`stage` 与 `'paid'` 相比（`===` `!==` `==` `!=`，左右都认，去掉括号、`!`、`as`、`satisfies`；`switch (….stage)` 里的 `case 'paid'`）。自测和样张同样查。
  - 挂上以后现有代码的命中：会话页 `dataIndex: 'handedOver'` 与 `r.stage === 'paid'` 两处（不变量 17）；产品库页「线路」「酒店」`route`「目的地」，`router.tsx` 的 `route`、`hotel`（进 `LEGACY`）；渲染器的 `'tags'`（字段类型名）与产品库页的「状态」列（进 `GENERIC`）；`Status.tsx` 的 `'paid'`（会话状态值）。
  - 会话页：「转人工」一列改为「状态」，每行 `<Status kind={conversationState(r)} />`，与 spec I 页的列一致，整页仍在第 13 步重做。原来没转人工的行这一列是空的，现在写「AI接待中」；转人工后成交与没转人工成交都写「已成交」。
  - 假包的界面配置也查不变量 9（第 3.1 步记的「第 3.3 步的检查也要扫假包」）；话术节 heading 的例外同样适用。
  - `scripts/check-console-dist.ts` 按文字查假包（不变量 25）：每个 JS 块用 TypeScript 的解析器读一遍，取出全部字符串字面量与模板字符串文字段（转义已解开），与假包的标记串整串比对。标记串是假包配置里的全部字符串值，去掉注册包里也有的、不到 3 个字符的、纯小写英文单词，现在 67 个，产物 JS 里共 10,516 个字符串。另要求在产物里找得到「等人接手」，证明字符串确实取出来了。压缩器把中文字符串写成反引号模板（如 `` n:`等人接手` ``），按引号找的正则会整个漏掉。这条检查连同原有的全部检查约 0.7 秒。CI 注释同步。
  - `scripts/check-console-src.selftest.ts` 48 → 91 条：不变量 11 的 20 处违规（注册包与假包各类词、带点 key 的一段、子字段、类型位置、带引号的属性名、模板文字段、首尾带空白、旧页面名单以外的文件），不变量 17 的 10 处（含自测文件），假包的不变量 9 一处；放过的写法（注释、标识符、子串、四种模块名、系统字段、会话状态值、通用词、样张、自测、行业包配置，只经 `conversationState` 判定、造数据时写 `handedOver`、别的值和 `'paid'` 比）；旧页面名单另跑两轮：同一个文件里名单外的「主材」照报，词没了、文件删了都点名为过时。
- 构建：入口集合 gzip 316,719 → 316,787 B（+68：`src/shared/conversation.ts` 本来就在入口里，`conversationState` 原先没人用、被摇掉了）；换页最多仍是产品库，247,051 → 247,076 B（+25，引用的块文件名变了），余 2,924 B。字体没变（771 个码位、157,920 B），「状态」两个字早在 UI 优先片里。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30，浅色、深色各一轮，探针在仓库外）：会话表头是「会话 渠道 阶段 状态 消息数 更新时间」；五行覆盖四种组合：转人工没成交的两行是「等人接手」胶囊（浅色 `#FFF3DC`、深色 `#2E2008` 底，与设计系统 §1.1 的 `--warning-bg` 相同），转人工后成交与没转人工成交都是「已成交」，其余是「AI接待中」，标签 13/500；页面上没有「转人工」三个字。两套主题 `securitypolicyviolation` 0 次，控制台错误 0 条。
- 变异（仓库外的隔离副本，60 例全部失败并点名，还原后与 worktree 逐字节相同）：
  - 真代码 15 例：会话页改回读 `handedOver` 与比 `'paid'`（两处都点名）、外壳搜索占位写死「线路」、产品库页多写一个名单外的「每晚起价」、渲染器按 `'itinerary'` 分支、外壳写假包的「施工节点」、会话页按 `'quote'` 分支、铃铛解构 `handedOver`、`switch (row.stage)` 的 `case 'paid'`；`import type` 旅游包、外壳 import 注册表、另一个 console 自测 import 假包、`ui-labels.ts` 转手导出假包、服务端启动装载 import 假包（后五例 `check-boundaries.ts` 点名）；`GENERIC` 多一个不撞词的「名称」、`LEGACY` 多放一个文件里没有的 `hotel`（点名要删）。
  - 词汇扫描与不变量 17 的实现 34 例，由 `check-console-src.selftest.ts` 点名：词表逐类去掉（假包、工具、阶段、带点 key 的段、子字段、标签、实体名）；不扫 JSX 文本、不扫模板文字段；比子串、不去空白；不排除会话状态值、通用词；系统字段 key 进词表；旧页面名单不分文件、放过整个文件、不查过时；词汇扫描也查自测、样张、行业包配置；模块名（整体、动态 import、类型位置）也按词表查；17 的属性访问、解构、按名字的字符串、左右颠倒、去括号与 as、`==`、`case`、自测豁免、任何东西和 `'paid'` 比都算；假包不查不变量 9、假包的 heading 不放过。第一轮「也查行业包配置」存活：变异脚本对同一个文件的两处改动都从原件改起，后一处覆盖了前一处；修好脚本后按名字失败。
  - 边界规则 6 例，由 `config.selftest.ts` 点名：去掉 `src/` 的假包规则、它不放过假包目录、不放过自测、console 通用规则对行业包重复报、`import type` 放过、渲染器自测能 import 任何包模块。
  - 产物检查 5 例：假包整份抄进 `console/src/reno.ts` 由入口引用（模块清单看不见，按文字点名「装修套餐」）；只漏一个「家装整装」；标记串一个都不收（点名「检查是空的」）；取字符串时用源码原文、不解开引号；只取引号字符串。第一轮的「只认模板字符串」无效：副本里的产物还是上一例的构建，而且压缩后的中文本来就在反引号里，所以换成了后两例。
  - 标记串的三个过滤在干净的产物上各试了一遍：不去纯小写单词，`styles` 误报；不去注册包里也有的，`$code` 误报；放宽到 2 个字符，现在不误报，留着 3 是防「业主」「方案」这类常用词以后成了界面文字。
- 偏离与取舍：
  - 旧页面名单 `LEGACY`（spec 顶部第 3.3 步的 `Revisions:`）：产品库页和它的路由参数按线路、酒店写死，第 9、10 步整页重做；现在改等于提前做一半，还会改变打不开的 kind 的行为。按「文件 + 词」放行，词没了就要删，第 9、10 步做完时名单必然清空。
  - 比原文严的两处（同一行 `Revisions:`）：假包也查不变量 9；`src/` 里的非自测代码不能 import 假包。
  - 词表的口径：带点的 key 另算每一段（`intensity`、`level`、`hardest`），console 写 `'intensity'` 同样是认得行业包；`$` 开头的只排除 key，它们的标签照算（「线路编号」算，「状态」进 `GENERIC`）；阶段的中文名、工具的中文名、分组名、`sopFields` 的键不在不变量 11 的清单里，不收。spec 举例的 `id` 没进 `GENERIC`：它不是任何包的词，按过时规则会被要求删掉。
  - 不变量 17 连自测和样张一起查（验收 3 写的是「`console/src` 里」）；造测试数据时写 `handedOver: true` 不算读。
  - 会话页的「转人工」列换成「状态」列（见上），不是等第 13 步：不这样改，不变量 17 的检查挂不上。
- 没有新增依赖。worktree 里的依赖用 `pnpm install --frozen-lockfile` 装（主工作区的 `node_modules` 没有第 3.2 步加的 `happy-dom`），锁文件没变。
- 留给后面的步骤：
  - 第 9、10 步：路由参数按行业包的 kind 取、产品库页重做以后，删掉 `LEGACY` 的两项（不删 `pnpm lint` 失败）。页面要显示字段名、实体名时从 `/pack` 取，不能写死；真要一个撞上包词的通用词，加进 `GENERIC` 并写明理由。
  - 第 13 步：会话页的「状态」列已经用 `conversationState`，阶段名已经取自 `/pack`；页签、阶段条、徽标照样不读 `handedOver`，也不写阶段名表。
  - 第 17.1 步：往假包里加字段，词表和产物的标记串自动跟着变；新字符串要是撞上界面自己的字，`check-console-dist.ts` 会点名，按那条的过滤规则处理。
- 评审之后（同日）：
  - 会话页写死的阶段名表 `STAGE_LABEL`（键是旅游包的阶段 key，不带引号，所以词汇扫描看不见）删掉，阶段名改从 `usePack()` 的 `stages` 取；`handoff` 仍写「—」，包里没有的阶段照写原值。旅游包的显示逐字不变，假包的租户看到的是「咨询」「量房」「已付定金」，不再是原始 key。
  - 词汇扫描加上对象字面量里不带引号的属性名（含简写），与带引号的键一样算；类成员名、类型里的成员名、属性访问、解构、JSX 属性名仍不扫。在现有代码上多撞出：`parts/toast.tsx` 的 `duration`、`theme/ThemeProvider.tsx` 的 `styles`（antd 配置键，进 `GENERIC`）；`shell/icons.tsx` 图标表的键 `route`、`package`（设计系统 §7 的图标名）；产品库页的 `hotel`、`detail`（进 `LEGACY`）。`GENERIC` 的项可以写 `only` 限定文件，图标名只在 `icons.tsx` 里放过，别处的 `route` 照报；限定文件的项在那些文件里都没了，`pnpm lint` 同样要求删掉。
  - 不变量 17 的 console 一侧认得存着 stage 的名字（`const s = r.stage`、`const { stage: s } = r`、表格列 `{ dataIndex: 'stage', render: (s) => … }` 的参数，可以接力）、值是 `'paid'` 的常量、`['paid'].includes(stage)` / `indexOf` / `new Set(['paid']).has(stage)`（数组与 Set 存进常量也算）。名字按声明所在的块、函数算，另一个函数里同名的 `s` 不算。查不到的写在脚本开头：别的文件 import 来的常量、对象查表 `{ paid: … }[stage]`、把 stage 传进别的函数再比。
  - `check-console-dist.ts` 加正对照：把全部标记串轮流按 `"…"`、`` `…` ``、插值之间的文字段拼成一段假块，用同一套取法和比对（`jsStrings`、`fakeHitsIn`）要全部找出来，现在 67/67。评审给的变异（比对时给标记串加 `\0`）原先照样通过，现在点名「只找出 0 个」。
  - 模块名不扫、对象键要扫，这两处与不变量 11 原文的出入写进 spec 顶部第 3.3 步评审之后的 `Revisions:`。
  - `check-console-src.selftest.ts` 91 → 108 条：不变量 11 加不带引号的键、假包的键、简写、限定文件的通用词写在别的文件共 4 处违规，不变量 17 加别名、别名接力、解构别名、常量、includes、indexOf、Set、数组常量、表格列 render、别名加常量的 switch 共 10 处；放过的写法加变量名与 JSX 属性名、类方法名、`duration` / `styles`、另一个函数里的同名参数、和 stage 以外的东西比的 `'paid'` 常量与数组、别的列的 render、图标表；限定文件的通用词过时与不过时各一条。
  - 构建：入口集合 gzip 316,787 → 316,791 B，换页最多仍是产品库 247,077 B（余 2,923 B）；产物 JS 里的字符串 10,516 → 10,510（阶段名表的键值没了）。
  - preview 实测（Chromium，同上一轮的探针加阶段列与假包两轮，CSP 同线上，接口由 `page.route` 拦截）：旅游包浅色、深色的阶段列是「— 报价 已支付 已支付 促成」，状态列与上一轮相同；假包浅色、深色是「咨询 量房 — 已付定金 mystery」。四轮 `securitypolicyviolation` 0 次，控制台错误 0 条。假包终点阶段 `deposit` 的状态是「AI接待中」：`conversationState` 按 spec「接口改动」只认 `stage === 'paid'`，与本步无关，第 17 步假包走查时留意。
  - 变异（仓库外的隔离副本，34 例全部失败并点名，还原后与 worktree 逐字节相同）：检查脚本 24 例由自测或 `pnpm lint` 点名（不扫对象键、类成员也扫、限定文件的通用词当全局、不记用过、不查过时、不收别名、作用范围当整个文件、不看作用范围、不认常量、不认数组、不认 Set、不认数组常量、成员判断不看参数、不做成员判断、不认 render 参数、任何列的 render 都认、不认解构别名、不能接力、`===` 与 `case` 只认字面量、`LEGACY` 少 `hotel` `detail`、`GENERIC` 少 `duration` `styles`、图标名限定到别的文件）；真代码 5 例（会话页加回阶段名表、stage 列 render 里比 `'paid'` 与 `['paid'].includes`、`new Set(['paid']).has(r.stage)`、外壳写一个简写键 `{ deposit }`）；产物检查 5 例由正对照点名（评审给的 `\0`、比对恒空、不取插值之间的文字段、只取模板字符串、取源码原文）。第一轮「stage 列 render 里 includes」存活，是变异本身引用了没声明的常量，改成字面量数组后失败。

### 第 4 步（2026-09-28）

- 做了什么：
  - 路由 `/` 是总览（`pages/overview.lazy.tsx`，懒加载），取代跳到 `/sop` 的重定向；侧栏第一项「总览」（`layout-dashboard`），「没有这个页面」的链接改回总览。
  - `console/src/overview/`：`model.ts` 是纯逻辑（待办行、系统状态、四个业务数、阶段条、最近变更的时间线），`queries.ts` 是总览自己的查询（`/sop` 与话术页共用 `['sop']`，草稿检查按草稿与 `rev` 缓存，`/status`，最近一个已成交，最近变更），`OverviewPage.tsx` 五块各自取数、各自骨架、各自出错，`overview.css` 照设计系统 §5.10、§5.11、§6.7。实体、图标、阶段、话术节、叫法都取自行业包；会话状态只经 `conversationState`，数字取同一次 counts。
  - 谁看得到什么照 spec 的表：坐席等非编辑角色没有话术草稿、待上架与「最近变更」，也不发这些请求，右栏挪到左栏；demo 匿名只有横幅和「在售」一格，只取各实体列表。
  - 会话列表接上 `state`、`stage` 两个 search 参数（`console/src/conversations-search.ts`，router 与自测共用）：总览的业务数与阶段条带着它们跳过去，服务端先过滤再分页，页头写「只看报价阶段、AI接待中的会话」加「看全部」。页签与阶段条仍是第 13 步的事。
  - `scripts/seed-demo.py` 加 `--scenario console-ux` 与 `--now`：13 个会话，A01 改成转人工，最后动静按设计系统 §10.0 的表相对 `--now` 定位，「昨天21:40」按 `--now` 所在时区的日历日算；订单的时间跟着各自的会话走。不带参数时，把时钟钉住跑新旧两版，两个输出文件逐字节相同。
  - `console/src/overview/overview.selftest.tsx` 串进 `pnpm test`（CI 注释同步），115 条：纯逻辑部分照设计系统 §10.0 的场景；挂载部分用 happy-dom 挂真的 `OverviewPage` 加假接口（所有者五块、各接口 500 只坏用它的块、坐席、没有要处理的事、匿名、审计按页取、外壳刚取过的数据不重取、换一个行业包），再挂真的会话列表核对「地址 → 请求 → 页头」。`selftest-env.ts` 把 `NODE_ENV` 设成 `test`：router-core 在 Node 里否则按服务端渲染挂载。`scripts/check-console-dist.ts` 要求 manifest 里有总览的懒加载块。
- 数字：首屏 JS（入口集合加总览）gzip 355,644 / 420,000 B；第 2.4 步记的是 `/` 重定向到话术页时实际下载 517,179 B。换页最多仍是产品库，247,077 → 247,686 B（余 2,314 B，第 9–12 步要留意）。UI 优先片 771 → 778 个码位，157,920 → 159,720 B（重跑 `scripts/fonts/build.ts`）；两个 preload 合计 171,604 / 300,000 B。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 按服务端规则拦截，时钟钉在 9月26日 14:30，探针在仓库外）：浅色、深色各 11 个状态（所有者、悬停与焦点、点「报价」阶段条与「等人接手」格、用户菜单、`/audit` 500、`lock_lost` 加索引 `lastError`、坐席、匿名、375 宽所有者与匿名、1100 宽、家装假包），`securitypolicyviolation` 0 次，控制台错误 0 条，计算样式扫描（字号集合、字重、含中文的字距）0 处，375、1100 宽都不横向滚动。几何与 A 页逐项一致：页头 y 24，区块头 y 100，五行 y 132–452，系统状态 y 480 高 22，KPI 四格 273×160 在 y 530，底部两栏 720 / 368 在 y 722，时间线与阶段条从 y 754 起，条区宽 248，4/3/2/1 → 248/186/124/62。文字与验收 10 一致：顺序 A01、F01、话术草稿、线路草稿、6条酒店草稿；业务数 13 / 2 / 1 / 43 及明细；点「报价」到 `?state=ai&stage=quote`，只列 2 个会话；`/audit` 500 时只有「最近变更」写「没取到 · 重试」；坐席看不到「最近变更」和草稿类待办。
- 变异（仓库外的隔离副本，43 例，最终全部失败并点名）：总览自测 41 例（待办的三段顺序与各自的排序、话术问题带原文、检查通过数、锁断开与索引提醒、等人接手格的数、在售数算进草稿、阶段含终态、不合「其他」、先截断再合并、`>=` 判取够、每行都写日期、今天写日期、名称只列 2 个、必须项恒过、建议项丢掉、终态名写死、渠道写原码、匿名画明细、非编辑者给新建、索引的实体名、已成交格去向、审计含登录、不带动作过滤、不按页取、坐席看到最近变更、坐席取话术、业务数依赖审计、匿名看到系统状态、阶段条链接丢 stage、底部不收成一栏、出错时藏行、不显示出错、search 留着原样的 state、丢掉 stage、列表不传 stage、页头不写阶段、两处 staleTime 改回 0）；外壳自测 1 例（侧栏没有总览）；产物检查 1 例（`/` 不用 `.lazy()`，点名 manifest 里没有总览块）。第一轮有两例存活：索引 `stale` 而没有 `lastError`、等人接手格取那一页的条数，补了两条断言。
- 偏离与取舍：
  - spec 顶部第 4 步的 `Revisions:`：「最近变更」不是 `limit=5`，是每页 50 条按页往前取，直到合出多于 5 句（至多 10 页），不然一次 CSV 导入被截在中间会写成「新建了4条酒店草稿」；业务数的明细另取 `?state=human`（评审之后改成总览自己取的最早一页，见下）与 `?state=paid&limit=1`。
  - 设计系统 A 页两处：第 5 行写「等6条」不写「等6家」（行业包没给实体配量词）；时间线头像写名字首字，小林是「小」（§6.8）。
  - TanStack Router 把地址里原样的 search 与 `validateSearch` 的结果合在一起给 `useSearch`，返回值里没写的键会原样留下：`?state=bogus` 原先照样发给接口（自测挂真的列表页时发现）。`conversationsSearch` 现在两个键总是写出来，不合规时是 `undefined`。第 5、9、13、14 步给别的路由写 `validateSearch` 时同样要这样写。
  - 外壳与总览共用的计数、等人接手、各实体列表，总览的观察者设 30 秒 `staleTime`：原来外壳启动时刚取过，总览的块挂上又各取一遍，匿名访客每次打开多用 2 次按 IP 限流的查询额度（每分钟 60 次）。之后照常跟外壳一起每 30 秒轮询。
  - 「去上架」「逐条检查」和在售数为 0 时的「新建{实体名}」都先打开这个实体的列表：详情与新建路由在第 10 步（2026-10-01 已改指到详情、草稿页签与新建，见「跨线收尾：条目链接」）。「新建{实体名}」现在是格里的一行字，不是单独的链接。
  - 窄屏：<1280 业务数两格一排，<992 底部两栏叠成一栏，<600 业务数一格一排、待办行把类型挪到对象上面、收起操作按钮（整行仍可点）。
  - 门禁：四个门禁全过；`pnpm test` 带 `PG_TEST_URL`（本机一次性的 `pgvector/pgvector:pg17` 容器）跑全，数据库自测 329 条含真实 PG 部分。
  - 这一步的浏览器实测用拦截的接口；真实 Postgres 加种子与时钟的走查在第 17.2 步，用本步的 `seed-demo.py --scenario console-ux`。
- 留给后面的步骤：
  - 第 10 步：待上架行和「新建{实体名}」改指到 `/catalog/$kind/$code` 与 `/catalog/new/$kind`。（2026-10-01 已做，见「跨线收尾：条目链接」）
  - 第 13 步：会话列表重做时保留 `state`、`stage` 的 search 与 `conversations-search.ts` 的写法；总览自测里「会话列表」那段随页面一起改。
  - 第 18 步（A2）：等待时长、接手、待付款与「本月成交额」替换这一版「需要你处理」的会话行。
- 评审之后（同日，4 条意见全部接受，走查另修 1 处）：
  - 等人接手只取了接口的默认一页：`waitingConversationsQuery` 不带 `limit`，服务端只回最新的 20 个，总览再按最后动静从早到晚重排、拿行数当「N项」，多于 20 个时等得最久的整行不见，「等人接手」格写的「最早」也只是这 20 个里最早的。总览改用自己的 `oldestWaitingQuery`（`overview/queries.ts`）：带 `limit=100`，`total` 多于 100 时取最后一页（`offset = total - 100`），两次之间总数变了按新的总数重取（至多再取 3 次）；「N项」由 `todoCount` 按 `total` 算；没列出的写成一行「还有N个等人接手的会话」（算 N 项），链到 `/conversations?state=human`。「等人接手」格取同一页。铃铛照旧取最新的一页，总览不再与它共用缓存：成员打开总览多一次请求（匿名不取会话，不占按 IP 的额度）。
  - 已成交格的口径原取包里终态阶段的名字，数字却只算 `conversationState` 判成已成交的会话（只认 `stage === 'paid'`）。改为只写 `conversationState` 认作已成交的阶段名，没有时写「已成交的会话」（家装假包）。停在非 paid 终态的会话算 AI 接待中、在阶段条里归进「其他」，这是 `conversationState` 的口径问题，记进「Open」，自测不再钉住「阶段到了「已付定金」」。
  - spec 顶部加第 4 步评审之后的 `Revisions:`：等人接手的取法；「新建{实体名}」是整格链接里的一行字（链接里不能再套链接）；设计系统 A 页就地改的两处（「等6条」、头像「小」）。「总览」的数据表与状态表同步改。
  - 走查另修：悬停待办行、业务数格、阶段条时字变主色。antd 的 `:where(.css-…) a:hover` 特异度与 `a:hover` 相同，比 `.ov-todo` 等的 `color` 高；初版的悬停截图拍在 antd 0.3 秒的颜色过渡中间，没看出来。三处悬停都钉住 `--text`。
  - 自测 115 → 128 条。纯逻辑：「还有N个」行与计数、它排在话术草稿前面、非 paid 终态的口径。挂载：等人接手 27 个（30项，W025 在最前，格里写最早的三个，请求带 `limit=100`）、105 个（108项，列出最早的 100 个，「还有5个」链到等人接手页签，第二次请求 `offset=5`）、两次请求之间多了一个（按新的总数重取，共 3 次请求）。假接口照服务端：不给 `limit` 时一页 20，按 `(updatedAt 倒序, id)` 排。
  - 变异（仓库外的隔离副本，12 例全部失败并点名）：不带 `limit`、不取最后一页、只重取一次、`offset` 差一、计数用行数、没有「还有」行、`hidden >= 0`、页面不传 `total`、「还有」行不算项数、「还有」行链错、业务数用铃铛那一页、口径取终态。悬停变色在浏览器里比对：改前三处悬停都是主色 `rgb(37, 92, 223)`，改后浅色 `rgb(24, 24, 27)`、深色 `rgb(237, 237, 239)`，即 `--text`。
  - preview 实测（做法同上，场景另加 25 个或 103 个更早的等人接手会话，再加家装假包）：浅色、深色各 4 个状态（27 个、105 个、105 个 375 宽、家装），CSP 违规 0、控制台错误 0，都不横向滚动。「还有5个」行在 1440 宽高 64，375 宽高 88；家装包的已成交格写「0 · 已成交的会话 · 还没有成交的会话」。

### 第 13 步（2026-09-28）

- 做了什么：
  - 会话列表整页重做，挪到 `console/src/conversations/`（`ConversationsPage.tsx`、纯逻辑 `model.ts`、`conversations.css`），`pages/conversations.lazy.tsx` 引它和样式，旧的 `pages/ConversationsPage.tsx` 删掉。页头「会话」、状态句、主按钮「打开工作台」（新标签打开 `/admin.html`，坐席等非编辑角色也有：它不是编辑）。页签「全部 / 等人接手 / AI接待中 / 已成交」与「客户停在哪一步」的阶段条都取同一个 `conversationCountsQuery`（与侧栏软徽标、铃铛共用缓存，一次挂载只请求一次，30 秒内的直接用，之后照外壳的节奏轮询）。页签顺序写成 `Record<ConversationState, number>`，02 加「顾问处理中」时 typecheck 失败。表格请求 `order=waiting_first`、每页 20 条，列与列宽照设计系统 I 页（会话 300 · 状态 140 · 阶段 120 · 消息 88 · 最后动静 160 · 操作）；等人接手的行阶段写「—」，阶段停在 `handoff` 的老数据同样写「—」；「最后动静」是 `relativeTime`，悬停 `absoluteTime`，列表本身每 30 秒重取一次。首列是真正的链接，点一行（不在链接上、不在选字）经 `window.open(…, '_blank', 'noopener,noreferrer')` 打开 `/admin.html#s=<id>`。
  - 地址：`conversations-search.ts` 加 `page`（2 起的整数，第 1 页不写），三个键照第 4 步的写法总是写出来。换页签只留状态；点阶段条的一行是 `?state=ai&stage=…`（与总览同一个去向），再点已选中的那一行取消；表格上方的筛选条「阶段：报价 ×」（设计系统 §5.5 生效的筛选按钮）清掉阶段、留着页签；页码越界（会话变少、旧链接）换成最后一页（`replace`）。
  - 状态：加载是 8 行骨架；一个会话都没有时空状态替换页签、阶段条和表格；页签没有结果写「这个分类下没有会话」，阶段筛选没有结果另给「清除筛选」；列表出错只坏表格那一块，计数出错时页签只写名字、阶段条写「没取到 · 重试」；匿名直接打开这个地址不发请求，写「登录后才能看会话」。
  - `stageRows` 挪到 `console/src/conversations/stages.ts`，总览的 `model.ts` 转出去，调用处不变；两页各自懒加载，共用的只有这 347 B。
  - `public/admin.html`：启动时读 `#s=<id>`（`decodeURIComponent`，写坏的 hash 不选中也不报错）；启动时那一次取列表回来后，这个会话不在、又没登录，就弹登录框说明（只核对这一次，没取到时不弹）；登录框走完、列表按新身份重取后选中，hash 一直在；之后 hash 跟着选中项走（`replaceState`），回到首页清掉，别的 hash 不动，`hashchange` 也跟着选。spec 顶部加第 13 步的 `Revisions:`。
  - `console/src/conversations/conversations.selftest.tsx`（110 条，约 2.5 秒）串进 `pnpm test`，排在总览自测之后，CI 注释同步：纯逻辑；happy-dom 里挂真的页面加照服务端规则算的假接口（counts 只请求一次、页签与阶段条之和对得上、13 行的顺序与每格的字、两处「打开工作台」的地址与新标签、点一行与点链接、页签、阶段条与筛选条、翻页与越界、三种空、两种 500、坐席、匿名不发请求、家装式的包、两个查询的轮询参数）；`public/admin.html` 的脚本原样在另一个 happy-dom 窗口里跑（prod 形态与演示形态的假接口、登录、关掉登录框后再取列表、换选中项、回首页、hashchange、写坏的 hash、已登录而会话不在、断网）。总览自测里「会话列表」那段（第 4 步说随页面一起改）挪进来，总览自测 128 → 124 条。
- 数字：首屏 JS（入口集合加总览）gzip 355,900 → 360,279 / 420,000 B。多出来的主要是 dayjs（3,308 B）：旧会话页不再用 dayjs 之后，rolldown 把它的运行时和 dayjs 合成一块共用块，入口和总览都引它；外加一块 `format` 的拆分开销和 347 B 的阶段条。会话列表的换页 86,210 → 86,263 B（JS），另有 5,234 B 的 CSS；换页最多仍是产品库，247,693 → 244,664 / 250,000 B（dayjs 挪出了产品库块）。UI 优先片 778 个码位不变（加「共」，旧页的「渠」没了），159,720 → 159,740 B，两个 preload 合计 171,624 / 300,000 B；两个 Geist 文件不变。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 按服务端规则拦截，数据是 `seed-demo.py --scenario console-ux` 的 13 个会话，时钟钉在 9月26日 14:30，探针在仓库外）：
  - 1440×1100 与 I 页逐项一致：页头 y 24；页签 y 100、高 40，项宽 47.6 / 79.4 / 76.2 / 53.8、间隔 24；阶段区块 y 156、宽 560，行从 y 188 起每行 32，条区宽 456，4/3/2/1 → 456/342/228/114；说明 y 384；表格 y 428，表头 36，行 44，操作按钮 28 高；主按钮 124×32。表头 13/500 text-3、排序列 text-2、首列 14/500 text，等人接手是 `--warning-bg` 胶囊，条是 `--bar`，悬停行 `--hover`；深色同样取令牌值。
  - 点「报价」：地址 `?state=ai&stage=quote`，请求带 `order=waiting_first&state=ai&stage=quote`，「AI接待中」页签选中，只列 C01、C02，筛选条「阶段：报价」，那一行 `--selected` 底、`aria-current="true"`；再点取消、点筛选条清掉；页签、「以表格查看」、后退都照预期。38 个会话时「共38条」、第 2 页 18 条，`?page=9` 换成 `?page=2`。空、页签无结果、阶段无结果、列表 500、计数 500、坐席（「只读」胶囊）、匿名（0 个会话请求）、家装假包（「业主停在哪一步」「企微业主 · H01」、阶段取包里的）两套主题各一轮。
  - 点第一行：新标签 `/admin.html#s=wecom%3Acust_F01`，`window.opener` 为 null；prod 形态的假后台下弹登录框，说明是「这个会话要登录顾问账号才能看。登录后直接打开它。」，登录后 F01 选中、hash 还在；点 B01 后 hash 变成 B01，刷新后仍选中 B01；操作列的按钮同样打开。
  - 375 宽：页面不横向滚动，表格在自己的容器里横滚（960 / 327），首列固定、底色是 `--panel`；四个页签放得下；1100 宽不横向滚动。两套主题所有场景的 `securitypolicyviolation` 0 次、控制台错误 0 条，计算样式扫描（字号、字重、含中文的字距）0 处。
  - 走查中改掉的：行高原来 45–50（状态胶囊与 28 高的按钮按基线对齐撑高行盒，改成贴顶对齐）；阶段区块头被 28 高的按钮撑成 28（改成定高 24）；TanStack 默认按 search 的子集判断当前页，取消筛选的链接（`?state=ai`）在 `?state=ai&stage=quote` 上被标成 `aria-current="page"`（筛选链接改成 `exact`）；375 宽时固定首列的表头是透明的，滚过去的表头字透上来，300 宽的首列占满了视口。
- 变异（仓库外的隔离副本，52 例全部失败并由具名断言点出，还原后与 worktree 逐字节相同）：模型 18 例（查询不带 waiting_first、offset 算错、页签顺序、软徽标、页签数取错状态、全部取 AI 接待中、换页签留着阶段、阶段条不能取消、不带 state=ai、清除阶段丢页签、第 1 页写 page、等人接手的阶段照写、handoff 写原码、阶段名写 key、悬停写相对时间、读屏名字不带状态、页码收 1、不合规的键不写出来）；页面 21 例（阶段条另取一次 counts、列表或计数不轮询、点链接也 window.open、不带 noopener、开在本页、筛选链接按子集算当前、不换越界页码、有筛选也整块空、空状态与状态句写死「客户」、不给清除筛选、匿名也取会话、一页也画分页器、首列不是链接、两处按钮不开新标签、不标倒序、表格视图不换、筛选条不写、计数出错不就地写）；admin.html 13 例（不读 hash、不弹、登录了也弹、没登录总弹、hash 不跟选中、不听 hashchange、不解码、解码不包 try、清掉别的 hash、登录后清掉选中、核对挪回 `load()` 且每次都核对、启动不核对、列表没取到也核对）。第一轮有 2 例存活（空状态写死「客户」、深链每次取列表都核对），补了家装包的空状态与「返回演示」之后再取列表两条；另有 2 例是变异脚本本身写坏了（语法错），改正后都点名。「解码不包 try」第一轮是整个自测崩掉，改成把页面脚本启动时抛的错记下来由具名断言报。
- 跑全量 `pnpm test` 时 `src/server.selftest.ts` 失败 3 条：它把 admin.html 的 `load()` 源码单独取出来跑（prod 未登录与 503 时按空列表渲染），第一版把深链核对写在 `load()` 里，引用了页面的全局变量，单独跑时抛错。那份自测不动，改页面：`load()` 取到时返回 `true`，核对挪到启动时那一次调用的 `.then` 里。浏览器里复测深链照旧。
- 自测里遇到的两处，改了代码：一、翻页后 antd 默认把表格的滚动容器动画滚回顶上，这个容器只横滚，动画按 `Date.now` 算时长，时钟钉住时停不下来，`waitUntilComplete` 一直等（浏览器里看不出）；表格设 `scrollToFirstRowOnChange: false`。二、页码越界换页的 effect 第一版看的是翻页时留着的上一页（placeholder），会反复跳；改成只看这一页自己的数据、只在页码超过最后一页时跳。
- 偏离与取舍：
  - admin.html 的两处补充行为见 spec 顶部第 13 步的 `Revisions:`。
  - 设计系统没写到、按现有规则补的：阶段条选中的那一行 `--selected` 底、阶段名 text 500，再点取消；清除阶段用 §5.5 生效筛选按钮的样子；「以表格查看」换成表格后按钮写「以条形图查看」；「最后动静」的表头按设计系统 I 页画 `chevron-down` 和 `aria-sort="descending"`，但排序固定、不能点。
  - 与设计系统的两处出入，都只在窄屏：<600 页签间隔 24 → 16（375 宽的内容区 327，四个页签加 24 的间隔要 329，antd 会收成「…」菜单）；<992 首列宽 300 → 176（首列固定，300 会占满视口，横滚区只剩 27）。
  - 状态句、区块标题、空状态里的「客户」取行业包的 `vocabulary.customer`（设计系统 §11），家装包写「业主」。总览的「客户停在哪一步」和业务数口径里的「客户」仍是写死的，第 17 步假包走查时一并看。
  - 家装假包里停在终态 `deposit` 的会话在列表里是「AI接待中」、阶段写「已付定金」，阶段条里算进「其他」：这是「Open」第 4 步那条 `conversationState` 的口径问题，本步不改。
  - 「Open」里第 2.2 步的第一条（admin.html 读 `#s=` 是第 13 步的事）随本步解决，开 PR 时已从「Open」删掉；`shell/model.ts` 的 `workbenchHref` 注释已改。
- 没有新增依赖。
- 留给后面的步骤：第 18 步加「顾问处理中」页签时改 `model.ts` 的 `TAB_RANK`（typecheck 会点名）与列表的行；J 页取代 admin.html 之后，`workbenchHref` 与本页的「打开工作台」改指 `/conversations/$id`。
- 评审之后（同日，6 条意见，5 条照改，1 条只接受一半）：
  - 页签不再用 antd `Tabs`，照 I 页画成 `role="tab"` 的按钮（`ConversationsPage.tsx` 的 `StateTabs`），tablist 名为「按接待状态筛选」。原来阶段条和表格是选中页签的 `children`：换页签、或在「全部」「等人接手」「已成交」下点阶段条，整块卸掉重挂，焦点掉到 body，「以表格查看」也被重置。现在只有一块 `role="tabpanel"`，由选中的页签命名。键盘：左右键在页签间移焦点（首尾相接），Home、End 到头尾，回车或空格才换；只有选中的页签在 Tab 顺序里；点已选中的页签不动（阶段筛选留着）。antd 在获得焦点的页签里塞的英文「Tab 1 of 4」读屏提示随之没了。
  - 选中的页签字重 500（设计系统 §4.4；原来 antd 画成 400）。页签外面包一层只管放不下时横滚的容器，四周各留 4 放焦点框、负外边距抵回，页头到页签仍是 20、页签到阶段区块 16；<600 的间隔 16 照旧，原因改成「放不下就得横滚」（不再有 antd 的「…」菜单）。
  - 阶段筛选没了、而焦点所在的元素也跟着没了（点了筛选条或「清除筛选」，或后退）：焦点放回刚才筛的那一行阶段（条形与小表格都认 `data-stage`），计数没取到、没有这一行时放回选中的页签；焦点还在页面上的（点页签、再点已选中的阶段）不动。按 effect 判断，不挂点击处理，带修饰键的点击不会留下一个等着的焦点。
  - 行内「打开工作台」的读屏名以看得见的字开头（WCAG 2.5.3）：「打开工作台，企微客户 F01（新标签页）」（`model.ts` 的 `openAria`）。表格名写明排序规则「会话，共13个，等人接手的排在最前」（`tableAria`，与 I 页相同，经 antd `Table` 的 `aria-label` 落到 `<table>` 上）。
  - `EmptyBlock` 加可选的 `level`（默认 h3，不影响别的页）；本页整页的两种空状态（一个会话都没有、匿名）紧跟页名 h1，传 2。页签无结果那一句在「客户停在哪一步」h2 之下，仍是 h3。
  - 只接受一半：评审建议考虑去掉「最后动静」的 `aria-sort`。留着：I 页同时画了表格名和 `aria-sort="descending"`，表格名现在说了「等人接手的排在最前」，`aria-sort` 标的是其下按最后动静倒序那一层；去掉的话读屏用户听不到这一层。
  - 自测 110 → 128 条（约 2.5 秒）：tablist 的名字、按钮、tabindex、aria-controls 与唯一的面板；键盘走一遍且每一步地址都不变；在「全部」的表格视图里点「报价」后阶段区块还是同一个节点、仍是表格、焦点留在那一格；清掉筛选条、点「清除筛选」、计数没取到三种情形的焦点去向；点页签清掉阶段时焦点不被挪走；点已选中的页签不换地址不重取；两个读屏名；空状态的标题层级。
  - 变异（仓库外的隔离副本，20 例全部失败并由具名断言点出，还原后与 worktree 逐字节相同）：面板按页签重挂（`key={active}`）、去掉焦点回位、焦点还在也回位、没有回落到页签、去掉 `data-stage`、左右键不首尾相接、Home 不认、方向键顺带换页签、页签都进 Tab 顺序、去掉 aria-controls、面板总由「全部」命名、tablist 不起名、点已选中的页签也换地址、表格不起名、按钮名回到旧写法、表格名不写规则、`level` 不生效、两处整页空状态不传 2、默认改成 h2。第一轮有 1 例存活（方向键顺带换页签：走完一圈回到「全部」，最后的地址又对了），改成每一步都记地址；「面板按页签重挂」第一轮是自测找不到元素崩掉，改成用两种视图都有的 `data-stage` 找，由具名断言报。
  - preview 复测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 按服务端规则拦截，浅色、深色，1440 与 375）：页签高 40、间隔 24（375 宽 16）、项宽 47.6 / 79.4 / 76.2 / 53.8 与改前相同，选中项 500、`--text` 字、2px `--text` 色的线，其余 400 `--text-2`；页签整排 1128 宽（375 宽 327），页头到页签 20、到阶段区块 16，375 宽页签不横滚、页面不横向滚动。焦点框 2px `--focus`、外移 2，截图里四边都在。评审列的场景都不再出现：表格视图里回车「报价」后地址 `?state=ai&stage=quote`、仍是表格、焦点在那一格；回车筛选条焦点到「报价」且画焦点框（鼠标点时不画）；表格视图下换页签仍是表格；条形视图下回车「推荐」焦点留着；计数 500 时回车筛选条焦点到「AI接待中」页签；页签获得焦点后名字是「全部13」，tablist 里没有 `aria-live`。axe：页面上的 heading-order 没了（整页空状态与匿名都是 h1 → h2）；余下两条不是这次的：操作列表头只有 `aria-label`（empty-table-header，minor，与 I 页相同）和外壳的租户名不在地标里（region，外壳第 2.2 步的事）。两套主题所有场景的 `securitypolicyviolation` 0 次、控制台错误 0 条。
  - 数字：首屏 JS（入口集合加总览）360,279 → 359,844 / 420,000 B；会话列表的块 9.19 → 10.37 kB（gzip 3.79 → 4.26 kB），CSS 5.23 → 5.77 kB；换页最多仍是产品库，244,634 / 250,000 B。UI 优先片不变（新文案的字都已在片里）。全量 `pnpm test`（真 Postgres）通过。没有新增依赖。

### 第 9 步（2026-09-28）

- 做了什么：
  - `console/src/catalog/params.ts`：地址里的 `status`、`q`、`f`（每项「字段 key:值」，同一个字段只认第一项，空的不写），`router.tsx` 的 `validateSearch` 用它；这个文件进入口，不依赖别的模块。
  - `console/src/catalog/list.ts`，纯逻辑、只看行业包配置与字段类型：列（首列是 `titleKey` 加 `subtitleKeys`，`titleKey` 不再单占一列；匿名去掉状态、更新两列）、表头（单位固定的金额写「每人起价（元）」，`元/人` 只取斜线前）、按类型的列宽规则（`Record<FieldType, …>`，按表头与全部条目的内容加宽、有上限）、筛选（`list.filters` 前 3 个；选项按类型生成，多值字段按「包含」匹配）、搜索（`list.search` 的字段，与 ⌘K 同一个原文匹配）、页签计数、默认按更新时间倒序、更新列写法、页头入口。是否的筛选按钮两种写法都有时名字写「境内/境外」（设计系统 D 页），不然写字段标签。
  - `console/src/catalog/CatalogList.tsx`：页签（匿名只有「全部」）、工具条（搜索框 320、筛选按钮与菜单、生效按钮「目的地：四川」加单独的清除按钮、「清除筛选」、右侧条数）、表格（单元格用第 3.2 步渲染器的列表形态，首列两行、编号等宽字，更新列 `aria-sort` 与悬停的绝对时间，多选与标签悬停看全文）、分页（50 条一页，不足一页不画），以及加载、从来没有过、筛选无结果、出错四种状态。筛选菜单多于 7 项时顶部有搜索框，拼音与 ⌘K 同一个懒加载块。
  - `console/src/pages/CatalogPage.tsx` 重写：kind 按行业包取，包里没有的出 `NotFound`；页头「共21条 · 销售助手只推荐已上架的」，编辑角色有「新建{实体名}」，`csvImport` 的实体另有「导入CSV」；列表里引用列、引用筛选要的目标实体按需取。01 的 rjsf 抽屉挪进 `pages/CatalogDrawer.tsx`，旧导入弹窗与它都按需下载（`React.lazy`），不进产品库页的块；按钮文字「CSV导入」改「导入CSV」。
  - 样式 `catalog/catalog.css`（§4.4、§5.3、§5.5），与 `fields/fields.css` 一起由 `pages/catalog.lazy.tsx` 引，随产品库的块下载、不进入口。第 3.2 步记的是由 `main.tsx` 全局引，改了：只有产品库页用渲染器。
  - 检查：`check-console-src.ts` 的 `LEGACY` 删掉产品库页与 `router.tsx` 两项，只留旧抽屉的 `route`、`detail`（第 10.3 步删抽屉时删）；夹具自测跟着改，另加「文件没了」一轮（108 条不变）。`check-fonts.ts` 的 `OUTSIDE_OK` 删掉「¥」那条（不变量 7，旧页面的「起价」列没了）。
- 自测：`fields.selftest.tsx` 第 8 节，1,018 → 1,175 条，已在 `pnpm test` 里。两个包的真实配置和样例都在这个文件里（只有它能 import 注册表和假包）：URL 状态、D 页与 L 页和主材的列与列宽（D 页的 64 / 120 / 224 / 180 / 100 / 152 与首列 312 逐个比）、各类型的筛选选项与匹配、搜索、页签计数、排序、更新列；挂进 happy-dom 画 D 页、筛选后、匿名、L 页、主材、酒店、60 条分页、从来没有过、筛选无结果、加载、出错；再经组件敲字、点页签、点清除、开菜单搜「四」、再点同一项清除，核对写回地址的内容与 replace。
- 变异（仓库外的隔离副本，59 例全部失败并点名，还原后与 worktree 逐字节相同）：`list.ts` 35 例、`params.ts` 6 例、`CatalogList.tsx` 16 例（筛选名的三例在其中）由自测点名；另 2 例：`LEGACY` 删掉旧抽屉那项（`pnpm lint` 点名 `CatalogDrawer.tsx` 的 `route`、`detail`），产品库页写回「¥」（`check-fonts.ts` 点名）。第一轮「引用的选项按编号排」存活：假包主材的编号正好也按拼音排，自测改用编号顺序与名称顺序不同的一组值之后点名。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`，浅色、深色各一轮，探针在仓库外）：
  - D 页 1440 宽：表格 x 260、宽 1152，列宽 312 / 64 / 120 / 224 / 180 / 100 / 152，与设计系统 D 页逐个相同；页签在页头下 20，工具条在页签下 16，表格在工具条下 12；行 56 高，表头 36、13/20/500 text-3；首列 14/22/500 text、次行 13/20 text-3 上距 2；第一行「贵州 小七孔·西江千户苗寨 5 日 / 贵州 · r-guizhou-5d · 5天 · 13,800 · 4–10月 · 家庭、亲子、银发 · 草稿 · 小林 · 今天13:40」。L 页（假包）列是「装修套餐 · 适用户型 · 每平米单价（元） · 起装面积 · 工期 · 适合开工月份 · 状态 · 更新」，页签「全部5 / 已上架4 / 草稿1」，「全年」只写「全年」；主材的单价每行带单位「268元/㎡」。坐席有「只读」胶囊、没有新建；匿名只有「全部20」，没有状态、更新两列，也没有新建。
  - 交互：搜「四川」地址是 `?q=四川`，2 条，页签「全部2 / 已上架2 / 草稿0」；目的地菜单 13 项、有搜索框，输入「sc」只剩四川（拼音块此时才下载），选中后 `?f=["destination:四川"]`，按钮浅色 `#EDF3FE` 底、`#255CDF` 500 字；同一个地址刷新后页签、搜索框、生效按钮与行都相同，后退回到上一步的页签，搜索框跟着地址走；筛选无结果没有主按钮，「清除筛选」回到 21 条；点名称才下载旧抽屉的块；60 条时第一页 50 行、「共60条」，换页签回到第 1 页；从来没有过的酒店只在空状态里有「导入CSV」「新建酒店」，页头没有按钮、没有状态句；加载 100ms 时骨架看不见、600ms 时 8 行 56 高；出错时工具条还在，表格位置「没取到 · 服务暂时连不上」加重试；旅游包下打开 `/catalog/package` 是「没有这个页面」。375 宽：`scrollWidth` 375，首列固定（横滚 400 后仍在 x 12），其余列在表格自己的容器里滚动。
  - 两套主题 `securitypolicyviolation` 都是 0 次；控制台只有浏览器对匿名 `/me` 的 401、故意造的 500 记的「Failed to load resource」，页面代码 0 条。
- 构建（与 `origin/dev` 同一套算法对比）：换页的产品库 247,077 → 129,199 B（rjsf 挪进按需下载的抽屉块，原样 395.14 kB、gzip 129.60 kB，只在第一次点名称或「新建」时下载），换页最多变成话术页 198,573 B；入口集合 316,791 → 325,333 B（+8,542，预算 420,000）。多出来的主要是两块：`format.ts` 本来就在入口里，列表与渲染器用上了 `parseMonthRange` 以后它不再被摇掉，连带 `season.ts`（gzip 4.10 kB）；rolldown 这次把 dayjs 单独切成一块、和它的运行时放在一起，入口要运行时，就连 dayjs 一起下（gzip 3.33 kB，原来在懒加载的 table 块里）。要省回来得把月份函数拆出 `format.ts`、或给构建配分块规则，都动别的步骤共用的文件，这一步不做。
- 字体：新文案带进「从」「共」，重跑 `scripts/fonts/build.ts`（fonttools 4.66.0、brotli 1.2.0）。UI 优先片 771 → 773 个码位，157,920 → 158,296 B（+376），两个 preload 合计 170,180 B；两个 Geist 文件、许可原文逐字节不变。
- 门禁：四道都过；`pnpm test` 另带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，用完即停）跑了一遍，db 自测 329 条含真实 PG 部分。
- 偏离与取舍（spec 顶部第 9 步的 `Revisions:` 记了前五条）：
  - 名称在第 10.1 步之前打开 01 的旧抽屉，是按钮不是链接；假包实体的名称是纯文字，「新建」「导入CSV」点了没有反应。
  - 筛选选项在 spec 列的三类之外按类型补齐（文本、标签、引用、数字取已有值；月份区间 1–12 月；状态两项；有序子项不画按钮）；按钮总画出来，没有可选值时不能点。
  - 页签数字按搜索与筛选之后算；页签、筛选记一步历史，搜索用 replace；页码不进地址，换页签、搜索、筛选回到第 1 页。
  - 从来没有过条目时新建、导入只在空状态里，页头不放、也不写状态句。
  - 更新列今天写「今天13:40」，更早的写日期；首列表头写实体名（L 页样张写的是「套餐」，按实体名是「装修套餐」）。
  - 筛选无结果里的「清除筛选」连搜索和页签一起回到默认，工具条上的只清筛选（评审之后前者改名「看全部」，见下一条记录）。
- 留给后面的步骤：
  - 第 10.1 步：`CatalogList` 的 `titleLink` 换成详情路由的 `Link`，删掉页面里的旧抽屉入口；「新建」改去 `/catalog/new/$kind`。
  - 第 12 步：「导入CSV」换成按行业包渲染的新弹窗，假包的主材也能点。
  - 第 16 步：375 宽下页头的状态句会折行，最后一个字单独成行（外壳的 `PageHeader`，不是本页的）。

### 第 9 步评审之后（2026-09-28）

- 做了什么（评审 7 条全部照改，另补两处键盘问题）：
  - 焦点不再掉到 body：筛选菜单选中一项、点 ×、按 Esc 之后回到这个筛选按钮；工具条的「清除筛选」、空状态的链接点了以后落到搜索框。选中后等一帧再挪焦点：在 Enter 的 keydown 里就挪的话，随后的 keypress 落到按钮上又把菜单打开。清除之后由搜索框在地址改完时接焦点，换了页签时是新页签里的搜索框挂上的那次（antd 的页签下一次提交才画出新页签的内容）。
  - 另补：7 项以内、没有搜索框的菜单（「境内/境外」）原来键盘选不了：antd 的 `autoFocus` 聚焦的是 `popupRender` 包的那层 div，它不可聚焦，焦点留在按钮上，↓ 和 Enter 都落在按钮上。外壳改成 `tabIndex={-1}`，获得焦点时转给选中的那一项（没有就第一项）；Esc 在外壳上自己处理（焦点在菜单项上时 antd 接不回按钮）；Dropdown 的子元素上不挂 ref，按钮经外层 span 找。
  - 另补：搜索框跟随地址不再看焦点，改成记下自己敲出去、地址还没回来的值（回声），回来的是其中之一就不回写，否则跟着地址走。原来焦点在框里时不回写：Safari 点按钮不挪焦点，框里敲了字再点「看全部」，地址清了、框里的字还在；清除之后把焦点放回搜索框也会碰上同一个问题。
  - 列宽：首列最小宽度侧栏展开和图标栏时 160、窄屏（<992）240（`TITLE_MIN_WIDTH` / `TITLE_MIN_NARROW`，`useViewport()` 取档）。1280 宽 D 页不再横滚；比容器宽时 antd 自带的左右边缘阴影由 `--divider` 加深到 `--btn-border`，看得出还能滚。
  - 分页器照 §5.5：`theme/antd.ts` 的 Pagination 令牌加 `itemSize: 28`、`fontWeightStrong: 500`、`colorBgTextHover` 取 `--hover`、`colorBgTextActive` 取 `--pressed`（antd 默认取 `--selected`，悬停的页码和当前页一样）；当前页的 accent 描边没有令牌，在 `parts/parts.css` 去掉（全局，会话列表的分页器同样适用）。
  - 页头的状态句还没取到（加载、出错）时先占一行 20 高的空行，取到以后页签、工具条、表格不往下跳。出错时也占着（评审只要求加载时）：重试成功后同样不跳。
  - 名称的焦点框：`.cell-link` 加上下 2、左右 4 的内边距与等量负外边距，框画在内边距里不压字；名称那一行不再裁切（名称自己省略）。
  - 筛选无结果的链接改名「看全部」：它连搜索和页签一起回到默认，与工具条上只清筛选按钮的「清除筛选」做的事不同。写进 spec 顶部第 9 步评审之后的 `Revisions:`。
  - 整页的自测：`fields.selftest.tsx` 第 8.9 节挂真的 TanStack Router（内存历史）和查询缓存，核对行业包里没有的 kind 是「没有这个页面」（两个包各一次，不拿第一个实体顶上）、编辑角色与能导入的实体的页头入口、非编辑成员与匿名没有入口、匿名只有「全部」页签和没有状态更新两列、从来没有过时页头不放按钮、假包的列和纯文字名称、加载与出错时状态句占位。为此两处共用文件的小改：`shell/AboutDialog.tsx` 的 `import.meta.env` 挪进组件里取（自测经产品库页 import 外壳，Node 里没有它，行为不变）；`fields/selftest-dom.ts` 设 `NODE_ENV=test`（TanStack Router 在 Node 里加载服务端构建，不设就把自己当服务端）。
- 自测：`fields.selftest.tsx` 1,175 → 1,219 条：焦点（×、菜单选中与再点清除、Esc、「清除筛选」、「看全部」含换页签）、小菜单打开后焦点在选中项或第一项、外壳可聚焦、搜索框的回声与「焦点在框里时地址变了也跟着变」、窄屏与宽屏的表格最小宽度、1280 下 D 页与 1366 下 L 页不横滚、整页 16 条。
- 变异（仓库外的隔离副本，23 例全部失败并点名，还原后与 worktree 逐字节相同）：页面 6 例（不认的 kind 拿第一个实体、匿名恒假、人人可编辑、从来没有过时页头放按钮、不占状态句、名称恒为纯文字）、焦点 9 例、搜索框同步 2 例（回声不认、改回按焦点判断）、列宽 3 例、「看全部」与「清除筛选」的行为和名字 3 例。第一轮「外壳去掉 tabIndex」存活：happy-dom 里什么元素都能聚焦，自测改为同时核对外壳的 `tabindex`（浏览器里不可聚焦的元素 `focus()` 不起作用）。
- preview 实测（Playwright 1.63，Chromium 与 WebKit，CSP 同线上，端口 4236，接口由 `page.route` 拦截，时钟同上一条记录，探针在仓库外）：
  - 键盘：目的地 Enter → 敲「sc」→ ↓ → Enter，焦点在「目的地：四川」，地址 `?f=["destination:四川"]`；在 × 上 Enter，焦点回到「目的地」；境内/境外 Enter 后焦点在「境内」，↓ 到「境外」，Enter 选中、菜单关上、焦点在「境内/境外：境外」；菜单项和搜索框里按 Esc 都回到按钮；工具条「清除筛选」、「看全部」之后焦点在搜索框、框里为空，从草稿页签「看全部」落在「全部21」的搜索框。WebKit 里焦点留在搜索框点「看全部」，框里清空，21 行。快速敲「稻城亚丁」不吞字。
  - 列宽：1280 宽 D 页首列 168，表格 1008 = 容器 1008（原来 1080 > 1008，「更新」列被裁）；假包 1280 宽 1056 > 1008 横滚 48，右缘阴影浅色 `rgba(9,9,11,.12)`、深色 `rgba(255,255,255,.12)` 可见；1366 宽假包不横滚（首列 198）；1440 宽 D 页 312 / 64 / 120 / 224 / 180 / 100 / 152 不变，L 页首列 256；1024 宽（图标栏）D 页 1000 > 936 横滚；375 宽首列 240 固定。
  - 分页器（60 条）浅色、深色：页码 28×28，当前页 `--selected` 底、描边透明、500，其余 400；悬停 `--hover`（浅色 `rgba(9,9,11,.04)`、深色 `rgba(255,255,255,.05)`），悬停当前页不变。
  - 加载（列表接口晚 1.2 秒）：页签的 y 加载中与取到后都是 108，状态行 20 高；CLS 0.0247 → 0.0034（剩下的是骨架换成表格行）。出错时状态行同样 20 高、页签在 108、表格位置「没取到」。
  - 名称焦点框：按钮 198×26（内边距 2 / 4、负外边距），框不压字，行高仍 56。
  - Chromium 两套主题 `securitypolicyviolation` 0 次，控制台只有故意造的 500；WebKit 页面本身 0 次，带截图的那一轮有一次 `style-src-elem`，去掉截图就没有，是 Playwright 截图往页面里塞的样式，不是页面的。
- 门禁：四道都过；`pnpm test` 另带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，用完即删）跑了一遍，72 秒，db 自测 329 条含真实 PG 部分。构建：入口集合 325,333 → 325,352 B，换页最多仍是话术页 198,573 B。
- 偏离与取舍：
  - 评审建议首列最小 160–180，取 160：D 页在 1280 正好放下（首列 168）。假包的套餐其余列要 896，1280 宽仍横滚 48，靠加深的边缘阴影提示；1328 宽起不滚。
  - 评审建议抽出纯函数测页面，改为挂真的路由测整页：页面里接线接错（如页头照样放按钮）纯函数测不到。
  - 状态句占位在出错时也保留（评审只要求加载时）。
  - 「清除筛选」与空状态链接取了「改名」一路（`看全部`），没有让两者做同一件事：空状态要能从只有搜索、只有页签造成的无结果里出来，工具条上的只清筛选按钮更符合它旁边的「目的地：四川 ×」。

### 第 14 步（2026-09-28）

- 做了什么：
  - 审计日志整页重做，挪到 `console/src/audit/`（`AuditPage.tsx`、纯逻辑 `model.ts`、`audit.css`），`pages/audit.lazy.tsx` 引它和样式，旧的 `pages/AuditPage.tsx`（表格加动作下拉）删掉。页头「审计日志」「谁在什么时候改了什么」。只有所有者、管理员请求数据；别的成员和匿名直接打开地址时不发请求，写一句「你的角色看不到审计日志」或「登录后才能看审计日志」。
  - 筛选：分段控件「全部 / 销售话术 / {产品库} / 账号与登录 / 平台与配置」（`auditGroups(pack)`）加开关「显示登录记录」，写进地址。新文件 `console/src/audit-search.ts` 管 `cat`、`login`，写法照第 4 步：键总是写出来，不合规的丢掉，原型上的名字不算类别。换类别时开关留着，开开关时类别留着。类别与开关经 `auditActionsParam` 换算成 `AuditQuery.actions`（全部且显示登录记录时不带），查询键里带 actions。router.tsx 的 `/audit` 加 `validateSearch`。
  - 时间线：`auditRuns` 合并连续同类记录，按本机日历日分组，组标题用 `dayHeading`。每条是 28 头像（非人操作者是 28 的方块加 `square-terminal`）、14/22 的句子（操作者与对象 500），下一行 13 text-2 的摘要，右边 13 text-3 的时刻，悬停看 `absoluteTime`。摘要：新建、上架写「{codeLabel}」加等宽编号；合并的一句列前三条的名字「…等6条」；其余取 `describeAudit` 的摘要。合并的一句末尾「展开6条」，展开后逐条列出，每条能单独打开。点句子（按钮，`aria-haspopup="dialog"`）或行里的空白处打开抽屉；选中的那条 `--selected` 底、`aria-current`。
  - 翻页：「加载更早的记录」每次凑 50 条（`AUDIT_PAGE`）。页尾是能合并的产品库动作、句子可能还没完时，接着往后取，直到那一句完整（至多多取 10 次）；多取回来的留到下一页用（carry），不重取。与第 4 步总览的理由相同：不把一次 CSV 导入截成「新建了4条酒店草稿」。不做滚到底自动加载，到底写「没有更早的记录了」。翻页出错只在底部就地提示和重试，已列出的留着。
  - 详情抽屉（M 480，`--raised`，头 56）：
    - 上面是整句（一行写完）、时间 `fullTime`、操作者、对象（实体名加等宽编号；话术写「话术v2」）；修正多一行原因。
    - 产品库的改动表「字段 · 原来 · 现在」；新建只有「字段 · 内容」两栏，只列填了的。字段名和顺序取行业包；金额用 `money`（`unitFrom` 取同一条的另一个字段）；数组用「、」连接。
    - 有序子项逐项对齐（最长公共子序列），比较时不看自动编号，中间插一天，后面几天不算改了。长文本和子项文字按字做行内差异：删去的划线加 `--subtle` 底，新加的 `--success-bg` 底，都不用红色，表下一句说明怎么读。
    - 包里没有的键不写原名，算进「另N项见技术详情」；改的全是这种键时不画表。上架是一行「状态 · 草稿 · 已上架」。
    - `sop.rollback` 且 `sameHashAsTarget === false` 时加一条 warning。去处是「打开这条{实体名}」或「打开销售话术」。
    - 默认折叠的技术详情：动作编码、对象类型与编号、记录号、按接口字段顺序的 JSON 原文。`TechDetails` 加可选的 `copy`，给了就在原文下放「复制」；剪贴板不可用时改为选中原文，按钮写「已选中，手动复制」。
    - 焦点：一关上就由 effect 还给点开它的那一句，不等收起动画；antd 自己的还焦点（`focusTriggerAfterClose`）关掉，不然点在行上打开时，它会把焦点还到打开前的 `main` 或刚点过的控件上。
  - 状态：加载时是组标题加 6 行的骨架；空「改动会记在这里」；类别下没有记录时写「这个类别下没有记录」加「看全部」（开关留着）；出错就地重试。
  - `src/shared/audit-text.ts` 只加两个导出（`auditItemName`、`auditMergeable`），原有行为不变。对象名的缓存与侧栏、⌘K 共用产品库列表查询，30 秒内的直接用。
  - `console/src/audit/audit.selftest.tsx`（117 条，约 2 秒）串进 `pnpm test`，排在会话列表自测之后，CI 注释同步。数据照设计系统 §10.0 的 8 条。纯逻辑部分覆盖：地址参数、actions、按页取时页尾那一句不截断且不重取、分组与摘要、行内差异与子项对齐、值的写法、改动表、抽屉各块，以及每种动作的可见文字里没有动作编码与 UUID。happy-dom 里挂真的页面加照服务端规则算的假接口，覆盖：请求与组、展开收起、筛选改地址并按新地址请求、地址还原、加载更早与到底、各种空与出错、抽屉（改动表、去处、技术详情、复制、焦点回到那一句）、坐席与匿名不发请求、家装式的包、整页没有红色。
- 数字：审计页的换页 JS 14,546 B gzip，CSS 5,597 B；第 2.4 步旧的表格页是 87,885 B（那时用 antd Table）。对象名原来经 `pack.ts` 的 `valueAt` 取，它在运行时 import 产品库 schema，审计的换页会多出 zod 那一块 24,190 B；改用 `model.ts` 里的 `valueAtPath` 之后，换页块里没有 zod 模块。首屏 JS 357,509 / 420,000 B；换页最多仍是产品库，247,675 / 250,000 B。UI 优先片 778 → 783 个码位（新加「笔见划底余因」，旧页的「滤」没了），159,740 → 160,540 B，两个 preload 合计 172,424 / 300,000 B（重跑 `scripts/fonts/build.ts`）。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 按服务端规则拦截：actions 过滤、`before` 翻页；时钟钉在 9月26日 14:30、`Asia/Shanghai`；浅色、深色各一轮，探针在仓库外）：
  - 1440×900 与 K 页一致：页头 y 24；分段控件 y 100、高 32，五段宽 50 / 78 / 64 / 92 / 92，选中段 `--thumb` 底、1px `--control-border` 的圈、500；开关 x 396，轨道 33×18，关着 `--control-border`；时间线 y 156、宽 680；组标题 13/500 text-2；两行的一条高 67，一行的高 48，条与条之间 `--divider`。抽屉 x 960、宽 480、头 56，底色浅色 `#fff`、深色 `#1b1b1e`（`--raised`）；事实栏 72；改动表表头 32、行 40，字段一栏 104；删去的 1.5px 删除线。
  - 行为：点「销售话术」，地址 `?cat=sop`，只请求 sop 的 4 个动作；开开关再点「账号与登录」，地址 `?cat=account&login=1`，列出两条登录。刷新后照样还原，后退回到 `?cat=sop&login=1`。Tab 进分段控件、右方向键换到「产品库」，焦点框 2px `--focus`。68 条的场景：点一次加载更早的记录，共发两次请求，第二次带 `before=348`，之后写「没有更早的记录了」。空、类别无结果、出错、坐席、匿名、回滚提醒、家装假包（「修改了装修套餐」「改了：套餐名称」）都照 spec。
  - 焦点：三种关法（键盘打开后 Esc；焦点在开关上时点行打开后 Esc；点关闭按钮）等收起动画结束后，焦点都在那一句上。
  - 375 宽页面不横向滚动（分段控件在自己的容器里横滚，388 / 335），抽屉占满 375；1100 宽的抽屉是 480。
  - 两套主题 24 个页面 `securitypolicyviolation` 0 次、控制台错误 0 条，计算样式扫描（字号、字重、含中文的字距）0 处。除了出错状态，整页没有红色。
- 变异（仓库外的隔离副本，30 例）：29 例由自测的具名断言点出，涵盖筛选与地址、按页取、分组与摘要、行内差异与子项对齐、改动表、抽屉、权限、查询键、翻页按钮、空状态、展开、对象名缓存、页大小、翻页出错、编码上页面、复制按钮。「去掉 `focusTriggerAfterClose: false`」在 happy-dom 里看不出，因为 rc-motion 在那里不结束，antd 关上后还焦点的那一步不跑。改在浏览器里比对：变异版点行打开后按 Esc，焦点落到 `main`；正式版落在那一句上。
  - 第一轮有 2 例存活：改动表标题不算包里没有的键；关上后不还焦点。补了断言。后者说明原来那条焦点断言是空转的：happy-dom 里焦点从没离开过那一句，`afterOpenChange` 也从不触发。改法是关上时由 effect 还焦点，关掉 antd 自己的还焦点，自测在关之前先把焦点放进抽屉。
  - 走查另删掉一条不生效的样式：antd 6 的抽屉面板是 `.ant-drawer-section`，`.ant-drawer-content` 什么也没匹配上。底色本来就由 `colorBgElevated`（`--raised`）给。
- 偏离与取舍：
  - 抽屉的「操作者」只写名字，不写角色，见 spec 顶部第 14 步的 `Revisions:`；设计系统 K 页同步改。
  - 去处暂时指到列表与话术页，见「Open」第 14 步第一条；产品库那一半 2026-10-01 已改到条目详情（「跨线收尾：条目链接」），话术那一半同日改到那一版的查看改动（「跨线收尾：审计里的话术版本」），「Open」里那条已删。分段控件与开关的样式在本页就地收，见「Open」第 14 步全站主题那条。
  - 句子不写「（CSV导入）」（设计系统 §10.0）；合并那一句的名字列表写「等6条」（第 4 步的 `Revisions:`：实体没有量词）。
  - 设计系统没写到、按现有规则补的：到底时写「没有更早的记录了」（13 text-3）；空状态的说明句；合并那一句的名字列表（样张里有，设计系统没写）；展开后的逐条；改动表标题「改了N处」「填了N项」和表下说明；只改了包里没有的键时不画表；窄屏（<600）句子换行、不省略。
- 没有新增依赖。门禁：四个门禁全过；`pnpm test` 带 `PG_TEST_URL`（本机一次性的 `pgvector/pgvector:pg17` 容器）跑全，数据库自测 329 条含真实 PG 部分。
- 评审之后（同日）改了六处：
  - 焦点：「加载更早的记录」取到最后一页时，按钮换成「没有更早的记录了」，原来焦点掉回 body（WCAG 2.4.3）。那一句现在 `tabIndex={-1}`，取完时焦点丢了就放到它上面；还有更早的就放回按钮。翻页出错后点重试，出错提示也会消失，同样处理。取的时候焦点移到了别处（比如点开了抽屉），就不动它。「取完」的判断：拿点的时候记下的页数和出错时刻，与现在比。第一版用的是「渲染过正在取」的标志，结果来得快时两种状态合在一次渲染里，标志会一直留着，变异时查出来了。焦点框只圈住那一句的字。
  - 标题层级：成员视图的两个空状态（「改动会记在这里」「这个类别下没有记录」）改为 h2，紧跟页名 h1，不跳级（axe `heading-order`）。
  - 分段控件：传 `tabIndex={-1}`，去掉整条轨道多出来的一次 Tab，Tab 直接进选中的那一段（「Open」第 14 步全站主题那条）。
  - 改动表的值：月份区间与引用改为和字段渲染器写得一样（ADR-004）。月份区间写「3–6、9–11月」，「全年」写包里的 `yearRoundLabel`；画不出月份的写原文，不写成「—」。按编号存的引用写目标条目的名字，取页面的产品库缓存，缓存里没有时写编号，有序子项里的引用也一样。`valueText`、`changeRows` 多一个可选的 `lookups`。
  - 自测 117 → 135 条。补的断言：家装式的夹具（`unitFrom` 的金额「98元/延米」、月份区间、按编号或按名称存的引用、子项里的引用）；嵌套对象从没有到有、从有到没有（修改与新建）；子项里包里没有的键算进「另N项」；时刻悬停的绝对时间；复制按钮在剪贴板被拒时选中原文、写进剪贴板时写「已复制」；空状态标题是 h2；轨道不进 Tab 顺序；到底、重试之后焦点的去处，以及焦点在别处时不被挪走。
  - plan 第 14 步的勾写明去处未完成，spec 顶部加一行第 14 步评审之后的 `Revisions:`（2026-10-01 两半都做完，勾的说明随之改）。
- 评审之后的变异（仓库外的隔离副本，每例 300 秒超时，24 例）：22 例由具名断言点出。评审报告里存活的 6 例（`unitFrom`、嵌套对象从没有到有、子项里认不出的键、新建时的嵌套字段、时刻的 title、复制时的选中）都在其中；新增的焦点、标题层级、轨道 tabIndex、月份区间、引用、`lookups` 传递各例也被点出。存活 2 例：「取完」只比页数、不比出错时刻；「取完」判断整个去掉。前者只影响出错之后那个标志什么时候清掉。后者在 effect 的依赖不变时本来就不会跑。两者都要焦点已经丢了、又碰上还没画出按钮或那一句的时候才有差别，页面上看不出来，不另加断言。
- 评审之后的 preview 实测（Chromium，CSP 同线上，浅色、深色各一轮，探针同上，另加几个场景）：
  - 130 条的日志：键盘按两次 Enter，行数 50 → 100 → 130，焦点先留在按钮上，到底后在「没有更早的记录了」上，框是 2px `--focus`；再按 Shift+Tab 回到最后一句。68 条鼠标点一次，焦点同样在那一句上，不画框。翻页出错时焦点留在按钮上，重试成功后到那一句上。
  - 从开关按 Shift+Tab 直接落到选中那一段，方向键右一下，地址变成 `?cat=sop`；Tab 顺序里没有整条轨道。
  - 空与类别无结果：axe 不再报 `heading-order`，只剩外壳原有的 `region`。
  - 家装假包：抽屉写「适合开工月份 3–6月 → 3–6、9–11月」「包含主材 实木地板 → 实木地板、岩板台面」「单价 88元/㎡ → 98元/延米」。
  - 26 个页面 `securitypolicyviolation` 0 次。控制台只有出错、匿名场景里模拟的 500、401 请求各一条网络日志，页面本身没有报错。
- 评审之后的门禁：四个门禁全过；`pnpm test` 带 `PG_TEST_URL`（一次性的 `pgvector/pgvector:pg17` 容器）跑全，数据库自测 329 条含真实 PG 部分。`check-console-dist`：首屏 JS 358,120 / 420,000 B，换页最多仍是产品库 247,515 / 250,000 B；`audit.lazy` 块 11.41 kB gzip（vite 报告）。月份区间的函数取自 `format.ts`，审计块里仍没有 zod。UI 优先片没变（783 个码位）。没有新增依赖。

### 第 5.1 步（2026-09-28）

- 做了什么：
  - `console/src/sop/outline.ts`（纯函数）：目录的行，节表与锁定取 `/sop` 的 `spec`，锁定原因按 key 取行业包的 `sopSections`；匿名只用行业包，包里没有的节从正文的「## 」行取标题、按没锁算，包还没到时照样画得出来。每行的字数与相对线上的差（含本地没保存的改动，改回原样就不算改过；固定规则节不算改过）、问题数（按 `sectionKey` 计，整体的问题不落到节上）。分段筛选与计数；URL 的 `section` 不认得（或没给）时退回第一个可编辑节；方向键到头不绕回。额度条的模型：本地改动合进草稿后用服务端同一个 `editableChars` 算；<95% 中性、95%–100% warning、>100% danger 并写「超出N字，发布会被拦下」；百分比夹在颜色的区间里（2,525 / 2,658 写 94%，不写四舍五入的 95%）；比例尺取上限与字数中大的，放宽 5% 后向上取两位有效数字，上限 2,658 时是 B 页的 0–2,800，超限时整段画得下。状态句：发布人没有名字时按来源写「导入于」「系统更新于」，不是今年的写年份。
  - `console/src/sop/Directory.tsx`：目录是 `nav` 地标「话术目录」，每节一个指向 `/sop?section=…` 的链接；整个目录只占一个 Tab 位（当前节，被筛掉时是看得见的第一节），↑↓ 换节，Home / End 到头尾，Enter 进编辑器（这一节还不是当前节时先选中）；点击进浏览历史，方向键用 `replace` 不进；带修饰键或中键的点击交给浏览器。带锁的节悬停或聚焦时 Tooltip 写「固定规则 · {lockReason}」，读屏经 `aria-describedby` 念出。`DirectorySelect` 是 <1280 的下拉：选项照目录的顺序、锁和圆点，多于 7 节可以搜（拼音库与 ⌘K 共用懒加载的块），底部是锁的说明。另有 `QuotaBar.tsx`、`SopSkeleton.tsx`（额度条、分段控件、目录行数取行业包的节数、编辑器）和 `sop.css`（由 `pages/sop.lazy.tsx` 引入，随话术页的块下载）。
  - `SopPage.tsx`：页头状态句、额度条、目录换成上面几个；编辑器和其余部分（保存、检查、发布、丢弃按钮，检查结果，逐节对比，版本历史）仍是 01 的做法，由第 5.2–7 步换掉。路由 `/sop` 加 `validateSearch`（只有 `section`）。`useUnsavedGuard` 加可选的第二个参数，话术页传 `LEAVING_PAGE`：换节只换查询参数、改动按节留在页面里，不拦；离开这一页照拦。`TextEditor` 只读时正文加 `tabindex=0`，匿名与固定规则节在目录里按 Enter 也进得去。
  - `console/src/sop/sop.selftest.tsx`：147 条断言，约 1.9 秒，串进 `pnpm test`（渲染器自测之后），CI 注释同步。节表用文件里的两份夹具（照旅游包、照家装整装假包），不 import 行业包模块。
- 快速连按时 React 报 #185（Maximum update depth exceeded），查明后修掉：
  - 现象：走查脚本在话术正文里连按 150 下退格，两套主题都会偶尔报一次，堆栈在 `TextEditor` 的 update listener 里。
  - 原因：`@rc-component/portal` 2.2.1 的 `Portal` 有一个不带依赖的 `useEffect`，每次重渲都 `setInnerContainer`。话术页每敲一个字整页重渲，关着的两个 `ConfirmDanger`（离开保护、丢弃）也跟着重渲，它们的 Portal 就在同步提交之后排一个 Default 优先级的更新；下一下按键的同步渲染会取消这个还没跑的 Default 任务再重排，React 19.3 的判定是「提交完还剩 Sync/Default 更新就记一次嵌套」，接连 50 次就抛 #185。开发版 React 加钩子逐个记 `setState` 的优先级与堆栈查到的。origin/dev 上的旧页面同样常驻这两个确认框，但同样的连按每下两次提交、0 次报错：新页面上 Default 任务在两下按键之间跑不上（每下只有约 1.05 次提交），原因没有再追，修法与它无关。
  - 修法：一、`ConfirmDanger` 加 `destroyOnHidden`，关着时不挂弹层；二、目录的每一行是 `memo` 的 `TocRow`，属性全是原始值，点击和按键由列表统一接住、按 `data-key` 认行，打字时只有字数变了的那一行重渲（Tooltip 打开过一次以后 Portal 一直挂着）；三、窄屏下拉 `memo`，只在节的顺序、名字、锁、改没改或当前节变了时重渲，所以选项里不再写字数（下拉打开过一次以后同样一直挂着）。
  - 修后实测（同一个探针，每轮先开过带锁行的 Tooltip、丢弃确认、离开保护，窄屏另开过下拉，再连按 900 下）：每轮 900 次提交里，提交完还剩待办更新的：浅色宽屏 0 次、浅色 1100 宽 1 次、深色宽屏 0 次、深色 1100 宽 1 次（1 次是那一节第一次变成「改过」时下拉重渲），报错 0 条。
  - 自测第 6 节钉住这三处：从 DOM 节点取 fiber、从根的 current 树往下找组件，比 `memoizedProps` 是不是同一个对象（memo 跳过时 React 设回上一次的那个）。用的是 React 内部结构（版本钉在 19.3），找不到组件时断言失败。
- 构建：入口集合 gzip 316,791 → 316,810 B（+19）；换页最多仍是产品库，247,077 → 247,151 B（+74，共用的 `UnsavedGuard` 块变了），余 2,849 B。话术页自己要下的 JS（gzip -9）201,092 → 200,907 B：01 页面用的 Menu、Progress、Row、Col、Tag 与 antd 图标不再引入；另多一个 1,332 B 的 CSS 块。字体按新文案重切：UI 优先片 771 → 774 个码位（「带」「拦」「醒」），157,920 → 158,608 B，两个 preload 合计 170,492 B。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30，数据是 `data/sop.md` 按服务端切节、草稿给话术原则加 44 字、异议处理加 9 字；浅色、深色各一轮，探针在仓库外）：
  - 1440 宽：额度条标签 560 宽、条 720 宽，95% 与上限刻度在条上 649.3、683.5 px（B 页）；目录 264 宽、与编辑器间隔 32；行高 40，节名两行的 62；当前节 `--selected` 底、节名 500；带锁的节名 text-2、字数 text-3；改过的节字数 accent-text 写「954（+44）」；分段控件高 32、选中段 1px `--control-border` 的环，三段是「全部11 / 可编辑4 / 已改2」。点一节进浏览历史，↓ 换节不进、焦点跟过去、`focus-visible` 2px 实线；Enter 后焦点在编辑器正文；后退回到点之前的节。直接打开 `?section=objections` 选中异议处理，`?section=nope` 退回前言；「已改」「可编辑」筛选各列 2、4 节。
  - 打字：连加 425 字，额度条变 danger「2,693 / 2,658字 · 101% · 超出35字，发布会被拦下」，状态句变「草稿改了3节」；删回 145 字是 warning「96% · 还能写110字」。换节不弹离开保护、改动还在；点侧栏的线路弹，「留下」后留在原页。检查以后话术原则下一行是 danger 的「1个问题」。
  - 1280 宽目录仍在左栏、没有横向滚动；1100 宽目录换成下拉，11 项，打「yycl」只剩「异议处理」，回车换节并写进 URL；375 宽（坐席）额度条上下排、没有按钮、状态句末尾「只读」、没有横向滚动。
  - 匿名：状态句「线上v2 · 9月25日」，没有额度条、分段控件、字数和按钮，锁照画（7 节）、Tooltip 照写原因，只请求 `GET /sop`。家装整装假包的租户：9 节、带锁 5 节，标题、锁、原因都取假包，额度条 463 / 555 字。
  - 加载骨架与成品同位：额度条 (88,108) 1312×44、目录首行 (88,220) 264×40、编辑器 (384,176)，与成品逐一相同。
  - 两套主题所有场景 `securitypolicyviolation` 0 次，控制台错误 0 条。
- 变异（仓库外的隔离副本，30 例全部让自测失败并点名，还原后与 worktree 相同）：95% 线用 `>`、上限用 `>=`、百分比不夹、比例尺不放宽、固定规则节也算改过、不取包的锁定原因、未保存的改动不计、合并时丢标题行（`editableChars` 抛结构错误）、差值不带加号、长度不变也写差、默认节取第一节、不认得的节照用、方向键绕回、匿名默认上锁、没名字不按来源写、没改动时不写那一段、`TocRow` 不 memo、下拉不比结构、下拉比结构漏了改没改、Tab 位全开、Enter 跟着链接走、Enter 不先选中、带修饰键的点击也拦、方向键不管修饰键、带锁的行没有 Tooltip、底部说明不画、额度条不上色、刻度位置错、确认框关着也挂 Portal、换节也拦。
- 偏离与取舍：
  - 窄屏下拉的选项不写字数（见上面 #185 的修法）；目录照写。spec 只说「宽 <1280 时目录变成编辑器上方的下拉选择」，没有写下拉里有没有字数，不算改 spec。
  - 带锁的节多一个 Tooltip 写锁定原因：spec 要求锁在列表里就看得见，锁定原因原本只在固定规则节正文上方那一行（第 5.2 步）；Tooltip 让不点开也能知道为什么锁。
  - 没给 `section` 时打开第一个可编辑节（旅游包是前言）；B 页选中话术原则是样张的场景。
  - `ConfirmDanger` 的 `destroyOnHidden` 对所有页面生效：确认框里没有要保留的状态，关掉的动画照放完才卸下。
- `pnpm test` 全过：`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条连真实 Postgres 部分一起跑。
- 没有新增依赖。
- 留给后面的步骤：
  - 第 5.2 步：固定规则节正文上方那一行改成「固定规则 · {lockReason}。这里改不了，要改请联系技术。」（现在还是 01 的 Alert）；原因取 `OutlineRow.lockReason`。编辑器换掉时，逐字重渲的范围照本步的做法：别让打开过的 Tooltip、下拉、关着的弹层跟着每个字重渲。
  - 第 5.3 步：spec「状态句」的「会变的部分预留固定宽度」本步没做：现在草稿那一段后面没有别的段，怎么变都不挤动别的东西，先定宽只会让间隔号前后空得不一样。接上「已自动保存14:05」时再给草稿那一段定宽或用等宽数字。页头的保存、检查、发布、丢弃按钮随第 5.3、6 步换成「更多」「版本记录」和发布条。
  - `ConfirmDanger` 的 `maskClosable` 在 antd 6 里已废弃：评审之后换成了 `mask.closable`，见下一段。
- 评审之后（同日，评审报的四条都改了）：
  - 字数口径（中）：服务端保存草稿时先规范化正文再计数（`rebuildSection` → `normalizeBody`：去每行行尾空白、开头空行、末尾空白，结尾补成一个空行或一个换行），额度条和目录的「改过」原来拿编辑器里的原文直接算，保存前后数字会跳、只多了行尾空格的节也算改过。`normalizeBody` 里不查编码的那部分挪到 `src/shared/sop-sections.ts` 的 `canonicalBody`（连同去 BOM 与换行的 `toLf`），`src/sop/sections.ts` 的 `normalizeBody` 改成查编码、调它、再查编码，config 自测 451 条照过；`memberOutline` 与 `mergedSections` 先按节表判断是不是末节、规范化，再比较、再计数。spec 顶部补一行 `Revisions:`，「额度条」第一条随之写上规范化。自测的夹具改成规范形（非末节以空行结尾、末节以换行结尾，场景字数不变），另按保存规则手算核对：在节末空行上打两个字 +4、行尾多一个空格不算改过、删掉节末空行不算改过、末节末尾打两个字 +3、粘贴的正文（BOM、开头空行、行尾空格与制表符、`\r\n`、分解形式的 é）、单独的 `\r`，以及差 2 字到上限时打这两个字就是 danger。用评审的探针在隔离副本里拿真实 `data/sop.md` 对「保存以后服务端的 `editableChars`」：三种编辑依次 2,219、2,215、2,215（评审时前端显示 2,217、2,216、2,214），末节 2,218、粘贴 2,218，前后一致，「改过」与差值也一致。
  - 整页的接线没有测试（中）：`sop.selftest.tsx` 加第 7 节，把 `SopPage` 挂在真的 TanStack Router 上（内存里的地址栏，basepath `/console`，`/sop` 的 `validateSearch` 照 router.tsx 抄一份，另有 `/audit` 当别的页），QueryClient 预置 `['viewer']`、`['sop']`、`['sop-versions']`，`fetch` 换成只记录、永远不回。断言：`?section=` 选节、不认得的退回前言；↓ 以后 `history.length` 不变、点击加一、后退回到之前的节；打字以后额度条 2,303 → 2,307、目录「958（+48）」；有改动时换节不弹离开保护、改动还在，去 `/audit` 弹、地址不动，「留下」后还在；匿名时锁与节名取行业包（家装整装假包的节表）；Enter 以后焦点在 `.cm-content`（当前节、要先换过去的只读节、当前的只读节、匿名）且只读正文 `tabindex=0`；加载中的骨架按身份画。router-core 在 Node 的 node 条件下按 `NODE_ENV` 判断是不是服务端渲染，新文件 `console/src/sop/selftest-env.ts` 在自测最先设成 `test`（只这一个进程）。`NODE_ENV=test` 时 antd 不再合并重复的警告，`ConfirmDanger` 的 `maskClosable={false}` 每个实例报一次废弃，改成 antd 6 的 `mask={{ closable: false }}`（模块级常量，`normalizeMaskConfig` 下两种写法等价；preview 里点遮罩确认框照旧不关）。自测 147 → 184 条，约 2.7 秒，`pnpm test` 的调用不变。
  - 匿名的骨架（低）：`SopSkeleton` 加 `filter` 参数，匿名不画分段控件；目录上面没有分段控件时（匿名的成品和骨架）列表去掉 12 的上边距，第一行与编辑器顶端对齐，和成员的分段控件一样。
  - 窄屏下拉的问题数（低）：选项同一行右端写「N个问题」（danger，前置 circle-x，和目录同一个 `IssueCount`），`sameOptions` 把问题数也比进去；问题数只在检查或发布之后变，不会逐字重渲。
  - 变异（仓库外的隔离副本，22 例全部让 `sop.selftest` 失败并点名，还原后与 worktree 逐字节相同）：评审给的 7 例（换节也拦、方向键 push 点击 replace、额度不计未保存的改动、匿名不取包的锁、忽略 URL 的 section、当前节上 Enter 不聚焦、只读正文去掉 `tabindex`）；另 3 例整页（换节以后不聚焦、方向键与点击都进历史、目录也不计本地改动）；规范化 8 例（目录不规范化、额度合并不规范化、末节当非末节、不去行尾空白、不去开头空行、不转 NFC、不去 BOM、不换 `\r`，后三例第一轮存活：粘贴夹具的 BOM 独占一行、行尾空白只在末尾、`\r` 都在行尾，都被别的规则顺手去掉了，夹具改过以后失败）；骨架 2 例（总画分段控件、页面照传）；下拉 2 例（不写问题数、不比问题数）。
  - preview 实测（Chromium，CSP 同线上，接口由 `page.route` 拦截，数据同上一轮的评审探针；浅色、深色各一轮）：1440 宽匿名骨架第一行 (88,174)、编辑器 (384,174)，成品相同（评审时成品第一行在 186、骨架在 218）；成员骨架与成品仍逐一相同（额度条 (88,108)、分段控件 (88,176)、第一行 (88,220)）。1100 宽检查以后展开下拉，11 项里只有「话术原则」右端写「1个问题」，浅色 `#B42318`、深色 `#FF9B8F`，离选项右边 8。1440 宽在「话术原则」末尾空行上打「测试」：2,258 → 2,262；点侧栏去会话，弹离开保护，点遮罩不关，「留下」后地址仍是 `/console/sop?section=tone`。375 宽坐席与匿名都没有横向滚动。`securitypolicyviolation` 0 次；控制台只有匿名时 `/me` 的 401（匿名就是这样判出来的，网络日志，不是脚本错误）。
  - 构建：入口集合 gzip 316,810 → 316,809 B；换页最多仍是产品库，247,151 → 247,154 B（共用的 `UnsavedGuard` 块带着 `ConfirmDanger`），余 2,846 B。字体不用重切（774 个码位、158,608 B）。`pnpm test` 全过，`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条连真实 Postgres 部分一起跑。

### 第 5.2 步（2026-09-28）

- 做了什么：
  - `console/src/sop/editor.ts`：话术正文的 CodeMirror 扩展，原文一个字不改。markdown：「- 」（前面可带缩进）换成 5×5 的圆点、正文缩 20，续行按缩进对齐（两个空格一级、四五个空格两级，最多三级），顶格列表项之间空 12（前面是空行或第一行时不空）；「**」包着的是 600，能编辑、有焦点、光标在那一行时才露出「**」（text-3）。芯片：`vocabulary.tools` 与 `sopFields` 里有的 ASCII 名字（前面不连字母、数字、下划线，与服务端的 `\b` 一致；只认自己的键）是一个带 `data-label` 的标记，中文名画在 `::before`、替代文字为空，原名仍是可编辑的原文。✗ ✓（另有 ✘ ✔）换成 16 的 lucide `x`、`check`，`role=img`、`aria-label` 是原字符，线宽 2.25（1.5px）。改动：线上正文与编辑器正文按字比（`@codemirror/merge` 的 `diff`，不用按词对齐的 `presentableDiff`），隔不到 3 个字的连成一处；改到的行加 `sop-changed`（左 12 处 2px accent 竖条），新加的字 `sop-ins`（accent-bg、`--r-xs`、左右 2）；只动空白、保存时会被 `canonicalBody` 抹掉的（行尾空白、开头与末尾的空行）不标。回退：`haltFallback` 为真时按「看得见的字」算 `haltIndices`（藏掉的「- 」「**」不算）。`CM_PHRASES` 汉化 CodeMirror 与 `@codemirror/merge` 的 7 句内置文案。字阶与卡片取 brand.css 变量：正文 `--font` 16/28，正文区 652 = 行宽 640 加沟槽 12。
  - `console/src/sop/SopEditor.tsx`：`SopEditor` 取代 01 的 `console/src/TextEditor.tsx`（已删，只有话术页用它）：没有行号，`aria-label` 是「「话术原则」正文」，只读时 `tabindex=0`；只读与否、节名变了才重建，线上正文走 `setBaseline`、词汇走 compartment，都不重建（光标和撤销历史都在）。`SectionPane` 是中栏：节标题 16/24/600、说明行（能改的成员「可编辑 · 910 → 954字（+44）」，只读成员只写字数，匿名不写）、固定规则节换成 14 的 lock 加「固定规则 · {lockReason}。这里改不了，要改请联系技术。」（原因取 `OutlineRow.lockReason`，取代 01 的 Alert），下面是编辑卡片（panel、`--r-lg`、`--shadow-card`，内边距 24，最宽 688；获得焦点时照文本域的规矩换成 accent 描边加 3px `--accent-ring`）。
  - `SopPage.tsx`：成员、匿名与 01 的冲突提示都用它；成员的线上正文取已发布版本，词汇取 `/pack`；匿名的正文去掉「## 标题」行（`outline.ts` 的 `bodyWithoutHeading`，标题已在中栏上方）。`SectionDiff.tsx`（01 的逐节对比）加上同一份内置文案。骨架的中栏加节标题与说明行（匿名不画说明行），与成品同位。`outline.ts` 另加 `sectionMeta`、`lockLine`。
  - `sop.selftest.tsx` 第 8 节：行的排法、粗体、芯片的名字（换包、原型上的名字）、改动标记（汉字中间插字、另起一行、只动空白、连成一处的边界）；`EditorState` 上算出的装饰（藏起来的标记、芯片在外层、图标、光标行露出「**」、挤压回退隔着藏掉的「**」也挤）；从 CodeMirror 四个包的源码里找出全部 `phrase("…")`，每句都要有中文，差异视图折叠的行写「18行没有改动」；挂在 DOM 里的芯片、图标、改动标记、`aria-label`、只读、焦点，换词汇、换线上正文不重建编辑器、打字以后改动标记跟着重算；中栏的三种身份与固定规则节；整页的接线（词汇与锁定原因取行业包、匿名去掉标题行、家装整装假包的芯片）。184 → 273 条断言，约 4.6 秒，`pnpm test` 的调用不变。
- 变异（仓库外的隔离副本，45 例，还原后与 worktree 逐字节相同）：第一轮 43 例让自测失败并点名，存活 2 例：「以换行开头的新行也标前一行」（原夹具里新加的一行被对齐成以换行结尾）、「改用 presentableDiff」（原夹具的插入处紧挨着标点，不触发按词扩展）；补了「在末尾另起一行」「汉字中间插字」两条以后都失败。其余 43 例：缩进级数与算法、「- 」后没字、空开的两个条件、粗体的边界、光标行、只读与没焦点时露出「**」、原型上的名字、名字前连数字、芯片不在外层（新加的字里的芯片被拆成三段）、不带中文名、图标不是整块或少一个、挤压按原文算或不看开关、连成一处的间隔（1、4）、三种空白规则与开头空格、以换行结尾、打字不重算、少一句文案、编辑器或差异视图不带文案、换线上正文或词汇不生效、`aria-label`、外面换正文也回调、只读成员能改、说明行三处、原因的句号、去标题不去空行、页面四处（改动相对草稿、不传词汇、匿名不去标题、锁定原因不取包）、骨架给匿名画说明行。
- 构建：入口集合 gzip 316,809 → 316,860 B（+51，lucide 的 check 模块多导出一份图形数据）；换页最多仍是产品库，247,154 → 247,038 B，余 2,962 B。话术页自己要下的 JS（按 manifest 从 `sop.lazy` 出发、入口集合以外，gzip -9）201,087 → 203,588 B（+2,501），CSS 1,348 → 1,511 B。字体按新文案重切：UI 优先片 774 → 776 个码位（「控」「采」），158,608 → 159,024 B，两个 preload 合计 170,908 B。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30，线上是 `data/sop.md`，草稿照 B 页在话术原则里插「，一句就够，别连发三句恭喜」、把一处 `search_routes` 写成 `search_route`，异议处理加一条；浅色、深色各一轮，探针在仓库外）：
  - 1440 宽：卡片 (384,234) 688 宽，内边距 24 24 24 12；正文 16px/28px、Geist 字栈，正文区 652 宽（行宽 640）；节标题 16/24/600，说明行「可编辑·910 → 922字（+12）」。芯片 22 高，中文名 14/500 text、原名 Geist Mono 12.5 text-3，`--subtle` 底、圆角 6、内边距 0 6，4 个芯片都在一个盒子里（改之前中文名与原名是部件加标记两个盒子，测到过中文名在上一行末尾、原名在下一行开头）；`search_route` 照原文。列表项正文缩 20，圆点 5×5 在 (6,12)，空开的行上边距 12、圆点下移到 24。竖条在正文左 12、2px，浅色 `#2B63E6`、深色 `#2F68EB`，画在改到的两行上（不是整段，评审之后改成整段，见下）；新加的字浅色底 `#EDF3FE`、深色 `#15274D`。✗ ✓ 各 16×16、线宽 2.25。点进带粗体的一行，这一行露出两个「**」（text-3），别的行照藏；卡片换成 accent 描边加光晕。在行末打「再补一句」：这几个字标出来、这一行加竖条，说明行 +4。
  - 固定规则节（转人工条件）：「固定规则·什么时候转人工，要和系统的转人工判断一致。这里改不了，要改请联系技术。」13/20 text-2，前置 14 的 lock；正文 text 色、不可编辑，标题里的工具名照原文、正文里的做成芯片。匿名：没有说明行，正文不带「## 话术原则」，5 个芯片，没有改动标记。坐席：说明行「910 → 922字（+12）」，只读，改动标记照画。家装整装假包：芯片是「查套餐 search_packages」「算估价 create_estimate」「量房时段 measureSlot」「起装面积 minArea」，`unknown_tool` 照原文，✗ ✓ 是图标。
  - 在带粗体和芯片的列表项上连打 200 个字、连删 200 下：两套主题报错 0 条（第 5.1 步的 #185 没有再出现），每次 dispatch 约 0.1 ms。CDP 模拟输入法在芯片前组字「你好」：提交后正文 +2，芯片还在。
  - 骨架与成品同位：成员的节标题 (384,176)、说明行 (384,202)、卡片 (384,234)，匿名的节标题 (384,174)、卡片 (384,210)，逐一相同。1100 宽（目录是下拉）卡片 688 宽；375 宽（坐席、匿名）卡片 327 宽，没有横向滚动，芯片不出卡片。
  - WebKit 与 Firefox（都不支持 `text-spacing-trim`）：话术原则里 18 处 `.halt`，`font-feature-settings: "halt"`，含「（最重要的一条）**：」里藏掉「**」以后的「）」。Firefox 两套主题 `securitypolicyviolation` 0 次；WebKit 在截图之前 0 次，每截一张图多一次 `style-src-elem`：Playwright 在 WebKit 上截图时插一段样式，被页面 CSP 拦下（不截图时不出现，与页面代码无关）。
  - Chromium 两套主题所有场景 `securitypolicyviolation` 0 次，控制台错误 0 条（匿名时 `/me` 的 401 是网络日志）。
- 偏离与取舍：
  - B 页说明行末尾的「查看本节改动」没做：它要一份这一节相对线上的差异，spec 没写它打开什么；逐节差异在第 6.3 步的发布抽屉里做，那时再接这个链接（评审之后记进 spec 顶部的 `Revisions:` 与第 6.3 步的清单）。
  - 只读的编辑器（固定规则节、只读成员、匿名）从不露出「**」：spec 写的是「光标不在那一行时隐藏」，只读时没有要改的东西，露出来只会让一行字宽跳动（评审之后 spec 同步改写，见 `Revisions:`）。
  - 列表之外的 markdown 不渲染：编号列表「1. 」照原文（spec 只要求列表圆点），`###` 之类话术里没有。顶格列表项之间空 12 照 B 页。
  - 芯片不是部件加标记，而是 `EditorView.outerDecorations` 里的一个标记，中文名是 `::before`：部件和标记是两个盒子，会被折到两行；放在外层，新加的字、粗体只在它里面，不会把它拆开。行首的「- 」、缩进、藏起来的「**」和图标是整块，光标跳过、退格一下删掉。
  - lucide 的图标在 CodeMirror 的部件里自己画 SVG，图形数据从 `lucide-react/dist/esm/icons/{x,check}.mjs` 的 `__iconData` 取（1.48.0 没有 `exports` 字段，单个模块可以直接 import），类型声明在 `console/src/sop/lucide-icons.d.ts`；✗ ✓ 在源码里按码位写，不进 UI 字体子集。
  - 只动空白的改动不标，与第 5.1 步额度条、目录的规范化同一口径；换来的是在行中间多打一个空格照样标。
  - 编辑卡片获得焦点时的描边与光晕是设计系统 §3 文本域的规矩，B 页样张没画焦点态。
- 没有新增依赖。
- `pnpm test` 全过：`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条连真实 Postgres 部分一起跑。
- 留给后面的步骤：
  - 第 5.3 步：1280–1439 与 <1280 的布局（中栏现在最宽 688，右栏还没有）；窄屏下卡片的内边距仍是 24。
  - 第 6.2 步：不认识的名字的 danger 波浪线与行内提醒（编辑器现在只把认识的名字做成芯片，别的照原文）。
  - 第 6.3 步：「查看本节改动」；01 的逐节对比（`SectionDiff`）深色下仍是 `@codemirror/merge` 的浅色样式与红色删除，发布抽屉换掉它时覆盖。
- 评审之后（同日，评审报的五条都改了）：
  - 竖条只画改到的那一行（中）：spec 与设计系统 §6.5 要的是「与段落等高」，B 页上一处改动的竖条从「② 没说目的地…」画到「…不要等下一轮。」。`editor.ts` 加 `paragraphLines`：改到的行扩到所在的段落再加 `sop-changed`。段落是空行隔开的一块，块里每个顶格的列表项（「- 」「* 」「+ 」和「1. 」「1) 」）连同下面的行（缩进的续行、下一级列表项、没缩进也不是列表项的行）各是一段，第一个列表项之前的行是一段，空行自己算一段。`draftMarks` 仍按行报改动（自测照旧钉逐行的口径）。
  - Chromium 不挤隔着藏掉的「**」的两个标点（中）：「**」用 `Decoration.replace` 藏起来，DOM 里是 widget buffer 加不可编辑的空 span，原生的 `text-spacing-trim` 不把两边当成挨着的，「（最重要的一条）**：」在 Chromium 里空出整字。挤压挪进 `haltChars(text, hidden, fallback)`：回退时照旧按看得见的字全算；支持时只补原文里不挨着、藏掉中间的字以后挨着的几对（逐对调 `haltIndices`，它本来只看相邻的一对）。
  - 匿名打开固定规则节的骨架少一行（低）：`SopSkeleton` 的说明行改由 `meta` 决定；`SopPage` 取地址上的 `section`，用行业包的 `sopSections` 按 `resolveSection` 同一口径定出要打开的节（`resolveSection` 与 `defaultSection` 的参数放宽成只要 `key`、`locked`），成员或这一节带锁时画。
  - spec 没有记两处偏离（低）：spec 顶部加一行 `Revisions:`（只读的正文一直藏「**」，「编辑器」那一条同步改写；「查看本节改动」随第 6.3 步做），第 6.3 步的清单列上这个链接。
  - 两处行为没有测试（低）：`selftest-env.ts` 让 `CSS.supports('text-spacing-trim', …)` 答不支持，整个话术自测按 Firefox、Safari 跑（`needsTrimFallback` 为真，此前 happy-dom 一律答支持），5.1 的断言都不受影响；挂着的 `SopEditor` 不传 `halt` 也出 `.halt`（「）」「」」）。失焦以后「**」藏回去、再获得焦点（选区没动）又露出来：CodeMirror 焦点事件之后隔 10 ms 才通知，自测等 30 ms。另加段落（续行、下一级、编号、空行、没缩进的续行、几处合并）、`haltChars`（回退、支持时只补隔着的、开标点挤后一个）、支持时 `EditorState` 上只有「）@**」、骨架（组件与整页：匿名默认节、固定规则节、不认识的节、可编辑节、成员）。273 → 293 条断言，约 3.7 秒，`pnpm test` 的调用不变。
  - 变异（仓库外的隔离副本 `mut-ux-sop/ux52-r2`，66 例全部让自测失败并点名，还原后与 worktree 逐字节相同）：上一轮的 45 例（挤压与骨架的 3 例按新代码改写）；评审存活的 2 例（更新时不看 `focusChanged`、`haltFallback` 的默认值写死 `false`）；段落 11 例（不扩、往上或往下越过列表项或空行、不往上或往下扩、编号不另起、下一级也另起、空行也扩、不排序）；挤压 4 例（支持时一个不加、每一对都加、加在前一个字上、回退也只补隔着的）；骨架 4 例（按身份画、页面不看固定规则节、看反了、不认默认节）。
  - preview 实测（Chromium，CSP 同线上，接口由 `page.route` 拦截，数据与草稿同上一轮；浅色、深色各一轮，探针在仓库外）：话术原则的竖条画在第 1–8 行（第一条列表项整条）和第 17 行（先共情那条），相邻两行上下沿相接（258→314→370…→650），颜色同上一轮；在第 3 行末尾打字，竖条不变、说明行 +1。「（最重要的一条）**：」的「）」在 x=636、宽 8，「：」紧跟在 644，与 Firefox、WebKit 的 636+8、644 相同（评审时 Chromium 是 636+16、652）；光标点进这一行露出「**」，「）」回到 16 宽，失焦后又挤、「**」藏回去。另三处在固定规则节里：「贯穿全程）**：」的「）」、「错开旺季」**：」「跟您确认」**：」的「」」都挂上 `.halt`、宽 8。骨架与成品：匿名打开转人工条件，骨架节标题 (384,174)、下一行 (384,200)、卡片 (384,232)，成品的锁定说明与卡片同位（评审时骨架卡片在 210）；匿名默认节、不认识的节仍是 (384,174)、(384,210)；成员两种都是 (384,176)、(384,202)、(384,234)。375 宽匿名打开这一节：骨架多了那一行，但成品的节标题与锁定说明各折成两行（48、40 高），骨架按一行画，卡片差 44；没有横向滚动。Firefox、WebKit 仍是 18 处 `.halt`，竖条同 Chromium。所有场景 `securitypolicyviolation` 0 次；控制台只有匿名时 `/me` 的 401（网络日志）。
  - 构建：入口集合 gzip 316,860 → 316,861 B；换页最多仍是产品库 247,038 B；话术页自己要下的 JS（gzip -9）203,588 → 203,819 B（+231），CSS 不变。字体不用重切（776 个码位、159,024 B）。`pnpm test` 全过，`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条连真实 Postgres 部分一起跑。
  - 取舍：编号列表「1. 」照原文显示、不加圆点和空开，两条相邻的编号项都改过时竖条连成一根；空行上的改动（在段落中间插空行）竖条只画那一行。

### 第 5.3 步（2026-09-28）

- 做了什么：
  - `console/src/sop/autosave.ts`：自动保存的状态机 `createAutosaver`（不依赖 React，计时器可以换）和接到页面上的 `useAutosave`。停止输入 1.5 秒后 `PUT /sop/draft`，只发本地改过、规范化以后与草稿不同的节（原文照发，服务端自己规范化）；每次带 `rev`：首次 `rev: null` 加 `basedOn`（当前线上版本），之后取上一次成功响应的，本地没有待存的改动、也没有请求在路上时才跟着服务端给的草稿走。同一时刻至多一个请求，路上又要求存过的，回来以后马上接着存。失败分三类：连不上、5xx、429 按 2、5、15 秒退避，之后每 15 秒，`online` 事件马上试；别的 4xx 不自动试，等下一次改动或「重试」；409（`rev_conflict` 与并发首次保存的 `conflict`）停住。`⌘S` / `Ctrl+S` 马上存并拦下浏览器的「存储网页」，只读成员不拦。
  - `console/src/sop/SaveParts.tsx`：状态句最后一段（「保存中…」「已自动保存14:30」、danger 的「没保存上 · 重试」，「重试」是按钮；两行看不见、高 0 的占位按最宽的两种写法撑宽）；409 横幅（「草稿刚被别人改过」，点名没存上的节，「载入最新草稿」，技术详情折叠）；载入以后的只读对比（左边载入时草稿里的这一节、右边你写的，「关掉对比」，01 的 `SectionDiff` 换成令牌色）。
  - `console/src/sop/SideCards.tsx`：检查清单（7 项名字取 `SOP_CHECKS`，没跑过是「还没跑」）与「话术里可以点名的工具」（行业包的 `vocabulary.tools`，每行一个芯片，卡底说明；包里没有工具时不画）。
  - `SopPage.tsx`：页头去掉 01 的「保存草稿」，剩丢弃、检查、发布，有没存上的改动、请求在路上、409 停住时不能点。409 以后编辑器只读（`SectionPane` 的 `frozen`）；载入最新草稿重取 `/sop`、清掉本地改动、自动保存接着来。离开保护管到没存上的改动与还开着的对比，换节不拦。存上以后按返回的草稿更新 `/sop` 缓存（`outline.ts` 的 `withSavedDraft`，字数重算），检查结果作废。连不上只写在状态句里，别的失败按 `ERROR_COPY` 在页头下加横幅；已经有数据时重取失败就地报错，页面不卸下。三栏改成网格的四格（目录、中栏、检查清单、工具），DOM 顺序固定，放在哪一栏由 `sop.css` 的容器查询定，骨架用同一个网格；窗口 <992 时编辑卡片内边距从 24 24 24 12 收成 16 16 16 4（第 5.2 步留下的）。
  - `sop.selftest.tsx` 第 9 节：纯函数（失败分类、退避、快捷键、哪些节算没存上、存上以后的缓存）；状态机（假计时器：防抖、单请求、退避、409、4xx、恢复联网、卸下、改回原样）；整页对假服务端（rev 链、状态句、⌘S、断网与离开保护、409 冻结与载入、422、rev 只跟自己存上的走、编辑中降成只读）；各身份的网格格子。293 → 385 条断言，约 6.5 秒，`pnpm test` 的调用不变。
- 变异（仓库外的隔离副本 `mut-ux-sop/ux53`）：第一轮 62 例，53 例失败并点名，存活 9 例。三例是重复的判断：409 的检查在 `flush` 和 `run` 里各一份，409 分支里的 `clearRetry()` 永远清不到东西（请求在路上时没有等着的重试），删掉 `run` 里那份和这一行。两例是卸下时的计时器：自测等计时器跑完才数，数不出差别，改成卸下后马上数。另四例补了用例：422 回来时路上又改过要马上再试；409 回来时路上打字留下的防抖要清；存上以后字数按返回的草稿重算（原夹具存前存后字数相同）；编辑中降成只读不再发。9.3g「有没存上的改动时不跟别人的 rev」原先测不到东西：React Query 隔一个宏任务才通知，页面还没按 rev 99 重渲就按了 ⌘S，改成先等 20 毫秒。第二轮 64 例（按新代码改写 3 例，另加 `run` 不看卸下、`edited` 不看 409、`edited` 不看卸下 3 例）全部让自测失败并点名，每例限时 300 秒，还原后与 worktree 逐字节相同。第一轮跑到页面那一段时我在同一个副本里手动改过一处，那几例的结果不作数，所以第二轮是整份重跑。
- 构建：入口集合 gzip 316,861 → 315,268 B（−1,593：第 5.2 步时单独一块的 `typography`（9,297 B）被 rolldown 并进了 index，index +7,699）。换页最多仍是产品库，247,038 → 247,124 B（+86），余 2,876 B。话术页自己要下的 JS（按静态 import 从 `sop.lazy` 出发、入口集合以外，gzip -9）203,819 → 206,261 B（+2,442），CSS 1,511 → 2,196 B。字体不用重切：界面用到的 594 个汉字都在 UI 优先片里（776 个码位，159,024 B）。
- preview 实测（Chromium，Playwright，CSP 同线上，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30，草稿 rev 4；浅色、深色各一轮，探针在仓库外）：
  - 1440 宽、侧栏收起（内容 1312）：目录 (88,176) 264 宽，中栏 (384,176) 688，右栏 (1104,176) 296，与 B 页的 264 / 32 / 688 / 32 / 296 一致；检查清单 312 高，工具卡片在它下面 16（y 504）；跑过一次检查，清单多了技术详情、344 高，工具卡片跟着到 536。
  - 1300 宽：目录 (80,176)，中栏 892 宽、卡片 688，检查清单在目录下面 24（(80,834)，264 宽），没有工具卡片。1440 宽展开侧栏：目录 (272,176)，检查清单 (272,834)，同样没有右栏。1100 宽：下拉 (80,228) 988 宽，卡片 688，检查清单在编辑器下面 24（(80,1323)，688 宽）。都没有横向滚动。375 宽（坐席、匿名）：没有横向滚动，卡片 327 宽、内边距 16 16 16 4。
  - 骨架与成品同位：1440 的目录第一行 (88,220)、节标题 (384,176)、卡片 (384,234)，1300 的 (80,220)、(376,176)、(376,234)，逐一相同。
  - 自动保存：打完最后一个字 1,451–1,465 毫秒后「保存中…」，PUT 带 rev 4、basedOn v2，只有话术原则一节；⌘S 约 210 毫秒内发出，带第一次响应的 rev 5，之后 1.8 秒不再多发。保存那一段在没写、保存中、已保存、没保存上四种状态下都是 116.3 宽（两个占位也是 116.3），状态句 20 高；「没保存上」浅色 `#B42318`、深色 `#FF9B8F`。
  - 连不上：状态句「没保存上 · 重试」，页头下没有横幅；点侧栏离开弹「有改动还没保存」，留下以后地址不变；自动重试的间隔 2,001–2,003 与 5,001–5,004 毫秒；`online` 事件马上发一次并存上；「重试」按钮马上发一次。
  - 409：横幅点名话术原则，编辑器 `contenteditable=false`，⌘S 以后 3 秒没有请求；载入最新草稿：一次 `GET /sop`，编辑器能改，对比在页头下 (88,104) 1312 宽、左右两栏，接着存带载入的草稿的 rev 20。载入时 `GET /sop` 答 503：冲突横幅下只多一条「服务暂时连不上」，编辑器还冻着，重试以后载入成功。对比的颜色：浅色左边改到的行 `--subtle`、右边 `#EDF3FE`，沟槽 `#63636B` 与 `#2B63E6`；深色 `rgba(255,255,255,.06)` 与 `#15274D`，沟槽 `#91919A` 与 `#2F68EB`；折叠行是 `--subtle` 底（merge 自带的浅色底在深色下是一条白带）。
  - Firefox、WebKit（1440，两套主题）：状态句 20 高，保存那一段 116.3 宽，四种状态下位置不变。WebKit 起初把保存那一段折到第二行（状态句 40 高：它给这个 flex 项算的宽度比内容窄十几 px），状态句改成占满这一行（`flex: 1 1 auto`）以后同 Chromium。
  - 所有场景 `securitypolicyviolation` 0 次（WebKit 每截一张图多一次 `style-src-elem`，同第 5.2 步，是 Playwright 截图时插的样式）；页面错误 0 条；控制台只有浏览器给故意失败的请求记的 `Failed to load resource`（连不上、409、503，匿名时 `/me` 的 401）。
- 偏离与取舍（前五条记进了 spec 顶部的 `Revisions:`）：
  - 只有暂时的失败自动重试；别的 4xx 原样再发还是失败，等下一次改动或手动「重试」。
  - 409 一律按「草稿刚被别人改过」处理，含并发首次保存撞上的 `conflict`；载入以后对比留在页头下、只读，关掉之前离开照拦。
  - 状态句只给保存那一段预留宽度；「草稿改了N节」与「没有未发布的改动」互换时不补齐。
  - 右栏按内容宽度判断（≥1280，评审后由 1312 改，见下），展开侧栏放不下时同 1280–1439；1280–1439 与 <1280 都不画工具卡片（spec 只说检查清单挪到哪里）。
  - 「出错」的整块错误加重试只用于第一次没取到。
  - 编辑中被降成只读成员（重取 `/me` 以后）：没存上的改动不再发（发了也是 403），离开照拦。
  - 吸顶条里看不见保存失败，记在「Open」待 owner。
  - 只读成员没有检查清单（第二轮评审后记上，spec `Revisions:` 第五条）：检查接口只给能编辑的成员，只读成员没有「检查」、
    也不自动保存，清单只能一直写 7 个「还没跑」。右栏只有工具卡片，1280–1439 与 <1280 时是目录加中栏。
  - 输入法组字的时间不算「停止输入」（第二轮评审后，spec `Revisions:` 第六条）。
- 没有新增依赖。
- `pnpm test` 全过：`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条连真实 Postgres 部分一起跑；话术自测 385 条。
- 留给后面的步骤：
  - 第 6.2 步：每次自动保存后检查；检查清单的「每次自动保存都会跑 · 上次14:05」。现在仍是 01 的做法：点「检查」跑一次，结果列在右栏清单里，存过一次就作废。
  - 第 6.3 步：发布条与发布抽屉（对比用的仍是 01 的 `SectionDiff`，这一步只在「你没保存上的改动」里换了令牌色）；Open 里吸顶条看不见保存失败的那一条。
  - 第 7 步：页头的「更多」与「版本记录」（现在还是 01 的丢弃、检查、发布和页面底部的版本历史）。
- 评审后补的（同日）：
  - 接连两次 409 冲掉第一批对比：别人接着在存（每 1.5 秒一次）时，载入以后再打字很快又是 409，原来这时整批换掉，
    第一次没存上的一大段就找不回来了。现在对比按批接在后面，一次 409 一批，关掉之前一直留着，又一次 409 时也照样显示；
    同一节有几份时节名写「话术原则（第2次没存上）」。停住时点「关掉对比」只关掉已有的对比，这一次没存上的节载入以后照样接上来
    （原来一并丢掉）。
  - 在一节长正文的下半截打字时 409：页头已缩成吸顶条，横幅和状态句都在视口外，编辑器变成只读、再敲的字没有反应，页面上看不出为什么。
    现在停住的那一刻横幅滚进视口（按底边对齐，横幅紧挨着页头，视口放得下时滚到顶，状态句「没保存上」也露出来）；
    焦点原来在编辑器里的，移到横幅外层（`tabIndex=-1`，不画焦点框），下一个 Tab 是「技术详情」、再下一个是「载入最新草稿」，
    不直接落在按钮上，免得接着敲的空格、回车把它按下去；焦点在目录等别处时不抢。编辑器变只读是整个重建的，
    旧的正文一拿掉焦点就掉到 body 上，所以用 layout effect 赶在那之前看焦点。Open 里那一条随之收窄到连不上与别的 4xx。
  - 右栏的门槛由内容宽 1312 改为 1280：原来只在浮层滚动条下成立，常显的滚动条（15–17）让 1440 宽、侧栏收起时的内容宽只剩 1297，
    右栏不出来、工具卡片消失。现在差的宽度由中栏让出来（最窄 656）；展开侧栏时 1440 宽内容 1128，仍是两栏。
  - 自测补了评审点出的存活变异：离开这一页（放弃改动并离开）时还在数的防抖、连不上时等着的重试都不再发；
    路上要求过接着存、又打了字、防抖还在数时答 422，不马上再发；保存那一段是 `role=status`、占位 `aria-hidden`；
    接连三次 409（对比按批留着、节名的第几次、停住时关掉对比）；409 时横幅滚进视口与焦点（在编辑器里时移、在目录上时不抢）。
    假服务端按住的请求改为放开时按那时的 mode 回。385 → 396 条断言。
  - 变异（仓库外的隔离副本 `mut-ux-sop/ux53-r2`，每例限时 300 秒）18 例全部失败并点名：409 时丢掉已有对比、载入时整批替换、
    停住时关掉对比连这一批一起丢、停住时不显示对比、横幅区不看对比、nth 恒为 1、节名不写第几次、不移焦点、焦点总是抢、
    不滚动、换成普通 effect、effect 每次渲染都跑、外层没有 `tabIndex`、焦点落在按钮上、卸下时不 `stop()`、
    4xx 分支不看防抖、保存那一段不是 live region、`stop()` 不清重试（后一例只有第 9.2 节的状态机用例拦得住：
    页面卸下以后 `active` 为 false，重试到点也不发，页面级是等价的）。
  - preview 实测（Chromium，CSP 同线上，`page.route` 拦接口，假服务端按 rev 严格判 409；浅色、深色各一轮）：
    - 常显滚动条（只这一组用 `bypassCSP` 注入 15px 的滚动条样式）：1440 宽侧栏收起，内容 1297，目录 (88,176) 264，
      中栏 (384,176) 673，右栏 (1089,176) 296，工具卡片 (1089,504)；展开侧栏 1113，两栏，检查清单在目录下面 (272,834)。
      1600 宽展开侧栏：浮层滚动条内容 1288，三栏、中栏 664；常显滚动条 1273，两栏。浮层滚动条下 1440 收起、1440 展开、
      1300、1100、375 的位置与第 5.3 步的实测逐一相同，都没有横向滚动。
    - 409：在话术原则末尾打字（`scrollTop` 562，页头已吸顶）时 409，之后 `scrollTop` 0，页头展开、状态句末尾「没保存上」，
      横幅 y 104–208，「载入最新草稿」y 115；焦点在 `.sop-conflict` 上、没有焦点框，再敲的字不进编辑器；Tab 依次到「技术详情」
      「载入最新草稿」。1440×700 同样滚到顶。Firefox 同 Chromium；WebKit 滚动与焦点相同，Tab 按 Safari 的默认跳过按钮
      （Option+Tab 才到），是浏览器设置。
    - 接连三次 409：第二次 409 时第一批对比还在；载入以后两份，节名「话术原则（第1次没存上）」「话术原则（第2次没存上）」，
      两次写的字都在页面上；第三次 409 后点「关掉对比」，横幅照样点名这 1 节，载入以后这一批变成对比；接着存带载入的 rev 92。
    - `securitypolicyviolation` 0 次（WebKit 截图时插的样式照旧记一次，不截图时 0 次）；页面错误 0 条；控制台只有故意答 409 的
      `Failed to load resource`（WebKit 另有 index.html 预载字体「几秒内没用上」的提示，与本步无关）。
- 第二轮评审后补的（同日）：
  - 输入法组字时照样自动保存：在候选框上停 1.5 秒，没上屏的拼音「ni hao」就 PUT 进了草稿，状态句写「已自动保存」；
    409 在组字时回来，编辑器整个重建、字被打断，拼音进了对比。现在状态机每次要发之前问一句编辑器在不在组字
    （CodeMirror 的 `view.composing`，经 `SopEditor.tsx` 的 `composingIn`），在组字就过 1.5 秒再看：计时到了、`⌘S`、
    自动重试、路上的请求回来要接着存，都等字上屏（上屏本身也是一次改动，从那时重新数）。409 在组字时回来，自动保存马上停
    （打字、`⌘S`、恢复联网都不发），状态句还是「保存中…」，每 100 毫秒看一次，字上屏以后才通知页面冻结编辑器，
    对比里是上屏的字。不用 compositionstart / compositionend 事件：Safari 的死键组字有时不发 compositionend，CodeMirror
    自己补了，事件上看不到，状态会一直卡在「组字中」；Android 上 CodeMirror 走 EditContext，DOM 上没有这两个事件。
    也不用 `compositionStarted`：Android 上光标放进一个词就算开始组字。
  - 丢弃、发布以后状态句还写「已自动保存14:30」（「没有未发布的改动 · 已自动保存14:30」）：两处成功以后 `resume()`，
    保存那一段清空；之后再改从新建草稿存起（rev 为 null）。
  - 按「载入最新草稿」「关掉对比」以后，按钮跟着横幅、对比卸下，焦点掉到 body 上，读屏什么也不念。现在载入以后焦点到对比的
    标题上（`tabIndex=-1`，同横幅外层不画焦点框），没有对比时回到编辑器；关掉对比回到编辑器，还冻着时回到横幅。
    焦点已经在别处的不抢（鼠标点按钮时 Safari 不给按钮焦点，焦点可能还在目录上）。
  - 自测补了评审点出的三个存活变异：载入最新草稿以后检查结果作废（9.3e 先跑一次检查）；409 以后 `resume()` 退避从 2 秒重新算
    （9.2，先重试到 15 秒那一档）；匿名重取失败的横幅（9.3o）。另两例（`clean` 里的 `saving`、`conflict`）同评审，是等价的。
  - 只读成员没有检查清单：不改，记进 spec `Revisions:` 与上面的「偏离与取舍」。
  - 自测 396 → 426 条断言：状态机里的组字（计时、`⌘S`、重试、接着存、409 等上屏、等上屏时卸下）与 resume 后的退避；
    整页的组字（happy-dom 里没有输入法，接管 `view.composing`）、丢弃与发布以后的状态句、载入与关掉对比以后的焦点、匿名重取失败。
    新断言里比 DOM 节点的一律先转成布尔：`eq` 打印不了节点，变异时整份自测崩掉、不点名是哪一条。
  - 变异（仓库外的隔离副本 `mut-ux-sop/ux53-r3`，每例 `node --import tsx` 单进程、限时 300 秒）23 例全部失败并点名：
    组字 11 例（`run` 不看组字、组字时不再计时、409 不看组字、不再接着看、409 不置停住、`edited` 与 `flush` 不看停住、
    卸下时不清等上屏的计时、`resume` 不清停住、页面恒答不在组字、改看 `compositionStarted`）；丢弃、发布以后不清 2 例；
    焦点 7 例（载入、关掉不记要去哪，抢焦点，不看冻着，不去标题，标题不接 ref，标题没有 `tabIndex`）；评审的 3 例。
  - preview 实测（Chromium，CSP 同线上，`page.route` 拦接口；浅色、深色各一轮）：
    - 组字：CDP `Input.imeSetComposition` 打「ni hao」、停 3.5 秒，0 次 PUT、状态句没有保存那一段；`Input.insertText`
      上屏「你好」以后 1,503–1,506 毫秒 PUT，带「你好」、不带拼音。PUT 在路上时开始组字「yi」，这个 PUT 答 409：
      1.2 秒后编辑器仍可编辑、没有横幅、状态句「保存中…」；上屏「乙」以后冻住、横幅出来、焦点在横幅上；载入以后对比右边有
      「甲乙」、没有「yi」，焦点在对比的标题上。
    - 丢弃以后状态句「线上v2 · 老板发布于9月25日 18:30 · 没有未发布的改动」，保存那一段空；再改首次 PUT 带 rev null；
      发布以后「线上v3 · 老板发布于9月26日 14:31 · 没有未发布的改动」，保存那一段空。
    - 键盘：409 以后焦点在横幅上，Tab、Tab 到「载入最新草稿」，Enter 以后在「你没保存上的改动」标题上（`outline` none），
      下一个 Tab 是「关掉对比」，Enter 以后回到编辑器正文；冻着时关掉对比，焦点回到横幅，下一个 Tab 是「技术详情」。
    - `securitypolicyviolation` 0 次，页面错误 0 条；控制台只有故意答 409 的 `Failed to load resource`。
  - 构建：话术页自己要下的 JS（gzip -9）206,489 → 206,695 B（+206），CSS 2,205 → 2,217 B（+12）。没有新的界面文字，字体不用重切。
  - `pnpm test` 全过：`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条连真实 Postgres 部分一起跑；
    话术自测 426 条。没有新增依赖。

### 第 15 步（2026-09-28）

- 做了什么：
  - 登录页 `console/src/pages/LoginPage.tsx` 重做：`--frame` 底上一块内嵌的内容面板（与外壳同一副骨架），一栏 360 宽、水平居中，从视口高度的 20% 处起（`clamp(32px, 20vh, 200px)`）；标题「运营后台」用 display 36/44/600；说明一句 14/22 text-2，在逗号处断行；然后是表单。不用 Card，没有品牌色块。
  - `console/src/LoginForm.tsx`（登录页和就地登录框共用）换成自己的标记，不再用 antd Form：标签在上 13/20/500、不加冒号，标签到控件 6、字段之间 20；邮箱 `type="email"`、占位符「例：name@example.com」，`maxLength` 与 `LoginBody` 的上限相同；密码 `Input.Password`。没填就提交不发请求，控件下方就地写「没填邮箱」「没填密码」（13 danger，前置 14 的 circle-x，设计系统 §5.2），`aria-invalid` 与 `aria-describedby` 连上，焦点到第一个没填的，填上就消失。服务端的错在按钮上方的页内 Alert 里，文案取 ERROR_COPY：「邮箱或密码不对 · 检查后重试」、429「尝试太频繁 · 稍后再试」、连不上「服务暂时连不上」加「重试」（按原样再提交）；detail 只在折叠的技术详情里，不弹 toast。提交中按钮 loading，再按回车不重复提交。登录页的控件与按钮高 40：CSS 只改高度，字仍是 14（antd 的 large 会把字换成 16）；就地登录框里照常 32。样式在 `console/src/login.css`，由 `main.tsx` 全局引一次。
  - 「返回演示」：`Viewer` 的 `login` 带上可选的 `demo`（原来的匿名视图）。侧栏与 ⌘K 的「登录」、横幅的「登录后编辑」都经 `viewer.ts` 的 `toLogin` 进登录页，只有从 demo 匿名来的才带。表单下方的「返回演示」是指向当前地址的真链接（`location.publicHref`，带 `/console` 与 search）：左键就地换回原来的匿名视图，不重新取 `/me`、`/pack`，地址不变，焦点放到外壳的 `main`；带修饰键或中键交给浏览器。标签页标题：从演示来是「登录 · 演示」，prod 是「登录」。
  - 服务端：登录失败的 `detail` 改为「邮箱或密码不对」，`PasswordBusyError` 改为「密码校验排队超时，请稍后再试」。`console.selftest.ts` 加两条断言（276 → 278 条），原有断言不动。运维日志与命令行里的「口令」没改：spec 只要求改 `detail`，日志的写法由原有断言钉着。
  - `console/src/pages/login.selftest.tsx`（83 条，约 2.3 秒）串进 `pnpm test`，排在审计日志自测之后，CI 注释同步。在 happy-dom 里挂真的 `Shell`（外面照 `main.tsx` 包 `ThemeProvider` 与 `App`），加照服务端规则的假接口，覆盖：prod 登录页的版式与文案、没填、三种服务端错与重试、提交中、登录成功后进成员外壳且地址不变、demo 从侧栏与横幅进来、「返回演示」的地址与修饰键、返回后不重取、焦点。`Shell` 经「关于」在模块顶层读 `import.meta.env.BASE_URL`，Node 里没有这个对象。所以自测先用 `module.register` 注册一个载入钩子，把 tsx 转好的源码里的 `import.meta.env` 换成构建时的值，再动态 import `Shell`。
- 数字（与 `origin/dev` 用同一套算法对比）：首屏 JS 362,029 → 329,547 / 420,000 B（−32,482）。旧登录页的 antd `Form`、`Card`（连带 `Tabs`）、`Typography` 不再进入口集合，挪进用到它们的页面块。换页最多仍是话术页，201,830 → 226,997 / 250,000 B，多出来的主要是 `Tabs`、`Typography`。UI 优先片不变（784 个码位、160,768 B）：新文案的字都已在片里，在合并结果上重跑 `scripts/fonts/build.ts`，产物逐字节相同。
- preview 实测（Chromium，Playwright 1.63，CSP 同线上，接口由 `page.route` 拦截，浅色、深色各一轮，1440 与 375，探针在仓库外）：
  - 1440：面板四周内嵌 8、圆角 12；一栏 x 540、宽 360，标题顶 188；标题 36/44/600 text；说明 14/22 text-2 两行；标签 13/20/500 text，标签到控件 6，字段之间 20；输入框与按钮高 40、字 14，按钮墨色；邮箱自动聚焦（`--accent` 描边加 3px 光晕）。没填时两行原因 13 danger、14 的图标，输入框的描边与光晕换成 danger，标题仍在 188。Alert 出错色底、圆角 8，在按钮上方 20，技术详情折叠；连不上时右侧有「重试」，点了再发一次登录。Tab 到技术详情的 summary，焦点框 2px `--focus`、外移 2。
  - 登录成功后进成员外壳，地址仍是 `/console/catalog/route?status=draft`，标签页标题「线路 · 云途定制旅行」。
  - demo：侧栏「登录」进登录页，「返回演示」的 href 是 `/console/catalog/route?status=active`，标签页标题「登录 · 演示」；点它回到线路页，地址不变，没有多取 `/me`、`/pack`，焦点在 `main`。横幅的「登录后编辑」进来同样有「返回演示」。
  - 就地登录框（登录后让会话失效再换页）：同一个表单，控件 32，没有「返回演示」；登录后停在会话页。
  - 375：面板内边距 16，一栏 327，页面不横向滚动。
  - 两套主题的各场景 CSP 违规 0 次，控制台错误 0 条；axe（wcag2a、wcag2aa、best-practice）在登录页和出错态都是 0。这一轮没开 wcag22aa，密码框的眼睛只有 14 见方，过不了 `target-size`，见下面「评审之后」。
- 变异（仓库外的隔离副本，每例 300 秒超时，37 例）：36 例由具名断言点出，涵盖外壳与横幅不带 `demo`、`toLogin` 带错、「返回演示」不拦跳转或带修饰键也拦、焦点不回面板、链接不带 basepath 或 search、标签页标题、prod 也给链接、不自动聚焦、成功后不重新判断来者、没填也发请求、不聚焦第一个没填的、没点过就写原因、提交中不拦、再提交不收起旧错误、Alert 在按钮下面、不给重试或重试不提交、aria 与出错样式、标签与占位符、请求体，以及服务端的两处文案。存活 1 例是等价变异：「邮箱只有空格」不 `trim` 也判为没填，因为 `type="email"` 的输入框按 HTML 的值净化规则本来就去掉首尾空白。第一轮有 4 例是自测找不到「返回演示」时抛错崩掉，改成链接不在就不点、由断言按名字报；「没点过就写原因」第一轮存活，补了一条提交前不写原因的断言。
- 偏离与取舍：
  - 没填的原因写在控件下方（设计系统 §5.2 的出错形态），不进 Alert：spec 的 Alert 说的是服务端返回的错。两者都不用 toast。
  - 竖直方向不居中：居中时，出现「没填」的原因会让整栏往上挪，标题跟着跳。
  - 登录页没有「跳到主要内容」：它前面没有导航可跳；内容在 `main` 地标里，邮箱自动聚焦。就地登录框里不自动聚焦，照旧由 antd Modal 管焦点。第 16 步的键盘走查一并看。
  - 以上三条评审之后写进了 spec 顶部第 15 步的 `Revisions:`，「登录」「外壳」两节和设计系统 §3 随之就地改写。
  - `SessionExpiredDialog` 的 `maskClosable` 在 antd 6 里已弃用，开发构建会打告警（自测输出里也有），01 以来如此，这一步没改。
- 评审之后（2026-09-28）：
  - 读屏：原来没填就提交时，焦点先挪、原因后画，焦点落到控件上时 `aria-describedby` 还没连上；焦点本来就在那个控件上（邮箱自动聚焦后直接回车）时，焦点不动，读屏什么也不念。改为 `flushSync` 先把原因画上再挪焦点；焦点不挪时，表单里一块看不见的 polite 区域（`.login-notice`）念「没填邮箱，没填密码」，改了输入就清空。
  - 「返回演示」照 §3：高 24（56×24），键盘焦点 2px `--focus`、外移 2，不再是 antd 链接的 3px 框。密码框的眼睛（antd 给的 Tab 停靠点）点击区域补到 24 见方：内边距 5、外边距抵回去，左边只抵 4，不压到输入框上（压上 1px，axe 就算它被遮住）；焦点 2px `--focus`、外移 2；antd 给它的 `transition: all` 让焦点框从 3px 字色框渐变过来，改成只过渡颜色。控件高度不变，密码输入框窄 1px（320 → 319）。
  - 自测 83 → 103 条（约 2.4 秒）：表单 `noValidate`，两个 `maxlength`（254、1024），格式不对的邮箱与只有空格的密码照样提交、错在 Alert 里，密码框的出错样式，原因前的图标，polite 区域念与清空，Shift、Alt、中键点「返回演示」不拦；另挂一次就地登录框（`/me` 401 判为过期）：不自动聚焦、没有「返回演示」，焦点落到邮箱时原因已连上，服务端的错在框里的 Alert，登录后框收起、页面没卸载、地址不变。
  - 变异（隔离副本，每例 300 秒超时）16 例全部点出：评审列出的 10 例存活变异（去掉 `noValidate`、任一 `maxLength`、Shift/Alt 放行、中键放行、就地登录框默认自动聚焦、去掉图标、去掉密码框的出错样式、只有空格的密码算没填或拦下提交），加这次的 6 例（先挪焦点后画原因、不念、焦点挪了也念、改了输入不清空、区域不是 polite、只念第一项）。上面「变异」一条里「带修饰键也拦」「aria 与出错样式」原来只覆盖 Ctrl、⌘ 和邮箱框，说大了。
  - preview 实测（Chromium，CSP 同线上，demo 用家装假包，浅色、深色，1440 与 375）：axe 加上 wcag22aa，登录页的初始、没填、密码不对、demo 登录页、375 各态都是 0；眼睛 24×24，两套主题焦点框 2px `--focus`（浅 `#2b63e6`，深 `#2f68eb`）、外移 2；「返回演示」同样。没填后标题仍在 188；polite 区域 1×1、裁掉，不占表单间距。就地登录框里控件 32，点「登录」没填时焦点到邮箱，区域不念。CSP 违规 0 次，控制台错误 0 条，375 宽不横向滚动。成员外壳（含就地登录框打开时）axe 报一条 `region`（`.tenant-name`，侧栏租户名不在地标里），外壳第 2.2 步以来如此，这一步没碰，记进「Open」。
  - 门禁：四道都过；`pnpm test` 带 `PG_TEST_URL`（一次性的 `pgvector/pgvector:pg17` 容器，用完即删）跑全，88 秒，数据库自测 329 条含真实 PG 部分。首屏 JS 329,656 / 420,000 B，UI 优先片不变（新文案的字都在片里）。没有新增依赖。
- 分支：从 `feat/ux-14-audit`（c10a6ca）开出，中途合入 `origin/dev`（含第 9、14 步），之后合回 `dev` 不会冲突。
- 门禁：四道都过；`pnpm test` 带 `PG_TEST_URL`（一次性的 `pgvector/pgvector:pg17` 容器，用完即删）跑全，86 秒，数据库自测 329 条含真实 PG 部分。没有新增依赖。

### 第 10.1 步（2026-09-28）

- 做了什么：
  - 路由：`/catalog/$kind/$code`（search 只认 `tab`，页签本身在第 10.3 步）与 `/catalog/new/$kind` 共用懒加载块 `pages/catalog-item.lazy.tsx`；kind 按行业包取，包里没有的是「没有这个页面」。侧栏的 `selectedNavKey` 把 `/catalog/new/{kind}` 算作这一类实体。两个包的列表名称都是详情链接，引用的名称经 `FieldEnv.itemLink` 也链到详情（列表与详情），⌘K「各实体」组的一条打开详情（原来打开列表）。旅游包的「新建」仍打开 01 的旧抽屉，建好后跳到新条目的详情页；假包的「新建」照旧没反应（第 10.3 步）。
  - `catalog/detail.ts`（纯逻辑）：锁定组的计数与在哪张卡片头声明（`lockRows`、`declaringCard`、`cardLocks`、`lockTotal`，原因接统一结尾「急需修正请联系技术。」）、状态句的锁定那一段、检查项的写法（`issueText`）与指向的字段（`fieldOfPath`、`subPathOf`）、骨架高度、联想、引用指向的实体。
  - `catalog/CatalogDetail.tsx` 与 `detail.css`：页头（`PageHeader` 加可选的 `breadcrumb`、`titleStatus`，吸顶时两者收起）、两栏（736 / 24 / 368，副栏吸顶 top 76，即吸顶条 52 加 24；<1280 落到主栏下方）、分组卡片（卡片头 Tag「上架后锁定 · 识别」与原因）、只有多字段有序子项的分组不套卡片、副栏三张卡（状态与锁定组、上架前检查、最近更新）、两栏骨架、<1024 的「建议在电脑上编辑」。`pages/CatalogItemPage.tsx`：取数与各种状态（不存在；出错时面包屑还在；非编辑成员打开新建写「你的角色无法执行这项操作」）。
  - 字段：`FormField` 加「已改」、「撤销这处」（平时透明，悬停或焦点在这个字段里时出现，一直能 Tab 到）与 `data-field-key`；`FieldGrid` 加 `original`、`declaredLocks`、`onUpdate`；`model.ts` 加 `fieldChanged`、`restoreField`，`LAYOUT.span` 收字段形态；渲染器的子项带 `data-item-index`。`CheckList` 的图标换成 lucide（第 3.2 步留给这一步），`.check-item` 补 `box-sizing`（不是按钮的通过行原来宽出 16）。
  - 有改动时站内跳转与关页先确认（`useUnsavedGuard`，不变量 20）。保存条在第 10.2 步，这一步改了只能撤销或放弃。
- 自测：`fields.selftest.tsx` 1,219 → 1,297 条（新增第 9 节，第 4 节加只读跨行一条），`shell.selftest.ts` 134 → 140 条。第 9 节挂真的路由和查询缓存测整页：E 页（面包屑与 aria-current、状态句、每个锁定组的 Tag 只出现一次、4 列与锁、副栏、点锁定组焦点到卡片头、改一处只标这一处、有改动时离开被拦下与「留下」、撤销、两张卡各改一处互不覆盖）、草稿（检查实时重算，点检查项焦点进线路名称、第3天的当晚住宿、体力强度）、非编辑成员、匿名、新建、非编辑成员打开新建、假包（锁定组、主材芯片链到主材详情）、旅游包下打开假包地址、不存在、加载、出错。
- 变异（仓库外的隔离副本，55 例全部失败并由具名断言点出，还原后与 worktree 逐字节相同）：`detail.ts` 21 例、`model.ts` 6 例、`FieldGrid` 6 例、`FormField` 3 例、`CatalogDetail` 11 例、`CatalogItemPage` 5 例，另有列表名称链到列表、页签什么都认、新建不选中实体（`shell.selftest.ts` 点名）。第一轮 8 例存活：5 例补了断言（只锁成员的标签不决定声明在哪张卡、两个 key 都对得上取长的、别处声明过的组整卡锁着也挂锁、锁定字段不标「已改」、外层字段优先于排在前面的同名子字段）；1 例是变异写错（原因的结尾）；1 例是多余代码：撤销时拷贝原值，表单状态从不就地改，删掉拷贝，换成「撤销就地改」一例；「匿名当草稿」是等价变异（匿名全只读、没有副栏，状态取什么画出来都一样），不算。
- preview 实测（Playwright 1.63，CSP 同线上，端口 4234，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`，探针在仓库外）：
  - E 页 1440×1100：主栏 x 272 宽 736，副栏 x 1032 宽 368；「基本信息」4 列 169 / 247 / 110 / 97（与第 3.2 步相同）；「价格与季节」177 高、「适合谁去」353 高（E 页样张 176、353）；逐日行程区块头 y 860，第一天的当天标题下沿 996，在 1100 − 保存条 60 = 1040 之上，**当晚住宿没有**：子项卡片按子字段的顺序排，占满一行的「当天安排」夹在中间，当晚住宿在 1172–1256（评审之后改正，原来这里只量了当天标题，写成了「第一天第一行」）。第 10.3 步的页签会再往下推 56，第 11 步的时间轴去掉卡片里「D1」那一行（28），第 11 步还要把当晚住宿排到当天标题旁边，第 17 步再量。
  - 只读值的计算颜色等于 `--text`（浅 rgb(24,24,27)、深 rgb(237,237,239)），标签 text-2；字号只有 12.5 / 13 / 14 / 15 / 16 / 24，字重 400 / 500 / 600，含中文的元素 letter-spacing 都是 0。
  - 改最累的一段：只它标「已改」，「撤销这处」平时 opacity 0、悬停 1，点了回到原文；点「条款」那一行，卡片上沿停在吸顶条下，焦点在卡片头。草稿：清空线路名称，检查第一行「线路名称没填」，点它焦点回到输入框；清空第3天的住宿，「第3天：当晚住宿没填」，点它焦点进第3天的住宿；点侧栏「酒店」弹「有改动还没保存」。
  - L 页（假包）：「8项上架后锁定 · 老周更新于9月25日」，识别2 / 计价2 / 条款3 / 推荐1，适用户型只读占一格。非编辑成员：没有输入框、不挂锁，状态句「小林更新于今天10:12」加「只读」。匿名没有副栏，打开草稿是「没有这条线路」。新建：「新建线路」，检查 1/13。
  - 宽度：1280 主栏 592、副栏 368；1024 单栏 736，副栏在下方；375 宽 `scrollWidth` 375，基本信息退成两列、「建议在电脑上编辑」出现。
  - 连按：第一轮在草稿里开过一次标签下拉，再在线路名称里连按 60 个字，React 报 #185（Maximum update depth exceeded）：每按一键整页的字段都重画，下拉关上后弹层的 Portal 还挂着，它每次重画都在 effect 里 setState（话术页第 5 步遇到的同一个问题）。改成按函数写回、字段按值记忆（`FieldGrid` 的 `onUpdate`）以后，下拉、Tooltip、联想框各开过一次再连按，同一张卡、别的卡、逐日行程里都是 0 次。`ConfirmDanger` 照抄话术线的 `destroyOnHidden` 改动（逐字节相同，合并不冲突）。
  - Chromium 两套主题与 Firefox、WebKit：`securitypolicyviolation` 0 次；控制台只有故意造的 401（匿名 /me）、404、500 的「Failed to load resource」，页面代码 0 条；CLS 0（从列表点进详情 0.005）。
- 构建：入口集合 gzip 325,352 → 325,663 B；详情页换页 78,567 B，列表页 134,104 B；换页最多仍是话术页，198,573 → 200,364 B（`CheckList` 换了 lucide 图标）。旧抽屉的块 259,303 B 不是路由块，只在点「新建」时下载，第 10.3 步删掉。
- 字体：新文案带进「余拦脑急」，重跑 `scripts/fonts/build.ts`（fonttools 4.66.0、brotli 1.2.0，仓库外的副本）。UI 优先片 773 → 777 个码位，158,296 → 159,264 B（+968），两个 preload 合计 171,148 B；两个 Geist 文件、许可原文逐字节不变。面包屑地标的名字写「当前位置」，不为只给读屏的「面包屑」收一个「屑」。**合并时**三个字体文件照旧冲突，后合并的一方在合并结果上重跑 `build.ts`。
- 门禁：四道都过；`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4238，用完即删）跑了一遍，73 秒，db 自测 329 条含真实 PG 部分。
- 偏离与取舍（前四条写进 spec 顶部第 10.1 步的 `Revisions:`，第四条是评审之后补的；设计系统 §6.0、§6.4 同步）：
  - 只读的月份区间、多选 enum 在网格里占一格，可改时照旧占满一行；网格窄于 480 时收列。
  - 已上架条目的副栏没有上架前检查，草稿与新建才有。
  - 锁定组只在第一张有整字段锁定的卡片头声明一次，同组其余卡片里的字段挂锁。
  - 没有编辑权限时，状态句和状态卡不提锁定（这些字段对他并没有被锁，§6.4 不挂锁的同一个道理），状态卡写「销售助手会向客户推荐它」；匿名没有副栏（没有状态和更新人）。
  - 新建不标「已改」：没有能撤回的原文。
  - 页头的「编辑 / 预览」页签、「更多」「上架…」在第 10.3 步，这一步页头下直接是两栏。
  - 草稿里的编号照第 3.2 步挂锁，锁的名字「上架后锁定」对草稿不准确，没改。
- 留给后面的步骤：
  - 第 10.2 步：保存条接 `CatalogDetail` 的表单状态（`original`、`state`，评审之后从 `DetailBody` 提到 `CatalogDetail`；打开时的条目是 `opened`，带 `rev`）；离开保护已经挂上；报错经 `FieldGrid` 的 `errors` 按 FieldDef.key 给；`⌘S`。评审之后加的过渡「在旧表单里改」（`CatalogDetail` 的 `onLegacyEdit`，`CatalogItemPage` 里的旧抽屉、`legacyOpen` 与 `reloads`，`CatalogDrawer` 的 `draft`）在保存条接上以后删掉；状态卡「其余内容可以直接改」那时可以补回「保存后立即生效」；保存条出现时，副栏的 `max-height` 还要让出保存条的高度。
  - 第 10.3 步：页签（路由已认 `tab`）、「更多」与「上架…」、新建的保存与编号帮助、删旧抽屉（`CatalogPage` 里「新建」的旧分支、`catalogForm.ts` 的 `legacyKind`、`LEGACY` 的最后一项、`@rjsf/*`）。话术线合并后 `useUnsavedGuard` 多一个参数 `LEAVING_PAGE`，切页签不算离开时用它。
  - 第 11 步：有序子项的区块头现在是 `FormField` 的 `.field-block-row`（「已改」「撤销这处」也在这一行）；检查项跳到子项靠 `data-item-index` 和子字段的 `data-field-key`，重做编辑器时保留。**子项卡片要把当晚住宿排到当天标题旁边、同一行**（E 页首屏要求的后一半，第 10.1 步没做到）：按子字段的类型把半格的两两排进一行，不用 `grid-auto-flow: dense`（它只挪视觉位置，Tab 顺序和读屏顺序不跟着变）；排好后重量，当晚住宿的下沿要在 1040 之上。新建能加子项以后，补一条「新建里改子项不标已改」（现在新建的逐日行程是空的，没有能改的子项）。
  - 第 17 步：E 页首屏连同页签、保存条、时间轴重量：区块头与第一天的当天标题、当晚住宿都在 1040 之上。

### 第 10.1 步评审之后（2026-09-28）

- 做了什么（评审 7 条：5 条照改，2 条按评审给的另一种改法记进 spec 的 `Revisions:`）：
  - 首屏数字改正：原记录的「第一天第一行下沿 996」只是当天标题；当晚住宿在 1172–1256，在保存条上沿 1040 以下。spec 顶部第 10.1 步 `Revisions:` 的一、本步记录、第 11、17 步的交接都改了：第 11 步把当晚住宿排到当天标题旁边再量。
  - 过渡的「在旧表单里改」：列表名称改成详情链接以后，旅游包的已有条目在控制台里没处保存了（旧抽屉只剩「新建」）。01 旧抽屉认得的实体（有共用 schema 的线路、酒店），能编辑的人在详情页页头有这个按钮：带着这一页没保存的改动（`pruneHidden` 之后的表单状态）打开旧抽屉，旧抽屉的表单从这份内容起步，和打开这一页时的条目比出改动；PATCH 带打开这一页时的 `rev`，接口之后又取到新版本也不换（别人改过就是 409，不会拿旧内容盖掉）；存好以后按 `['catalog', kind]` 失效，详情页按新内容重新打开。草稿照旧能在旧抽屉里上架。表单状态从 `DetailBody` 提到 `CatalogDetail`（页头的按钮要读它）。`legacyKind` 从 `CatalogPage` 挪到 `catalogForm.ts` 两边共用。写进 `Revisions:` 六。
  - 状态卡的说明不再写「保存后立即生效」：已上架、能编辑、有锁定时写「其余内容可以直接改」，没有锁定的写「销售助手会向客户推荐它」。
  - 非编辑成员不提锁定、匿名没有副栏：评审给的两种改法取「记进 `Revisions:`」（四、五），设计系统 §6.4 补一句。理由见 `Revisions:`：非编辑成员的卡片头不声明、字段不挂锁，状态卡列出锁定组、点了跳到一张没有锁定说明的卡片，前后对不上；匿名投影没有状态和更新人，副栏只剩「已上架」。
  - 骨架高度：记进 `Revisions:` 七（同第 2.4 步），附实测。条目取到之前不知道状态和子项条数，估得再细也对不上已上架条目的 4 列卡片和 8 天的行程（3,720 高）。
  - 副栏自己滚：`.detail-side` 加 `max-height: calc(100dvh − 112px)`（`box-sizing: border-box`）和 `overflow-y: auto`，四周 2 的内边距与负外边距，卡片的描边和阴影不被裁；吸顶 top 由 76 改 74，卡片仍在吸顶条下 24。<1280 落到主栏下方时这些都去掉。
  - `CheckList` 加 `headingLevel`（默认 3，话术页不变），详情页副栏给 2：副栏三张卡的标题都是 h2。
  - 「新建不标已改」只在一处判定：`DetailBody` 算一次 `base`，卡片和有序子项的区块都用它（原来两处各写一遍，区块那处没有断言）。
- 自测：`fields.selftest.tsx` 1,297 → 1,307 条：新建主材选「延米」「套」后单价的单位跟着变；E 页有「在旧表单里改」、状态卡的说明；过渡的整条路（改一处 → 缓存里换成 rev 5 → 点按钮 → 旧抽屉带着改动 → 保存的 PATCH 是 `{ rev: 1, set: { intensity } }` → 抽屉关上、详情页按新内容重开、没有「已改」，旧抽屉在 happy-dom 里真挂）；非编辑成员、新建、假包没有这个按钮；副栏三个 h2；`sameCell` 的内容相同的新 deps 数组不算变。
- 变异（仓库外的隔离副本，13 例，还原后与 worktree 逐字节相同）：12 例被具名断言杀死，包括评审存活的两例（`depsOf` 恒为空、新建也给原文）和区块不给原文、交最新的条目（第一轮存活：换缓存后没等页面重画就点了，补 `settle`）、旧抽屉不带改动、存好不重开、存好不失效、任何实体都有旧表单、不看编辑权限、`sameCell` 不比 deps（第一轮存活，补断言）、状态说明、检查清单标题级别。1 例等价：去掉 `opened &&`（新建页不给 `onLegacyEdit`，这个判断只为收窄类型，去掉 tsc 报错）。
- preview 实测（Playwright 1.63 Chromium，CSP 同线上，端口 4234，接口由 `page.route` 拦截，PATCH 按 rev 回 200 或 409，时钟同上，探针在仓库外）：
  - E 页 1440×1100 两套主题：页头右侧「在旧表单里改」，状态卡「其余内容可以直接改」；逐日行程区块头 860–884，D1 当天标题 938–996、当天安排 1016–1152、当晚住宿 1172–1256、餐食 1276–1332。改最累的一段 → 点按钮 → 旧抽屉里是改过的文字 → 保存：PATCH 一次 `rev 1`、`set` 只有 `intensity`，抽屉关上，页面值是新文字、没有「已改」，状态句「小林更新于今天14:30」。
  - 新建线路 1440×900：副栏 788 高（内容 970，自己滚），页面滚到 600 时副栏在 y 82–870、第一张卡在 84，面板下沿 892；把副栏滚到底，最后一行「客户的其他叫法没填」在 820–856，看得见；Tab 到它时副栏跟着滚，812–848。原来要整页滚到底（976）才露出来。
  - 草稿两套主题：副栏标题 h2 状态 / 上架前检查 / 最近更新，字阶相同。非编辑成员没有按钮、状态句「小林更新于今天10:12」加「只读」；匿名没有副栏和按钮；假包的套餐没有按钮；新建主材选「延米」，单价后缀「元」→「元/延米」。
  - 骨架（条目接口晚 2.5 秒）：骨架卡片 206 / 206 / 284 / 196 / 206 / 284 / 128、副栏 262 / 118，成品 146 / 177 / 353 / 3,720 / 438 / 496 / 123、副栏 260 / 122；逐日行程的上沿骨架 870、成品 860；CLS 0。
  - 宽度：1280 副栏吸顶、`max-height` 688；375 宽 `scrollWidth` 375，副栏 static、不限高，按钮在页头里（x 237，宽 114）。
  - `securitypolicyviolation` 0 次；控制台只有匿名故意造的 401（/me），页面代码 0 条。
- 构建：入口集合 gzip 325,663 → 325,695 B；详情页换页 78,567 → 80,115 B（`legacyKind` 带进共用 schema 的判断、antd `Button`），列表页 134,104 → 135,547 B；旧抽屉的块 207,348 B，只在点「新建」「在旧表单里改」时下载；换页最多仍是话术页 200,990 B。字体不用重建：新文案「在旧表单里改」的字都在 UI 优先片里。
- 门禁：四道都过；`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4238，用完即删）74 秒通过，db 自测 329 条含真实 PG 部分，fields 1,307 条、shell 140 条。
- 没照评审原样做的：
  - 评审建议「在 /catalog/new/route 里改一处子项，断言没有已改」：新建的逐日行程是空的，第 11 步之前没有「添加一天」，改不了子项。改成让卡片和区块共用一处判定，已有的「新建里填了字不标已改」断言覆盖两者（变异验证过）；第 11 步能加子项以后补这一条（已写进交接）。
  - 过渡按钮没有照评审的第二种改法「10.1 与 10.2 一起交」：本步的范围是 10.1。

### 第 10.2 步（2026-09-28）

- 做了什么：
  - `catalog/save.ts`（纯逻辑，只看行业包配置与字段类型）：保存条上的改动（与补丁同一个口径：先 `pruneHidden`，有序子项条数不变时逐项、逐个子字段列，「最累的一段、行程亮点第2条」「第3天的当晚住宿、第4天的当天安排」，假包写「第3个节点的验收要点」）；右边的说明与主按钮（草稿「草稿保存后仍不会推荐给客户」「保存草稿」，已上架「销售助手下一条回复就用新内容」「保存并立即生效」）；报错落在哪（`placeOf`：payload 的 `id` 是行业包的 `$code`，有序子项落到那一项或那一项的子字段，更细的路径落到字段，落不到的归汇总）与写法（`issueLine`「当晚住宿：没填」，说明已以字段名开头的不重复，说明里没有汉字的写「格式不对」）；只显示碰过的（`visibleErrors`：表单自己查出来的只给碰过的位置（焦点离开过的字段、有序子项的一项与子字段；在一个字段的几个控件之间换焦点不算离开这个字段），点过保存以后全部；服务端 422 的显示到那个字段改过为止；同一处两边都有只写表单的）；失焦的位置（`touchedPlaces`，沿祖先链的 `data-field-key`、`data-item-index`）；控件自己已经报了的不写第二遍（`reportsItself`：认不出的月份区间，第 3.2 步的交接）；409 之后的对比（`changedFields`、`usableChanges`）；`locked_field` 的中文名（`lockedFieldLabel`：「线路名称、标签里的「国内」」，认不得的写「其他内容」）。
  - `CatalogDetail`：有改动才出现保存条（`ActionBar`：16 `clock` 用 `--warning-icon`、「有2处改动」、改动名、「展开改动」；「展开改动」打开一张贴在条上方的浮层清单，每处一行，点了跳到那个字段，Esc 或在清单外按下收起）；`⌘S` / Ctrl+S（能保存的页面总拦下浏览器的「存储网页」，没有改动不发请求）；保存前按上架前检查的必须项查一遍（与 schema 同判，不变量 15），不合格不发请求，全部报在字段下方，顶部「有N处要改」，焦点到第一处（等报错画上以后再跳）；合格就发 PATCH（`submission` 算 `set` / `unset`，带眼下条目的 `rev`），提交中主按钮 loading、不禁用、不重发；存好以后换成返回的条目（提交中又改的一处照旧是改动），读屏念「已保存」，焦点回到最后待过的字段，不弹 toast；422 `invalid_item` 的 issues 落到字段（有序子项里的一项和子字段经 `FieldGrid` 的 `itemErrors` 到渲染器），落不到的逐条写在汇总下面，原文进技术详情；`locked_field` 等其余失败是页内 `ErrorAlert` 加重试；409 `rev_conflict` 是页头下的 danger 横幅「这条刚被别人改过」加「载入最新版本」，载入以后表单换成最新版本，你的改动留在页头下的对比卡里，逐字段「最新版本 / 你改的」并排（按只读形态画），还能改的有「用我的改动」；对比里还有没用回的改动时，离开页面同样先确认（不变量 20）。「放弃」先 `ConfirmDanger`（「放弃这1处改动？」，默认焦点「保留」）。保存条出现时副栏 `max-height` 让出 60（`calc(100dvh − 172px)`）。状态卡的说明补回「其余内容可以直接改，保存后立即生效」。
  - `pages/CatalogItemPage.tsx`：PATCH 存好以后写进这一条的缓存，列表失效；「载入最新版本」不看缓存重取。
  - `src/shared/catalog.ts`：编号、天数、天号的报错不再写 `id`、`days`、`day`（「编号只能是…最长64位」「逐日行程有7天，要和天数（8）相同」「第2天的天号应为2」），`console.selftest.ts` 加验收 15 第 10 条（422 的报错里是「天数」，响应里没有 `days`）。
- 自测：`fields.selftest.tsx` 1,307 → 1,381 条（新增第 10 节）。纯逻辑：改动的口径与写法（E、G 页、假包、条数变了、`showWhen`、与补丁同一个口径）、报错的位置与写法、只显示碰过的、服务端的显示到改过为止、月份区间只报一次、对比里还能用回的。整页挂真的路由和查询缓存，`fetch` 换成按方法与地址回应的假接口：E 页打开不改没有保存条、⌘S 拦浏览器不发请求；改两处的保存条逐字；展开改动（Esc 在清单里与在按钮上、在外面按下）；点一处跳到行程亮点第2条；⌘S 的 PATCH 是 `{ rev: 1, set }`、提交中再按不重发、存好换条目与缓存、再存带 rev 2、「已保存」、没有 toast、焦点不掉到 body；草稿清空线路名称与第3天住宿点「保存草稿」不发请求、两处报错、汇总、「跳到第一处」；新建只碰过编号只报编号；422 落到字段、英文不上页面、改了就消失；409 横幅、载入最新版本、对比、离开被拦、用我的改动、再存带新 rev；`locked_field` 的中文名；连不上的重试；放弃的确认；非编辑成员；假包的 PATCH 地址；验收 16 第三条（20 条线路、23 家酒店逐一打开不改：没有保存条，⌘S 也不发 PATCH）。
- 变异（仓库外的隔离副本，每个变异跑一次 fields 自测、300 秒闹钟，还原后与 worktree 逐字节相同）：第一轮 58 例，49 例被具名断言杀死（`save.ts` 20 例里 19 例、`CatalogDetail` 25 例里 21 例、`FieldGrid` / 渲染器 / `FormField` 8 例里 5 例、页面 4 例里 3 例，天数的报错写回 `days` 由 `console.selftest.ts` 的验收 15 第 10 条点名）。9 例存活，都补了断言：汇总不按字段排（表单与服务端的混在一起时的顺序）；补丁带打开时的 rev（页面缓存与表单同步时看不出，补「后台重取把别人存的 rev 3 放进缓存，补丁仍带 rev 1」）；再改一处不清「已保存」（补「撤销回到存好的内容不再念」）；存好焦点不回来（原来的测试没有把焦点放在按钮上）；逐条列表与一项本身的报错不画、不连到输入框（原来的 422 只落在子字段上，补单字段逐条与天号两处）；列表不失效；在一个字段里换控件也算离开。最后一例查出一个真问题：清空行程亮点第1条、换到第2条再离开，记下的只有第2条，第1条的「没填」直到保存才出现。改成失焦时记「离开了的位置」（焦点所在元素的位置，减去焦点还在里面的位置），多选片之间换焦点仍不算离开这个字段。第二轮 10 例（9 例存活的加失焦的新写法一例）全部杀死。
- preview 实测（Playwright 1.63 Chromium，CSP 同线上，端口 4232，接口由 `page.route` 拦截，PATCH 按 rev 回 200 或 409、另造 422 与 `locked_field`，时钟钉在 9月26日 14:30、`Asia/Shanghai`，探针在仓库外）：
  - E 页 1440×1100 两套主题：改最累的一段与行程亮点第2条，保存条 y 1032–1092、宽 1192，等于面板的宽度与下沿（面板离窗口下沿 8，所以保存条上沿是 1032，不是第 10.1 步按 1100 − 60 记的 1040）；逐日行程区块头 860–884、第一天的当天标题 938–996 在它上方，当晚住宿照旧在下方（第 11 步）。摘要 14/22/500 text、改动名与说明 13/20 text-2、「展开改动」14/22/500 accent-text、图标 `--warning-icon`；副栏 `max-height` 928。清单浮层在条上方 952–1024、宽 320；Esc 收起、焦点回到「展开改动」。滚到底保存条仍在 1032。⌘S：一次 PATCH（`rev 1`，`set` 只有 `intensity`、`highlights`），保存条消失，没有「已改」，状态句「小林更新于今天14:30」，没有 toast。
  - G 页草稿两套主题：清空第3天住宿、改第4天安排，「有2处改动 · 第3天的当晚住宿、第4天的当天安排」「草稿保存后仍不会推荐给客户」「放弃 / 保存草稿」；离开住宿框时它下方就报「当晚住宿：没填」，点「保存草稿」不发请求，顶部「有1处要改」，焦点在第3天的住宿框。
  - 422：「最累的一段：格式不对」「当晚住宿：不能为空」，「有2处要改」，焦点进最累的一段，可见文字里没有英文。409 两套主题：横幅 272–1400 × 136–208；载入以后对比卡「最累的一段 · 最新版本 / 你改的」，状态句换成「老周更新于…」、没有保存条；用我的改动后保存，PATCH 带 rev 2。`locked_field`：「这些内容上架后锁定了：线路名称、标签里的「国内」」。假包：「有1处改动 · 第3个节点的验收要点」，PATCH 到 `/catalog/package/p-nuanmu-2r`。
  - 宽度：375、479、480、767、768、1024、1280 七档，保存条里摘要、改动名、「展开改动」、说明、两个按钮互不重叠、都在条里，`scrollWidth` 等于窗口宽（第一轮 375 宽时摘要压在说明上、主按钮被裁，改成窄屏逐级隐藏补充，见偏离）。
  - `securitypolicyviolation` 0 次；页面代码的控制台错误 0 条，只有故意造的 409、422 的「Failed to load resource」；CLS ≤ 0.0014。改完失焦的写法以后整套重跑一遍，结果相同。
- 构建：入口集合 gzip 325,695 → 325,705 B；详情页换页 80,115 → 84,549 B，列表页 135,547 → 135,698 B；换页最多仍是话术页 200,983 B；旧抽屉的块 207,494 B（只在点「新建」「在旧表单里改」时下载）。
- 字体：新文案带进「仍」，重跑 `scripts/fonts/build.ts`（仓库外的副本，fonttools 4.66.0、brotli 1.2.0）：UI 优先片 777 → 778 个码位，159,264 → 159,476 B，两个 preload 合计 171,360 B；两个 Geist 文件不变。**合并时**三个字体文件照旧冲突，后合并的一方在合并结果上重跑 `build.ts`。
- 门禁：四道都过；`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4238，用完即删）78 秒通过，db 自测 329 条含真实 PG 部分，console 277 条（加验收 15 第 10 条），fields 1,381 条、shell 140 条，eval 19/19。
- 偏离与取舍（前三条写进 spec 顶部第 10.2 步的 `Revisions:`）：
  - 「在旧表单里改」没有全删：已上架条目不再有它；草稿还要靠它去旧抽屉上架，第 10.3 步的上架确认做好时和旧抽屉一起删（第 10.1 步的交接写的是「保存条接上以后删掉」）。
  - 顶部汇总下面逐条写落不到字段的问题；没有汉字的服务端说明写「格式不对」；认不出的月份区间只由控件报一次。
  - 窄屏的保存条：<768 不写说明，<480 再去掉改动名和「展开改动」。
  - 「展开改动」做成浮层清单（设计系统只写了这个按钮）；汇总只在点过保存以后出现，失焦时字段下方照常报。
- 留给后面的步骤：
  - 第 10.3 步：新建的保存（现在保存条只给已有条目：`onSave` 只在 `ItemLoader` 里给，`showBar` 排除新建）、409 `catalog_code_taken` 落到编号字段下（经 `placeOf` 的 `$code`）；上架前检查没过时点「上架…」跳到字段可以用 `jumpTo`（等这一轮画完再跳）；删草稿的「在旧表单里改」、旧抽屉与 `CatalogDrawer` 的 `draft`。
  - 第 11 步：重做有序子项编辑器时保留 `itemErrors`（一项本身的报错写在序号下，子字段的写在子字段下，单字段的逐条写在那一条下并连到输入框）与 `data-item-index`、子字段的 `data-field-key`（失焦的位置、跳转都靠它们）。

### 第 10.2 步评审之后（2026-09-28）

- 做了什么（评审 7 条都照改，评审给了几种改法的取哪种见末尾；另查出评审没提的两处）：
  - 面板被推上去（高）：读屏区 `.save-live` 改 `position: fixed`，钉在视口左上。原来是 absolute，包含块是 `.shell-panel`，停在约 5,800 处的静态位置，把面板撑出一段溢出，scrollIntoView 会滚动它。外壳 `.shell-panel` 的 `overflow: hidden` 同时改成 `clip`：只裁圆角，不再是滚动容器，别的页面以后也不会出同类问题（`shell.css` 一行）。
  - 「展开改动」的焦点环（中）：按钮 64×24（`min-height: 24px`；左右各 4 的内边距代替原来离名字 4 的外边距，字离名字仍是 4）。焦点环改 `outline-offset: -2px`（设计系统 §3「容器会裁掉外框的地方」），清单里的行也一样。
  - 409 之后的焦点（中）：载入以后焦点落在对比卡标题上（h2，`tabIndex` −1，焦点环同卡片头）。「用我的改动」把焦点交给下一个「用我的改动」，最后一个回到标题；按钮用 `aria-describedby` 连上这一行的字段名。「关闭对比」以后回到最后待过的字段，没有就是页标题。
  - 非 422 的失败（中）：409 横幅、`locked_field` 或连不上的 Alert 出现时滚进视野，焦点给它的按钮（「载入最新版本」「重试」）；没有按钮的 Alert 自己拿焦点。这里用 `focus({ focusVisible: true })`，因为实测普通 `focus()` 在 ⌘S 触发的异步保存之后 `:focus-visible` 为假，焦点挪过去了却没有焦点环。
  - 弹层下的 ⌘S（中）：放弃确认、关闭对比的确认开着，或者焦点在弹层里（`[role="dialog"]`、`.ant-modal-root`、`.ant-drawer`，即旧抽屉、未保存保护、⌘K）时，⌘S 不拦也不保存。
  - 关闭对比先确认（低）：对比里还有没用回表单的改动时，「关闭对比」先弹 `ConfirmDanger`「放弃这N处改动？」（「对比里还没用回表单的改动会丢掉，撤销不了。」，默认焦点「保留」）。
  - 编号、天号报错的回归保护（低）：`console.selftest.ts` 验收 15 第 10 条旁加一条：新建编号 `R_Bad` 返回 422，说明以「编号只能」开头、不含 `id`；第2天的天号写成 5 返回 422，说明正好是「第2天的天号应为2」。
  - 评审没提的一：确认框（放弃、关闭对比）关上以后焦点掉到 body。回收焦点时，焦点还在正要关上的弹窗里，原写法把它算作「还在页面上」，就不管了；弹窗关完把焦点还给打开它的按钮，可那个按钮已经随保存条或对比卡没了。happy-dom 里弹窗是同步关的，所以原来的自测测不出来。现在焦点在弹层里也算丢了，两处都回到最后待过的字段。
  - 评审没提的二：409 之后「载入最新版本」连不上时，`fetchQuery` 把这一条的查询置成出错，`ItemLoader` 整页换成出错态，卸掉 `CatalogDetail`，没保存的改动随之丢掉，也不经过离开保护。现在整页的 404 与出错态只在还没取到这一条时出现。已经打开着的，失败由详情页就地显示「服务暂时连不上」加重试（横幅还在），焦点给「重试」。
- 自测：`fields.selftest.tsx` 1,381 → 1,396 条。409 与连不上时焦点的去处（「载入最新版本」「重试」、没有按钮的 Alert），载入以后落在对比卡标题上，「用我的改动」交给下一个、最后一个回到标题，读屏连字段名；关闭对比：改动都用回了不用确认，还有没用回的先确认（「保留」、撤销以后是「放弃这2处改动？」、放弃以后离开不拦）；放弃确认和关闭对比的确认开着时按 ⌘S（焦点先移开）不拦、不发 PATCH；焦点在旧抽屉里按 ⌘S 同样。载入最新版本连不上时详情页和改动都在，焦点在「重试」上，重试以后是对比卡。`console.selftest.ts` 277 → 278 条。
- 变异（隔离副本，每例 300 秒闹钟，还原后与 worktree 逐字节相同）：自测跑了 20 例，19 例被具名断言杀死：焦点不挪到横幅或重试、失败不触发、没有按钮的 Alert 不拿焦点、载入以后不聚焦标题、「用我的改动」不交给下一个或干脆不挪焦点、去掉 `aria-describedby`、关闭对比不确认、确认标题的处数、⌘S 的三个条件各去掉一个、弹层选择器只认 `.ant-modal-root`、关闭对比不回收焦点、载入失败不挪焦点（第一轮存活，补了载入失败这一段；补的时候查出评审没提的二）、`ItemLoader` 不看有没有数据、失败与横幅的优先顺序、编号与天号改回英文键（评审存活的两例）。存活 1 例，只在真浏览器里看得出：回收焦点时不把弹层里的焦点算作丢了。把这个变异在副本里构建后跑 preview，放弃确认与关闭对比的确认之后焦点都在 BODY，算杀死。`focusVisible` 那一处同样只在浏览器里看得出：改之前那次 preview 实测是 `:focus-visible` 为假，也算杀死。CSS 两处在 preview 里用 `bypassCSP` 注入评审时的旧 CSS 对照（见下）。`ItemLoader` 的 404 判断没变异：条目没有删除接口，打开着的条目重取不会得到 404。
- preview 实测（Playwright 1.63 Chromium 153，CSP 同线上，端口 4232，接口由 `page.route` 拦截，时钟同上，探针在仓库外）：
  - E 页 1440×1100 两套主题：先依次点副栏四个锁定行，再改一处按 ⌘S，422 跳到页尾的「标签」。这之后 `.shell-panel` 的 scrollTop 都是 0，scrollHeight 等于 clientHeight 1084，保存条在 1032–1092；滚轮滚回顶部，页头在 32–116。注入评审时的旧 CSS 对照：锁定行之后是 72，422 跳转之后是 280，保存条上沿 752，页头 −248（评审的现象）；两处只改一处（只改 fixed 或只改 clip）都是 0。
  - 「展开改动」：从主按钮 Shift+Tab 两次到它，`:focus-visible` 为真，焦点环 2px、offset −2px，按钮盒子 437–501 × 1050–1074 在 `.action-bar-hint` 的裁切框 372–501 × 1050–1074 里，焦点环完整（截图两套主题）；Enter 展开清单。窄屏七档（375 到 1280）重跑，都不重叠，`scrollWidth` 等于窗口宽。
  - 409（两套主题）：改住宿档次与最累的一段后按 ⌘S，横幅在吸顶页头下 80–152，焦点在「载入最新版本」，焦点环 3px；Enter 载入以后焦点在对比卡标题；Enter「用我的改动」交给下一个，再 Enter 回到标题；关闭对比不弹确认，焦点回到最后待过的输入框；「放弃」确认开着时按 ⌘S，不发 PATCH，确认框还在；「放弃改动」以后焦点在输入框。还有没用回的改动时关闭对比，先确认「放弃这1处改动？」，按 ⌘S 不发，放弃以后焦点在输入框，点侧栏「酒店」直接离开。
  - 失败：连不上时焦点在「重试」上，`locked_field` 时焦点在 Alert 上，两者都有焦点环，Alert 在 136–212；载入最新版本连不上时详情页还在，改动也在，「服务暂时连不上」的「重试」有焦点，重试以后出现对比卡、焦点在标题。
  - 草稿的旧抽屉：焦点在抽屉里按 ⌘S，没有 PATCH，抽屉还开着。
  - 第 10.2 步原来的整套走查（E、G、422、409、`locked_field`、假包、七档宽度）在最终构建上重跑，结果与原记录相同。`securitypolicyviolation` 0 次；页面代码的控制台错误 0 条，只有故意造的 409、422 和连不上的「Failed to load resource」。
- 构建：入口集合 gzip 325,705 → 325,696 B；详情页换页 84,549 → 85,010 B，列表页 135,698 → 135,693 B；换页最多仍是话术页 200,981 B。字体不用重建：新文案的字都在 UI 优先片里（`check-fonts` 596 个汉字全在）。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4238，用完即删），79 秒通过：db 自测 329 条（含真实 PG 部分），console 278 条，fields 1,396 条，shell 140 条，eval 19/19。
- 评审给了几种改法的，取哪种：
  - 「用我的改动」以后，焦点交给下一个「用我的改动」（评审的第二种），不给那个字段：让人留在对比卡里逐处核对，键盘不用在对比卡和几千像素外的字段之间来回跳。写回的字段照常标「已改」、出现保存条。
  - 失败时只滚动、挪焦点，保存条的摘要不写失败（评审给的两种改法取第一种）。焦点优先给刚出的失败，所以载入最新版本连不上时给「重试」，不给还在的横幅。
  - 弹层下的 ⌘S 照评审「不拦也不保存」：这时浏览器的「存储网页」照常弹出。只看焦点在不在弹层里，外加两个确认框的状态；按键的 target 总是焦点所在的元素，不另外看。
- spec 不用改：这些都在 spec「保存条」「报错落到字段」与不变量 20 的范围里，没有和原文冲突的地方。

### 第 10.2 步第二轮评审之后（2026-09-28）

- 做了什么（评审 5 条都照改）：
  - 422 全落不到字段（中）：`invalid_item` 的 issues 一处也落不到字段时（路径为空、未知键），页头下的汇总滚进视野、拿焦点，焦点环同失败的 Alert（`detail.css` 加 `.detail-issues:focus-visible`）。页头下给哪一个焦点改成由失败的种类点名（`ALERT_OF`：失败、409 横幅、汇总），不再按「失败优先、再横幅」猜：409 横幅还在时又来这样的 422，焦点给汇总。
  - 服务端报错按位置收（低）：`visibleErrors` 把提交时与眼下的值按报错自己的位置比（`placeValue`：字段、有序子项的一项、一项里的子字段），不再按整个顶层字段比。改第2天的标题只收它那一条，第2天的住宿、第5天的安排照旧显示，汇总的处数跟着对。
  - 一项本身的报错连到子字段（低）：`ItemCardsForm` 把序号下那条报错（天号）的 id 经 `FormField` 新的 `describedBy` 拼进这一项每个子字段控件的 `aria-describedby`，跳过来、Tab 进来都念得到；不设 `aria-invalid`（错的不是这些子字段）。
  - 不显示的改动（低）：点改动清单里 `showWhen` 没显示的一处（体力强度「不填」以后的「最累的一段」），跳到管它显示的字段（`jumpPlace`，沿 `showWhen` 往上找）。`jumpToIssue` 找不到可去的地方时返回 false，清单收起后焦点回到「展开改动」，不掉到 body。
  - 状态复位的断言（低）：评审存活的 5 个变异都补了断言（见自测）。
- 自测：`fields.selftest.tsx` 1,396 → 1,405 条。纯逻辑：`jumpPlace`；服务端报错按位置比（改第2天标题、改第2天住宿、改第3天住宿三种）。整页：只有路径为空的一条 422，焦点从输入框挪到汇总、主按钮不再 loading，409 横幅在时再来一次，焦点同样给汇总；天号的报错连到第3天的四个子字段；清单点「最累的一段」焦点落进体力强度，找不到时回到「展开改动」；连不上两次以后重试存上，Alert 收起；点过保存以后存上，再清空线路名称（没离开）不报、没有汇总；422 报在没改过的住宿档次下，放弃以后收起，再清空它（没离开）不报；提交中改的一处还在时读屏不念「已保存」。
- 变异（隔离副本，每例 300 秒闹钟，还原后与 worktree 逐字节相同）：15 例全部被具名断言杀死：评审存活的 5 例（保存开始不清失败、存好不清「点过保存」、放弃不清「点过保存」、放弃不清服务端报错、`saved && !dirty` 去掉 `!dirty`），加这一轮的 10 例（落不到字段的 422 不拿焦点、错给横幅；按整个字段比；子字段按整项比；子字段不连一项的报错；`FormField` 丢掉外面的 `describedBy`；`jumpPlace` 原样返回；清单跳不过去不回焦点；`jumpToIssue` 总返回 true；载入最新版本失败错给横幅）。
- preview 实测（Playwright Chromium，CSP 同线上，端口 4232，接口由 `page.route` 拦截，探针在仓库外）：
  - 422 只有路径为空的一条（两套主题）：在第4天的当天标题里改一个字按 ⌘S，汇总「有1处要改」「格式不对」滚到 80–184、拿焦点，`:focus-visible` 为真，焦点环 2px、offset 2px；可见文字里没有英文，主按钮不再 loading。
  - 天号：422 `itinerary.1.day` 以后焦点在第2天的当天标题上（405–437），读屏说明是「第2天的天号应为2」；四个子字段都连上它（4 处引用）。
  - 按位置收：第2天标题与第5天安排各一条、「有2处要改」；在第2天标题里再敲一个字，只剩第5天那条、「有1处要改」。
  - 不显示的改动（两套主题）：体力强度点「不填」，保存条「有2处改动 · 体力强度、最累的一段」；清单里对「最累的一段」按 Enter，清单收起、焦点落在体力强度的分段控件上（焦点环 3px），下一个 Tab 还在体力强度里（评审时是 BODY，再 Tab 到「放弃」）。
  - `securitypolicyviolation` 0 次；页面代码的控制台错误 0 条，只有故意造的 422 的「Failed to load resource」。
- 构建：入口集合 gzip 325,696 → 325,699 B；换页最多仍是话术页 200,984 B。字体不用重建：新代码没有新的界面文字（`check-fonts` 596 个汉字全在）。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4238，用完即删），79 秒通过：db 自测 329 条（含真实 PG 部分），console 278 条，fields 1,405 条，shell 140 条，eval 19/19。
- 评审给了几种改法的，取哪种：落不到字段的 422 用 `alertTick` 那条路（和失败同一套滚动与焦点），不另写一套；一项本身的报错连到这一项的每个子字段（不是只连第一个），Shift+Tab 从下一项倒着进来也念得到；不显示的改动跳到管它显示的字段，找不到时再回到「展开改动」，两种都做。
- spec 不用改：spec「报错落到字段」只说映射到字段下方，没说什么时候收；按位置收在它的范围里。

### 第 10.3 步（2026-09-28）

- 做了什么：
  - `catalog/actions.ts`（纯逻辑，只看行业包配置与字段类型）：页签（匿名默认「预览」，别人默认「编辑」，地址上只写不是默认的那一个）；上架确认的第一句（`activateSentence`：`{字段 key}` 按类型写成值，占位两侧的空格去掉，单位固定的金额只写斜线前面的，句末补句号）、按锁定组分行的「字段 值」（`lockLines`，写法见 spec 顶部第 10.3 步的 `Revisions:` 二）、没做的建议一句（`recommendLine`）；复制的新编号检查（`codeProblem`，格式说明 `CODE_RULE` 从 `src/shared/pack.ts` 导出共用）与换掉编号的 payload（`copyPayload`，键序不动）；新建的编号帮助与示例（`withCodeHints`）、空表单（`blankPayload`：必填的数组先放空数组）、提交按字段排键（`inFieldOrder`）。
  - `catalog/ItemDialogs.tsx`：上架确认（640，`ActivateDialog`：后果列表 16 图标加 14 文字，info / lock / triangle-alert / circle-alert 按 §5.14 取色；锁定清单每段「字段 值」是一个 inline-block，间隔号在段尾，换行只在它后面；默认焦点「再检查一下」，关上以后焦点回到「上架…」，上架成功、失败时不回，焦点由页面放到结果上）；复制为新草稿（480，`CopyDialog`：说明与提醒、新编号输入框（等宽字、帮助写格式、示例取 `codeExample`）、默认焦点在输入框、回车就是复制，编号的问题与 409 写在输入框下，别的失败是弹窗里的 `ErrorAlert`）。
  - `catalog/ItemPreview.tsx`：「预览」页签，375 宽的框里是只读形态的全部分组（与没有编辑权限看到的相同），表单网格按自己的宽度收成一列（第 10.1 步的容器查询），框上一行「手机宽度 · 含没保存的改动」。
  - `CatalogDetail`：页头「更多」（ellipsis，次要按钮样式 32×32，菜单里是「复制为新草稿」，只给能编辑的人、已有的条目）与草稿的主按钮「上架…」；页头下的页签「编辑 / 预览」（内容放在选中的页签里）；上架（必须项没过时不开确认框，全部报到字段下、焦点跳到第一处；有没保存的改动时先按保存条的口径 PATCH，再按存好的 rev 发 activate；409、422、连不上照保存的规矩落到页头下或字段，「重试」直接再上架一次（评审之后改成重新打开确认框，见下一节））；新建的保存（保存条「还没保存」，⌘S 同样，POST 建草稿，409 `catalog_code_taken` 落到编号下）；从预览里跳到字段先换回编辑，等编辑页签的面板显示出来再挪焦点（antd 的页签面板下一轮才去掉 display: none，看不见的控件拿不到焦点：真浏览器里查出来的，happy-dom 看不出）；上架、建好、复制出来以后焦点在页标题上，读屏念一句。未保存保护改用话术线的 `LEAVING_PAGE`（`parts/UnsavedGuard.tsx` 照抄 dev 上的版本，逐字节相同，合并不冲突）：切页签不算离开。
  - `pages/CatalogItemPage.tsx`：页签取自地址（记一步浏览历史）；activate、复制与新建的请求；建好、复制出来的条目放进缓存、列表失效，去它的详情（新建用 replace 并跳过离开保护，表单里的内容已经存上；复制照常经离开保护，评审之后改成建之前先问，见下一节），那一页打开时念「已建草稿」「已复制为新草稿」。`pages/CatalogPage.tsx` 的「新建」两个包都去 `/catalog/new/$kind`。
  - 删掉：`pages/CatalogDrawer.tsx`（01 的 rjsf 抽屉）、`zodValidator.ts`、`console/package.json` 的 `@rjsf/antd`、`@rjsf/core`、`@rjsf/utils`、`@rjsf/validator-ajv8`（worktree 里 `pnpm install`，`pnpm-lock.yaml` 只有删除的 150 行）；`scripts/check-console-src.ts` 的 `LEGACY` 最后一项没了，名单连同它的放行与「过时」检查一起删掉，夹具自测去掉对应的几轮（102 条）。`catalogForm.ts` 的 `formPayload` / `diffPayload` 只剩 `console.selftest.ts` 里 01 的回归用例在用（不改那份自测），`legacyKind` 给第 12 步之前的旧导入弹窗。
- 自测：`fields.selftest.tsx` 1,405 → 1,458 条（去掉「在旧表单里改」的几条，新增第 11 节）。纯逻辑：页签、各类型的值写法、第一句（旅游包、假包套餐与主材）、锁定清单（F 页四行、没填与没有「国内」、假包的「其他」、showWhen）、建议句、新编号、复制的 payload、编号的帮助、空表单、键序、保存条文案。整页挂真的路由、查询缓存与假接口：草稿页头与页签；确认框的全部文字、640 宽、默认焦点、间隔号在段尾、「再检查一下」后焦点回到「上架…」；上架后页面、焦点、读屏；验收 17（含从预览页签点）；有改动时先 PATCH 再 activate 与确认框开着时的 ⌘S；先保存 422、409、422、连不上与重试；复制（「更多」菜单、弹窗、五种编号问题、409、回车、payload、去新草稿）、有改动时复制被离开保护拦下、复制连不上；预览（375 框、只读、文本、保存条与副栏还在、不拦、从预览点检查项与锁定组换回编辑、后退）；匿名默认预览、地址带 tab、非编辑成员；新建酒店（空表单无保存条、编号帮助、409 落到编号、改了就收、⌘S 的 payload 与键序、replace、焦点与读屏）；非编辑成员打开草稿没有页头操作；假包新建的编号帮助与放弃；列表页两个包的「新建」。happy-dom 不跑动画，弹窗的进出场由自测的 `motion()` 走完（先让 requestAnimationFrame 跑到动画开始，再发 animationend / transitionend），这样默认焦点与关上以后卸掉都测得到。
- 变异（仓库外的隔离副本，每例跑一次 fields 自测、300 秒闹钟，还原后与 worktree 逐字节相同，收尾 ps 查过没有留下进程）：第一轮 57 例（`actions.ts` 25、弹窗 8、预览 2、`CatalogDetail` 17、页面 4、列表 1），55 例被具名断言杀死。存活 2 例都是死代码，删掉了：空表单挑出必填的数组（选填的 `writeValue` 本来就不留空数组）；`CatalogDetail` 再看一遍 `canEdit`（页面对非编辑成员本来就不给 `onCopy`、`onActivate`）。第二轮 5 例（必填的数组不放、showWhen 管着的也放、页面给非编辑成员 `onCopy`、给 `onActivate`、已上架也画「上架…」）全部杀死：其中「给 `onActivate`」第一次存活（非编辑成员的用例只开了已上架的条目），补「非编辑成员打开草稿」以后杀死；「showWhen 管着的也放」靠新补的一条。只有真浏览器看得出的一处：从预览跳到字段时等编辑页签的面板显示出来，改之前的构建在 Chromium 里点检查项以后焦点落在 BODY，改之后落进体力强度，算杀死。
- preview 实测（Playwright Chromium，CSP 同线上，端口 4231，接口由 `page.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`，浅色、深色各一轮，探针在仓库外）：
  - F 页 1440×900：页头「更多」32×32（`--panel` 底、`--shadow-btn`、text 色）与「上架…」；页签在页头下 20（116 → 136），页签下沿 176，第一张卡 192。确认框 x 400、y 100、640×418；标题 16/24/600 text，正文 14/22/400，字段名 text-2（浅 rgb(77,77,85)、深 rgb(168,168,177)）、值 text；图标 info 与 lock 是 text-2，triangle-alert 浅 rgb(184,110,0)、深 rgb(240,179,85)，circle-alert 浅 rgb(180,35,24)、深 rgb(255,155,143)；底栏 `--frame`（浅 rgb(246,246,247)、深 rgb(9,9,11)）；关闭按钮 `aria-label`「关闭」。锁定清单四行，识别、计价两行各折一次（45、44 高），间隔号落在行首 0 处；字号只有 16 / 14 / 13 / 12.5，字重 600 / 400 / 500，含中文的元素 letter-spacing 都是 0。默认焦点「再检查一下」（点开时 `:focus-visible` 为假，键盘 Enter 打开时为真）；Esc 关上，焦点回到「上架…」且有焦点环。确认以后一次 activate（`rev 1`），标题后「已上架」，状态句「13项上架后锁定·小林更新于今天14:30」，页头只剩「更多」，没有上架前检查，读屏区「已上架」，焦点在标题上（有焦点环）。
  - 验收 17：清空线路名称点「上架…」，没有确认框，焦点在线路名称的输入框（有焦点环），下方「线路名称：没填」，没有请求。
  - 复制（已上架的 r-sichuan-lux）：「更多」菜单只有一项；弹窗 x 480、480 宽，焦点在输入框；填原编号回车写「线路编号：和原来的编号一样，换一个」；填 r-sichuan-lux-kids 回车，POST 的 payload 键序与原条目相同、只换编号，到 `/console/catalog/route/r-sichuan-lux-kids`，状态草稿，读屏「已复制为新草稿」，焦点在标题上，弹窗没了。
  - 预览（草稿，住宿档次改成「精品民宿，含<b>早餐</b>」）：框 x 453、375 宽，框里的表单网格都是一列，主栏没有输入框，「手机宽度·含没保存的改动」，那句按原文显示、框里 0 个 `<b>`，框里没有元素超出右缘；保存条还在。从预览点检查项「体力强度没填」、锁定组「条款」、改动清单里的「住宿档次」：都换回编辑（地址上没有 tab），焦点分别落进体力强度、「费用包含与不含」卡片头、住宿档次的输入框；后退回到预览。375 宽 `?tab=preview`：`scrollWidth` 375，框收成 327。匿名默认预览（地址上没有 tab），点「编辑」写 `?tab=edit`，没有输入框。
  - 新建：空的新建线路没有保存条，「必须项3/13·建议5条没做」，没有页签（评审之后写进 spec 的 `Revisions:`）；新建酒店填好（标签一个不填）按 ⌘S，POST 的 payload 是 `id, name, destination, stars, nightlyFrom, roomType, highlights, tags: []`，换成 `/console/catalog/hotel/h-erhai-lake`（`history.length` 前后都是 3，replace），读屏「已建草稿」，焦点在标题上。假包：旧房翻新（草稿）的确认框「…并按每平米860元估价。」，四行锁定清单（包含主材写名称）；新建套餐的编号帮助与「例：p-nuanmu-2r」；装修套餐列表点「新建」到 `/console/catalog/new/package`。
  - 375 宽草稿：`scrollWidth` 375，确认框收成 359 宽（antd 的 `100vw − 16`），打开时也不横滚。
  - 两套主题 18 个场景：`securitypolicyviolation` 0 次，页面代码的控制台错误 0 条，CLS ≤ 0.0013。截图在仓库外（`F-*`、`copy-*`、`preview-*`、`new-*`、`reno-*`、`narrow-*`），走查截图照旧在第 17 步。
- 构建（与第 10.2 步第二轮评审之后同一套算法）：入口集合 gzip 325,699 → 324,479 B；详情页换页 85,010 → 87,948 B（两个弹窗、预览、页签）；列表页 135,693 → 133,974 B；换页最多仍是话术页 200,116 B；旧抽屉的块（207,494 B）没了，旧导入弹窗的块 72,802 B 只在点「导入CSV」时下载。
- 字体：新文案带进「白带宽」，删掉的抽屉带走一些，重跑 `scripts/fonts/build.ts`（仓库外的副本，fonttools 4.66.0、brotli 1.2.0）：UI 优先片 778 → 780 个码位，159,476 → 159,744 B，两个 preload 合计 171,628 B；两个 Geist 文件不变。**合并时**三个字体文件照旧冲突，后合并的一方在合并结果上重跑 `build.ts`。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4237，用完即删），80 秒通过：db 自测 329 条（含真实 PG 部分），console 278 条，session 52 条，parts 99 条，shell 140 条，fields 1,458 条，check-console-src 102 条，eval 19/19 两遍。
- 偏离与取舍（写进 spec 顶部第 10.3 步的 `Revisions:`）：见那一行的五条。另：确认框第一段前的「info」图标与第二段的「lock」图标照 F 页；弹窗宽度在 375 宽时由 antd 收成 359（`100vw − 16`）。
- 留给后面的步骤：
  - 第 4 步（总览，已在 dev）：在售数为 0 时的「新建{实体名}」现在可以直接链到 `/catalog/new/$kind`（总览的注释写着「新建路由在第 10 步，在那之前打开列表」），合并以后由总览那一侧改。（2026-10-01 已做，见「跨线收尾：条目链接」）
  - 第 11 步：新建线路要能加逐日行程才存得上（天数至少 1，条数要等于天数），在那之前新建线路的保存停在「逐日行程还差N天」；新建能加子项以后，补一条「新建里改子项不标已改」（第 10.1 步的交接）。
  - 第 12 步：假包的「导入CSV」；`catalogForm.ts` 的 `legacyKind` 随旧导入弹窗一起删。
  - 第 17 步：走查截图（验收 4 的「上架确认」「新建线路（空表单）」「线路预览」，验收 5 的新建套餐与上架确认框）。

### 第 10.3 步评审之后（2026-09-28）

- 做了什么（评审 6 条都照改，改法见末尾）：
  - 上架失败的「重试」（高）：改走 `startActivate`（经 ref 取这一轮的），先查必须项，再重新打开确认框，锁定清单按那时的表单列；不再直接 PATCH 加 activate。原来失败以后改了锁定字段，点「重试」会把没人确认过的值锁死。
  - 键盘打开复制弹窗（高）：「更多」菜单的 `onClick` 对 `domEvent` 调 `preventDefault()`。rc-menu 在 keydown 里就点了菜单项，弹窗随即打开、焦点进了弹窗，同一次 Enter 的激活（keypress）落到右上角「关闭」上，弹窗刚开就关。
  - 复制弹窗关上以后的焦点（中）：`CopyDialog` 关完调 `onClosed`，页面把焦点还给「更多」（`IconButton` 的 ref）。antd 记下的触发元素是已经收起的菜单项，还不回去。复制成了的话这一页连同弹窗都卸掉了，不会调到。
  - 有改动时复制（中）：建之前先过离开保护，`CatalogDetail` 自己弹同一个「有改动还没保存」（`ConfirmDanger`，默认焦点「留下」）；「留下」什么也不建，复制弹窗还开着、编号还在；「放弃改动并离开」才 POST，建好以后 `navigate` 带 `ignoreBlocker`，不再拦第二次。`CopyDialog` 的提交防重复改成 ref，含问离开的那一段。
  - 自测缺口（中）：见自测。
  - 新建没有页签（低）：写进 spec 顶部第 10.3 步 `Revisions:` 四，理由是路由表里 `/catalog/new/$kind` 不收 search。
- 自测：`fields.selftest.tsx` 1,458 → 1,468 条。上架连不上以后改线路名称再「重试」：先打开确认框（标题、先保存、锁定清单是改过的，没有新请求），确认以后 POST、PATCH、POST rev 2；清空线路名称再「重试」不开确认框、焦点跳过去。假包「旧房翻新」的确认框：第一句、四个锁定组、包含主材写名称。复制：编号不对、409 以后焦点回到输入框（先把焦点放到按钮上再点，评审指出 happy-dom 的 `click()` 不挪焦点，原断言恒真）、报错经 `aria-describedby` 连上；菜单项上 Enter 打开且默认动作被拦下；取消、关闭、Esc 以后焦点在「更多」；有改动时先问、「留下」不建、「放弃改动并离开」只 POST 一次并直接到新草稿；复制弹窗开着、焦点不在弹窗里按 ⌘S 不拦不存；回车（按下、松开、再按下）只 POST 一次；422 `path: id` 写在输入框下；关上再打开没有上一次的编号与报错。
- 变异（隔离副本，每例 300 秒闹钟，还原后与 worktree 逐字节相同，收尾 ps 查过没有留下进程）：18 例，评审存活的 8 例（R1–R8）加这次改动的 10 例。全部被具名断言杀死，只有 2 例第一次没有：一是回车防重复，rc-input 按住 Enter 时自己加锁、松开才解，自测只发 keydown，第二次回车被输入框吞掉，补了 keyup 以后杀死；二是复制弹窗的 `focusTriggerAfterClose: false`，去掉以后两个环境里都一样（antd 要还焦点的菜单项已经隐藏，拿不到焦点），是死代码，删掉，`onClosed` 改成总把焦点给「更多」。另有两例第一轮是自测崩溃（断言里放了 DOM 元素，`JSON.stringify` 循环引用），改成布尔以后是具名断言杀死。
- preview 实测（Playwright Chromium，CSP 同线上，端口 4234，接口由 `page.route` 拦截，时钟同上，探针在仓库外）：
  - 重试（两套主题）：第一次 activate 断网，「服务暂时连不上」；把每人起价改成 9800，横幅还在；点「重试」出现确认框，计价一行「每人起价9,800元/人」，第一句「按每人9,800元起报价」，另有「先保存这1处改动，再上架」，这时只有第一次的 POST；确认以后 PATCH `{rev:1,set:{priceFrom:9800}}`、POST `{rev:2}`，「已上架」，焦点在标题上（有焦点环）。
  - 键盘复制（两套主题）：焦点在「更多」按 Enter，Tab 到「复制为新草稿」按 Enter，900ms 后弹窗还在、焦点在输入框（`:focus-visible`）；填 `R_X` 回车报格式；Esc 以后焦点在「更多」，焦点环 2px；鼠标打开再「取消」、再右上角关闭，焦点都在「更多」，再打开是帮助文字、没有旧报错；弹窗 axe 0 条。
  - 有改动时复制（浅色、深色 1440，浅色 375）：回车以后两个弹窗叠着，「有改动还没保存」在上，焦点在「留下」，没有请求；「留下」以后还在原地址，复制弹窗和编号都在，焦点回到输入框，保存条「有1处改动」；再回车、「放弃改动并离开」：一次 POST，payload 的最累的一段是存着的原文，到 `/console/catalog/route/r-sichuan-copy`，没有弹窗，标题「草稿」、焦点在标题上，读屏「已复制为新草稿」。375 宽 `scrollWidth` 375。
  - `securitypolicyviolation` 0 次；页面代码的控制台错误 0 条，只有故意断网的「Failed to load resource」。
- 构建：入口集合 gzip 324,479 → 324,483 B；换页最多仍是话术页 200,112 B。字体不用重建：新文案「有改动还没保存」等都在 UI 优先片里（`check-fonts` 598 个汉字全在）。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4237，用完即删），82 秒通过：db 自测 329 条（含真实 PG 部分），console 278 条，session 52 条，parts 99 条，shell 140 条，fields 1,468 条，check-console-src 102 条，eval 19/19 两遍。
- 评审给了几种改法的，取哪种：
  - 重试走 `startActivate`（评审第一种），不在表单改动时收起横幅：横幅说的是上一次没上成，改了表单它照样成立，收起了就只剩「上架…」一个入口，读屏也听不到失败。
  - 键盘 Enter 用 `preventDefault`（评审第一种），不推迟到下一帧：推迟靠时序躲开那次激活，`preventDefault` 直接把它去掉，自测也断言得到。
  - 有改动时复制「建之前先问」（评审第一种），不做「建好以后留下再补一句」：后一种会在库里留下用户选了「留下」的草稿。确认框用和未保存保护同样的标题、说明与按钮；`UnsavedGuard.tsx` 不改（与 dev 逐字节相同，合并不冲突）。
  - 新建的页签按评审第一种写进 `Revisions:`，不给新建加预览：路由表里新建不收 search，加页签要改路由表与 `router.tsx`（共用文件）。

### 第 10.3 步第二轮评审之后（2026-09-28）

- 做了什么（评审 6 条都照改）：
  - 新建线路存不上（中）：旧抽屉删了以后，多字段的有序子项没有增删，新建线路的逐日行程是 0 天，条数永远不等于天数；草稿线路也改不了天数。照评审第一种，把增删从第 11 步提前（`renderers.tsx` 的 `ItemCardsForm`）：卡片右上角「删除这{itemNoun}」（28 图标按钮，text-3，§6.3），底部「添加一{itemNoun}」（次要按钮带 plus）。新加的一项由 `blankItem` 给出：自动编号写上序号，必填的数组子字段先放空数组（同新建的空表单）。增删以后 `renumber` 按位置重排 `autoIndexKey`；改子字段时一项的键按行业包的顺序排（`itemInOrder`，同新建提交的 `inFieldOrder`）。`countFrom` 指向的字段上架后锁定时（`countLocked`，旅游包已上架线路的天数）两个按钮都不画（验收 18）。焦点：加了一项，进它的第一个输入框；删了一项，给接替它位置那一项的「删除」；删光了，给「添加」。`arrayValued` 从 `catalog/actions.ts` 挪到 `fields/model.ts` 共用。上移下移、竖轴与节点、条数提醒、「条数随天数锁定，文字可改」和「复制上一{itemNoun}的…」仍在第 11 步。第 10.3 步记录里交给第 11 步的两件（新建线路能加逐日行程、「新建里改子项不标已改」）这次做了。
  - 预览的条目名（中）：按表单里的内容取（`itemTitle(entity, state, base.code)`），同上架确认；页头仍是存着的名称。
  - 有改动时上架、上架还在发（低）：先保存的那一次（`save(true)`）不再把焦点拉回表单，焦点留在「上架，开始推荐」上。确认框忙的时候关不掉：「关闭」和「再检查一下」disabled，Esc 不关，点遮罩也不关（antd 的 `closable`、`mask` 用对象形式，写成模块级常量）。`onCancel` 里不再另加判断，四条路都由弹窗属性挡住。
  - 「更多」的 aria（低）：加 `aria-haspopup="menu"` 和 `aria-expanded`，同用户菜单。按 ArrowDown 不进菜单的问题与用户菜单相同（antd Dropdown 的键盘行为），这里不改。
  - 自测缺口（低）：评审存活的 4 例都补了用例：两处没保存的改动、上架以后的缓存与列表、两个必须项没过时跳到第一处、两条建议。
  - 页签的英文 live 文字（低）：照评审第二种绕开。`parts.css` 加 `.ant-tabs-tab-btn > [aria-live] { display: none }`：@rc-component/tabs 1.13.0 的文字写死成英文，没有开关可关。全站页签（含第 9 步列表页的）在这一处统一处理，display: none 同时把节点移出无障碍树。
- 自测：`fields.selftest.tsx` 1,468 → 1,484 条。纯逻辑：`blankItem`（自动编号、必填与选填的数组子字段、单字段）、`renumber`（重排、编号对的原样共用、没有自动编号的不动）、`itemInOrder`、`countLocked`（已上架、草稿、新建、没有编辑权限、没有 countFrom、包里没有天数）、两条建议的连接。整页：新建线路从 0 天加两天、删最后一天、删第一天、删光（标签、按钮、焦点、文字跟着走），新建里改子项不标「已改」；草稿线路删一天以后标「已改」、检查清单「逐日行程还差1天」，再加一天填好，⌘S 的补丁里天号按位置 1–5、新一天的键按包里的顺序；已上架线路没有增删、文字能改；假包新建套餐的「添加一个节点」，已上架套餐也能增删。预览标题按表单；忙时的确认框（焦点、四种关法都关不掉、回来以后焦点在标题上）；「更多」的 aria；上架以后缓存是 rev 2、列表重取后是已上架；两处改动；两处没过跳到第一处。
- 变异（隔离副本 `mut-ux-catalog/review2`，每例跑一次 fields 自测、300 秒闹钟；还原后与 worktree 逐字节相同（`diff -r`）；收尾 ps 查过，没有留下进程）：30 例（`renderers.tsx` 8、`model.ts` 6、`FieldGrid`/`FormField` 各 1、`CatalogDetail` 7、`ItemDialogs` 4、`CatalogItemPage` 2、`actions.ts` 1），全部被具名断言杀死，没有超时。只能在真浏览器里验的页签 CSS 另做了一例：在 Chromium 里经 CSSOM 把那个 live 节点改回显示，页签的可访问名字变成「Tab 1 of 2 编辑」；规则生效时是「编辑」。
- preview 实测（Playwright Chromium，CSP 同线上，端口 4231，接口由 `context.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`，浅色、深色各一轮，探针在仓库外）：
  - 新建线路：「逐日行程·0天」只有「添加一天」；点两次得到 D1、D2，焦点依次进当天标题（`:focus-visible`）。「删除这天」28×28，离卡片右缘 10、上缘 10，颜色是 text-3（浅 rgb(99,99,107)、深 rgb(145,145,154)），和「D1」标签垂直居中对齐；子字段网格离卡片上缘 42。「添加一天」高 32、带 plus，次要按钮（浅底白、深底 rgb(18,18,20)）。删 D2 以后焦点在 D1 的「删除这天」。填满以后按 ⌘S：副栏「必须项14/14」，一次 POST，payload 是 `days: 1` 加一天 `{day, title, detail, hotel, meals}`；地址换成 `/catalog/route/r-probe-new`，状态「草稿」，没有字段报错。
  - 草稿 r-guizhou-5d：天数改成 6，加一天，焦点进 D6 的当天标题；填好后按 ⌘S，PATCH 的 `set` 只有 `days`、`itinerary`，天号 1–6，第 6 天的键按包里的顺序；保存条随即收起。已上架的 r-sichuan-lux：8 天，没有增删按钮，16 个输入框照样能改。假包新建套餐：「施工节点·0个节点」只有「添加一个节点」，点了以后是「节点1」和「删除这个节点」，焦点在节点名称里。
  - 预览：线路名称改成「贵州 亲子五日（改过的名字）」以后，框里的标题就是它，页头仍是存着的名称，框上一行「手机宽度·含没保存的改动」。
  - 忙时上架（activate 延迟 2.5 秒）：键盘 Enter 打开确认框，焦点在「再检查一下」；Tab 到「上架，开始推荐」再按 Enter。PATCH 之后焦点仍在这个按钮上（`:focus-visible`）。「关闭」「再检查一下」都 disabled；按 Esc、按空格、点遮罩，确认框都还开着。activate 回来以后确认框关上，标题旁写「已上架」，焦点在标题上；请求依次是 PATCH rev 1、activate rev 2。
  - 「更多」：`aria-haspopup="menu"`，`aria-expanded` 收着时 false、Enter 打开后 true、Esc 关上后 false。页签：键盘挪动以后，无障碍树里是 tab「编辑」「预览」，live 节点的 `display` 是 none。
  - 375 宽新建线路加一天：`scrollWidth` 375，「删除这天」在卡片里面。
  - 两套主题 18 个场景：`securitypolicyviolation` 0 次，控制台错误 0 条，拦截的接口里没有落到兜底（未处理路径）的请求。
- 构建：入口集合 gzip 324,483 → 324,486 B；换页最多仍是话术页，200,112 → 200,114 B（`check-console-dist`）。字体不用重建：`check-fonts` 显示 598 个汉字都在 UI 优先片里（780 个码位，159,744 B）。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4237，用完即删），85 秒通过：db 自测 329 条（含真实 PG 部分），console 278 条，session 52 条，parts 99 条，shell 140 条，fields 1,484 条，check-console-src 102 条，eval 19/19 两遍。
- 评审给了几种改法的，取哪种：
  - 新建线路取第一种（把增删提前），没有选「第 11 步之前不让新建线路」或「只记一笔」。第 10.3 步本身要做「新建」；草稿线路改天数，在 01 里本来靠旧抽屉就能做，这一步删了抽屉，就得把这条路补回来。只提前增删这一片：spec「有序子项与引用」和设计系统 §6.3 的其余部分（上移下移、竖轴与节点、条数提醒、锁定说明）仍按第 11 步做。行为没有偏离 spec，所以不写 `Revisions:`。
  - 忙时上架：两处都改（不刷新焦点、确认框关不掉），没有改成「关了也行、上架照样跑完」。上架以后无法撤回，忙的时候关掉弹窗，看起来像取消了，其实没有取消。
  - 页签取第二种（绕开），不只记一笔：英文读出来的问题现在就在列表页和详情页上。CSS 选择器绑在 rc-tabs 的 DOM 结构上，升级 antd 以后要重新验一遍（第 16 步的可访问性收尾）。

### 跨线收尾：条目链接（2026-10-01）

第 4、10、14 步都合进 `dev` 以后，把两处先指到列表的去处改到条目详情与新建。

- 做了什么：
  - 总览（第 4 步「留给后面的步骤 · 第 10 步」）：待上架 1 条的行「去上架」到 `/catalog/$kind/$code`；多条合成的行「逐条检查」到 `/catalog/$kind?status=draft`；在售数为 0 时，编辑者的在售格整格到第一个实体的 `/catalog/new/$kind`，非编辑者照旧到列表。`model.ts` 的去处形状不变（`TodoTarget` 带编号就是详情），`OverviewPage.tsx` 按编号与 `Kpi.create` 选路由。
  - 审计抽屉（「Open」第 14 步的产品库一半）：`DrawerLink` 的 catalog 一支带上编号（记录的 `targetId`），`AuditPage.tsx` 链到 `/catalog/$kind/$code`；产品库的记录没有编号时不给去处（「对象」本来也不写）。话术仍到 `/sop`，「Open」第 14 步收窄为只剩话术的版本（等第 7 步；同日做完，见「跨线收尾：审计里的话术版本」）。
  - 实体与编号都取自行业包和数据，自测另用家装式的包核对 `/console/catalog/package/p-1`。
- 偏离与取舍：spec「总览」原文没写待上架两种行的去处。多条的行取草稿页签，与 CSV 导入完成时的「去草稿页签逐条检查后上架」一致；spec 顶部 2026-10-01 的 `Revisions:` 记了这一条、第 14 步那一行的收窄，以及在售数为 0 一格去掉「第 10 步起」。
- 自测：总览 124 → 127 条（整行链接改成详情与草稿页签；在售数为 0 时所有者到新建、坐席到列表；别的行业包的待上架链到这个包的实体与编号）。审计 135 → 137 条（去处带编号；没有编号时没有去处；挂载里点「打开这条线路」到详情地址）。
- 变异（隔离副本 `mut-links`，每例 300 秒闹钟；还原后与 worktree 逐字节相同，没有留下进程）：12 例全部失败。总览 7 例（单条去列表、编号写成实体、多条不带草稿页签、多条带已上架页签、在售为 0 不链新建、在售格总链新建、新建给非编辑者），都由具名断言点出。审计 5 例（去处回到列表、页面里编号写成实体、模型不带编号、没编号也给去处、话术去处丢了）：前 4 例由具名断言点出，最后一例在挂载时点不到去处，自测中途退出。
- preview 实测（Chromium，CSP 同线上，端口 4240，接口由 `context.route` 拦截，时钟钉在 9月26日 14:30，浅色、深色各一轮，探针在仓库外）：总览两行的 href 是 `/console/catalog/route/r-guizhou-5d`、`/console/catalog/hotel?status=draft`；点「去上架」进详情，标题是这条线路；后退再点「逐条检查」，列表选中「草稿6」页签，6 行。只有草稿时在售格写 0 和「新建线路」，链到 `/console/catalog/new/route`，点了进新建页。审计抽屉的「打开这条线路」链到 `/console/catalog/route/r-sichuan-lux`，点了进详情；话术那条仍是 `/console/sop`。6 个场景 `securitypolicyviolation` 0 次，控制台错误 0 条，没有落到兜底的请求。
- 门禁：四道都过（`pnpm test` 没带 `PG_TEST_URL`，这次没动服务端与数据库）。没有新增依赖，没有新文案（字体不用重建）。
- 评审之后（同日，1 条意见接受）：第 10.3 步「留给后面的步骤 · 第 4 步」补标已做；第 14 步「偏离与取舍」的「去处暂时指到列表」、第 4 步「偏离与取舍」的「先打开这个实体的列表」各补半句已改。只动文档。

### 跨线收尾：审计里的话术版本（2026-10-01）

第 7 步（话术页地址上的 `v`）合进 `dev` 以后，把审计抽屉里话术那条的去处改到对应的版本，「Open」第 14 步的那一条删掉。

- 做了什么：`model.ts` 的 `DrawerLink` 的 sop 一支带上 `v`，即这条记录生成、成为线上的那一版：发布取 diff 的 `versionNo`，回滚、重新生成取
  `toVersionNo`，与「对象」的「话术vN」同一个数；丢弃不生成版本，diff 里取不到版本号时也一样，`v` 是 null。`AuditPage.tsx` 有 `v` 时链到
  `/sop?v=N`（第 7 步的查看改动：vN 相对前一版改了什么），没有时到 `/sop`。链接文字仍是「打开销售话术」，没有新文案，字体不用重切。
- 取哪一版（spec 顶部 2026-10-01 这一条的 `Revisions:`，第 14 步评审之后那行随之撤销）：回滚不取目标 `targetVersionNo`。查看改动比的是
  前一版，链到生成的 v3 看到的是这次回滚让线上变了什么（v2 → v3）；链到目标 v1，看到的是「v1是最早的版本，没有可比的」，或者目标当年
  的改动。
- 自测：审计 137 → 141 条。纯逻辑核对发布、回滚、重新生成、丢弃、发布 diff 缺版本号各自的「对象」与去处；挂载里的 `/sop` 换成与
  router.tsx 同一个 `sopSearch`：发布那条的 href 是 `/console/sop?v=2`，点了以后地址 `/sop?v=2`、search 是 `{ v: 2 }`；回滚那条的 href
  是生成的 v3，不是目标 v1；丢弃那条的 href 是 `/console/sop`，点了以后不带版本。
- 变异（隔离副本 `mut-audit-sop`，每例 300 秒闹钟，只跑审计自测）：8 例全部失败并点名：去处不带版本、回滚取目标版本、取换下的旧版
  `fromVersionNo`、页面不带 search、没有版本时也带 `v`、重新生成不给版本、链到前一版、只有发布带版本。副本还原后与 worktree 逐字节相同，
  没有留下进程。
- preview 实测（Chromium，CSP 同线上，端口 4250，`context.route` 拦接口，时钟钉在 9月26日 14:30，数据是第 7 步那份真实的 `data/sop.md`：
  v1 导入、v2 改异议处理、v3 回滚到 v1、v4 系统重新生成改了转人工条件；浅色、深色各一轮，探针在仓库外）：从 `/audit?cat=sop` 打开抽屉，
  点「打开销售话术」：
  - 发布 v2：href `/console/sop?v=2`，主区「v2相对v1改了什么」，只列异议处理，横幅「正在查看v2」，编辑器不在。
  - 回滚（「把话术回滚到v1，生成v3」，对象「话术v3」）：`?v=3`，「v3相对v2改了什么」，下一行「退回去·老板·9月26日 09:31·回到v1·改了1节（异议处理）」，
    只列异议处理。
  - 重新生成 v4：`?v=4`，「v4相对v3改了什么」，下一行「代码里的固定规则变了·系统更新·9月26日 10:00」，列转人工条件（固定规则节）。
  - 丢弃：href `/console/sop`，到话术页的编辑器，没有横幅。
  - 两轮 `securitypolicyviolation` 0 次，控制台错误 0 条，没有漏拦的接口。
- 门禁：四道都过（`pnpm test` 没带 `PG_TEST_URL`，这次没动服务端与数据库）。没有新增依赖。只读了 `console/src/sop/`，没有改。

### 第 6.1 步（2026-09-28）

- 做了什么：
  - `src/shared/console-api.ts`：`ContractViolation` 加可选的 `match`，注释照 spec「接口改动」。
  - `src/sop/contract.ts`：`checkSopContract` 在四类违规里填 `match`：`phrase_missing` 与 `phrase_forbidden` 的纯文本规则是
    `rule.text`，正则规则是 `m[0]`（匹配到的那一段，不是正则本身），`unknown_tool` / `unknown_field` 是标识符名；`structure`、
    `locked_changed`、`over_budget` 不带这个键（不是带 `undefined`）。`detail` 不变，命令行与启动日志的报错照旧。渲染只在 SOP
    后面接固定的硬性要求，所以正则规则的 `m[0]` 与 `sectionKey` 指的是同一节。
  - `console.selftest.ts` 加验收 15 第 2 条，放在「AuditQuery.actions」一块之后（那一块把整轮的审计记录写成句子，放在它前面会把
    这里的重渲染、回滚记录也算进去）：一份草稿在话术原则里同时写进两种禁用短语（纯文本「明显超出我们现有线路的范围」、正则命中的
    「缩短天数重新报价」）和不存在的工具、字段，检查与发布 422 的 violations 逐条带 `match`；`structure`、`over_budget` 没有这个键；
    删掉一句必需说法 → `phrase_missing` 带那句原文，发布 422 同样带。276 → 281 条断言，整份约 28 秒。
- 取舍：验收 15 第 2 条的「删掉一句必需说法」用现在的镜像做不到：`SOP_CONTRACT` 的 14 条必需说法全在固定规则节里，存草稿点名
  固定规则节是 422。自测先发布一版话术原则里也写着「定价只有两条规则」的（这时两处都有），再用把这句从定价规则节去掉的镜像重新
  装载配置源（启动重渲染），这句就只剩话术原则里一处，再存一份删掉它的草稿。跑完换回原镜像、回滚到这一块开始前的版本：之后
  「锁丢失」一块重新装载时的前缀哈希与 v1 相同。验收的写法没改，不算偏离 spec。
- 变异（仓库外的隔离副本 `mut-ux-sop/ux-6.1`，只跑 `console.selftest.ts`，每例限时 300 秒）：10 例全部让自测失败，
  每例只红针对它的那一条：`phrase_missing` 不填、填成「缺少「…」」；纯文本禁用短语不填；正则规则填正则本身、不填；工具不填；
  字段不填、填成节名；`structure`、`over_budget` 也带 `match`。基线 28 秒通过，还原后与 worktree 逐字节相同。
- 没有界面改动（console 只多一个可选的类型字段），不用 preview 走查；没有新的界面文字，字体不用重切。没有新增依赖。
- `pnpm test` 全过（82 秒）：`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条连真实 Postgres
  部分一起跑；契约的函数层自测（`config.selftest.ts`，451 条）一条没改照样通过；console 自测 281 条。
- 评审后补：`locked_changed` 不带 `match` 原先没有断言（经 HTTP 时锁定节总从镜像取，这类违规只在函数层出得来，console 自测
  碰不到）。`config.selftest.ts` 在已有的 locked_changed 一例旁加一条（451 → 452 条）。变异（隔离副本 `mut-ux-sop/ux-6.1-r2`，
  限时 300 秒）：`locked_changed` 带上 `match` → 只红这一条；还原后与 worktree 逐字节相同。
- 留给后面的步骤：
  - 第 6.2 步：旅游包的必需说法全在固定规则节里，运营改不到，用旅游包时检查不会报 `phrase_missing`（自测靠换镜像造出来）；
    行业包把必需说法放进可编辑节时，spec 表里「点了去哪：线上版本里含这句的节」才用得上。

### 第 6.2 步（2026-09-28）

- 做了什么：
  - `console/src/sop/check.ts`：`useDraftCheck` 按「存下来的那份草稿」检查：key 是草稿的 id、rev 加线上版本的 id，变了就
    `POST /sop/draft/check` 一次（自动保存存上了、打开页面时已有草稿、载入最新草稿、回滚后线上换了）；没有草稿时不查、清掉结果。
    几个检查同时在路上时只认最后发出的那一个；没跑成时上一次的结果留着、另记错误；卸下以后回来的不认。页头的「检查」按钮去掉，
    剩丢弃、发布（第 6.3、7 步换掉）。
  - `console/src/sop/problems.ts`（纯函数）：每条问题落在哪一节、点了去哪（`phrase_missing` 取线上版本里含这句的节）；spec 表里
    「前端生成的说明」；编辑卡片上方的说明；编辑器里要标的问题与「改成…」的候选（只在行业包的词汇里找：工具名找 `vocabulary.tools`，
    字段名找 `sopFields`，编辑距离 ≤2 里最近的一个，一样近取表里靠前的）；按标识符（前后不连 `[A-Za-z0-9_]`，同服务端的 `\b`）
    或按原文找每一处。
  - `editor.ts`：`problemsField`（块级部件只能由 StateField 给）：每一处画 `.sop-bad` 的 danger 波浪线（§6.6）；写错的名字每一段、
    每个名字一条行内提醒，插在那一段（列表项连同续行）末行的后面，缩进取那一段的第一行；样子照 §5.12 与 B 页：14 的 circle-alert，
    第一行「提到了不存在的工具「search_route」，是不是「查线路 search_routes」？」（候选是 panel 底的芯片），右边 28 高的幽灵小按钮
    「改成search_routes」，第二行 13 text-2 写后果，放不下时按钮折到第一行下面。位置每次改动都在正文里重新找，改掉了波浪线就没了；
    只读（409 停住）时提醒照写、不给按钮。`fixNameAt` 换掉那一段里这个名字的每一处、光标放在最后一处后面，带 `problemFix` 标记；
    `selectFirst` 选中第一处并滚过去。`paragraphSpan` 从 `paragraphLines` 里拆出来两处共用，部件里的文字自己做挤压回退。
  - `SopEditor.tsx`：`problems`（换了才派一次 `setProblems`，不重建编辑器）、`onFix`（替换那一笔在 `onChange` 之后回调）；
    `SectionPane` 的 `notes` 写在编辑卡片上方（样子同行内提醒）；`editorIn`。`QuotaBar` 可以带 `ref`（定位时程序聚焦，`tabIndex=-1`）。
  - `SideCards.tsx` 的 `CheckCard`：下一行「每次自动保存都会跑 · 上次14:05」，没跑成时是 danger 的「没检查上 · 重试」；没过的项写
    「1处 · 话术原则」、整行是按钮（没有去处的不是）；「字数在额度内」通过时写百分比（`outline.ts` 的 `quotaPercent`，与额度条同一个
    写法），超了写「超出N字」。
  - `SopPage.tsx`：清单点了定位：换节进浏览历史、已经在那一节不进，等编辑器按这一节建好以后选中第一处、聚焦正文；没有 match 可选的
    聚焦正文、把卡片上方的说明滚进视口；额度那一项滚到额度条、焦点落在它上面。「改成…」以后等这次渲染把改动交给自动保存（`useAutosave`
    的 effect 在前面），再马上存。目录的问题数按问题落在的节数。右栏清单的属性与编辑器里的问题只随检查结果、换节、换包变，打字时
    清单不重渲、问题不重派。
  - `sop.selftest.tsx`：第 9 节里靠页头「检查」按钮的用例改成自动检查（打开时已有草稿就查、载入最新草稿以后再查一次、没有草稿不查）；
    新增第 10 节：纯函数、EditorState 上的装饰与「改成…」那一笔、挂在 DOM 里的提醒、整页接按正文算问题的假服务端（打开时检查、
    点了定位、「改成…」以后马上存再检查、只认后发的、没跑成与重试、没有草稿与丢弃、只读成员、409 时没有按钮、超额）。426 → 504 条
    断言，约 11 秒，`pnpm test` 的调用不变。
- 变异（仓库外的隔离副本 `mut-ux-sop/ux-6.2`，每例 `node --import tsx` 单进程、限时 300 秒）：第一轮 55 例，52 例让自测失败并点名，
  存活 3 例补了用例：部件的 `eq` 不比候选的原名（中文名也比，改一个被另一个盖住；补「候选只换了原名」）；定位选中最后一处（整页夹具
  每节只有一处；补在 EditorState 上从四处里选第一处）；没有去处的项也能点（`eq` 的 JSON 丢了函数，改比 `typeof`，整页另查不是按钮）。
  另把续行的缩进改成比第一行深，钉住「缩进取第一行」。第二轮 4 例（含 `eq` 整个恒真）全部失败。副本还原后与 worktree 逐字节相同，
  没有留下进程。
- 构建：入口集合 gzip 315,266 → 315,267 B；换页最多仍是产品库 247,122 B，余 2,878 B。话术页自己要下的 JS（按静态 import 从
  `sop.lazy` 出发、入口集合以外，gzip -9）206,695 → 210,244 B（+3,549），CSS 2,217 → 2,272 B。字体按新文案重切：UI 优先片
  776 → 777 个码位（「句」），159,024 → 159,332 B，两个 preload 合计 170,908 → 171,216 B。
- preview 实测（Chromium，Playwright，CSP 同线上，`page.route` 拦接口，假服务端按正文算问题，时钟钉在 9月26日 14:30，数据同第 5.2 步
  的 B 页场景：话术原则里把一处 `search_routes` 写成 `search_route`；浅色、深色各一轮，探针在仓库外）：
  - 打开 `?section=preamble`：检查 1 次，清单「6/7通过」、下一行「每次自动保存都会跑 · 上次14:30」，「工具名都存在」是按钮、写
    「1处 · 话术原则」（浅色 `#B42318`、深色 `#FF9B8F`），「字数在额度内」写 84%（同额度条）；目录的话术原则「1个问题」。
  - 点「工具名都存在」：换到话术原则，选中 `search_route`（在视口里），焦点在正文上。波浪线：underline wavy、1.5px、偏移 3、
    颜色同 danger、skip-ink none。行内提醒在那一段末行下面 12（592 → 604），左边比正文多缩 20（列表项的正文），620×84，
    内边距 8 8 8 12、圆角 6，底色浅色 `#FDEDEB`、深色 `#3A1714`；标题 14/22/500，后果 13/20 text-2，按钮 144×28、14/500、
    text 色、悬停 `--hover`；候选芯片 22 高、panel 底；图标 14、danger 色。正文里按 Tab 落到「改成search_routes」上。
  - 点「改成search_routes」：28–31 毫秒后 PUT（没等防抖），正文里那一处换好、不再有 `search_route`；提醒和波浪线没了，焦点回到正文；
    存上以后检查第 2 次，「7/7通过」、「上次14:31」，目录的问题数没了。
  - 在异议处理末尾打「客户嫌贵时缩短天数重新报价。」：自动保存以后「6/7通过」；换到前言再点「没有禁用短语」：回到异议处理、选中这几个字、
    画波浪线，编辑卡片上方一条「「缩短天数重新报价」不能出现在话术里」（688 宽，底色同行内提醒）。
  - 1100 宽：提醒在卡片里、按钮和标题同一行；375 宽（老板）：按钮折到标题下面，提醒 60–335 在卡片 24–351 里（改之前按钮不折行，
    提醒伸出卡片到 461），都没有横向滚动。
  - Firefox、WebKit（两套主题）：定位、波浪线（wavy 1.5px）、提醒的位置与 Chromium 相同（WebKit 低 1 px）；两者都不支持
    `text-spacing-trim`，提醒里「」，」的「」」挂 `.halt`；点「改成…」以后 7/7。WebKit 里 Tab 按 Safari 的默认跳过按钮（同第 5.3 步）。
  - 所有场景 `securitypolicyviolation` 0 次，页面错误与控制台错误 0 条（WebKit 不截图）。
- 偏离与取舍（记进 spec 顶部的 `Revisions:`）：
  - 打开页面时已有草稿、载入最新草稿、回滚后线上换了也检查（spec 只写「每次自动保存成功以后」）：去掉页头的「检查」以后，打开一份已有
    问题的草稿不改一个字就看不到问题。
  - 说明写在哪：`unknown_*` 的是行内提醒的第一行；结构、固定规则、必需说法、禁用短语的写在那一节编辑卡片的上方；清单每项照 B 页只写
    处数和节名。
  - 落不到节上的问题（节表整体不对、线上版本里也没有那句必需说法、禁用短语只在固定的硬性要求里）不能点，只写处数。
  - 「改成…」换掉那一段里这个名字的每一处（一段一条提醒），不是只换一处。字段名的后果照工具名写「模型只认N个字段名……」，
    行业包还没到时不写个数、不给候选。
- 没有新增依赖。
- `pnpm test` 全过（约 1 分 45 秒）：`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（端口 4227，跑完即删），db 自测 329 条
  连真实 Postgres 部分一起跑；console 自测 281 条、config 自测 452 条照过；话术自测 504 条。
- 留给后面的步骤：
  - 第 6.3 步：发布条的「改完1个问题即可发布」点了跳到第一个问题、发布抽屉里检查清单的失败项「点了关抽屉并定位」，都可以直接用
    `SopPage.tsx` 的 `locate` 与 `CheckCard`；发布被拒（422）的问题现在照样喂给清单、目录与编辑器（`rejected`），01 的发布弹窗还在。
  - 旅游包的必需说法都在固定规则节里（第 6.1 步），「必备短语都在」没过、点了去线上版本里含这句的节，这一路只有自测里造得出来。
- 评审之后（同日，五条都改了）：
  - 两条合并提示（中）：检查打开页面就跑以后，过期的草稿（`basedOn` 不是线上版本）一打开就同时出 `draft.stale` 的「发布时自动合并」
    和检查的 `rebase.needed` 那一条，两处是服务端同一个条件；有冲突的节时一条说自动合并、一条说发布不了。改成只出一条：检查报了
    冲突的节时是出错色的「这几节在你编辑期间被别人改过……发布不了」，不然是 info 的「草稿打开之后发布过新版本，发布时自动合并」
    （检查回来之前、回滚以后重查回来之前按 `draft.stale`）；发布撞上冲突（409）时只出发布被拒的那一条。原来检查那一条在 422
    时藏起来（`!rejected`），422 是合并成功以后的事，碰不上冲突的节，这一支去掉（变异时它是唯一存活的一例，改了也没有可测的差别）。
    整页自测 10.3e：过期的草稿没有冲突、有冲突，检查回来前后各只有一条；有冲突时去发布、答 409，只剩发布被拒那一条。
  - 「改成…」按标识符找没有钉住（中）：夹具 DOC2 的第一段加一处写对的 `search_routes`（B 页的话术原则就是这样），断言点了以后
    这一段四处都是 `search_routes`、没有 `search_routess`，写对的那一处不动。
  - 检查的三处竞态没有测试（中）：整页自测 10.3d：回滚（草稿的 rev 不变、线上换成 v3）以后再查一次；两次都在路上，后发的先跑成、
    先发的晚回来没跑成，不写「没检查上」；丢弃时还在路上的检查回来不认，清单仍是 7 个「还没跑」。假服务端加了回滚与发布 409。
  - 行内提醒的内边距（低）：`8px 8px 8px 12px` 改成设计系统 §5.12 的 8 12（B 页画的是 8 8 8 12，设计系统为准）。上面 preview
    实测里的「内边距 8 8 8 12」作废，按钮离提醒右边 12。
  - `sop.css` 里 `.sop-notes` 挪到编辑卡片那段注释上面，注释回到它说的规则旁边。
  - 变异（仓库外的隔离副本 `mut-ux-sop/ux-6.2-r2`，每例 `node --import tsx` 单进程、限时 300 秒）：9 例里 8 例让自测失败并点名——
    评审给的 4 例（`fixNameAt` 按原文找、key 不带线上版本、没跑成时不比序号、没有草稿时不作废路上的检查），提示 4 例（409 旁边
    照出、冲突当成自动合并、检查回来之前不出、照旧另出一条 `draft.stale`）；存活的 1 例是上面去掉的 `!rejected`。没有留下进程。
  - 自测 504 → 511 条断言。preview 实测（Chromium，CSP 同线上，探针在仓库外，浅色、深色各一轮）：提醒 `padding` 为 `8px 12px`，
    1440 与 1100 宽 620×84、按钮和标题同一行、离右边 12；375 宽按钮折到标题下面，提醒 60–335 在卡片里，没有横向滚动。过期草稿
    （检查晚 1.5 秒回来）：没有冲突时前后都只有「发布时自动合并」一条，有冲突时先是这一条、回来以后换成出错色的一条。
    `securitypolicyviolation` 0 次，控制台错误 0 条。话术页自己的 JS 210,244 → 210,231 B，CSS 不变；入口集合 315,266 B。
    字体不用重切。
  - `pnpm test` 全过（约 1 分 30 秒），`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（跑完即删），db 自测 329 条
    连真实 Postgres 部分一起跑；console 自测 281 条、config 自测 452 条照过。

### 第 6.3 步（2026-09-28）

- 做了什么：
  - `console/src/sop/publish.ts`（纯函数）：逐节改动的行数 `lineStat`（与差异视图同一个按行分块的算法，`@codemirror/merge` 的
    `Chunk`，行里改了字算 +1 −1）与「+3行 −1行」；行内 / 并排存在 `localStorage` 的 `console.sopDiffMode`（读写包 try/catch，
    读不到按行内）；发布条的摘要、成功那句、「发布…」不能点的原因（409 停住 → 没有改动 → 有问题，只有有问题时点了跳到第一个问题）、
    第一个问题（清单的顺序、第一个有去处的）；抽屉的替换说明、预填、「在预填之外再写至少一个字」、「发布」不能点的原因（检查在路上
    → 没检查上 → 有冲突的节 → 有问题 → 说明没写），各带点了去哪（清单的第一项或「重试」、说明框）。
  - `DiffView.tsx`：行内是 `unifiedMergeView`（`allowInlineDiffs`、`mergeControls: false`、不要沟槽，没改的前后各留 2 行、连着
    4 行以上才折叠），并排是 `MergeView`，两种都只读、自动换行、内置文案用编辑器那份汉化（「14行没有改动」）；节末的空行只留一个
    换行。行内 / 并排是发布抽屉与「查看改动」共用的一个选择。
  - `PublishParts.tsx`：`PublishBar`（ActionBar，B 页：16 图标加 14/500 摘要加 13 的补充，右边原因、「查看改动」「发布…」，
    不能点时 `aria-disabled`、`aria-describedby` 指向原因）；`PublishDrawer`（§5.13 L 640，从上到下是冲突提示、检查清单、替换
    说明、逐节改动、变更说明，底部原因、「取消」「发布」）；`ChangesDrawer`（「查看改动」「查看本节改动」，只看）。抽屉收起的那一下
    照关上那一刻画，发布成功以后不闪成「将替换线上v3」。焦点由页面还给打开它的按钮（antd 还的是打开时的 activeElement，Safari
    点按钮不给按钮焦点）；点清单定位时不还，焦点在正文里。
  - `RollbackModal.tsx`：版本历史里 01 的回滚确认挪出来，发布条的「回滚到v2」与版本历史共用（第 7 步重做）。
  - `check.ts` 加 `running`（最后发出的那一个还在路上），抽屉等它回来才让发布；`outline.ts` 的 `changedSections`（与目录的
    「改过」同一口径，含本地还没存上的改动，按保存时的规则规范化）；`SopEditor.tsx` 说明行末尾的「查看本节改动」（这一节改过才有）。
  - `SopPage.tsx`：页头去掉 01 的「发布」和发布弹窗，页面底部的逐节对比去掉。点「发布…」先存（同 `⌘S`），存上以后打开抽屉；这一次
    存上了，自动保存那一次检查就是打开时的检查，不另发，没有要存的才另调一次；存失败或 409 就不打开。发布成功写在条里、不弹 toast，
    焦点回到「发布…」；422 抽屉开着、清单换成被拒的问题；409 关上抽屉，由页面上原有的提示说；别的失败写在抽屉里，说明不丢。
  - `sop.css`：发布条（<768 时摘要占一行，原因和按钮在下一行靠右）、抽屉、差异（新增 `--success-bg` 与「+」，删除 `--subtle`、
    text-2、1.5px 删除线、「−」，读屏念「发出：」「删去：」；`@codemirror/merge` 自带的红绿底、红色删除、沟槽、折叠行的 ⦚ 与
    渐变都盖掉，选择器比它的主题多一层，与插入顺序无关）。
  - 字体：新文案多 5 个汉字，减号 `−`（U+2212）加进由 Noto 画的符号（Geist 的子集只有 ASCII），设计系统 §2.1、§2.4、§2.6 同步；
    UI 优先片 777 → 783 个码位，159,332 → 160,564 B，两个 preload 合计 171,216 → 172,448 B。
  - `sop.selftest.tsx` 第 11 节：纯函数；差异的两种样子，`@codemirror/merge` 的 baseTheme 里带颜色的规则在 sop.css 里都被盖掉；
    整页对假服务端（点「发布…」先存再开、只检查一次，成功写在条里，「回滚到v2」，从版本历史回滚以后那句不留，422、500、检查在路上
    或没跑成，变更说明关上再开，查看改动与查看本节改动、焦点，没有草稿、只读成员、匿名，有问题时跳到第一个，409 停住）。
    511 → 594 条断言，约 15 秒，`pnpm test` 的调用不变。
- 接手续做：上一个会话写完代码与自测、改好 plan 与 spec 以后断网，变异与 preview 走查没有留下记录（临时目录也没了），所以都重做。
  续做时补了：发布成功以后再打开抽屉是这一次的预填（上一次写的不留）；评审发现在页面底部的版本历史里回滚以后，条里还写
  「已发布v3 · 回滚到v2」，改成成功那句只在线上还是那一版时留着（之后别人发布过也一样），加 11.3b2；变异补的用例与一处简化（见下）。
- 变异（仓库外的隔离副本 `mut-ux-sop/ux-6.3`，每例 `node --import tsx` 单进程只跑话术自测、限时 300 秒）：第一轮 85 例
  （`publish.ts` 21、`DiffView.tsx` 12、`PublishParts.tsx` 15、`SopPage.tsx` 26、`check.ts` 4、`outline.ts` 3、`SopEditor.tsx` 1、
  `sop.css` 3），74 例让自测失败并点名，存活 11 例：
  - 补了用例的 9 例：第一个问题不看有没有去处（同一项里先有落不到节上的、后有能去的）；抽屉里不写「检查于14:30」（11.3a 原来只在
    `waitFor` 里等这句，等不到也往下走）；改一个字再改回去，成功那句又回来（11.3n）；点之前就没存上、点「发布…」时还在组字，抽屉
    永远不开（11.3d2）；在正在看的这一节里定位以后焦点被还给「发布…」（11.3e2，原用例跨节定位，换节晚于还焦点，测不出）；
    `useDraftCheck` 打开时不算在路上（直接测钩子）；收起时跟着重画（happy-dom 没有收起动画，抽屉一关就卸下，整页测不到，导出
    `useShownWhileClosing` 直接测）；删除块里 `.cm-deletedChunk .cm-deletedText` 的红色底线没盖、折叠行的 ⦚ 没去（颜色覆盖的自测
    原来只对最后一个类名，`.cm-merge-b .cm-line .cm-deletedText` 就算盖过了；改成对整串类名，另查 `content`）。
  - 等价的 1 例：`noteReady` 里 `t !== ''` 多余（空串是任何预填的开头），删掉这一判断，另补「没有预填时空着」一例。
  - 留着的 1 例：去掉抽屉的 `focusable={{ focusTriggerAfterClose: false }}`。自测与 Chromium 里都看不出差别：把这一例单独构建、
    在 preview 里从抽屉定位到正在看的这一节，收起 1.5 秒以后焦点仍在正文里，`focusin` 只有清单那一项和正文两次，antd 没有还焦点。
    设置留着，焦点一律由页面还给打开抽屉的按钮。
  - 第二轮重跑 12 例：存活的 11 例（`noteReady` 那一例按新代码改写成「说明不去首尾空白」），加上同样按新代码改写的「删掉预填
    末尾几个字也算写了」；除上面留着的 1 例都让自测失败并点名。副本还原后与 worktree 逐字节相同，没有留下进程。
- 构建：入口集合 gzip 315,266 → 315,258 B；换页最多仍是产品库 247,040 B。话术页自己要下的 JS（按静态 import 从 `sop.lazy`
  出发、入口集合以外，gzip -9）210,231 → 213,971 B（+3,740），CSS 2,272 → 3,232 B。
- preview 实测（Chromium，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在 9月26日 14:30，探针在仓库外；数据是真实的
  `data/sop.md` 与旅游包：线上 v2，草稿在话术原则里把一处 `search_routes` 写成 `search_route`、加了「一句就够，别连发三句恭喜」，
  异议处理改了一句；浅色、深色各一轮）：
  - 发布条 1376×60、吸底、内边距 0 32、`--panel` 底、上边一条 `--border`（inset 阴影）；左边 16 的 `triangle-alert`（浅色
    `#B86E00`、深色 `#F0B355`）、14/22/500「草稿改了2节（话术原则、异议处理）」、danger 的「1个问题要改」、「字数2,237 / 2,658」；
    右边 text-2「改完1个问题即可发布」、「查看改动」、`aria-disabled` 的「发布…」（`aria-describedby` 指向原因）。点「发布…」：
    选中 `search_route`、焦点在正文里，不开抽屉。
  - 说明行「可编辑 · 910 → 922字（+12）· 查看本节改动」；点链接开 640 宽抽屉「「话术原则」的改动 相对线上v2」：头 56、内边距
    0 16 0 24、16/24/600，体 4 24 24；行内一个编辑器、并排两个，折叠行「5行没有改动」`--subtle` 底 text-2；切到并排以后
    `localStorage` 存 `split`；Esc 关上，焦点回到链接。
  - 点「改成search_routes」，7/7 以后条上没有原因、图标换成 text-2 的 `pencil-line`；「查看改动」列两节「+1行 −1行」，关上焦点回到
    按钮。点「发布…」（没有要存的）：只检查 1 次；抽屉底 60、`--frame` 底、上边一条 `--divider`，原因「在说明里写上为什么改」；清单
    7/7、「检查于14:30」；「将替换线上v2（老板 · 9月25日 18:30发布）」；预填「修改：话术原则、异议处理。」；滚到底以后头下出现
    `--divider`。只有预填时点「发布」：焦点到说明框、光标在末尾；写上字以后发布，条里写「已发布v3（改了话术原则、异议处理）· 客户
    下一句就用新话术 · 回滚到v2」、`circle-check` 是 success 色，焦点回到「发布…」，没有 toast。
  - 差异的颜色：行内的小改动删掉的字 `--subtle` 底、text-2、删除线，新加的字 `--success-bg` 底加底线；另造一份删掉整行的草稿：
    删除行 `--subtle` 底（浅色 `rgba(9,9,11,.05)`、深色 `rgba(255,255,255,.06)`）、text-2、内边距 2 8（行首另留 18 放「−」）、
    「−」text-2、1.5px 删除线；并排左边改到的行同样；新增行 `--success-bg`、「+」success 色。抽屉里所有元素与伪元素都没有红色。
  - 375 宽：发布条换成两行（82 高，内边距 10 16），抽屉 375 宽占满，行内与并排都没有横向滚动，页面宽 375。
  - 家装假包（9 节、6 个工具）：条「草稿改了1节（话术原则）」，抽屉的预填「修改：话术原则。」、逐节改动「话术原则 +2行 −1行」，
    清单 7 项照常。
  - 从抽屉的清单定位到正在看的这一节（假服务端发布答 422）：抽屉卸下 1.5 秒以后焦点仍在正文里、选中那个名字。
  - 所有场景 `securitypolicyviolation` 0 次，页面错误 0 条，没有漏拦的接口；控制台只在故意答 422 的那一轮有浏览器自己的
    「Failed to load resource: 422」，不是页面的错误。
- 偏离与取舍（记进 spec 顶部的 `Revisions:`，七处）：发布条只给能编辑的成员；409 停住是「发布…」的原因，没存上的改动不是（点了先存）；
  「草稿和线上一样，没有可发布的改动」拆成左边摘要与右边原因；成功那句在线上换了版本以后也不留；「查看改动」「查看本节改动」打开
  只看的 640 抽屉；抽屉里「发布」不能点的原因与先后、「在预填之外再写至少一个字」的判定；422、409、别的失败各自的去处；行数按行计、
  CJK 连写算一个词所以多半显示成整行删加；「回滚到v2」先用 01 的回滚确认，01 的逐节对比去掉。
- 没有新增依赖（`@codemirror/merge` 6.12.2 是 01 就有的）。
- `pnpm test` 全过（86 秒）：`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（端口 4227，跑完即删），db 自测 329 条
  连真实 Postgres 部分一起跑；console 自测 281 条、config 自测 452 条照过；话术自测 594 条。第一次跑在产品库的换页预算上失败
  （451,758 / 250,000 B）：主仓库的 `node_modules` 在 10:03 按合并了第 10.3 步（删掉 `@rjsf/*`）的 dev 重装过，本分支的产品库页面还
  import `@rjsf`，从共享的 `node_modules` 解析到另一份 react 与 antd。worktree 里改成按本分支的 lockfile 装
  （`pnpm install --frozen-lockfile --prefer-offline`，换掉两个软链接，依赖没变）以后 247,040 B，通过。合并时以 dev 的依赖为准，
  这个现象跟着消失。
- 留给后面的步骤：
  - 第 7 步：「回滚到v2」和版本历史共用 `RollbackModal.tsx`（01 的写法，成功以后还弹 toast），按 spec「回滚」重做时一起换；
    页头的「丢弃」挪进「更多」。
  - 第 8 步：抽屉里有冲突的节时那条提示还写「先把你的改动复制出来，丢弃草稿，再在当前版本上重做」，加「去合并」时改掉；发布 409
    现在关上抽屉、由页面上的提示说，合并模式做好以后「完成合并」回到发布抽屉。
  - Open 里第 5.3 步那条（吸顶时看不见「没保存上 · 重试」）没动：发布条上的「发布…」点了先存，没存上不打开，原因仍由状态句说；
    改不改发布条左边的写法等 owner。
- 评审之后（2026-10-01，六条都改了）：
  - 线上版本跟不上（高）：页面打开以后别人发布了 v3，抽屉还写「将替换线上v2」，成功那句把别人改的前言算成你改的，「回滚到v2」
    回滚的是页面打开时的 v2、撤掉别人的发布。改成：检查报了 `rebase.needed` 时另取一次 `/sop`，只拿 `published` 写替换说明
    （`onlineNow`：比页面上的新才用），取不到算这次检查没跑成；不写进 `/sop` 的缓存，页面上的草稿、逐节改动与预填照旧相对
    草稿所基于的版本（发布时三方合并，写进缓存的话别人改的前言会变成「你改的」）。发布以后被替换的版本按发布结果的 `basedOn`
    认（`replacedIn`：先在页面上的与检查取到的里找，都不是就 `GET /sop/versions?limit=1&before=N` 取紧挨着的前一个并核对 id），
    「改了…」相对它算（`publishedNames`，固定规则节不算）；取不到就只写「已发布v4 · 客户下一句就用新话术」、不给回滚、不报错。
    spec 顶部加一行 `Revisions:`。假服务端照 `src/config/sop.ts`：发布的结果带 `basedOn`、按三方合并，版本列表按 `before`、
    `limit` 取，回滚的 `sameHashAsTarget` 可设。整页自测 11.3o（检查之前别人发布了 v3：没检查上、重试，替换说明 v3，
    「已发布v4（改了话术原则、异议处理）」「回滚到v3」，回滚请求是 v3）与 11.3o2（检查之后才发布：按版本号取 v3；取不到、
    取回来的不是 basedOn 时只写已发布v4、没有回滚）。
  - 发布失败看不见（中）：500 这类错误挪到抽屉体最上面，出来时 `scrollIntoView`（点「发布」时多半滚到了底下写说明）；关上再
    打开不留上一次的错误（原来就清，补了用例）。
  - 说明下的帮助文字（中）：「会写进版本记录和审计日志」去掉「和审计日志」：`sop.publish` 的审计里没有变更说明，版本历史里有。
  - 「回滚到v2」被省略（低）：条的补充改成两段，前面的字（`.sop-bar-hint-text`）自己省略，「· 回滚到v2」（`.sop-bar-hint-action`）
    不省略；补充一层是网格（第一列 `minmax(0, auto)`，最窄就是按钮那一段），盖掉 ActionBar 的 `overflow: hidden`，焦点框也不再
    靠内边距躲裁切。只改 `sop.css`，共享的 ActionBar 没动。
  - 用例缺口（低）：条上回滚以后固定规则改过的说明（11.3b 改成 `sameHashAsTarget: false`）、关上再打开不留错误（11.3f）、
    行内 / 并排的读屏名称与说明的 `maxLength` 500（同 `PublishBody`，11.3a）。
  - 折叠行只能用鼠标展开（低）：`DiffView.tsx` 给 `.cm-collapsedLines` 补 `role="button"`、`tabindex="0"`（建好编辑器以后补一次，
    之后每次重画由 ViewPlugin 的 `docViewUpdate` 补），Enter / 空格照点击展开（并排两边一起）；展开以后这一行没了，焦点接到
    这个编辑器的正文上（`tabindex="-1"`，不在 Tab 顺序里），下一个 Tab 到下面那一处折叠。焦点框 2px `--focus`、向里收 2；
    CodeMirror 自带的聚焦虚线框去掉。11.2 加了行内与并排两组。
  - 变异（隔离副本 `mut-ux-sop/ux-6.3-r2`，每例 `node --import tsx` 单进程只跑话术自测、限时 300 秒）：35 例，31 例让自测失败
    并点名；存活 4 例：按版本号取回来的不核对 `basedOn`、`publishedNames` 不跳过固定规则节，各补了用例（取回来的是不相干的
    版本；固定规则节两版写法不同）以后重跑都抓到；`onlineNow` 的 `>` 换成 `>=` 等价（版本号唯一，一样大就是同一版）；去掉
    Enter / 空格的 `preventDefault` 等价（处理函数返回 true 时 CodeMirror 自己调），这一句删了。副本还原后与 worktree 逐字节
    相同，没有留下进程。
  - 自测 594 → 614 条断言。
  - preview 实测（Chromium，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在 9月26日 14:30，探针在仓库外，数据同上；浅色、
    深色各一轮）：
    - 检查之前小王发布了 v3（改了前言）：抽屉「将替换线上v3（小王·9月26日 13:00发布）」，逐节改动与预填仍只有话术原则、
      异议处理，页面写「发布时自动合并」；发布以后服务端 v4 的 `basedOn` 是 v3，条里「已发布v4（改了话术原则、异议处理）·
      客户下一句就用新话术 · 回滚到v3」，没有另取版本列表；回滚请求是 `versions/v3/rollback`。检查之后才发布的：抽屉写 v2，
      发布以后取了一次 `versions?limit=1&before=4`，条里与回滚同上。
    - 发布答 500（1440×1000）：错误在抽屉体第一个，56–132（滚动区 56–940），说明还在；取消再打开没有错误。
    - 成功那句：1440 到 375 各宽度「回滚到v2」都在视口里、`elementFromPoint` 是它本身；放不下时省略的是「客户下一句就用新话术」
      （768 宽改了 4 节：字 145 → 74 宽，按钮 394–450；375 宽两行，按钮 295–351）。其余状态的补充字、位置、对比度与改前相同
      （宽 216 → 212：原来给焦点框留的右内边距 4 去掉了）。页面宽度等于视口。
    - 键盘：「查看改动」里 Tab 依次是关闭、行内 / 并排、折叠行（「5行没有改动」「4行没有改动」…，并排时两边都有），焦点框
      2px（浅色 `rgb(43,99,230)`、深色 `rgb(47,104,235)`）、偏移 −2，行高 24；Enter（行内）/ 空格（并排）展开，焦点到正文，
      再 Tab 到下一处折叠。只用鼠标点正文时没有焦点框、没有虚线框；鼠标点折叠行照旧展开。
    - 所有场景 `securitypolicyviolation` 0 次，页面错误 0 条，没有漏拦的接口；控制台只有故意答 401（匿名的 `/me`）、500 时浏览器
      自己的「Failed to load resource」。
  - `pnpm test` 全过（82 秒），`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（端口 4227，跑完即删），db 自测 329 条
    连真实 Postgres 部分一起跑；话术自测 614 条。产物：首屏 JS 315,258 B，换页最多 247,043 B（产品库，预算 250,000），preload
    字体 172,448 B；字体不用重切（新文案只删了字）。
- 第二轮评审之后（2026-10-01，五条都改了）：
  - 发布没成功时错误里的「重试」绕过检查（中）：「重试」直接调发布。说明改回只剩预填再点它，照样发出去，违反验收 13。
    改成与「发布」走同一个判断（`submit`）：不能发布时不发，去原因所在处。11.3f 补了一例：改回预填、点「重试」，不发，焦点在说明框。
  - 发布成功以后重取 /sop 没成功（中）：成功那句要等重取回来（线上版本号对上）才出来。重取失败时，条里还写「草稿改了2节」，
    「发布…」也还能点，又没有 toast，看着像没发布出去。改成发布结果马上写进 /sop 的缓存（`outline.ts` 的
    `withPublished`：线上是它、草稿没了、字数按它算），不等重取。重取失败只在页头下就地报错。之后再改，自动保存从 v3 新建
    草稿（rev 为 null），不再带已经发布出去的那份草稿的 rev。成功那句仍只在线上还是那一版时留着（判断不变：缓存写进去以后
    当场就对上）。加 11.3p。
  - 请求在路上时能关抽屉（低）：关上以后答 500，错误写进关着的抽屉，再打开时又被清掉，哪里都不显示。改成在路上时关不掉：
    「取消」和关闭按钮禁用，按钮左边写「正在发布…」（§5.2：禁用的按钮旁边写原因）；Esc、点遮罩不调 `onClose`。
    关闭按钮的禁用样子加在 `sop.css`（text-3、`not-allowed`），共享的 `shell.css` 没动。没有选「关上以后错误写到页面上」：
    「取消」并不撤回请求，发布照样会成功，按了「取消」以后又看到「已发布v3」更让人糊涂。加 11.3q。
  - 别人在这期间发布过时左边那一版也叫「线上」（低）：替换说明写「将替换线上v3」，并排的栏头和读屏名称却写「线上v2」。
    改成按 `publish.ts` 的 `baseName` 写：页面上的版本还是线上版本时写「线上v2」，线上已是更新的一版（检查另取到的）时只写
    「v2」。「查看改动」标题后写「相对v2（线上已是v3）」（`diffAgainst`），它与发布抽屉共用页面上的同一个「现在的线上版本」。
    没写成「v2（草稿基于这一版）」：页面打开时草稿就已经跟不上（`draft.stale`），之后又有人发布的话，页面上的 v2 既不是
    草稿基于的那一版，也不是线上版本，这句话不对。spec 顶部加一行 `Revisions:`（含上一条）。加 11.3o3 与纯函数各例。
  - 存活的四例（低），都补了用例：A 抽屉没接 `useShownWhileClosing`（11.3u，直接渲染 `PublishDrawer`，换成关上时的新属性。
    happy-dom 支持 transition，打开的动画要等 antd 的 `motionDeadline` 500 毫秒才放完；放完以前关上，抽屉不画收起那一段就
    直接卸下，所以先等 600 毫秒再关。收起期间画过的样子留在拿下来的节点上，再拿来断言）；B 抽屉头下的分隔线随滚动出现、
    消失（11.3s）；C 只有落不到节上的问题时点「发布…」，把检查清单滚进视口（11.3s）；D 点「发布…」先存时撞上 409：
    不开抽屉、不再转圈，「载入最新草稿」以后也不会自己打开（11.3r）。
  - 变异（隔离副本 `mut-ux-sop/ux-6.3-r3`，每例 `perl alarm 300` 单进程只跑话术自测）：19 例（`PublishParts.tsx` 11、`SopPage.tsx`
    4、`publish.ts` 2、`outline.ts` 2）。第一轮 17 例让自测失败并点名，存活 2 例，补了用例以后重跑都抓到：
    一是 `withPublished` 不重算字数，原用例的发布结果与草稿字数相同，改用合并了别人前言的结果；二是 A，11.3u 原来没等
    打开的动画放完，见上。副本还原后与 worktree 逐字节相同，没有留下进程。
  - 自测 614 → 630 条断言。
  - preview 实测（Chromium，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在 9月26日 14:30，探针由评审的探针改写，在仓库外；
    浅色、深色各一轮）：
    - 「重试」：说明改回预填以后点它，只有第一次的 1 个发布请求，焦点在说明框、光标在末尾（13/13）。
    - 发布 200、紧接着 `GET /sop` 答 500：条「已发布v3（改了话术原则、异议处理）· 客户下一句就用新话术 · 回滚到v2」，「发布…」
      `aria-disabled`、旁边写「没有可发布的改动」；状态句「线上v3 · 老板发布于9月26日 14:31 · 没有未发布的改动」，页头下写
      「服务暂时连不上 · 重试」；再点「发布…」不发请求。
    - 在路上（发布延迟 1.5 秒后答 500，1440 与 375 宽）：「取消」disabled（`--subtle` 底、text-3、`not-allowed`），关闭按钮
      text-3、`not-allowed`，左边 13 text-2「正在发布…」（浅色 7.75、深色 8.43），375 宽也放得下；按 Esc、点遮罩、强点「取消」
      与关闭按钮以后抽屉还开着；答 500 以后错误在抽屉体最上面，「取消」又能点、原因没了，Esc 关上（光标停在关闭按钮上时，
      第一下 Esc 先关它的 Tooltip，这是 antd 弹层的先后，以前就这样）。
    - 别人发布了 v3（并排）：替换说明「将替换线上v3（小王·9月26日 13:00发布）」，栏头「v2 | 草稿」，读屏名称「「话术原则」v2」；
      「查看改动」标题「草稿的改动 相对v2（线上已是v3）」，1440 与 375 宽都在一行里、不溢出，页面宽等于视口。
    - 回归：B 页的发布条（1440 到 375）、抽屉的颜色与分隔线、成功以后焦点回到「发布…」、375 宽抽屉底部、家装假包，与上一轮相同。
    - 22 个场景 `securitypolicyviolation` 都是 0 次，页面错误 0 条，没有漏拦的接口；控制台只有故意答 500 时浏览器自己的
      「Failed to load resource」。
  - `pnpm test` 全过（85 秒），`PG_TEST_URL` 指向本机一次性的 `postgres:17-alpine` 容器（端口 4227，跑完即删），db 自测 329 条
    连真实 Postgres 部分一起跑；话术自测 630 条。产物：首屏 JS 315,259 B，换页最多 247,044 B（产品库，预算 250,000），
    preload 字体 172,448 B；新文案的字都已在 UI 优先片里，字体不用重切。

### 第 11 步（2026-09-28）

- 做了什么：
  - `fields/model.ts`（纯逻辑，只看字段类型与行业包配置）：一项的缺项与节点（`itemGaps`、`itemState`，缺项的口径同上架前检查报「没填」「没选」的那些）、条数提醒（`countGap`，口径同 `checkItem` 的条数一致项）与区块头右侧的说明（`countNote`，条数锁定时「条数随天数锁定，文字可改」）、一项里子字段的排法（`itemRows`：两列网格里半格的两两排进一行，DOM 顺序就是画出来的顺序，不用 `grid-auto-flow: dense`）、「复制上一{itemNoun}的…」要复制的值（`copyFromPrev`）、「本条写过的」（`writtenValues`）、引用候选按 filterBy 筛（`refLibrary`；`RefItem` 带上 payload）、库外文本（`freeText`）、长文本的字数与 softMax（`charCount`、`overSoftMax`）、子字段的「已改」（`subChanged`）。
  - 多字段有序子项的编辑器（`renderers.tsx` 的 `ItemCardsForm`）做成设计系统 §6.3 的通用组件：左侧竖轴宽 40、离卡片 12，节点直径 22，填全了 `--text-2` 实心，有缺项空心（1.5 的 `--control-border`），有写错的空心 danger；序号标签写得下（「D1」）写在节点里，写不下（「节点3」）节点只写序号、卡片第一行写全。卡片第一行「缺：当晚住宿」（13 warning，14 `triangle-alert`），这一项的组（`role="group"`，名字「第3天」）经 `aria-describedby` 连上它。右上角「上移」「下移」「删除这{itemNoun}」（28，text-3），第一项的上移、最后一项的下移 `aria-disabled`、40%；移动以后自动编号按位置重排，焦点跟着那一项停在同一个按钮上。条数随另一个字段锁定时四种按钮都不画。一天的卡片是「当天标题、当晚住宿」一行，再是当天安排、当天餐食（假包是「节点名称、工期」一行）；按钮压在第一行上，第一行右边那一格（`under-tools`）和卡片第一行的标签行给它让出 92。条数没变时改过的子字段各自标「已改」。只读时间轴同样两两成行。
  - `FormField`：区块头右侧的条数提醒（13 warning）或「条数随天数锁定，文字可改」（13 text-2，前置 12 的锁），连进这一组的 `aria-describedby`；长文本超过 softMax 时帮助换成 warning 色的「手机上会很长（建议120字以内）」（14 `triangle-alert`，报错仍然优先）；标签行右侧的文字按钮「复制上一{itemNoun}的{字段名}」（13/500 accent-text），点了以后焦点进这个字段的控件。
  - 引用（`ReferenceForm`）：联想分两组，「{实体名}库 · 贵州」按 filterBy 只列同一取值的（草稿跟「草稿」），「本条写过的」右侧写第一次出现在哪一项（「第2天」）；组标题 13/500 text-3、前一组和后一组之间 1px `--divider`（§5.3），组里的项与组标题同样左边距 8（antd 默认缩进 24）。下拉至少 384 宽，窗口 <992 时和输入框一样宽。`allowFree` 写了库外的文本时控件下方 13 text-3「酒店库里没有这个，按原文保存」，连进输入框的 `aria-describedby`。`FieldEnv` 加 `entityLabel`（详情页与样张页给）。长文本有 softMax 时字数写「75/120」，超过变 warning 色。
  - `FieldGrid`：给有序子项条数说明和打开时的值（子字段的「已改」）；filterBy 的取值进按字段记忆的 deps（目的地改了，逐日行程跟着重画，第一组跟着换）。`CatalogDetail` 跳到字段时不把「复制上一天的…」当控件。
- 自测：`fields.selftest.tsx` 1,484 → 1,516 条（新增第 12 节；第 5、7、10、11 节里按旧的 DOM（`section[aria-label="D2"]`、序号下的报错、卡片里的「D1」）找元素的几处改成按 `data-item-index` 和节点找，断言的内容不变）。
  - 纯逻辑：缺项与上架前检查的「没填」「没选」逐个子字段核对（两个包与一个数字、多选的夹具，28 种改法）；节点状态（一项本身的报错、写错的子字段、没填的子字段离开以后、别的项的报错）；条数提醒与 `checkItem` 的条数一致项核对（10 种天数写法乘 6 种条数）；区块头的说明（已上架、草稿、对上了、没有编辑权限、假包）；两两成行（旅游包编辑与只读、假包、一个半格与整行交错的夹具）；复制上一项、本条写过的、按目的地筛、库外文本、字数与 softMax、子字段「已改」。
  - 画出来的样子：G 页的节点（D3 缺项、D4 有报错）、按钮与 `aria-disabled`、子字段顺序、`under-tools`；条数锁定时没有按钮；假包节点里只写序号、卡片第一行「节点3」；只读时间轴的顺序。
  - 整页（真的路由与查询缓存）：G 页清空第3天的住宿（节点、「缺：当晚住宿」与读屏说明、复制按钮出现在哪几天）；离开空着的住宿以后字段下方报「没填」、节点仍是缺项；按 Enter 打开联想（两组的每一项、384 宽、敲字筛、和输入一样的不列）；复制上一天（值、焦点、按钮没了、节点实心）；目的地改成四川以后第一组换成四川的两家；库外文本的提示与读屏；131 字与 75 字的字数、提示、帮助；子字段「已改」；上移下移（到头的不动、焦点跟着走、保存条逐个子字段列、移回来没有改动）；上移以后 ⌘S 的补丁（天号 1–5、内容换位、键序不变）；删一天「还差1天」（连进读屏说明）、加两天「多了1天」、条数变了子字段不标「已改」。已上架线路：锁定说明（前置锁）、没有按钮、422 报在第2天住宿下时第2天的节点有报错；非编辑成员（天数与行程对不上）没有条数提醒、按钮和复制。假包草稿：节点、移动、「复制上一个节点的用到的主材」、主材的两组联想（第3、4个节点都是马可波罗，只列一次）、验收要点超过 80 字的提示。
- preview 实测（Playwright 1.63 Chromium，CSP 同线上，端口 4233，接口由 `context.route` 拦截，时钟钉在 9月26日 14:30、`Asia/Shanghai`，浅色、深色各一轮，7 个场景，探针在仓库外）：
  - G 页 1440×1100（草稿 r-guizhou-5d，清空第3天住宿、第4天当天安排改到 131 字、第3天住宿打开联想）：一项 x 272、宽 736；节点 x 281、在卡片上沿下 14、22×22；卡片 x 324、宽 684；按钮组离卡片右缘 12、上缘 11，28 见方，D1 的上移 `aria-disabled`、不透明度 0.4；当天标题与当晚住宿同一行（x 340 / 678，各 314 宽），当天安排在下一行。节点颜色：填全浅 rgb(77,77,85) 底白字、深 rgb(168,168,177) 底 rgb(18,18,20) 字；缺项空心，描边浅 `#88888F`、深 rgb(113,113,122)；「缺：当晚住宿」、softMax 提示、「131/120」浅 rgb(138,87,0)、深 rgb(240,179,85)；库外提示 13 text-3；「复制上一天的当晚住宿」13/500 accent-text。联想下拉 384 宽（x 678，输入框 314），两组「酒店库·贵州」三家（两家草稿）、「本条写过的」四项写第几天；组标题 13/20/500 text-3、内边距 8 8 4，第二组上方 1px divider（上 4），组里的项左边距 8。5 天的卡片第一行都不压右上角的按钮。
  - 第一轮走查查出两处，都改了：离开空着的住宿以后节点变成 danger（改成仍算缺项，见 spec 顶部第 11 步的 `Revisions:` 二）；下拉和输入框一样宽，名称被截断，组里的项缩进 24。
  - 1280 宽：第2天「当晚住宿」的标签行让出按钮以后，「复制上一天的当晚住宿」折到第二行（标签行 46 高），5 天都不压按钮；`scrollWidth` 1280。
  - 键盘：第1天的「下移」按 Enter，第1、2天换位，焦点在第2天的「下移」（`:focus-visible`）；Shift+Tab 到「上移」按 Enter 换回，焦点在第1天的「上移」，没有保存条；「复制上一天的当晚住宿」按 Enter，焦点进第3天的住宿。
  - E 页 1440×1100（已上架 r-sichuan-lux，改最累的一段出现保存条）：区块头 916–940，右侧「条数随天数锁定，文字可改」（13 text-2，锁 text-3），没有上移下移、删除、添加；第一天的当天标题输入框 992–1024、当晚住宿同一行，都在保存条上沿 1032 之上（第 10.1 步交接的首屏要求）。
  - 假包草稿 p-jiufang-part：节点里写序号、卡片第一行「节点3」；「复制上一个节点的用到的主材」写进第4个节点；第1个节点主材的联想「主材库」四件、「本条写过的」一项（第3个节点）；7 个节点的第一行都不压按钮。
  - 375 宽：第3天的卡片 275 宽，按钮在卡片里，子字段一列；联想下拉与输入框同宽（243，x 92），`scrollWidth` 开着下拉也是 375（384 宽的时候被推出左边 24，改成窄屏跟输入框一样宽）。
  - 非编辑成员：只读时间轴同样「当天标题、当晚住宿」在前，没有条数说明、按钮和复制，节点 22。
  - 两套主题 14 个场景：`securitypolicyviolation` 0 次，控制台错误 0 条，拦截的接口里没有落到兜底的请求。
- 构建（与第 10.3 步第二轮评审之后同一套算法，基准在 7ca8031 上构建）：入口集合 gzip 324,486 → 324,483 B；详情页换页 88,699 → 90,691 B，列表页 134,476 → 136,483 B（两页都带渲染器）；换页最多仍是话术页 200,114 → 200,108 B。
- 字体：新文案带进「很」，重跑 `scripts/fonts/build.ts`（仓库外的 venv，fonttools 4.66.0、brotli 1.2.0）：UI 优先片 780 → 781 个码位，159,744 → 159,912 B，两个 preload 合计 171,796 B；两个 Geist 文件不变。**合并时**三个字体文件照旧冲突，后合并的一方在合并结果上重跑 `build.ts`。
- 变异（仓库外的隔离副本 `mut-ux-catalog/step11`，每例跑一次 fields 自测、300 秒闹钟；还原后源码与 worktree 逐字节相同（`diff -r`）；收尾 ps 查过，没有留下进程）：第一轮 64 例（`model.ts` 28、`renderers.tsx` 24、`FormField` 8、`FieldGrid` 3、`CatalogDetail` 1），59 例被具名断言杀死，3 例是自测崩溃（断言里放了 DOM 元素，`JSON.stringify` 循环引用），2 例存活：去掉复制以后挪焦点（点之前焦点本来就在住宿里，happy-dom 的 `click()` 不挪焦点，断言恒真）、有序子项不把子字段的 filterBy 放进 deps（自测改目的地以后又改了住宿，逐日行程本来就要重画）。补断言（先把焦点放到按钮上；先清空住宿、再改目的地）、崩溃的三处改成布尔以后，第二轮这 5 例全部被具名断言杀死，没有超时。只在真浏览器里看得出的几处（`under-tools` 的让位、组里的项左边距、下拉宽度与窄屏、节点 22）由上面的 preview 实测量过：结构有自测（`under-tools` 的格数、`ref-popup` 与 384px 的宽度），样式由走查核对。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4239，用完即删），99 秒通过：db 自测 329 条（含真实 PG 部分），console 278 条，session 52 条，parts 99 条，shell 140 条，fields 1,516 条，check-console-src 102 条，eval 19/19 两遍。没有新增依赖。
- 偏离与取舍（前五条写进 spec 顶部第 11 步的 `Revisions:`）：
  - 「复制上一{itemNoun}的…」只在上一项填了、和这一项不同时画；点了以后焦点进这个字段（样张 G 页第4天、上一天空着，也没有画这个按钮）。
  - 节点的 danger 只给写错的；没填的子字段离开以后照常报「没填」，节点仍算缺项（第一轮走查发现变红，和「缺：当晚住宿」的 warning 打架）。
  - 联想：filterBy 字段没填时不筛；已选上的值筛掉了也留着；「本条写过的」和第一组同名的照列（样张同）；不能写库外的引用也分组；两组都按输入筛，和输入一样的不列。
  - 条数提醒、锁定说明只在能编辑时画。
  - 有 softMax 时字数写「75/120」（样张），超过时帮助换成提示。
  - 第二组的标题照 spec 写「本条写过的」（设计系统 G 页和样张写「本线路写过的」）；复制按钮照 spec 的模板写「复制上一天的当晚住宿」（样张写「复制上一天的住宿」），假包是「复制上一个节点的用到的主材」。
  - 样张 G 页把填全的几天收起成一行（「3天已填好，已收起」「全部展开」），spec 和设计系统 §6.3 都没写，没做。
  - 样张 G 页一天是三列（当天标题、当晚住宿、当天餐食）；设计系统 §6.0 规定编辑时多选 enum 占满一行，照设计系统排两列，当天餐食在当天安排下面。
  - 联想下拉的最小宽度 384 取自样张（设计系统没写）；窗口 <992 跟输入框一样宽。
  - 单字段的逐条列表（行程亮点、费用包含）没改：移动以后焦点留在原位置的按钮上（第 3.2 步的写法），留给第 16 步。
- 留给后面的步骤：
  - 第 16 步：单字段逐条列表的移动让焦点跟着那一条走（多字段的已经跟着走）；下拉分组标题在读屏里没有角色（rc-select 只给组标题一个 div），看第 16 步要不要补。
  - 第 17 步：走查截图（验收 4 的 G 页、E 页首屏连同页签、保存条与时间轴），本步量过的数字在上面。

### 第 11 步评审之后（2026-09-28）

- 评审四条，改了三条半：
  - 到头的「上移」「下移」焦点环太淡（中）：`aria-disabled` 的 `opacity: 0.4` 作用在整个按钮上，焦点环一起变淡，而移动以后焦点正好停在到头的按钮上。改成只降图标（`> svg`），按钮本身不降；单字段逐条列表（`.field-list-edit`）同改。设计系统 §6.3 的写法随之写明（外观不变）。
  - 只读时间轴读不到第几天（中）：节点对读屏隐藏，只读卡片又没有名字（非编辑成员、「预览」页签、匿名）。只读卡片和编辑卡片一样是 `role="group"`，名为「第1天」「第3个节点」。
  - 自测的四处空当（低）：补断言。整个逐日行程里的「复制上一天的…」只在当晚住宿上（第2、4、5天）；`.subitems-edit` 的 `aria-labelledby` 指向区块头「逐日行程·5天」；主材下拉里敲只在分组标题里的字（「写」「库」）什么也不列，敲「马可」两组各剩一项；375 宽时联想下拉不是 384 宽（1440 宽时是）。
  - 库外提示与上下文矛盾（低）：(b) 改了，下拉开着、列着候选时不注，收起、没有候选、离开以后照注。开合由 `onOpenChange` 记；rc-select 没有候选时不画下拉，这时也不报合上，所以「真画着下拉」是「开着并且有候选」。没有另在失焦时清掉开合：rc-select 自己在这种情形下也没合上，候选回来时下拉会自己再出来，清掉反而和画面对不上。(a) 没改：「—（返程）」确实按原文保存，提示属实；要免注得由行业包给 `allowFree` 字段声明约定值，是行业包配置结构的新增，不在本步。两条都写进 spec 顶部第 11 步评审之后的 `Revisions:`。
- 自测：`fields.selftest.tsx` 1,516 → 1,522 条。另有一条静态检查：`console/src/**/*.css` 里选中 `[aria-disabled='true']` 按钮本身的规则不许设 `opacity`（只许落到 `> svg` 这类后代）。自测里的 Esc 要带 `keyCode`：rc-select 的下拉按 `which` 认键，React 从 `keyCode` 取，`press` 只带 `key`，此前几处按的 Esc 其实没有合上下拉（不影响那些断言）。
- preview 实测（同第 11 步的探针与设置，端口 4233，浅色、深色各一轮，4 个场景，探针在仓库外）：
  - 键盘把第2天上移，焦点在第1天的「上移」（`aria-disabled`、`:focus-visible`）：按钮不透明度 1、图标 0.4；焦点环截图取样浅 rgb(43,99,230) 对白 5.21:1，深 rgb(47,104,235) 对 rgb(18,18,20) 3.83:1，与可用的「下移」相同（评审时是 1.82:1、1.56:1）。行程亮点第一条的「上移」同样按钮 1、图标 0.4。
  - 非编辑成员：逐日行程的 ariaSnapshot 是 group「第1天」到「第5天」；假包是「第1个节点」到「第7个节点」。
  - 库外提示：打开时第4、5天注，第1天不注；敲「荔」，下拉列 2 项，不注；Esc 以后注；敲全「云上西江酒店」，没有候选，注；敲着「荔」点到当天标题，注；选下拉里的荔波荔泉宾馆，不注。
  - 两套主题 8 个场景：`securitypolicyviolation` 0 次，控制台错误 0 条。
- 变异（隔离副本 `mut-ux-catalog/ux11-r2`，每例跑一次 fields 自测、300 秒闹钟；还原后 `diff -r` 与 worktree 相同；ps 查过，没有留下进程）：11 例全部被具名断言杀死。两处 CSS 把 `opacity` 挪回按钮；只读卡片去掉组、去掉组名；评审的四例（每个子字段都画复制按钮、编辑器的组没有名字、`matchRef` 让组标题参与筛选、窄屏固定 384）；库外提示三例（总是注、只看开合不看候选、不记开合）。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4239，用完即删），84 秒通过：db 自测 329 条（含真实 PG 部分），console 278 条，fields 1,522 条，check-console-src 102 条，eval 19/19 两遍；字体检查 599 个汉字都在 UI 优先片里（781 个码位，与第 11 步相同）；产物首屏 JS 324,483 B、换页最多 200,108 B，与第 11 步相同。
- 没有新增依赖；没有新的界面用字，字体不重切。

### 第 12 步（2026-09-28）

- 做了什么：
  - `src/shared/catalog-csv.ts`（前后端共用）拆成几步：`parseCatalogCsv`（替换字符、没闭合的引号是整份的问题）、`resolveCsvHeader`（字段名照旧可用，也认调用方传入的中文标签；「不合格原因」列整列忽略；字段名和标签指向同一个字段也算重复；缺编号列）、`convertCsvRow`（格子先 `unguardCell` 再去首尾空白）、`checkCsvRows`（转换没问题的行交给 validate，文件内编号重复点名前一行）。`prepareCatalogCsv(kind, csv, labels?)` 由它们组成，服务端照旧整份全部合格才建。另有 `entityCsvShape`（按行业包的字段配置推出列：编号存 id；多选按「、」分隔、按字符串存的多选是一格文字、只有一个文字子字段的有序子项按「、」分隔；多字段的有序子项、带点的键不成列；showWhen 管着的按选填算；字段配置里没写 `$code` 的实体也补上编号列）、`csvLabelsOf`、`guardCell` / `unguardCell`、`toCsv`、三条上限的常量与 `csvParts`（按行的顺序能放就放，每份都带表头，算要分几份）。服务端（`app.ts`）从租户的行业包取标签表传给 `importCatalogCsv`；CSV 报错里的英文键换成中文（spec 顶部第 12 步的 `Revisions:` 五）。
  - `console/src/csvFile.ts` 加 `readCsvBytes`：先 UTF-8 严格解码，不成再 `gb18030` 严格解码，都解不开才抛 `CsvEncodingError`；01 的 `decodeCsvFile` 不动（`console.selftest.ts` 里 01 的回归用例还在用）。`console/src/download.ts`：Blob 加 `<a download>` 存文件。
  - `console/src/catalog/csv-import.ts`（纯逻辑，只看行业包配置与字段类型）：模板（BOM、一行中文表头）与填写规则（每列怎么填，例子照列表的第一条写、编号写示例编号）；预检 `checkCsv`（空文件与只有表头、整份的问题、三条上限、逐行过 `checkItem`、编号是否已经有了，写成「每晚起价：要写整数，写的是「2,6OO」」并标出哪一格）；汇总与按钮文案；表格的列与列宽（`resultWidths`：名称与编号合成首列，数组不画，按表头与这份文件的内容估宽，原因占剩下的、至少 170）；提交（`submission`，去掉「不合格原因」列）；服务端 422 的逐行问题放回原来的行（`withServerIssues`）；下载不合格的行（`failedCsv`：加一列原因，每格加引号，危险字符开头的格子先去掉旧前缀再加一个制表符，带 BOM；少了格子的行补空格子）。
  - `console/src/catalog/CsvImportDialog.tsx`：880 宽、五步（步骤条、文件行、汇总、表格、底栏左边「上一步」），第 2 步的拖放区与「选择文件」、「粘贴」页签；导入中关不掉；第 5 步「已建N条草稿」，「去草稿页签」换到草稿页签并清掉搜索与筛选。样式 `csv-import.css` 随产品库页的块下载。`pages/CatalogPage.tsx` 的「导入CSV」（加 `file-up` 图标）第一次点时才挂弹窗、下载它的块，每次打开换一个 key 从第 1 步重来；建好以后列表失效。删掉 01 的 `pages/CsvImport.tsx` 和 `catalogForm.ts` 的 `legacyKind`。
- 自测：`console.selftest.ts` 278 → 282 条（验收 15 第 9 条：中文表头与英文表头导入的 payload 相同、「制表符 + =」与「制表符 + @」的前缀去掉；下载的不合格行文件带 BOM、引号和「不合格原因」列原样再导入；中文标签与字段名重复）。`fields.selftest.tsx` 1,522 → 1,625 条，新增第 13 节（每块包在 try 里，半路崩了记成具名失败接着跑）：列与标签（酒店的列与 schema 推出的逐列相同）、防公式、写 CSV 与三条上限（按字符与按 UTF-8 字节的边界正好卡在服务端的闸上）、解码（GBK 的字节由 Python 的 gbk 编码器算出）、H 页的预检、英文表头、提交、下载、改好重新导入、各种整份与逐行的问题、假包主材、服务端 422、填写规则与模板；再挂整页走一遍弹窗（五步、空文件、只有表头、解不开、拖放 GBK 文件、H 页的表格与底栏、两次下载的字节、422、导入中、连不上与重试、完成、去草稿页签、再打开从头来、250 行、粘贴、服务端说整份不合格、Esc、假包主材）。
- 变异（仓库外的隔离副本 `mut-ux-catalog/ux12`，每例跑一次 fields 自测或 console 自测、300 秒闹钟，按测试锁排队；还原后 `diff -r` 与 worktree 相同；收尾 ps 查过，没有留下进程）：57 例，共用的 `catalog-csv.ts` 19 例（表头别名、原因列、重复、缺编号列、防公式的全角、去前缀只去一个、写 CSV 的引号、三条上限的边界与字节数、转换出错不再校验、重复点名、showWhen、storeAs、单值子项、补编号列、服务端不传标签）、服务端 2 例（`app.ts`、`catalog.ts` 不传标签，console 自测点名）、解码 3 例、`csv-import.ts` 22 例、弹窗与页面 11 例（空文件、422、刷新列表、去草稿页签、导入中能关、换步不挪焦点、重开不重来、整份不合格仍给导入、拖放、拖进来不变样、编码错误的说明）。第一轮 55 例被杀，其中 11 例是自测半路崩掉（表格或文件框不在时的空引用，`report()` 没跑到，看不出是哪条）；存活 2 例。自测随之改成：预检不是逐行的结果时记一条具名失败、给空表，第 13 节每块包在 try 里；另补全部合格（info）与全部要改两种汇总。重跑这 13 例，12 例被具名断言杀死；存活 1 例是等价变异：`convertCsvRow` 不先 `unguardCell`，去首尾空白已经把开头的制表符去掉了（spec 顶部第 12 步的 `Revisions:` 三）。
- preview 实测（Playwright Chromium，CSP 同线上，端口 4234，接口由 `context.route` 拦截，时钟钉在 9月26日 14:30，浅色、深色各一轮，探针在仓库外）：
  - H 页 1440×1100：弹窗 x 280、880 宽；步骤条 22 的圆，已完成两步打勾、text-2，当前一步 `--primary` 底、名字 text 500，没到的 text-3；文件行「新签酒店-9月.csv 按UTF-8读取·8行」与右边「换一个文件」；汇总 warning（浅色底 `#FFF3DC`）；表头 32 高，8 行都是 52 高，列宽 40 / 72 / 174 / 55 / 68 / 107 / 128 / 188，正好 832 不横滚，原因折成两行；出错的格子 `--danger-bg` 底、danger 字、圆角 4；「2,6OO」的两个 O 在格子和原因里都是 danger 色波浪下划线；底栏「上一步」「下载不合格的2行（带原因）」「只导入合格的6行」。深色同样，出错格子 `#3A1714` 底、`#FF9B8F` 字。
  - 下载：模板「酒店导入模板.csv」，前三个字节 EF BB BF，只有一行中文表头；不合格的行「新签酒店-9月-不合格的2行.csv」，带 BOM，每格加引号，原因在最后一列。
  - 拖放：在拖放区上发 dragenter、dragover、drop（DataTransfer 里放 GBK 文件），拖放区换样，进第 3 步，文件行「按GBK读取·1行」，名称「三亚湾酒店」不乱码。空文件停在第 2 步，文件行下 13 号 danger「这份文件没有要导入的行」，底栏只有「上一步」。
  - 导入：接口慢 1.5 秒时第 4 步「正在导入6条草稿」，右上角关闭点不动、底栏没有按钮；之后第 5 步「已建6条草稿」与「去草稿页签逐条检查后上架」，提交的 CSV 是表头加 6 行；「去草稿页签」以后地址 `?status=draft`，页签「草稿6」，侧栏计数随之变成 29，焦点回到「导入CSV」。250 行：「这份文件太大，请分成2份导入」和上限，没有发请求。粘贴英文表头的两行：「粘贴的内容·2行」「导入2条草稿」；Esc 关上，焦点回到「导入CSV」（有焦点环）。
  - 假包主材：标题「从CSV导入主材」，规则表 8 行（环保等级标「（选填）」，例子取第一件主材），表头按它的字段，质保写成「五年」那一行要改。
  - 375×812：页面不横滚；步骤条只写当前一步的名字，其余只画序号；表格在自己的容器里横滚；底栏折行。
  - 两套主题 16 个场景：`securitypolicyviolation` 0 次，控制台错误 0 条。
- 构建：CSV 的解析与预检都在弹窗自己的块里（`CsvImportDialog-*.js`，原样 21.53 kB、gzip 8.84 kB；01 的旧导入弹窗是 3.46 kB、gzip 1.94 kB，解析在服务端；模块是 `csvFile.ts`、`download.ts`、`src/shared/csv.ts`、`src/shared/catalog-csv.ts`、`csv-import.ts` 与弹窗本身），第一次点「导入CSV」才下载（第 2.4 步留下的那一条）。与基准（ux-11 的 2a57530，同一套依赖与算法）比：首屏 324,483 → 323,014 B；列表页换页 136,534 → 135,206 B；详情页 90,744 → 90,038 B；话术页 200,108 → 200,324 B（共用块重排），仍是换页最多。
- 字体：新文案带进「骤因板拖校」，重跑 `scripts/fonts/build.ts`（仓库外的 venv，fonttools 4.66.0、brotli 1.2.0）：UI 优先片 781 → 783 个码位，159,912 → 160,920 B；两个 Geist 文件不变。**合并时**三个字体文件照旧冲突，后合并的一方在合并结果上重跑 `build.ts`。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4238，用完即删），83 秒通过：db 自测 329 条（含真实 PG 部分），config 451 条，console 282 条，fields 1,625 条，check-console-src 102 条，eval 19/19 两遍；字体检查 601 个汉字都在 UI 优先片里。没有新增依赖。
- 偏离与取舍（spec 顶部第 12 步的 `Revisions:` 记了前五条）：
  - 前端不直接调 `prepareCatalogCsv`，调它拆出来的几步，列按行业包推出、逐行过 `checkItem`（一）。
  - 「不合格原因」列再导入时忽略（二）。
  - `unguardCell` 只去「制表符 + 危险字符」开头的一个制表符；01 的去首尾空白照旧，导入结果上分不出来（三，变异 M7 因此存活，是等价变异）。
  - 三条上限按整份文件查，超了不画表格（四）。
  - 服务端 CSV 报错去掉英文键（五）。
  - 弹窗标题写「从CSV导入{实体名}」（H 页样张）；入口按钮照 spec 写「导入CSV」（样张写「从CSV导入」），加 `file-up` 图标（设计系统 §7）。弹窗照别的弹窗放在 top 100，样张是上下居中。
  - 表格不画数组列（标签、亮点），它们的问题照样写在原因里；名称与编号合成首列（H 页）。
  - 第 4 步「导入」是请求在路上和失败时停的一步：连不上就地报错带「重试」，左边「上一步」回第 3 步；422 `invalid_csv` 直接回第 3 步，问题放回原来的行，「只导入合格的N行」跟着变；服务端说整份不合格（第 0 行）时写出原因，不再给导入按钮。
  - 第 5 步的按钮是「关闭」和主按钮「去草稿页签」，句子「去草稿页签逐条检查后上架」写在正文里。
  - 粘贴的内容为空时写「粘贴的内容里没有要导入的行」；文件行写「粘贴的内容」，右边是「改粘贴的内容」。
  - 填写规则的例子照列表的第一条写（一整行读下来就是能导入的数据），编号写行业包的示例编号；还没有条目时取 placeholder「例：」后面的。
  - 375 宽：步骤条只写当前一步的名字（其余的名字留给读屏），底栏折行。
- 留给后面的步骤：
  - 第 14 步（审计）：CSV 导入的草稿和手动新建一样记 `catalog.create`，合成一句、展开看每一条（设计系统 §10.0），本步没改审计。
  - 第 17 步：走查截图（验收 4 的「酒店 CSV 导入（含 GBK 文件和坏行）」）；验收 19 的「Excel 双击打开模板」「简体中文 Windows 上另存的文件」要在真 Excel 上测。

### 第 12 步评审之后（2026-09-28）

- 评审六条，全改：
  - 第1步的规则表被撑出弹窗（中）：例子一格 `nowrap`，表格又是自动布局，旅游包第一家酒店的亮点很长，例子一列撑到 826，表格超出弹窗右缘，弹窗高过视口。规则表改成固定布局（`tableLayout="fixed"`），表头 180、例子 220 定宽，怎么填占剩下的；例子只占一行，长的省略、悬停看全文。表格至少 600 宽（`scroll.x`），比弹窗窄时（375 宽）在自己的容器里横向滚动，同第3步的表格。
  - 一行就超上限时预检拦不住（低）：`csvParts` 让每份的第一行无条件放进去，算出来是「1份」，请求照发，服务端回 413 或 400。共用的 `catalog-csv.ts` 加 `csvLongRows`（连同表头单独一份也超上限的行），`csvParts` 遇到这种行返回 `Infinity`；`checkCsv` 先查它，有就是新的一种结果 `long`：第3步写「第N行太长，分成几份也导入不了」（最多写三个行号，多了写「等N行」）和上限，加一句「这一行连同表头单独一份也超了」，不画表格、没有导入按钮。弹窗的 `doImport` 在 `submission().fits` 为假时不发请求（合格的行是预检通过的那份的子集，照理到不了这里，是兜底）。spec 顶部第 12 步的 `Revisions:` 加了第六条。
  - 从空状态导入，关上以后焦点掉到 body（低）：建好以后列表重新取到，空状态卸了，antd 要还焦点的那个按钮已经不在了。弹窗加 `afterClose`（antd 还完焦点之后调），产品库页在这里把焦点放到挂着的「导入CSV」上（导入按钮同一时刻只挂一份：有条目时在页头，没有时在空状态里，ref 指着挂着的那份；本来就回到它上面的情形不变）。
  - 下载的不合格行里多了格子的行（低）：原因跑到没有表头的第10列。原因固定在「不合格原因」那一列，多出来的格子照原样放在它右边（不截掉、不并进别的格子：看得出多在哪，再导入时这一行照旧是列数不对）。
  - 弹窗的三处空当（低）：导入中按 Esc、点遮罩（先在遮罩上按下再点，与 rc-dialog 的判断相同）都关不掉；对照组是不在导入时点遮罩能关上。主流程改成从带搜索与筛选的 `/catalog/hotel?q=松赞&f=destination:云南` 进来，「去草稿页签」以后地址只剩 `status=draft`。文件行下的那一句断言 `role="alert"`。
  - 文案没人看着（低）：console 自测「库里已有这个 code」整句比较服务端回的 `[{ row: 2, issues: [{ path: 'id', message: '这个编号已经有了' }] }]`；fields 加一例编号撞上草稿，写「（草稿里的酒店，草稿）」。
- 自测：`fields.selftest.tsx` 1,625 → 1,643 条（太长的行按字符、按字节正好卡在上限上的不算、多一个字就算，`csvParts` 是 `Infinity`，`fits` 为假，`checkCsv` 的 `long` 先于 `big`，标题与说明；多了格子的行；撞上草稿；规则表的固定布局、600 最小宽与两列定宽；弹窗里太长的行；导入中 Esc 与遮罩；带搜索进来；`role="alert"`；从空状态导入以后焦点到页头的「导入CSV」）。`console.selftest.ts` 282 条，条数不变，一条改成整句比较。
- 变异（隔离副本 `mut-ux-catalog/ux12-r1`，每例单进程 `node --import tsx` 跑一次 fields 或 console 自测、300 秒闹钟、按测试锁排队；还原后 `diff -r` 与 worktree 相同（只差没进 git 的 `console/build-meta`）；ps 查过，没有留下进程）：24 例。规则表 2 例（不用固定布局、不设最小宽度）；上限 11 例（不返回 Infinity、`csvLongRows` 恒空、字符与字节两处边界 `>` 改 `>=`、不计表头、`checkCsv` 不查、排在「太大」之后、行号不截断、`> 3` 改 `>= 3`、说明不分一行几行、弹窗不画）；下载 2 例（多的格子照旧接在原因前、多的格子丢掉）；焦点 2 例（页面不挪、弹窗不转 `afterClose`）；评审点名存活的 4 例（Esc、遮罩、保留搜索、去掉 `role`）；文案 2 例（撞上草稿也写已上架、服务端退回「这个 code 已经有了」）；`doImport` 不看 `fits` 1 例。第一轮 22 例被具名断言杀死；字节边界那例存活（自测里放得下的那行只到 65,534 B），改成正好 65,536 B（21,837 个汉字加两个 ASCII）以后被杀。`doImport` 不看 `fits` 那例存活，是等价变异：合格的行是通过预检的那份的子集，到不了那一行。
- preview 实测（Playwright Chromium，CSP 同线上，端口 4232，接口由 `context.route` 拦截、按线上规则超 64 KB 回 413，探针在仓库外，按渲染锁排队）：
  - 第1步 1440×1100：弹窗 880 宽、625 高（评审时 1307）；规则表 x 304、832 宽，右缘 1136，在弹窗（右缘 1160）里面；三列 180 / 432 / 220；8 行都是 40 高；例子一格 204 宽，酒店亮点那一行省略。浅色、深色相同。
  - 第1步 375×812：弹窗 359 宽；规则表 600 宽，在 311 宽的容器里横向滚动，三列 180 / 200 / 220；页面不横滚（375 / 375）。
  - 一行 22,000 个汉字：第3步「第1行太长，分成几份也导入不了」和上限，底栏只有「上一步」，没有发请求。
  - 空列表导入 7 条：点底栏「关闭」，焦点在页头的「导入CSV」；点「去草稿页签」，地址 `?status=draft`，焦点同样在页头的「导入CSV」。有条目时 Esc、「关闭」照旧回到「导入CSV」。假包主材照常。
  - 两套主题 16 个场景：`securitypolicyviolation` 0 次，控制台错误 0 条。
- 字体：新文案带进「独」，重跑 `scripts/fonts/build.ts`（同第 12 步的 venv）：UI 优先片 783 → 784 个码位，160,920 → 161,164 B；两个 Geist 文件不变。合并时照旧由后合并的一方重跑。
- 门禁：四道都过。`pnpm test` 带 `PG_TEST_URL`（本机一次性 pgvector/pgvector:pg17 容器，端口 4238，用完即删），87 秒通过：db 自测 329 条（含真实 PG 部分），config 451 条，console 282 条，fields 1,643 条，check-console-src 102 条，eval 19/19 两遍；字体检查 602 个汉字都在 UI 优先片里。产物：首屏 JS 323,014 → 323,012 B，换页最多仍是话术页 200,324 → 200,322 B；导入弹窗的块 21.53 → 22.29 kB（gzip 8.84 → 9.12 kB），仍是第一次点「导入CSV」才下载。
- 没有新增依赖。

### 第 7 步（2026-10-01）

- 做了什么：
  - `console/src/sop/search.ts`：话术页地址上的 `section`、`view=history`、`v=2`（只认正整数），路由表与话术自测共用这一份，不 import
    别的模块。`router.tsx` 只换成 import 它。
  - `console/src/sop/history.ts`（纯函数）：翻页（每页列 20、取 21，多取的是页上最后一个版本的前一版）、前一版（版本号小 1）、
    每一行的说明与下一行（作者那一段按来源写「系统导入」「系统更新」，回滚写「回到v1」，后台发布与回滚写「改了N节（节名）」，
    只算可编辑节；系统更新的说明换成「代码里的固定规则变了」）、技术详情（四个哈希的前 12 位，系统更新另带存下来的原话）、
    「v2相对v1改了什么」与哪几节变了（固定规则节也列）、回滚的计划与后果（同 `src/config/sop.ts` 的 `rebase`：草稿的基线、
    目标、草稿三方比，有交集要先合并、没有自动并入；目标的固定规则节和线上不同另写一条）、差异块的标题、载入到草稿会改哪几节、
    会盖掉草稿自己改过的哪几节、「丢弃草稿」不能点的原因。`outline.ts` 导出 `bodyOf`，`changedSections` 多一个 `withLocked`。
  - `console/src/sop/HistoryParts.tsx`：`SopActions`（页头的「更多」与「版本记录」，memo；「更多」受控、`aria-expanded`、
    打开时焦点进菜单）；`HistoryList`（420 抽屉的体：草稿一行、各版本、技术详情、「更早的版本」/「没有更早的版本了」、
    骨架、整块与翻页的「没取到 · 重试」）；`useKnownVersion`、`useVersionPair`（版本记录里有的不再取）；`VersionBanner`、
    `VersionView`（主区的对比，行内 / 并排同发布抽屉的选择）。`PublishParts.tsx` 的 `SopDrawer` 导出，多 `size`（420 / 640）、
    关闭按钮的读屏名称、数组形式的状态。
  - `RollbackModal.tsx` 按 spec「回滚」重做（640）：后果列表、草稿那一条（基线不是线上时另取，取的时候骨架、取不到就地重试）、
    固定规则改过、差异块（`--subtle` 底、逐节行内差异，最高 `min(360px, 40vh)`）、必填的「为什么回滚」、「再看看」默认焦点、
    底栏的原因；关上的动画放完以后清掉原因与错误。
  - `SopPage.tsx`：页头的「丢弃」换成 `SopActions`；页面底部 01 的版本历史表去掉；抽屉、查看改动、回滚、载入、丢弃的接线与焦点
    （关抽屉回到「版本记录」，继续编辑、载入、回到编辑去编辑器，查看改动去对比的标题，丢弃确认关上回到「更多」，载入确认
    「再看看」回到点的那个按钮）；换节、定位、跳到问题先离开对比。查看改动时额度条与三栏收起，`sop.css` 让内容区排成一列、
    对比撑满，发布条照样在面板底部。
  - `parts/ConfirmDanger.tsx` 加可选的 `focusTriggerAfterClose`（默认照旧）。
  - 字体按新文案重切：UI 优先片 783 → 787 个码位（加「覆盖继续觉得追切」，去掉不再出现的「历史渲染」），160,564 → 161,788 B。
  - `sop.selftest.tsx` 第 12 节（纯函数与整页对假服务端，见文件头），第 9–11 节里用页头「丢弃」和页面底部版本历史的用例改走
    「更多」与抽屉；假服务端加 `GET /sop/versions/:id`、回滚取目标版本的节、几个失败开关。630 → 703 条断言，约 23 秒，
    `pnpm test` 的调用不变。9.3a「全存上了：离开这一页不拦」原来等「丢弃」按钮能点，现在等存上的 rev 再隔 50 毫秒
    （React Query 隔一个宏任务才通知页面重渲，只等缓存会在页面还没按新草稿重渲时就跳走，被离开保护拦下）。
- preview 实测（Chromium，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在 9月26日 14:30，数据是真实的 `data/sop.md`：
  v1 导入、v2 在异议处理的「嫌贵」里加了「先问一句每人预算上限……」，草稿同第 6.3 步；浅色、深色各一轮，探针在仓库外）：
  - 页头：「更多」32×32、「版本记录」106×32，图标 text-2。抽屉 (1020,0) 420×900，头 56、标题 16/24/600，状态「线上v2·另有1份草稿」
    （浅色 8.37:1、深色 7.28:1）；行内边距 16 0、行间 `--divider`；版本号 14/600、说明 14/500、下一行 13 text-2（8.37 / 7.28）；
    文字按钮 14/500 accent-text（5.71 / 6.85）；技术详情折叠（5.95 / 5.5），抽屉里看得见的文字没有 12 位以上的十六进制；
    底部「没有更早的版本了」text-3（5.95 / 5.5）。地址 `?section=tone&view=history`。
  - 回滚弹窗 (400,100) 640 宽：默认焦点在「再看看」；后果四条，前三条图标 text-2，「先合并」那条 `--warning-icon`（浅色
    `#B86E00`、深色 `#F0B355`）；差异块 `--subtle` 底，标题「回滚后，线上的可编辑节会变成这样：异议处理529 → 496字（撤回v2的改动）」
    13/500；弹窗里没有红色；底栏 `--frame` 底，「写上为什么回滚」「再看看」「回滚到v1」。没写原因点「回滚到v1」：不发、焦点到输入框、
    `aria-invalid`；写上以后 Enter：发出、toast「已回滚到v1：新版本v3」，状态句线上v3，抽屉里 v3 是线上、写「回到v1·改了1节（异议处理）」，
    焦点回到「回滚到这版…」。Esc 先关弹窗、再关抽屉，焦点回到「版本记录」。草稿只改了话术原则时最后一条是「你的草稿会在发布时自动并入。」
  - 查看改动：地址 `?section=tone&v=2`，横幅 (88,104) 1312×50「正在查看v2」加「回到编辑」，标题 16/24/600 并拿到焦点，下一行
    「客户嫌贵时先问预算上限，再给两档方案·老板·9月25日 18:30·改了1节（异议处理）」，只列异议处理；额度条与编辑器不在；发布条在面板底部
    (56,832)（改之前跟在对比后面、浮在面板中间，见下）。同一地址刷新：另取 `versions?limit=2&before=3`，样子相同；「回到编辑」后焦点在正文上。
  - 载入到草稿（草稿改了两节）：确认框「会覆盖草稿里的：话术原则、异议处理。」默认焦点「再看看」；「覆盖并载入」以后 PUT 带 rev 4、
    两节，抽屉关上，焦点在正文上，toast「已把v1载入草稿」，状态句「草稿改了1节」（话术原则回到线上的写法）。
  - 「更多」：菜单 208 宽，「丢弃草稿」不是 danger（17.72 / 14.7）；没有草稿时写「丢弃草稿 还没有草稿」、不能点。丢弃确认的正文与按钮
    同第 5–6 步，默认焦点「保留」，关上以后焦点回到「更多」；丢弃以后状态句「没有未发布的改动」。
  - 只用键盘：「更多」上 Enter 打开菜单、焦点进菜单，Enter（或 ↓ 再 Enter）打开丢弃确认、焦点在「保留」，Esc 回到「更多」；
    「版本记录」上 Enter 打开抽屉；行里的「回滚到这版…」「载入到草稿再改」上 Enter 打开各自的确认框，Esc 回到那个按钮。
  - 375 宽：抽屉 375 宽占满，页面宽 375；回滚弹窗 359 宽，比视口高时随焦点滚到底栏；查看改动页面宽 375。坐席：页头只有「版本记录」，
    抽屉里只有「查看改动」。
  - 14 轮场景 `securitypolicyviolation` 0 次，页面错误与控制台错误 0 条，没有漏拦的接口。
- 走查时改掉的（都补了用例）：查看改动的标题不能聚焦（加 `tabIndex=-1`）；「覆盖并载入」以后 antd 把焦点还给已经卸下的抽屉按钮、掉到 body
  （确认框不还焦点，由页面放进编辑器，「再看看」时还给那个按钮）；丢弃确认关上同样掉到 body（改为回到「更多」）；菜单项上 Enter 打开的
  确认框一闪就关：确认框同步打开、焦点锁把焦点放到弹窗的关闭按钮上，这一下 Enter 的默认动作按下了它（拦下 keydown 的默认动作）；
  菜单打开时焦点不进菜单（`autoFocus`）；查看改动时发布条浮在中间（内容区在对比时排成一列、对比撑满）；375 宽的回滚弹窗高过视口
  （差异块最高改成 `min(360px, 40vh)`）。
- 变异（仓库外的隔离副本 `mut-ux-sop/ux-7`，每例 `node --import tsx` 单进程只跑话术自测、限时 300 秒）：51 例（`history.ts` 20、
  `search.ts` 2、`outline.ts` 1、`HistoryParts.tsx` 12、`SopPage.tsx` 13、`RollbackModal.tsx` 3）。第一轮 47 例失败，其中 3 例是自测崩掉
  （`!` 取不到弹窗、编辑器），没有点名；存活 4 例：恰好 20 个的一页也当成还有下一页、草稿改了哪几节按线上比、回滚的目标不另取、
  浏览器后退不还焦点（happy-dom 里抽屉不抢焦点，焦点本来就停在「版本记录」上）。补了用例、崩的几处改成取不到也能比以后，这 7 例重跑
  全部失败并点名。副本还原后与 worktree 逐字节相同，没有留下进程。
- 构建：首屏 JS 315,259 → 315,263 B；换页最多仍是产品库，247,044 → 248,396 B（+1,352，共用的 `UnsavedGuard` 块带着 ConfirmDanger），
  余 1,604 B；preload 字体 172,448 → 173,672 B。话术页自己要下的 JS（按静态 import 从 `sop.lazy` 出发、入口集合以外，gzip -9；
  同一个算法在本步之前的产物上重算是 240,361 B）240,361 → 155,639 B：01 的版本历史表去掉以后，话术页不再下载 antd 的 Table 块；
  CSS 3,308 → 3,796 B。
- 偏离与取舍（记进 spec 顶部的 `Revisions:`，八处）：查看改动比前面紧挨着的一版、固定规则节也列、最早的版本不给、换节等先离开对比、
  地址进不进浏览历史；线上版本与只读成员的操作照 C 页、来源与系统更新的写法、草稿那一行；回滚的「你的草稿」含没存上的改动、基线另取、
  差异块的标题、标题不带说明；「为什么回滚」的说明不写审计日志、原因必填的做法；载入走自动保存、只在会盖掉草稿自己的改动时确认；
  「丢弃草稿」不能点时写原因、键盘与焦点；`ConfirmDanger` 的 `focusTriggerAfterClose`；每页 20 个多取 1 个。
- 没有新增依赖。`pnpm test` 全过（93 秒）：`PG_TEST_URL` 指向本机一次性的 `pgvector/pgvector:pg17` 容器（端口 4228，跑完即删），
  db 自测 329 条连真实 Postgres 部分一起跑；话术自测 703 条。第一次跑在产品库的换页预算上失败（453,155 / 250,000 B），原因同第 6.3 步：
  主仓库的 `node_modules` 按已经删掉 `@rjsf/*` 的 dev 装过，本分支的产品库页面还 import 它；worktree 里按本分支的 lockfile 装
  （`pnpm install --frozen-lockfile --prefer-offline`，换掉两个软链接，依赖没变）以后通过。
- 留给后面的步骤：
  - 第 8 步：回滚确认里「回滚后要先合并，才能发布」与发布抽屉同样还没有「去合并」；合并做好以后回滚确认不用改，`rollbackPlan` 已按
    发布时的三方合并算。
  - 状态句（第 5.1 步的 `memberStatus`）在线上版本是导入或系统更新时写「import-config发布于…」「system发布于…」：这两种版本的
    `publishedByName` 存的是命令名，不是空。版本记录里已按来源写「系统导入」「系统更新」（`history.ts` 的 `authorOf`），状态句没改，
    走查（第 17 步）之前改成同一个写法。
- 评审之后（2026-10-01，六条都改了，spec 不用改）：
  - 看着某一版时打开版本记录（中）：「继续编辑」「载入到草稿再改」只去掉 `view`、留着 `v`，编辑器不回来，焦点掉到 body，
    载入以后还看着旧的对比。`closeHistory('editor')` 一并去掉 `v`（不进浏览历史），同 spec 修订一「先回到编辑」。
  - 用例缺口（中）：评审的 8 个存活变异都补了用例（12.2h）：只有没存上的改动时的草稿那一行、回滚确认里的「你的草稿」；草稿
    那一行技术详情的两个哈希（没跑过检查不画）；关上再打开回滚确认，原因是空的；「为什么回滚」里 Enter 提交；没存上时
    「丢弃草稿」写「改动还在保存」（防抖设成永远不到，不靠「保存中」挡）；看着某一版、第一个问题就在当前节时点「发布…」。
    原因原来在关上的动画回调（`afterOpenChange(false)`）里清，happy-dom 不放这段动画、回调不来，测不到；改成目标变了（打开、
    换了一个）时清，不靠回调，关上的回调只放下目标。
  - 回滚确认关上以后的焦点（低）：只有 Chromium 回到「回滚到这版…」；WebKit 点按钮不给按钮焦点，antd 还给打开时的
    activeElement（抽屉）。改成同载入确认：页面记下点的按钮（版本记录的「回滚到这版…」与发布条的「回滚到v2」都传），弹窗的
    `focusable.focusTriggerAfterClose` 关掉，目标清空以后还给它（还连着的话）。
  - 抽屉头的线上版本（低）：别人在这期间发布过时写页面上的 v2，列表里 v3 是线上。改用 `online`（检查另取到的那一版），同发布
    抽屉与回滚确认。
  - 查看回滚出来的那一版写「回滚」（低）：对比的下一行没传回滚目标。`useRolledBackTo` 抽出来与版本记录那一行共用：手上有就用，
    没有按 id 另取，写「回到v1」。
  - 随地址打开的抽屉关上以后焦点掉到 body（低）：没有点过的按钮时还给页头的「版本记录」（`SopActions` 多一个 `historyRef`）；
    浏览器后退关上的，原来只认点开过的抽屉，改成抽屉一关上（不是查看改动、继续编辑这类去别处的）就同 Esc。
  - 变异（隔离副本 `mut-ux-sop/ux-7-r1`，每例 `node --import tsx` 单进程只跑话术自测、限时 300 秒）：15 例全部让自测失败并点名。
    撤回修复 7 例：「继续编辑」「载入」留着 `v`、抽屉头用页面上的线上版本、回滚确认关上不还焦点、发布条的「回滚到v2」不记按钮、
    对比不传回滚目标、没有点过的按钮不回落到「版本记录」、后退只认点开过的抽屉；评审的 8 例：「你的草稿」不含没存上的改动、
    回滚确认与草稿那一行只认存下的草稿（2 例）、草稿那一行没有哈希、打开时不清原因、Enter 不提交、丢弃不看没存上的、
    当前节不离开对比。副本还原后与 worktree 逐字节相同，没有留下进程。
  - 自测 703 → 718 条断言。
  - preview 实测（Chromium 与 WebKit，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在 9月26日 14:30，探针在仓库外，数据同上；
    浅色、深色各一轮，两个引擎结果相同）：
    - `?section=tone&v=2` 打开版本记录 →「继续编辑」：地址 `?section=tone`，编辑器在、对比不在，焦点在「话术原则」正文上。
      `?section=objections&v=2` →「载入到草稿再改」→「覆盖并载入」：PUT 1 次，toast「已把v1载入草稿」，地址 `?section=objections`，
      编辑器里是 v1 的写法，焦点在「异议处理」正文上。
    - 回滚确认：打开时焦点在「再看看」；写了一半点「再看看」、再打开按 Esc，两次焦点都回到「回滚到这版…」，再打开原因是空的；
      写上原因按 Enter 发出回滚，抽屉头「线上v3·另有1份草稿」，v3 写「老板·9月26日 14:31·回到v1·改了1节（异议处理）」，
      焦点回到「回滚到这版…」。
    - 查看 v3：下一行「退回去·老板·9月26日 14:31·回到v1·改了1节（异议处理）」，焦点在标题上；同一地址刷新照样，另取了
      `versions/v1`。
    - 页面打开以后小王发布了 v3：改一个字、存上、检查以后，抽屉头「版本记录线上v3·另有1份草稿」，列表里 v3 是线上，v2 有
      回滚与载入；状态句仍按页面上的 v2 写（同第 6.3 步）。
    - `?section=tone&view=history` 打开：Esc、关闭按钮关上以后，焦点都在页头的「版本记录」上。
    - 页面自己的 `securitypolicyviolation` 0 次。WebKit 每截一张图记一次 `style-src-elem`（控制台「Refused to apply a
      stylesheet」），来源是 `web-inspector://bootstrap.js`，即 Playwright 在 WebKit 里截图时往页面插的样式（`caret` 设成
      `initial` 也有）；不截图的流程是 0 次，页面里也没有不带 nonce 的 `<style>`。除此以外控制台错误 0 条，没有漏拦的接口。
  - `pnpm test` 全过（92 秒），`PG_TEST_URL` 指向本机一次性的 `pgvector/pgvector:pg17` 容器（端口 4228，跑完即删），db 自测 329 条
    连真实 Postgres 部分一起跑；话术自测 718 条。产物：首屏 JS 315,253 B，换页最多 248,397 B（产品库，预算 250,000），preload 字体
    173,672 B；没有新文案，字体不用重切。没有新增依赖。

### 第 8 步（2026-10-01）

- 做了什么：
  - 服务端：`SaveDraftBody.rebaseOnto`（可选）；`saveSopDraft` 在已有草稿、`rev` 对得上时，`rebaseOnto` 不是当前发布版本 → 409
    `rev_conflict`（「线上又有新版本，刷新后重来」），按发布时同一个三方 `rebase`（基线是草稿的 `based_on`）算，撞上的节没在 `edits`
    里 → 409 `sop_conflict`（`keys` 是缺的节，`current` 只带这几节的线上正文），不然存「rebase 结果再应用 `edits`」、`based_on` 换成
    线上版本，`rev` 由触发器加 1；`rev` 为 null 却带了 `rebaseOnto` → 422 `invalid_sop`（「没有草稿，不需要合并」），在进事务之前就拦。
    `updateDraftSections` 多一个可选的 `basedOn`，触发器允许草稿改 `based_on`，没有迁移；不记审计。`console.selftest.ts` 加验收 15
    第 3、4 条（草稿改话术原则 → 别人回滚到话术原则不同的 v0 → 发布 409 → 三种失败各一次、草稿都没动 → 带合并结果保存 200、
    上游另改的微信语气并进来、草稿自己改的异议处理留着、`stale` 与 `rebase.needed` 为 false → 发布成功、线上正文等于合并结果 →
    没有草稿时带 `rebaseOnto` 422），281 → 288 条。
  - `console/src/sop/merge.ts`（纯函数）：进入合并（要合并的节按节表、固定规则节不算，右边从草稿这一节的正文开始）、重新比一次
    （仍要合并的节里合并里改过的写法留着、没改过的取新草稿，「处理好了」清掉）、还有几节、处理好了去哪、完成合并发的 `edits`、
    合并里改过哪几节与退出的确认、目录的标记、说明行、提醒的标题、完成合并以后的 `/sop` 缓存（`withMerged`）。
  - `console/src/sop/MergeParts.tsx`：`MergeEditor`（`MergeView`，`revertControls: 'a-to-b'`，自己画的 24 见方按钮，lucide
    `arrow-right`，读屏名称与 CSS 画的提示都是 `phrases` 里那一句「采用线上的写法」；键盘 Enter / 空格转成库认的 mousedown，
    采用以后焦点去下一块的按钮，没有了到右边的正文；左边只读但在 Tab 顺序里）、`MergePane`（标题可由页面聚焦、说明行、两栏的名字、
    「这一节处理好了」与点过以后的状态）、`MergeActions`（「退出合并」「完成合并」）。
  - `SopPage.tsx`：「去合并」（页头下的提醒、发布抽屉）先存、重查，查回来仍有要合并的节才进合并模式（渲染时看，同 `opening`）；
    合并模式的页头、目录标记、中栏、别的节只读、额度条与右栏收起、提醒不出、自动保存暂停（`autosave.ts` 的 `paused`）；焦点
    （进来、处理好一节、完成合并不能点、重新比过、退出）；完成合并（一次 PUT，成功以后先写缓存、等合并存下的草稿进了缓存再打开发布抽屉）、
    没成功（409 重新比一次、别的就地重试）、退出的确认、离开拦下；发布 409 时抽屉开着、重查，重查回来之前照 409 写；合并期间版本记录里
    「载入到草稿再改」不能点。01 留下的「发布被拒」提醒（贴当前版本正文、「先复制出来再丢弃重做」）去掉。
  - 别处：`check.ts` 草稿刚换了的那一次渲染里 `running` 就是 true（不然去合并会拿存之前的检查结果进合并）；`publish.ts` 发布条在合并期间
    的原因「完成合并以后才能发布」、抽屉的原因改成「合并完1节即可发布」（点了去「去合并」）；`PublishParts.tsx` 抽屉里冲突那一条带
    「去合并」（在等时转圈）、「发布…」可取 ref；`Directory.tsx` 行与窄屏下拉里的「需合并」「已处理」；`editor.ts` 导出 `lucideSvg`；
    `outline.ts` 的 `OutlineRow.merge`；`parts/PrimaryButton.tsx` 加一个可选的 `ref` 属性（只加不改，页面要把焦点还给它）；`sop.css`。
  - 字体：新文案多一个「右」，去掉的提醒带走了「拒」：UI 优先片仍是 787 个码位，161,788 → 161,796 B，preload 合计 173,672 → 173,680 B。
  - `sop.selftest.tsx` 第 13 节（纯函数、暂停的自动保存、左右对照在 DOM 里的两种采用与焦点、整页对按三方比算冲突的假服务端，含家装假包），
    第 10.3e 与第 11 节按新的写法改了三处（冲突的提醒带「去合并」、409 不关抽屉、抽屉的原因）；假服务端认 `rebaseOnto`、按包的节表
    规范化正文。718 → 761 条，约 30 秒，`pnpm test` 的调用不变。
- preview 实测（Chromium 全部场景、WebKit 主流程与退出，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在 9月26日 14:30，
  数据是真实的 `data/sop.md` 与旅游包：线上 v2，草稿基于 v2 改了话术原则与异议处理，店长发布了 v3，改了话术原则的一句与前言；
  浅色、深色各一轮，探针在仓库外）：
  - 页头下的提醒「有1节在你改的同时被改了：话术原则」加「去合并」；抽屉里同一句，「发布」不能点、原因「合并完1节即可发布」，点「发布」
    焦点到「去合并」。
  - 合并模式（1440×1000，侧栏收起）：地址 `?section=tone`；状态句「还有1节要合并」，「完成合并」`aria-disabled`、`aria-describedby`
    指向状态句；目录「话术原则 · 需合并」；额度条、检查清单、工具卡片不在；中栏 (384,108) 1016 宽，卡片 1016，两栏 492 | 32 | 492，
    3 个按钮 24×24 在 x=880；标题 16/24/600，正文 16/28；说明行与栏名 13 text-2（浅色 8.37:1、深色 7.93:1）；改到的行左边 `--subtle`
    （`rgba(9,9,11,.05)` / `rgba(255,255,255,.06)`）、右边 `--accent-bg`（`rgb(237,243,254)` / `rgb(21,39,77)`），上面的字
    15.93 / 15.9 与 13.88 / 12.57；提示 `--text` 底、`--panel` 字 13/20、内边距 4 8、圆角 6；发布条「完成合并以后才能发布」；
    焦点在「话术原则」标题上。
  - 键盘：第一个按钮上 Enter，右边这一块换成线上的写法，按钮 3 → 2，焦点到下一个按钮。「完成合并」不能点时点它：不发请求，焦点回到标题。
    「这一节处理好了」：目录「已处理」，状态句「要合并的节都处理好了」，焦点到「完成合并」。完成合并：PUT `{ basedOn: v3, rev: 4,
edits: [话术原则], rebaseOnto: v3 }`，回到抽屉「将替换线上v3（店长·9月26日 13:10发布）」，逐节改动话术原则、异议处理，预填
    「修改：话术原则、异议处理。」，没有冲突；发布成功「已发布v4（改了话术原则、异议处理）」、焦点回到「发布…」，前言是店长的；
    版本记录 v4、v3、v2。全程按钮的字与读屏名称没有英文。
  - 退出：合并里改右边，等 2 秒没有 PUT；「退出合并」弹确认（默认焦点「接着合并」），「接着合并」回到「退出合并」，确认以后焦点在
    编辑器正文上、提醒还在。完成合并答 500：页头下「服务暂时连不上 · 重试」；「重试」答 409：「这期间别人又改了草稿或发布了新版本」，
    「载入最新内容」以后横幅没了、「还有1节要合并」、焦点在标题上。
  - 1280 宽：卡片 872，两栏各 420；375 宽：页面宽 375，目录是下拉（选中项带「需合并」），两栏各 148（窄，能用；spec 不要求 375 宽能合并）。
  - Chromium 所有场景 `securitypolicyviolation` 0 次，页面错误 0 条，没有漏拦的接口；控制台只有故意答 500、409 时浏览器自己的
    「Failed to load resource」。WebKit 截图的轮次每截一张记一次 `style-src-elem`（主流程 9 张 9 次、退出 3 张 3 次，同第 7 步：
    Playwright 截图时往页面插的样式），不截图重跑是 0 次。
  - 走查时改掉的（都补了用例）：完成合并以后抽屉的预填有时把店长改的前言也算进去（浏览器里 React Query 通知页面晚于别的状态，
    抽屉按旧缓存预填）：改成等合并存下的那份草稿进了缓存再打开；「完成合并」不能点时点它，已经在那一节上的焦点不动：改成直接聚焦标题。
- 变异（仓库外的隔离副本 `mut-ux-sop/ux-8`，每例 `perl alarm 300` 单进程只跑对应的自测：服务端 9 例跑 console 自测，界面 50 例跑话术自测）：
  第一轮 59 例，47 例让自测失败（4 例是自测在取不到合并的编辑器、确认框时崩掉，这几处改成取不到也能比），存活 12 例：
  - 补了用例的 9 例：键盘采用以后焦点去紧挨着的那一块（原来两块，最后一块就是下一块）；自动保存的 `paused`（直接测钩子）；
    完成合并以后等缓存再开抽屉（把 React Query 的通知推迟 30 毫秒，同浏览器里的先后）；「去合并」在等时转圈（提醒与抽屉各一）；
    先存没存上时不进合并、不再转圈；去合并时存的那一次改变了要不要合并（等存上以后的检查，`check.ts` 的修正）；重新比过以后还在看的节
    不用合并了，去第一个要合并的节；进合并时清掉编辑器里的改动（不然完成合并以后它们被当成没存上的改动、盖掉合并的结果，抽屉也不开）。另补一例：
    合并期间版本记录里「载入到草稿再改」不能点（第二轮新加的变异，原来没测）。
  - 删掉的 1 例：完成合并、重新比过时又清一次编辑器的改动，合并期间它一直是空的，两处删了。
  - 留着的 2 例：页面传给自动保存的 `paused`，合并期间编辑器的改动一直是空的（进来时清掉、别的节只读、对照里的字记在合并的状态里），
    到不了，留着当明说的约束；「完成合并」不能点、已经在那一节上时直接聚焦标题，happy-dom 里点按钮以后 antd 总会再重渲一次，焦点照样
    到标题，测不出，由上面的 preview 走查管（改之前的代码就是这个变异，Chromium 里焦点停在「完成合并」上）。
  - 第二轮重跑存活的与新加的 12 例，改紧断言以后除上面留着的 2 例都让自测失败并点名。副本里的源文件还原后与 worktree 逐字节相同，没有留下进程。
- 构建：首屏 JS 315,253 → 315,258 B；换页最多仍是产品库，248,397 → 248,401 B（`PrimaryButton` 的改动），余 1,599 B；话术页自己要下的
  JS（同第 7 步的算法：从 `sop.lazy` 按静态 import 走、减去入口集合、gzip -9；本步之前在 cc1bdb9 上重算是 155,745 B）155,745 → 158,353 B
  （+2,608），CSS 3,796 → 4,259 B；preload 字体 173,672 → 173,680 B。
- 偏离与取舍（记进 spec 顶部的 `Revisions:`，七处）：去合并先存、重查，抽屉等进了合并模式才关；发布 409 抽屉开着（改第 6.3 步修订五）；
  合并模式按节走、别的节只读、额度条与右栏收起；页头加「退出合并」，「完成合并」不能点时去第一个没处理的节；「已处理」与处理好以后去哪；
  「采用线上的写法」的图标按钮与键盘（设计系统 §7 加 `arrow-right`）；退出的确认；完成合并以后先写缓存、409 重新比一次。
- 没有新增依赖；worktree 按本分支的 lockfile 装了一份（`pnpm install --frozen-lockfile --prefer-offline`，换掉两个软链接，原因同第 6.3、7 步：
  主仓库的 `node_modules` 按已删掉 `@rjsf/*` 的 dev 装过）。`pnpm test` 全过（98 秒），`PG_TEST_URL` 指向本机一次性的
  `pgvector/pgvector:pg17` 容器（端口 4229，跑完即删），db 自测 329 条连真实 Postgres 部分一起跑；console 自测 288 条、话术自测 761 条。
- 01 plan「Open」里「冲突后只能丢弃重做」那条标成已解决，指向本步。
- 留给后面的步骤：「Open」里新加一条（页面打开时草稿就已过期，目录与逐节改动把别人改的节算成你改的）；第 16 步可以看看 375 宽的合并
  （两栏各 148，spec 没要求）。
- 评审之后（2026-10-01，五条：四条照改，第二条只改说明行、不改版式；spec 顶部加一条 `Revisions:`）：
  - 「载入最新内容」丢掉你写的（中）：完成合并答 409 以后重新比一次，不再冲突的节连同右边写的一起没了（一节也不冲突时连合并模式
    也退了、没有一句话），横幅却写「你在右边写的留着」。`restartMerge` 改成合并里改过右边的节都留在合并里、写法照旧（`kept`，
    说明行「需合并 · 你在合并里改过这一节，右边留着你写的」），只有改的写法已经和新草稿一样才不留；一节也不用留了才退出，
    toast「不用再合并了」，焦点回编辑器。这期间草稿没了（别人发布或丢弃了）原来会卡住（检查答 404、「重试」什么也不做），
    现在不查、按线上版本比，完成合并在线上版本上新建草稿（`rev` 为 null、不带 `rebaseOnto`）。去哪一节、焦点放哪改在合并的状态
    换好以后的 effect 里定（`mergeFocus` 的 `restart`），不再按发请求前的旧状态算。没有把不再冲突的节放回编辑器的改动、由自动保存
    存：自动保存只在没有待存的改动时跟上服务端的 `rev`，那样会带着旧的 `rev` 发出去、撞 409。
  - 合并期间别的节写「可编辑」（低）：说明行换成「合并期间只读，完成或退出合并以后再改 · 496 → 506字（+10）」（`readOnlyMeta`，
    `SectionPane` 多一个可选的 `meta`）。编辑卡片照旧最宽 688、不随合并模式加宽：688 是设计系统 B 页的中栏宽，1280–1439 的两栏
    右边本来就空着同样一条。
  - 窄屏下拉的合并标记没有用例（低）：13.3h 在 1100 宽进合并，选中项写「需合并」、处理好了写「已处理」（停在同一节，只有标记变）。
  - 只有草稿变了的 409 没有用例（低）：13.3e7 别人存了一次草稿、改了话术原则（线上照旧 v3），载入以后右边是别人存的写法，完成合并
    发的就是看到的、`rev` 是新草稿的。假服务端的 `rebaseOnto` 照 `src/config/sop.ts` 核对 `rev` 与草稿在不在（原来不核对）。
  - 验收 14 的主路径没有用例（低）：13.3i 检查说能发布 → 发布答 409 → 抽屉里「去合并」→ 完成合并，合并以后的检查按住。写用例时
    发现一个评审没报的问题：新的检查回来之前，抽屉与页头下的提醒照上一次检查（合并以前的）写冲突，`clearResults()` 在也一样，
    抽屉里又是「有1节在你改的同时被改了 · 去合并」。改成检查报的「要合并」只在草稿的基线不是检查那时的线上版本时算（`behind`）。
  - 另补 13.3e3（不再冲突、改过的节不是第一节，留在这一节）、13.3e4（一节也不冲突、改过的留着，完成合并带 `rebaseOnto`）、
    13.3e5（草稿没了）、13.3e5b（草稿没了、你写的就是新线上的写法：退出）、13.3e6（都不用留：toast、焦点、提醒）；13.1 加
    `kept` 与两种说明行；13.3a 加只读的说明行。话术自测 761 → 771 条。
  - 变异（隔离副本 `mut-ux-sop/ux-8r`，每例 `node --import tsx` 单进程只跑话术自测、限时 300 秒）：25 例，22 例让自测失败
    （1 例是自测在草稿没了时取 `draft!` 崩掉，改成取不到也能比，重跑点名），存活 3 例：没有草稿时右边从空串开始、完成合并以后的
    info 提醒照上一次检查，补了 13.3e5b 与 13.3i 的「页头下没有提醒」，重跑都点名；留着的 1 例是重新比时线上版本总取重取的 `/sop`
    （不取检查另取的那一份）：假服务端里两份一样，改之前就是这样取的。评审的 MA、MB、CB、MC 四例都在里面、都让自测失败。
    副本还原后与 worktree 逐字节相同，没有留下进程。
  - preview 实测（Chromium 浅色、深色带截图，WebKit 浅色、深色不截图，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在
    9月26日 14:30，数据同上，探针在仓库外）：
    - 评审的场景：话术原则合并里写「我在合并里写的一句。」、处理好，线上换成 v2 的写法（v4）→ 完成合并 409 →「载入最新内容」：
      还在合并里，「还有1节要合并」，说明行「需合并·你在合并里改过这一节，右边留着你写的」，栏名「线上v4的写法」，右边有那一句，
      焦点在标题上；处理好、完成合并：PUT `{ basedOn: v4, rev: 4, edits: [话术原则], rebaseOnto: v4 }`，草稿里有那一句，回到抽屉、
      没有冲突。同样的流程不写字：退出合并，toast「不用再合并了」，焦点在话术原则正文上，提醒「草稿打开之后发布过新版本，发布时自动合并」。
    - 合并期间点异议处理：说明行「合并期间只读，完成或退出合并以后再改·496 → 506字（+10）」，浅色 8.37:1、深色 7.93:1，
      `contenteditable=false`、`aria-readonly=true`；1440 宽卡片 688（中栏 1016），1280 宽 688（中栏 872）。
    - 375 宽：下拉的选中项进合并前没有标记，进合并「需合并」，处理好「已处理」，页面宽 375。
    - 发布 409：抽屉「有1节在你改的同时被改了：话术原则 · 去合并」、原因「合并完1节即可发布」→ 去合并 → 处理好 → 完成合并（检查按住）：
      抽屉没有冲突那一条、原因「正在检查…」、页头下没有提醒、写好的说明还在；放开以后「将替换线上v3」、能发布，发布成功
      「已发布v4（改了话术原则、异议处理）」。
    - 两个引擎结果相同；`securitypolicyviolation` 0 次，页面错误 0 条，没有漏拦的接口，控制台只有故意答 409 时浏览器的
      「Failed to load resource」。
  - 字体：新文案的字都在 UI 优先片里（「冲突」不在，说明行改了说法），不用重切。没有新增依赖。
  - `pnpm test` 全过（99 秒），`PG_TEST_URL` 指向本机一次性的 `pgvector/pgvector:pg17` 容器（端口 4229，跑完即删）；话术自测 771 条。
    产物：首屏 JS 315,258 → 315,262 B，换页最多仍是产品库 248,401 → 248,403 B，preload 字体 173,680 B 不变。

### 话术页两条 owner 决定（2026-10-01）

- 做了什么：owner 当天就「Open」里第 5.3 步与第 8 步走查时的两条拍板，两条都从「Open」删掉；spec 顶部加一行 `Revisions:`，「销售话术」的「比较的基准」「自动保存」「发布条」三处补写；设计系统 B 页的发布条加一条。
  - 发布条的「没保存上 · 重试」：`PublishBar` 多两个可选属性 `saveFailed`、`onRetrySave`，页面在自动保存是 `failed`（连不上、5xx、429 与别的 4xx；409 是 `conflict`，另有横幅）时传。左边换成 danger 的 `circle-x` 与 14/500 danger「没保存上 · 重试」（「重试」同状态句，`saver.flush`），原来的摘要（改了哪几节、问题数、字数）降成 13 的补充；摘要这一格不缩不裁，放不下时省略的是后面的补充（`sop.css` 的 `is-save-failed`）。条里不另设 status（读屏怎么念见下面「评审之后」）。「没保存上」由 `SaveParts.tsx` 导出（`SAVE_FAILED`），两处同一个。
  - 比较的基准：`SopPage.tsx` 的 `useDraftBase`。草稿 `stale` 时用 `useKnownVersion`（与回滚确认同一个缓存，多一个可选的 `inHand`）取 `draft.basedOn` 那一版，不然就是线上版本。目录与额度条（`memberOutline`）、状态句与发布条（同一份 `changed`）、编辑器的改动标记与说明行、「查看改动」与发布抽屉的逐节改动和预填（`changedSections`）、两个抽屉左边那一版的名字、丢弃的确认、载入到草稿的 `loadPlan` 都改成相对它。第一次打开时取到以前整页是骨架，没取到整块出错、能重试（抽出 `SopPending`，与取 `/sop` 时同一个样子），检查与它同时发出。画出来以后才换的（回滚、载入最新草稿以后）：这次打开以后见过的线上版本与版本记录里有的直接用；要另取时先按线上版本算，没取到在页头下写「没取到草稿的基线版本」「改动先按线上版本算，别人改的节也会算进来」和「重试」，页面不卸下。合并以后草稿不再 `stale`，基准回到线上版本，没有另加代码。
- 偏离与取舍：
  - owner 点名的是目录、额度条、「草稿改了N节」、逐节改动四处。编辑器的改动标记与说明行的字数差、丢弃与载入到草稿的确认说的也是「草稿改了什么」，一起换了，不然同一页上两种口径（前言在目录上没改，编辑器沟槽里却有竖条）。`locateViolations` 的「线上版本里含这句的节」照旧是线上版本。
  - 第一次打开时不先按线上版本画、取到再换：那样一打开就把别人改的节标成你改的，过几百毫秒又改掉。代价是打开过期的草稿多一个往返（取回 `/sop` 才知道要取哪一版）。
  - 画出来以后才换基准时不卸下页面（编辑中的内容在 `MemberSop` 里，卸下就丢），所以那时没取到只能先按线上版本算并说明。实际里新的基准多半就是页面见过的线上版本（回滚、别人发布或回滚以后），不另取。
  - 回滚确认自己取基准的骨架与报错（第 7 步）现在只在页面上那一次没取到、版本记录第一页里也没有它时出现：打开版本记录以后，第一页里有的版本会经 TanStack 的 `initialData` 补进那条缓存，页面上的报错也随之消失。原来的 12.2e 改成「回滚确认用页面取到的那一份、不再取」，回滚确认自己取的样子挪到 14.5b，用夹具造出这种情况（草稿基于版本记录第一页以外的 v3）。
  - 10.3e 的假服务端补上 v2（页面要取它），先等页面画出来再看提示，断言不变。
- 自测：话术自测加第 14 节（14.1–14.6），771 → 792 条断言，单跑约 12 秒。
- 变异（隔离副本 `mut-sop-owner`，每例 `perl alarm 300` 只跑话术自测）：22 例，21 例第一轮就让自测失败；存活 1 例是页头下报错条件里多余的 `shown &&`（画出来以前整页是骨架，画不到这条报错），等价变异，删掉了这个条件。另有两例是断言里放了 DOM 节点、`JSON.stringify` 崩掉，改成布尔以后重跑都点名。副本还原后与 worktree 逐字节相同，没有留下进程。
- preview 实测（Chromium 浅色、深色带截图，WebKit 浅色、深色不截图，Playwright，CSP 同线上，`page.route` 拦接口，时钟钉在 9月26日 14:30，探针在仓库外）：
  - 在话术原则末尾打字（页头已缩成吸顶条）时连不上：发布条左边「没保存上·重试·草稿改了2节（话术原则、异议处理）·字数2,243 / 2,658」，「重试」28×26、焦点框完整露出；「没保存上」与图标浅色 `#B42318`（白底 6.57:1）、深色 `#FF9B8F`（9.21:1）。375 宽时补充按省略号截断，「重试」照样在，页面宽 375。点「重试」存上以后换回原来的摘要；422 同样，页头下另有横幅。1440、1280、375 三种宽度都在视口里。
  - 打开过期的草稿（线上 v3 只改了前言）：取 v2 的 1.5 秒里是骨架；之后目录只有话术原则、异议处理带圆点，状态句「线上v3·店长发布于9月26日 13:10·草稿改了2节」，额度条两节算改过，前言的编辑器没有竖条、说明行「可编辑·232字」；查看改动「草稿的改动相对v2（线上已是v3）」两节；发布抽屉「将替换线上v3」、两节、预填「修改：话术原则、异议处理。」。取不到时整块「没取到 · 重试」，重试以后同上。
  - 载入最新草稿以后基准换成没见过的 v3、取不到：页头下的报错，目录先算 3 节；「重试」以后报错没了、2 节。
  - 两个引擎结果相同；`securitypolicyviolation` 0 次，页面错误 0 条，没有漏拦的接口；控制台只有故意的连不上、409、422、500 时浏览器自己的「Failed to load resource」。
- 字体：新文案的字都在 UI 优先片里，不用重切。没有新增依赖。
- `pnpm test` 全过（126 秒），`PG_TEST_URL` 指向本机一次性的 `pgvector/pgvector:pg17` 容器（端口 4285，跑完即删）；话术自测 792 条。
  产物（与 origin/dev 同一份副本比）：首屏 JS 327,497 → 327,495 B，换页最多仍是话术页 169,489 → 169,891 B，preload 字体 177,092 B 不变。
- 评审之后（同日，三条全改，spec 顶部另加一行 `Revisions:`，设计系统 B 页的发布条补两句）：
  - 读屏念不到「没保存上」（WCAG 4.1.3）：状态句里的 `role=status` 在页头吸顶时随 `.page-status` 的 `display: none` 掉出无障碍树，而这正是要补的情形。
    改成 `SaveParts.tsx` 的 `SaveLive`：页面上一处看不见的 `role=status`（`.sop-save-live`，fixed 钉在左上、1×1、`clip-path`，同产品库详情的 `.save-live`），
    放在页头以外，念「保存中…」「已自动保存14:05」「没保存上，重试」；状态句的 `.sop-save-now` 不再是 status（没吸顶时不念两遍），发布条里照旧不设。
    没取评审给的另一种改法（吸顶时把状态句改成视觉隐藏）：里面的「重试」是按钮，看不见却还在 Tab 顺序里，焦点会落到看不见的地方。
  - 「草稿和线上一样」不实：比较的基准不是线上版本时，草稿自己没改不等于和线上一样。`publish.ts` 加 `sameAs`，基准就是线上版本时照旧「和线上一样」，
    不是时「和v2一样（线上已是v3）」；发布条的摘要（含没保存上时后面的补充）、版本记录里草稿那一行（`draftLine` 多一个参数）、查看改动与发布抽屉里没有改动时那一句都用它。
    「发布…」的原因、状态句的「没有未发布的改动」不变。页面打开以后别人才发布的（检查另取到更新的线上版本、草稿基于页面上的那一版）同样按它写。
  - 补测（话术自测 14.2 加骨架三行，新增 14.7–14.10）：这次打开以后才成为线上的版本当基线时不另取；回滚以后重取已经取到的基线没成功时不报错、目录不变；
    取基线时的骨架有额度条、筛选、说明行；没有改动又没保存上时条上的补充；两个抽屉里没有改动时那一句。
  - 话术自测 792 → 801 条。变异（隔离副本 `mut-sop-owner`，每例 `perl alarm 300` 只跑话术自测）：14 例全部点名，含评审存活的 4 例
    （删掉记下见过的线上版本、`baseError` 不看有没有取到、取基线时的骨架 `member={false}`、没保存上时补充的回退写成空串）；副本还原后与 worktree 逐字节相同。
  - preview 实测（同上的探针，Chromium 与 WebKit，浅色、深色，1440、1280、375）：吸顶时没保存上，Chromium 的 CDP 无障碍树里有且只有一个 `status`
    （polite，「没保存上，重试」，不在页头里，1×1）；滚回顶上、页头没吸顶时同样只有这一个；375 宽页面宽 375。草稿等于 v2、线上 v3 只改了前言：
    发布条「草稿和v2一样（线上已是v3）」、原因「没有可发布的改动」，版本记录草稿那一行「未发布·和v2一样（线上已是v3）」。`securitypolicyviolation` 0 次，
    控制台只有故意的断网、422 时浏览器自己的「Failed to load resource」。新文案的字都在 UI 优先片里。

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
