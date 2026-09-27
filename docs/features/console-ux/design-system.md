# 运营后台设计系统（「利落」v4）

本文是 [spec.md](spec.md) 的视觉与内容细则：令牌、对比度、字体、组件、字段类型渲染器、行业包配置、逐页设计和文案。行为、接口、状态判定和验收以 spec.md 为准，视觉取值以本文为准；本文提到数据来源、轮询、判定函数这类行为时只是转述，两边不一致时照 spec 改本文。实现照本文写；改任何颜色取值都要重跑 §1.2 的对比度自测（spec 验收 1）。

- **内容**：信息架构、导航与权限、四种会话状态及判定、字段类型的行为、行业包结构、文案、可访问性。
- **视觉**：方案 A「利落」。冷锌灰中性色，侧栏与外框同底，内容放在一块内嵌白面板里，描边写进阴影，主按钮用墨色，租户主色只做指示。owner 2026-09-27 选定。
- **字体**：拉丁字母和数字用 Geist，等宽用 Geist Mono，中文用思源黑体 Noto Sans SC，三款都是 SIL OFL 1.1（§2）。§2 的结论都在 fonttools 和三个浏览器引擎上实测过。
- **owner 2026-09-27 的四项补充决定**，已写进对应章节：
  1. 整卡锁定、只有短值的卡片排成 4 列，列宽按内容自适应；E 页「基本信息」因此收成一行，逐日行程在一屏里露出来（§6.4、E 页）。
  2. 侧栏用户行放不下「名字 + 角色」时先藏角色，名字保持完整，角色留在 Tooltip 和用户菜单里；纯 CSS 实现（§4.2 第 5 项）。
  3. 会话工作台的列表把状态挪到第二行，标题独占第一行（J 页）。
  4. 补上「P · 字体与标点」验收页（§10.1、P 页），实现为只在走查构建里出现的样张页。「关于」文案里的「）；」同时改成「），」（§2.6）。
- **设计样张之后做的修正**（来自样张 QA 和接口核对；实现以本文为准）：
  - 工具条搜索框宽 320：300 放不下 D 页的占位文案（§5.2、§5.5）。D 页「更新」列宽 152（§10.2 D）。
  - 检查清单的头用卡片标题字阶 15/22/600，原稿 §5.17 写的 14/500 与 §2.3 矛盾（§5.17）。
  - 弹窗右上角有关闭按钮（§5.14）。
  - 差异里删除行行首的「−」改用 text-2（回滚弹窗的差异块里是两层 subtle 叠在 raised 上，深色 text-3 只有 3.88:1）；删除线粗 1.5px（§6.5）。
  - 话术正文里的 ✗ ✓ 不在 Noto Sans SC 里，编辑器用 lucide 图标显示，原文不变（§6.6）。
  - 行内的等宽元素左右各留 4px：`text-autospace` 不在中文和独立的等宽元素之间补间距（§2.5）。日期和时刻之间保留空格（§2.5）。
  - G 页「当晚住宿」是必填子字段（schema 要求），第 3 天空着时列为没过的必须项，不是建议项（§10.2 G）。
  - H 页：9 列放不进 832 宽，「酒店名称 · 编号」合成一列；「2,6OO」里的字母 O 加波浪下划线标出（§10.2 H）。
  - 接口里没有草稿的最后保存时间，也分不出产品库条目是「新建」还是「更新」：A 页、B 页相应的文字改了（§10.0 修正 8、9）。
  - 实体图标只能从一个固定集合里选，加行业包才不用改 console（§7）。
  - 行业包配置加了 `recommend`（建议项），见 §9。
  - 评审之后：必须项按 spec「校验」的口径计数，r-guizhou-5d 是 13 项，样张 A、F、G 上的「9/9」以本文为准（§10.0 修正 10）；审计句子不写「（CSV导入）」，接口分不出来源（§10.0）；N 页用真实哈希（§10.0 修正 7）；⌘K 不响应不带修饰键的 J / K（§5.18）；数组字段的「必填」与 `min`（§9）；「减少动态效果」开关的 CSS 写法（§1.5）。

## 0. 硬规则

1. **默认浅色。** 深色是个人偏好，要同等质量；「跟随系统」也只是一个选项。所有页面先按浅色设计、按浅色验收。
2. **约九成像素是中性色。** 主按钮用墨色 `--primary`（深色主题反相）。租户主色 `--accent` 只出现在以下地方：
   - 链接和文字按钮、焦点环
   - 复选框和开关的打开态、多选片的选中态、生效的筛选
   - 额度条里改过的段、「已改」标记、MonthStrip L 的选中段
   - 租户 logo 的兜底底色

   导航、页签、表格的选中都用中性色。**状态一律不用主色表达。**

3. **分层用半透明细线，写在 `box-shadow` 里，不写 `border`。** 内容放在一块内嵌面板里。卡片只给「真实对象」用：表单分组、编辑器、详情副栏、有序子项、KPI 格。阴影只给浮层（菜单、弹层、弹窗、抽屉）。页头吸顶条、保存条、发布条都不透明。
4. **没有常驻或循环的动效。** 高频操作的动画时长为 0：导航、页签、排序、筛选、⌘K、行悬停、主题切换。
5. **会话状态固定四种，互不重叠，全站用同一套词：AI 接待中 / 等人接手 / 顾问处理中 / 已成交。** 数字徽标只数「等人接手」。状态只用一个组件 `Status` 表达：圆点加文字，只有「等人接手」加底色（§5.6）。
6. **运营界面只画今天接口给得出的数据。** 需要 02 后端的画面单独成页，标题前缀写「02 后端到位后 · 」。产品界面里任何地方都不出现「示意」「演示数据」这类角标。
7. **工程信息只出现在平台管理员能看的「系统」页。** 包括模型、延迟、成本、评测、哈希、配置锁。哈希收进默认折叠的「技术详情」。
8. **界面代码不认行业。** 行业包只提供配置：实体类型和字段、销售阶段、话术节表、词汇、导航、实体图标名。界面按**字段类型**渲染，不按行业渲染。不做只属于旅游的部件：没有目的地字标、海拔剖面、客群×强度矩阵。
9. **红色只表示「出错了」或「要立刻处理」。** toast 只报成功，错误就地显示。
10. **不用：** emoji、玻璃、渐变、插画；常驻显示的键盘快捷键提示；11px 字；700 字重。
11. **字体只用 Geist、Geist Mono、思源黑体（Noto Sans SC）。** 根元素 `lang="zh-CN"`。中文不依赖系统字体，Windows 和 Mac 看到的是同一款字。

## 1. 颜色

### 1.1 令牌

四类取值原则：

- 中性色色度近零（锌灰，OKLCH C ≤ 0.005），不带青蓝色调。
- 装饰性分隔全部用黑或白的半透明色，叠在任何底上都成立。
- 可交互控件的边界（输入框、选择框、复选框、开关）单独用不透明的 `--control-border`，保证 ≥3:1。
- 语义色沿用上一版验过的值，只把 neutral 换成锌灰，另给每个语义色补一个亮一些的圆点色。

| 令牌                               | 浅色                              | 深色                                | 用途                                                        |
| ---------------------------------- | --------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `--frame`                          | `#F6F6F7`                         | `#09090B`                           | 侧栏和外框底（比面板暗一档）                                |
| `--panel`                          | `#FFFFFF`                         | `#121214`                           | 内容面板、卡片、表格、输入框底                              |
| `--raised`                         | `#FFFFFF`                         | `#1B1B1E`                           | 浮层：菜单、弹层、抽屉、弹窗                                |
| `--thumb`                          | `#FFFFFF`                         | `#2A2A2E`                           | 分段控件的选中滑块                                          |
| `--hover`                          | `rgba(9,9,11,.04)`                | `rgba(255,255,255,.05)`             | 行、导航、幽灵按钮悬停                                      |
| `--selected`                       | `rgba(9,9,11,.06)`                | `rgba(255,255,255,.08)`             | 导航选中、表格选中行、⌘K 当前项                             |
| `--subtle`                         | `rgba(9,9,11,.05)`                | `rgba(255,255,255,.06)`             | Tag 底、代码芯片、分段轨道、骨架、禁用底                    |
| `--pressed`                        | `rgba(9,9,11,.08)`                | `rgba(255,255,255,.10)`             | 按下                                                        |
| `--border`                         | `rgba(9,9,11,.08)`                | `rgba(255,255,255,.08)`             | 表头下线、面板/卡片描边（写在阴影里）                       |
| `--divider`                        | `rgba(9,9,11,.06)`                | `rgba(255,255,255,.06)`             | 行分隔、页签下线、弹窗底栏上线                              |
| `--btn-border`                     | `rgba(9,9,11,.12)`                | `rgba(255,255,255,.12)`             | 次要按钮描边（带文字的按钮不要求 3:1）                      |
| `--control-border`                 | `#88888F`                         | `#71717A`                           | 输入框、选择框、复选框、开关关闭态（≥3:1）                  |
| `--text`                           | `#18181B`                         | `#EDEDEF`                           | 正文、标题、值                                              |
| `--text-2`                         | `#4D4D55`                         | `#A8A8B1`                           | 次要文字：状态句、帮助、表格次要列、状态标签                |
| `--text-3`                         | `#63636B`                         | `#91919A`                           | 第三级：表头、计数、时间、占位符、编号（仍 ≥4.5）           |
| `--primary` / `-hover` / `-active` | `#18181B` / `#2E2E33` / `#3F3F46` | `#EDEDEF` / `#D4D4D8` / `#BDBDC4`   | 主按钮底（墨色，深色主题反相）                              |
| `--on-primary`                     | `#FFFFFF`                         | `#121214`                           | 主按钮字                                                    |
| `--accent`                         | `#2B63E6`                         | `#2F68EB`                           | 选中指示、复选/开关打开、额度条改过的段、租户 logo 兜底底色 |
| `--on-accent`                      | `#FFFFFF`                         | `#FFFFFF`                           | accent 上的勾、字                                           |
| `--accent-text`                    | `#255CDF`                         | `#75A2FF`                           | 链接、「已改」、筛选生效后的字                              |
| `--accent-bg`                      | `#EDF3FE`                         | `#15274D`                           | 多选片选中底、生效筛选底、新增文字高亮、MonthStrip L 选中段 |
| `--focus`                          | `#2B63E6`                         | `#2F68EB`                           | 焦点环                                                      |
| `--accent-ring`                    | `rgba(43,99,230,.20)`             | `rgba(47,104,235,.35)`              | 输入框聚焦时的 3px 光晕（装饰）                             |
| `--success` / `-bg` / `-dot`       | `#1D7A3D` / `#E8F5EC` / `#1E9E57` | `#6FCF8C` / `#10281A` / `#4CC274`   | 已上架、已成交、线上、检查通过                              |
| `--warning` / `-bg` / `-icon`      | `#8A5700` / `#FFF3DC` / `#B86E00` | `#F0B355` / `#2E2008` / `#F0B355`   | 等人接手、需要留意、额度 ≥95%（`-icon` 兼作圆点）           |
| `--danger` / `-bg` / `-dot`        | `#B42318` / `#FDEDEB` / `#DC3A2F` | `#FF9B8F` / `#3A1714` / `#FF6B5E`   | 出错、检查不通过、等待 >10 分钟（02）                       |
| `--danger-ring`                    | `rgba(180,35,24,.18)`             | `rgba(255,155,143,.25)`             | 出错输入框的光晕                                            |
| `--info` / `-bg` / `-dot`          | `#35598F` / `#EDF2F9` / `#3F72C8` | `#9DB8E6` / `#18233A` / `#7FA3E8`   | 顾问处理中、只读说明、演示横幅                              |
| `--neutral` / `-bg` / `-dot`       | `#4D4D55` / `#F1F1F2` / `#8A8A93` | `#A8A8B1` / `#27272A` / `#71717A`   | AI 接待中、草稿、只读                                       |
| `--badge` / `--on-badge`           | `#F2A516` / `#18181B`             | 同左                                | 只用于叠在铃铛上的实心数字徽标                              |
| `--month-on` / `--month-off`       | `#7C7C85` / `rgba(9,9,11,.08)`    | `#8E8E97` / `rgba(255,255,255,.10)` | MonthStrip S                                                |
| `--bar`                            | `#A1A1AA`                         | `#52525B`                           | 会话阶段条（旁边一定写数字）                                |
| `--quota-off`                      | `#8A8A93`                         | `#71717A`                           | 额度条里没改的段                                            |
| `--toast-icon`                     | `#4CC274`                         | `#1D7A3D`                           | 反相 toast 上的成功图标                                     |
| `--mask`                           | `rgba(9,9,11,.40)`                | `rgba(0,0,0,.60)`                   | 抽屉、弹窗遮罩                                              |
| `--av1…6-bg` / `-fg`               | 见 §1.5                           | 见 §1.5                             | 头像 6 色（按名字确定性取色）                               |

阴影（描边一律写在阴影里，不用 `border`，避免 1px 挤动布局）：

| 令牌             | 浅色                                                                                                  | 深色                                                                 | 用途                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `--ring`         | `0 0 0 1px rgba(9,9,11,.08)`                                                                          | `0 0 0 1px rgba(255,255,255,.08)`                                    | 纯描边：KPI 格、图标块                                                 |
| `--shadow-panel` | `0 0 0 1px rgba(9,9,11,.06), 0 1px 2px rgba(9,9,11,.04)`                                              | `0 0 0 1px rgba(255,255,255,.06)`                                    | 内嵌内容面板                                                           |
| `--shadow-card`  | `0 0 0 1px rgba(9,9,11,.08), 0 1px 2px rgba(9,9,11,.04)`                                              | `0 0 0 1px rgba(255,255,255,.08)`                                    | 卡片                                                                   |
| `--shadow-btn`   | `0 0 0 1px rgba(9,9,11,.12), 0 1px 2px rgba(9,9,11,.05)`                                              | `0 0 0 1px rgba(255,255,255,.12)`                                    | 次要按钮、侧栏搜索触发器、筛选按钮                                     |
| `--shadow-thumb` | `0 0 0 1px rgba(9,9,11,.08), 0 1px 2px rgba(9,9,11,.08)`                                              | `0 0 0 1px rgba(255,255,255,.10), 0 1px 2px rgba(0,0,0,.4)`          | 开关滑块。分段控件的选中段改用 `--control-border` 描边（§5.4），不用它 |
| `--shadow-menu`  | ring + `0 1px 1px rgba(0,0,0,.02), 0 4px 8px -4px rgba(0,0,0,.05), 0 16px 24px -8px rgba(0,0,0,.08)`  | `0 0 0 1px rgba(255,255,255,.10), 0 8px 24px rgba(0,0,0,.50)`        | 下拉、Popover、铃铛弹层、toast                                         |
| `--shadow-modal` | ring + `0 1px 1px rgba(0,0,0,.02), 0 8px 16px -4px rgba(0,0,0,.05), 0 24px 40px -8px rgba(0,0,0,.12)` | `0 0 0 1px rgba(255,255,255,.10), 0 24px 48px -12px rgba(0,0,0,.65)` | 弹窗、抽屉、⌘K                                                         |

深色靠「更亮的底 + 白色半透明描边」分层：frame `#09090B` → panel `#121214` → raised `#1B1B1E` → thumb `#2A2A2E`。

### 1.2 对比度（WCAG 2.x）

alpha 色先叠到它所在的底上再算：hover 叠 panel；selected 分别叠 frame（导航）和 panel（表格行）；subtle 叠 panel。`control-border` 只在它会出现的底上检查，输入框不放在 frame、选中导航和 accent-bg 上。要求：文字 4.5，控件边界与焦点 3。**全部通过。** 改任何值都要重跑对比度自测（spec 验收 1）；渲染后的页面另有实测（spec 验收 2）。

#### 浅色

| 前景 ＼ 底               | panel `#FFFFFF` | frame `#F6F6F7` | hover `#F5F5F5` | selected·frame `#E8E8E9` | selected·panel `#F0F0F0` | subtle `#F3F3F3` | accent-bg `#EDF3FE` | 要求 |
| ------------------------ | --------------- | --------------- | --------------- | ------------------------ | ------------------------ | ---------------- | ------------------- | ---- |
| text `#18181B`           | 17.72           | 16.40           | 16.25           | 14.47                    | 15.55                    | 15.97            | 15.90               | 4.5  |
| text-2 `#4D4D55`         | 8.37            | 7.75            | 7.68            | 6.84                     | 7.35                     | 7.55             | 7.52                | 4.5  |
| text-3 `#63636B`         | 5.95            | 5.51            | 5.46            | 4.86                     | 5.22                     | 5.36             | 5.34                | 4.5  |
| accent-text `#255CDF`    | 5.71            | 5.29            | 5.24            | 4.67                     | 5.01                     | 5.15             | 5.13                | 4.5  |
| control-border `#88888F` | 3.52            | —               | 3.23            | —                        | 3.09                     | 3.17             | —                   | 3    |
| focus `#2B63E6`          | 5.21            | 4.82            | 4.78            | 4.26                     | 4.57                     | 4.70             | 4.68                | 3    |

| 语义    | 字 / 底 / 点                      | 字对 panel / frame | 字对自己的底 | text-2 对底 | 点对 panel / 底 |
| ------- | --------------------------------- | ------------------ | ------------ | ----------- | --------------- |
| success | `#1D7A3D` / `#E8F5EC` / `#1E9E57` | 5.38 / 4.98        | 4.79         | 7.46        | 3.45 / 3.07     |
| warning | `#8A5700` / `#FFF3DC` / `#B86E00` | 6.10 / 5.65        | 5.55         | 7.62        | 3.99 / 3.63     |
| danger  | `#B42318` / `#FDEDEB` / `#DC3A2F` | 6.57 / 6.09        | 5.79         | 7.37        | 4.48 / 3.94     |
| info    | `#35598F` / `#EDF2F9` / `#3F72C8` | 7.05 / 6.53        | 6.27         | 7.44        | 4.72 / 4.19     |
| neutral | `#4D4D55` / `#F1F1F2` / `#8A8A93` | 8.37 / 7.75        | 7.42         | 7.42        | 3.42 / 3.03     |

- on-primary `#FFFFFF` 对 primary / hover / active：17.72 / 13.51 / 10.44
- on-accent `#FFFFFF` 对 accent `#2B63E6`：5.21（复选框勾、开关，需 ≥3）；accent 对 panel 5.21
- on-badge 对 badge：8.58
- month-on 对 month-off（叠在 panel 上为 `#EBEBEB`）：3.47；对 panel 4.13
- warning-icon 对 panel / warning-bg：3.99 / 3.63
- 头像 6 色（字对底）最低 6.06

#### 深色

| 前景 ＼ 底               | panel `#121214` | frame `#09090B` | raised `#1B1B1E` | hover `#1E1E20` | selected·frame `#1D1D1F` | selected·panel `#252527` | hover·raised `#262629` | subtle `#202022` | accent-bg `#15274D` | 要求 |
| ------------------------ | --------------- | --------------- | ---------------- | --------------- | ------------------------ | ------------------------ | ---------------------- | ---------------- | ------------------- | ---- |
| text `#EDEDEF`           | 16.00           | 17.02           | 14.70            | 14.23           | 14.39                    | 13.09                    | 12.91                  | 13.91            | 12.57               | 4.5  |
| text-2 `#A8A8B1`         | 7.93            | 8.43            | 7.28             | 7.05            | 7.13                     | 6.48                     | 6.40                   | 6.89             | 6.23                | 4.5  |
| text-3 `#91919A`         | 5.99            | 6.37            | 5.50             | 5.33            | 5.39                     | 4.90                     | 4.83                   | 5.21             | 4.70                | 4.5  |
| accent-text `#75A2FF`    | 7.46            | 7.93            | 6.85             | 6.63            | 6.71                     | 6.10                     | 6.01                   | 6.48             | 5.86                | 4.5  |
| control-border `#71717A` | 3.87            | —               | 3.56             | 3.44            | —                        | 3.17                     | 3.12                   | 3.37             | —                   | 3    |
| focus `#2F68EB`          | 3.83            | 4.07            | 3.52             | 3.41            | 3.45                     | 3.13                     | 3.09                   | 3.33             | 3.01                | 3    |

| 语义    | 字 / 底 / 点                      | 字对 panel / frame / raised | 字对自己的底 | text-2 对底 | 点对 panel / 底 |
| ------- | --------------------------------- | --------------------------- | ------------ | ----------- | --------------- |
| success | `#6FCF8C` / `#10281A` / `#4CC274` | 9.78 / 10.40 / 8.98         | 8.19         | 6.64        | 8.27 / 6.92     |
| warning | `#F0B355` / `#2E2008` / `#F0B355` | 10.05 / 10.69 / 9.23        | 8.51         | 6.71        | 10.05 / 8.51    |
| danger  | `#FF9B8F` / `#3A1714` / `#FF6B5E` | 9.21 / 9.79 / 8.46          | 7.88         | 6.78        | 6.70 / 5.73     |
| info    | `#9DB8E6` / `#18233A` / `#7FA3E8` | 9.30 / 9.88 / 8.54          | 7.78         | 6.64        | 7.40 / 6.20     |
| neutral | `#A8A8B1` / `#27272A` / `#71717A` | 7.93 / 8.43 / 7.28          | 6.31         | 6.31        | 3.87 / 3.08     |

- on-primary `#121214` 对 primary / hover / active：16.00 / 12.66 / 10.01
- on-accent `#FFFFFF` 对 accent `#2F68EB`：4.88（复选框勾、开关，需 ≥3）；accent 对 panel 3.83
- on-badge 对 badge：8.58
- month-on 对 month-off（叠在 panel 上为 `#2A2A2C`）：4.41；对 panel 5.76
- warning-icon 对 panel / warning-bg：10.05 / 8.51
- 头像 6 色（字对底）最低 7.99

本版新增的用法都落在上表已验过的配对里：

- 总览待办行的图标块：text-2 在 subtle 上。
- KPI 格的明细行：text-2 在 panel 上。
- 时间线的时间：text-3 在 panel 上。

嵌套的底：回滚弹窗里的差异块是 `--subtle` 底，删除行再叠一层 `--subtle`，两层都叠在 raised 上。浅色这个底是 `#E7E7E7`：text 14.33、text-2 6.77、text-3 4.82；深色是 `#363638`：text 10.38、text-2 5.14、text-3 3.88。所以这里不用 text-3，删除行的字和「−」用 text-2（§6.5）。对比度自测把「text-2 在 subtle·subtle·raised 上」列为一对。

另外两处按 1.4.11 处理：

- 分段控件的选中段、收起侧栏的当前项：只靠底色时只有 1.1–1.2:1，所以外加 `0 0 0 1px var(--control-border)`（浅 3.09–3.5，深 3.12–4.1）。
- 阶段条旁边一定写数字，条本身不承担信息，不要求 3:1。

### 1.3 租户主色生成器

主色不做按钮底，所以生成器不再为白字压暗品牌色，只保证「当指示色够亮、当文字够深」。在 OKLCH 里只调 L，H 不变，色度 C 取 min(C, 0.23)，出色域时降 C。

1. `accent`（浅）：从品牌色的 L 开始，每步 −0.005，直到对 panel ≥3:1 且白色勾对它 ≥3:1。`on-accent` = 白字对 accent ≥4.5 时用白，否则用 `#18181B`。
2. `accent-bg`：浅 L 0.962、C = min(C, 0.035)；深 L 0.28、C = min(C, 0.075)。
3. `accent-text`：浅从 min(accent 的 L, 0.60) 往下降，直到在 panel、frame、hover、selected（叠 frame 与叠 panel）、accent-bg 上都 ≥4.6（留 0.1 余量）；深从 max(L, 0.72) 往上升，直到在深色所有底（含 raised、hover·raised）和深色 accent-bg 上都 ≥4.6。
4. `focus`：浅用 accent，若在 panel、frame、selected·frame、accent-bg 上 <3 就再降 L；深色的 `accent` 与 `focus` 同值：从 accent 往上升 L，直到在 panel、frame、raised、两种 selected、hover·raised、深色 accent-bg 上都 ≥3。深色 `on-accent` 在白字对它 ≥3 时用白（勾是图形，要求 3），否则用 `#121214`。
5. `accent-ring` = accent 的 20%（深色用深色 accent 的 35%）。
6. 撞色提醒：品牌色 C > 0.08，且色相与 danger 29.5° / warning 70.5° / success 150.2° 中任一个相差不到 20° 时，品牌设置页提示「这个颜色接近『出错 / 留意 / 成功』的颜色，链接和选中标记可能被看成状态」。可以坚持使用：状态本身靠圆点加文字区分，不会因此出错。
7. 中性色不随租户变。生成器的单元测试跑 1.2 的全部配对。

