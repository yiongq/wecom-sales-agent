# 后台 UX 重做：「青绿长卷」

Status: draft
Depends on: [01 · Postgres 底座 + 配置入库 + 后台 v0](../../architecture/01-pg-config-console/spec.md)（「后台 API 与页面」、安全头、匿名投影、权限矩阵）；技术栈见 [ADR-002](../../adr/adr-002-console-vite-react.md)。**前置条件：01 翻为 `implemented` 之后才开工。** 原因有两条：AGENTS.md 规定 Amends 只能加在已 implemented 的 spec 上；验收 19 要重跑 01 的验收，也要等 01 先验收完。
Amends: 01「后台 API 与页面」，01 implemented 后生效。改动限于三类：给 `src/shared/console-api.ts` 增加成员和可选参数；给页面换呈现方式；改几处给用户看的文案。不改 01 已有的行为、权限、匿名投影、会话列表的投影范围和验收。
开工方式：本 spec 放在 `docs/features/`，不在「继续」的自动选活范围内（自动选活只扫 `docs/architecture/NN-*`）。开工时要明确说「按 docs/features/console-ux/spec.md 实现」。
来源：文中 [n] 指同目录 [references.md](references.md) 的编号。

## 背景与问题

01 把后台的功能做齐了：草稿、检查、发布、回滚、锁定字段、按行报错的 CSV 导入、审计。截图（01 的 `walkthrough/01–10`）和 `console/src/**` 显示，缺的是表达层：

- **没有身份。** `main.tsx` 的 `ConfigProvider` 只传了 `locale` 和 `csp`，全站是 antd 出厂蓝。页头和 `<title>` 都只有「后台」两个字。
- **不达 AA。** antd 默认值实测：主色 `#1677FF` 配白字只有 4.10:1；说明文字 `rgba(0,0,0,.45)`（约 `#8C8C8C`）对白 3.36:1；禁用色约 `#BFBFBF`，对白 1.84:1，而上架后的锁定字段用的正是禁用样式。`TextEditor.tsx`、`SectionDiff.tsx` 把 `#d9d9d9` 写死了。没有深色主题。截图 06 里，每个必填字段前都有一颗红星。
- **工程词外露。**
  - 表单标签是 `id`、`priceFrom`；检查结果是 `phrase_forbidden`。
  - 审计写成 `catalog.activate` 加 UUID，操作者是 `user-create`；历史表里有 prompt hash。
  - 服务端报错直接显示给运营：「与镜像里的 data/sop.md 不一致」「要和 days（8）相同」「口令校验排队超时」。
  - diff 的折叠条是英文「18 unchanged lines」。CSV 要手抄英文表头，文件框是浏览器原生的「Choose File」。
- **层级不清。** SOP 顶栏是四个同权按钮：「丢弃」是常驻的红框按钮，「发布」反而不是主按钮。页面没有标题。错误走 3 秒就消失的 `message.error`。上架确认用 `Popconfirm`，列的是英文键，按钮只写「确定」。
- **两个缺陷。**
  - 侧栏当前页高亮从来没有生效。`Shell.tsx` 用 ``path.startsWith(`/console${k}`)`` 做比较，而 TanStack Router 把 `basepath` 实现成 rewrite，拿到的 `pathname` 是 `/sop`。所以截图 02–10 的侧栏都没有选中项。这一条在 01 收尾时已经修掉。
  - SOP 冲突是死路。`src/config/sop.ts` 的 `rebase()` 只要发现同一节在基线之后两边都改过，就判为冲突，不看内容；而已有草稿的 `basedOn` 又没有接口能改。结果是一旦冲突，这份草稿怎么改都发布不了，只能丢弃。01 界面上写的「把需要的内容合进草稿后再发布」实际上做不到。01 收尾时只把这句提示改成如实说明（只能丢弃后在新版本上重做），真正的解法是本 spec 的 `rebaseOnto`。
- **性能。** 首屏是一个 2,051,003 B 的单包（gzip 后 650,950 B），`vite.config.ts` 把告警阈值调到 4096，把告警压掉了。`/console/assets/*` 带 `no-store`，也没有压缩。
- **没有首页。** `/console/` 直接跳到 `/sop`。`/status` 里的锁、缓存、索引、漂移信息，除了用来判断是不是匿名之外，都没用上。

用户是旅行社老板和运营，不是工程师；这个后台同时是面试作品。要求两条：一眼看出这是一家高端定制游公司的 AI 销售后台，并且好用。

## 目标与非目标

目标：

1. 运营不接触任何工程词，就能完成这些事：改话术并发布、看改了什么、回滚；新建线路、逐日排行程、上架；导入酒店表；查谁改了什么。
2. 一套有辨识度的视觉语言（下文「青绿长卷」）。浅色和深色两套主题里，所有文字对比度 ≥ 4.5:1，控件边界和焦点环 ≥ 3:1。antd 组件层也要达标，包括页签、分页、按钮悬停和焦点框。
3. 红色只表示「出错了或要立刻处理」，第三方组件带进来的默认红也算在内。
4. 打开总览需要的 JS 降到现在的 2/3 以下；页面加载和状态切换时不跳动。
5. 匿名演示落在一张讲清产品的总览页上。

非目标：

- 坐席工作台、人工接管与回复。这些归 02，仍在 `admin.html`；两套登录也要到 02 才合并。
- 「用草稿试聊」：要新接口，另立 spec。
- 线路和酒店的图片：等 02 加字段并自托管之后再做。
- 发布环境、发布标签、A/B 分流：见「被否决的方案」。
- 审计导出；审计按时间范围、操作者、对象筛选（开放问题 5）。
- 会话列表显示客户昵称：昵称属于客户画像，01 明确不投影（开放问题 8）。
- 拖动排序：统一用「上移 / 下移」按钮（见「被否决的方案」）。
- 换组件库；改 CSP；改 01 的权限矩阵和匿名投影。

## 现状与方案

| 现状                                       | 方案                                                                             | 见                            |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------- |
| 没有主题、默认蓝、不达 AA，深色派生色失控  | `theme.ts` 两套钉死的 token 加组件层覆盖，对比度自测                             | 视觉方案                      |
| 5 个平铺菜单，高亮失效                     | 分组侧栏 + 18px 图标 + 修高亮 + 按宽度收起                                       | 信息架构与导航                |
| 登录后直接进 SOP                           | 新增总览：目的地长卷 + 指标条 + 系统状态                                         | 总览                          |
| SOP 四个同权按钮、手动保存、错误走 toast   | 页头状态句 + 自动保存 + 发布抽屉（预检、差异、说明）+ 页内问题面板               | 销售话术                      |
| 冲突只能丢弃                               | 按节合并 + `rebaseOnto`                                                          | 销售话术 · 冲突合并；接口改动 |
| 表单英文键、红星、锁定用禁用态、720px 抽屉 | 独立详情页、分组卡片、钢印写明锁定类别、中文标签与常驻帮助、锁定内容改成只读文本 | 产品库详情与编辑器            |
| 逐日行程是嵌套输入框                       | 竖向站点时间轴、餐食选择片                                                       | 逐日行程编辑器                |
| CSV 要手抄英文表头，只认 UTF-8             | 中文模板、GBK 兜底、前端预检、防公式注入                                         | CSV 导入                      |
| 会话列表显示 id，审计列机器码              | 会话：可读标签 + 旅程刻度 + 接待状态；审计：写成人话句子                         | 会话列表、审计日志            |
| 2 MB 单包                                  | 按路由拆包 + 预算检查 + 静态资源压缩                                             | 性能                          |

## 设计原则

1. **说运营的话。** 用用户熟悉的词；出错时说「无法……」，并给出下一步 [44][49]。机器码、UUID、哈希，以及服务端返回的原文 `detail`，只放在默认收起的「技术详情」里。
2. **一个操作区一个主操作。** 每页一个页头，右上角是唯一的主按钮；风险操作排在最后，或者收进「更多」[4][5][6]。
3. **红色只给出错。** 功能色表达明确的状态 [39]；danger 只表示危险或严重错误 [38]；critical 只给需要行动的问题 [97]。状态不能只靠颜色表达，要同时有图标和文字 [12][133]。
4. **状态常驻，后果先说。** 「线上是哪一版、草稿改了什么、哪些内容锁了」要一直看得见 [52][69]。上架、回滚、丢弃之前，先把后果写清楚，再请用户确认 [36][71]。
5. **错误就地。** 会自动消失的 toast 只用来报成功。错误属于 alert 而不是 toast：toast 会自动消失，也带不了「重试」这个操作 [29][33]；Polaris 也不鼓励用 toast 报错 [32]。错误显示在出错的位置或页头下方，并附上操作 [31][34][90]。
6. **特色来自业务数据（设计立场）。** 签名细节由真实数据驱动：线路站点、钢印、季节条、目的地长卷。不用紫蓝渐变、玻璃拟态这类同质化装饰，参考的是 [122][123][160] 的观点，不是业界规范。不用 emoji 是本项目自定的规则。
7. **克制。** 中性色打底，只有一个品牌色。这条是受 Aman「以克制表达奢华」[126] 和 Linear「少量变量推导主题」[114] 的启发，不是规范。静止的卡片用无阴影的基础材质，阴影主要留给浮层 [119]。动效要短，并且可以关掉 [120][140]。

## 视觉方案

### 选定方向：A「青绿长卷」

研究提出了三个成型方向：

- A「青绿长卷」：取《千里江山图》的石青、石绿、赭石设色，纸色底；线路站点、钢印、题跋式版本记录。
- B「等高线图册」：国家公园 Unigrid 的黑色标题带 [129]、等高线纹理、海拔刻度。
- C「票根行程单」：车票和登机牌的票面层级 [130]，发布做成检票剪口。

其余视角独立提出的「行旅·墨青」「行程书·黛青印」「旅程账本」，色系和隐喻都在 A 的范围内，并入 A。

选 A 的理由：

- **和业务同源。** 高端定制游卖的是中国山水和线路。《千里江山图》以青绿为主：石青覆在石绿和淡石青之上，赭石和墨是次要色，只用来皴染山脚和阴面 [125]。这组颜色自带这层联想。「线路站点」一个隐喻，就能同时说清 SOP 分节、版本历史、逐日行程、销售阶段四件事。
- **颜色语义天然对齐，而且分量对。** 石青作主色和「改过的」，石绿表示线上或正常，赭石只给少数需要留意的状态，和原画里「次要色」的分量一致；朱砂只给出错。「红色专用」这条硬约束因此成了设计故事的一部分。传统印章用朱红，这里改用无色的「钢印」；也不用蓝印泥，清代国丧期间公文改用蓝印 [124]。
- **最适合主要工作量。** 运营大部分时间在读写中文长段落。A 的纸色底、1.75 倍行高 [143]、宋体标题受益最大。B 的近黑主按钮和户外气质偏硬；C 的票面在 SOP 页用不上。
- **落地风险低。** 几乎全部落在这几样东西上：antd token、一个静态 CSS、几个自绘组件、一个几十 KB 的字体子集。不改 CSP，也不需要额外的接口。
- **有意避开同质化。** 一是不用 antd 默认蓝，也不走紫蓝渐变的「AI 产品」套路 [122]。二是「米色底 + 橙色点缀 + 衬线字」已经被点名是 AI 产品的通病 [160]，所以赭石退为少见的状态色，宋体只用于固定标题和印文。辨识度靠结构性的签名细节（方形站点、印文钢印、目的地长卷）来立，不指望底色。三是核心色避开别人的默认值：朱砂 `#AE3A1E` 离 Material 3 的 error 原值 `#B3261E`[161] 的 ΔE 约 9，石青 `#1F4F7F` 离最近的 Tailwind 色 [162] 的 ΔE 约 7。

从 B 借一样东西：线路的「最佳季节条」，由 `bestSeason` 解析，数据驱动。

### 颜色

全站只有这一套语义：

| 语义         | 颜色 | 用在                                                                                                                                                                                        |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 交互与改动   | 石青 | 主按钮、链接、选中、焦点环；草稿里改过的节、季节条的旺季月份、目的地字标的框                                                                                                                |
| 正常 / 线上  | 石绿 | 线上版本、已上架、检查通过、已成交                                                                                                                                                          |
| 留意（少用） | 赭石 | 产品库有未保存的改动；字数到额度的 95%–100%；上架前的建议项没做；逐日行程条数和天数对不上；已转人工、客户在等但不到 10 分钟；系统在自动重试（缓存或索引延迟）；回滚前的「固定规则变过」提示 |
| 中性         | 墨灰 | 草稿（从未上线）、历史版本、未改动的节、AI 接待中、锁定                                                                                                                                     |
| 出错         | 朱砂 | 校验失败、接口失败、违规、超出额度、冲突、锁连接断开、转人工超时（≥ 10 分钟）、`ConfirmDanger` 的确认按钮                                                                                   |

「草稿改了几节」不用赭石：运营编辑时一直处在这个状态，用赭石会让警示色长期挂在页面上。Contentful 把「已发布但有改动」标成 primary [164]，Shopify 的 warning 只给需要留意的问题 [97]。旺季月份也不用赭石，理由和 `DestinationMark` 不按目的地上色一样：颜色会被读成语义。

色阶按用途分档：底、面、分隔、边框、次要字、正文各有固定位置，悬停和选中不各写一套 [118]。

浅色。「纸」是页面底，「面」是卡片、输入框、表格的底；输入框的底恒为「面」。

| token                                             | 用途                               | hex                     | 对比度                                                                                               |
| ------------------------------------------------- | ---------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| 纸 `colorBgLayout`                                | 页面底、页头、侧栏                 | #F5F3EE                 | —                                                                                                    |
| 面 `colorBgContainer`                             | 卡片、输入框、表格                 | #FFFFFF                 | —                                                                                                    |
| 表头底 `colorFillAlter`                           | 表头、分组标题                     | #F0EEE7                 | 正文 13.95                                                                                           |
| 墨 `colorText`                                    | 正文                               | #1B2220                 | 纸 14.61、面 16.20                                                                                   |
| 次要 `colorTextSecondary`                         | 次要文字、表头字、钢印             | #4B5450                 | 纸 7.06、面 7.83、表头底 6.74、选中底 6.64                                                           |
| 说明 `colorTextTertiary` / `colorTextDescription` | 帮助文字、时间、描述               | #5C6561                 | 纸 5.43、面 6.02、表头底 5.18、选中底 5.11                                                           |
| 占位 `colorTextPlaceholder`                       | 占位示例                           | #6B7470                 | 面 4.82（占位只出现在面上）                                                                          |
| 石青 `colorPrimary`                               | 主按钮底、链接、选中字、焦点环     | #1F4F7F                 | 面 8.46、纸 7.63、表头底 7.28、选中底 7.18；白字在其上 8.46                                          |
| 石青悬停 / 按下                                   | 主按钮与链接状态                   | #2B5F91 / #183F66       | 白字 6.67 / 10.82                                                                                    |
| 选中底 `colorPrimaryBg` / `controlItemBgActive`   | 菜单、行、选项的选中               | #E7EDF4（悬停 #D5E0EC） | 石青字 7.18 / 6.32                                                                                   |
| 焦点环 `colorPrimaryBorder`                       | antd 焦点框、`--yt-focus`          | #1F4F7F                 | 面 8.46、纸 7.63                                                                                     |
| 信息底 `colorInfoBg` / `colorInfoBorder`          | 演示横幅等 info 提示               | #EDF1F6 / #B9C9DA       | 正文 14.28、石青 7.46                                                                                |
| 石绿 `colorSuccess`                               | 线上、通过                         | #276E53                 | 面 6.10、纸 5.50；浅底 #E5F1EB 5.26（描边 #A9CDBB）                                                  |
| 赭石文字 `colorWarningText`                       | 留意文字                           | #8A5B0C                 | 面 5.86、纸 5.29；浅底 #F6EEDC 5.08（描边 #DCC48F）                                                  |
| 赭石图形 `colorWarning`                           | 留意图标、边框                     | #A06E12                 | 面 4.44、浅底 3.84（非文字，≥ 3）                                                                    |
| 朱砂 `colorError`                                 | 出错                               | #AE3A1E                 | 面 6.13、纸 5.53；浅底 #FBEAE5 5.26（描边 #E3A99A）；白字 6.13；悬停 #8F2F18 8.12、按下 #7A2814 9.81 |
| 控件边框 `colorBorder`                            | 输入框、默认按钮描边、季节条淡季格 | #7D8681                 | 面 3.75、纸 3.38、表头底 3.23                                                                        |
| 分隔线 `colorBorderSecondary`                     | 卡片描边、分隔                     | #DDDFD8                 | 装饰，不计                                                                                           |
| 中性标签（底 / 字）                               | 客群等标签                         | #EEF0EC / #4B5450       | 6.82                                                                                                 |
| 提示框底 `colorBgSpotlight`                       | Tooltip                            | #1B2220                 | 白字 16.20                                                                                           |
| 差异新增底 / 删除底                               | + 行 / − 行（删除线）              | #E3F1EA / #F1ECE2       | 正文 13.91 / 次要字 6.65                                                                             |

深色。不用纯黑，降低饱和度，层级靠表面明度区分 [116][117][40]。

