# 后台 UX 重做 · 实现计划

对应 [spec.md](spec.md)。每步单独一个 PR 进 `dev`；界面改动要在 PR 里写 BEFORE/AFTER。步骤里的「见 xx」指 spec 的章节。新增依赖一律钉精确版本：下面写的是 2026-09-26 的最新版，安装时如果有更新的版本，以安装时为准，并写进 PR。

- [ ] 0. 开工前提
  - [ ] 0.1 01 翻为 `implemented`（01 plan 第 17–20 步完成）。在那之前本 spec 不开工。
  - [ ] 0.2 （owner）审阅 spec，翻为 `ready`；对开放问题 8（会话昵称）给出选择，或确认维持现状。
  - [ ] 0.3 开工时明确说「按 docs/features/console-ux/spec.md 实现」。本 spec 不在自动选活的范围里。
- [ ] 1. 主题地基（见「视觉方案」）
  - [ ] 1.1 `console/src/theme.ts`：`PALETTE`（两套 token、components、primaryFg、brand）、钉住种子色的算法包装、`PRIMARY_FG_KEYS`、`antdTheme`、`CONTRAST_PAIRS`。`main.tsx` 接入 theme、`button.autoInsertSpace=false`、`form.requiredMark` 函数。外观切换存到 `localStorage['yt.theme']`，读写包 try/catch。
  - [ ] 1.2 `console/src/styles/brand.css`：两套 `--yt-*`、焦点环、`text-autospace`、reduced-motion、固定规则节斜纹、`.yt-boot` 页头骨架、侧栏选中竖条。
  - [ ] 1.3 首屏：`console/public/theme-boot.js`；`console/index.html` 加 `color-scheme`、`theme-boot.js` 和 `#boot` 骨架（只画页头，只用 class）。`vite.config.ts` 设 `build.assetsInlineLimit: 0`。
  - [ ] 1.4 CodeMirror：`TextEditor`、`SectionDiff` 改读 `--yt-*`，深色加 `darkTheme`，去掉写死的颜色；覆盖 `@codemirror/merge` 的红色类；`phrases` 汉化；`unifiedMergeView` 传 `mergeControls:false`。
  - [ ] 1.5 `StatusPill`，以及控件样张页 `/_specimen`（只在 `VITE_SPECIMEN=1` 时注册）。
  - [ ] 1.6 `console/src/theme.selftest.ts`（对比度、组件键覆盖、brand.css 与 `PALETTE` 一致）串进 `pnpm test`（验收 1）。
- [ ] 2. 宋体子集
  - [ ] 2.1 依赖：devDependency `subset-font@2.9.0`。`console/tsconfig.json` 的 `include` 加上 `scripts`，让 `console/scripts/*.ts` 过 typecheck。
  - [ ] 2.2 `console/scripts/subset-serif.ts`：源字体用固定 URL，校验 sha256，字重 600。字符来源是 `SERIF_STRINGS`、`SEAL_LABELS`、`DESTINATION_MARKS`、`SERIF_DIGITS`。提交 woff2 和字符清单。
  - [ ] 2.3 `@font-face`（`font-display: swap`）、`font-synthesis: none`；用 Vite 小插件在 `transformIndexHtml` 里注入 woff2 的 `preload`。`console/src/brand/serif.tsx`（`yt-serif` 只在这里出现）。
  - [ ] 2.4 新建仓库根目录的 `NOTICE`，记下 Noto Serif SC（OFL-1.1）并附许可证全文。
- [ ] 3. 共享文案与纯函数（见「文案与中文标签」）
  - [ ] 3.1 `src/shared/catalog-fields.ts`：`labelOfPath`、`parseMeals` / `formatMeals`、`toFormData` / `fromFormData`，含空值即删键的规则。另有 `ui-labels.ts`（图标只存名字字符串）、`format.ts`（含 `shortIdOf`）、`destination-marks.ts`、`catalog-readiness.ts`（必须项直接取 `RouteSchema` / `HotelSchema.safeParse` 的 issues）。
  - [ ] 3.2 `src/shared/sop-sections.ts`：从 `src/sop/sections.ts` 挪出 `TRAVEL_SOP_SECTIONS`、`sectionBody`、`editableChars`，原处再导出。
  - [ ] 3.3 `src/shared/catalog.ts` 的 schema 报错改用中文字段名；`PasswordBusyError` 和登录失败的文案，「口令」改成「密码」。
  - [ ] 3.4 自测，都放在 `src/shared/` 之外：`src/ui-meta.selftest.ts`（不变量 6、7）、`console/src/catalog-form.selftest.ts`（不变量 8，用 `@rjsf/utils` 的 `getDefaultFormState`）、`scripts/check-console-src.ts`（源码扫描）。这三个都串进 `pnpm test`，放在 console 构建之前。
- [ ] 4. 外框（见「信息架构与导航」「通用部件」）
  - [ ] 4.1 `Me.tenantName`：接口、handler、`console.selftest.ts` 用例。在 01 spec 顶部加 `Amended by: docs/features/console-ux/spec.md`，此时 01 已是 implemented。
  - [ ] 4.2 `useViewport()`；受控 `Sider`（1280 / 992 两档）；分组侧栏、18px 图标、选中项修复；小屏 Drawer；页头品牌区（方章 + 字标 + 租户名）与用户菜单。
  - [ ] 4.3 `PageHeader`、`document.title`、面包屑；匿名 info 横幅与非编辑角色的「只读」。
  - [ ] 4.4 `StateView`、`ERROR_COPY`、`TechDetails`、`ConfirmDanger`、离开保护；会话过期的判定（`error === 'unauthorized'`、匿名形状、`/me` 401）与就地重登；全站去掉 `message.error`。