生成器随「租户品牌色」一起实现（spec「依赖 02 的后端」第 10 项）；在那之前，全部租户用默认主色。

验算过的例子：

| 输入                           | accent 浅 / 深        | on-accent 浅 / 深     | accent-text 浅 / 深                 | accent-bg 浅 / 深     | focus 浅 / 深                       | 撞色提醒 |
| ------------------------------ | --------------------- | --------------------- | ----------------------------------- | --------------------- | ----------------------------------- | -------- |
| 默认 · 云途蓝 `#2B63E6`        | `#2B63E6` / `#2F68EB` | `#FFFFFF` / `#FFFFFF` | `#255CDF` (4.67) / `#75A2FF` (5.86) | `#EDF3FE` / `#15274D` | `#2B63E6` (4.26) / `#2F68EB` (3.01) | —        |
| 旧云途蓝 `#077CAD`             | `#077CAD` / `#077CAD` | `#FFFFFF` / `#FFFFFF` | `#006E9B` (4.63) / `#51B0E3` (5.96) | `#E6F5FF` / `#012D42` | `#077CAD` (3.82) / `#077CAD` (3.09) | —        |
| 松间整装（L 页） `#1F6F78`     | `#1F6F78` / `#317E87` | `#FFFFFF` / `#FFFFFF` | `#1F6F78` (4.76) / `#68B2BC` (5.96) | `#D8FAFE` / `#012F34` | `#1F6F78` (4.76) / `#317E87` (3.06) | —        |
| 浅橙（验证深字分支） `#F08A24` | `#DE7B01` / `#DE7B02` | `#18181B` / `#FFFFFF` | `#9B5402` (4.68) / `#ED871F` (5.72) | `#FFEFE4` / `#401F00` | `#C96E02` (3.0) / `#DE7B02` (4.91)  | warning  |

括号里是该色在要求的所有底色上的最低对比度。

### 1.4 用色规则

- 主色出现的地方只限 §0 第 2 条列出的那些。
- 红色只表示出错或要立刻处理；toast 只报成功。
- 文字只放在 1.2 表里列过的底上。语义文字可以放在 panel、frame、raised 和自己的 `-bg` 上。
- 圆点色 `-dot` 只做圆点、图标和小图形，不做文字。
- 差异视图里删除不用红色（§6.5）。

### 1.5 令牌的 CSS 形态

`console/src/theme/brand.css` 照下面写；antd 的令牌映射见 §8。深色主题在 `<html>` 上加 `data-theme="dark"`。

```css
:root {
  /* surfaces */
  --frame: #f6f6f7;
  --panel: #ffffff;
  --raised: #ffffff;
  --thumb: #ffffff;
  /* alpha fills */
  --hover: rgba(9, 9, 11, 0.04);
  --selected: rgba(9, 9, 11, 0.06);
  --subtle: rgba(9, 9, 11, 0.05);
  --pressed: rgba(9, 9, 11, 0.08);
  /* lines */
  --border: rgba(9, 9, 11, 0.08);
  --divider: rgba(9, 9, 11, 0.06);
  --btn-border: rgba(9, 9, 11, 0.12);
  --control-border: #88888f;
  /* text */
  --text: #18181b;
  --text-2: #4d4d55;
  --text-3: #63636b;
  /* primary button */
  --primary: #18181b;
  --primary-hover: #2e2e33;
  --primary-active: #3f3f46;
  --on-primary: #ffffff;
  /* accent (tenant) */
  --accent: #2b63e6;
  --on-accent: #ffffff;
  --accent-text: #255cdf;
  --accent-bg: #edf3fe;
  --focus: #2b63e6;
  --accent-ring: rgba(43, 99, 230, 0.2);
  /* semantic */
  --success: #1d7a3d;
  --success-bg: #e8f5ec;
  --success-dot: #1e9e57;
  --warning: #8a5700;
  --warning-bg: #fff3dc;
  --warning-icon: #b86e00;
  --danger: #b42318;
  --danger-bg: #fdedeb;
  --danger-dot: #dc3a2f;
  --danger-ring: rgba(180, 35, 24, 0.18);
  --info: #35598f;
  --info-bg: #edf2f9;
  --info-dot: #3f72c8;
  --neutral: #4d4d55;
  --neutral-bg: #f1f1f2;
  --neutral-dot: #8a8a93;
  /* badge / viz / misc */
  --badge: #f2a516;
  --on-badge: #18181b;
  --month-on: #7c7c85;
  --month-off: rgba(9, 9, 11, 0.08);
  --bar: #a1a1aa;
  --quota-off: #8a8a93;
  --toast-icon: #4cc274;
  --mask: rgba(9, 9, 11, 0.4);
  /* shadows */
  --ring: 0 0 0 1px rgba(9, 9, 11, 0.08);
  --shadow-panel: 0 0 0 1px rgba(9, 9, 11, 0.06), 0 1px 2px rgba(9, 9, 11, 0.04);
  --shadow-card: 0 0 0 1px rgba(9, 9, 11, 0.08), 0 1px 2px rgba(9, 9, 11, 0.04);
  --shadow-btn: 0 0 0 1px rgba(9, 9, 11, 0.12), 0 1px 2px rgba(9, 9, 11, 0.05);
  --shadow-pill: none;
  --shadow-thumb: 0 0 0 1px rgba(9, 9, 11, 0.08), 0 1px 2px rgba(9, 9, 11, 0.08);
  --shadow-menu:
    0 0 0 1px rgba(9, 9, 11, 0.08), 0 1px 1px rgba(0, 0, 0, 0.02), 0 4px 8px -4px rgba(0, 0, 0, 0.05), 0 16px 24px -8px rgba(0, 0, 0, 0.08);
  --shadow-modal:
    0 0 0 1px rgba(9, 9, 11, 0.08), 0 1px 1px rgba(0, 0, 0, 0.02), 0 8px 16px -4px rgba(0, 0, 0, 0.05), 0 24px 40px -8px rgba(0, 0, 0, 0.12);
  /* avatars */
  --av1-bg: #ffe4e1;
  --av1-fg: #803f3b;
  --av2-bg: #f6ead1;
  --av2-fg: #6c5005;
  --av3-bg: #ddf2dd;
  --av3-fg: #326234;
  --av4-bg: #d1f3f4;
  --av4-fg: #026266;
  --av5-bg: #dfedff;
  --av5-fg: #305686;
  --av6-bg: #f2e5fd;
  --av6-fg: #65467a;
  --r-xs: 4px;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 10px;
  --r-xl: 12px;
  --r-full: 999px;
  --font: 'Geist', 'Noto Sans SC', system-ui, sans-serif;
  --mono: 'Geist Mono', 'Noto Sans SC', ui-monospace, Menlo, Consolas, monospace;
}
:root[data-theme='dark'] {
  /* surfaces */
  --frame: #09090b;
  --panel: #121214;
  --raised: #1b1b1e;
  --thumb: #2a2a2e;
  /* alpha fills */
  --hover: rgba(255, 255, 255, 0.05);
  --selected: rgba(255, 255, 255, 0.08);
  --subtle: rgba(255, 255, 255, 0.06);
  --pressed: rgba(255, 255, 255, 0.1);
  /* lines */
  --border: rgba(255, 255, 255, 0.08);
  --divider: rgba(255, 255, 255, 0.06);
  --btn-border: rgba(255, 255, 255, 0.12);
  --control-border: #71717a;
  /* text */
  --text: #ededef;
  --text-2: #a8a8b1;
  --text-3: #91919a;
  /* primary button */
  --primary: #ededef;
  --primary-hover: #d4d4d8;
  --primary-active: #bdbdc4;
  --on-primary: #121214;
  /* accent (tenant) */
  --accent: #2f68eb;
  --on-accent: #ffffff;
  --accent-text: #75a2ff;
  --accent-bg: #15274d;
  --focus: #2f68eb;
  --accent-ring: rgba(47, 104, 235, 0.35);
  /* semantic */
  --success: #6fcf8c;
  --success-bg: #10281a;
  --success-dot: #4cc274;
  --warning: #f0b355;
  --warning-bg: #2e2008;
  --warning-icon: #f0b355;
  --danger: #ff9b8f;
  --danger-bg: #3a1714;
  --danger-dot: #ff6b5e;
  --danger-ring: rgba(255, 155, 143, 0.25);
  --info: #9db8e6;
  --info-bg: #18233a;
  --info-dot: #7fa3e8;
  --neutral: #a8a8b1;
  --neutral-bg: #27272a;
  --neutral-dot: #71717a;
  /* badge / viz / misc */
  --badge: #f2a516;
  --on-badge: #18181b;
  --month-on: #8e8e97;
  --month-off: rgba(255, 255, 255, 0.1);
  --bar: #52525b;
  --quota-off: #71717a;
  --toast-icon: #1d7a3d;
  --mask: rgba(0, 0, 0, 0.6);
  /* shadows */
  --ring: 0 0 0 1px rgba(255, 255, 255, 0.08);
  --shadow-panel: 0 0 0 1px rgba(255, 255, 255, 0.06);
  --shadow-card: 0 0 0 1px rgba(255, 255, 255, 0.08);
  --shadow-btn: 0 0 0 1px rgba(255, 255, 255, 0.12);
  --shadow-pill: none;
  --shadow-thumb: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-menu: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 8px 24px rgba(0, 0, 0, 0.5);
  --shadow-modal: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 24px 48px -12px rgba(0, 0, 0, 0.65);
  /* avatars */
  --av1-bg: #492826;
  --av1-fg: #f9bdb7;
  --av2-bg: #3f3112;
  --av2-fg: #e3cb99;
  --av3-bg: #223a23;
  --av3-fg: #b2dab2;
  --av4-bg: #083a3d;
  --av4-fg: #96dce0;
  --av5-bg: #21344c;
  --av5-fg: #afd1fc;
  --av6-bg: #3b2b46;
  --av6-fg: #dcc2f1;
}
body {
  margin: 0;
  font-family: var(--font);
  font-size: 14px;
  line-height: 22px;
  color: var(--text);
  background: var(--frame);
  font-variant-numeric: tabular-nums;
  font-synthesis-weight: none;
  -webkit-font-smoothing: antialiased;
  text-autospace: normal;
  text-spacing-trim: normal;
}
a {
  color: var(--accent-text);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
button,
input,
textarea,
select {
  font: inherit;
  color: inherit;
}
.sep {
  margin: 0 6px;
}
.mono {
  font-family: var(--mono);
  font-size: 12.5px;
}
.halt {
  font-feature-settings: 'halt';
}
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0s !important;
    transition-duration: 0s !important;
  }
}
:root[data-reduce-motion='true'] * {
  animation-duration: 0s !important;
  transition-duration: 0s !important;
}
```

`data-reduce-motion` 由 `theme-boot.js` 在首帧按 `localStorage` 设好，用户菜单的「减少动态效果」开关切换时同步改；开着时 `ConfigProvider` 的 `theme.token.motion` 传 `false`（§8），antd 自己的动画也关掉。

## 2. 字体

### 2.1 选型与授权

| 用途                                           | 字体                                                                   | 授权                                                                                     | 生产                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| 拉丁字母、数字、ASCII 标点、间隔号 `·`         | **Geist**（Vercel，v1.800，可变 wght 100–900）                         | SIL OFL 1.1，没有保留字体名                                                              | 自托管自己切的子集（§2.6）          |
| 等宽：编号、工具原名、字段原名、哈希、JSON     | **Geist Mono**（v1.701）                                               | SIL OFL 1.1，没有保留字体名                                                              | 同上                                |
| 中文、全角标点、引号、省略号、破折号及其他符号 | **思源黑体 Noto Sans SC**（Google Fonts 版 v2.004，可变 wght 100–900） | SIL OFL 1.1，保留字体名只有 'Source'，用「Noto Sans SC」这个名字切片、自托管、商用都可以 | 自托管：UI 优先片加长尾分片（§2.6） |

- `⌘`（U+2318）、`×`、`→`、`㎡`、`℃` 都由 Noto 画，不掉到系统字体。
- 许可文本随字体发布，见 §2.6。

### 2.2 实测结论（fonttools 4.66 + Chromium 153 / Firefox / WebKit，Playwright 自带版本）

| 项                                | 结果                                                                                                                                                                                                                                                                                          | 影响                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noto Sans SC 的 GPOS 特性         | `halt kern mark palt vert vhal vkrn vpal`，**没有 `chws` / `vchw`**。上游 `notofonts/noto-cjk` 的 `NotoSansSC-VF.otf`（2.004）也没有                                                                                                                                                          | 不能靠 `font-feature-settings: "chws"` 做跨浏览器挤压                                                                                                                         |
| Noto Sans SC 的 GSUB 特性         | `aalt ccmp dlig fwid hist hwid liga locl pwid ruby vert vrt2`。`locl`（hani 与 ZHS）把 `—` 换成整字宽的 U+2015                                                                                                                                                                                | 中文里的「——」连成一条（已截图核对）：两个 U+2015 再由 `ccmp` 连成一个两字宽的字形，子集要留 `ccmp`（§2.6）                                                                   |
| 各全角标点的 `halt` 值            | 字身在左、右边空半字的一类，`halt` 为 `xa −500`：，。、：；！？）」』】》〉〕”’。字身在右的一类，`halt` 为 `xp −500, xa −500`：（「『【《〈〔“‘                                                                                                                                               | 挤压全靠 `halt`：浏览器按上下文决定对哪个字施加                                                                                                                               |
| `…`（U+2026）                     | Noto 里整字宽 1000，墨迹 y 314–446，**垂直居中**；Geist 的 `…` 墨迹 y 0–113，落在基线上                                                                                                                                                                                                       | Geist 不画 `…`（§2.6 的 `unicode-range`）。另外 `lang="en"` 的段落会触发 `locl latn` 换成西文省略号、落回基线，所以根元素必须是 `lang="zh-CN"`，含 `…` 的元素不设 `lang="en"` |
| `·`（U+00B7）                     | Noto 里整字宽 1000，居中；Geist 里宽 201                                                                                                                                                                                                                                                      | 间隔号交给 Geist 画，窄，这是想要的效果                                                                                                                                       |
| `–`（U+2013）                     | Noto 宽 536，半字宽                                                                                                                                                                                                                                                                           | 「5–10 月」用 Noto 画没问题                                                                                                                                                   |
| 字重                              | Noto 可变轴 100–900，默认实例 Thin；400/500/600 都是真字重                                                                                                                                                                                                                                    | 中文标题可以用 600，和 Geist SemiBold 视觉一致（已截图核对）                                                                                                                  |
| 垂直度量                          | Noto hhea 1160/−288（1.448em），Geist 1005/−295（1.3em）                                                                                                                                                                                                                                      | 一律写固定行高，不用 `line-height: normal`                                                                                                                                    |
| `text-spacing-trim`               | Chromium 153 支持 `normal / trim-start / space-all / space-first`（不支持 `trim-both`）。**用 Noto 的 `halt` 就能挤压，不需要 `chws`**，跨元素边界也生效。Firefox、WebKit 不支持                                                                                                              | Chrome / Edge 原生挤压；其他引擎用 §2.5 的回退                                                                                                                                |
| Chromium 的挤压规则               | 用完整字体逐对测了 24×24 = 576 对，加 5 句真实文案；第 1.3 步扩到 §2.5 函数里的全部 33 个字（1,089 对）、10 句文案重测：§2.5 的回退与 Chromium 的整串宽度 **0 处不同**，墨迹位置也相同。只有「收标点 + 开标点」一类（576 对里 104 对）挤的字不同：Chromium 挤开标点的左半，回退挤收标点的右半 | 回退的宽度和字形位置与 Chrome 一致；「收 + 开」挤哪个字的差别，只在换行正好断在两字之间时看得出（§2.5）                                                                       |
| 按 Google / fontsource 切片加载时 | 有 **30 对不挤**：它们跨切片，Chrome 在字体段落边界上没处理，主要是「；」和弯引号紧挨「，。、：」的那些对。补一个 19.5 KB 的标点专用字面后，**0 处不同**                                                                                                                                      | 生产让所有标点落在 UI 优先片里（§2.6）                                                                                                                                        |
| `text-autospace`                  | 三个引擎都支持 `normal`。每个中西交界补 1/8 字宽（20px 时 2.5px）；手打一个空格是 Geist 的 0.25 字宽，是它的两倍                                                                                                                                                                              | 界面文案里中文和数字/拉丁之间**不手打空格**                                                                                                                                   |

### 2.3 字重与字阶

- **标题 600**：页标题、区块标题、卡片标题、弹窗和抽屉标题、KPI 数字。中文和拉丁都是 600，Noto SemiBold 对 Geist SemiBold。
- **标签 500**：表单标签、表头、按钮、状态标签、页签选中、导航选中、行标题（对象名）、数字徽标。
- **正文 400**：其余所有文字。
- 不用 700。`font-synthesis-weight: none`，不许浏览器假粗。
- 中文字距一律 0。负字距**只加在纯拉丁/数字的元素上**（KPI 数字）。标题里夹着中文时，整行字距为 0。

| 名称       | 字号/行高          | 字重      | 字距     | 只用在                                                                                           |
| ---------- | ------------------ | --------- | -------- | ------------------------------------------------------------------------------------------------ |
| badge      | 12/16              | 500       | 0        | 只用于数字徽标                                                                                   |
| meta       | 13/20              | 400 / 500 | 0        | 帮助、状态句、表头（500 text-3）、次行、时间、面包屑、状态标签（500）、Tag、表单标签（500 text） |
| code       | 12.5/20 Geist Mono | 400       | 0        | 编号（r-sichuan-lux）、工具原名、字段原名、哈希                                                  |
| body       | 14/22              | 400 / 500 | 0        | 正文基准：表格、表单值、按钮（500）、导航（400，选中 500）、行标题（500）                        |
| reading    | 16/28              | 400       | 0        | 话术编辑器正文、长文本只读，行宽 ≤ 40em                                                          |
| card-title | 15/22              | 600       | 0        | 卡片标题、空状态标题、清单头                                                                     |
| section    | 16/24              | 600       | 0        | 页内区块标题（总览各区、节标题）、抽屉和弹窗标题                                                 |
| page-title | 24/32              | 600       | 0        | 页标题（都含中文，所以字距 0）                                                                   |
| kpi        | 28/36              | 600       | −0.025em | 总览业务数、系统页关键数字（纯数字）                                                             |
| display    | 36/44              | 600       | 0        | 只用于登录页标题                                                                                 |

- 数字一律 `font-variant-numeric: tabular-nums`，body 上已经设了。Geist 的 `tnum` 在自切的子集里保留了（§2.6）。
- 金额写「42,800 元」；表头带单位时，单元格只写数。全站不出现「¥」。

### 2.4 字体栈

- `--font: "Geist","Noto Sans SC",system-ui,sans-serif`；`--mono: "Geist Mono","Noto Sans SC",ui-monospace,Menlo,Consolas,monospace`。antd 的 `fontFamily`、`fontFamilyCode` 取同样的值（§8）。
- Geist 的 `unicode-range` 只有可打印 ASCII、U+00A0 和 U+00B7（§2.6），所以下面这些都由 Noto 画：
  - 中文标点「，。（）「」」
  - 弯引号 “”‘’
  - `…` 和 `—`
  - `–` `×` `→` `⌘` `㎡`
- 字体没到时用系统字体。一律写固定行高，不用 `line-height: normal`，换字体时行框高度不变。

### 2.5 标点挤压、中西间距、间隔号

**CSS**（写在全局样式的 body 上）：

根元素写 `<html lang="zh-CN">`（`console/index.html`）。

```css
body {
  text-spacing-trim: normal; /* 初始值就是 normal；写明它，防止组件库改成 space-all */
  text-autospace: normal; /* 中西交界补 1/8 字宽 */
  font-synthesis-weight: none;
  font-variant-numeric: tabular-nums;
}
.halt {
  font-feature-settings: 'halt';
} /* 只给回退用，见下 */
```

- `normal` 的效果：
  - 相邻的全角标点之间只留半个字宽，例如「）「」、「」「」、「：「」、「」，」、「（「」。
  - 行首的开括号不挤，这和 `trim-start` 不同。
  - 单独出现的标点照旧占整字宽，不会像 `palt` 那样把所有标点都压成半宽。
  - 不要在任何地方写 `space-all`，也不要全局开 `halt` / `palt`：那会把每个「，」都压成半宽，是日文排版的做法，不是简体中文正文的做法。
- **回退**：Firefox、Safari、老版本的企业微信内置浏览器都不支持 `text-spacing-trim`。Noto 没有 `chws`，所以只能由我们自己决定对哪个字加 `halt`。启动时检测一次：
  ```js
  const needsTrimFallback = !CSS.supports('text-spacing-trim', 'normal');
  ```
  为真时，用下面这个函数找出要加 `halt` 的字，把它们包进 `<span class="halt">`。函数在完整字体上与 Chromium 153 逐对核对过，576 对的挤压全部一致（第 1.3 步逐字重测，扩到函数里全部 33 个字、1,089 对：整串宽度 0 处不同；只有「收标点 + 开标点」这一类，Chromium 把半字算在开标点上、这里挤收标点，两字的墨迹位置相同，换行断在两字之间时行首的开标点仍是全宽）：
  ```js
  const OPEN = '（［｛〔〈《「『【〖“‘'; // 左边空半字
  const CLOSE = '）］｝〕〉》」』】〗，。、：；”’'; // 右边空半字（简体的 ，。、：； 靠左）
  const MID = '·・'; // U+00B7 由 Geist 画，仍按间隔号算
  function haltIndices(s) {
    // ！？ 不参与，Chromium 也不挤它们
    const out = new Set();
    for (let i = 0; i + 1 < s.length; i++) {
      const a = s[i],
        b = s[i + 1];
      if (CLOSE.includes(a) && (OPEN.includes(b) || CLOSE.includes(b) || MID.includes(b))) out.add(i);
      else if ((OPEN.includes(a) || MID.includes(a)) && OPEN.includes(b)) out.add(i + 1);
    }
    return [...out];
  }
  ```
  - `haltIndices` 放在 `src/shared/typography.ts`。接入点是一个文本助手 `cjk(text): ReactNode`，只在 `needsTrimFallback` 时拆 span。用在我们自己渲染文字的地方：PageHeader 标题和状态句、§6 各渲染器的单元格和只读值、表单标签、帮助和错误、Alert、检查清单、审计句子、保存条和发布条的摘要、弹窗和抽屉的标题与后果列表。
  - 话术编辑器（CodeMirror）用同一个函数生成 `Decoration.mark({ class: 'halt' })`。
  - 字符串要先拼好再算：分隔号 `·` 虽然画成单独的元素（见下），算的时候要算进去。
- **中西间距**：界面文案（我们写的字）里，中文和数字、拉丁字母之间**不手打空格**，由 `text-autospace` 补。本文为了好读，写例子时留了空格，代码里一律删掉。例如：
  - 写 `7条消息`，不写 `7 条消息`
  - 写 `线上v2`，不写 `线上 v2`
  - 模板写 `${n}条消息`

  产品数据（线路名「贵州 小七孔·西江千户苗寨 5 日」、酒店名等）原样显示，不改。
  - 例外：日期和时刻之间保留一个空格，如「9月25日 18:30」。
  - `text-autospace` 不在中文和一个独立的等宽元素之间补间距（例如「编号」后面紧跟 `r-guizhou-5d` 的等宽元素），所以行内的等宽元素左右各留 4px 外边距。

- **间隔号**：并列的几段信息之间用组件 `Sep` 隔开。它是 `<span class="sep" aria-hidden="true">·</span>`，左右外边距各 6，颜色跟随所在的文字，文字两侧不打空格。组件里再跟一个空的 `<span class="sep-sr">`，它的 `::before` 写 `content: '' / '，'`：生成内容的替代文字，看不见、不占宽度、不参与挤压，读屏时念成「，」来断句。不用 `position:absolute` 的 sr-only：WebKit 的一行里有 absolute 的盒子时，整行的 `text-autospace` 都失效（plan 第 1.3 步实测）。
  - `cjk()` 收一个字符串数组时，各段之间放 `Sep`，挤压在拼好的串上算。
  - Chrome 会把紧挨在它前面的全角收尾标点挤掉半字：「处理）· 有」，这是对的。
  - 回退函数在拼好的字符串上算，结果一致。
- **省略号和破折号**：
  - 省略号写一个 U+2026「…」，中文里写两个「……」，不写三个点「...」。
  - 破折号写两个 U+2014「——」。空值写一个「—」。
  - CSS 截断（`text-overflow: ellipsis`）出来的「…」也由 Noto 画，居中。

### 2.6 生产：自托管