| token                                                           | hex                     | 对比度                                                                                                                                            |
| --------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 夜 `colorBgLayout`                                              | #111614                 | —                                                                                                                                                 |
| 面 `colorBgContainer`                                           | #182020                 | —                                                                                                                                                 |
| 浮层 `colorBgElevated`                                          | #1F2927                 | —                                                                                                                                                 |
| 表头底 `colorFillAlter`                                         | #1D2624                 | 正文 12.61                                                                                                                                        |
| 正文                                                            | #E4E9E5                 | 夜 14.87、面 13.49、浮层 12.16                                                                                                                    |
| 次要                                                            | #B0B9B4                 | 面 8.25、浮层 7.44、表头底 7.71、选中底 7.06                                                                                                      |
| 说明                                                            | #A0AAA5                 | 夜 7.65、面 6.94、浮层 6.26、选中底 5.94                                                                                                          |
| 占位                                                            | #8E9893                 | 面 5.58、浮层 5.03                                                                                                                                |
| 主按钮底 `colorPrimary`                                         | #3E73AA                 | 白字 4.96；作图形时对面 3.35、夜 3.69、浮层 3.02                                                                                                  |
| 主按钮悬停 / 按下                                               | #4277AE / #33649A       | 白字 4.69 / 6.12                                                                                                                                  |
| 石青前景 `colorPrimaryText`、`colorLink`、`colorInfo`、组件前景 | #93B8E2（悬停 #A9C7EA） | 面 8.05、夜 8.88、浮层 7.26、表头底 7.52、选中底 6.89；悬停对面 9.51                                                                              |
| 焦点环 `colorPrimaryBorder`                                     | #93B8E2                 | 面 8.05、浮层 7.26                                                                                                                                |
| 选中底                                                          | #1B2C3F（悬停 #22364C） | 石青前景 6.89 / 6.00                                                                                                                              |
| 信息底 / 描边                                                   | #172432 / #2D4A66       | 正文 12.80、石青前景 7.64                                                                                                                         |
| 石绿                                                            | #6FC39F                 | 面 7.88、浮层 7.11；浅底 #173127 6.63（描边 #2C5A46）                                                                                             |
| 赭石（文字与图形同色）                                          | #DDB15A                 | 面 8.30、浮层 7.48；浅底 #33280F 7.24（描边 #5E4A1E）                                                                                             |
| 朱砂                                                            | #F28B70                 | 面 6.87、浮层 6.20、夜 7.58、表头底 6.42；浅底 #3A1D15 6.37（描边 #6A3326）；悬停 #F5A08A 对浮层 7.32；朱砂上的数字用 #1B0B09（7.92），白字不达标 |
| 控件边框                                                        | #67736E                 | 面 3.36、夜 3.70、浮层 3.03                                                                                                                       |
| 分隔线                                                          | #2A3431                 | 装饰                                                                                                                                              |
| 中性标签（底 / 字）                                             | #232B29 / #B0B9B4       | 7.21                                                                                                                                              |
| 提示框底                                                        | #2E3A37                 | 白字 11.82                                                                                                                                        |
| 差异新增底 / 删除底                                             | #173229 / #2A2A25       | 正文 11.21 / 次要 7.17                                                                                                                            |

规则：

- 文字 ≥ 4.5:1 [131]；控件边界、焦点环、承载状态的图形 ≥ 3:1 [132]；只读内容不享受禁用豁免 [26][131]。表中数值按 WCAG 公式算出。
- **antd 的种子色要钉住。** 实测 antd 6.6.5：写在 `token` 里的 `colorPrimary`、`colorError`、`colorInfo`、`colorLink`、`colorSuccess`、`colorWarning` 会被当成种子交给算法重新派生。深色算法会改掉它们，例如 `#2C7393` 变成 `#286580`，`#F2837A` 变成 `#d1726b`。各种浅底、描边也由算法派生：浅色的 `colorPrimaryBg` 成了 `#A8B1B3`，`colorSuccessBg` 成了 `#A3ADA8`，石绿字放在上面只有 2.64:1 [146]。所以两套主题都用包一层的算法把种子钉回表中的值，其余 map token（Hover、Bg、Border、Text 等）一律显式写出。实测钉住之后，`getDesignToken()` 的输出和两张表逐项相等，没有一处不符。
- **组件层单独覆盖。** 深色的 `colorPrimary` 是给白字垫底的填充色，放在面上只有 3.35:1。凡是拿 `colorPrimary` 当文字或细边框的组件 token，都改用石青前景色（见「落到 antd v6」）[174]。
- `theme.selftest.ts` 同时复算两处：`getDesignToken()` 的实际输出，以及 `antdTheme(mode).components` 里显式写出的组件值（`getDesignToken` 不返回组件 token）。见验收 1。

### 字体与字阶

- **界面字体**用系统字体，零成本，不需要加载：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", sans-serif`。西文和数字排在前面，由 SF 或 Segoe UI 渲染，这两款带等宽数字特性，`tabular-nums` 才能生效。不用 Inter。
- **宋体子集**：思源宋体 SemiBold（Noto Serif SC 600，OFL [128]）的子集，`font-family: "YT Serif"`。只收下面四类固定字符：
  - `SERIF_STRINGS`：导航级页标题、登录与匿名首屏标语、页头字标、长卷的「境内」「境外」；
  - `SEAL_LABELS`：钢印印文，即识别、计价、条款、推荐、固定；
  - `DESTINATION_MARKS` 的全部字标；
  - `SERIF_DIGITS`：0–9、v、逗号。

  动态文字（线路名、租户名、详情页标题）一律用无衬线。
  - 产物是一个 woff2，≤ 40 KB，提交在 `console/src/assets/fonts/`，同时提交它的字符清单。
  - 由 `console/scripts/subset-serif.ts` 生成，用 devDependency `subset-font`。源字体按固定 URL 下载并校验 sha256，源文件不进仓库，字重固定为 600。
  - `@font-face` 写 `font-display: swap` [171]。回退栈直接接无衬线栈，不经过系统宋体：简体 Windows 上的 SimSun 合成 600 会发糊。凡是用宋体的元素都加 `font-synthesis: none` [169]。
  - `index.html` 由 Vite 小插件在构建时注入 `<link rel="preload" as="font" type="font/woff2" crossorigin href="/console/assets/…woff2">`，文件名带哈希 [170]。

- **代码类**只用于技术详情里的哈希和编号：`ui-monospace, "SF Mono", Menlo, Consolas, monospace`，不自托管。
- **字重**：无衬线只用 400 和 500，这是 antd 对中文的建议 [14]。宋体子集只有 600，只用于大字号的固定标题和数字；这是有意偏离 [14]，依据是飞书「Semibold 偶用于大标题」[127]，而且宋体 400 在 24px 下太细。
- `html { text-autospace: normal }`，让中西文之间自动留出约 1/4 字宽 [141][142]，旧浏览器会自然忽略。CodeMirror 里关掉（`.cm-editor { text-autospace: no-autospace }`），否则光标定位会错位。

字阶，字号共 12 / 14 / 16 / 24 / 32 五级（[14] 建议 3–5 级，并给出了 24、30、38 这几档）：

| 级     | 字号/行高     | 字重                 | 字体                                             | 用于                                                  |
| ------ | ------------- | -------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| 注释   | 12/20         | 400、500             | 无衬线（印文用宋体）                             | 帮助文字、表头、徽标、时间、落款、钢印印文            |
| 正文   | 14/22         | 400                  | 无衬线                                           | 表格、表单、正文                                      |
| 小标题 | 16/24         | 500                  | 无衬线                                           | 卡片标题                                              |
| 阅读   | 16/28（1.75） | 400                  | 无衬线                                           | SOP 编辑器、预览正文、版本记录的变更说明；行宽 ≤ 40em |
| 页标题 | 24/32         | 宋体 600；详情页 500 | 导航级页标题用宋体子集；详情页的动态名称用无衬线 | 页头标题                                              |
| 展示   | 32/40         | 600                  | 宋体子集                                         | 总览指标数字、版本号「v3」、登录与匿名首屏标语        |

- 页头的字标「AI 销售助手」按标志处理，固定 20px 宋体，不属于字阶。
- 40em 行宽是本项目的取值：16px 下约 40 个汉字，落在中文屏幕排版经验值 32–45 字/行的范围内 [173]。[143] 只用来支撑 1.75 的行高。
- 表格里的金额、天数、海拔、时间一律用 `font-variant-numeric: tabular-nums` 并右对齐 [14][46]。宋体的单个数字不需要等宽。

### 间距、圆角、阴影、密度

- 间距基数 8，细处用 4；越相关的元素离得越近，档位是 8 / 16 / 24 [41][42][43]。
- 页边距 24（宽 ≥ 1440 时 32）；卡片之间 16；卡片内边距 24；表单项之间 24（antd 默认）；页头与内容之间 16。
- 圆角：控件 4、卡片 6、浮层 8、状态胶囊 999、站点与钢印 1–2。偏方的圆角取「册页」的感觉，也和 antd 默认的 6/8 拉开差别。
- 阴影只给 Drawer、Modal、Dropdown、Popover；卡片用 1px 分隔线描边，不加阴影 [119]。
- 密度：
  - 产品库表格是两行内容，行高约 56；会话行是两行，行高 64 [11]；审计时间线每条约 44。
  - SOP 目录每项 ≥ 36，标题允许折成两行、不截断。「不截断」是本项目自定的规则。

### 图标

- 功能图标只用已安装的 `@ant-design/icons` 的 Outlined 一套：侧栏导航 18px，按钮 16px，行内 14px。不混用面性图标，不用 emoji [121]。
- 导航：总览 `AppstoreOutlined`、销售话术 `MessageOutlined`、线路 `CompassOutlined`、酒店 `ShopOutlined`、会话 `CommentOutlined`、审计日志 `AuditOutlined`。
- 状态与动作：
  - 状态：检查通过、已上架、已成交用 `CheckCircleOutlined`；草稿 `EditOutlined`；出错 `ExclamationCircleOutlined`；留意 `ClockCircleOutlined`；AI 接待 `RobotOutlined`；已转人工 `CustomerServiceOutlined`。
  - 动作与来源：回滚 `RollbackOutlined`、发布 `CloudUploadOutlined`、导入 `ImportOutlined`、系统 `SettingOutlined`、命令行 `CodeOutlined`、上移 `ArrowUpOutlined`、下移 `ArrowDownOutlined`、删除一条 `DeleteOutlined`（默认样式，不用红）。
- 自绘图形写成 React 组件（DOM 或内联 SVG 元素，不发请求，在 CSP 下安全）：`RouteLine`、`Seal`、`SeasonStrip`、`DestinationMark`、`RidgeScroll`、`StatusPill`。

### 签名细节

一条主线、三个配件，全站共用。

1. **线路站点 `RouteLine`。** 一根竖线串起若干方形「驿站」。站点是 8×8、圆角 1 的方块，和人物、会话的圆形头像区分开，也和 antd Timeline 的圆点加灰线拉开距离 [163]。
   - 线段：已走过的用 1.5px 石青实线，未发生的（草稿、没填完的天）用 1px 控件边框色虚线。线段只是装饰，信息由站点形状和文字承担。
   - 站点只有 4 种状态，靠形状加文字区分，不只靠颜色 [133]：
     - **未改 / 未填**：空心方，1px 控件边框色描边；
     - **改过 / 填齐**：石青实心方；
     - **有问题**：朱砂实心方，扩成 16×16，里面写问题数。数字浅色主题用白色（6.13），深色主题用 #1B0B09（7.92）；
     - **固定**：14px 钢印（见 2）。
   - 石绿只在版本记录里用一处：线上版本那一站是石绿实心，旁边带「线上」`StatusPill`。
   - 保存状态不画在站点上，只在页头状态句里表达，保存失败一律用朱砂。
   - 用在三处：SOP 目录（每节一站）；版本记录（每版一站，草稿是最上面的一段虚线）；逐日行程（D1…Dn）。审计时间线借用同一根线，站点换成动作图标。
2. **钢印 `Seal`。** 无色，像公文上的压印，有两种形态：
   - **组级印文钢印**：横式方章，约 30×18，1px 次要色框，圆角 2，框里是 12px 宋体两字印文：识别、计价、条款、推荐、固定。次要色对面 7.83，对表头底 6.74。用在产品库卡片头和 SOP 固定规则节。一眼就能读出锁的类别，它是全站最有记忆点的部件。
   - **行内锁形钢印**：14×14、圆角 2 的方框，里面是 10px 锁形。用在 SOP 目录和只读字段旁。

   两种都带视觉隐藏的文字「锁定：{类别}」。锁定原因在卡片头下方用 12px 说明色常驻显示，不藏在悬停里。

3. **季节条 `SeasonStrip`。** 12 格，每格 6×10，间隔 1。
   - `peakMonths(bestSeason)` 里的月份用石青实心（浅色对面 8.46，深色用 #93B8E2，对面 8.05），表示这些月份出发报价上浮 10%。
   - 其余月份用 1px 控件边框色描边（对面 3.75）：月份位置是读懂这张图必需的信息，要满足 3:1 [132]。
   - 当前月份下方加一条 2px 墨色短线。
   - 「全年」显示为 12 格全描边，旁注「全年 · 不加价」。
   - 带 `aria-label`，如「旺季 5–10 月，出发报价上浮 10%」。
   - 用在线路表、线路详情、预览。
4. **目的地字标 `DestinationMark` 与目的地长卷。**
   - 字标是方形，1px 石青细框，无底色，墨色宋体字。境内写省级简称一字（川、藏、滇、黔、陕、京、疆、琼……），境外写两字简称（巴厘、日本、北欧、马代、瑞士）。对照表 `DESTINATION_MARKS` 是闭集，放在 `src/shared/destination-marks.ts`，字都进宋体子集；查不到时取首字，并改用无衬线。
   - 字标不按目的地上色，否则颜色会被读成语义。
   - 尺寸：列表里 28×28；总览长卷里 40×40，两字简称用 16px。
   - 人物头像保持圆形、无衬线、中性底，和字标一眼就能分开。
   - 总览首屏第一排是「覆盖目的地」长卷：一条横带，上下各一条 1px 分隔线，像手卷的天头地脚。带里按「境内 / 境外」两段排开，段首是宋体小标，每个字标下面写在售线路数；本月在旺季的，再加一个石青小方块和「本月旺季」。它就是作品集的门面截图。

点缀一处：

- **山水题图 `RidgeScroll`。** 全站只有这一处插画，只用在登录页和匿名总览首屏的底部，通栏，高约 120px。它是三层平涂的山：赭石打山脚，石绿画山体，石青点峰顶，照《千里江山图》的设色层次来 [125]。不用渐变，彩度降低，`aria-hidden`。
  - 颜色是装饰专用变量 `--yt-ridge-1/2/3`：浅色 #D8C9AA、#A7C2B1、#8DA6BE，深色 #3B342A、#2C4438、#2D4054。它们不属于状态色，不稀释语义。
  - 工作页面（总览页头、空状态）不放插画。

版本记录做成题跋式，见「销售话术 · 版本记录」。

### 动效

生产力型动效：短、快、可关 [120]。

- 时长：快 0.1s（悬停、按压）、中 0.16s（状态切换、淡入）、慢 0.24s（抽屉、面板）。曲线 `cubic-bezier(0.2, 0, 0.38, 0.9)`。
- 只动 `opacity` 和 `transform`，不动尺寸和位置，不引起布局偏移。
- 只有一处仪式感：发布或回滚成功时，版本记录里的新站点「压印」一次（scale 1.06 → 1，160ms）。
- 自动保存的状态文字淡入切换；保存条从底部滑入，0.16s。
- `prefers-reduced-motion: reduce` 时：antd 传 `token.motion = false`；静态 CSS 里 `.yt-anim` 的 `animation`、`transition` 全部置为 `none` [140]。

### 落到 antd v6 与 CSS 变量（CSP 下）

页面 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'nonce-…'`。

**antd 主题。** 新文件 `console/src/theme.ts` 是颜色的唯一来源。它导出：

- `PALETTE`：上面两张表，每套含 `token`、`components`、`primaryFg`、`primaryFgHover`、`brand`（`--yt-*` 的值）；
- `antdTheme(mode, reducedMotion): ThemeConfig`；
- `PRIMARY_FG_KEYS`；
- 对比度测试用的 `CONTRAST_PAIRS`。

antd v6 默认走 CSS 变量模式，运行时注入的 `<style>` 继续由 `ConfigProvider` 的 `csp.nonce` 带上 nonce [146][147]。

`main.tsx`：

```tsx
<ConfigProvider
  locale={zhCN}
  csp={cspNonce ? { nonce: cspNonce } : undefined}
  theme={antdTheme(mode, reducedMotion)}
  button={{ autoInsertSpace: false }} // 去掉两字按钮里的空格：「检 查」→「检查」
  form={{ requiredMark: (label, { required }) => (required ? label : <>{label}<span className="yt-optional">（选填）</span></>) }} // 必填不打星，只标选填 [23][166]
>
```

```ts
// console/src/theme.ts（节选；色值即「颜色」两表）
type Algo = typeof theme.defaultAlgorithm;
const SEEDS = ['colorPrimary', 'colorInfo', 'colorLink', 'colorSuccess', 'colorWarning', 'colorError'] as const;

/** antd 把 token 里的种子色交给算法重新派生，深色算法会改掉它们（实测 6.6.5：#2C7393 → #286580）。
 *  包一层把种子钉回 PALETTE；其余 map token 写在 token 里本来就生效 */