- [ ] 5. 拆包与传输（见「性能」）
  - [ ] 5.1 各页改成 `.lazy()`；删掉 `chunkSizeWarningLimit` 的覆盖，开 `build.manifest`。
  - [ ] 5.2 扩展 `scripts/check-console-dist.ts`：这一步先只按「入口集合」算预算，禁 `@codemirror`/`@rjsf`，没有 specimen chunk，CSS 里没有 `url(data:`，跳过二进制文件。总览那一项放到第 6 步补。
  - [ ] 5.3 `/console/assets/*` 做 gzip。
  - [ ] 5.4 在交接记录里写拆包前后的数字；超预算时按开放问题 7 请 owner 定。
- [ ] 6. 总览页：路由 `/` 取代重定向；目的地长卷、指标条、系统状态、最近变更；匿名首屏加 `RidgeScroll`。预算检查补上「入口 + 总览 chunk」这一项（见「总览」）。
- [ ] 7. 话术页一（依赖 `@codemirror/lang-markdown@6.5.2`）
  - [ ] 7.1 页头状态句；目录站点（4 种状态）与钢印，匿名目录的钢印来自 `sop-sections`。
  - [ ] 7.2 编辑器改版（去行号、markdown 轻高亮、`aria-label`）；实时字数额度。
  - [ ] 7.3 自动保存与退避、`⌘S`、离开保护、窄屏下拉。
- [ ] 8. 话术页二（依赖 `@codemirror/lint@6.9.7`）
  - [ ] 8.1 `ContractViolation.match`：契约检查在四类违规里填值，加自测。
  - [ ] 8.2 问题面板：说明由前端生成，服务端 `detail` 进技术详情。`@codemirror/lint` 标注，并覆盖 `.cm-lintRange-*` 的 data: 背景，不开 gutter。目录显示问题数。
  - [ ] 8.3 发布抽屉：预检、替换说明、unified 差异与切换、预填说明。去掉页底的对比卡片。
- [ ] 9. 话术页三：题跋式的版本记录抽屉、「查看改动」视图、回滚确认（差异与固定规则提示）、载入到草稿、「更多」里的丢弃确认（菜单项不加 danger）、压印动效。
- [ ] 10. 话术页四：`SaveDraftBody.rebaseOnto`（服务端 + 验收 3 的用例）；合并模式界面（`revertControls`、汉化）。
- [ ] 11. 产品库列表：新列、`DestinationMark`、`SeasonStrip`、`StatusPill`、页签、搜索、筛选标签、URL 状态、各种状态（见「产品库列表」）。
- [ ] 12. 产品库详情
  - [ ] 12.1 路由 `/catalog/$kind/$code` 与 `/catalog/new/$kind`；两栏布局；副栏（状态、上架前检查、元数据）。
  - [ ] 12.2 rjsf：`ObjectFieldTemplate`（卡片 + 印文钢印 + 原因）、`FieldTemplate`、全部 `ButtonTemplates`、`translateString` 中文表、各 widget（`overseas` 的普通 Radio 没有默认值；`intensity` 用 Segmented；空值即删键）；只读文本。
  - [ ] 12.3 保存条；报错落到字段（碰过的字段集合 + `extraErrors`，`showErrorList:false`）；上架确认；复制为新草稿；删除旧抽屉。
- [ ] 13. 逐日行程时间轴、餐食片、住宿联想、上移下移、天数联动；包含与不含对照列。
- [ ] 14. 预览页签；匿名默认显示预览。
- [ ] 15. CSV 导入重做：中文模板与 GBK 兜底；三条上限的前端预检；不合格行下载时在引号内加制表符前缀；`prepareCatalogCsv` 接受中文表头、导入时去掉本系统加的前缀（加自测）。
- [ ] 16. 会话：`ConvQuery.state` 与 `ConversationRow` 新字段（加自测）；页面（会话标签、旅程刻度）；`public/admin.html` 的 `#s=` 深链，登录流程中保留 hash。
- [ ] 17. 审计：`AuditQuery.actions`（加自测）；`describeAudit`、时间线、详情抽屉。
- [ ] 18. 登录页改版：纸面一栏、宋体标语、`RidgeScroll`。
- [ ] 19. 可访问性与响应式收尾：跳转链接、地标、焦点顺序、目录方向键、375px 检查、reduced-motion。
- [ ] 20. 走查：两套主题截图（含控件样张）、axe 对比度审计、红色判定、CSP 违规与控制台错误计数、`<style>` 里的 data: 扫描、逐路由断言、demo 删 cookie 那一步、CLS 与 Lighthouse。结果记进下方的验收记录（验收 4–7、17、18）。
- [ ] 21. 对照 spec 当前的全部验收标准逐条验证，结果记进本文件。
- [ ] 22. 清理临时探针和测试产物：仓库外的走查库、脚本、下载的浏览器、`VITE_SPECIMEN` 构建；确认工作区干净。
- [ ] 23. owner 确认后，把 spec 的 `Status` 更新为 `implemented`。

## 交接记录

（按日期追加：已完成 / 半成品状态 / 阻塞 / 下一步）

## 验收记录

（按验收编号追加：通过或不通过、证据位置）