生产只从本站加载字体，不连 Google Fonts。字体文件经 Vite 打进 `/console/assets/`，文件名带内容哈希。

| 文件                                 | 来源                                             | 码位                        | 字重轴  | 大小（实测） | 加载                           |
| ------------------------------------ | ------------------------------------------------ | --------------------------- | ------- | ------------ | ------------------------------ |
| `geist-ui.woff2`                     | `Geist[wght].ttf`（google/fonts，OFL）           | U+0020–007E、U+00A0、U+00B7 | 400–600 | 11.9 KB      | preload                        |
| `geist-mono-ui.woff2`                | `GeistMono[wght].ttf`                            | 同上                        | 400–500 | 8.0 KB       | 用到时                         |
| `noto-sans-sc-ui.woff2`（UI 优先片） | `NotoSansSC[wght].ttf`（google/fonts，v2.004）   | 见下                        | 400–600 | 243,600 B ¹  | preload                        |
| 长尾分片（101 片）                   | `@fontsource-variable/noto-sans-sc` 5.3.0（OFL） | 各片自带的范围              | 100–900 | 单片约 48 KB | 页面上出现界面没用过的字时按需 |

¹ 界面做完时的量（见下）；现在的产物只收已经写进代码的文字，数字见 plan 第 1.2 步的实施记录。

**UI 优先片**：

- 码位：界面文字里的全部汉字（`console/index.html`、`console/src/**` 除样张目录 `_specimen/` 外、`src/shared/**` 除假包外、各注册行业包的 `console-pack.ts` 里的字符串与 JSX 文本，加 antd 的 zh_CN 语言包和 zod 的 zh-CN 语言包；注释和自测不算，见 `scripts/fonts/ui-text.ts`）；全部 CJK 标点 `U+3000-303F, U+FF01-FF60, U+FFE0-FFE6, U+2014-2015, U+2018-2019, U+201C-201D, U+2026, U+2E3A-2E3B`；以及由 Noto 画的符号 `×` `–` `→` `⌘` `㎡` `℃`。按当前仓库加本文的全部文案（界面做完时的用字）、照这份配方切，共 1,124 个码位，实测 243,600 B（早先量的 1,110 个码位、242 KB 那一版少了 U+FFE0–FFE6、U+2E3A–2E3B 和 `×` `–` `→` `⌘` `℃` 这 14 个）；同一批字按 Google 或 fontsource 的切片要下 25 片、1.43 MB。
- 保留 GPOS `halt vhal palt vpal kern`、GSUB `ccmp locl vert vrt2`（`ccmp` 把「——」连成一条，§2.2）；wght 轴限到 400–600。
- 由 `scripts/fonts/build.ts` 生成并提交：从固定 URL 取原文件、校验 sha256，调 fonttools 的 `pyftsubset` 切片，同时写出码位清单和产物的 sha256。只在开发机上跑（要本机装 fonttools），CI 不跑。界面文案改了就重跑；新字即使没重跑也能显示，只是来自长尾分片。
- `pnpm test` 的检查（spec「字体与授权义务」）：界面文字里的每个汉字、全部 CJK 标点都在码位清单里，汉字以外的字符都由 Geist 或这一片画（例外各带理由）；产物的 cmap、sha256 等于清单；`fonts.css` 里 UI 优先片最后声明。标点都在这一个文件里，Chrome 才能对所有标点对都挤压，§2.2 那 30 对差异也就没有了。

**Geist 和 Geist Mono 自己切，不用 `@fontsource-variable/geist` 的 CSS。** 它的 latin 片 `unicode-range` 含 `U+2000-206F`，会把 `— “ ” ‘ ’ …` 画成西文字形，早先样张里「…」落在基线上就是这个原因。

- 从 OFL 原文件切，码位 `U+0020-007E, U+00A0, U+00B7`，保留 `kern liga tnum pnum ccmp locl`。
- 这个 `unicode-range` 不含 U+2018–201D、U+2014、U+2026，含 U+00B7。ASCII 以外的符号（`×` `–` `→` 等）都交给 Noto；`×` 虽然在 Latin-1 里，也不进这个范围。

**长尾分片**不提交，由钉死版本的 npm 依赖提供。它们的 `@font-face` 由同一个构建脚本从依赖里的清单生成，家族名写成「Noto Sans SC」，不用依赖自带的 CSS（它的家族名是「Noto Sans SC Variable」）。范围里去掉控制字符（U+0000–001F、U+007F–009F）：latin 片从 U+0000 起，WebKit 遇到拉丁字母后面的换行符会去下载它。

**声明顺序**：先声明长尾分片，最后声明 UI 优先片。同一家族的 `unicode-range` 重叠时，浏览器先查后声明的那一个，所以界面文字和全部标点都取自 UI 优先片，不下载长尾分片。Chromium 153、Firefox 155、WebKit 26.6 实测都是这样（spec 开放问题 4，数字见 plan 第 1.2 步的实施记录）。

```css
/* 长尾：每片一条，由构建脚本生成，先声明 */
@font-face {
  font-family: 'Noto Sans SC';
  src: url(<分片>.woff2) format('woff2');
  font-weight: 400 600;
  font-style: normal;
  font-display: swap;
  unicode-range: <该片的范围>;
}
/* UI 优先片：最后声明 */
@font-face {
  font-family: 'Noto Sans SC';
  src: url(./fonts/noto-sans-sc-ui.woff2) format('woff2');
  font-weight: 400 600;
  font-style: normal;
  font-display: swap;
  unicode-range: <码位清单>;
}
@font-face {
  font-family: 'Geist';
  src: url(./fonts/geist-ui.woff2) format('woff2');
  font-weight: 400 600;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0020-007E, U+00A0, U+00B7;
}
@font-face {
  font-family: 'Geist Mono';
  src: url(./fonts/geist-mono-ui.woff2) format('woff2');
  font-weight: 400 500;
  font-style: normal;
  font-display: swap;
  unicode-range: U+0020-007E, U+00A0, U+00B7;
}
```

- `font-weight` 必须写成范围（`400 600`）。只写一个值时，浏览器会把可变轴夹死在那个值上，600 就会变成假粗或者 400。
- **preload** 只放两个：`geist-ui.woff2` 和 `noto-sans-sc-ui.woff2`，都带 `crossorigin`，由构建注入 `index.html`。其余按需加载。
- **缓存**：`src/console-api/host.ts:61` 现在给 `/console/*` 的静态文件都带 `CONSOLE_SECURITY_HEADERS` 里的 `Cache-Control: no-store`，每次整页加载都会重下字体。带内容哈希的 `/console/assets/*` 改成 `public, max-age=31536000, immutable`；`index.html` 和 API 保持 `no-store`。怎么落进 01 见 spec 开放问题 1。
- **CSP**：`src/shared/security-headers.ts` 的 `BASE_CSP` 现在是 `default-src 'self'`，字体已经只能从本站加载。显式加一段 `font-src 'self'`，不加 `data:`，也不加 `fonts.gstatic.com`。
- **许可文本**随构建发布，内容照上游原文：`/console/licenses/OFL-Geist.txt`（Geist 与 Geist Mono 共用同一份版权声明）、`/console/licenses/OFL-NotoSansSC.txt`、`/console/licenses/lucide-ISC.txt`。仓库根目录的 `NOTICE` 记下三款字体。子集不改字体家族名：OFL 允许功能等价的子集沿用「Geist」「Noto Sans SC」，保留字体名只有「Source」。
- **「关于」**：用户菜单加一项「关于」，打开 480 宽的弹窗（§4.2 第 5 项；样张在 P 页）。写：
  - 字体：Geist、Geist Mono（Vercel），思源黑体Noto Sans SC（Adobe、Google）。都按SIL Open Font License 1.1使用
  - 图标：Lucide（ISC许可）
  - 三个链接：「查看Geist许可」「查看思源黑体许可」「查看图标许可」（两款字体的版权声明各是一份文件，spec 第 2.2 步的 Revisions）

  中文和拉丁字母、数字之间不打空格（§2.5），由 `text-autospace` 补。不写版本号和构建哈希（硬规则 7）。第一句用「），」不用「）；」（owner 2026-09-27）：设计样张按 Google Fonts 的切片加载，「）」「；」落在不同切片，实测含它的那段文字在 `space-all` 和 `normal` 下都是 110px，没挤；换成「），」后从 110px 挤到 102px。生产里标点都在 UI 优先片，两种写法都挤，改成「），」是为了样张和生产一致。

## 3. 圆角、阴影、间距、动效、焦点

**圆角**：

- `--r-xs 4`：复选框、Tag、kbd、行内高亮
- `--r-sm 6`：按钮、输入框、选择框、导航项、菜单项、滑块、Tooltip、代码芯片
- `--r-md 8`：菜单、Popover、toast、Alert、分段轨道、行悬停块
- `--r-lg 10`：卡片、KPI 格、空状态图标块、子项卡片
- `--r-xl 12`：内容面板、弹窗、⌘K
- 全圆：状态胶囊、数字徽标、头像、开关
- 抽屉贴边，不做圆角。「圆的是状态，方的是属性」：Tag 用 4，状态胶囊用全圆。

**层级**：

- 0 级是内容面板（`--shadow-panel`）。
- 页面里的卡片用 `--shadow-card`，KPI 格用 `--ring`。
- 1 级浮层用 `--shadow-menu`。
- 2 级（弹窗、抽屉、⌘K）用 `--shadow-modal`，加遮罩。
- 吸附元素（缩起的页头、保存条、发布条、吸顶表头）不透明，只加一条 `--divider` 细线，不加阴影。

**间距**：4 的倍数，刻度 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48。

| 项                         | 值                                                         |
| -------------------------- | ---------------------------------------------------------- |
| 侧栏                       | 宽 240，收起 56；内边距 8                                  |
| 内容面板                   | 距窗口上、右、下 8，左侧贴侧栏；圆角 12                    |
| 面板内边距                 | ≥1440：上 24、左右 32、下 32；1280–1439：左右 24；<992：16 |
| 区块之间                   | 28–32（不套卡片的区块，各页写明）；卡片之间 16             |
| 导航项 / 控件 / 表格内控件 | 32 / 32 / 28；登录页控件 40                                |
| 表头 / 单行 / 两行         | 36 / 44 / 56                                               |
| 单元格内边距               | 0 12（表格整体左右各 −12，让首列文字和页标题对齐）         |
| 卡片                       | 头 16 20 0，体 12 20 20                                    |
| 表单                       | 标签到控件 6，控件到帮助 6，字段之间 20，分组卡片之间 16   |
| 点击目标                   | ≥ 24×24                                                    |

**动效**：只动 opacity 和 transform，逐个列出属性，禁止 `transition: all`。

| 场景                                                                                              | 时长与缓动                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 导航、页签、排序、筛选、翻页、⌘K 开关、列表里的 J/K、行悬停、主题切换、侧栏收起、「技术详情」展开 | 0ms                                                                                   |
| 按钮、输入框的颜色和阴影变化                                                                      | 100ms linear                                                                          |
| 下拉、Popover 入场                                                                                | 120ms 的 opacity，退场 0ms                                                            |
| 弹窗                                                                                              | 160ms 的 opacity，加 scale .98→1，`cubic-bezier(.2,0,0,1)`                            |
| 抽屉                                                                                              | 入场 200ms translateX，`cubic-bezier(.2,0,0,1)`；退场 150ms，`cubic-bezier(.4,0,1,1)` |
| 保存条、成功 toast 出现                                                                           | 160ms 的 opacity，加 translateY 8px→0                                                 |
| 「等人接手」状态点第一次出现                                                                      | opacity 1→.35→1，周期 1.2s，**只播 3 次**，之后静止                                   |
| 轮询后数字变了                                                                                    | 背景闪一次 accent-bg，150ms 淡出，一次                                                |

不做：

- 骨架闪光（骨架是静态的）、数字滚动、页面切换动画、按下缩放、水波纹、任何循环动画。
- 转圈只出现在提交中的按钮里；其他加载一律用骨架，并且延迟 300ms 才出现。

系统设置了 `prefers-reduced-motion`，或者用户在菜单里打开「减少动态效果」时，以上时长全部为 0，状态点不闪。

**焦点**（`:focus-visible`）：

- 按钮、链接、导航项、页签、芯片、复选框、表格里的名称链接：`outline: 2px solid var(--focus); outline-offset: 2px`。
- 容器会裁掉外框的地方（表格行、列表行、导航项、菜单项）改用 `outline-offset: -2px`。
- 输入框、选择框、文本域获得焦点（包括鼠标点击）：描边换成 `--accent`，外加 `0 0 0 3px var(--accent-ring)`。出错的控件两处都换成 danger（`--danger-ring`）。
- 两行首列的第二行加 2px 上间距，焦点环不压到次行。
- `html { scroll-padding-top: 72px; scroll-padding-bottom: 76px }`，焦点不会被吸顶条或保存条挡住。
- 每页首个可聚焦元素是「跳到主要内容」。

## 4. 外壳

### 4.1 页面几何（宽 1440）

- 侧栏 x 0–240，底 `--frame`，没有右边线。
- 内容面板 x 240–1432，距上下各 8（高 = 窗口高 − 16）；`--panel` 底，`--r-xl`，`--shadow-panel`，`overflow: hidden`，面板内部自己滚动。
- 内容宽 = 1192 − 64 = **1128**。侧栏收起（B 话术、C 版本记录、J 工作台）时：侧栏 56，面板 1376 宽，内容宽 **1312**。
- 断点：≥1280 展开；992–1279 收成 56 的图标栏，悬停出标签；<992 隐藏，出现一条 52 高的顶栏（菜单按钮、租户 logo 和名称、铃铛，底 `--frame`，无分隔线），由菜单按钮打开侧栏抽屉。
- 深色主题在 `<html>` 上加 `data-theme="dark"`；`body` 的底色是 `--frame`。

### 4.2 侧栏

从上到下：

1. **租户行**（高 40）：
   - 租户按钮：flex 1，高 36，内边距 0 8，`--r-sm`，悬停 `--hover`。里面是 logo 20×20、圆角 5，后接租户名 14/500 text，超长省略。没有 logo 时，在 `--accent` 底上用 `--on-accent` 写名称首字，13/600。需要 `Me.tenantName`。
   - 平台管理员能切租户时，右侧加 14 的 `chevrons-up-down`（text-3）；其他人不画这个箭头，不做假的可点提示。
   - 租户按钮右边是铃铛图标按钮，28×28，`bell` 16，text-2；右上角叠实心数字徽标（§5.7）。
2. **搜索触发器**（上 6、下 8）：高 32，`--r-sm`，`--panel` 底加 `--shadow-btn`，内边距 0 8。里面是 `search` 16 text-3，加 14 text-3 的「搜索{实体名}、会话…」，实体名来自行业包，如「搜索线路、酒店、会话…」，超长省略。它是打开 ⌘K 的按钮，不是输入框；悬停 Tooltip 写「⌘K」，不常驻显示快捷键。
3. **导航**：项与项间隔 2。
   - 每项高 32，`--r-sm`，内边距 0 8，图标与文字间隔 8；图标 16（text-3），文字 14/400 text-2。
   - 悬停 `--hover`，字变 text。
   - **选中：`--selected` 底，字 text 500，图标 text；没有左侧竖条。**
   - 右侧计数 13 text-3 等宽（线路 21、酒店 29）；「会话」右侧是软徽标。
   - 导航由行业包生成，顺序固定：
   ```
   总览
   销售话术
   {pack.nav.catalogGroup}            ← 分组标题：旅游包「产品库」
     {entity.label} …                 ← 线路、酒店 / 装修套餐、主材；图标名来自行业包
   运营                               ← 分组标题
     会话            [等人接手数]
     审计日志                          ← 只给所有者、管理员
   平台                                ← 只给平台管理员
     系统
   ```
4. **分组标题**：13/20/500 text-3，上 16、下 4，内边距 0 8。
5. **用户行**（贴底，高 40）：
   - 用户按钮：flex 1，高 36，内边距 0 8。24 圆头像（§6.8 取色）、名字 14/500、角色 13 text-3、右侧 14 `chevrons-up-down` text-3。
   - **放不下时先藏角色，名字保持完整**（owner 2026-09-27）：名字和角色放进同一个容器：flex 1，`min-width: 0`，高 22，`display: flex; flex-wrap: wrap; column-gap: 8px; overflow: hidden`。
     - 放不下时，角色整个折到第二行，被裁掉；名字不截断。
     - 名字本身也放不下时，名字才截断成「…」（名字设 `max-width: 100%` 加省略号）。
     - 按钮的 Tooltip 写「名字·角色」，用户菜单的身份块照常写角色。裁掉不等于隐藏，读屏照样读到角色。
     - 纯 CSS 实现，不用 JS 测宽。
     - 例：N 页的「技术支持」（平台管理员）。按钮内能放文字的宽度是 122，名字 56 + 间隔 8 + 角色 65 = 129，放不下，所以只显示名字。
   - 右边是「收起侧栏」图标按钮 28（`panel-left` 16）。进入销售话术页和会话工作台时，侧栏默认收起。
   - **用户菜单**向上弹出：宽 240，`--raised`，`--r-md`，内边距 4，`--shadow-menu`，左边与用户行对齐。从上到下：
     1. 身份块：名字 14/500、邮箱和角色 13 text-3，不可点
     2. 分隔线
     3. 「外观」：右侧写当前值（13 text-3）和 `chevron-right`，子菜单向右弹出：浅色（默认）/ 深色 / 跟随系统，当前项右侧 `check`
     4. 「减少动态效果」开关
     5. 「关于」（§2.6）
     6. 分隔线
     7. 「退出登录」（`log-out`）

     **没有**单键切换主题的快捷键。
6. **收起为 56**：
   - 每项变成 32×32 居中图标按钮，悬停出 Tooltip 写标签。当前项：`--selected` 底，外加 `0 0 0 1px var(--control-border)`（只有图标，没有字重可以区分，要一个 ≥3:1 的图形标记）。
   - 租户只剩 logo，搜索变 `search` 图标按钮。
   - 「会话」的软徽标改成叠在图标右上角的实心徽标。

**铃铛弹层**：

- 宽 360，从铃铛右侧向内容区弹出；`--raised`，`--r-md`，`--shadow-menu`，内边距 4。
- 列出等人接手的会话。每行高 56，`--r-sm`：上一行「企微客户 · F01」14/500，下一行 13 text-2「8 分钟前有新动静」；右侧幽灵小按钮「打开工作台」加 `arrow-up-right` 14。底部分隔线下是「查看全部会话」链接。
- 今天的数据来自页面可见时每 30 秒轮询一次 `GET /conversations/counts` 和 `GET /conversations?state=human`（spec「外壳 · 计数刷新」）；空状态和轮询失败的样子见 spec「外壳 · 铃铛」。02 以后改成 SSE 推送，加浏览器通知，标签页标题前加未读数，例如「(2) 总览 · 云途定制旅行」。

### 4.3 PageHeader（在面板内，不做卡片）

- 第三层页面（详情）在标题上方放面包屑，13/20：
  - 上级是 text-3 链接，悬停变 text；当前页 text-2。分隔符「/」text-3，两侧各 8；面包屑与标题间隔 8。
  - 没有独立页面的分组名（「产品库」）写纯文本，不做链接。
- 标题 24/32/600。需要时，标题右边 8 处跟一个状态（§5.6）。
- 状态句 13/20 text-2，一句话，距标题 4。会变的部分（如「已自动保存 14:05」）预留固定宽度。
- 右侧操作区与标题块垂直居中，按钮间隔 8，从左到右：「更多」图标按钮（`ellipsis`，次要按钮样式 32×32）、次要按钮、主按钮。主按钮最多一个，放在最右。风险操作收进「更多」。
- 页头到下一块（页签、工具条或内容）20。
- 滚动后：面板顶部出现 52 高的吸顶条，只放 15/22/600 页名和操作按钮，底部一条 `--divider`。
- `document.title` 写成「页名 · 租户名」，详情页写成「条目名 · 实体名 · 租户名」。

### 4.4 页签

下划线式：

- 高 40，项间隔 24，文字 14 text-2；选中项 text 500，下方 2px **text 色**线，不用主色。
- 计数 13 text-3，跟在文字后 4；「等人接手」的计数用软徽标。
- 整排下方一条 `--divider`，宽度等于内容宽。切换 0ms，antd `animated={false}`。

### 4.5 StateView（加载、空、出错）

- **骨架**：`--subtle` 块，`--r-xs`，与成品同尺寸（表格 8 行、卡片按块），静态不闪，延迟 300ms 出现。
- **空状态**：替换整块内容，在原位置居中，上下 48。从上到下：
  1. 40×40 图标块：`--panel` 底，`--shadow-card`，`--r-lg`，里面 20 的图标，text-2
  2. 间隔 12，标题 15/22/600，不超过 5 个词
  3. 间隔 4，说明 14/22 text-2，最宽 40em
  4. 间隔 16，最多一个主按钮，可以再加一个链接
- **筛选没有结果**：只给「清除筛选」链接，不放主按钮。
- **出错**：就地放 danger Alert，写「没取到 · 重试」，重试是次要按钮。

## 5. 组件

### 5.1 按钮

文字 14/500，图标 16、与文字间隔 6，文字不换行。默认高 32、左右 14（带前置图标时内边距 0 14 0 12）；表格和卡片里高 28、左右 10；登录页高 40。按钮之间间隔 8。

| 类型                              | 默认                                                                              | 悬停                              | 按下               |
| --------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- | ------------------ |
| 主按钮                            | `--primary` 底，`--on-primary` 字，无阴影                                         | `--primary-hover`                 | `--primary-active` |
| 次要                              | `--panel` 底，text 字，`--shadow-btn`                                             | 底叠 `--hover`                    | 底叠 `--pressed`   |
| 幽灵                              | 无底，text-2 字                                                                   | `--hover` 底，text 字             | `--pressed`        |
| 链接 / 文字按钮                   | accent-text，无底                                                                 | 下划线（偏移 3）                  | —                  |
| 图标按钮                          | 32 或 28 见方，`--r-sm`，16 图标 text-2，幽灵样式；必须有 `aria-label` 和 Tooltip | 同幽灵                            | 同幽灵             |
| 危险（**只在 ConfirmDanger 里**） | `--danger` 底，`--panel` 色字（浅 6.57，深 9.21）                                 | `opacity: .9`（浅 5.58，深 7.69） | 同悬停             |

- **禁用**：`--subtle` 底，text-3 字，无描边无阴影；旁边必须用 13 text-2 写原因。主按钮要禁用时用 `aria-disabled`，外观同禁用，保留焦点，点击后跳到第一个原因。
- **行内操作**（总览待办、会话列表）用幽灵小按钮，28 高，后接 14 `arrow-up-right`（新标签打开）或 `chevron-right`（站内跳转）；整行本身也可点。
- 按钮写具体的动作，如「上架，开始推荐」「回滚到 v1」「丢弃草稿」「只导入合格的 6 行」；不写「确定」「是」。

### 5.2 输入框、选择框、文本域

- **外观**：高 32，`--r-sm`，`--panel` 底；1px `--control-border`，写成 `box-shadow: inset 0 0 0 1px var(--control-border)`，描边不占布局。内边距 0 10，14 text。
  - 占位符 text-3，只放示例，以「例：」开头。
  - 前置图标 16 text-3；后缀单位 14 text-2，放在框内右侧。
- **状态**：
  - 悬停：描边换成 text-3 色。
  - 聚焦（包括鼠标点击）：描边换成 `--accent`，外加 `0 0 0 3px var(--accent-ring)`。
  - 出错：描边换成 `--danger`，外加 `0 0 0 3px var(--danger-ring)`。控件下方写 13 danger 字，前面放 14 的 `circle-x`，写「无法……」或具体原因；这时帮助文字暂时隐藏。
  - 禁用：`--subtle` 底，描边 `--divider`，字 text-3。
- **文本域**：内边距 8 10，14/22，3–12 行自动增高，右下角字数 13 text-3（超过 softMax 时变成 warning 色）。
- **标签和帮助**：
  - 标签在控件上方，13/20/500 text，不加冒号，不加星。选填字段在标签后加 13 text-3「（选填）」。
  - 帮助文字常驻在控件下方，13/20 text-2，最宽 40em。
- **选择框**：外观同输入框，右侧 16 `chevron-down` text-3。
- **工具条搜索框**：同输入框，宽 320（300 放不下 D 页的占位文案），前置 `search`。

### 5.3 下拉菜单与选项

- `--raised` 底，`--r-md`，内边距 4，`--shadow-menu`。
- 选项：高 32，圆角 `--r-xs`（外圆角 8 减去内边距 4），内边距 0 8，14 text；悬停 `--hover`；选中项文字 500，右侧放 16 `check`，用 text 色，不用主色底。
- 分组标题 13/500 text-3，内边距 8 8 4。分隔线 1px `--divider`，上下各 4。
- 选项多于 7 个时，顶部放一个搜索输入框（照 5.2），支持拼音首字母。