const pinned =
  (base: Algo, p: Palette): Algo =>
  (seed, map) => ({
    ...base(seed, map),
    ...Object.fromEntries(SEEDS.map((k) => [k, p.token[k]])),
  });

/** 拿 colorPrimary 当文字或细边框的组件 token [174]。深色 colorPrimary 是垫白字的填充色，对面只有 3.35:1，
 *  这些位置改用 primaryFg（浅色 #1F4F7F，深色 #93B8E2），带 Hover 的键用 primaryFgHover。
 *  theme.selftest 断言两套主题都覆盖了这张表里的每个键 */
export const PRIMARY_FG_KEYS = {
  Tabs: ['itemSelectedColor', 'itemHoverColor', 'itemActiveColor', 'inkBarColor'],
  Pagination: ['itemActiveColor', 'itemActiveColorHover'],
  Button: ['defaultHoverColor', 'defaultHoverBorderColor', 'defaultActiveColor', 'defaultActiveBorderColor'],
  Input: ['activeBorderColor', 'hoverBorderColor'],
  InputNumber: ['activeBorderColor', 'hoverBorderColor'],
  Select: ['activeBorderColor', 'hoverBorderColor'],
  Menu: ['itemSelectedColor'],
} as const;

export function antdTheme(mode: 'light' | 'dark', reducedMotion: boolean): ThemeConfig {
  const p = PALETTE[mode];
  return {
    algorithm: pinned(mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm, p),
    token: { ...BASE, ...p.token, ...(reducedMotion ? { motion: false } : {}) },
    components: withPrimaryFg(p.components, p.primaryFg, p.primaryFgHover),
  };
}
```

- `BASE`：`fontFamily`、`fontFamilyCode`、`fontSize: 14`、`borderRadius: 4`、`borderRadiusLG: 6`、`borderRadiusSM: 2`，三档 `motionDuration*`，以及 `motionEaseInOut` / `motionEaseOut`。
- `PALETTE[mode].token` 显式写出这些键：
  - 主色：`colorPrimary` / `Hover` / `Active`、`colorPrimaryText` / `TextHover` / `TextActive`、`colorPrimaryBg` / `BgHover`、`colorPrimaryBorder` / `BorderHover`、`controlItemBgActive` / `ActiveHover`；
  - 信息与链接：`colorInfo` / `InfoText` / `InfoBg` / `InfoBorder`、`colorLink` / `LinkHover` / `LinkActive`；
  - 功能色：`color{Success,Warning,Error}` 各自的本色、`Text`、`Bg`、`Border`，以及 `colorErrorHover` / `Active`；
  - 文字：`colorTextBase`、`colorText`、`colorTextSecondary`、`colorTextTertiary`、`colorTextDescription`、`colorTextPlaceholder`；
  - 底与边：`colorBgBase`（深色）、`colorBgLayout`、`colorBgContainer`、`colorBgElevated`、`colorBgSpotlight`、`colorFillAlter`、`colorBorder`、`colorBorderSecondary`。
- `PALETTE[mode].components`：
  - `Layout`：`headerBg`、`siderBg`、`bodyBg` 取纸（夜），`headerHeight: 56`；
  - `Menu`：`itemBg: 'transparent'`、`itemSelectedBg` 取选中底、`iconSize: 18`、`itemBorderRadius: 4`、`activeBarBorderWidth: 0`、`groupTitleColor` 取说明色；
  - `Table`：`headerBg` 取表头底、`headerColor` 取次要色、`headerSplitColor: 'transparent'`、`rowHoverBg`；
  - `Button`：`primaryShadow` / `defaultShadow` / `dangerShadow` 都是 `'none'`，`fontWeight: 500`。不设 `dangerColor`，因为全站没有实心红按钮；
  - `Card`：`headerFontSize: 16`；
  - `Tag`：`defaultBg` / `defaultColor` 取中性标签；
  - `Form`：`labelRequiredMarkColor` 取说明色，作为必填星号的兜底，正常情况下星号不会出现。

**组件用法的禁令**，由源码扫描（`scripts/check-console-src.ts`）保证，理由都是「antd 在这些地方用的颜色没有 token 可改」[174]：

- 不用 `Radio.Button`：描边型选中态把字色写死为 `colorPrimary`。三档单选用 `Segmented`；需要「未选」态的二选一，用普通 `Radio`。
- 不用 `<Badge count>`：计数固定是白字配 `colorError`，深色下只有 2.53:1。问题数用 `RouteLine` 的问题站点或 `StatusPill`。
- 不用 `Tag` 的状态预设（`color="success|warning|error|processing"` 及其他预设色）：状态预设的字色取 `colorWarning` 这类图形色，不是 `*Text`，浅色赭石只有 3.14:1。状态徽标一律用 `StatusPill`。
- `StatusPill`：图标 + 文字 + 浅底，胶囊圆角 999。文字色取 `colorSuccessText`、`colorWarningText`、`colorErrorText` 或 `colorTextSecondary`，底色取对应的浅底。Carbon 要求状态同时用上色、形、字 [12]，这里三样都有。

**品牌变量（antd 之外的）。**

- 变量全部静态写在 `console/src/styles/brand.css` 里，分两套：`:root` 是浅色；`:root[data-theme="dark"]` 和 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` 是深色。
- 变量表：
  - 签名组件：`--yt-line`、`--yt-seal`、`--yt-season-peak`、`--yt-mark-border`；
  - 差异与斜纹：`--yt-diff-ins-bg`、`--yt-diff-del-bg`、`--yt-hatch-a`、`--yt-hatch-b`；
  - 插画：`--yt-ridge-1/2/3`；
  - antd 值的副本，给静态 CSS 和 CodeMirror 用：`--yt-primary`、`--yt-primary-fg`、`--yt-focus`、`--yt-text`、`--yt-text-2`、`--yt-text-3`、`--yt-border`、`--yt-divider`、`--yt-bg`、`--yt-surface`、`--yt-elevated`、`--yt-error`、`--yt-on-error`、`--yt-success`、`--yt-warning-text`。
- `theme.selftest.ts` 解析 brand.css，断言两套值与 `PALETTE[mode].brand` 逐项相等。
- 切换主题时只改 `<html data-theme>`（`setAttribute('data-theme', …)`，这不是 style 属性），不在运行时写任何样式。静态 CSS 在 JS 加载前就生效，所以第一帧签名组件就有颜色。
- 源码里禁止 `style.cssText` 和 `setAttribute('style', …)`：两者都会被 `style-src` 拦下 [145]。

**静态 CSS。** `brand.css` 还放这些东西：签名组件样式、固定规则节的斜纹、宋体 `@font-face`、`text-autospace`、焦点环、reduced-motion 规则、`.yt-boot` 首屏骨架。它由 `main.tsx` import，Vite 打成 `/console/assets/*.css`，在 `index.html` 里以 `<link>` 加载，走 `style-src 'self'`。斜纹用 `repeating-linear-gradient`，不用 `url("data:…")`。

**不内联 data: URL。** `vite.config.ts` 设 `build.assetsInlineLimit: 0`。原因：默认 4 KB 以下的资源会被转成 base64 的 data: URL [148]，而 `img-src`、`font-src` 会回退到 `default-src 'self'`，里面不含 data: [144]，线上会被静默拦掉，本地 dev 却看不出来。宋体 woff2 作为 `/console/assets/` 下的文件加载。

**CodeMirror。** `TextEditor`、`SectionDiff` 和合并视图的 `EditorView.theme` 只用 `var(--yt-*)`，去掉写死的 `#d9d9d9`、`#f0f0f0`。深色时加 `EditorView.darkTheme.of(true)`；继续传 `EditorView.cspNonce`。两个第三方包自带的样式要覆盖：

- `@codemirror/lint` 的 baseTheme 给 `.cm-lintRange-*` 和 `.cm-lint-marker-*` 用了 `background-image: url('data:image/svg+xml,…')` [175]。在我们的 CSP 下会被拦，每显示一次触发一次违规，下划线本身也不显示。所以要覆盖 `.cm-lintRange-error`、`.cm-lintRange-warning`、`.cm-lintRange-info`、`.cm-lintRange-hint`：设 `background-image: none`，改用 `text-decoration: underline wavy var(--yt-error)`（非 error 级用 `--yt-text-3`），`text-underline-offset: 3px`。同时不开 `lintGutter`。
- `@codemirror/merge` 的 baseTheme 自带一套红：`#ee4433` 渐变下划线、`#ff000033` 删除字底、`#e43` 删除行标记；`unifiedMergeView` 默认还会渲染英文的 Accept / Reject 按钮，底色是 `#2a2` 和 `#d43`。要覆盖的类有 `.cm-changedText`、`.cm-deletedChunk .cm-deletedText`、`.cm-merge-b .cm-deletedText`、`.cm-deletedLineGutter`、`.cm-changedLineGutter`、`.cm-insertedLine`、`.cm-deletedChunk`：新增用 `--yt-diff-ins-bg` 加行首「+」竖条，删除用 `--yt-diff-del-bg` 加删除线，不用红。`unifiedMergeView` 传 `mergeControls: false`。`EditorState.phrases` 汉化：「$ unchanged lines」→「已折叠 $ 行未改动」，「Revert this chunk」→「采用线上的写法」，「Accept」/「Reject」→「采用」/「不采用」[155][157]。

**首屏不闪。**

- `console/index.html` 加 `<meta name="color-scheme" content="light dark">`。
- head 里加一个同源的经典脚本 `<script src="/console/theme-boot.js"></script>`（放在 `console/public/`，不到 300 B，`script-src 'self'` 允许）。它在 try/catch 里读 `localStorage['yt.theme']`，把 `<html data-theme>` 设成用户手动选的主题，这样手动选的主题从第一帧就生效。
- `#root` 里放 `<div id="boot" class="yt-boot">`，只画页头骨架，不画侧栏：服务端不看会话，没法预知是登录页、匿名页还是成员页。骨架只用 class，样式在 brand.css 里，不用 style 属性。React 挂载后替换它。
- 托管方已经对 `index.html` 全量替换 nonce 占位符（`renderConsoleIndex`），不需要改服务端。

**主题切换。** 页头用户菜单里有「外观：跟随系统 / 浅色 / 深色」，默认跟随系统 [158]。选择存在 `localStorage['yt.theme']`，读写都包 try/catch，读不到就跟随系统。`<html data-theme>` 同步为实际生效的主题。匿名访客也能切换。

## 信息架构与导航

侧栏只有两层；一级项各配一个专属图标，标签 1–2 个词 [2]；分组见 [3]：

| 分组   | 项         | 路由                               | 谁能看到         |
| ------ | ---------- | ---------------------------------- | ---------------- |
| —      | 总览       | `/`                                | 所有人（含匿名） |
| —      | 销售话术   | `/sop`                             | 所有人           |
| 产品库 | 线路、酒店 | `/catalog/route`、`/catalog/hotel` | 所有人           |
| 运营   | 会话       | `/conversations`                   | 成员             |
| 运营   | 审计日志   | `/audit`                           | owner、admin     |

- **选中项**用 `useMatchRoute`（或 `<Link activeProps>`）判断，修掉带 `/console` 前缀比较的缺陷。导航要一直标出「你在哪」[1][48]。选中项的样式：选中底、石青前景字，加一条 2px 石青左竖条（深色用 #93B8E2）。竖条写在 brand.css 里，用 `inset box-shadow` 实现。侧栏图标 18px，标签 14px、字重 500。
- **收起。** antd 的断点只有 lg 992、xl 1200，`Sider` 也只接一个 `breakpoint` 和一个 `collapsedWidth` [165]，做不出三档，所以改成受控的 `collapsed`。共用的 `useViewport()` 按 `matchMedia('(min-width: 1280px)')` 和 `('(min-width: 992px)')` 分三档：
  - ≥ 1280：展开，208px；
  - 992–1279：收成 64px 图标栏，悬停出标签；
  - < 992：`collapsedWidth: 0` 并隐藏，由页头左侧的菜单按钮以 Drawer 打开 [2]。

  SOP 目录变下拉、详情副栏下移，也读同一个 hook。

- **页头**：56px，和侧栏一样是纸色，与白色内容卡片构成「倒 L」外框 [114]。
  - 左侧品牌区：一枚 20×20 的无色方章（1px 次要色框，宋体「销」字），接宋体字标「AI 销售助手」，再接一条 1px 竖分隔。成员接着显示 `Me.tenantName`（14px、500）；匿名显示中性的「演示」`StatusPill`。产品的正式名称见开放问题 3，现在的字标是描述性占位。
  - 右侧（匿名）：「去体验对话」链接（`/chat.html`）+ 默认样式的「登录」按钮。
  - 右侧（成员）：姓名、角色中文名、下拉菜单（外观、退出）。
- **面包屑**只在第三层出现，如「产品库 / 线路 / 四川 稻城亚丁·色达秘境 8 日」[1][2]。
- **页头组件 `PageHeader`**：标题、一句说明或状态句、右侧操作区；一个操作区至多一个主按钮 [4][6][7]。
- **`document.title`** 每页更新为「页名 · 运营后台」，详情页为「条目名 · 线路 · 运营后台」[136]。
- **URL 状态**：筛选、页签、选中的节都写进 search params（TanStack Router `validateSearch`），刷新、后退、分享链接都能还原 [15]。

路由（`basepath: '/console'` 不变）：

