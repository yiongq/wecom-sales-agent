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
- [ ] 2. 外壳、通用部件与新增接口（5）
  - [x] 2.1 服务端与共享代码：`Me.tenantName`；`src/shared/pack.ts` 的类型；`src/packs/travel/console-pack.ts` 与 `src/packs/registry.ts`，`tenant-create` 改读注册表；`GET /pack`；`src/shared/conversation.ts`（`conversationState`、`shortIdOf`）；`ConvQuery.state` / `stage` / `order` 与 `GET /conversations/counts`；`sectionBody`、`editableChars` 连同 `SopStructureError` 等挪到 `src/shared/sop-sections.ts`（做法见 spec「额度条」）。`console.selftest.ts` 加验收 15 的第 1、5、6、7 条。01 implemented 之后在 01 顶部加 `Amended by:`。
  - [ ] 2.2 外壳：启动的加载与出错（spec「外壳 · 启动」）；侧栏由行业包生成（分组、计数、会话软徽标）；租户行与铃铛弹层，含空状态与轮询失败，刷新方式按 spec「外壳 · 计数刷新」；搜索触发器与 ⌘K（键盘、数据来源、各种状态按 spec「外壳 · 搜索触发器」，拼音库懒加载）；用户行（纯 CSS 先藏角色）与用户菜单（外观、减少动态效果、关于、退出）；受控收起与 `useViewport()` 三档；匿名外壳与横幅；非编辑角色的「只读」；跳转链接与地标；`document.title`。走查时核对：用户菜单里切外观，下一帧就是终值颜色，没有渐变（主题切换 0ms，靠第 1.1 步的 `data-theme-switching`）。
  - [x] 2.3 通用部件：`StateView`、`ERROR_COPY`（含兜底）、`TechDetails`、`ConfirmDanger`、`Status`、`ActionBar`、`CheckList`、墨色主按钮组件、成功 toast 函数；未保存保护（`useBlocker`）；会话过期的判定与就地重登（spec「会话过期的判定」）；全站去掉 `message.error`。`scripts/check-console-src.ts` 挂进 `pnpm lint`，先覆盖不变量 2–4、6、8、9、28。`Status`、`ConfirmDanger` 做好后加进 `/_specimen` 控件样张（第 1.3 步）。
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

## Open

- 待 owner（第 1.4 步）：spec「性能」一节写「preview 不压缩」，与实测不符。vite 8.3.1 的 preview 自带 `@polka/compression`，1 KB 以上的 text、JS、JSON 响应按 `Accept-Encoding` 走 gzip，所以 preview 上 `/console/assets/*` 的 JS、CSS 也是压缩的。它不加 `Vary: Accept-Encoding`，这些响应又带 immutable 长缓存，`Vary` 只有 `Origin`。影响只在本地 preview：真实 host 由 Hono `compress` 加 `Vary`，验收 23 也以 host 为准，所以没改代码。建议在 spec 顶部 `Revisions:` 记一笔，把那句改成「preview 上的压缩是 vite 自带的，不作验收依据」。如果要 preview 的头与 host 完全一致，可以在 `previewWithCsp` 里给 JS、CSS 资源补上 `Vary: Accept-Encoding`。

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