### 5.4 分段控件、多选片、复选框、开关

- **分段控件**：用于单选 ≤5 项、必填布尔、视图切换、审计筛选。antd `Segmented`。
  - 轨道高 32，内边距 2，`--r-md`，`--subtle` 底。
  - 每段高 28，左右 12，`--r-sm`，14 text-2。
  - 选中段：`--thumb` 底，`box-shadow: 0 0 0 1px var(--control-border)`（≥3:1），text 500，不加勾。
  - 必填且没有默认值时，一段都不选；选填的单选在最前面加一段「不填」。
- **多选片**：用于多选 ≤6 项。
  - 高 30，左右 10，`--r-sm`，`--panel` 底加 `--shadow-btn`，14 text-2，片与片间隔 6。
  - 选中：`--accent-bg` 底，accent-text 500，前面加 14 的 `check`（颜色之外的第二个信号），描边改成 `0 0 0 1px var(--accent-ring)`。`aria-pressed`。
- **复选框**：16×16，`--r-xs`，1px `--control-border`，`--panel` 底。选中时 `--accent` 底、无描边，里面是 12 的 `check`（`--on-accent`，描边 3）。
- **开关**：32×18 全圆。关闭时 `--control-border` 底，打开时 `--accent` 底；滑块 14，白色。旁边用 14 text-2 写当前值的文字，如「境外」。

### 5.5 表格

- **不放进卡片**，直接铺在面板上，左右各 −12。
- **表头**：36 高，13/20/500 text-3，不换行，透明底，下方 1px `--border`（写成 inset 阴影），没有竖分隔。
  - 可排序的列在表头文字后跟 12 的 `chevron-down` / `chevron-up`（text-3）。当前排序列的表头文字变成 text-2。没有动画。
- **行**：
  - 单行 44 高，首列两行时 56，都含行下 1px `--divider`（antd 的 td 下边框，内边距的算法见 §8 Table）。
  - 悬停 `--hover`（0ms）；选中 `--selected`（工作台、审计），配 `aria-selected`，不画左侧竖条；没有斑马纹。
  - 单元格内边距 0 12。
- **首列**：主文本 14/22/500 text，是真正的链接（悬停出下划线，键盘可达）；次行 13/20 text-3，上间距 2，写「四川 · r-sichuan-lux」，编号用 `--mono` 12.5。
- **数字列**：右对齐、等宽数字，单位写进表头，如「每人起价（元）」。带单位的整数把单位写进单元格，如「8 天」，同样右对齐。
- **枚举和标签**：多选枚举写成 14 text-2 的「家庭、亲子、银发」，一行放不下就省略，悬停显示全文。开放标签（tags 类型）用 Tag，最多 3 个，多出来的写 13 text-3「+2」，悬停列出全部。
- **状态列**用 §5.6；**更新列**用 13 text-3，写「小林 · 今天 13:40」。
- **分页器**：只在超过一页时出现（产品库 50 条一页，会话 20 条一页），放在右下。左侧 13 text-3「共 21 条」；页码是 28 的幽灵按钮，当前页 `--selected` 底，text 500。
- **弹窗和抽屉里的表格**（CSV 校验、审计改动）：表头 32、行 40，不做 −12。出错的单元格 `--danger-bg` 底、danger 字，`--r-xs`。

**工具条**（页签下 16，表格上 12）：

- 搜索框 320，加若干筛选按钮，右侧 13 text-3「21 条」，间隔 8。
- 筛选按钮是次要按钮的变体：高 32，内边距 0 8 0 10，14 text-2，后接 14 `chevron-down` text-3，如「目的地」。
- 生效后改成 `--accent-bg` 底、accent-text 500，写「目的地：四川」，后接 14 `x`，点了清除。
- 筛选按钮是带文字的菜单按钮，不要求 3:1 的边界。

### 5.6 状态 `Status`（全站唯一表达状态的组件）

高 22，行内对齐。

- **默认形态（不加底色）**：6px 圆点，间隔 6，13/20/500 text-2 标签。
- **待处理形态（加底色）**：只给「等人接手」（和 02 的「等了 10 分钟以上」）。全圆胶囊，内边距 0 8 0 7，`--warning-bg` 底；标签用 `--warning` 色 500，圆点用 `--warning-icon`。圆点第一次出现时闪 3 次（§3）。
- 草稿用**空心**圆点（`box-shadow: inset 0 0 0 1.5px var(--neutral-dot)`），在形状上也能和实心圆点区分。
- 胶囊里不放图标。状态永远是「圆点加文字」，满足 1.4.1（靠文字表达状态）。

| 状态             | 圆点                 | 形态                               | 计入徽标 |
| ---------------- | -------------------- | ---------------------------------- | -------- |
| AI 接待中        | `--neutral-dot`      | 默认                               | 否       |
| 等人接手         | `--warning-icon`     | 待处理（胶囊）                     | **是**   |
| 顾问处理中（02） | `--info-dot`         | 默认                               | 否       |
| 已成交           | `--success-dot`      | 默认                               | 否       |
| 已上架 / 线上    | `--success-dot`      | 默认                               | —        |
| 草稿             | 空心 `--neutral-dot` | 默认                               | —        |
| 只读             | `--neutral-dot`      | 胶囊，`--neutral-bg` 底，text-2 字 | —        |

会话状态只由 `src/shared/conversation.ts` 的 `conversationState(row)` 判定，前后端共用：服务端的过滤和计数，console 的列表、首页、导航徽标、铃铛都调它，数字都来自同一次 counts 响应（spec 不变量 17、18）：

- 已成交：`stage === 'paid'`。
- 等人接手：`handedOver && stage !== 'paid'`。02 以后还要满足「没有接手人」。
- 顾问处理中：只有 02 有，条件是 `handedOver`、有接手人、`stage !== 'paid'`，状态值 `assigned`。今天的数据分不出这一类，所以**今天的界面不出现这个状态和它的页签**，也不做成灰掉的样子。
- AI 接待中：其余情况。

### 5.7 数字徽标

- **软徽标**（导航、页签里的等人接手数）：高 18，最小宽 18，内边距 0 6，全圆，`--warning-bg` 底，`--warning` 字，12/16/500 等宽数字。
- **实心徽标**（叠在铃铛上、叠在收起后的「会话」图标上）：高 16，最小宽 16，内边距 0 4，全圆，`--badge` 底，`--on-badge` 字，12/16/500。外加 `0 0 0 2px var(--frame)` 做镂空，位置 top −3、right −4。
- 超过 99 写「99+」。只数等人接手。其他计数（线路 21）只写 13 text-3 的数字，不做成徽标。

### 5.8 Tag（属性标签）

- 高 22，内边距 0 6，`--r-xs`，`--subtle` 底，13/20 text-2，无描边。
- 可删除的 Tag 在右侧放 12 的 `x`（text-3，点击区域 24）。
- 锁定的成员（如「国内」）在左侧放 12 的 `lock`（text-3），间隔 4，没有删除按钮。
- 总览「需要你处理」里的类型（话术草稿、待上架）不是 Tag，写成 13/500 text-3 的文字。

### 5.9 卡片

只用于表单分组、编辑器、详情页副栏、有序子项的每一项、系统页各块。`--panel` 底，`--r-lg`，`--shadow-card`，不写 `border`。

- 卡片头：内边距 16 20 0；标题 15/22/600；右侧放链接或一个幽灵按钮；**头和体之间没有分隔线**。
- 卡片体：内边距 12 20 20。
- 锁定声明写在卡片头：标题后 8 处放 Tag「上架后锁定 · 计价」（Tag 前置 12 `lock`），标题下一行用 13/20 text-2 写原因。
- 副栏卡片吸顶（top 24），卡片之间 16。

### 5.10 KPI 格（总览业务数）

- 4 格一排，间隔 12，每格宽 (1128 − 36) / 4 = 273。
- 每格：`--panel` 底，`--ring`，`--r-lg`，内边距 16 20。
- 从上到下：
  1. 名称 13/20/500 text-2
  2. 间隔 6，数字 28/36/600 text，字距 −0.025em
  3. 间隔 2，口径 13/20 text-3
  4. 间隔 12，一条 1px `--divider`（左右贴格内边距）
  5. 间隔 11，**明细行** 13/20 text-2，一行，写这个数背后的真实构成（各格写什么见 §10.2 A）
- 整格是链接，跳到对应的筛选列表：悬停 `--hover` 底，右上角出现 14 `arrow-up-right`（text-3）。格高 160，四格等高。

### 5.11 列表区块（总览「需要你处理」「最近变更」「客户停在哪一步」）

不套卡片。

- **区块头**：一行 24 高：16/24/600 标题，间隔 8，13 text-3 计数（「5 项」）；右侧是链接按钮，13/500 text-2（如「全部会话」），后接 14 `chevron-right`。区块头到列表 8。
- **待办行**（「需要你处理」）：
  - 高 64，内边距 0 12，左右 −12，`--r-md`，悬停 `--hover`，整行可点。行与行之间 1px `--divider`，左右各缩进 12。
  - 列用 grid：`28px 104px minmax(0,1fr) auto`，列间距 16，都垂直居中。
    1. **图标块**：28×28，`--r-sm`，`--subtle` 底，里面 16 的图标（text-2）。会话用 `messages-square`，话术用 `message-square-text`，产品库条目用行业包给该实体配的图标（旅游包：线路 `route`、酒店 `bed-double`）。
    2. **类型**：状态胶囊（§5.6），或 13/500 text-3 的类型文字。
    3. **内容**：两行，间隔 2。第一行是对象，14/22/500 text，超长省略。第二行是上下文，13/20 text-2，各段用 `Sep` 隔开，超长省略。需要警示的那一段用 danger 字，前面加 14 `circle-alert`。
    4. **操作**：幽灵小按钮（§5.1）。
- **最近变更行**（时间线）：
  - 高 40，grid `96px 24px minmax(0,1fr)`，列间距 12。
    1. 时间：13/20 text-3，右对齐，等宽数字。同一天只在第一条写日期，如「今天 13:40」，之后只写「11:20」。
    2. 头像：24（§6.8）。所有头像的圆心上下用一条 1px `--divider` 连起来，从第一条的圆心到最后一条的圆心。
    3. 句子：14/22 text，人名和对象用 500，超长省略。
  - 区块底部间隔 8，放「查看全部」链接。
- **阶段条行**（「客户停在哪一步」）：用 §6.7 的阶段条。
- **系统状态行**：16 `circle-check`（`--success`），加 14 text「一切正常」，加 14 text-2「 · 线上话术 v2 · 产品库改动已生效」，不做卡片。出问题时改成 warning 或 danger 的 Alert，文案见 spec「总览」。与代码仓库的差异（drift）只放在「系统」页。

### 5.12 Alert

- `--{语义}-bg` 底，**无描边**，`--r-md`，内边距 10 12。
- 左侧 16 图标，距文字 10：info 用 `info`，success 用 `circle-check`，warning 用 `triangle-alert`，danger 用 `circle-alert`。颜色：success、danger、info 用语义文字色，warning 用 `--warning-icon`。
- 标题 14/22/500 text，说明 13/20 text-2；操作放在右侧，用 28 高的次要按钮。
- 页级 Alert 与内容等宽，放在页头下 16；块级 Alert 放在出事的块里。
- 四种用途：info 用于只读说明和演示（演示只读横幅用 info，不用黄色）；success 用于检查通过；warning 用于需要留意；danger 用于出错和要立刻处理。

**行内提醒**（话术编辑器里的「提到了不存在的工具」）：留在文字流里，不浮在正文上面。`--danger-bg` 底，`--r-sm`，内边距 8 12；14 `circle-alert` 加 14 text 文字，右侧放幽灵小按钮「改成 search_routes」。

### 5.13 抽屉

- 贴右边，全高，宽度三档：S 420（版本记录）、M 480（审计详情）、L 640（发布、合并）。
- `--raised` 底，`--shadow-modal`（左边那条描边就是阴影里的 ring），无圆角，配 `--mask`。
- **头**：高 56，内边距 0 16 0 24；标题 16/24/600，后面可以跟一句 13 text-2 的状态；右边是 28 的关闭图标按钮（`x`）。没有分隔线，内容滚动后才出现 `--divider`。
- **体**：内边距 4 24 24，自己滚动。
- **底**（可选）：高 60，内边距 0 24，`--frame` 底，上边一条 `--divider`；按钮靠右，间隔 8，主按钮在最右。
- Esc 关闭，焦点困在抽屉里，关闭后回到触发它的元素。

### 5.14 弹窗与确认

- 宽度三档：480（普通确认、关于）、640（上架、回滚）、`min(880px, 100vw)`（CSV 导入）。
- `--raised` 底，`--r-xl`，`--shadow-modal`，`overflow: hidden`，配 `--mask`。
- 右上角是 28 的关闭图标按钮（`x`，`aria-label`「关闭」）；Esc 同样关闭，关闭后焦点回到触发它的元素。
- **头**：内边距 20 24 0，标题 16/24/600，写出对象，例如「上架「贵州 小七孔·西江千户苗寨 5 日」」。
- **体**：内边距 12 24 20，14/22，先写后果。
  - 后果写成列表，每条 16 图标加 14 文字，图标与文字间隔 8，条与条间隔 8。
  - 图标：中性事实用 `info`（text-2）；要留意的用 `triangle-alert`（`--warning-icon`）；会锁定的用 `lock`（text-2）；不可撤销的用 `circle-alert`（`--danger`）。
- **底**：带底色的底栏，内边距 12 24，`--frame` 底，上边一条 `--divider`。左侧可以放幽灵按钮（「上一步」）；右侧按钮间隔 8，主按钮在最右。
- **默认焦点在安全的那个按钮上**，例如「再看看」「再检查一下」「保留」。
- **ConfirmDanger** 是全站唯一能出现危险按钮的组件，用于丢弃草稿这类事。弹窗里不放主按钮，取消按钮默认聚焦。上架和回滚不算危险操作，确认按钮用主按钮。

### 5.15 Toast、Tooltip

- **Toast**（只报成功）：
  - 面板顶部往下 20，水平居中。高 40，内边距 0 14 0 12，`--r-md`，`--shadow-menu`。
  - **反相**：`--text` 底，`--panel` 色字 14/22；16 `circle-check` 用 `--toast-icon`，与文字间隔 8。
  - 3 秒后消失，不带操作。
  - 错误一律不用 toast；发布成功也不用 toast，写在发布条里。
- **Tooltip**：`--text` 底，`--panel` 色字 13/20，内边距 4 8，`--r-sm`，最宽 240，无箭头。

### 5.16 保存条 / 发布条（ActionBar）

- 吸在内容面板底部，宽度等于面板（被面板圆角裁切），不覆盖侧栏。高 60，内边距 0 32，`--panel` 底，上边一条 `--border`；不透明，无阴影，不做成居中的悬浮胶囊。
- 左边：16 的状态图标，加 14/500 摘要，加 13 text-2 补充。例如「有 2 处改动」，后跟文字按钮「展开改动」。
- 右边从左到右：13 text-2 说明、次要按钮、主按钮。
- 没有改动时保存条不出现；发布条在话术页常驻。
- 服务端确认成功以后，把成功结果写在条里，不弹 toast。例如「已发布 v3（改了 话术原则、异议处理）· 客户下一句就用新话术」，后面跟文字按钮「回滚到 v2」。这句话保留到下一次改动。
- 按 `⌘S` 立即保存。

### 5.17 检查清单（CheckList）

- **头**：卡片标题字阶 15/22/600「发布前检查」，右侧 13 text-2「6/7 通过」；下一行 13 text-3「每次自动保存都会跑 · 上次 14:05」。
- **每项**：高 36，`--r-sm`，左右 −8，内边距 0 8。
  - 16 图标：通过用 `circle-check`（`--success`）；没过用 `circle-x`（`--danger`）；只是建议用 `triangle-alert`（`--warning-icon`）；还没跑用 `circle-dashed`（text-3）。
  - 14 text 标签；右侧 13 说明，没过时用 danger 字，如「1 处 · 话术原则」。
- 没过的项整行是一个按钮：悬停 `--hover`，末尾放 14 `chevron-right`，点了跳到出问题的位置。
- **话术的 7 项**，名字固定：结构完整 / 固定规则节没改 / 必备短语都在 / 没有禁用短语 / 工具名都存在 / 字段名都存在 / 字数在额度内。依次对应 `structure / locked_changed / phrase_missing / phrase_forbidden / unknown_tool / unknown_field / over_budget`。
- 产品库的上架前检查用同一个组件：必须项和建议项都由 `checkItem` 算，计数口径见 spec「校验」；建议项用 warning 图标，说明写「不拦上架」。保存返回 422 时，服务端 schema 的 issues 落到字段下方，不改这里的计数。

### 5.18 ⌘K

- 用 antd Modal：宽 640，距顶部 120，`--r-xl`，无动画。
- 输入行：高 48，内边距 0 16；18 的 `search`（text-3）加 16px 输入，无框，下方一条 `--divider`。
- 结果区：内边距 6，最高 400。
  - 按「页面 / {各实体} / 会话 / 操作」分组，分组标题 13/500 text-3，内边距 8 10 4。
  - 行高 36，`--r-sm`，内边距 0 10：16 图标（text-3）、14 text、右侧 13 text-3 的补充；当前行 `--selected`。
- 支持拼音和首字母（拼音库懒加载）。只用 ↑↓ 移动，Enter 打开；输入法组字时 Enter 不打开结果。**不响应不带修饰键的 J / K**：拼音是直接敲的拉丁字母，「jd」（酒店）「kh」（客户）这类查询要能输入。不带修饰键的 J / K 只留给焦点不在输入框里的列表（02 之后的工作台列表）。
- 各组的数据来源、加载、出错和没有结果的样子见 spec「外壳 · 搜索触发器」。没有结果时，结果区写 14 text：没有找到「{输入}」；下一行 13 text-2：换个说法，或者用拼音首字母；内边距 16。

### 5.19 分隔号 `Sep`

- `<span class="sep" aria-hidden="true">·</span>`：U+00B7 由 Geist 画，左右外边距各 6，颜色跟随所在的文字（text-3 在 14 号正文里太淡），两侧文字不打空格。生产组件另带一个给读屏断句的「，」（生成内容的替代文字，§2.5）。
- 用在状态句、次行、明细行、待办行的上下文里。
- 挤压和回退见 §2.5。

### 5.20 焦点

规则见 §3：按钮、链接、导航这一类是 2px `--focus` 外框，偏移 2（容器里偏移 −2）；输入框类控件是 accent 描边加 3px 光晕，不另画外框。

## 6. 字段类型渲染器

每种类型有三种形态：列表单元格、表单、只读。只读这一种同时用于三种情况：上架后锁定、没有编辑权限、匿名演示。

| 类型                | 存储                                                                   | 列表单元格                                                                             | 表单                                                                                                                                                                                                                                       | 只读 / 锁定                          | 配置项                                                    |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------- |
| text 文本           | string                                                                 | 14 text；首列 500，并且是链接                                                          | Input；有 `suggest` 时用 AutoComplete，联想来自已有值                                                                                                                                                                                      | 14 text                              | `placeholder` `suggest`                                   |
| longText 长文本     | string                                                                 | 默认不进列表；进列表时截成一行，悬停看全文                                             | TextArea（3–12 行），右下角字数；超过 `softMax` 时字数变成 warning 色，并提示「手机上会很长（建议 120 字以内）」，不拦                                                                                                                     | 16/28 段落，最宽 40em                | `softMax`                                                 |
| money 金额          | 整数（元）                                                             | 右对齐，等宽数字，千分位；单位写进表头，如「每人起价（元）」                           | InputNumber，千分位，只收整数，后缀是单位，如「元/人」                                                                                                                                                                                     | 「42,800 元/人」                     | `unit`，或 `unitFrom`（单位取另一个 enum 字段）           |
| intUnit 带单位整数  | 整数                                                                   | 右对齐，「8 天」「4,700 米」                                                           | InputNumber，后缀是单位                                                                                                                                                                                                                    | 「8 天」                             | `unit` `min` `max`                                        |
| monthRange 月份区间 | 字符串，如「5月-10月」「11月-次年4月」「全年」，由 `peakMonths()` 解析 | MonthStrip S，右边写文字（§6.1）                                                       | Input 加实时预览：MonthStrip L 和「识别出：5–10 月 · {monthMeaning}」。解析失败时报错「没认出月份：写成「5月-10月」「11月-次年4月」或「全年」」                                                                                            | MonthStrip L，加一行文字             | `monthMeaning`                                            |
| enum 枚举           | 单选存 string；多选存 string[]，或按 `storeAs` 连成字符串              | 单选写文字；**多选写成用「、」连起来的 14 text-2 纯文字**                              | 单选且 ≤5 项用分段控件（选填时最前面加一段「不填」）；多选且 ≤6 项用多选片；超过的用 Select                                                                                                                                                | 用「、」连起来的文字                 | `options` `multiple` `storeAs`                            |
| tags 开放标签       | string[]                                                               | Tag，最多 3 个，其余写「+N」                                                           | Select 的 tags 模式，带联想；锁定的成员不能删                                                                                                                                                                                              | 一排 Tag                             | `suggest` `lockedWhenActive.members`                      |
| boolean 是否        | boolean                                                                | 写 `trueLabel` 或 `falseLabel` 的文字，不画勾                                          | 必填：两段的分段控件，没有默认值；选填：开关，旁边写当前文字                                                                                                                                                                               | 写文字                               | `trueLabel` `falseLabel`                                  |
| subItems 有序子项   | 数组。只有一个 text 子字段时存 string[]                                | 写「8 天」「7 个节点」「4 条」                                                         | 单字段：逐条列表，每条一个输入框，带上移、下移、删除，底部「添加一条」。多字段：见 §6.3                                                                                                                                                    | 单字段写成列表；多字段写成只读时间轴 | `item` `itemNoun` `indexLabel` `countFrom` `autoIndexKey` |
| reference 引用      | 编号或名称文本                                                         | 被引用条目的名称，是链接；引用的条目是草稿时后面跟一个「草稿」状态；库里找不到的写原文 | Select 带搜索，每项显示名称、13 text-3 的编号和状态。`allowFree` 时改成 AutoComplete，可以写库外的文本，写了库外的值就在控件下方用 13 text-3 注「{实体名}库里没有这个，按原文保存」（这是提示，不是错误）。`multiple` 时显示成可删除的芯片 | 名称链接；多个时显示芯片             | `to` `store` `allowFree` `filterBy` `multiple`            |
| status 状态         | 系统字段 draft / active                                                | `Status`                                                                               | 不能直接编辑，要通过「上架…」这类操作改                                                                                                                                                                                                    | `Status`                             | —                                                         |

### 6.0 表单布局

- 字段按 `groups` 的顺序排成卡片（§5.9），卡片里的字段排成两列网格：列间距 24，字段之间 20，标签在上。
- 长类型占满一行：`longText`、`monthRange`、`tags`、多选 `enum`、多选 `reference`、单字段的 `subItems`。
- 多字段的 `subItems` 不进卡片网格，自成区块（§6.3）。`$status` 不进表单，它在页头和副栏里。
- 整张卡都锁定、只有短值时排成 4 列，见 §6.4（owner 2026-09-27）。
- 列数和跨行只看字段类型和锁定状态，不看是哪个行业包。

### 6.1 MonthStrip

- **S 号（列表）**：
  - 一条连续轨道，宽 96（每月 8），高 6，全圆角，`--month-off` 底。
  - 高亮区间画成连续的圆角条，用 `--month-on`。跨年区间（11月-次年4月）画两段。
  - 当前月是一根 2×12 的 text 色竖线，居中压在该月位置，外加 `0 0 0 1.5px var(--panel)` 镂空。
  - 右边 8 处写 13 text-2 文字：单段写「5–10 月」；多段写「4–6、9–10 月」；跨年写「10 月–次年 5 月」。「全年」时轨道全空，文字写字段的 `yearRoundLabel`，默认「全年」；旅游包的最佳季节写「全年（不加价）」。
- **L 号（表单、只读）**：
  - 12 格等宽，每格 28，总宽 336，高 28，`--subtle` 底，`--r-md`；格内是 13/20 text-3 的月份数字。
  - 选中区间画成连续的 `--accent-bg` 圆角段（`--r-sm`），段内数字用 accent-text 500。
  - 当前月在数字下方 3 处放一个 4px 的 text 色圆点。
  - 「全年」整条没有选中段，数字用 text-2。