| 路由                   | search                                                                                                     | 页面                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/`                    | —                                                                                                          | 总览（取代现在的重定向）                                              |
| `/sop`                 | `section?: string`、`view?: 'history'`、`v?: number`                                                       | 销售话术                                                              |
| `/catalog/$kind`       | `status?: 'active' \| 'draft'`、`q?: string`、`dest?: string`、`region?: 'cn' \| 'abroad'`、`seg?: string` | 产品库列表                                                            |
| `/catalog/$kind/$code` | `tab?: 'edit' \| 'preview'`                                                                                | 条目详情                                                              |
| `/catalog/new/$kind`   | —                                                                                                          | 新建条目。不用 `/catalog/$kind/new`：`new` 是合法的条目编号，会撞路由 |
| `/conversations`       | `state?: 'ai' \| 'human' \| 'paid'`、`page?: number`                                                       | 会话                                                                  |
| `/audit`               | `cat?: 'sop' \| 'catalog' \| 'account' \| 'platform'`、`login?: 1`                                         | 审计日志                                                              |
| `/_specimen`           | `theme?: 'light' \| 'dark'`                                                                                | 控件样张，只在 `VITE_SPECIMEN=1` 的构建里存在（走查用，生产构建不含） |

## 逐页设计

### 通用部件

**加载、空、错误。** 统一组件 `StateView`：

- 加载用和成品同尺寸的骨架：表格用 `Table loading` 骨架行，卡片用 `Skeleton`。不用整页转圈 [20][21]。只有首屏判断身份时，才显示 `index.html` 里的静态页头骨架。
- 空状态替换整块内容，不留空表头 [18]。分三类：
  - 首次没有数据：标题用正向说法 [18]，如「从第一条线路开始」；说明将来这里会有什么，再给一个主操作；
  - 筛选没有结果：写清怎么调整，给「清除筛选」链接，不放主按钮 [19]；
  - 没权限或系统原因：写原因和能做的事。

  标题 ≤ 5 个词 [19]。工作页面的空状态不放插画。

**错误文案。** 全部按 `ApiError.error` 映射，放在 `src/shared/ui-labels.ts` 的 `ERROR_COPY` 里，文案是固定的中文，不拼接服务端的 `detail`。`detail` 只出现在「技术详情」里：

| error / 状态                       | 标题 · 下一步                                                         | 形式                                                         | 颜色 |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ---- |
| 会话过期（判定见下）               | 登录已过期 · 重新登录后接着刚才的操作                                 | 就地弹登录框，不卸载页面，编辑内容保留；登录后重放失败的请求 | 中性 |
| 403 `forbidden`                    | 你的角色无法执行这项操作 · 需要所有者或管理员                         | 页内 Alert                                                   | 留意 |
| 403 `csrf` / `cross_site`          | 页面已过期 · 刷新后重试                                               | 页内 Alert + 刷新按钮                                        | 出错 |
| 409 `rev_conflict`                 | 别人刚改过这里 · 载入最新内容（你的改动以对比形式保留）               | 页头下横幅 + 按钮                                            | 出错 |
| 409 `sop_conflict`                 | 有 N 节在你改的同时被改了 · 去合并                                    | 发布抽屉 / 页头下横幅                                        | 出错 |
| 409 `catalog_code_taken`           | 这个编号已经有了 · 换一个                                             | 字段下方                                                     | 出错 |
| 422 `contract`                     | 有 N 处需要改 · 点一处跳过去                                          | 问题面板                                                     | 出错 |
| 422 `locked_field`                 | 这些内容上架后锁定了：{中文字段名}                                    | 页内 Alert                                                   | 出错 |
| 422 `invalid_item` / `invalid_csv` | 有 N 处要改                                                           | 落到字段 / 行                                                | 出错 |
| 429 `rate_limited` / `busy`        | 尝试太频繁 · 稍后再试（响应带 `Retry-After` 时写「约 N 分钟后再试」） | 表单内                                                       | 出错 |
| 503 `lock_lost`                    | 暂时无法保存：系统在重连数据库，线上内容不受影响 · 稍后重试           | 页头下横幅                                                   | 出错 |
| 503 `db_disabled`                  | 后台只在数据库模式下可用                                              | 整页 Result                                                  | 中性 |
| 网络失败、5xx                      | 服务暂时连不上 · 重试                                                 | 就地 + 重试按钮                                              | 出错 |

- 成功只用 `message.success`：一句话，3 秒消失，不带操作 [29][32]。错误一律不用 toast [29][30][33]。
- **会话过期的判定。** 不看 401 状态码：登录接口的 `invalid_credentials` 也返回 401；demo 下会话失效后，GET 会返回 200 的匿名投影，只有写请求才返回 401。判定条件有三种，满足任一即可：
  - 任一响应体的 `error === 'unauthorized'`；
  - 前端当前是成员身份，而某个 GET 返回了匿名形状（每个接口一个 `isAnonShape` 判断，例如 SOP 概览里没有 `draft` 键）；
  - `/me` 返回 401。

  满足时，`QueryCache` / `MutationCache` 的 `onError` 置一个「会话过期」标记，弹出登录框；不清 React Query 缓存，也不卸载当前页。匿名形状的数据不写进缓存。

**未保存保护。** 有未保存的内容时：

- 站内跳转用 `useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver: true })`，接一个自定义 Modal：标题「有改动还没保存」，按钮「留下」和「放弃改动并离开」；
- 关页和刷新走 beforeunload [29][150]。

**破坏性确认。** 统一组件 `ConfirmDanger`：

- 标题写对象，正文写后果 [35][36][37]。
- 确认按钮写具体的动作，用 `danger` 加默认类型，也就是描边红字：浅色 #AE3A1E 对面 6.13，深色 #F28B70 对浮层 6.20。GitLab 只要求确认按钮用 danger 变体，没要求实心 [35]。
- 取消按钮默认聚焦。弹窗里不放 primary 按钮。
- 全站只有这个组件能出现 `danger` 属性；菜单项（包括「更多」里的「丢弃草稿」）不加 danger。

**只读形态。**

- 匿名演示：页头下方一条 info 色调横幅（信息底加石青图标）：「演示模式 · 只读：这里配置的销售话术和产品库，直接驱动企业微信里的 AI 销售。」右侧是「去体验对话」「登录后编辑」。这是说明不是警告，不用黄色 [39]。
- 非编辑角色（supervisor、agent、viewer）：不挂横幅，页头状态句末尾加一个中性的「只读」`StatusPill`，悬停时说明「你的角色是坐席，只能查看」。编辑类按钮不渲染，而不是灰着放在那里。

### 登录

- 页面直接铺在纸上，不做「左半品牌色块 + 右半表单卡」这种常见的 SaaS 模板。
  - 一栏居中：宋体标语「AI 销售助手 · 运营后台」（展示级 32/40）；一句无衬线说明「在这里维护销售话术和产品库，企业微信里的 AI 销售按它们接待客户。」；然后是表单，输入框本身是「面」色。
  - 视口底部是通栏的 `RidgeScroll`。
- 字段是「邮箱」「密码」（不用「口令」）。标签在上方，不加冒号 [22]；占位符只放示例。
- 错误显示在按钮上方的页内 Alert 里，文案取 `ERROR_COPY`，不用 toast。服务端登录失败的 `detail` 同步由「邮箱或口令不对」改为「邮箱或密码不对」。
- 从匿名演示点「登录」进来时，表单下方给一个「返回演示」链接（viewer 状态里带 `from: 'anon'`）。
- 状态：提交中按钮显示 loading；429 按 `ERROR_COPY` 显示。

### 总览（新）

总览回答两个问题：现在在跑什么，接下来该做什么 [8][9]。只调现有接口，前端并发请求；各块独立加载、独立出错，一块失败不影响其他。

布局从上到下：

1. **目的地长卷**（所有人可见）。数据取已上架线路，按 `destination` 分组，按 `overseas` 分成境内、境外两段；每个字标下面写「N 条线路」，本月在旺季的加「本月旺季」。点一个字标，跳到 `/catalog/route?dest=…`。窄屏时横带在自己的容器里横向滚动，页面本身不横滚。
2. **指标条**。不是一排独立的圆角卡片 [123]，而是一条 1px 描边的横条，用竖分隔线分成几格，像题签。每格上面是 12px 标签，中间是展示级的宋体数字，下面一行是链接：

| 格       | 数据                                                              | 成员                                                                              | 匿名             |
| -------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------- |
| 线上话术 | `GET /sop`                                                        | 「v3」+「9月26日 14:02 · 老板发布」；有草稿时用石青字「草稿改了 2 节 → 继续编辑」 | 版本号与发布日期 |
| 在售线路 | `GET /catalog/route`                                              | 上架数；有草稿时「2 条草稿待上架 →」，跳到草稿页签                                | 上架数           |
| 在售酒店 | `GET /catalog/hotel`                                              | 同上                                                                              | 上架数           |
| 会话     | `GET /conversations?limit=1` 与 `?state=human&limit=1` 的 `total` | 总数；「已转人工 N →」                                                            | 不显示           |

3. **系统状态**（约 1/3 宽）+ **最近变更**（约 2/3 宽）。最近变更取 `GET /audit?limit=5`，默认不含登录，显示 5 句人话和「查看全部」，只给 owner、admin 看。其他成员只有系统状态；匿名两块都没有。

系统状态由 `Status` 译成人话。一切正常时只显示一行石绿的「一切正常」：

- `lock === 'lost'` → 朱砂：「暂时无法保存修改：和数据库的锁连接断开了，系统在自动重连。线上话术和产品不受影响。」
- `sopStale` / `catalogStale` → 赭石：「话术 / 产品库的最新修改还没载入运行中的系统，正在自动重试。」
- `index.stale` 或 `index.lastError` 不为空 → 赭石：「线路搜索索引在更新，新上架的线路可能暂时搜不到。」`lastError` 的原文收进技术详情。
- `drift` 不为空 → 中性：「后台里改过 N 处内容，和代码仓库里的初始数据不同，以后台为准。」点开后按节、按条目列出。

匿名首屏在长卷上方加一段说明，兼作作品集的门面：宋体标题「这是 AI 销售助手的运营后台」（展示级）、一句话、主按钮「去体验对话」、次按钮「登录后编辑」，底部是通栏的 `RidgeScroll`。

状态：

- 每块都有自己的骨架；
- 接口失败时，块内显示「没取到 · 重试」；
- 在售数为 0 时，长卷位置显示「从第一条线路开始」，编辑者多一个「新建线路」。

### 销售话术（SOP）

布局（宽 ≥ 1280）：

```
┌ 销售话术                          [版本记录] [检查] [发布…] [···] ┐
│ 线上 v3 · 9月26日 14:02 老板发布 ｜ 草稿改了 2 节 · 已保存 刚刚         │
│ 字数额度 ▇▇▇▇▇▇▇▇▇▇▇▇▇▇░░░░ 2,238 / 2,658 · 还能写 420 字             │
├──────────────┬────────────────────────────────────────┤
│ 目录（240）   │ 话术原则                                          │
│ □ 前言        │ ┌ 编辑器（16/28，行宽 ≤ 40em）──────────┐    │
│ [固定] 各阶段目标 │ │ …                                        │    │
│ ■ 话术原则 ②  │ └─────────────────────────────────┘    │
│ [计价] 报价纪律 │ 本节 612 字（比线上 +34）                         │
│ …             │                                                   │
└──────────────┴────────────────────────────────────────┘
□ 未改  ■ 改过（石青）  ② 有 2 个问题（朱砂）  [固定] 钢印
```

**页头与状态句。**

- 状态句一句话说清三件事：线上是哪一版（谁、什么时候发布的）、草稿相对线上改了几节（石青字）、保存状态 [52][58][69]。保存状态的文字预留固定宽度，切换时不挤动布局。
- 操作区依次是：「版本记录」「检查」（默认按钮）、「发布…」（唯一的主按钮）、「更多」（里面是「丢弃草稿」）[4][35]。
- 草稿和线上相同时，「发布…」禁用，Tooltip 说明「草稿和线上一样，没有可发布的改动」。n8n 在没有可发布的改动时同样禁用发布按钮 [52]。

**字数额度。**

- 前端按服务端的同一口径实时计算：可编辑节的正文（去掉标题行和其后的空行），UTF-16 长度求和。上限取 `SopOverview.budget.limit` 向下取整。
- 把 `src/sop/sections.ts` 里的 `TRAVEL_SOP_SECTIONS`、`sectionBody`、`editableChars` 挪到 `src/shared/sop-sections.ts`，`src/sop/sections.ts` 原样再导出，前后端共用。这几项没有任何 import，挪过去不越界。节表以后由行业包定义（03），到时再挪走。
- 额度条按节分段，每节一段，当前节加深，悬停显示节名和字数。
- 三档颜色：< 95% 中性；95%–100% 赭石；> 100% 朱砂，并写「超出 38 字，发布会被拦下」。阈值不取常见的 80%：上限是导入版本的 1.2 倍（`BUDGET_RATIO`），没改过的话术就已经在 83%，按 80% 算会一直是赭石。超限不拦输入 [64]。字数上限的做法可参照 Fin：它的每条指引上限 2,500 字符 [60]。
- 编辑器下方写「本节 612 字（比线上 +34）」。

**目录。** 保持 prompt 的原顺序（这个顺序就是模型读到的顺序），用 `RouteLine` 画成站点：

- 可编辑节：正常字重，站点状态按「签名细节」的 4 种来画。编辑区标题只写节名，不写「第 N 站」。
- 固定规则节（01 的锁定节）：印文钢印「固定」，不用 Tag。锁的标记在列表里就能看到，不用点开才知道；WordPress 在工具栏和列表视图里都显示锁图标 [61]。
- 匿名与成员的目录一样都有钢印：节表来自 `src/shared/sop-sections.ts`，不依赖 `AnonSopOverview`。
- 标题允许两行，不截断，悬停显示全称。
- 键盘：上下方向键切换，Enter 进入编辑器（roving tabindex）。
- 选中的节写进 URL 的 `section`。

**编辑器。**

- 去掉行号；用比例字体，16/28，行宽 ≤ 40em。
- 加 `@codemirror/lang-markdown` 的轻量高亮：粗体标记、列表标记用次要色，不渲染成富文本。
- `EditorView.contentAttributes({ 'aria-label': '「话术原则」正文' })`。
- 编辑器和差异视图都用 `EditorState.phrases` 汉化（见「落到 antd v6」）。

**固定规则节。** 正文只读，但保持正文色。外框左侧是 4px 斜纹（`--yt-hatch-*`），上方写一句：「这一节是报价、转人工等硬规则，由开发在代码里维护，这里改不了。要改请联系开发。」不出现「镜像」「data/sop.md」[26][27]。这样分工的依据：Decagon 让运营用自然语言写流程，工程保留护栏和代码 [62]；OpenAI 也建议把 prompt 放进代码走评审 [63]。本项目只对护栏这样做。

**自动保存。**

- 停止输入 1.5 秒后调 `PUT /sop/draft`，带 `rev`；首次保存带 `rev: null`、`basedOn: published.id`。
- 状态文字：「保存中…」→「已保存 · 刚刚」。失败时按 2s、5s、15s 退避重试，状态变成朱砂的「没保存上 · 重试」，并带手动重试按钮。
- `⌘S` / `Ctrl+S` 立即保存。去掉「保存草稿」按钮：同一页不混用手动保存和自动保存 [29]。
- 409 `rev_conflict`：不重试，停住自动保存。页头下显示「草稿刚被别人改过」横幅和「载入最新草稿」按钮；本地没保存上的节以只读对比的形式保留，供复制。
- 有未保存或保存中的内容时，离开受保护（见通用部件）。

**检查与问题。**

- 「检查」先冲掉待保存的内容，再调 `/draft/check`。
- 有问题时，页头下方出现问题面板（朱砂 Alert，标题「有 3 处需要改，发布前要处理」）。每条一行：中文类型 + 节名 + 说明。说明由前端按 `code`、`sectionKey`、`match` 生成，服务端的 `detail`（含「V9 SOP…」这类出处）只放进每条的技术详情。点一条，就切到该节、滚到命中的文字并选中 [65]。
- 编辑器里用 `@codemirror/lint` 在 `match` 所在的范围画波浪下划线，悬停显示同一句说明 [156]；下划线的样式见「落到 antd v6」。目录上，该节的站点变成问题站点，并显示问题数。
- 没有问题时，面板显示石绿的「检查通过，可以发布」，不再显示哈希。

| code               | 中文             | 前端生成的说明                           | 定位                           |
| ------------------ | ---------------- | ---------------------------------------- | ------------------------------ |
| `structure`        | 结构有问题       | 这一节的标题或位置被改了，改回原来的标题 | 到节                           |
| `locked_changed`   | 改动了固定规则节 | 固定规则节不能改，撤回这一节的改动       | 到节                           |
| `phrase_missing`   | 少了必需的说法   | 要保留这句：「{match}」                  | 找线上版本里含这句的节，跳过去 |
| `phrase_forbidden` | 用了禁用说法     | 「{match}」不能出现在话术里              | 到 `match`                     |
| `unknown_tool`     | 工具名不存在     | 「{match}」不是现有的工具                | 到 `match`                     |
| `unknown_field`    | 字段名不存在     | 「{match}」不是现有的字段                | 到 `match`                     |
| `over_budget`      | 超出字数额度     | 超出 N 字（前端算）                      | 到额度条                       |

**发布抽屉。** 点「发布…」：先冲掉待保存的内容，右侧打开 640px 的抽屉「发布到线上」，自动调 `/draft/check`。抽屉里依次是 [54][55][56]：

1. **预检清单**，逐项打勾或打叉：结构、固定规则节没动、必需的说法、禁用的说法、工具与字段名、字数额度、与线上合并。失败项可以点，点了关抽屉并定位。
2. **替换说明**：「将替换线上 v3（老板 · 9月26日 14:02 发布）」。
3. **逐节改动**：只列改过的节，用 `unifiedMergeView`，开 `allowInlineDiffs`、`mergeControls: false`，未改动的部分折叠 [157]。节标题行写「+3 行 −1 行」；右上角有「行内 / 并排」切换，选择存进 localStorage [66][57]。新增行是石绿浅底加行首「+」竖条；删除行是米色浅底、次要色、删除线，行首「−」，不用红 [133]。
4. **变更说明**：可见的标签「这次改了什么、为什么」，预填「修改：话术原则、异议处理。」。必须在预填之外再写至少一个字才能发布；占位示例「客户嫌贵时先问预算上限」[50]。
5. **底部**：「发布」（主按钮）+「取消」。预检没有全过时，「发布」禁用，旁边写原因。这里禁用主按钮是可以的：抽屉很短，原因就写在旁边 [86]。

成功后：抽屉关闭，版本记录里的新站点压印一次，toast「已发布 v4」，状态句更新。原来页面底部的「逐节对比」卡片去掉，挪进了抽屉。

**冲突合并。** 预检里 `rebase.conflicts` 不为空，或者发布返回 409 `sop_conflict` 时，抽屉里显示「有 2 节在你改的同时被改了」和按钮「去合并」。主区进入合并模式 [67]：

- 目录上冲突的节标「需合并」；页头显示「还有 2 节要合并」和「完成合并」按钮。
- 每个冲突节一个 `MergeView`：左边「线上 v4 的写法」只读，右边「你的草稿」可编辑。`revertControls: 'a-to-b'` 让运营逐块「采用线上的写法」[157]。每节底部有「这一节处理好了」。
- 全部处理好后点「完成合并」：调 `PUT /sop/draft`，带 `rebaseOnto: <当前发布版本 id>`，`edits` 为全部冲突节的合并结果（见「接口改动」）。成功后回到发布抽屉。
- 合并模式期间暂停自动保存，退出时恢复。

**版本记录（题跋式）。** 「版本记录」打开右侧 420px 的抽屉（URL 上是 `view=history`），用 `RouteLine` 竖排，最新的在上面 [55][57][70]。每一站像长卷后面的一段跋文：先写为什么改，再落款。

```
┆ 草稿 · 未发布 · 改了 2 节                 （虚线段，石青实心站）
■ v4  客户嫌贵时先问预算上限，再给两档方案。       ← 变更说明，阅读级 16/28
            老板 · 9月26日 14:02  [线上]          ← 落款 12px 次要色，右对齐
□ v3  ⟲ 回到 v1 · 撤回上周的报价话术
            老板 · 9月25日 18:30