- 两种都带 `role="img"` 和 `aria-label`，例如「最佳季节：5 月到 10 月」。

### 6.2 额度条

- 高 6，全圆角，底色 `--month-off`。每个可编辑节占一段，段间留 2px `--panel` 缝；改过的节用 `--accent`，没改的用 `--quota-off`。
- 95% 和 100% 处各画一根 1×12 的 text-2 刻度，刻度下方写 13 text-3 的「95%」「上限」。
- 标签 13/20 text-2，数字 text 500：「可编辑正文 **2,303 / 2,658** 字 · 87% · 还能写 355 字」。
- 标签下一行是图例，13 text-2：6px 圆角色块 `--accent`「改过的节」、色块 `--quota-off`「没改的节」、纯文字「固定规则节不计入」，项间隔 16。
- ≥95% 时文字和图标换成 warning；>100% 时换成 danger，并写「超出 38 字，发布会被拦下」。

### 6.3 有序子项编辑器

通用组件：旅游包里是逐日行程，家装包里是施工节点。

- **头部**：16/24/600，写成「逐日行程 · 5 天」。条数与 `countFrom` 对不上时，右侧用 13 warning 字写「还差 1 天」或「多了 1 天」。
- **左侧竖轴**：宽 40，1px `--border` 连线，节点直径 22。
  - **节点里写什么**：`indexLabel` 展开后不超过 3 个字符（「D1」「D12」）时写在节点里，13/500；更长的（「节点 3」）节点里只写序号「3」，完整标签写在卡片第一行，13/500 text-2。
  - 这一项全部填好：`--text-2` 实心底，`--panel` 色字。
  - 有缺项：`--panel` 底，加 `inset 0 0 0 1.5px var(--control-border)`，text-2 字；旁边用 13 warning 字写「缺：当晚住宿」，前面放 14 `triangle-alert`。
  - 有校验错误：同样空心，描边和字换成 `--danger`。
- **右侧每项一张卡片**：§5.9 的卡片，内边距 14 16，卡片之间间隔 12。卡片里按子字段的类型渲染。
  - 右上角三个 28 图标按钮：`arrow-up`「上移」、`arrow-down`「下移」、`trash-2`「删除这{itemNoun}」，都用 text-3。
  - 不能用的按钮（第一项的上移、最后一项的下移）降到 40% 不透明度，并设 `aria-disabled`。不做拖动。
- **底部**：「添加一{itemNoun}」，次要按钮，带 `plus` 图标。
- `autoIndexKey` 指定的字段（如 `day`）自动编号，只读；增删和移动以后自动重排。
- `countFrom` 指向的字段被锁定时，隐藏增删和移动按钮，头部右侧用 13 text-2 写「条数随{字段名}锁定，文字可改」。

### 6.4 锁定字段（上架后锁定）

- **不用禁用样式。** 值直接写 14/22 text（长文本用 16/28），不画输入框，可以选中复制。只读值顶部留 5，让它和旁边输入框里的文字对齐。
- 标签用 13/500 text-2。
  - 整卡都锁时，只在卡片头挂一次锁（§5.9），字段标签不挂锁，用 `aria-describedby` 指向卡片头的锁定说明。
  - 同一张卡里混有可改字段时，锁定字段的标签后挂 12 的 `lock`（text-3，`aria-label="上架后锁定"`），可改字段照常显示输入框。
- `$code`（编号）建好后永远只读，不论状态（`ALWAYS_LOCKED`）。
- **整卡锁定、只有短值的卡片排成 4 列**（owner 2026-09-27）：
  - 适用条件：卡片里 3 个及以上字段，全是只读的 text、intUnit、money、单选 enum。含 longText、monthRange、tags、subItems、reference 或任何输入框的卡片，仍是两列。
  - 写法：`grid-template-columns: repeat(4, minmax(0, auto))`，列间距 24。短值的列只占自己要的宽度，剩下的宽度平分到 4 列，所以线路名称这类长值完整显示。实在放不下才截断，悬停看全文。
  - 目的：让锁定卡少占一行，下面的有序子项在一屏里露出来。E 页「基本信息」的 4 列实测宽 178 / 244 / 108 / 95。
- 原因每组只说一次，写在卡片头：Tag「上架后锁定 · 计价」，下一行用 13 text-2 写原因，例如「已发给客户的方案书按这些数算价，改了会变价。急需修正请联系技术。」
- 只锁部分成员的标签字段（如「国内」）不在卡片头声明锁定：被锁的成员 Tag 带锁图标，悬停 Tooltip 写「上架后锁定 · 推荐：{reason}」。
- 草稿里那些「上架后会锁」的字段：标签后面加 13 text-3 的「上架后锁定」和 12 `lock`，提醒上架前重点核对。
- 没有编辑权限的角色看到只读形态，但不挂锁（这些字段并没有被锁），页头状态句末尾放一个「只读」胶囊（§5.6）。

### 6.5 改过的字段、差异、编辑器标记

- **改过还没保存的字段**：标签后 6 处放 6px 的 `--accent` 圆点，再放 13/500 accent-text「已改」。字段获得焦点或悬停时，出现 13 accent-text 链接「撤销这处」。不画左侧竖条。
- **话术编辑器**：
  - 改过的段落，在正文左侧 12 处的沟槽里画一根 2px 宽、与段落等高的 `--accent` 竖条（编辑器专用，像代码编辑器的改动沟槽）。
  - 新加的文字用 `--accent-bg` 底，`--r-xs`，左右各留 2。
- **差异**：
  - 新增行：`--success-bg` 底，行首 `--success`「+」。
  - 删除行：`--subtle` 底，text-2 字，删除线，行首 text-2「−」。删除不用红色。
    - 删除线写 `text-decoration-thickness: 1.5px`：Noto 默认的删除线很细，14 号中文里看不出来。
    - 「−」不用 text-3：回滚弹窗里差异块本身是 `--subtle` 底，删除行再叠一层，两层 subtle 叠在 raised 上，深色是 `#363638`，text-3 在这里只有 3.88:1，text-2 是 5.14:1（§1.2「嵌套的底」）。
  - 行内边距 2 8。
  - 标注用文字（「删去」「发出」），不只靠颜色。

### 6.6 工具名和字段名芯片（话术）

- 行内显示，高 22，内边距 0 6，`--r-sm`，`--subtle` 底，无描边。先写中文名 14/500 text，间隔 4，再写原名 `--mono` 12.5 text-3，如「查线路 search_routes」。话术原文不变，芯片只是一种显示方式。
- 话术原文里的 ✗、✓ 不在 Noto Sans SC 里，编辑器用 16 的 lucide `x`、`check` 图标显示，`aria-label` 仍是原字符；原文不变。
- 不认识的名字不做成芯片，只显示原文，下面画波浪线：`text-decoration: underline wavy var(--danger); text-decoration-thickness: 1.5px; text-underline-offset: 3px`。

### 6.7 会话相关

- **阶段条**（I 页和总览「客户停在哪一步」）：
  - 每行高 32，`--r-sm`，可点，悬停 `--hover`。
  - 从左到右：13 text-2 阶段名（宽 48）；条（高 8，`--r-xs`，`--bar` 色，长度按比例，没有轨道底）；14/500 text 的数字（宽 32，右对齐）。
  - 数为 0 的行不画条，数字用 text-3。
  - 阶段名和顺序来自行业包的 `stages`，不含 `terminal`。`branchOf` 阶段（异议）排在它的主阶段后面，阶段名前缩进 8。
- **会话列表首列**：16 的 `messages-square`（text-3），间隔 8，再写「企微客户 · F01」14/500。
- **气泡**（J 页）：
  - 客户的气泡：`--subtle` 底，`--r-lg`（左上角 4），内边距 8 12，14/22，最宽 560。
  - AI 的气泡：`--panel` 底加 `--shadow-card`，`--r-lg`（右上角 4）。
  - 系统行：13 text-3，居中。
- **交接卡**：`--subtle` 底，`--r-lg`，内边距 14 16，无描边。标题 14/500，各行 13/20 text-2，值用 text。

### 6.8 头像

- 圆形，24（侧栏、列表、总览时间线）或 28（审计）；里面是 13/500 的首字。
- 颜色：名字各字符的 UTF-16 码相加，mod 6 再加 1，得到 n，取 `--av{n}-bg` / `--av{n}-fg`（浅色最低 6.06:1，深色最低 7.99:1）。
- 命令行这类非人操作者：用 28（时间线里 24）的方块，`--r-sm`，`--subtle` 底，里面放 16 的 `square-terminal`（text-2）。

## 7. 图标

- 库：**lucide**（ISC），生产用 `lucide-react`（版本在实现时钉死），`strokeWidth={1.5} absoluteStrokeWidth`，即任何尺寸下线宽都是 1.5px，线端和拐角为圆头。取代 `@ant-design/icons` 的内容图标；antd 组件内部的小图标（排序、Tag 关闭、选择框箭头）能换就通过 `suffixIcon` / `closeIcon` 等属性换成 lucide，换不了的保留。
- 尺寸：16（导航、按钮、输入框、Alert、清单）、14（行内、芯片、箭头、Tag 里）、12（Tag 里的锁、排序）、20（空状态）。
- 颜色：`currentColor`。导航默认 text-3、选中 text；按钮和图标按钮 text-2；语义图标用对应语义色。
- 不做彩色图标底。实体图标由行业包配置给出 lucide 名称，只能取下面的实体图标集合。

| 用途                                                      | lucide 名                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 总览 / 销售话术 / 会话 / 审计日志 / 系统                  | `layout-dashboard` / `message-square-text` / `messages-square` / `history` / `settings`    |
| 旅游包：线路 / 酒店                                       | `route` / `bed-double`                                                                     |
| 家装包：装修套餐 / 主材                                   | `package` / `layers`                                                                       |
| 搜索 / 铃铛 / 租户与用户切换 / 收起侧栏 / 更多            | `search` / `bell` / `chevrons-up-down` / `panel-left` / `ellipsis`                         |
| 新建 / 关闭 / 勾 / 下拉 / 进入 / 新标签打开               | `plus` / `x` / `check` / `chevron-down` / `chevron-right` / `arrow-up-right`               |
| 锁定 / 只读 / 编辑 / 复制 / 下载 / 上传 CSV / 回滚 / 时间 | `lock` / `eye` / `pencil-line` / `copy` / `download` / `file-up` / `undo-2` / `clock`      |
| 上移 / 下移 / 删除                                        | `arrow-up` / `arrow-down` / `trash-2`                                                      |
| 信息 / 成功 / 留意 / 出错 / 没过 / 没跑                   | `info` / `circle-check` / `triangle-alert` / `circle-alert` / `circle-x` / `circle-dashed` |
| 命令行操作者 / 主题 / 退出                                | `square-terminal` / `sun`、`moon` / `log-out`                                              |

**实体图标集合**：行业包的 `EntityType.icon` 只能从下面这些 lucide 名称里选。console 只为它们打包图标组件，`checkPack` 校验；这样加一个行业包不用改 console。要用集合外的图标，改这张表和 console 的图标映射，不改页面。

`route` `bed-double` `package` `layers` `box` `boxes` `tag` `tags` `shopping-bag` `shopping-cart` `store` `gift` `ticket` `file-text` `briefcase` `building-2` `house` `car` `plane` `utensils` `shirt` `wrench` `graduation-cap` `stethoscope`

## 8. 落到 antd 6.6.5（`theme.ts`，亮暗各一份，值取 §1.1 对应列）

```ts
token: {
  colorPrimary: accent, colorPrimaryHover: '#1D53D5' /* 深 #2158DA */, colorPrimaryActive: '#0E42C3' /* 深 #1247C8 */, // 生成器：accent 的 L −0.05 / −0.10
  colorPrimaryBg: accentBg, colorPrimaryBorder: focus, colorPrimaryText: accentText, colorLink: accentText, colorLinkHover: accentText,
  colorBgSolid: primary, colorBgSolidHover: primaryHover, colorBgSolidActive: primaryActive,   // 墨色主按钮
  colorText: text, colorTextSecondary: text2, colorTextTertiary: text3, colorTextQuaternary: text3,
  colorTextPlaceholder: text3, colorTextDisabled: text3,
  colorBorder: controlBorder, colorBorderSecondary: border, colorSplit: divider,
  colorBgLayout: frame, colorBgContainer: panel, colorBgElevated: raised, colorBgSpotlight: text, colorBgMask: mask,
  colorFillQuaternary: hover, colorFillTertiary: subtle, colorFillSecondary: selected, colorFill: pressed, colorFillAlter: 'transparent',
  controlItemBgHover: hover, controlItemBgActive: selected, controlItemBgActiveHover: pressed,
  colorSuccess: success, colorWarning: warning, colorError: danger, colorInfo: info,
  colorSuccessBg: successBg, colorWarningBg: warningBg, colorErrorBg: dangerBg, colorInfoBg: infoBg,
  fontFamily: '"Geist","Noto Sans SC",system-ui,sans-serif',
  fontFamilyCode: '"Geist Mono","Noto Sans SC",ui-monospace,Menlo,Consolas,monospace',
  fontSize: 14, fontSizeSM: 13, fontSizeLG: 16, fontSizeHeading1: 24, fontSizeHeading2: 16, fontSizeHeading3: 15, lineHeight: 22 / 14,
  fontWeightStrong: 600, controlHeight: 32, controlHeightSM: 28, controlHeightLG: 40,
  borderRadiusXS: 4, borderRadiusSM: 6, borderRadius: 6, borderRadiusLG: 10, borderRadiusOuter: 6,
  boxShadow: shadowModal, boxShadowSecondary: shadowMenu, boxShadowTertiary: ring,
  motionDurationFast: '0.1s', motionDurationMid: '0.16s', motionDurationSlow: '0.2s', wireframe: false,
},
components: {
  Layout:    { siderBg: frame, bodyBg: frame, headerBg: frame, headerHeight: 52 /* 只在 <992 */ },
  Menu:      { itemHeight: 32, itemBorderRadius: 6, itemMarginInline: 0, itemMarginBlock: 2, itemPaddingInline: 8,
               itemBg: 'transparent', subMenuItemBg: 'transparent', itemColor: text2, itemHoverColor: text, itemHoverBg: hover,
               itemSelectedBg: selected, itemSelectedColor: text, itemActiveBg: pressed, activeBarWidth: 0, activeBarBorderWidth: 0,
               iconSize: 16, iconMarginInlineEnd: 8, groupTitleColor: text3, groupTitleFontSize: 13, collapsedWidth: 56 },
  Button:    { fontWeight: 500, paddingInline: 14, paddingInlineSM: 10, defaultBg: panel, defaultColor: text,
               defaultBorderColor: btnBorder, defaultHoverBorderColor: btnBorder, defaultHoverColor: text, defaultHoverBg: '#F5F5F5' /* 深 #1E1E20 */,
               defaultActiveBg: '#EBEBEB' /* 深 #2A2A2C */, defaultShadow: '0 1px 2px rgba(9,9,11,.05)', primaryShadow: 'none', dangerShadow: 'none',
               solidTextColor: onPrimary, textHoverBg: hover, textTextColor: text2 },
               // 主按钮：<Button color="default" variant="solid">；colorPrimary 不做按钮底
  Input:     { paddingInline: 10, hoverBorderColor: text3, activeBorderColor: accent, activeShadow: `0 0 0 3px ${accentRing}`,
               errorActiveShadow: `0 0 0 3px ${dangerRing}` },
  Select:    { optionHeight: 32, optionPadding: '5px 8px', optionSelectedBg: 'transparent', optionSelectedFontWeight: 500,
               optionActiveBg: hover, hoverBorderColor: text3, activeBorderColor: accent, activeOutlineColor: accentRing },
  Table:     { headerBg: 'transparent', headerColor: text3, headerSplitColor: 'transparent', headerBorderRadius: 0,
               borderColor: divider, rowHoverBg: hover, rowSelectedBg: selected, rowSelectedHoverBg: pressed,
               cellPaddingBlock: 10.5 /* 单行：10.5 + 22 + 10.5 + 1px 下边框 = 44（行高 44 含 antd td 的 1px border-bottom）；首列两行的行用 className 把上下内边距改成 5.5：5.5 + 22 + 2 + 20 + 5.5 + 1 = 56 */, cellPaddingInline: 12, headerSortActiveBg: 'transparent', headerSortHoverBg: hover, bodySortBg: 'transparent' },
  Tabs:      { inkBarColor: text, itemColor: text2, itemHoverColor: text, itemSelectedColor: text, itemActiveColor: text,
               horizontalItemGutter: 24, horizontalItemPadding: '9px 0', titleFontSize: 14 },
  Segmented: { trackBg: subtle, trackPadding: 2, itemColor: text2, itemHoverColor: text, itemHoverBg: 'transparent',
               itemSelectedBg: thumb, itemSelectedColor: text },
  Tag:       { defaultBg: subtle, defaultColor: text2 },                // <Tag variant="filled">
  Modal:     { contentBg: raised, headerBg: raised, footerBg: frame, titleFontSize: 16, titleLineHeight: 24 / 16,
               contentPadding: 0, headerPadding: '20px 24px 0', bodyPadding: '12px 24px 20px', footerPadding: '12px 24px',
               footerBorderTop: `1px solid ${divider}`, footerBorderRadius: '0 0 12px 12px', footerMarginTop: 0 },
  Drawer:    { footerPaddingBlock: 14, footerPaddingInline: 24 },   // 底栏 --frame 底写在 styles.footer
  Switch:    { trackHeight: 18, trackMinWidth: 32, handleSize: 14, handleBg: '#FFFFFF' },
  Tooltip:   { maxWidth: 240 },
  Message:   { contentBg: text, contentPadding: '9px 14px 9px 12px' },   // 反相 toast，字色在 className 里设 panel
}
```

`ConfigProvider`：

- `wave={{ disabled: true }}`
- 用户开了「减少动态效果」或系统设了 `prefers-reduced-motion` 时，`theme.token.motion` 传 `false`（§1.5）
- Tabs 统一 `animated={false}`
- 表单 `requiredMark` 设成只给选填字段加「（选填）」
- `button={{ autoInsertSpace: false }}`：antd 默认在两个汉字的按钮文字中间插一个空格（「关闭」成了「关 闭」），与 §2.5「中文不手打空格」相悖

全局样式里另写 §2.5 的 `text-spacing-trim` / `text-autospace` / `.halt`，以及 §5.19 的 `.sep` 与 `.sep-sr`。

## 9. 行业包配置

界面只读下面这份结构（`src/shared/pack.ts`），经 `GET /api/console/pack` 下发。旅游包的值取自真实代码，路径见各处注释，放在 `src/packs/travel/console-pack.ts`；家装包是假的，放在 `src/shared/pack-fixtures/renovation.ts`，只给自测和走查用，证明界面换一个包不需要改代码。

```ts
type FieldType =
  'text' | 'longText' | 'money' | 'intUnit' | 'monthRange' | 'enum' | 'tags' | 'boolean' | 'subItems' | 'reference' | 'status';

interface FieldDef {
  key: string; // payload 路径，如 'priceFrom'、'intensity.level'；'$code'、'$status'、'$updated' 是系统字段
  type: FieldType;
  label: string; // 中文标签，不带冒号
  group: string; // 表单分组 key
  help?: string; // 常驻在字段下方
  placeholder?: string; // 只放示例，以「例：」开头
  required?: boolean; // 默认 true；false 时标签后加「（选填）」
  lockedWhenActive?: true | { members: string[] }; // tags 可以只锁其中几项
  lockGroup?: string; // 指向 EntityType.lockGroups 的 key
  showWhen?: { key: string; filled: true }; // 条件显示；显示出来就必填
  unit?: string;
  unitFrom?: string;
  min?: number;
  max?: number; // intUnit、money 是数值上下限；数组类型（tags、多选 enum、subItems）的 min 是至少几项，拦上架
  softMax?: number; // longText
  options?: string[];
  multiple?: boolean; // enum
  storeAs?: { join: string; empty: string }; // enum 多选存成字符串
  suggest?: 'distinct' | string[]; // text / tags 的联想来源
  trueLabel?: string;
  falseLabel?: string; // boolean
  monthMeaning?: string; // monthRange 高亮月份的含义
  yearRoundLabel?: string; // monthRange 解析成「全年」时显示的文字，默认「全年」
  recommend?: true | { min?: number; max?: number }; // 不拦上架的建议项
  to?: string;
  store?: 'code' | 'label';
  allowFree?: boolean;
  filterBy?: string; // reference
  item?: FieldDef[];
  itemNoun?: string;
  indexLabel?: string; // subItems
  countFrom?: string;
  autoIndexKey?: string;
}

interface EntityType {
  kind: string; // URL 用：/catalog/{kind}
  label: string; // 导航和页标题用
  icon: string; // lucide 名称，只能取 §7 的实体图标集合
  codeLabel: string;
  codeExample: string;
  titleKey: string;
  subtitleKeys: string[]; // 列表首列的主行和次行
  groups: { key: string; label: string }[]; // 表单卡片，按顺序
  lockGroups: Record<string, { tag: string; reason: string }>;
  fields: FieldDef[];
  list: { columns: string[]; filters: string[]; search: string[]; defaultSort: '-$updated' };
  csvImport: boolean;
  activateLine: string; // 上架确认的第一句，{字段} 会被替换
}

interface IndustryPack {
  id: string;
  name: string;
  vocabulary: {
    customer: string;
    advisor: string;
    productNoun: string; // 总览上「在售{productNoun}」
    tools: Record<string, string>; // 工具原名 → 中文名，话术芯片用
    sopFields: Record<string, string>; // 话术可以点名的字段 → 中文名
  };
  entities: EntityType[];
  stages: { key: string; label: string; branchOf?: string; terminal?: boolean }[];
  sopSections: { key: string; heading: string | null; locked: boolean; lockReason?: string }[];
  nav: { catalogGroup: string; entities: string[] };
}
```

### 9.1 旅游包（真实）