```

- 站名「v4」用宋体数字；来源为回滚时，站内画 `RollbackOutlined`，说明前写「回到 v1」。来源的中文名：导入、后台发布、回滚、系统更新（副注「代码里的固定规则变了」）。
- 线上版本是石绿实心站，带「线上」`StatusPill`。每个版本带说明的做法，可参照扣子的版本列表 [56]。
- 每站的操作：
  - 「查看改动」：主区切到只读对比「v2 相对 v1 改了什么」，只列变化的节；页头横幅「正在查看 v2 · 回到编辑」；URL 上是 `v=2`。
  - 「回滚到这版…」：线上版本没有这一项。
  - 「载入到草稿再改」。
- 哈希（prompt、tools、prefix、sop 各取前 12 位）收进每站的「技术详情」折叠区。01 验收 22 要求历史列表出现 prompt_hash，展开技术详情即可看到。
- 底部「更早的版本」按 `before` 翻页。

**回滚。** Modal（640px），标题「回滚到 v1」[36][68][71]：

- 三句人话：「会生成一个新版本并立即上线。」「v3、v4 都还在，随时能再切回来。」「固定规则节保持现在的写法，不会退回旧版。」
- 差异：「回滚后，线上的可编辑节会从 v4 变成这样」。前端已经有两个版本的 `sections`，不需要新接口。
- 目标版本的固定规则节和线上不同时，在提交之前就显示赭石提示：「v1 之后代码里的固定规则改过，回滚后这些节用现在的写法，所以新版本不会和 v1 完全一样。」不再在事后弹 `modal.info`。
- 变更说明必填，标签可见。
- 按钮「回滚到 v1」（主色，不用红：回滚会生成新版本，还能再回滚，不是破坏性操作）+「再看看」。

「载入到草稿再改」：把目标版本的可编辑节 PUT 进草稿。已有草稿时，先确认「会覆盖草稿里的：话术原则、异议处理」。

**丢弃草稿。** 在「更多」菜单里，不常驻；菜单项本身不加 danger。点了之后弹 `ConfirmDanger`：

- 标题「丢弃草稿？」；
- 正文「草稿里 2 节改动（话术原则、异议处理）会丢掉，线上 v3 不受影响。这一步撤销不了。」；
- 按钮「丢弃草稿」（描边红字）+「保留」（默认焦点）。

状态：

| 状态       | 表现                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| 加载       | 页头骨架 + 目录 12 行骨架 + 编辑器骨架，尺寸与成品一致                                |
| 出错       | 整块 `StateView` 错误 + 重试                                                          |
| 空         | 不会出现（总有已发布版本）。「没有草稿」是正常状态，状态句写「没有未发布的改动」      |
| 匿名       | 目录（含钢印）+ 只读正文；页头只有状态句「线上 v3 · 9月26日」；没有额度条、按钮、哈希 |
| 非编辑成员 | 和编辑者同一布局，全部只读；能看版本记录，没有回滚与载入；状态句末尾有「只读」        |
| 宽 < 1280  | 目录变成编辑器上方的下拉选择；抽屉宽 `min(640px, 100vw)`                              |

### 产品库列表

页头「线路」，说明「共 20 条 · 销售助手只推荐已上架的」；右上角是「新建线路」（主按钮），酒店页另有「导入 CSV」（次按钮）。新建资源的主操作固定放在右上角 [5]。线路不能用 CSV 导入，所以不渲染入口，也不再放一个灰按钮。

表格上方一行：搜索在左，筛选随后，计数在右 [15][16][73][74]。

- 页签：全部 20 / 已上架 18 / 草稿 2（前端计数；匿名只有「全部」）。
- 搜索：名称、目的地、客户的其他叫法、编号，输入即筛 [13]。
- 常驻筛选不超过 3 个 [16]：目的地、境内/境外、适合客群。生效的条件显示成可以单独删除的标签，另有「清除筛选」[111][112]。
- 以上全部写进 URL。

线路的列 [10][46][76]：

| 列             | 内容                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| 线路           | `DestinationMark` + 两行：线路名称（链接，键盘可达，点进详情 [13]）；次行是次要色的「四川 · r-sichuan-lux」 |
| 天数           | 「8 天」，右对齐                                                                                            |
| 每人起价（元） | 「42,800」，右对齐、等宽数字；单位写在表头                                                                  |
| 适合客群       | 最多 3 个中性标签，多出来的显示「+2」                                                                       |
| 海拔 · 强度    | 「4,700 米 · 较累」；≥ 3000 米时加高原小图标（带文字说明）                                                  |
| 最佳季节       | `SeasonStrip`                                                                                               |
| 状态           | `StatusPill`：已上架（石绿 + `CheckCircleOutlined`）/ 草稿（墨灰 + `EditOutlined`）[12][97]                 |
| 更新           | 「09-26 14:30 · 老板」；系统导入的写「系统导入」                                                            |

酒店的列：酒店（字标 + 名称 + 次行「目的地 · 编号」）、星级档次、每晚起价（元）、主推房型、标签、状态、更新。

- 整行悬停可以点进详情；名称单元格是真正的链接 [137]。
- 数据不足一页时不显示分页器 [13]；超过 50 条再分页。
- 窄屏时首列固定，其余列横向滚动 [135]。

状态：

| 状态             | 表现                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| 加载             | 8 行表格骨架                                                                                      |
| 空（从来没有过） | 「从第一条线路开始」+ 说明「上架后，销售助手会向客户推荐它」+「新建线路」（酒店另有「导入 CSV」） |
| 筛选无结果       | 「没有符合条件的线路」+「清除筛选」链接，没有主按钮                                               |
| 出错             | 表格位置显示错误 + 重试                                                                           |
| 匿名             | 只有已上架的条目；没有状态、更新两列，没有新建入口                                                |
| 非编辑成员       | 没有新建、导入入口                                                                                |

### 产品库详情与编辑器

改成独立页面 `/catalog/$kind/$code`（新建是 `/catalog/new/$kind`），取代 720px 的抽屉：有自己的 URL，字段多也不挤 [25]。两栏布局：主栏约 2/3，放分组卡片；副栏约 1/3，吸顶，放状态和元数据 [25][89]。宽 < 1280 时副栏落到主栏下方。

```
┌ 产品库 / 线路 / 四川 稻城亚丁·色达秘境 8 日                                 ┐
│ 四川 稻城亚丁·色达秘境 8 日  [✓ 已上架]        [编辑 | 预览]  [··· 复制为新草稿] │
├──────────────────────────────┬───────────────────────┤
│ 基本信息                 [识别]│ 状态                     │
│  销售助手靠这些认出客户说的是哪条线…│ [✓ 已上架] · 9 项锁定    │
│ 价格与季节               [计价]│ 上架前检查 ✓ 9/9         │
│ 适合谁去                 [推荐]│ 更新：老板 · 2 小时前    │
│ 逐日行程                        │                          │
│ 费用包含与不含           [条款]│                          │
│ 卖点                            │                          │
│ 客户怎么叫               [识别]│                          │
├──────────────────────────────┴───────────────────────┤
│ ◷ 有 3 处改动   [放弃]  [保存并立即生效]  销售助手下一条回复就用新内容        │
└──────────────────────────────────────────────────────┘
```

**字段元数据。** 新文件 `src/shared/catalog-fields.ts` 导出 `CATALOG_FIELDS: Record<CatalogKind, readonly FieldMeta[]>`。它是字段标签、帮助、占位、单位、控件、分组、锁定组的唯一来源：

- rjsf 的 `ui:title`、`ui:description`、`ui:placeholder`、`ui:order` 由它生成 [159]；CSV 表头、错误路径、审计改动表也用它。
- 帮助文字常驻在字段下方，占位符只放示例 [22][50]。标签简单易懂 [47]，不加冒号。多数字段必填，只给选填字段标「（选填）」[23]。
- 分组从弱到强：同一卡片内加小标题 → 分成不同卡片 [24]；卡片顺序按旅游行业后台的习惯排 [76][84]。

线路：

| 字段                | 标签                   | 帮助（字段下方常驻）                                                                                         | 控件                                         | 分组       | 上架后                   |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ---------- | ------------------------ |
| `id`                | 线路编号               | 小写字母、数字和连字符，建好后不能改。例：r-sichuan-lux                                                      | 输入（新建时可填，之后是只读文本）           | 基本信息   | 锁定 · 识别              |
| `title`             | 线路名称               | 写上目的地和天数 [77]。例：四川 稻城亚丁·色达秘境 8 日                                                       | 输入                                         | 基本信息   | 锁定 · 识别              |
| `destination`       | 目的地                 | 客户问「去哪」时按它匹配                                                                                     | 输入 + 已有目的地联想                        | 基本信息   | 锁定 · 识别              |
| `days`              | 天数                   | 要和逐日行程的天数一样                                                                                       | 数字，后缀「天」                             | 基本信息   | 锁定 · 识别              |
| `overseas`          | 境内还是境外           | 推荐和报价按它区分境内外，没选不能保存                                                                       | 普通 `Radio`「境内」「境外」，**没有默认值** | 基本信息   | 锁定 · 推荐              |
| `priceFrom`         | 每人起价               | 填淡季、4 人以下的价；旺季上浮 10%、4 人及以上 95 折由系统算                                                 | 数字，千分位，后缀「元/人」，整数            | 价格与季节 | 锁定 · 计价              |
| `bestSeason`        | 最佳季节               | 写月份区间，如「5月-10月」「11月-次年4月」，或写「全年」。这些月份出发报价上浮 10%，「全年」不加价           | 输入 + 季节条实时预览（「识别出：5–10 月」） | 价格与季节 | 锁定 · 计价              |
| `segments`          | 适合客群               | 可多选，推荐线路时按它筛                                                                                     | 复选组：家庭 亲子 蜜月 商务 银发             | 适合谁去   | 锁定 · 推荐              |
| `maxAltitude`       | 全程最高海拔（选填）   | 按行程核实的最高点。给长辈挑低海拔线路时只看这个数                                                           | 数字，后缀「米」                             | 适合谁去   | 锁定 · 推荐              |
| `intensity.level`   | 体力强度（选填）       | 看最累的那天：轻松＝以车览、城市漫步为主；适中＝有成段步道、索道、骑行；较累＝数小时徒步，或连着几天长途越野 | `Segmented`「不填 \| 轻松 \| 适中 \| 较累」  | 适合谁去   | 可改                     |
| `intensity.hardest` | 最累的一段             | 照行程原文概括；行程没写步行量就写「行程没写」。选了体力强度才出现，出现就必填                               | 输入                                         | 适合谁去   | 可改                     |
| `itinerary`         | 逐日行程               | 见下一节                                                                                                     | 站点时间轴                                   | 逐日行程   | 条数随天数锁定，文字可改 |
| `inclusions`        | 费用包含（选填）       | 写具体：酒店写城市和档次，门票写景点 [77][78]                                                                | 逐条列表                                     | 费用       | 锁定 · 条款              |
| `exclusions`        | 费用不含（选填）       | 写明单房差、自费项目 [77]                                                                                    | 逐条列表                                     | 费用       | 锁定 · 条款              |
| `hotelLevel`        | 住宿档次               | 例：五星/奢华度假村                                                                                          | 输入                                         | 卖点       | 可改                     |
| `highlights`        | 行程亮点               | 建议 3–5 条，每条以动词开头 [78]                                                                             | 逐条列表，可上移下移                         | 卖点       | 可改                     |
| `tags`              | 标签                   | 自由标签，如海岛、摄影；其中「国内」上架后锁定                                                               | 标签输入                                     | 卖点       | 只有「国内」锁定 · 推荐  |
| `aliases`           | 客户的其他叫法（选填） | 标题和目的地里没有、客户常说的叫法，如「川西」「海南」；只写这条线真正覆盖的地方                             | 标签输入                                     | 客户怎么叫 | 锁定 · 识别              |

`overseas` 为什么没有默认值：`RouteSchema` 里它是必填的 `z.boolean()`。开关没有「未选」态，新建时要么默认成 false，把境外线路静默存成境内；要么缺键。字段上架后锁定，错了只能停机用 `catalog-fix` 修。所以要逼运营明确选一次。

`itinerary` 的子字段：

- `day` 第几天：自动编号，只读；
- `title` 当天标题，例：成都 → 丹巴；
- `detail` 当天安排：客户在手机上看，写清距离和用时，120 字以内为宜 [76]；
- `hotel` 当晚住宿：最后一天可以写「—（返程）」；
- `meals` 当天餐食。

酒店的字段：

- `id` 酒店编号，锁定 · 识别；
- `name` 酒店名称，锁定 · 识别；
- `destination` 目的地，锁定 · 识别；
- `stars` 星级档次，例：五星、奢华，可改；
- `nightlyFrom` 每晚起价（元/晚），锁定 · 计价；
- `roomType` 主推房型，例：水上别墅，可改；
- `highlights` 酒店亮点，可改；
- `tags` 标签，可改。

分组：基本信息、价格、卖点。

**锁定组与原因。** 沿用 01 的「各字段为什么锁」，一组只说一次，不再在每个字段下重复 [27][86]。卡片头右侧是该组的印文钢印，钢印下方用 12px 说明色常驻写原因：

- 识别：「销售助手靠这些认出客户说的是哪条线，改名会让对话里的旧说法认不出来。」
- 计价：「已发给客户的方案书按这些数算价，改了会变价。」
- 条款：「已发出的方案书按这些条款承诺。」
- 推荐：「推荐和安全护栏按这些筛线路，包括给长辈换低海拔线路、境内外过滤。」

所有组共用一句结尾：「有报价快照（02）后开放；急需修正请联系技术。」

锁定计价字段是本项目为保持已发方案书一致而做的取舍，不是行业通行的做法。Stripe 的 Price 金额创建后不可改，改价要新建 [87]；Shopify 则允许直接改价，保存即生效 [89]。报价快照上线之前，本项目取前者。

草稿状态下，这些字段旁标一个小的「上架后锁定」，提醒上架前重点核对。

**控件。** 用自定义的 rjsf widgets 和 templates 包 antd 组件；表单进出只经过 `toFormData` / `fromFormData` 两个纯函数（放在 `src/shared/catalog-fields.ts`），序列化结果和现在完全相同。

- `ObjectFieldTemplate`：按 `CATALOG_FIELDS` 的分组渲染成 antd Card，卡片头放该组的钢印和原因。
- `FieldTemplate`：标签在上，帮助文字常驻。必填不打星（`ConfigProvider` 的 `form.requiredMark`，见上文），选填标「（选填）」。截图 06 里的红星因此消失，`Form.labelRequiredMarkColor` 取说明色，作为兜底。
- **`ButtonTemplates` 全部覆盖** [168]。@rjsf/antd 默认的 `RemoveButton` 是 `danger` 的实心红按钮，文案是英文。覆盖成：
  - `AddButton`「添加一条」；
  - `RemoveButton`：`DeleteOutlined` 图标按钮，`aria-label`「删除这一条」，默认样式，不用 danger；
  - `MoveUpButton` / `MoveDownButton`「上移」「下移」；
  - 不提供复制按钮。
- `translateString` 传入完整的中文对照表，覆盖 rjsf 的全部 `TranslatableString` [167]。
- 金额与数字：`InputNumber`，千分位、整数、单位后缀；提交值仍是整数。
- `segments`：复选组。JSON Schema 里没有 `uniqueItems`，rjsf 默认会渲染成「一项一个下拉加添加按钮」，所以用自定义 widget [159]。
- `tags`、`aliases`：`Select mode="tags"`。`highlights`、`inclusions`、`exclusions`：逐条列表，每条一个输入框，可以增删、上移下移。
- **空值规则**：`aliases`、`inclusions`、`exclusions`、`maxAltitude` 清空就等于删键（进 `unset`），不留 `[]` 或空串，因为 schema 要求这些字段出现时 `.min(1)`。`intensity` 选「不填」时整组 unset；选了档位，才出现「最累的一段」并且必填。
- **只读字段**（上架后锁定的、非编辑角色看到的、匿名看到的）渲染成纯文本值：正文色，不画输入框，不用禁用色，可以选中复制 [26][86]。

**费用包含与不含。** 左右两列对照：左列「包含」行首是勾号；右列「不含」行首是中性的减号，不用红叉，「不含」不是错误 [77]。常用条目的联想取自现有全部线路的包含、不含，去重。

**副栏。**

1. **状态卡**：`StatusPill`（已上架 / 草稿）。草稿时有「上架…」主按钮，有未保存的改动时先保存。已上架时写「已上架 · 9 项锁定」。
2. **上架前检查**：`src/shared/catalog-readiness.ts` 里的纯函数 `catalogReadiness(kind, payload)` 实时计算，每项可以点，点了跳到对应字段 [79][75]。
   - **必须项**直接用 `RouteSchema.safeParse(payload)`（酒店用 `HotelSchema`）的 issues，按 `path` 经 `labelOfPath` 映射到字段，不另写一份规则，免得和 schema 走偏。例如「境内还是境外：没选」「逐日行程：有 3 天，要和天数（4）相同」。
   - **建议项**只提示，不拦上架：亮点 3–5 条；填了最高海拔；填了体力强度；至少有一个客户的其他叫法；费用包含和不含各至少一条；每天都写了住宿；「包含」里写了全程用餐但某天的餐食不全。
   - 顶部是一条细进度条「7/9 项」。
   - 「上架…」按钮不禁用。长表单不禁用主按钮 [22]。必须项没过时点它，不打开确认框，而是展开检查清单，焦点跳到第一个没过的字段，做法同 GOV.UK 的错误汇总 [65]。
3. **元数据卡**：更新人、更新时间。用相对时间，悬停看绝对时间 [45]。

**保存条。** 有改动时，底部吸底出现「有 3 处改动 · 放弃 · 保存…」，前面是赭石的 `ClockCircleOutlined` [28][88]：

- 草稿：按钮「保存草稿」。
- 已上架：按钮「保存并立即生效」，旁边小字「销售助手下一条回复就用新内容」（01 规定写接口返回 200 时快照已更新）[89]。可以展开改动摘要，如「行程亮点：第 2 条改了」。
- 提交中按钮显示 loading，其余时候不禁用 [22]。保存后页面已经反映结果，不再弹 toast [29]。
- 没有改动时保存条不出现。
- 离开保护见通用部件。409 `rev_conflict` 用朱砂横幅「这条刚被别人改过」+「载入最新版本」，本地的改动以对比形式保留。

**报错落到字段。**

- 服务端的 `issues[].path`（如 `itinerary.3.meals`）映射到 rjsf 的 `extraErrors`，显示在对应字段下方。标签用 `labelOfPath` 翻成「逐日行程 · 第 4 天 · 当天餐食」。
- 顶部只放一行汇总「有 2 处要改，点击跳转」，汇总不是唯一的报错位置 [90][65]。`showErrorList` 设为 `false` [167]。
- **失焦校验只显示碰过的字段。** rjsf 的 `liveValidate: 'onBlur'` 会在失焦时校验整张表单 [167]，新建时离开第一个字段，所有空着的必填字段会一起报错。所以不开 `liveValidate`。维护一个「已失焦或已提交过」的字段集合；失焦时对整张表单跑一次 `zodValidator`，只把集合里字段的错误经 `extraErrors` 显示出来。点保存时，把全部字段加入集合 [90]。
- `locked_field` 的 `fields` 用中文名列出。

**上架确认。** 用 Modal 替换 Popconfirm [36]：

- 标题：「上架「四川 稻城亚丁·色达秘境 8 日」」。
- 正文三段：
  1. 「上架后，销售助手会立即推荐这条线路，并按每人 42,800 元起报价。」
  2. 「下面这些内容会锁定」：按锁定组列出中文字段名和当前值，方便最后核对，如「天数 8 · 每人起价 42,800 元 · 最佳季节 5–10 月 · 境外：否 · 费用包含 3 项」。
  3. 「上架后无法下架，锁定的内容只能由技术修正。」
- 按钮：「上架，开始推荐」（主色，不用红：上架不是破坏性操作）+「再检查一下」（默认焦点）。

**复制为新草稿。** 在「更多」菜单里。弹窗要求填新编号，并提醒「两条都上架会同时被推荐，请区分名称和客群」，然后用原 payload（换掉 `id`）调现有的 `POST /catalog/:kind`。Shopify 复制商品时也可以把副本设为草稿 [83]。

**预览。** 页头的「编辑 | 预览」页签（URL 上是 `tab`）。预览按 375px 手机宽度渲染一张方案书风格的卡片：标题、天数、起价、季节条、逐日时间轴、包含与不含对照 [76]。做法类比 Airbnb 按房客所见预览入住指南 [96]。数据取当前表单，包括未保存的改动。全部以文本节点渲染，不用 `dangerouslySetInnerHTML`：产品库的文本是不可信输入（01）。匿名演示默认显示预览，不显示只读表单。

状态：

| 状态       | 表现                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| 加载       | 两栏骨架，卡片高度与成品一致                                                          |
| 不存在     | 「没有这条线路」+「回到线路列表」                                                     |
| 出错       | 页内错误 + 重试                                                                       |
| 匿名       | 默认显示预览页签；编辑页签是全只读文本                                                |
| 非编辑成员 | 全只读文本；没有保存条、上架、复制                                                    |
| 窄屏       | 副栏落到主栏下方；编辑流程只保证宽 ≥ 1024，更窄时顶部提示「建议在电脑上编辑」，但不拦 |

### 逐日行程编辑器

用自定义的 rjsf `ArrayFieldTemplate`，做成竖向的站点时间轴 [76][79][80][81]：

- 左侧是 `RouteLine`，站点写「D1」…「Dn」。这一天的各项都填了，是石青实心站；有缺项是空心站，旁边写「缺：当晚住宿」；有校验错误是问题站。
- 右侧每天一张卡：
  - 当天标题；
  - 当天安排：多行文本，右下角显示字数；超过 120 字时，赭石提示「手机上会很长」[76]；
  - 当晚住宿；
  - 当天餐食。
- 每张卡的右上角是「上移」「下移」「删除这一天」。不做拖动：按钮本身就满足 WCAG 2.5.7 对单指针替代的要求 [172]。
- **当晚住宿**：输入框 + 联想。联想来源是同目的地酒店库的 `name`，以及本线路已经写过的住宿；存的仍是文本。另有「复制上一天的住宿」按钮 [82]。
- **当天餐食**：「早」「午」「晚」三个切换片。
  - 序列化：按「早、午、晚」的顺序，用「/」连接选中的项；一个都不选，存「—」。
  - 现有数据的全部取值（「早/午/晚」「早/午」「早/晚」「早」「晚」「—」）都符合这条规则，读进来再写出去逐字节相同。
  - 规则之外的旧值（自由文本）显示原文输入框，并提示「这天的餐食写法不标准」，不自动改写。
  - 纯函数 `parseMeals` / `formatMeals` 放在 `src/shared/catalog-fields.ts`。
- `day` 自动编号，不可编辑；增删、上移下移后自动重排。
- 与天数联动：条数不等于天数时，时间轴头部用赭石显示「还差 2 天」或「多了 1 天」；这同时是上架前检查的必须项（来自 schema）。
- 已上架的条目，天数锁定：隐藏增删和移动，只能改文字。

### CSV 导入（酒店）

Modal（宽 `min(880px, 100vw)`），分步进行 [91][92][85][93]：

1. **模板。** 「下载模板」生成带 UTF-8 BOM 的 CSV，表头用中文标签（酒店编号、酒店名称、目的地……），只有表头一行 [94]。弹窗里用一张小表展示一行示例和填写说明：数组用「、」分隔，布尔值写「是 / 否」。
2. **选文件。** `Upload.Dragger`（`beforeUpload` 返回 `false`，只在本地读），保留「粘贴」页签。
   - 解码：先用 `new TextDecoder('utf-8', { fatal: true })`，失败再用 `gb18030`，并提示「按 GBK 读取」。
   - 为什么兜底 GBK：中文 Windows 上，Excel 的「CSV（逗号分隔）」按系统 ANSI 代码页保存，简体中文就是 GBK。这是本项目的判断。微软社区问答里有同样的说法 [95]，但没有找到微软的官方文档，所以以验收 15 的实测为准。
3. **预检。**
   - 前端直接调共享的 `prepareCatalogCsv` 与 `parseCsv`，逐行显示合格或不合格。出错的单元格描红并写原因：沿用现有的中文报错，路径翻成中文标签。
   - 对照已载入的列表，检查编号是否已经存在 [93]。
   - 按服务端的三条上限预检：≤ 200 行（`MAX_CSV_ROWS`）、`csv` ≤ 60,000 字符（`ImportCsvBody`）、请求体 ≤ 64 KB（`MAX_BODY_BYTES`，按 UTF-8 字节算，中文每字 3 字节）。超限时写「这份文件太大，请分成 N 份导入」，不让运营去碰 413 或 400。
4. **导入。**
   - 全部合格：「导入 N 条草稿」（主按钮）。
   - 有不合格：主按钮禁用并写原因。次按钮有两个：「只导入合格的 N 行」（前端过滤后重新序列化再提交，同样过上面三条上限）和「下载不合格的 M 行」（CSV，多一列「原因」）[92][85]。
   - **防公式注入** [113]。下载的文件里，以 `=`、`+`、`-`、`@`、制表符、回车、换行（包括全角的 ＝＋－＠）开头的单元格，在引号内的开头加一个制表符。这是 OWASP 给 Excel 的建议；所有单元格都加双引号，文件带 BOM。
   - 已知的局限：OWASP 提醒，Excel 另存再打开后，这些转义可能被去掉；前缀的制表符也会留在数据里。所以 `prepareCatalogCsv` 导入时，只去掉「制表符 + 上述危险字符」这一种开头的制表符，其余不动，并配自测。
5. **结果。** 「已建 N 条草稿」+「去草稿页签逐条检查后上架」。

服务端契约不变，仍然只收 `{ csv }`。共享的 `prepareCatalogCsv` 额外接受 `CATALOG_FIELDS` 的中文标签作为表头别名，英文键照旧可用。

状态：解析中显示进度；服务端返回 422 `invalid_csv` 时仍按行显示；非编辑成员与匿名没有入口。

### 会话列表

页头「会话」，说明「企业微信里的客户会话（只读）。接管和回复在工作台里，工作台目前单独登录。」；右侧是「打开工作台」（`/admin.html`，新标签页打开）。

页签：全部 / AI 接待中 / 已转人工 / 已成交，各带数量 [100][101]。数量来自 `ConvQuery.state`，每个页签发一次 `limit=1` 请求取 `total`。映射规则：

- `paid`：`stage === 'paid'`；
- `human`：`handedOver && stage !== 'paid'`；
- `ai`：其余。

每行两行高，64px [98][99]：

- **左侧**：中性底的圆形，里面是渠道图标（企业微信 / 网页），带 `aria-label`。不加载企微头像 URL：CSP 没有放行第三方图片，头像也是客户数据。
- **第一行**：会话标签，如「企微客户 · 7F3A」「网页访客 · 2C9B」，字重 500。短码规则与 `admin.html` 的 `shortIdOf` 相同（抽成 `src/shared/format.ts` 的 `shortIdOf`），所以在工作台里能对上号。不显示昵称和目的地：这两项是客户画像，01 明确不投影（开放问题 8）。
- **第二行**：旅程刻度。开场、问需、推荐、报价、异议、促成、已支付，共 7 格细刻度（每格 6×3，间隔 2）：走过的格用次要色，没走到的格用分隔线色，当前格用石青，后面写阶段名。已转人工时，停在 `stageBeforeHandoff` 那一格，该格改用赭石并写「已转人工」；已成交时 7 格全是石绿。刻度只是辅助图形，信息由阶段名文字承担。
- **右侧**：
  - 接待状态 `StatusPill`：AI 接待中（中性 + `RobotOutlined`）、已转人工（赭石 + `CustomerServiceOutlined`）、已成交（石绿 + `CheckCircleOutlined`）；
  - 相对时间「12 分钟前」，悬停看绝对时间，超过 30 天改显示日期 [103][104]；
  - 最后一条消息是客户发的时，下面小字写「客户等了 25 分钟」[102]。
- **红色只在一种情况下出现**：已转人工、最后一条是客户发的、而且已经等了 ≥ 10 分钟。这时显示朱砂的「已转人工，客户等了 18 分钟」加图标。其余要跟进的情况用赭石。不画未读圆点：没有逐人的已读状态。
- **点击**：新标签页打开 `/admin.html#s=<id>`。
  - 工作台启动时读 hash，选中该会话（`admin.html` 的小改动）。
  - 工作台用的是 `ADMIN_PASS` 的独立登录，和后台账号是两套（02 才合并）。没登录时，工作台只看得到演示会话。
  - 所以 hash 在工作台的登录流程中要保留：登录框走完后，仍按 hash 选中。
- `sim-` 会话仍然不列出（01）。每页 20 条，分页器在底部。

状态：

- 加载：8 行骨架；
- 空：「客户的会话会出现在这里」+「客户在企业微信里发来第一句话后就会出现」；
- 页签无结果：「这个分类下没有会话」；
- 出错：就地重试；
- 匿名：没有入口（01）。

### 审计日志

页头「审计日志」，说明「谁在什么时候改了什么」。只有 owner、admin 看得到（01）。

筛选（写进 URL）：类别（全部、销售话术、产品库、账号与登录、平台与配置）+ 开关「显示登录记录」，默认关闭 [108][109]。类别和开关换算成 `AuditQuery.actions`，由服务端过滤，翻页不会出现空页。

用时间线，不用表格 [104][107]：

- 按天分组，组标题是「今天」「昨天」「9月24日 周三」。
- 每条：左侧是动作图标，落在 `RouteLine` 上；中间是一句人话，操作者和对象加粗；右侧是「14:02」，审计一律用绝对时间 [45]；下一行小字内联 1–3 个改动摘要，如「改了：行程亮点、住宿档次」。
- 系统和命令行的操作要和真人一眼区分开 [107]：真人用圆形的首字头像；系统用 `SettingOutlined`；命令行用 `CodeOutlined`，写「命令行 · 建账号」。
- 底部是「加载更早的记录」按钮，按 `before` 翻页；不做滚到底自动加载 [17]。
- 这一页没有失败类事件，不出现红色。

句子由 `console/src/audit-sentence.ts` 的 `describeAudit(entry, lookups)` 生成。动作的中文名、分组、图标名（字符串）放在 `src/shared/ui-labels.ts` 的 `AUDIT_ACTIONS` 里，console 再把图标名映射成组件 [105][106]：

| action                                                                      | 句子                                                                                                       | 数据来源                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `sop.publish`                                                               | 老板 发布了话术 v3，改了 2 节（话术原则、异议处理）；有 `rebasedFrom` 时加「（自动合并了期间别人的修改）」 | diff 的 `versionNo`、`changedKeys` → 节标题          |
| `sop.rollback`                                                              | 老板 把话术回滚到 v1 的内容，生成 v4                                                                       | diff 的 `targetVersionNo`、`toVersionNo`             |
| `sop.discard`                                                               | 老板 丢弃了话术草稿                                                                                        | —                                                    |
| `sop.rerender`                                                              | 系统 因代码里的规则变了，重新生成了话术 v5                                                                 | diff 里有原因就写上                                  |
| `catalog.create`                                                            | 老板 新建了线路草稿「成都一日游」                                                                          | diff 里 `title` / `name` 的新值                      |
| `catalog.update`                                                            | 老板 修改了线路「四川 稻城亚丁·色达秘境 8 日」的 行程亮点、住宿档次                                        | diff 的键 → 中文标签；名称查产品库缓存，查不到用编号 |
| `catalog.activate`                                                          | 老板 上架了线路「…」                                                                                       | 同上                                                 |
| `catalog.locked_fix`                                                        | 命令行 修正了线路「…」的锁定内容：{原因}                                                                   | diff                                                 |
| `auth.login` / `auth.logout`                                                | 老板 登录了后台 / 退出了后台                                                                               | —                                                    |
| `config.import`                                                             | 命令行 导入了初始配置                                                                                      | —                                                    |
| `platform.tenant_create`                                                    | 命令行 建了租户                                                                                            | —                                                    |
| `platform.user_create`                                                      | 命令行 为 a@x.com 建了账号（角色：管理员）                                                                 | diff 的 `email`、`role` → 中文                       |
| `platform.user_password` / `user_disable` / `member_role` / `member_remove` | 命令行 重置了 a@x.com 的密码 / 停用了 a@x.com / 把 a@x.com 的角色改为 管理员 / 把 a@x.com 移出了租户       | diff 里有的字段就写，没有就省略对象                  |

以后新增的 action 兜底为「{操作者} 执行了一项操作」，动作编码只放进技术详情。当前所有写审计的 action 都必须有模板，由自测保证（不变量 7）。

详情抽屉（480px）[110][108]：

- 句子、完整时间（`YYYY-MM-DD HH:mm:ss`）、操作者。
- 改动表「字段 · 原来 · 现在」：字段名用中文标签；金额写「42,800 元」；数组用「、」连接；长文本用 `SectionDiff` 的行内差异。
- 跳转：`sop.*` → 话术版本记录里的对应版本；`catalog.*` → 条目详情。
- `sop.rollback` 且 `sameHashAsTarget === false` 时，赭石说明「新版本和 v1 不完全相同：v1 之后代码里的固定规则变过，回滚只恢复可编辑节」。
- `catalog.locked_fix` 把原因放在第一行。
- 底部是折叠的「技术详情」：动作编码、对象类型与编号、JSON 原文和复制按钮。

状态：

- 加载：骨架；
- 空：「改动会记在这里」；
- 筛选无结果：「这个类别下没有记录」+「看全部」；
- 出错：就地重试。

## 文案与中文标签

标签只有一个来源：

- `src/shared/catalog-fields.ts`：产品库字段的标签、帮助、占位、单位、控件、分组、锁定组；`labelOfPath(kind, path)`，如「逐日行程 · 第 4 天 · 当天餐食」；`parseMeals` / `formatMeals`；`toFormData` / `fromFormData`。console 表单、字段报错、上架前检查、审计改动表、CSV 表头别名都用它。
- `src/shared/ui-labels.ts`：`VIOLATION_LABEL: Record<ViolationCode, string>`、`SOP_SOURCE_LABEL: Record<SopSource, string>`、`ROLE_LABEL: Record<Role, string>`、`STAGE_LABEL`、`CHANNEL_LABEL`、`AUDIT_ACTIONS`（图标只存名字字符串）、`ERROR_COPY`。一律用 `Record<联合类型, …>`，漏项在 typecheck 阶段就报错。`src/shared/` 只许 import zod 和本目录（`scripts/check-boundaries.ts`），所以这里不放 React 组件。
- `src/shared/format.ts`：
  - `formatYuan(n)` →「42,800 元」；`formatAmount(n)` →「42,800」，单位写在表头时用；
  - `formatRelative(iso, now)`、`formatDateTime(iso)`、`formatMonthRange(months)`；
  - `shortIdOf(id)`；
  - 全站不再出现「¥」。
- `src/shared/destination-marks.ts`：`DESTINATION_MARKS`。
- `src/shared/sop-sections.ts`：节表与正文、字数的纯计算。
- `console/src/brand.ts`：产品说明句、`SERIF_STRINGS`、`SEAL_LABELS`、`SERIF_DIGITS`。

界面只用下表左列的术语 [44]：