```ts
const travel: IndustryPack = {
  id: 'travel',
  name: '旅游',
  vocabulary: {
    customer: '客户',
    advisor: '顾问',
    productNoun: '产品',
    tools: {
      search_routes: '查线路',
      get_route_detail: '看线路详情',
      search_hotels: '查酒店',
      create_quote: '算报价',
      generate_proposal: '生成方案书',
      create_order: '下单',
      handoff_to_human: '转人工',
    }, // src/tool-defs.ts
    sopFields: {
      altitudeNote: '海拔提示',
      bestSeason: '最佳季节',
      departDate: '出发日期',
      destinationMiss: '没有的目的地',
      intensityNote: '强度提示',
      maxBudgetPerPerson: '每人预算上限',
      maxNightlyPrice: '每晚预算上限',
      overBudget: '超出预算',
      payUrl: '付款链接',
      priceFrom: '起价',
      routeId: '线路编号',
      supersededOrderId: '作废的订单',
      withinBudget: '在预算内',
    }, // SOP_KNOWN_FIELDS
  },
  // src/types.ts SalesStage。'handoff' 不算阶段，它对应会话状态「等人接手」
  stages: [
    { key: 'greeting', label: '开场' },
    { key: 'discovery', label: '问需' },
    { key: 'recommend', label: '推荐' },
    { key: 'quote', label: '报价' },
    { key: 'objection', label: '异议', branchOf: 'quote' },
    { key: 'closing', label: '促成' },
    { key: 'paid', label: '已支付', terminal: true },
  ],
  // src/sop/sections.ts TRAVEL_SOP_SECTIONS；原因照 01 spec 的「节表」改写成人话
  sopSections: [
    { key: 'preamble', heading: null, locked: false },
    { key: 'stages', heading: '各阶段目标', locked: true, lockReason: '报价时机、出方案书、细节只按原文答，这些做法由代码逐条核对' },
    { key: 'orders', heading: '订单：改单、给别人再订、重发链接', locked: true, lockReason: '改单时作废旧订单的做法和下单工具绑在一起' },
    { key: 'tone', heading: '话术原则', locked: false },
    {
      key: 'quote-discipline',
      heading: '报价纪律（硬性）',
      locked: true,
      lockReason: '超出预算怎么说、按总价比预算，和算报价工具绑在一起',
    },
    {
      key: 'price-rules',
      heading: '定价规则（只有这两条，硬性）',
      locked: true,
      lockReason: '和算报价、价格护栏是同一套规则，改了会报出和系统不一致的价',
    },
    { key: 'objections', heading: '异议处理', locked: false },
    {
      key: 'capabilities',
      heading: '能力边界（硬性，先看这条）',
      locked: true,
      lockReason: '天数和住宿固定、顾问在微信上联系，这些承诺由代码守',
    },
    {
      key: 'no-destinations',
      heading: '我们没有的目的地（如南极、冰岛）',
      locked: true,
      lockReason: '没有的目的地怎么回、坚持才转人工，由代码判断',
    },
    {
      key: 'handoff',
      heading: '转人工条件（满足任一立即调用 handoff_to_human）',
      locked: true,
      lockReason: '什么时候转人工，要和系统的转人工判断一致',
    },
    { key: 'wechat-style', heading: '微信语气规范', locked: false },
  ],
  nav: { catalogGroup: '产品库', entities: ['route', 'hotel'] },
  entities: [route, hotel],
};

// 锁定表来自 src/shared/catalog.ts LOCKED_WHEN_ACTIVE；字段来自 data/routes.json、RouteSchema
const route: EntityType = {
  kind: 'route',
  label: '线路',
  icon: 'route',
  codeLabel: '线路编号',
  codeExample: 'r-sichuan-lux',
  titleKey: 'title',
  subtitleKeys: ['destination', '$code'],
  groups: [
    { key: 'basic', label: '基本信息' },
    { key: 'price', label: '价格与季节' },
    { key: 'fit', label: '适合谁去' },
    { key: 'days', label: '逐日行程' },
    { key: 'terms', label: '费用包含与不含' },
    { key: 'sell', label: '卖点' },
    { key: 'alias', label: '客户怎么叫' },
  ],
  lockGroups: {
    id: { tag: '识别', reason: '销售助手靠这些认出客户说的是哪条线，改名会让对话里的旧说法认不出来' },
    price: { tag: '计价', reason: '已发给客户的方案书按这些数算价，改了会变价' },
    terms: { tag: '条款', reason: '已发出的方案书按这些条款承诺' },
    rec: { tag: '推荐', reason: '推荐和安全护栏按这些筛线路，包括给长辈换低海拔线路、区分境内外' },
  },
  fields: [
    {
      key: '$code',
      type: 'text',
      label: '线路编号',
      group: 'basic',
      lockGroup: 'id', // 永远只读（ALWAYS_LOCKED）
      help: '小写字母、数字和连字符，建好后不能改',
      placeholder: '例：r-sichuan-lux',
    },
    {
      key: 'title',
      type: 'text',
      label: '线路名称',
      group: 'basic',
      lockedWhenActive: true,
      lockGroup: 'id',
      help: '写上目的地和天数',
      placeholder: '例：四川 稻城亚丁·色达秘境 8 日',
    },
    {
      key: 'destination',
      type: 'text',
      label: '目的地',
      group: 'basic',
      lockedWhenActive: true,
      lockGroup: 'id',
      suggest: 'distinct',
      help: '客户问「去哪」时按它匹配',
    },
    {
      key: 'days',
      type: 'intUnit',
      unit: '天',
      min: 1,
      max: 30,
      label: '天数',
      group: 'basic',
      lockedWhenActive: true,
      lockGroup: 'id',
      help: '要和逐日行程的天数一样',
    },
    {
      key: 'overseas',
      type: 'boolean',
      trueLabel: '境外',
      falseLabel: '境内',
      label: '境内还是境外',
      group: 'fit',
      lockedWhenActive: true,
      lockGroup: 'rec',
      help: '推荐和报价按它区分境内外',
    },
    {
      key: 'priceFrom',
      type: 'money',
      unit: '元/人',
      label: '每人起价',
      group: 'price',
      lockedWhenActive: true,
      lockGroup: 'price',
      help: '填淡季、4人以下的价；旺季上浮10%、4人及以上95折由系统算',
    },
    {
      key: 'bestSeason',
      type: 'monthRange',
      label: '最佳季节',
      group: 'price',
      lockedWhenActive: true,
      lockGroup: 'price',
      monthMeaning: '这些月份出发报价上浮10%，「全年」不加价',
      yearRoundLabel: '全年（不加价）',
    },
    {
      key: 'segments',
      type: 'enum',
      multiple: true,
      min: 1,
      options: ['家庭', '亲子', '蜜月', '商务', '银发'],
      label: '适合客群',
      group: 'fit',
      lockedWhenActive: true,
      lockGroup: 'rec',
      help: '可多选，推荐线路时按它筛',
    },
    {
      key: 'maxAltitude',
      type: 'intUnit',
      unit: '米',
      label: '全程最高海拔',
      required: false,
      recommend: true,
      group: 'fit',
      lockedWhenActive: true,
      lockGroup: 'rec',
      help: '按行程核实的最高点，给长辈挑线路时只看这个数',
    },
    {
      key: 'intensity.level',
      type: 'enum',
      options: ['轻松', '适中', '较累'],
      label: '体力强度',
      required: false,
      recommend: true,
      group: 'fit',
      help: '看最累的那天',
    },
    {
      key: 'intensity.hardest',
      type: 'text',
      label: '最累的一段',
      group: 'fit',
      showWhen: { key: 'intensity.level', filled: true },
      help: '照行程原文概括；行程没写步行量就写「行程没写」',
    },
    {
      key: 'itinerary',
      type: 'subItems',
      label: '逐日行程',
      group: 'days',
      countFrom: 'days',
      autoIndexKey: 'day',
      indexLabel: 'D{n}',
      itemNoun: '天',
      item: [
        { key: 'title', type: 'text', label: '当天标题', group: '', placeholder: '例：成都 → 丹巴' },
        { key: 'detail', type: 'longText', label: '当天安排', group: '', softMax: 120, help: '客户在手机上看，写清距离和用时' },
        {
          key: 'hotel',
          type: 'reference',
          to: 'hotel',
          store: 'label',
          allowFree: true,
          filterBy: 'destination',
          label: '当晚住宿',
          group: '',
          help: '最后一天可以写「—（返程）」',
        },
        {
          key: 'meals',
          type: 'enum',
          multiple: true,
          options: ['早', '午', '晚'],
          storeAs: { join: '/', empty: '—' },
          label: '当天餐食',
          group: '',
        },
      ],
    },
    {
      key: 'inclusions',
      type: 'subItems',
      item: [{ key: '', type: 'text', label: '', group: '' }],
      itemNoun: '条',
      label: '费用包含',
      required: false,
      recommend: true,
      group: 'terms',
      lockedWhenActive: true,
      lockGroup: 'terms',
    },
    {
      key: 'exclusions',
      type: 'subItems',
      item: [{ key: '', type: 'text', label: '', group: '' }],
      itemNoun: '条',
      label: '费用不含',
      required: false,
      recommend: true,
      group: 'terms',
      lockedWhenActive: true,
      lockGroup: 'terms',
    },
    { key: 'hotelLevel', type: 'text', label: '住宿档次', group: 'sell', suggest: 'distinct', placeholder: '例：顶级野奢' },
    {
      key: 'highlights',
      type: 'subItems',
      item: [{ key: '', type: 'text', label: '', group: '' }],
      itemNoun: '条',
      label: '行程亮点',
      group: 'sell',
      min: 1,
      recommend: { min: 3, max: 5 },
      help: '建议3–5条，每条以动词开头',
    },
    {
      key: 'tags',
      type: 'tags',
      label: '标签',
      group: 'sell',
      lockedWhenActive: { members: ['国内'] },
      lockGroup: 'rec',
      help: '其中「国内」上架后锁定',
    },
    {
      key: 'aliases',
      type: 'tags',
      label: '客户的其他叫法',
      required: false,
      recommend: true,
      group: 'alias',
      lockedWhenActive: true,
      lockGroup: 'id',
      help: '标题和目的地里没有、客户常说的叫法，如「川西」',
    },
    { key: '$status', type: 'status', label: '状态', group: 'basic' },
  ],
  list: {
    columns: ['title', 'days', 'priceFrom', 'bestSeason', 'segments', '$status', '$updated'],
    filters: ['destination', 'overseas', 'segments'],
    search: ['title', 'destination', 'aliases', '$code'],
    defaultSort: '-$updated',
  },
  csvImport: false,
  activateLine: '上架后，销售助手会立即向客户推荐这条线路，并按每人 {priceFrom} 起报价',
};

const hotel: EntityType = {
  kind: 'hotel',
  label: '酒店',
  icon: 'bed-double',
  codeLabel: '酒店编号',
  codeExample: 'h-songtsam-meili',
  titleKey: 'name',
  subtitleKeys: ['destination', '$code'],
  groups: [
    { key: 'basic', label: '基本信息' },
    { key: 'price', label: '价格' },
    { key: 'sell', label: '卖点' },
  ],
  lockGroups: {
    id: { tag: '识别', reason: '销售助手靠这些认出客户说的是哪家酒店，改名会让对话里的旧说法认不出来' },
    price: { tag: '计价', reason: '已发给客户的方案书按这个价算，改了会变价' },
  },
  fields: [
    { key: '$code', type: 'text', label: '酒店编号', group: 'basic', lockGroup: 'id' },
    { key: 'name', type: 'text', label: '酒店名称', group: 'basic', lockedWhenActive: true, lockGroup: 'id' },
    { key: 'destination', type: 'text', label: '目的地', group: 'basic', lockedWhenActive: true, lockGroup: 'id', suggest: 'distinct' },
    { key: 'stars', type: 'text', label: '星级档次', group: 'basic', suggest: 'distinct', placeholder: '例：五星、顶奢' },
    { key: 'nightlyFrom', type: 'money', unit: '元/晚', label: '每晚起价', group: 'price', lockedWhenActive: true, lockGroup: 'price' },
    { key: 'roomType', type: 'text', label: '主推房型', group: 'sell', placeholder: '例：水上别墅' },
    {
      key: 'highlights',
      type: 'subItems',
      item: [{ key: '', type: 'text', label: '', group: '' }],
      itemNoun: '条',
      label: '酒店亮点',
      group: 'sell',
      min: 1,
    },
    { key: 'tags', type: 'tags', label: '标签', group: 'sell' }, // 必填只要求键存在，可以是 []（HotelSchema 的 tags: texts）
    { key: '$status', type: 'status', label: '状态', group: 'basic' },
  ],
  list: {
    columns: ['name', 'stars', 'nightlyFrom', 'roomType', 'tags', '$status', '$updated'],
    filters: ['destination'],
    search: ['name', 'destination', '$code'],
    defaultSort: '-$updated',
  },
  csvImport: true,
  activateLine: '上架后，销售助手会向客户推荐这家酒店，并按每晚 {nightlyFrom} 起介绍',
};
```

### 9.2 家装整装包（假的，证明通用）

```ts
const renovation: IndustryPack = {
  id: 'renovation',
  name: '家装整装',
  vocabulary: {
    customer: '业主',
    advisor: '设计顾问',
    productNoun: '产品',
    tools: {
      search_packages: '查套餐',
      get_package_detail: '看套餐详情',
      search_materials: '查主材',
      create_estimate: '算估价',
      book_measure: '预约量房',
      handoff_to_human: '转人工',
    },
    sopFields: { pricePerSqm: '每平米单价', minArea: '起装面积', measureSlot: '量房时段' },
  },
  stages: [
    { key: 'consult', label: '咨询' },
    { key: 'measure', label: '量房' },
    { key: 'design', label: '方案' },
    { key: 'quote', label: '报价' },
    { key: 'sign', label: '签约' },
    { key: 'deposit', label: '已付定金', terminal: true },
  ],
  sopSections: [
    { key: 'preamble', heading: null, locked: false },
    { key: 'stages', heading: '各阶段目标', locked: true, lockReason: '量房、出方案、报价的顺序由代码核对' },
    { key: 'tone', heading: '话术原则', locked: false },
    { key: 'pricing', heading: '报价规则（硬性）', locked: true, lockReason: '和算估价工具是同一套规则' },
    { key: 'measure', heading: '量房预约规则', locked: true, lockReason: '可约时段来自预约工具' },
    { key: 'objections', heading: '异议处理', locked: false },
    { key: 'capabilities', heading: '能力边界（硬性）', locked: true, lockReason: '工期和增项承诺由代码守' },
    { key: 'handoff', heading: '转人工条件', locked: true, lockReason: '要和系统的转人工判断一致' },
    { key: 'wechat-style', heading: '微信语气规范', locked: false },
  ],
  nav: { catalogGroup: '产品库', entities: ['package', 'material'] },
  entities: [pkg, material],
};

const pkg: EntityType = {
  kind: 'package',
  label: '装修套餐',
  icon: 'package',
  codeLabel: '套餐编号',
  codeExample: 'p-nuanmu-2r',
  titleKey: 'title',
  subtitleKeys: ['$code'],
  groups: [
    { key: 'basic', label: '基本信息' },
    { key: 'price', label: '价格' },
    { key: 'fit', label: '适合谁' },
    { key: 'terms', label: '施工与条款' },
    { key: 'nodes', label: '施工节点' },
    { key: 'sell', label: '卖点' },
  ],
  lockGroups: {
    id: { tag: '识别', reason: '销售助手靠名称认出业主说的是哪个套餐' },
    price: { tag: '计价', reason: '已发出的估价单按这些数算，改了会变价' },
    terms: { tag: '条款', reason: '已签的合同按这些条款施工' },
    rec: { tag: '推荐', reason: '推荐套餐时按户型筛' },
  },
  fields: [
    { key: '$code', type: 'text', label: '套餐编号', group: 'basic', lockGroup: 'id' },
    { key: 'title', type: 'text', label: '套餐名称', group: 'basic', lockedWhenActive: true, lockGroup: 'id' },
    { key: 'pricePerSqm', type: 'money', unit: '元/㎡', label: '每平米单价', group: 'price', lockedWhenActive: true, lockGroup: 'price' },
    { key: 'minArea', type: 'intUnit', unit: '㎡', label: '起装面积', group: 'price', lockedWhenActive: true, lockGroup: 'price' },
    {
      key: 'houseTypes',
      type: 'enum',
      multiple: true,
      options: ['一居', '两居', '三居', '四居及以上', '别墅'],
      label: '适用户型',
      group: 'fit',
      lockedWhenActive: true,
      lockGroup: 'rec',
    },
    { key: 'styles', type: 'tags', label: '风格', group: 'fit', suggest: ['现代简约', '奶油', '原木', '新中式', '轻法式'] },
    { key: 'startMonths', type: 'monthRange', label: '适合开工月份', group: 'fit', monthMeaning: '施工旺季，排期要提前4周' },
    { key: 'duration', type: 'intUnit', unit: '天', label: '工期', group: 'terms', lockedWhenActive: true, lockGroup: 'terms' },
    {
      key: 'demolition',
      type: 'boolean',
      trueLabel: '含拆旧',
      falseLabel: '不含拆旧',
      label: '拆旧',
      group: 'terms',
      lockedWhenActive: true,
      lockGroup: 'terms',
    },
    {
      key: 'materials',
      type: 'reference',
      to: 'material',
      store: 'code',
      multiple: true,
      label: '包含主材',
      group: 'terms',
      lockedWhenActive: true,
      lockGroup: 'terms',
    },
    {
      key: 'nodes',
      type: 'subItems',
      label: '施工节点',
      group: 'nodes',
      indexLabel: '节点{n}',
      itemNoun: '个节点',
      item: [
        { key: 'name', type: 'text', label: '节点名称', group: '', placeholder: '例：水电' },
        { key: 'days', type: 'intUnit', unit: '天', label: '工期', group: '' },
        { key: 'checkpoints', type: 'longText', softMax: 80, label: '验收要点', group: '' },
        {
          key: 'materials',
          type: 'reference',
          to: 'material',
          store: 'code',
          multiple: true,
          required: false,
          label: '用到的主材',
          group: '',
        },
      ],
    },
    {
      key: 'highlights',
      type: 'subItems',
      item: [{ key: '', type: 'text', label: '', group: '' }],
      itemNoun: '条',
      label: '卖点',
      group: 'sell',
    },
    { key: '$status', type: 'status', label: '状态', group: 'basic' },
  ],
  list: {
    columns: ['title', 'houseTypes', 'pricePerSqm', 'minArea', 'duration', 'startMonths', '$status', '$updated'],
    filters: ['houseTypes', 'styles'],
    search: ['title', 'styles', '$code'],
    defaultSort: '-$updated',
  },
  csvImport: false,
  activateLine: '上架后，销售助手会向业主推荐这个套餐，并按每平米 {pricePerSqm} 估价',
};

const material: EntityType = {
  kind: 'material',
  label: '主材',
  icon: 'layers',
  codeLabel: '主材编号',
  codeExample: 'm-marcopolo-800',
  titleKey: 'name',
  subtitleKeys: ['category', '$code'],
  groups: [
    { key: 'basic', label: '基本信息' },
    { key: 'price', label: '价格' },
    { key: 'terms', label: '质保与环保' },
  ],
  lockGroups: { price: pkg.lockGroups.price },
  fields: [
    { key: '$code', type: 'text', label: '主材编号', group: 'basic' },
    { key: 'name', type: 'text', label: '主材名称', group: 'basic' },
    { key: 'category', type: 'enum', options: ['瓷砖', '地板', '橱柜', '卫浴', '门窗', '涂料'], label: '品类', group: 'basic' },
    { key: 'brand', type: 'text', label: '品牌', group: 'basic', suggest: 'distinct' },
    {
      key: 'priceUnit',
      type: 'enum',
      options: ['㎡', '延米', '件', '套'],
      label: '计价单位',
      group: 'price',
      lockedWhenActive: true,
      lockGroup: 'price',
    },
    { key: 'unitPrice', type: 'money', unitFrom: 'priceUnit', label: '单价', group: 'price', lockedWhenActive: true, lockGroup: 'price' },
    { key: 'warrantyYears', type: 'intUnit', unit: '年', label: '质保', group: 'terms' },
    { key: 'ecoGrade', type: 'enum', options: ['ENF级', 'E0级', 'E1级'], label: '环保等级', required: false, group: 'terms' },
    { key: '$status', type: 'status', label: '状态', group: 'basic' },
  ],
  list: {
    columns: ['name', 'category', 'brand', 'unitPrice', 'warrantyYears', '$status', '$updated'],
    filters: ['category'],
    search: ['name', 'brand', '$code'],
    defaultSort: '-$updated',
  },
  csvImport: true,
  activateLine: '上架后，套餐和销售助手可以引用这件主材，按 {unitPrice} 计价',
};
```

说明：

- `$code` 是条目编号，也就是 payload 的 `id`（01 的约定：条目的 id 就是编号）；`$status`、`$updated` 取自 `CatalogItem` 的 `status`、`updatedAt`、`updatedByName`。
- `EntityType.icon`：实体图标，写 lucide 名称，只能取 §7 的实体图标集合。旅游包 route 用 `'route'`、hotel 用 `'bed-double'`；家装包 package 用 `'package'`、material 用 `'layers'`。
- `FieldDef.yearRoundLabel`：monthRange 解析成「全年」时显示的文字，默认「全年」。旅游包 `bestSeason` 配成 `'全年（不加价）'`。这句原来写死在 MonthStrip 里，属于旅游包自己的说法。
- **数组类型的 `required`**（tags、多选 enum、subItems）只要求键存在，可以是空数组，与 schema 一致：线路和酒店的 `tags` 是必填，但允许 `[]`。要至少几项用 `min`（拦上架，如行程亮点、酒店亮点、适合客群 `min: 1`）；有序子项的 `countFrom` 已经隐含至少一项。
- `FieldDef.recommend`：不拦上架的建议项。`true` 表示「建议填」，没填时写「{label}没填（不拦上架）」；`{ min, max }` 用于 subItems 和 tags 的条数，写「{label}建议{min}–{max}{itemNoun}」。
- 旅游包里 `vocabulary.tools` 的键、`sopFields` 的键、`sopSections` 的 key 与顺序与 `locked`、带 `lockedWhenActive` 的字段、`stages` 的 key，都由 `src/packs/packs.selftest.ts` 与代码逐项核对（spec 不变量 14）。

## 10. 逐页设计

### 10.0 共同约定

- 页面编号（A、B…P）与 spec 的「逐页设计」一一对应。需要 02 后端的页面，标题前写「02 后端到位后 · 」。
- 尺寸以宽 1440 的窗口为准；下面说的坐标都相对内容面板的左上角，x 从内容区左边（面板左边往里 32）算起。
- 颜色只取 §1 的令牌。只有 L 页按 §1.3 的表替换主色那一组，用来演示租户品牌色。
- 样张用的是下面这组场景数据；它同时是走查的种子数据（spec 验收 4、6、10）。

**场景数据**：所有页面共用同一个时刻，2026 年 9 月 26 日（周六）14:30。

- 租户：云途定制旅行，旅游包。
- 人：老板（所有者），小林（管理员）。
- 话术：
  - v1：系统导入，9 月 24 日 10:02。
  - v2：老板发布于 9 月 25 日 18:30，变更说明「客户嫌贵时先问预算上限，再给两档方案」，改了 1 节（异议处理 496 → 531 字）。
  - 草稿基于 v2：改了 2 节，话术原则 910 → 954（+44），异议处理 531 → 540（+9）；已自动保存 14:05。
  - 可编辑正文 2,303 / 2,658 字（87%）。各节字数：前言 232、话术原则 954、异议处理 540、微信语气规范 577。固定规则节：各阶段目标 3,117、订单 448、报价纪律 638、定价规则 559、能力边界 779、没有的目的地 317、转人工条件 514。
  - 草稿里有 1 处问题：话术原则第一条把 `search_routes` 写成了 `search_route`。
- 线路：21 条，20 条已上架（data/routes.json 原样，更新人写「系统导入 · 9月24日」），外加 1 条草稿。
  - 草稿是小林 13:40 用「复制为新草稿」从 r-guizhou 建的：编号 r-guizhou-5d，名称「贵州 小七孔·西江千户苗寨 5 日」，目的地贵州，境内，5 天，每人起价 13,800，最佳季节 4月-10月，适合客群家庭、亲子、银发，最高海拔 1,200 米，其他叫法「黔东南」，标签国内、贵州、非遗手作、亲子，费用包含 7 条，费用不含 5 条。
  - r-sichuan-lux 由小林在 10:12 改过住宿档次和行程亮点。
- 酒店：23 家已上架（data/hotels.json 原样），外加小林 11:20 从 CSV 导入的 6 条草稿（H 里合格的 6 行）。
- 会话：`scripts/seed-demo.py --scenario console-ux --now 2026-09-26T14:30+08:00` 生成的 13 个种子会话（spec 验收 4「走查种子与时钟」）。与脚本的默认场景相比，A01 改成转人工（`stage: 'handoff'`、`handedOver: true`），各会话的最后动静按下表相对 `--now` 定位。短码按 `shortIdOf` 算（如 wecom:cust_A01 → A01）。

| 会话               | 状态      | 阶段   | 消息 | 最后动静   |
| ------------------ | --------- | ------ | ---- | ---------- |
| 企微客户 · F01     | 等人接手  | —      | 2    | 8 分钟前   |
| 企微客户 · A01     | 等人接手  | —      | 7    | 26 分钟前  |
| 企微客户 · B01     | AI 接待中 | 促成   | 4    | 1 小时前   |
| 企微客户 · C01     | AI 接待中 | 报价   | 4    | 2 小时前   |
| 企微客户 · C02     | AI 接待中 | 报价   | 4    | 3 小时前   |
| 企微客户 · D01     | AI 接待中 | 推荐   | 2    | 5 小时前   |
| 企微客户 · D02     | AI 接待中 | 推荐   | 2    | 昨天 21:40 |
| 企微客户 · D03     | AI 接待中 | 推荐   | 2    | 昨天 16:05 |
| 企微客户 · E01–E04 | AI 接待中 | 问需   | 各 2 | 9月24日    |
| 企微客户 · A02     | 已成交    | 已支付 | 5    | 9月24日    |

合计 13 个：等人接手 2，AI 接待中 10，已成交 1。AI 接待中按阶段分：开场 0、问需 4、推荐 3、报价 2、异议 0、促成 1。

- 审计（新的在前）：
  - 今天 13:40 小林 新建了线路草稿「贵州 小七孔·西江千户苗寨 5 日」
  - 今天 11:20 小林 新建了 6 条酒店草稿。这 6 条是 CSV 导入的，但审计和手动新建一样都记 `catalog.create`，diff 形状也相同，句子里不写来源；要显示来源，得另给审计 diff 加 `source`。连续的同类操作合并成一句，展开能看到每一条。
  - 今天 10:12 小林 修改了线路「四川 稻城亚丁·色达秘境 8 日」的 住宿档次、行程亮点
  - 9月25日 18:30 老板 发布了话术 v2，改了 1 节（异议处理）
  - 9月24日 10:05 命令行 为 xiaolin@yuntu.test 建了账号（角色：管理员）
  - 9月24日 10:03 命令行 为 boss@yuntu.test 建了账号（角色：所有者）
  - 9月24日 10:02 命令行 导入了初始配置
  - 9月24日 10:01 命令行 建了租户