| 用                                                | 不用                                         |
| ------------------------------------------------- | -------------------------------------------- |
| 销售话术（正文首次出现时可写「销售话术（SOP）」） | 导航和标题里的 SOP                           |
| 线上 / 线上 v3                                    | 已发布版本、published                        |
| 草稿                                              | draft、rev                                   |
| 固定规则节                                        | 锁定节、镜像里的 data/sop.md                 |
| 字数额度                                          | 预算、budget                                 |
| 上架 / 上架后锁定                                 | active、activate                             |
| 线路编号 / 酒店编号                               | code、id                                     |
| 境内 / 境外                                       | overseas                                     |
| 密码                                              | 口令                                         |
| 系统导入 / 命令行                                 | import-config、user-create                   |
| 技术详情（折叠区）                                | 在其他地方出现的 prompt、hash、uuid、payload |

格式：

- 金额：「42,800 元起」；表头「每人起价（元）」配单元格「42,800」；输入框后缀「元/人」「元/晚」[46]。
- 时间：审计与版本记录用绝对时间「9月26日 14:02」（跨年时加年份）；列表和总览用相对时间，悬停给绝对时间 [45][103]。
- 数字用阿拉伯数字。中西文之间的间距交给 `text-autospace`，文案里不手打空格 [44][141]。
- 按钮写具体的动作：「上架，开始推荐」「丢弃草稿」「回滚到 v1」，不写「确定」「是」[36]。
- 标签和提示不加句号。少用「不能」「请勿」这种命令口吻，出错时写「无法……」[44]。

**服务端给用户看的文案**，同步改成中文字段名和「密码」，都是文案改动，不动行为：

- `src/shared/catalog.ts` 里 `RouteSchema` / `HotelSchema` 的报错：「id 只能是…」→「编号只能是…」；「要和 days（8）相同」→「要和天数（8）相同」；「第 1 项的 day 应为 1」→「第 1 天的天号应为 1」。前端校验和服务端 422 用的是同一套 schema，两边一起变。
- `PasswordBusyError`：「口令校验排队超时」→「密码校验排队超时」；登录失败：「邮箱或口令不对」→「邮箱或密码不对」。
- 现有的自测不断言这些字符串，改文案不需要改断言。

## 可访问性与响应式

- **对比度**：两套主题的文字 ≥ 4.5:1，控件边界与焦点环 ≥ 3:1，组件层的覆盖值也算在内（见「颜色」两表）[131][132]。只读值用正文色 [26]。
- **不只靠颜色**：状态都有文字和图标；差异用 +/− 和删除线；季节条有 `aria-label` [133][12]。
- **焦点**：`:focus-visible` 统一用 2px 外框，偏移 2px。颜色取 `--yt-focus`：浅色 #1F4F7F（对面 8.46），深色 #93B8E2（对面 8.05、对浮层 7.26）。antd 自带的焦点框取 `colorPrimaryBorder`，两套主题都显式设成同一个值 [134][174]。
- **键盘**：自绘组件（目录站点、表格名称链接、餐食片、上移下移）都能用键盘到达 [137]。Tab 顺序：页头操作 → 目录 → 编辑器 → 保存条。
- **拖动**：不用拖动操作；排序靠「上移 / 下移」按钮 [172]。
- **名称与角色**：CodeMirror 带 `aria-label`；钢印带视觉隐藏的「锁定：{类别}」；图标按钮带 `aria-label` [138]；每页都有 `document.title` [136]；页首有「跳到主要内容」链接；使用 `header`、`nav`、`main` 地标。
- **点击目标** ≥ 24×24 CSS px [139]。
- **动效**遵守 `prefers-reduced-motion` [140]。

断点（设计画布 1440，覆盖 1920 / 1440 / 1366 / 1280 [41]；由 `useViewport()` 统一判断，不依赖 antd 的 lg/xl）：

| 宽度      | 布局                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| ≥ 1440    | 页边距 32，侧栏展开                                                                                                |
| 1280–1439 | 页边距 24，侧栏展开                                                                                                |
| 992–1279  | 侧栏收成 64px 图标栏；SOP 目录变成下拉；详情副栏落到下方                                                           |
| < 992     | 侧栏隐藏，菜单按钮打开 Drawer；抽屉宽 `min(640px, 100vw)`                                                          |
| 375       | 总览和所有只读视图可用：页面不横向滚动（表格和目的地长卷内部可以横滚，表格首列固定）[135]；编辑流程只保证宽 ≥ 1024 |

## 性能

- **按路由拆包。** 代码式路由用 `createRoute(...).lazy(() => import('./pages/xxx.lazy'))` 拆出每一页 [149]。`@codemirror/*`、`@rjsf/*`、CSV 解析只进用到它们的页面 chunk。`/_specimen` 只在 `VITE_SPECIMEN=1` 时注册，生产构建里没有这个 chunk。
- **预算。** 扩展现有的 `scripts/check-console-dist.ts`（已经挂在 `pnpm test` 末尾，紧跟构建）。它读 Vite 的 `build.manifest` 来计算：
  - 打开总览需要的 JS（入口 + 其静态依赖 + 总览路由 chunk），gzip 后合计 ≤ 420,000 B（现在是 650,950 B）；
  - 任意一次站内导航额外下载的 JS，gzip ≤ 250,000 B；
  - 入口集合里没有 `@codemirror`、`@rjsf` 的模块；
  - manifest 里没有 specimen 的 chunk；
  - 宋体子集 ≤ 40,960 B；CSS 文件里没有 `url(data:`；
  - 跳过二进制文件（woff2）的文本扫描；
  - 删掉 `chunkSizeWarningLimit: 4096` 这个覆盖，由上面的预算把关。manifest 只列文件名，公开无害。
- **压缩。** `/console/assets/*` 的 JS、CSS 按 `Accept-Encoding` 返回 gzip（Hono `compress`）。`/api/console/*` 和 `index.html` 不压缩：响应里有 csrf，压缩再加上攻击者可控的输入，会让 BREACH 类攻击变得可行 [154]。woff2 本身已经压缩过，不再压。
- **字体。** 宋体 woff2 由 `index.html` 预加载 [170]，用 `font-display: swap` [171]；宋体只用于单行固定标题、印文和数字，行高固定，换字体不改变行框的高度。
- **不跳动。** 骨架与成品同尺寸；状态文字预留宽度；动效只用 opacity 和 transform。每页加载与主要状态切换的 CLS ≤ 0.1 [151]。
- **首屏。** 在本地 preview（CSP 与线上相同）上，用 Lighthouse 桌面预设测总览页，LCP ≤ 2.5 s [152]。
- 静态资源长缓存见开放问题 1。

## 接口改动

只改体验确实需要、前端又推不出来的地方。全部是新增成员或新增可选参数，01 的既有请求照旧有效。

```ts
// src/shared/console-api.ts

export interface Me {
  userId: string;
  displayName: string;
  role: Role;
  csrf: string;
  tenantSlug: string;
  /** 新增：tenants.name。页头显示正在管理哪个租户，多租户以后防止改错租户 */
  tenantName: string;
}

export interface ContractViolation {
  code: ViolationCode;
  sectionKey: string | null;
  /** 服务端原文，只在「技术详情」里显示；界面上的说明由前端按 code、sectionKey、match 生成 */
  detail: string;
  /** 新增：phrase_forbidden 是命中的短语或正则匹配文本；phrase_missing 是必需的那句原文（rule.text）；
   *  unknown_tool / unknown_field 是标识符；其余 code 没有。前端据此在编辑器里画下划线、选中、写说明 */
  match?: string;
}

export const SaveDraftBody = z.strictObject({
  basedOn: z.string().min(1).max(64),
  rev: z.number().int().nonnegative().nullable(),
  edits: z
    .array(z.strictObject({ key: z.string().min(1).max(64), body: z.string().max(100_000) }))
    .min(1)
    .max(32),
  /** 新增：把已有草稿的基线换成这个发布版本，用于合并冲突 */
  rebaseOnto: z.string().min(1).max(64).optional(),
});

export const ConvQuery = z.object({
  limit: intParam(100).optional(),
  offset: z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .optional(),
  /** 新增：接待状态。paid：stage === 'paid'；human：handedOver 且未成交；ai：其余 */
  state: z.enum(['ai', 'human', 'paid']).optional(),
});

export interface ConversationRow {
  id: string;
  channel: string;
  stage: string;
  handedOver: boolean;
  messageCount: number;
  updatedAt: string;
  /** 新增：转人工前的阶段；没转人工为 null */
  stageBeforeHandoff: string | null;
  /** 新增：最后一条 customer 或 agent 消息的时间与说话方（不算 system 消息），不含正文；没有消息为 null */
  lastMessageAt: string | null;
  lastSpeaker: 'customer' | 'agent' | null;
}

export const AuditQuery = z
  .object({
    limit: intParam(100).optional(),
    before: intParam(Number.MAX_SAFE_INTEGER).optional(),
    action: z.string().min(1).max(64).optional(),
    /** 新增：逗号分隔的 action 列表，至多 32 个，只返回其中的动作 */
    actions: z
      .string()
      .regex(/^[a-z_.]{1,64}(,[a-z_.]{1,64}){0,31}$/)
      .optional(),
  })
  .refine((q) => !(q.action && q.actions), { message: 'action 与 actions 只能给一个' });
```

语义：

- **`rebaseOnto`**：只对已有的草稿有效。
  - `rev` 为 null 却带了 `rebaseOnto` → 422 `invalid_sop`（「没有草稿，不需要合并」）。
  - `rebaseOnto` 不是当前发布版本的 id → 409 `rev_conflict`（「线上又有新版本，刷新后重来」）。
  - 服务端调用现有的 `rebase(base = 草稿的基线版本, cur = 当前发布版本, mine = 草稿)`。`conflicts` 里的每一节都必须出现在 `edits` 里，否则返回 409 `sop_conflict`：`keys` 是缺的节，`current` 是这些节的线上正文，形状和发布冲突相同。
  - 成功时：草稿的 `sections` = rebase 结果再应用 `edits`，`based_on` = `rebaseOnto`，`rev` 加 1；之后 `/draft/check` 的 `rebase.needed` 为 false。草稿保存本来就不记审计，这里也不记。
  - `sop_versions_guard_update` 允许改草稿的 `based_on`，不需要迁移。
- **`ConvQuery.state`**：服务端先过滤再分页，`total` 是过滤后的条数。
- **`ConversationRow` 的新字段**是会话状态和消息元数据（时间、说话方），不含正文，也不含客户画像；01 的「不带客户画像、不带消息正文」照旧成立。会话标签由前端用 `channel` 和 `shortIdOf(id)` 拼出来，不需要新字段。
- **`AuditQuery.actions`**：SQL 里用 `action = ANY($1)`，`nextBefore` 的语义不变；同时给了 `action` 和 `actions` 时返回 400 `bad_request`。

不改的东西（前端推得出来，或者现在不需要）：审计的对象名（从 diff 和产品库缓存拼）、总览的聚合接口（并发调现有接口）、草稿的最后保存人、工具名词表（见开放问题）、会话的昵称（开放问题 8）。

接口之外的服务端小改动：

- 契约检查 `checkSopContract` 在四类违规里填 `match`：`m[0]`、`rule.text`（`phrase_forbidden` 的纯文本规则和 `phrase_missing`）、标识符名。
- `/me` 带上 `tenantName`，取启动时已经装载的租户行。
- `src/shared/catalog.ts` 的 schema 报错改用中文字段名；`src/shared/catalog-csv.ts` 的表头接受中文标签作别名，导入时去掉本系统加的制表符前缀（见 CSV 导入）。
- `/console/assets/*` 的 gzip（见「性能」）。
- 登录失败和 `PasswordBusyError` 的文案：「口令」→「密码」。
- `public/admin.html`：启动时读 `location.hash` 的 `#s=<id>` 选中会话；登录流程中保留 hash。

与 01 的关系：本 spec 是对 01「后台 API 与页面」的增补，01 implemented 之后生效。01 的页面条款都保留能力，只换呈现：

- 「检查」「发布」「丢弃」三个动作都还在，「丢弃」进了「更多」菜单；
- 历史里的 `prompt_hash` 收进了技术详情；
- 产品库的编号降为名称下面的次行；
- 锁定字段仍然只读，并注明「有报价快照后开放」。

01 的验收 16（匿名 `/status` 只有 `mode`）、17、22 继续成立。01 implemented 之后，在 01 顶部加一行 `Amended by:` 指向本 spec，其余不动。

## 不变量

每条都能写成断言或测试。

视觉与文案：

1. `theme.ts` 两套主题里，`CONTRAST_PAIRS` 列出的每一对文字组合 ≥ 4.5:1，控件边框、焦点环、状态图形对其底色 ≥ 3:1。计算用 `theme.getDesignToken()` 的实际输出，加上 `antdTheme(mode).components` 里的组件值。`PRIMARY_FG_KEYS` 里的每个键在两套主题里都有值。brand.css 里两套 `--yt-*` 与 `PALETTE[mode].brand` 逐项相等。
2. 朱砂色只出现在这些地方：字段与表单报错、接口失败提示、契约违规、超出字数额度、409 冲突、`lock_lost`、转人工超时、`ConfirmDanger` 的确认按钮。`console/src` 里，`danger` 属性只出现在 `ConfirmDanger` 组件里，菜单项配置里没有 `danger: true`。
3. 每个操作区至多一个 `type="primary"` 按钮；主按钮从不带 `danger`；`ConfirmDanger` 里没有 primary 按钮。
4. `console/src` 里没有 `message.error(` 和 `notification.error(`。
5. 上架后锁定的字段和只读字段以正文色渲染成文本，不使用 `colorTextDisabled`。
6. `RouteSchema`、`HotelSchema` 转出的 JSON Schema 里，每个属性路径（含 `itinerary` 与 `intensity` 的子字段）在 `CATALOG_FIELDS` 里都有标签，并且标签含中文字符。
7. 源码里每个 `writeAudit({ action: '…' })` 的 action 都在 `AUDIT_ACTIONS` 里；`ViolationCode`、`SopSource`、`Role` 的每个值都有中文名。
8. 表单往返无损：对 `data/routes.json` 里的每一天，`formatMeals(parseMeals(meals)) === meals`；对每条线路 `p`，`fromFormData(getDefaultFormState(schema, toFormData(p)))` 与 `p` 深度相等，`diffPayload` 的 `set` 与 `unset` 都为空。
9. `console/src` 里没有「¥」；金额都经过 `formatYuan` / `formatAmount`。
10. `console/src` 里没有 `style.cssText`、`setAttribute('style'`；构建产物的 CSS 里没有 `url(data:`；运行时注入的 `<style>`（CodeMirror、antd）里也没有生效的 `url(data:`（第三方的 data: 背景都被覆盖成 `none`）。
11. `SERIF_STRINGS`、`SEAL_LABELS`、`DESTINATION_MARKS`、`SERIF_DIGITS` 的每个字符都在宋体子集的字符清单里。`yt-serif` 这个 class 只出现在 `console/src/brand/serif.tsx` 里；它导出的组件只接受 `SerifString` 类型（上述常量的字面量联合）和数字。
12. 默认状态下（技术详情未展开），页面可见的文字里没有这些东西：UUID；12 位及以上的十六进制串；以 `phrase_` 或 `unknown_` 开头的码；以 `sop.`、`catalog.`、`auth.`、`platform.` 开头的动作编码；「口令」「镜像」「days」「id 只能」。
13. `console/src` 里没有 `Radio.Button`、`<Badge count`，也没有带状态或预设色的 `Tag`（`color=` 只允许不写）；状态徽标都经过 `StatusPill`。
14. `console/src` 里读取服务端 `detail` 的地方只有 `TechDetails` 组件。

交互：

15. 编辑者有未保存的内容时（SOP 自动保存未完成或失败、产品库表单有改动），站内导航被拦下并弹出确认框，关页时有 beforeunload 提示。
16. SOP 自动保存的每个请求都带当前的 `rev`；收到 409 后不再自动重试。
17. 筛选、页签、选中的节都在 URL 里：用同一个 URL 刷新，页面状态相同。
18. 在每个路由下（含详情页深链），侧栏恰有一个选中项。
19. 每个路由的 `document.title` 以「 · 运营后台」结尾，并且各不相同（详情页含条目名）。
20. 成员身份下，任何一个响应被判为会话过期后，当前页不卸载，编辑中的内容不丢，匿名形状的数据不进缓存。

性能与安全：

21. 入口集合的 JS 不含 `@codemirror`、`@rjsf` 的模块；生产构建里没有 specimen chunk；预算数字见「性能」。
22. `/api/console/*` 和 `index.html` 的响应没有 `Content-Encoding`。
23. 匿名可见的响应和页面里没有任何成员姓名、草稿、变更说明（01 不变量 31 不变）；会话接口的响应里没有客户画像字段。
24. 产品库文本（包括预览）只以文本节点渲染；`console/src` 里没有 `dangerouslySetInnerHTML`。

## 验收标准

1. **对比度与主题自测。** `pnpm test` 包含 `console/src/theme.selftest.ts`，浅、深两套主题逐对计算，全部通过。以下三种改动都会让它失败并点名：
   - 把浅色的 `colorTextTertiary` 临时改成 `#8C8C8C`，失败并点名这一对；
   - 把深色的 `Tabs.itemSelectedColor` 改成 `#3E73AA`，失败并点名这个组件键；
   - 去掉包在算法外面的钉住层，失败并点名被改掉的种子色；
   - 把 brand.css 里任意一个 `--yt-*` 改掉，失败并点名这个变量。