- 02 的场景另外加一个会话「企微客户 · 7F3A」，对话用一段真实模型回放（贵州带爸妈 4 人，11 月 8 日出发）。订单：A01 已付 105,600 元，A02 已付 101,840 元，B01 待付款 85,600 元。本月成交额 207,440 元。

**场景数据的修正**（早先样张之间的几处矛盾，在这里定下来）：

1. **「需要你处理」的顺序**：规则是「等人接手的在前，最后动静早的在前」，所以 A01（26 分钟前）排在 F01（8 分钟前）前面。会话列表（I 页）的规则不同：等人接手的在前，其余按最后动静倒序，所以 I 页里 F01 在前。
2. **草稿线路 r-guizhou-5d**：小林 13:40 建的，此后没保存过，`updatedAt` 就是今天 13:40。F、G 页的状态句写「上架后13项会锁定 · 小林更新于今天13:40」，与审计一致。
3. **今天有新动静的会话**：6 个，F01、A01、B01、C01、C02、D01。D01 在 5 小时前，也就是 9:30。
4. **导航计数**：线路 21，酒店 29（23 家已上架，加 6 条草稿）。
5. **02 场景**（A2、J 两页）：共 14 个会话，即 13 个加上 7F3A。
   - 7F3A：等人接手，14:18 转人工，到 14:30 等了 12 分钟。
   - F01：等人接手，原因「客户投诉价格太贵」，14:22 转人工，等了 8 分钟。
   - A01：顾问处理中，接手人是小林。
   - 计数：等人接手 2，顾问处理中 1，AI 接待中 10，已成交 1。铃铛徽标 2，浏览器标签页标题「(2) 会话 · 云途定制旅行」。
6. **H 页**画的是小林 11:20 那次导入的第 3 步，所以背景里的酒店列表是导入前的 23 家。
7. **N 页**的四个哈希用 01 线上切换时记下的真实值（01 plan 第 17 步）：prompt `6c202d633b60`、tools `64c16fc8f464`、prefix `cd3cc7dab87a`、sop `396b2514bfbf`。
8. **草稿的最后保存时间**：接口里没有。B 页状态句里的「已自动保存14:05」只在本次打开页面后自己保存过时出现；A 页第 3 行不写保存时间（spec 开放问题 6）。
9. **产品库条目只有更新人和更新时间**，分不出「新建」还是「更新」，也看不出是不是 CSV 导入：A 页第 4、5 行写「小林更新于13:40」「小林更新于11:20」。
10. **必须项的数目**按 spec「校验」的口径：r-guizhou-5d 有 12 个必填字段（线路编号、线路名称、目的地、天数、境内还是境外、每人起价、最佳季节、适合客群、逐日行程、住宿档次、行程亮点、标签），加「条数与天数一致」，共 13 项。A、F 页写「必须项13/13」；样张上画的「9/9」没有重画，以本文为准。

### 10.1 页面清单（16 页）

| #   | 编号与标题                             | 设计尺寸  | 身份            | 侧栏                      | 什么时候做                           |
| --- | -------------------------------------- | --------- | --------------- | ------------------------- | ------------------------------------ |
| 1   | A · 总览（待办中心）                   | 1440×1040 | 老板（所有者）  | 展开，总览                | 今天                                 |
| 2   | M · 总览深色（个人偏好）               | 1440×1040 | 老板            | 展开，用户菜单打开        | 今天                                 |
| 3   | 02 后端到位后 · A2 · 需要你处理        | 1440×488  | 老板            | 只画区块                  | 02 之后                              |
| 4   | B · 销售话术编辑（有1处检查问题）      | 1440×1100 | 老板            | 收起 56                   | 今天                                 |
| 5   | C · 版本记录 + 回滚确认                | 1440×900  | 老板            | 收起 56                   | 今天                                 |
| 6   | D · 产品库列表（旅游包：线路）         | 1440×900  | 小林（管理员）  | 展开，线路                | 今天                                 |
| 7   | E · 已上架线路编辑（锁定字段）         | 1440×1100 | 小林            | 展开，线路                | 今天                                 |
| 8   | F · 草稿上架确认                       | 1440×900  | 小林            | 展开，线路                | 今天                                 |
| 9   | G · 有序子项编辑（旅游包里是逐日行程） | 1440×1100 | 小林            | 展开，线路                | 今天                                 |
| 10  | H · CSV导入（有2行不合格）             | 1440×1100 | 小林            | 展开，酒店                | 今天                                 |
| 11  | L · 同一套界面换成家装整装包           | 1440×1800 | 松间整装 · 老板 | 展开，装修套餐            | 今天（假包走查；换主色要品牌色后端） |
| 12  | I · 会话列表（今天的数据）             | 1440×1100 | 老板            | 展开，会话                | 今天                                 |
| 13  | 02 后端到位后 · J · 会话工作台         | 1440×900  | 小林            | 收起 56                   | 02 之后                              |
| 14  | K · 审计日志                           | 1440×900  | 老板            | 展开，审计日志            | 今天                                 |
| 15  | N · 系统（只给平台管理员）             | 1440×900  | 平台管理员      | 展开，多出「平台 / 系统」 | 要后端                               |
| 16  | P · 字体与标点（验收页）               | 1440×1100 | —               | 无外壳                    | 今天，只在走查构建里                 |

所有页面的外壳都照 §4：侧栏 240（B、C、J 收成 56），内容面板内嵌，内容宽 1128（收起时 1312）。

### 10.2 各页

**A · 总览（待办中心）**：1440×1040。面板高 1024。

目标：一眼看到要处理的事，每件事带着足够的上下文，不点进去也知道轻重。数据全部来自今天的接口和 §10.0 的场景，不画趋势、迷你图、涨跌百分比、回放、模型信息，也不画转人工原因和等待时长（那两项在 A2）。

- **PageHeader**（y 24–80）：标题「总览」；状态句「云途定制旅行 · 9月26日 周六」；没有按钮。
- **① 需要你处理**（y 100，页头下 20；区块头 §5.11）：
  - 区块头：标题「需要你处理」、计数「5项」，右侧链接「全部会话」。
  - 列表从 y 132 开始，5 行，每行 64，到 y 452，用待办行（§5.11）：

  | #   | 图标块                     | 类型             | 第一行（对象）                               | 第二行（上下文，各段用 Sep 隔开）                                                      | 操作                                  |
  | --- | -------------------------- | ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- |
  | 1   | `messages-square`          | 状态「等人接手」 | 企微客户 · A01                               | 企业微信 · 7条消息 · 最后动静26分钟前                                                  | 幽灵「打开工作台」＋ `arrow-up-right` |
  | 2   | `messages-square`          | 状态「等人接手」 | 企微客户 · F01                               | 企业微信 · 2条消息 · 最后动静8分钟前                                                   | 同上                                  |
  | 3   | `message-square-text`      | 「话术草稿」     | 改了2节：话术原则（+44字）、异议处理（+9字） | 〔danger，前置 `circle-alert`〕1个问题：话术原则里有个工具名写错了 · 发布前检查6/7通过 | 幽灵「继续编辑」＋ `chevron-right`    |
  | 4   | `route`（行业包图标）      | 「待上架」       | 线路草稿「贵州 小七孔·西江千户苗寨 5 日」    | 小林更新于13:40 · 必须项13/13已过 · 建议1条没做：体力强度没填（不拦上架）              | 幽灵「去上架」＋ `chevron-right`      |
  | 5   | `bed-double`（行业包图标） | 「待上架」       | 6条酒店草稿                                  | 小林更新于11:20 · 青城山六善酒店、成都锦江宾馆、大研安缦等6家                          | 幽灵「逐条检查」＋ `chevron-right`    |
  - 排序：等人接手的在前，最后动静早的在前；接着是话术草稿，然后是待上架（按时间倒序）。
  - 第 3 行不写工具原名：首页面向老板，原名只在话术编辑器里出现。

- **② 系统状态**（y 480，高 22）：照 §5.11 的系统状态行。
- **③ 业务数**（y 530，4 个 KPI 格，§5.10，格高 160，到 y 690）：

  | 名称     | 数字 | 口径                                | 明细行                      | 点了去                  |
  | -------- | ---- | ----------------------------------- | --------------------------- | ----------------------- |
  | 会话     | 13   | 企业微信里的客户会话，不含网页试聊  | 今天有新动静的6个           | 会话列表                |
  | 等人接手 | 2    | AI已转人工、还没成交的会话          | 最后动静：26分钟前、8分钟前 | 会话列表 · 等人接手页签 |
  | 已成交   | 1    | 阶段到了「已支付」的会话            | 企微客户 · A02 · 9月24日    | 会话列表 · 已成交页签   |
  | 在售产品 | 43   | 线路20 · 酒店23，销售助手只推荐这些 | 另有草稿7条：线路1 · 酒店6  | 线路列表                |
  - 明细行只写接口里现成的数：会话的 `updatedAt`、状态和短码，产品库各状态的计数。
  - 「最后动静」不说成「等了多久」。

- **④ 底部两栏**（y 722）：左栏宽 720，间隔 40，右栏宽 368。
  - **左栏「最近变更」**：只给所有者和管理员看。区块头只有标题，没有计数。时间线（§5.11）从 y 754 开始，5 行，到 y 954；y 962 放「查看全部」链接，到 y 982。

    | 时间          | 头像                   | 句子（加粗的部分用 500）                                                   |
    | ------------- | ---------------------- | -------------------------------------------------------------------------- |
    | 今天 13:40    | 林                     | **小林** 新建了线路草稿「**贵州 小七孔·西江千户苗寨 5 日**」               |
    | 11:20         | 林                     | **小林** 新建了6条酒店草稿                                                 |
    | 10:12         | 林                     | **小林** 修改了线路「**四川 稻城亚丁·色达秘境 8 日**」的住宿档次、行程亮点 |
    | 9月25日 18:30 | 老                     | **老板** 发布了话术v2，改了1节（异议处理）                                 |
    | 9月24日 10:05 | `square-terminal` 方块 | **命令行** 为xiaolin@yuntu.test建了账号（角色：管理员）                    |

  - **右栏「客户停在哪一步」**：
    - 区块头：标题，加计数「AI接待中的10个」，右侧链接「会话」。
    - 阶段条（§6.7）从 y 754 开始，6 行，每行 32，到 y 946：开场 0、问需 4、推荐 3、报价 2、异议 0（缩进 8）、促成 1。
    - 条区宽 248，按最大值 4 缩放：4 → 248，3 → 186，2 → 124，1 → 62。
    - y 954 写 13 text-3「按每个会话现在所处的阶段统计」。
    - 每行都可点，跳到会话列表并按该阶段筛选。
  - 没有「最近变更」权限的角色看不到左栏，右栏挪到左栏的位置，宽度不变。
- 内容到 y 982 结束，面板底部留白 42。

**M · 总览深色**：1440×1040，`data-theme="dark"`。内容与 A 完全相同，另外画出用户菜单打开的样子（§4.2 第 5 项）：

- 菜单从侧栏底部的用户行向上弹出，宽 240。
  - 身份块：老板 / boss@yuntu.test · 所有者。
  - 「外观」右侧写「深色」，子菜单向右弹出，压在面板左边上：浅色（默认）/ 深色（勾）/ 跟随系统。
  - 「减少动态效果」开关：关，轨道 `--control-border`，滑块白色。
  - 「关于」，然后「退出登录」。
- 菜单不加遮罩。

**02 后端到位后 · A2 · 需要你处理**：1440×488。

- 样张只画「需要你处理」这一块和右侧一个 KPI 格：`--frame` 底上一块面板 x 8–1432、y 8–480，内边距 24 32，内容宽 1360。落进总览时，它替换 A 页的「需要你处理」；「本月成交额」格放在哪里，随 02 的总览一起定。
- 左侧列表宽 1047，间隔 40，右侧一个 KPI 格，宽 273。
- 区块头（y 24）：「需要你处理」「6项」，右侧链接「全部会话」。列表 y 56–440，6 行，每行 64：

  | #   | 图标块            | 类型       | 第一行                          | 第二行                                                                           | 操作                               |
  | --- | ----------------- | ---------- | ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
  | 1   | `messages-square` | 等人接手   | 企微客户 · 7F3A · 贵州带爸妈4人 | 原因：客户要把6天压缩到4天，现成线路没有 · 〔danger，前置 14 `clock`〕等了12分钟 | 次要小按钮「接手」                 |
  | 2   | `messages-square` | 等人接手   | 企微客户 · F01                  | 原因：客户投诉价格太贵 · 〔warning，前置 `clock`〕等了8分钟                      | 次要小按钮「接手」                 |
  | 3   | `messages-square` | 「待付款」 | 企微客户 · B01 · 巴厘岛2人      | 85,600元 · 下单2小时未付                                                         | 幽灵「打开会话」＋ `chevron-right` |
  | 4–6 | 同 A 的第 3–5 行  |            |                                 |                                                                                  |                                    |
  - 排序：没人接手的在前，金额高的在前，沉默久的在前。
  - 等了 10 分钟以上用 danger 字，不到 10 分钟用 warning 字，都带钟表图标。

- 右侧 KPI 格（y 56）：
  - 名称「本月成交额（元）」，数字「207,440」
  - 口径「本月已付款订单的总额」
  - 明细行「另有待付85,600元」

**B · 销售话术编辑（有 1 处检查问题）**：1440×1100，侧栏收起，内容宽 1312。

- **PageHeader**：
  - 标题「销售话术」。
  - 状态句「线上v2 · 老板发布于9月25日 18:30 · 草稿改了2节 · 已自动保存14:05」；最后一段只在本次打开页面后保存过时出现（§10.0 修正 8）。
  - 右侧：「更多」（里面是「丢弃草稿」），加次要按钮「版本记录」（前置 `history`）。**页头没有主按钮，主按钮在发布条里。**
- **额度条**（页头下 20，通栏）：
  - 左侧宽 560：标签「可编辑正文 **2,303 / 2,658** 字 · 87% · 还能写355字」，下一行是图例（§6.2）。
  - 右侧：条宽 720，比例尺 0–2,800 字，所以 95% 刻度在 2,525、上限刻度在 2,658。
  - 4 段按节顺序排：前言 232、话术原则 954（改过）、异议处理 540（改过）、微信语气规范 577。
- **三栏**（额度条下 24）：左栏 264，间隔 32，中栏 688，间隔 32，右栏 296。
  - **左栏目录**：
    - 顶部是分段控件「全部 11 / 可编辑 4 / 已改 2」，选中「全部」。
    - 11 行，顺序照节表，行高最小 40，节名允许两行，右侧是 13 的字数：
      - 固定规则节：14 `lock`（text-3）、text-2 节名、text-3 字数。
      - 可编辑节：text 色节名。
      - 改过的节：节名后放 6px `--accent` 圆点，字数写「954（+44）」，用 accent-text。
    - 当前节「话术原则」：`--selected` 底，无竖条；下一行写 13 danger「1个问题」，前置 14 `circle-x`。
    - 各节字数照 §10.0 场景数据。
    - 目录底部一条分隔线，下面写 13 text-2，前置 `lock`：「带锁的7节是固定规则，由代码逐条核对，这里只能看」。
  - **中栏**：
    - 节标题 16/24/600「话术原则」；下一行 13 text-2「可编辑 · 910 → 954字（+44）· 查看本节改动」，最后一段是链接。
    - 编辑卡片（§5.9，内边距 24）。正文 16/28，最宽 640，按 markdown 渲染：
      - 列表圆点悬挂缩进 20，粗体 600。
      - 不显示 `**`，没有行号，不折叠正文。实现上用 CodeMirror 的装饰：光标不在那一行时隐藏标记。
    - 样张显示这一节从要点②开始的那段。
    - 工具名全部显示成芯片（§6.6）。
    - 草稿把 `search_routes` 写成了 `search_route`：那一处画波浪线，紧接在那一条之后插入行内提醒（§5.12）：
      - 文字「提到了不存在的工具「search_route」，是不是「查线路 search_routes」？」
      - 下一行 13 text-2「模型只认7个工具名，写错的名字会被当成不存在，这条规则就不起作用了。」
      - 右侧按钮「改成search_routes」
    - 新加的「，一句就够，别连发三句恭喜」用 `--accent-bg` 标出来；改过的段落在沟槽里画竖条（§6.5）。
  - **右栏**：
    - 检查清单「发布前检查 · 6/7通过」，其中「工具名都存在」没过，说明「1处 · 话术原则」。
    - 下面一张卡片「话术里可以点名的工具」：7 个芯片，每行一个（查线路、看线路详情、查酒店、算报价、生成方案书、下单、转人工）；卡底写 13 text-2「写别的名字模型会当成不存在」。
    - 试聊窗格不渲染（没有接口，spec「依赖 02 的后端」第 9 项）。
- **发布条**（§5.16）：
  - 左边：16 `triangle-alert`（`--warning-icon`），加 14/500「草稿改了2节（话术原则、异议处理）」，加 13「1个问题要改」（danger）和「字数2,303 / 2,658」（text-2）。
  - 右边：13 text-2「改完1个问题即可发布」，次要按钮「查看改动」，主按钮「发布…」（`aria-disabled`，禁用外观）。
- 宽度 1280–1439 时右栏收掉，检查清单挪到左栏目录下面。
- 点开固定规则节时：正文照样用 text 色只读，不用灰底。正文上方放一行 13 text-2，前置 `lock`：「固定规则 · {lockReason}。这里改不了，要改请联系技术。」

**C · 版本记录 + 回滚确认**：1440×900。

- 背景是 B 页。右侧开着 S 420 的抽屉，抽屉上面再叠一个 640 的回滚弹窗，两层遮罩叠加。
- **抽屉「版本记录」**：每个版本一行，行与行之间用 `--divider`，内边距 16 0。
  - 草稿：状态「草稿」（空心点），加「未发布 · 改了2节」；行右侧是文字按钮「继续编辑」。
  - v2：14/600「v2」，加状态「线上」。
    - 变更说明 14/500「客户嫌贵时先问预算上限，再给两档方案」
    - 下一行 13 text-2「老板 · 9月25日 18:30 · 改了1节（异议处理）」
    - 操作「查看改动」
  - v1：
    - 说明「初始导入」
    - 下一行「系统导入 · 9月24日 10:02」
    - 操作「查看改动」「回滚到这版…」「载入到草稿再改」，文字按钮之间用 Sep 隔开
  - 每行最后有一个默认折叠的「技术详情」（13 text-3，加 `chevron-right`），里面是四个哈希的前 12 位；收起时页面上不出现哈希。
- **弹窗「回滚到v1」**（§5.14）：
  - 后果列表：
    - 〔`info`〕会生成v3并立即上线，客户的下一句就按v1的写法回复。
    - 〔`info`〕v2还在，随时能再切回来。
    - 〔`lock`〕固定规则节保持现在的写法，不会退回旧版。
    - 〔`triangle-alert`〕你的草稿（改了话术原则、异议处理）是在v2上改的。回滚后要先合并，才能发布。
  - 差异块：先写 13/500「回滚后，线上的可编辑节会变成这样：异议处理531 → 496字（撤回v2的改动）」，下面是一小段行内差异（§6.5），整块放在 `--r-md` 圆角、内边距 8 的底块里，底块用 `--subtle`。
  - 必填输入框，标签「为什么回滚」，占位「例：v2的嫌贵话术让客户觉得被追问预算」。
  - 底栏：次要按钮「再看看」（默认焦点），加主按钮「回滚到v1」（不用红色）。

**D · 线路列表**：1440×900。

- **PageHeader**：标题「线路」；状态句「共21条 · 销售助手只推荐已上架的」；主按钮「新建线路」（前置 `plus`）。
- **页签**：全部 21 / 已上架 20 / 草稿 1。
- **工具条**：
  - 搜索框「搜索名称、目的地、客户的其他叫法、编号」，宽 320。
  - 筛选按钮「目的地」「境内/境外」「适合客群」（都来自 `list.filters`）。
  - 右侧「21条」。
- **表格**（§5.5）：
  - 总宽 1152，列宽：线路自适应（约 312）· 天数 64 · 每人起价（元）120 · 最佳季节 224 · 适合客群 180 · 状态 100 · 更新 152。更新列不取 144：`text-autospace` 让「系统导入 · 9月24日」在 144 里多出约 1px 被省略；最长的线路名约 281px，312 放得下。
  - 更新列按时间倒序：表头「更新」是 text-2，后跟 `chevron-down`。
  - 行 56 高，样张画 11 行（到 y 852 正好画满）：
    1. 草稿「贵州 小七孔·西江千户苗寨 5 日」
       - 次行：贵州 · r-guizhou-5d
       - 5天 · 13,800 · 4–10 月 · 家庭、亲子、银发 · 草稿 · 小林 · 今天13:40
    2. r-sichuan-lux：更新写「小林 · 今天10:12」
    3. 之后按 routes.json 的原顺序，更新写「系统导入 · 9月24日」
  - 跨年的季节写「10 月–次年 5 月」，多段写「4–6、9–10 月」。
- 其他状态（空、筛选无结果、出错）照 §4.5。

**E · 线路详情编辑**（已上架：锁定字段、可改字段、保存条）：1440×1100。条目是 r-sichuan-lux，数据取 routes.json。

- **面包屑**：「产品库 / 线路 / 四川 稻城亚丁·色达秘境 8 日」，其中「产品库」是纯文本。
- **标题**同名，后面跟状态「已上架」。状态句「13项上架后锁定 · 小林更新于今天10:12」。右侧：「更多」（里面是「复制为新草稿」）。
- 页头下是页签「编辑 / 预览」（§4.4），选中「编辑」。
- **两栏**：主栏 736，间隔 24，副栏 368，副栏吸顶。
- **主栏**按 groups 顺序排卡片（§5.9）。字段排成两列网格，列间距 24，标签在上。「基本信息」例外，排成一行 4 列（§6.4）：
  - **「基本信息」**：
    - 卡片头 Tag「上架后锁定 · 识别」，下一行原因「销售助手靠这些认出客户说的是哪条线，改名会让对话里的旧说法认不出来。急需修正请联系技术。」
    - 全是只读值，字段不单独挂锁，一行 4 列（owner 2026-09-27；原来是两行两列）：线路编号 r-sichuan-lux（`--mono`）、线路名称、目的地 四川、天数 8天。线路名称完整显示。
  - **「价格与季节」**：
    - 卡片头 Tag「上架后锁定 · 计价」，加原因。
    - 每人起价 42,800元/人。
    - 最佳季节 5月-10月：画 MonthStrip L，9 月下面有当前月圆点。下一行 13 text-2「5–10月 · 这些月份出发报价上浮10%，「全年」不加价」。
  - **「适合谁去」**：
    - 卡片头 Tag「上架后锁定 · 推荐」，加原因。这是混合卡：
    - 锁定字段只读，标签后挂 12 `lock`：境内还是境外（境内）、适合客群（蜜月、家庭）、全程最高海拔（4,700米）。
    - 体力强度：可改的分段控件「不填 / 轻松 / 适中 / 较累」，选中「较累」。
    - 最累的一段：可改的输入框，**已改**（§6.5 的圆点和「已改」），值取 routes.json 原文，在末尾补半句作为改动。
  - **「逐日行程」**：
    - 头部「逐日行程 · 8天」，右侧 13 text-2「条数随天数锁定，文字可改」。
    - 基本信息收成一行以后，逐日行程头部在面板 y 906 处，D1 卡片的第一行（当天标题、当晚住宿两个输入框）在保存条上方完整露出。D2 在保存条以下，要滚动才看到。没有增删和移动按钮。
- **副栏**：
  - 状态卡：状态「已上架」，写「13项上架后锁定」。下面每个锁定组一行，行高 32，可点，末尾 `chevron-right`，点了滚到对应卡片：识别 5 · 计价 2 · 条款 2 · 推荐 4。
  - 「最近更新」卡：更新人 小林，更新时间 今天10:12。「在对话里被推荐」这类数据今天没有，不画。
- **保存条**：
  - 左边：16 `clock`（`--warning-icon`），加「有2处改动」，加 13 text-2「最累的一段、行程亮点第2条」，加文字按钮「展开改动」。
  - 右边：13 text-2「销售助手下一条回复就用新内容」，幽灵按钮「放弃」，主按钮「保存并立即生效」。

**F · 草稿上架确认**：1440×900。

- **背景**：r-guizhou-5d 的详情页，在遮罩下。
  - 标题后是状态「草稿」；状态句「上架后13项会锁定 · 小林更新于今天13:40」；页头主按钮「上架…」。
  - 副栏的上架前检查写「必须项13/13 · 建议1条没做」（§10.0 修正 10）。