2. **静态自测。** `pnpm test` 包含以下四个脚本：
   - `src/ui-meta.selftest.ts`：不变量 6、7；
   - `console/src/catalog-form.selftest.ts`：不变量 8，20 条线路逐一验证；
   - `console/src/theme.selftest.ts`：不变量 1，以及不变量 11 的字符覆盖；
   - `scripts/check-console-src.ts`：源码扫描，覆盖不变量 2、4、9、10（源码部分）、11（class 部分）、13、14、24。

   它们都不放在 `src/shared/` 里，所以不越过 `check-boundaries` 的边界。

3. **接口。** `console.selftest.ts` 新增以下用例，原有断言一条不改，01 验收 1 继续成立：
   - `/me` 带 `tenantName`。
   - 在「话术原则」里写进禁用短语，`/draft/check` 的对应违规带 `match`，且等于命中的文本；删掉一句必需说法，对应的 `phrase_missing` 带 `match`，且等于那句原文。
   - 冲突合并的完整路径：草稿改「话术原则」→ 回滚到一个「话术原则」不同的旧版本 → 发布返回 409 `sop_conflict`；带 `rebaseOnto` 和合并后的「话术原则」保存，返回 200，之后 check 的 `rebase.needed` 为 false，发布成功，线上正文等于合并结果。
   - 合并的三种失败：`rebaseOnto` 不是当前发布版本 → 409 `rev_conflict`；`edits` 缺冲突节 → 409 `sop_conflict`，且 `keys` 点名缺的节；没有草稿时带 `rebaseOnto` → 422。
   - `ConvQuery.state` 三个取值的 `total` 之和等于不带 `state` 时的 `total`，每页的行都满足对应条件；`ConversationRow` 的键里没有 `profile`、`nickname`、`destinationInterest`。
   - `AuditQuery.actions` 只返回列表里的动作，翻页不出空页；同时给 `action` 与 `actions` 返回 400。
   - 酒店 CSV 用中文表头导入，结果与用英文表头相同；带「制表符 + `=`」前缀的单元格导入后前缀被去掉。
   - 提交一条天数与逐日行程不符的线路，422 的报错里是「天数」，不是「days」。
4. **两套主题的走查。** 在本地真实 Postgres + preview（CSP 与线上相同，构建时带 `VITE_SPECIMEN=1`）上用 Playwright 走一遍，浅色、深色各一轮。截图存到 `docs/features/console-ux/walkthrough/{light,dark}/NN-名称.png`。
   - 至少包括这些状态：
     - 匿名：总览、话术（目录带钢印）、线路预览；
     - 登录页（含错误态）；成员总览（含一次模拟的 `lock_lost`）；
     - 话术：编辑与自动保存；检查出违规并点选定位；发布抽屉；冲突合并；版本记录与回滚确认；「更多」菜单展开；丢弃确认；
     - 产品库：线路列表（含筛选、筛选无结果）；新建线路（空表单）；已上架线路详情（锁定组）；已上架线路编辑态（出现保存条）；逐日行程时间轴；上架确认；酒店 CSV 预检（含 GBK 文件和坏行）；
     - 会话列表（含一行超时的红色）；审计时间线与详情抽屉；
     - 控件样张 `/_specimen`：Tabs、Pagination、Segmented、Radio、Checkbox、四种 `StatusPill`、四种 Alert、默认按钮悬停与焦点、ConfirmDanger；
     - 375px 下的总览与线路列表。
   - 走查全程的 `securitypolicyviolation` 事件 0 次、控制台错误 0 条；所有 `<style>` 的文本里没有生效的 `url(data:`。
   - 每个路由都断言三件事：`.ant-menu-item-selected` 恰好 1 个；`document.title` 以「 · 运营后台」结尾且各路由互不相同；页头操作区的 `.ant-btn-primary` 不超过 1 个。
   - demo 下另走一步：在话术页编辑时删掉会话 cookie，再继续编辑 → 弹出登录框、页面不跳成匿名、编辑内容还在；登录后刚才的保存被重放成功。
   - 走查脚本放在仓库外（与 01 验收 22 相同），结果记进 plan。
5. **对比度审计。** 上一条的每个截图状态，都用 axe-core 的 `color-contrast` 规则检查，两套主题都是 0 条违规。做审计的浏览器上下文可以开 `bypassCSP`；CSP 检查在不开的那一轮做。
6. **红色只给出错。**
   - 「算红」的判定，满足任一即可：计算后的 `color`、`background-color`、`border-*-color`、`outline-color`、`text-decoration-color`，或 `background-image` 里出现的颜色，属于该主题 `getDesignToken()` 实测的 `colorError*` 集合；或者色相落在 350°–20°、HSL 饱和度 > 40%。
   - 正常状态的截图里，没有任何元素「算红」。正常状态包括：总览一切正常、话术无问题、话术「更多」菜单展开、线路列表、新建线路（空表单）、已上架线路详情、已上架线路编辑态、审计、控件样张（不含 ConfirmDanger 那一块）。
   - 出错状态里有红：违规、冲突、CSV 坏行、超时会话、ConfirmDanger。
7. **不露机器码。** 走查的每个默认状态，页面可见文字都满足不变量 12。
8. **中文字段。** 新建线路页的所有字段标签都含中文，没有纯英文标签，没有红色星号，rjsf 的按钮文案都是中文。已上架线路的锁定字段是文本，计算后的颜色等于 `colorText`。
9. **话术编辑。**
   - 在「话术原则」里打字，3 秒内状态变成「已保存」，刷新后内容还在。
   - 断网后再打字，状态变红并提示重试；这时点侧栏的「线路」，弹出离开确认。恢复网络后，自动保存成功。
   - 只用 Tab、方向键、Enter、`⌘S`，能完成一次「改一节 → 发布」。
10. **违规定位。** 检查出 `phrase_forbidden` 后，点问题面板里的那一条，编辑器切到对应的节，并选中命中的文字；该文字有波浪下划线，且不触发 CSP 违规。目录上该节显示问题数。发布抽屉的「发布」按钮禁用，并写明原因。
11. **冲突合并（界面）。** 用验收 3 的场景在界面上走一遍：发布抽屉提示要合并 → 在合并模式里逐块「采用线上的写法」→ 完成合并 → 发布成功，版本记录出现新站点。整个过程中没有英文按钮。
12. **回滚。** 回滚确认框里有三句说明和差异。用 01 验收 8 的注入方式造出一个 rerender 版本，再回滚到它之前的版本，确认框在提交之前就显示「固定规则变过」的提示。
13. **产品库。**
    - 列表的筛选写进 URL，刷新后不变。
    - 线路详情是两栏布局，每个锁定组的印文钢印和原因只出现一次。
    - 上架确认框列出中文字段名和当前值，按钮是「上架，开始推荐」；已上架条目的保存按钮是「保存并立即生效」。
    - 把 20 条线路逐一打开、不做任何改动：保存条不出现，网络面板里没有 PATCH。加上不变量 8 的纯函数自测，01 验收 9「原样提交审计 diff 为空」在新界面上仍然成立。
    - 新建线路时不选「境内 / 境外」，点保存：字段下方报「境内还是境外：没选」，没有发出请求。
14. **逐日行程。** 餐食片的选择写回 `meals` 后，字符串符合规则。把草稿线路的天数从 3 改成 4：时间轴头部显示「还差 1 天」；点「上架…」不打开确认框，焦点跳到逐日行程。「上移 / 下移」能调整顺序，`day` 自动重排。
15. **CSV。**
    - 下载的模板用 Excel 双击打开，中文不乱码。
    - 用 Excel「CSV（逗号分隔）」在简体中文 Windows 上保存的文件，能正确预检（显示「按 GBK 读取」）。
    - 含坏行时，能「只导入合格的行」；下载的不合格行文件里，以「=」开头的单元格在引号内带制表符前缀，把它改好后重新导入，前缀不会进入数据。
    - 一份 250 行的文件，在前端就提示分份，不发请求。
16. **会话与审计。**
    - 会话行显示会话标签和旅程刻度，只有转人工超时的那一行是红色。
    - 用种子会话点一行，新标签页打开工作台并选中该会话；带 `ADMIN_PASS` 时，对真实会话再走一次：登录框走完后仍然选中。
    - 审计默认不显示登录记录，打开开关后显示；每条都是中文句子；详情抽屉的改动表字段名是中文。
17. **性能。** `pnpm test` 里的预算检查通过；Lighthouse 桌面预设下，总览的 LCP ≤ 2.5 s；走查中用 `PerformanceObserver` 记录每页加载和主要状态切换的 CLS，全部 ≤ 0.1；`/console/assets/*.js` 带 `Content-Encoding: gzip`，`/api/console/me` 不带。
18. **响应式与动效。**
    - 375px 下，总览和各只读页满足 `document.documentElement.scrollWidth <= innerWidth`。
    - 宽 1024–1279 时，侧栏是 64px 图标栏，SOP 目录变成下拉；宽 < 992 时侧栏隐藏。
    - 模拟 `prefers-reduced-motion: reduce` 时，签名组件计算后的 `transition-duration` 和 `animation-duration` 都是 0s。
19. **01 不回归。** 01 的验收 16、17、22 重新执行通过（22 在新界面上完成，`prompt_hash` 在技术详情里可见）；四个门禁全过。

## 开放问题

1. **静态资源长缓存。** `/console/assets/*` 的文件名带哈希，业界做法是 `max-age=31536000, immutable`，只有 HTML 用 no-store [153]。但 01 规定 `/console/*` 一律 `no-store`，改它就是修改 01，不是增补。拆包完成后测一次「第二次打开总览」的传输量；超过 200 KB 时，由 owner 决定是否另写一份小 spec 取代 01 的这一条。本 spec 的性能验收不依赖缓存。
2. **匿名演示显示租户名。** 这要让匿名 `/status` 多一个字段，与 01 验收 16「只有 mode」冲突。由 owner 决定；不做时，匿名页头显示字标和「演示」。
3. **产品名。** 页头现在用描述性的占位字标「AI 销售助手」，方章印文取「销」。要不要一个正式的产品名、叫什么，是品牌决定，由 owner 定（另记）。定了之后，改 `SERIF_STRINGS` 并重新生成字体子集，版面不用动。
4. **工具名胶囊与补全。** 要在正文里把 `search_routes` 等工具名显示成胶囊、输入时补全，需要 `SopOverview` 下发工具词表。等 `unknown_tool` / `unknown_field` 在后台累计拦下 5 次，或者 03 开始做 SOP 编辑器增强时，再定。
5. **审计的时间范围、操作者、对象筛选和导出。** 01 的数据量小，时间线加翻页够用。审计超过 2,000 行，或者 owner 需要对账留存时，另写 spec 加 `from`、`to`、`actor`、`targetId` 和导出 [110]；导出按 [113] 防公式注入，并记一条审计。
6. **「谁在改草稿」。** 显示「老板 10 分钟前在改」需要草稿记下最后保存人和时间，要加列和迁移。等第二个编辑者开始日常使用时再定。
7. **首屏预算能否达到。** 评审时用 rolldown 模拟外框加总览入口，约 305 KB gzip，所以 420,000 B 的预算预计够用。如果拆包后入口集合仍超出，并且超出部分来自 antd 本体，由 owner 在「放宽预算」和「试 antd 的 `zeroRuntime` 模式 [146]」之间选，决定记进 plan。
8. **会话列表显示客户昵称。** 运营认人靠昵称，但昵称和目的地是客户画像，01 明确不投影，而且会话列表对 viewer、agent 也可见。本 spec 是增补，不放宽这条边界，所以用「渠道 + 短码」。要显示昵称，是改变 01 的决定：由 owner 在「另立 spec 放宽投影（可按角色）」和「等 02 工作台合并进后台时一起做」之间选。

## 被否决的方案

- **方向 B「等高线图册」。** 黑色标题带和等高线辨识度高，也适合表现海拔。但近黑的主色在 antd 里派生出来的悬停、焦点色偏弱，要大量手工覆盖；户外探险的气质和「高端定制」的温润不合；SOP 长文阅读也得不到好处。只借了它的季节条。
- **方向 C「票根行程单」。** 票面层级适合订单和报价快照，但 SOP 页用不上，铺满全站会显得花哨；靛蓝主色离 antd 默认蓝和通用 SaaS 蓝太近，辨识度只能靠票面组件撑。留给 02 的报价快照再考虑。
- **「晨雾·靛青」通用精致 SaaS。** 风险最低，但和旅行业务没有关联，面试时讲不出设计理由。
- **保留上一稿的朱砂 `#B3261E`、石青 `#1B5A74`。** 前者就是 Material 3 基线的 error 原值 [161]，后者和 Tailwind cyan-800 的 ΔE 只有 3–4 [162]。懂行的人会读成「默认配色」，「和业务同源」的理由也就站不住了。
- **把纸色换成冷灰。** 冷灰（如 #F0F3F1）离 antd 默认的 #F5F5F5 只有 ΔE 1.8，等于退回出厂灰。纸色本来就不是差异的来源，保留暖纸；拆掉的是「米色 + 橙色点缀」这个组合 [160]。
- **深色主题用浅石青作 `colorPrimary`、主按钮配深色字（Material 式）。** Checkbox 勾号、Switch 滑块、Steps 序号、日期选中格等处，antd 直接在 `colorPrimary` 上画白色，而且没有 token 可改，要覆盖的清单比「前景色改用浅石青」更长、更难穷举。
- **运行时用 `setProperty` 写 `--yt-*`（上一稿的 `BrandVars`）。** MDN 只说明了直接给属性赋值不受 `style-src` 约束 [145]，没提 `setProperty`；而且这些值本来就是静态的。写进 brand.css 更简单，第一帧就有颜色，也不依赖 CSP 的推论。
- **换组件库（Arco、TDesign、MUI，或 shadcn/ui + Tailwind）。** ADR-002 已经选了 antd；rjsf 有 antd 主题，「表单由 schema 生成」的链路已经跑通。换库等于重写五页，换来的只是默认外观，而外观问题在 token 层和组件层就能解决。
- **引入 ProComponents（ProLayout、PageContainer）。** 能省下页头和布局代码 [3][7]，但多一个大依赖，版本还要跟着 antd 的大版本对齐。这里需要的只是一个页头组件和一个 Sider，自己写几十行就够。
- **全量自托管中文字体，或者用 Google Fonts。** 后者会被 CSP 拦下。前者一个字重就有 5–20 MB，按 unicode-range 切片后每页仍要下载几百 KB，而在 `no-store` 下每次都要重新下载。所以只做固定字符的子集。
- **朱红印章表示锁定或已发布。** 红色只给出错；蓝色印泥有丧事的含义 [124]。改用无色钢印。
- **SOP 手动保存加保存条。** 草稿本来就是沙盒，发布才是唯一的上线动作。n8n 在编辑后几秒内自动保存为草稿，并发靠单人编辑锁 [52]；Dify 的用户反映过，不带版本号的自动保存会覆盖别人的修改 [53]。本方案选「自动保存 + `rev` 乐观锁」，还能避免「忘了保存就离开」。产品库不同：已上架条目保存即生效，所以保留手动保存和明确的「保存并立即生效」。
- **n8n 式的单人编辑锁。** 需要在线状态、心跳和锁释放机制，还会把第二个编辑者挡在门外。01 已经有 `rev` 乐观锁，而两人同时改话术的情况很少；冲突时本 spec 给出了合并路径，比锁更省事。
- **发布环境、发布标签、A/B 分流** [55][72]。一个租户只有一条线上话术，运营不是工程师，多一层抽象只会让「发布」更难懂。保留「一个草稿 + 一个线上」，与 Dify、Zendesk、n8n 的做法一致 [51][52][57]。
- **继续在 720px 抽屉里编辑线路。** 20 多个字段加上嵌套的行程挤在抽屉里，没有 URL，也没有地方放状态和检查。酒店的字段少，也统一成详情页，少维护一套交互。
- **拖动排序。** antd 没有现成的可排序列表，要么引入拖放依赖（ADR-002 要求钉版本），要么手写；而且 WCAG 2.5.7 要求有单指针的替代方案 [172]。「上移 / 下移」按钮本身就满足要求，也够用。
- **上架按钮在必须项未过时禁用。** Carbon 主张长表单不禁用主按钮 [22]。改成点了之后跳到第一个没过的字段，效果更直接。
- **审计写入时存 `target_label` 快照列。** 符合「审计写入后不改」，但要迁移；现有的 diff 加产品库缓存，已经能拼出全部现有动作的对象名。将来新动作拼不出来时再加。
- **总览的聚合接口 `GET /overview`。** 现有的几个接口并发调用就够了；聚合接口还得单独处理匿名投影。
- **会话行显示企微头像。** CSP 没有放行第三方图片；为了一个展示细节放开 `img-src`，会扩大攻击面，不值得。
- **审计滚到底自动加载。** 找某一条记录是目标明确的任务，无限滚动会让人找不回位置 [17]。
- **会话未读圆点。** 没有逐人的已读状态，画出来就是假的。
- **前端用「丢弃 + 重建」代替 `rebaseOnto` 合并冲突。** 两个请求不是原子的，第二步失败的话草稿就没了；还会多一行 `sop.discard` 审计，歪曲实际发生的事。
- **把本 spec 放进 `docs/architecture/02-…`。** 02 的序号已经给了「会话入库 + 坐席工作台」；这是一份用户可见的功能 spec，按 `docs/spec-driven-dev.md` 的规定放在 `docs/features/`，开工时明确指定即可。