- **弹窗**（640，§5.14）：
  - 标题：上架「贵州 小七孔·西江千户苗寨 5 日」
  - 第一段：上架后，销售助手会立即向客户推荐这条线路，并按每人13,800元起报价。
  - 第二段先写 14/500「下面这些内容会锁定」，然后按锁定组分行。每行是 Tag（前置 `lock`）「识别」等，后面是用 Sep 串起来的「字段 值」：字段名 text-2，值 text。
    - 识别：线路编号 r-guizhou-5d · 线路名称 贵州 小七孔·西江千户苗寨 5 日 · 目的地 贵州 · 天数 5天 · 客户的其他叫法 黔东南
    - 计价：每人起价 13,800元/人 · 最佳季节 4月-10月（这些月份出发报价上浮10%）
    - 条款：费用包含 7条 · 费用不含 5条
    - 推荐：境内 · 适合客群 家庭、亲子、银发 · 最高海拔 1,200米 · 标签「国内」
  - 两行提示：用 16 图标加 14 文字，不做 Alert 盒子。
    - 〔`triangle-alert`，`--warning-icon`〕有1条建议没做：体力强度没填（不拦上架）
    - 〔`circle-alert`，`--danger`〕上架后无法下架，锁定的内容只能由技术修正。
  - 底栏：次要按钮「再检查一下」（默认焦点），加主按钮「上架，开始推荐」。
  - 锁定清单里每组「字段 值」整体不断行，换行只发生在间隔号后面，间隔号不出现在行首。

**G · 有序子项编辑器**（旅游包里是逐日行程）：1440×1100。

- r-guizhou-5d 的详情页，滚动到「逐日行程」卡片。这是草稿，所以能增删和移动。状态句同 F。
- 头部「逐日行程 · 5天」，条数和天数一致，不显示提醒。节点里写「D1」–「D5」（§6.3）。
- 五天（文字都取自 routes.json 里 r-guizhou 的第 1、2、3、5、6 天）：
  - **D1** 贵阳抵达 青岩古镇：当晚住宿「贵阳凯宾斯基大酒店」，引用的是草稿酒店，名称后跟状态「草稿」；餐食「晚」。填全了，实心节点。
  - **D2** 小七孔 晨光碧水：当晚住宿「荔波荔泉宾馆」（名称后跟「草稿」）；餐食「早/午/晚」。填全了，实心节点。
  - **D3** 茂兰原始林与瑶山古寨：当晚住宿没填，空心节点，旁边写「缺：当晚住宿」。
    - 住宿输入框处于聚焦状态，展开联想（§5.3）。
    - 第一组「酒店库 · 贵州」：贵阳安纳塔拉度假酒店；贵阳凯宾斯基大酒店（状态「草稿」）；荔波荔泉宾馆（状态「草稿」）。
    - 第二组「本线路写过的」：荔波荔泉宾馆。
    - 输入框旁边是文字按钮「复制上一天的住宿」。
  - **D4** 西江千户苗寨 银与灯：
    - 当晚住宿「云上西江酒店」：它在 H 里没导入成功，所以下方注 13 text-3「酒店库里没有这个，按原文保存」。
    - 当天安排改长到 131 字，字数计数用 warning 色，下面写「手机上会很长（建议120字以内）」。
    - 餐食多选片选了早、午、晚。
  - **D5** 晨雾千户 返程：当晚住宿「—（返程）」，餐食「早/午」。
- 每张卡片右上角都有上移、下移、删除；D1 的上移和 D5 的下移不能用。卡片列表底部有「添加一天」。
- 副栏的上架前检查多出一条没过的必须项「第3天：当晚住宿没填」，可以点。当晚住宿是必填子字段（schema 要求），所以它是必须项，不是建议项。
- 保存条：「有2处改动」，补充「第3天的当晚住宿、第4天的当天安排」。这是草稿，右边写「草稿保存后仍不会推荐给客户」，按钮是「放弃」和主按钮「保存草稿」；页头的「上架…」是次要按钮。草稿也要整条通过 schema（01），所以这时点「保存草稿」，第3天的当晚住宿下方报「当晚住宿：没填」，不发请求。

**H · CSV 导入**（第 3 步「校验结果」，有 2 行不合格）：1440×1100。

- 背景是酒店列表（导入前的 23 家），上面是 880 宽的弹窗。
- **步骤条**，5 步：下载模板 / 选文件 / 校验结果 / 导入 / 完成。
  - 已完成的步：`check`（text-2）加 text-2 字。
  - 当前步：22 圆形序号，`--primary` 底、`--on-primary` 字，文字 text 500。
  - 没到的步：text-3。
  - 步与步之间用 1px `--divider` 连线。
- **文件行**：「新签酒店-9月.csv · 按UTF-8读取 · 8行」，右侧文字按钮「换一个文件」。
- **汇总** Alert（warning）：「6行可以导入，2行要改」。
- **表格**（弹窗内的小号表格，§5.5）：
  - 列：行号 · 结果 · 酒店名称 · 编号（一列两行：名称在上，`--mono` 编号在下；9 列放不进 832 宽）· 目的地 · 星级档次 · 每晚起价（元）· 主推房型 · 原因。单元格内边距 0 8，行高 52。
  - 结果列：合格写 16 `circle-check`（success）加「合格」；要改写 16 `circle-x`（danger）加「要改」。
  - 不合格的行，出错的单元格用 `--danger-bg` 底、danger 字；原因写在最后一列，13 danger：
    1. h-sixsenses-qingcheng 青城山六善酒店 · 四川 · 顶奢 · 3,400 · 山景套房 · 合格
    2. h-jinjiang-chengdu 成都锦江宾馆 · 四川 · 五星 · 900 · 行政房 · 合格
    3. h-songtsam-meili 松赞梅里山居 · 云南 · 顶奢 · 4,800 · 雪山景观套房 · **酒店编号：这个编号已经有了（松赞梅里山居，已上架）**
    4. h-amandayan 大研安缦 · 云南 · 顶奢 · 5,200 · 纳西庭院套房 · 合格
    5. h-kempinski-guiyang 贵阳凯宾斯基大酒店 · 贵州 · 五星 · 1,100 · 城景房 · 合格
    6. h-yunshang-xijiang 云上西江酒店 · 贵州 · 精品 · 2,6OO · 观景吊脚楼房 · **每晚起价：要写整数，写的是「2,6OO」**。Geist 里字母 O 和数字 0 难分，单元格和原因里的两个 O 都加 danger 波浪下划线（§6.6 的样式），文案不变。
    7. h-liquan-libo 荔波荔泉宾馆 · 贵州 · 五星 · 800 · 园景房 · 合格
    8. h-songtsam-lhasa 松赞拉萨林卡 · 西藏 · 顶奢 · 3,600 · 布达拉宫景观套房 · 合格
- **底栏**：左边是幽灵按钮「上一步」；右边是次要按钮「下载不合格的2行（带原因）」和主按钮「只导入合格的6行」。
  - 有不合格的行时，不放一个禁用的「全部导入」，而是直接把「只导入合格的」做成主按钮。理由是不留禁用的主按钮，而且下载的文件已经带着原因，改好了可以再导。

**I · 会话列表**（今天：只用现有的 6 个字段）：1440×1100。

- **PageHeader**：
  - 标题「会话」；状态句「企业微信里的客户会话 · 接手和回复目前在工作台里完成」。
  - 主按钮「打开工作台」，后置 `arrow-up-right`，在新标签页打开 /admin.html。
- **页签**：全部 13 / 等人接手 2（软徽标）/ AI接待中 10 / 已成交 1。今天没有「顾问处理中」。
- **区块「客户停在哪一步」**（页签下 16，宽 560，不套卡片）：
  - 区块头：标题，加计数「AI接待中的10个会话」，右侧文字按钮「以表格查看」。
  - 阶段条（§6.7）：开场 0 / 问需 4 / 推荐 3 / 报价 2 / 异议 0 / 促成 1，每一段都能点，点了按阶段筛选。
  - 下面一行 13 text-3「按每个会话现在所处的阶段统计」。
- **表格**（区块下 24）：
  - 列宽：会话 300（§6.7 的首列）· 状态 140 · 阶段 120 · 消息 88（右对齐）· 最后动静 160 · 操作（幽灵「打开工作台」加 `arrow-up-right`）。
  - 排序：等人接手的在前，其余按最后动静倒序。13 行都画出来，数据用 §10.0 的会话表。
  - 等人接手的两行，阶段写「—」。
- **今天不画**：客户昵称、需求、最后一句话、转人工原因、等待时长、红色。行里的「最后动静」就是 `updatedAt`，不说成「等了多久」。

**02 后端到位后 · J · 会话工作台**：1440×900，侧栏收起。面板内边距 0，分三栏：列表 320、对话（自适应，约 694）、客户与交接 360。栏与栏之间用 1px `--divider` 隔开。

- **列表**：
  - 列表和右栏顶部各有一条 56 高的栏头，与对话头对齐：「会话 14个」「客户与交接」。
  - 按状态分组，不用页签（320 宽放不下四个页签）。组标题 13/500 text-3，写状态名和计数：「等人接手」加软徽标 2、「顾问处理中 1」「AI接待中 10」「已成交 1」。
  - 每行 64 高，两行字，行间 2（owner 2026-09-27：状态挪到第二行，标题独占第一行）：
    - 第一行只放标题「企微客户 · 7F3A · 贵州带爸妈4人」，14/500，占满整行宽（280），放不下才截断。
    - 第二行高 22，从左到右间隔 8：
      1. 状态（§5.6）
      2. 13 text-2 的上下文，占剩下的宽度，截成一行，悬停看全文
      3. 右对齐的 13 等待时长（前置 `clock`），或最后动静时间（text-3）
    - 等人接手的行，胶囊和等待时长一共占掉约 170，上下文只剩约 100。所以 F01 显示成「原因：客户投诉…」，全文在悬停提示、对话头部和交接卡里都有。
  - 各行内容：
    - **7F3A**：选中，`--selected` 底。第二行依次是「等人接手」胶囊、客户的最后一句、13 danger「等了12分钟」（前置 `clock`）。
    - **F01**：第二行依次是「等人接手」、「原因：客户投诉价格太贵」、warning「等了8分钟」。
    - **A01**：第二行依次是状态「顾问处理中」、「接手人：小林」、「26分钟前」。
    - **AI 接待中的各行**：第二行依次是状态「AI接待中」、「停在：促成」这类阶段、最后动静时间。画到放不下为止。
- **对话**：
  - 头部（56 高，下边 `--divider`）：
    - 标题 16/24/600「企微客户 · 7F3A · 贵州带爸妈4人」，后面是「等人接手」胶囊和「等了12分钟」。
    - 右边：「更多」（里面是「交还AI」「复制会话链接」），加**唯一的主按钮**「接手会话」。
  - 头部下面有一个开关「显示AI步骤」，默认关。
  - 消息 T1–T5 是 7F3A 那段回放里的对话（§6.7 气泡）。T4 的气泡下面只留一行 13 text-2：「AI原稿里删了1句 · 展开」。展开以后是删去和发出的对照，标注用文字，不只靠颜色。
  - 输入框上方固定一张交接卡（§6.7），写：
    - AI已转人工 · 14:18
    - 原因（逐字）
    - 客户原话里的出行时间「…11月8号出发…」→ 2026-11-08
    - 停在：报价
  - 输入框是禁用状态，占位「接管后在此回复，客户在企业微信中看到」。
- **右栏「客户与交接」**：卡片从上到下：
  - 需求：目的地 贵州 · 4位（带爸妈）· 11月8日出发 · 预算 没说
  - 最近报价：贵州 荔波小七孔·西江千户苗寨 6 日 · 每人15,010元 · 4位共60,040元 · 11月不在最佳季，4位95折
  - 订单与付款：还没有订单
  - 转人工：原因、时间 14:18、由谁处理（写「还没人接手」）
  - 快捷回复：3 条
- 侧栏收起后，「会话」图标上叠实心徽标 2。

**K · 审计日志**（人话句子 + 详情抽屉）：1440×900。

- **PageHeader**：标题「审计日志」；状态句「谁在什么时候改了什么」。
- **筛选**：分段控件「全部 / 销售话术 / 产品库 / 账号与登录 / 平台与配置」，选中「全部」；加开关「显示登录记录」（关）。
- **时间线**按天分组：
  - 组标题 13/500 text-2：「今天 · 9月26日 周六」「昨天 · 9月25日 周五」「9月24日 周四」。
  - 每条：
    - 左边 28 头像（§6.8）。
    - 中间是 14 的人话句子，人名和对象用 500；下一行 13 text-2 写改动摘要，如「改了：住宿档次、行程亮点」。
    - 右边是 13 text-3 的时间「13:40」。
  - 数据用 §10.0 的 8 条。「6条酒店草稿」那一条收起画，末尾是文字按钮「展开6条」。
  - 选中 10:12 那一条：`--selected` 底。
- **右侧 M 480 的详情抽屉**：
  - 句子；时间 2026-09-26 10:12:44；操作者 小林（管理员）。
  - 改动表（弹窗内小号表格）「字段 · 原来 · 现在」：
    - 住宿档次：「顶级精品」→「顶级野奢」。原值由设计补，现值取 routes.json。
    - 行程亮点第2条：用行内差异（§6.5）。
  - 文字按钮「打开这条线路」。
  - 默认折叠的「技术详情」，收起画。里面是 catalog.update · route · r-sichuan-lux · JSON 原文。
- 这一页不出现红色。底部是「加载更早的记录」。

**L · 同一套界面换成家装整装包**：1440×1800。上半屏是列表，下半屏是详情，各自带完整外壳（各 900 高）。

- 租户「松间整装」，主色 `#1F6F78`，按 §1.3 表里那一行替换 accent 那组变量。这是在演示租户品牌色；品牌色要后端，在那之前假包的走查用默认主色：
  - `--accent:#1F6F78`
  - `--accent-text:#1F6F78`
  - `--accent-bg:#D8FAFE`
  - `--focus:#1F6F78`
  - `--on-accent:#FFFFFF`
  - `--accent-ring:rgba(31,111,120,.2)`
- 导航：总览 / 销售话术 / 产品库（装修套餐 `package`、主材 `layers`）/ 运营。
- **上半屏「装修套餐」列表**（同 D 的组件）：
  - 页签：全部 5 / 已上架 4 / 草稿 1。
  - 列：套餐 · 适用户型 · 每平米单价（元）· 起装面积 · 工期 · 适合开工月份（MonthStrip S）· 状态 · 更新。
  - 5 行：
    - 暖木 · 两居全包经典版 p-nuanmu-2r · 两居、三居 · 1,280 · 60 ㎡ · 75 天 · 3–6、9–11 月 · 已上架
    - 奶油 · 三居全包进阶版 p-naiyou-3r · 三居、四居及以上 · 1,580 · 90 ㎡ · 90 天 · 3–5、9–11 月 · 已上架
    - 新中式 · 大平层定制版 p-xinzhongshi-flat · 四居及以上、别墅 · 2,680 · 140 ㎡ · 120 天 · 全年 · 已上架
    - 极简 · 一居焕新版 p-jijian-1r · 一居 · 980 · 35 ㎡ · 45 天 · 全年 · 已上架
    - 旧房翻新 · 局部改造包 p-jiufang-part · 两居、三居 · 860 · 20 ㎡ · 30 天 · 3–11 月 · 草稿
  - 「全年」只写「全年」：家装包没有配 `yearRoundLabel`（§9）。
- **下半屏「暖木 · 两居全包经典版」详情**（已上架，同 E 的组件）：
  - 基本信息：锁定 · 识别。
  - 价格：锁定 · 计价。1,280元/㎡，起装 60 ㎡。
  - 适合谁（混合卡）：
    - 适用户型：只读，带锁，两居、三居。
    - 风格：可改的标签，原木、奶油。
    - 适合开工月份：可改的 monthRange，预览 MonthStrip L，加「识别出：3–6、9–11月 · 施工旺季，排期要提前4周」。
  - 施工与条款：锁定 · 条款。工期 75天 · 含拆旧 · 包含主材 4 个引用芯片（马可波罗 800×800 抛釉砖、大自然 三层实木复合地板、欧派 整体橱柜、箭牌 卫浴套装）。
  - 施工节点：有序子项编辑器，节点 1–7：拆改 5天、水电 10天、泥瓦 15天、木作 12天、油漆 10天、安装 8天、保洁验收 3天。
    - 节点里只写序号，卡片第一行写「节点 3」（§6.3）。
    - 每个节点有验收要点和用到的主材。
    - 条数不锁，所以增删和移动按钮都在。

**N · 系统**（只给平台管理员）：1440×900，身份「平台管理员」。

- 侧栏多出「平台 / 系统」这一组，选中「系统」。侧栏用户行是「技术支持 平台管理员」，放不下，按 §4.2 只显示「技术支持」。需要后端补平台管理员登录和一个只读的诊断接口；每张卡片右上角用 13 text-3 标明数据来源。
- **PageHeader**：
  - 标题「系统」。
  - 状态句「只有平台管理员能看到 · 云途定制旅行 · 数据库模式」。
  - 次要按钮「复制诊断信息」（前置 `copy`）。
- **两列卡片**（各 552，间隔 24）：
  - **「运行状态」**（来源 `GET /status`，今天就有）：
    - 状态行：配置锁 持有中；话术 v2 已载入；产品库改动已生效；线路搜索索引 已同步（第12代）。
    - 「与代码仓库初始数据的差异」：话术 1 节（异议处理）· 线路 改过 1 条、只在后台 1 条 · 酒店 只在后台 6 条。每一项都能展开看明细（`chevron-right`）。
  - **「模型」**（来源：运行配置）：主模型 glm-5.3-flashx；4秒没返回就用 glm-5.2 对冲；并发上限 8；访客每日额度 500。
  - **「延迟与成本」**（来源写「评测批次09-24，不是线上实测」）：2×2 的数字，用 kpi 字阶。首轮响应 P50 2.75秒 · P90 5.1秒 · 超过8秒 0% · 每千轮 4.8元。
  - **「评测」**：51条用例 · 147条断言 · 护栏类20条 · 回归 23/23 通过。下面用 16 `triangle-alert` 加 warning 字写：「这批跑在话术v1上；线上已是v2，还没重跑」。
  - **「技术详情」**：默认折叠，样张画成展开。prompt 6c202d633b60 · tools 64c16fc8f464 · prefix cd3cc7dab87a · sop 396b2514bfbf，四个哈希各取前 12 位（§10.0 修正 7），用 `--mono` 12.5；旁边是 28 的复制图标按钮。
- 没有趋势图。

**P · 字体与标点（验收页）**：1440×1100。

- 这是字体与标点的验收页，不是产品页面：路由 `/_specimen/type`，只在 `VITE_SPECIMEN=1` 的构建里注册。没有外壳：`--frame` 底上一块面板 x 8–1432、y 8–1092，内边距 32，内容宽 1360。分两栏：左栏 660，间隔 40，右栏 660。每节的节名用 16/24/600，节与节之间 32。所有例子都用生产的字体文件和全局样式渲染，所以它就是上线效果的验收样张（spec 验收 7、8）。
- 文件在 `console/src/_specimen/` 下。字重样例「销售话术 Sales v2」和「不要这样」那行反例故意手打了空格，所以这个目录不受 spec 不变量 9 的扫描。样张独有的字不进 UI 优先片（§2.6）：生产里没有这两页，不让每个访客多预载这些字形；打开样张时这些字按需加载长尾分片，字形和宽度不变。
- **左栏**：
  1. **字体与字重**：三行，每行先写 `--mono` 12.5 text-3 的说明（「Geist · Noto Sans SC · 400」），再写一句 16/24 的样例「销售话术 Sales v2 · 2,303 / 2,658字 · 企微客户 · A01」，分别用 400 / 500 / 600。
  2. **字阶**：§2.3 的 10 级，每级一行。左侧 120 宽写名称和字号（`--mono` 12.5 text-3），右侧用该字阶写一句真实文案：
     - badge：徽标「2」，实心徽标（§5.7）和软徽标各画一个
     - meta：「线上v2 · 老板发布于9月25日 18:30」
     - code：「r-sichuan-lux」
     - body：「企微客户 · F01 · 2条消息」
     - reading：话术原则的一句
     - card-title：「上架前检查」
     - section：「需要你处理」
     - page-title：「销售话术」
     - kpi：「207,440」
     - display：「云途定制旅行」
  3. **数字**：一列右对齐的等宽数字 13 / 2 / 1 / 43 / 13,800 / 42,800 / 207,440，旁边写「tabular-nums」。
- **右栏**：前三节用同一种排法，左边是 64 宽的 13 text-3 标签，间隔 12，右边是 16/28 的样例。
  1. **标点挤压**：三组真实文案，每组画两行。上一行加 `text-spacing-trim: space-all`，前面标 13 text-3「不挤压」；下一行是本文的 `normal`，标「本规范」；两行右侧用 13 text-3 写各自的宽度（px）。三组文案：
     - 「改了2节（话术原则、异议处理）· 有1个问题要改」
     - 「客户答「可以」「好」，你还得再问一遍」
     - 「（「不用倒时差、带娃能玩水」「想找个安静的地方过纪念日」）」
     - 宽度在渲染后用 `getBoundingClientRect` 实测、写到页面上。Chromium 的参考值：362 → 354、288 → 272、464 → 440，每挤一处少 8px（半个 16px 字）。
  2. **省略号与破折号**：
     - 「想了解…吗」「客户只会答「可以」……」「——对，就是这条」「最后一天可以写「—（返程）」」，都用 16/28。
     - 四行的标签依次是「省略号」「两个连用」「破折号」「空值」。
     - 最后一行是反例，标签「反例」：一个 `lang="en"` 的「search…」，旁边用 13 danger 字写「不要这样：lang="en" 会把省略号换成西文字形，落到基线上」。这是唯一允许用 danger 字的地方，用来标反例。
  3. **间隔号与中西间距**：
     - 「企微客户·A01·7条消息」用 `.sep` 画出来。
     - 「有1个问题要改」画两遍对比：一遍靠 `text-autospace` 自动补间距，标「本规范」；一遍手打空格，标「不要这样」（13 text-3，不用 danger）。
  4. **关于弹窗样张**：480 宽（§5.14）。
     - 标题「关于」。
     - 正文两段：
       - 「字体：Geist、Geist Mono（Vercel），思源黑体Noto Sans SC（Adobe、Google）。都按SIL Open Font License 1.1使用。」为什么用「），」见 §2.6。
       - 「图标：Lucide（ISC许可）。」
     - 下面三个链接「查看Geist许可」「查看思源黑体许可」「查看图标许可」。
     - 底栏次要按钮「关闭」（默认焦点）。

## 11. 文案

- 界面只用下表左列的术语：

  | 用                                      | 不用                                         |
  | --------------------------------------- | -------------------------------------------- |
  | 销售话术                                | 导航和标题里的 SOP                           |
  | 线上 / 线上v3                           | 已发布版本、published                        |
  | 草稿                                    | draft、rev                                   |
  | 固定规则节                              | 锁定节、镜像里的 data/sop.md                 |
  | 字数额度                                | 预算、budget                                 |
  | 上架 / 上架后锁定                       | active、activate                             |
  | {实体名}编号（线路编号、酒店编号）      | code、id                                     |
  | 境内 / 境外                             | overseas                                     |
  | 密码                                    | 口令                                         |
  | 系统导入 / 命令行                       | import-config、user-create                   |
  | 技术详情（折叠区）                      | 在其他地方出现的 prompt、hash、uuid、payload |
  | 等人接手、顾问处理中、AI 接待中、已成交 | 待人工、已转人工、待接管、需要介入           |

- 实体名、字段名、阶段名、客户和顾问的叫法都来自行业包（§9），界面代码里不写。
- 四种会话状态只用这四个词：AI 接待中、等人接手、顾问处理中、已成交。不写「待人工」「已转人工」「待接管」「需要介入」。
- 金额写「42,800 元」「每人 13,800 元起」，不写「¥」。
- 时间：列表里用相对时间，悬停显示绝对时间；审计和版本记录用绝对时间「9月26日 14:02」，跨年时加年份。
- 按钮写动作；标签不加冒号；提示不加句号。
- 出错写「无法……」，并给出下一步。服务端返回的 `detail` 只放进技术详情。
- 任何文案都不出现：模型名、哈希、JSON 键名、英文字段名，以及「镜像」「data/sop.md」。「系统」页和技术详情除外。
- **排版相关**（§2.5）：
  - 中文与数字、拉丁字母之间不手打空格。
  - 并列信息用 `Sep` 隔开。
  - 引用界面上的词用「」。
  - 省略号写「…」或「……」，不写「...」。
  - 破折号写「——」，空值写「—」。
  - 本文例子里的空格只为好读，照抄时删掉；产品数据（线路名等）原样保留。
