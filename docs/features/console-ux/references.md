# 后台 UX 重做 · 参考文献

spec.md 里的 [n] 指这里的编号。每条用一句话说明引用了它的什么。标「观点」的是个人或机构的看法，不当作规范引用。

来源：上一稿 references.md 里核对过的条目（仍被引用的保留原说明），以及 2026-09-26 的生产可用评审、2026-09-27 的字体调研里实际打开过的页面。本稿重新编号，只收 spec 实际引用的条目。

## 一、首页、会话与 AI 客服后台的业界做法

1. Shopify · App 首页 — https://shopify.dev/docs/apps/design-guidelines/user-experience/app-home-page — 首页放快速统计、状态更新和可立即执行的操作。
2. Ant Design · 工作台 — https://ant.design/docs/spec/research-workbench-cn — 首屏放最常用的内容，给出到达目的地的最短路径。
3. Intercom · 监控 Fin 的表现 — https://www.intercom.com/help/en/articles/11390083-monitor-fin-s-performance-with-clarity-and-confidence — AI 的表现数据放在 Reports / Analyze 里，不在首页。
4. 有赞 · 产品设计原则 — https://design.youzan.com/product-principle/share.html — 「先有，再高效，然后易用，最后好看」「黑白灰配一些色」；商家每日使用的工作系统不需要强视觉冲击。
5. Intercom · Fin 会话视图 — https://www.intercom.com/help/en/articles/7860256-view-fin-ai-agent-s-conversations-from-the-inbox — 按 AI 参与、转人工等维度划分的默认视图。
6. Intercom · 收件箱排序 — https://www.intercom.com/help/en/articles/6989006-inbox-sorting — 按「等了多久」排序。
7. Zendesk · AI 会话日志 — https://support.zendesk.com/hc/en-us/articles/8357749580186-Reviewing-conversation-logs-for-AI-agents — AI 的处理细节默认收起，悬停后点 View details 才展开。
8. Fin · 预览与测试 — https://fin.ai/help/en/articles/13975790-how-to-preview-and-test-fin — 编辑器旁的预览面板分客户视角与运行日志两个页签，可选测试身份。
9. Zendesk · 查看与恢复修订 — https://support.zendesk.com/hc/en-us/articles/9810823284122-Viewing-procedure-revisions-and-restoring-a-previous-version — 修订在正文里行内高亮；恢复的旧版本默认成为草稿。

## 二、深色模式

10. Zendesk · 深色模式 — https://support.zendesk.com/hc/en-us/articles/9011095783322 — 深色要管理员先开放、坐席再自己选，而且不覆盖 Admin Center。
11. Intercom 社区 · 新一代收件箱的深色模式 — https://community.intercom.com/customer-faq-28/is-dark-mode-available-with-the-next-generation-inbox-2401 — 只有 Inbox 有深色，每人自选。
12. Salesforce Trailhead · SLDS 2 深色模式 — https://trailhead.salesforce.com/content/learn/modules/dark-mode-in-slds-2-quick-look/discover-dark-mode — 深色是 beta，要选「Let users enable dark mode」，Setup 不支持。
13. Shopify 社区 · 后台有没有深色模式 — https://community.shopify.com/t/does-shopify-offer-a-dark-mode-for-the-admin-page/240190 — 后台没有原生深色。社区问答，只作旁证。
14. NN/g · 深色模式 — https://www.nngroup.com/articles/dark-mode/ — 视力正常的用户多数情况下在浅色下表现更好；深色作为可选项提供。
15. web.dev · prefers-color-scheme — https://web.dev/articles/prefers-color-scheme — 跟随系统深浅色，并提供手动切换。

## 三、B 端组件与模式

16. GitLab Pajamas · 侧栏导航 — https://design.gitlab.com/patterns/navigation-sidebar — 只有两层；标签 1–2 个词；一级项各配唯一的图标；小屏时默认隐藏。
17. Ant Design · 按钮 — https://ant.design/docs/spec/buttons-cn — 一个按钮区最多一个主按钮；有风险的操作放在最后。
18. Polaris React（已归档）· 资源索引页 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/patterns/resource-index-layout/variants/default.mdx — 「Always use the primary action in the top right corner for resource creation」。
19. Atlassian · 页头 — https://atlassian.design/components/page-header/usage — 每页一个页头；规定了标题、操作、筛选的位置。
20. Ant Design · Layout — https://ant.design/components/layout-cn — `Sider` 的 `breakpoint` 只接一档（lg 992、xl 1200……），`collapsedWidth` 只有一个值，做不出 1280/992 三档，所以改成受控收起。
21. Ant Design · 数据列表 — https://ant.design/docs/spec/data-list-cn — 点标题进详情；调整筛选即时生效；不足一页不显示分页器。
22. GitLab · 筛选 — https://design.gitlab.com/patterns/filtering — 搜索在左、筛选随后、排序靠右；窄屏时筛选下移。
23. Polaris React（已归档）· 索引筛选 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/selection-and-input/index-filters.mdx — 「Include no more than 2 or 3 promoted filters」；筛选标签的命名。
24. NN/g · 无限滚动 — https://www.nngroup.com/articles/infinite-scrolling/ — 目标明确的查找任务不宜用无限滚动。
25. Carbon · 空状态 — https://carbondesignsystem.com/patterns/empty-states-pattern/ — 空状态替换原本的元素；标题宜用正向说法。
26. GitLab · 空状态 — https://design.gitlab.com/patterns/empty-states — 搜索无结果时不放 CTA；标题不超过 5 个词。
27. Carbon · 加载 — https://carbondesignsystem.com/patterns/loading-pattern/ — 用骨架屏代替转圈。
28. NN/g · 骨架屏 — https://www.nngroup.com/articles/skeleton-screens/ — 整页加载用骨架屏。
29. Carbon · 表单 — https://carbondesignsystem.com/patterns/forms-pattern/ — 标签 1–3 个词；帮助文字常驻；占位符不放关键内容；长表单不禁用主按钮。
30. Polaris React（已归档）· 资源详情页 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/patterns/resource-details-layout/variants/default.mdx — 「The primary content occupies two thirds of the page」；「Put supporting information such as status, metadata, and summaries in the secondary column」。
31. Carbon · 只读状态 — https://carbondesignsystem.com/patterns/read-only-states-pattern/ — 只读文字保持启用态的颜色，并满足 4.5:1。
32. Cloudscape · 禁用与只读 — https://cloudscape.design/patterns/general/disabled-and-read-only-states/ — 需要看的内容用只读，不用禁用；禁用时写明原因和何时可用。
33. GitLab · 设置管理 — https://design.gitlab.com/patterns/settings-management — 不能改的设置要写清原因。
34. Polaris React（已归档）· 上下文保存条 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/internal-only/contextual-save-bar.mdx — 表单有未保存的改动时出现，提供保存和放弃。
35. GitLab · 保存与反馈 — https://design.gitlab.com/patterns/saving-and-feedback — 错误「belongs in an alert rather than a toast, which auto-dismisses and cannot carry the retry action」；toast 不带操作；自动保存和手动保存二选一；离开时提示未保存，按钮是「保存」与「放弃改动并离开」。
36. Polaris React（已归档）· Toast — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/internal-only/toast.mdx — 不鼓励用 toast 报错，只留给「网络断开」这类非用户造成、三个词说得清的错误；持续性的错误用横幅。
37. GitLab · 破坏性操作 — https://design.gitlab.com/patterns/destructive-actions — 按严重度分级，高严重度用模态确认；确认按钮用 danger 变体。
38. NN/g · 确认对话框 — https://www.nngroup.com/articles/confirmation-dialog/ — 写清具体后果；按钮用描述性的动词；不要滥用确认。
39. Atlassian · 色彩 — https://atlassian.design/foundations/color — danger 只用于危险或严重错误；有语义的地方不用装饰色代替。
40. Ant Design · 色彩 — https://ant.design/docs/spec/colors-cn — 功能色代表明确的信息和状态。
41. Carbon · 状态指示 — https://carbondesignsystem.com/patterns/status-indicator-pattern/ — 状态至少同时用上符号、形状、颜色、文字中的三样；草稿用灰色。
42. Ant Design · 文案 — https://ant.design/docs/spec/copywriting-cn — 说用户熟悉的话；省略无用的词；出错时用「无法」；「不能」「请勿」有命令感。
43. GitLab · 日期与时间 — https://design.gitlab.com/content/date-and-time — 审计用绝对时间；相对时间悬停给出绝对时间。
44. Ant Design · 数据格式 — https://ant.design/docs/spec/data-format-cn/ — 金额加千分位；数字右对齐；单位写在表头。
45. NN/g · 错误信息 — https://www.nngroup.com/articles/error-message-guidelines/ — 错误放在出错处附近，用平实的语言，并给出修复建议。
46. NN/g · 表单占位符 — https://www.nngroup.com/articles/form-design-placeholders/ — 关键信息不要只放在占位符里。
47. NN/g · 表单报错 — https://www.nngroup.com/articles/errors-forms-design-guidelines/ — 报错放在行内；不在输入中途报错；汇总不能是唯一的报错位置。
48. GOV.UK · 字数计数 — https://design-system.service.gov.uk/components/character-count/ — 边打字边更新；超限时不阻止输入；可以设显示阈值。
49. GOV.UK · 错误汇总 — https://design-system.service.gov.uk/components/error-summary/ — 汇总放在页顶，每条链接到对应位置，措辞与行内报错一致。
50. Primer · RelativeTime — https://primer.style/product/components/relative-time/ — 默认超过 30 天改显示绝对日期。

## 四、话术编辑、版本与发布

51. n8n · 保存与发布 — https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows — 「Changes save automatically as you edit, typically within 1 to 5 seconds」；没有可发布的改动时发布按钮禁用；「Only one person can edit a workflow at a time」，并发靠编辑锁。
52. Dify · 讨论 #3610 — https://github.com/langgenius/dify/discussions/3610 — 用户反映：不带版本号的自动保存会覆盖别人的改动。
53. Dify · 版本控制 — https://docs.dify.ai/en/use-dify/build/version-control — Current Draft「Not live for users」、Latest Version「The live version users see」；Restore 会把旧版本载入草稿并覆盖当前草稿。旧地址已经 404，这是 2026-09 核对过的现行地址。
54. LangSmith · 管理提示词 — https://docs.langchain.com/langsmith/manage-prompts — 提交历史侧栏、Diff 开关；Promote 时显示将被替换的版本。
55. 扣子 · 版本列表 — https://docs.coze.cn/developer_guides_list_bot_versions — 每个版本都带更新说明。
56. GitHub · 审阅改动 — https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request — 统一视图与并排视图可以切换，选择会沿用。
57. VS Code · 合并冲突 — https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts — 对方、当前、结果三栏；逐块接受；显示剩余冲突数。
58. Contentful · 状态 — https://www.contentful.com/help/status/ — 「已发布但有未发布的改动」单独作为一种状态。
59. PromptLayer · 发布标签 — https://docs.promptlayer.com/features/prompt-registry/release-labels — 面向开发者的发布标签与分流，作为未采用的对照。
60. WordPress · 使用区块（用户文档） — https://wordpress.org/documentation/article/work-with-blocks/#how-to-lock-and-unlock-a-block — 「When a block is locked, a lock icon appears in the block toolbar and in List View」。
61. Decagon · AOP — https://decagon.ai/product/aop — 运营用自然语言写流程，工程保留护栏与集成。
62. OpenAI · 迁出 prompt object — https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object — 把 prompt 迁回代码，走与产品逻辑相同的评审和发布流程；本项目只对护栏这样做。

## 五、产品库与导入

63. GetYourGuide · 创建与编辑行程 — https://supply.getyourguide.support/hc/en-us/articles/14198398866077-Creating-and-editing-an-itinerary — 多日游必须完成逐日行程，完整度影响能否提交。
64. Travefy · 复制一天 — https://intercom.help/travefy/en/articles/3712808-how-to-duplicate-a-day — 行程编辑里可以复制某一天。
65. Shopify · 复制商品 — https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/products/duplicate-product — 复制商品时可以把副本设为草稿，并填新标题。替换了原来已失效的 Wetu 链接。
66. Stripe · 管理价格 — https://docs.stripe.com/products-prices/manage-prices — Price 的金额创建后不能改，改价要新建一个 Price；产品本身仍可编辑。
67. Shopify · 添加与更新商品 — https://help.shopify.com/en/manual/products/add-update-products — 状态放在右栏；保存的改动立即在店铺生效，价格也能直接改。
68. 有赞 · 商品导入 — https://help.youzan.com/displaylist/detail_5_5-2-11700 — 提供模板；可以下载未导入的结果，查看原因，改好后重新上传。
69. Shopify · 导入商品 — https://help.shopify.com/en/manual/products/import-export/import-products — 先预览再导入；文件须为 UTF-8。
70. HubSpot · 导入报错 — https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors — 区分整行未导入与单个值未导入；可以下载出错的行。
71. 微软 · 在 Excel 中正确打开 UTF-8 CSV — https://support.microsoft.com/en-us/excel/opening-csv-utf-8-files-correctly-in-excel — UTF-8 的 CSV 带 BOM 才能在 Excel 里直接打开。
72. Microsoft Q&A（社区回答）· Excel 2013 保存 UTF-8 CSV — https://learn.microsoft.com/en-us/answers/questions/4863777/how-can-i-save-a-csv-with-utf-8-encoding-using-exc — 「Instead of Unicode, Excel encodes CSV files using ANSI」。这是社区用户的回答，不是微软的官方文档，只作旁证；GBK 兜底以 spec 验收 19 的实测为准。
73. OWASP · CSV 注入 — https://community.owasp.org/attacks/CSV_Injection — 危险的开头字符有 `=`、`+`、`-`、`@`、制表符、回车、换行，以及它们的全角形式。给 Excel 的建议是在引号内加制表符前缀；同时提醒，Excel 另存再打开后，这些转义可能失效，制表符也会留在数据里。旧地址已 308 跳转到这里。

## 六、审计

74. Vercel · 活动日志 — https://vercel.com/docs/activity-log — 事件配白话描述；相对时间悬停看精确时间。
75. EnterpriseReady · 审计日志 — https://www.enterpriseready.io/features/audit-log/ — 事件要有人能读懂的描述；写入后不可改。
76. GitHub · 审计事件 — https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/audit-log-events-for-your-organization — category.action 编码配一句白话。
77. AppMaster · 活动流 — https://appmaster.io/blog/audit-logging-internal-tools-activity-feed — 动词 + 对象；时间线布局；系统操作与真人操作分开标注。
78. AWS CloudTrail · 事件历史 — https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-console.html — 默认只看写操作；详情先列资源，再给原文。
79. Linear · 审计日志 — https://linear.app/docs/audit-log — 可以过滤掉登录事件。
80. Atlassian · 审计日志 — https://support.atlassian.com/security-and-access-policies/docs/view-audit-log-activities/ — 默认近 7 天；详情面板；导出当前筛选的结果。

## 七、字体与授权

81. google/fonts · Geist — https://github.com/google/fonts/tree/main/ofl/geist — Geist 的 OFL 原文件（v1.800），可变字重 100–900；等宽数字每位 0.600em（实测）。
82. google/fonts · Inter — https://github.com/google/fonts/tree/main/ofl/inter — Inter 4，带 opsz 与 wght 两个轴；等宽数字每位 0.648em，带 opsz 轴的拉丁子集约 86 KB（实测）。
83. google/fonts · Noto Sans SC 许可文本 — https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt — 「Copyright 2014-2021 Adobe … with Reserved Font Name 'Source'」：保留字体名只有「Source」。
84. Adobe · Source Han Sans 2.005R — https://github.com/adobe-fonts/source-han-sans/releases/tag/2.005R — 思源黑体的上游发布。
85. SIL · OFL FAQ — https://openfontlicense.org/ofl-faq/ — 2.6：网页字体的子集化算修改，OFL 允许；2.7、2.8：子集保持功能等价时可以沿用原名，保留字体名另论。
86. npm · @fontsource-variable/noto-sans-sc — https://www.npmjs.com/package/@fontsource-variable/noto-sans-sc — 5.3.0，OFL-1.1；按 Google 的切法分 101 片，每片是 wght 100–900 的可变字体，家族名「Noto Sans SC Variable」。
87. npm · cn-font-split — https://www.npmjs.com/package/cn-font-split — Apache-2.0，Rust 实现；可以把 UI 用字放进第一包、其余按字频切片；默认在 src 里先写 local()，要去掉。
88. 小米 · MiSans 字体知识产权许可协议（PDF） — https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf — 第 2 条：许可可撤销；须在软件中特别注明使用了 MiSans；不得改编或二次开发；不得单独再分发。
89. 小米 · MiSans 常见问题 — https://hyperos.mi.com/font/zh/faq/ — 「是否可以用作嵌入式字体？可以。但您应在软件中特别注明使用了 MiSans 字体」；不得单独对字体做外观上的更改。
90. 华为 · 设计资源（HarmonyOS Sans） — https://developer.huawei.com/consumer/cn/design/resource/ — 包内 LICENSE 只许分发「unmodified copies」，要在软件里显著声明，不得做任何修改。
91. 厂商字体授权解读（观点，个人博客） — https://blog.xinshijiededa.men/font-license/ — 对 HarmonyOS 等厂商字体许可条款的解读，只作旁证。
92. ColorOS · OPPO Sans 4.0 — https://www.coloros.com/article/A00000074/ — 许可与 HarmonyOS Sans 几乎逐字相同，中文摘要另有「不向他方提供其他下载渠道」。
93. vivo · vivo Sans 开发者文档 — https://developers.vivo.com/doc/d/314fa33cbaec4a93be351cd44757d9d9 — 许可与 MiSans 同一模板（署名、不得改编、不得单独分发），没有解释「改编」范围的 FAQ。
94. 阿里巴巴字体 — https://fonts.alibabagroup.com/ — 普惠体 3.0 的法律声明：未经授权不得上传、发布、转载字体文件，不得转换、拆分。
95. Fontshare · ITF Free Font License — https://www.fontshare.com/licenses/itf-ffl — 可以在自己的服务器上自托管，但禁止修改，包括子集化和格式转换。
96. Jim Nielsen · The AI Aesthetic（观点，2026-07-29） — https://blog.jim-nielsen.com/2026/ai-aesthetic/ — 点名的 AI 产品通病有「beige/cream colors, orange accents, and serif typefaces」，以及比原生应用「much smaller, thinner icons」的侧栏图标。

## 八、排版

97. MDN · text-autospace — https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace — 中西文之间自动留间距，Baseline 2025。
98. W3C · 中文排版需求（clreq） — https://www.w3.org/TR/clreq/ — 汉字与西文、数字之间的间距不多于 1/4 汉字宽。
99. MDN · font-synthesis — https://developer.mozilla.org/en-US/docs/Web/CSS/font-synthesis — `none` 禁止浏览器合成粗体、斜体；CJK 字体通常没有这些变体，合成会影响可读性。
100.  MDN · rel=preload — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload — 字体预加载要写 `as="font"`、`type` 和 `crossorigin`。
101.  MDN · font-display — https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display — `swap` 先用回退字体显示，字体到了再换上。
102.  Lucide · 图标规范 — https://lucide.dev/contribute/icon-design-guide — 描边统一，不混用粗细。

## 九、可访问性、平台与工程

103. WCAG 2.2 · 1.4.3 最低对比度 — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html — 文字 4.5:1，大字 3:1；只有不可操作的组件豁免。
104. WCAG 2.2 · 1.4.11 非文字对比度 — https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html — 控件边界、焦点态和状态图形 3:1。
105. WCAG 2.2 · 1.4.1 颜色的使用 — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html — 颜色不能是唯一的表达手段。
106. WCAG 2.2 · 2.4.7 焦点可见 — https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html — 键盘焦点要看得见。
107. WCAG 2.2 · 1.4.10 重排 — https://www.w3.org/WAI/WCAG22/Understanding/reflow.html — 320px 宽下可以重排，数据表本身豁免。
108. WCAG 2.2 · 2.4.2 页面标题 — https://www.w3.org/WAI/WCAG22/Understanding/page-titled.html — 每页有描述性的标题。
109. WCAG 2.2 · 2.1.1 键盘 — https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html — 所有功能都能用键盘操作。
110. WCAG 2.2 · 4.1.2 名称、角色、值 — https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html — 控件要有可访问名称。
111. WCAG 2.2 · 2.5.8 目标尺寸（最小） — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html — 点击目标至少 24×24 CSS px。
112. WCAG 2.2 · 2.5.7 拖动 — https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html — 用拖动完成的功能，都要能用不拖动的单指针方式完成（AA 级）。
113. MDN · prefers-reduced-motion — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion — 系统要求减少动效时关闭动画。
114. MDN · CSP default-src — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/default-src — 没写的 font-src、img-src 回退到 default-src。
115. Ant Design · 定制主题 — https://ant.design/docs/react/customize-theme-cn — seed / map / alias token；`algorithm`；`getDesignToken`；`cssVar`；`zeroRuntime`。spec 里「种子色会被算法重新派生」的结论，是在 antd 6.6.5 上用 `getDesignToken` 实测得到的。
116. Ant Design 组件样式源码 — https://github.com/ant-design/ant-design/tree/master/components — 在 console 安装的 antd 6.6.5 里核对过：Tabs、Pagination 的选中色，Button 默认按钮的悬停色，Input/Select 的激活边框都取自 `colorPrimary` 系；`Radio.Button` 描边型的选中字色写死为 `colorPrimary`；Tag 状态预设的字色取 `color{Type}` 而不是 `*Text`；Badge 计数是白字配 `colorError`；Form 必填星号取 `labelRequiredMarkColor`（默认等于 `colorError`）；焦点框取 `colorPrimaryBorder`。
117. Vite · 构建选项 — https://vite.dev/config/build-options — `assetsInlineLimit` 默认 4096，设 0 关闭内联；`chunkSizeWarningLimit` 默认 500 kB。
118. TanStack Router · 代码分割 — https://tanstack.com/router/latest/docs/framework/react/guide/code-splitting — 代码式路由用 `createLazyRoute` 与 `.lazy()` 拆分。
119. TanStack Router · 导航拦截 — https://tanstack.com/router/latest/docs/framework/react/guide/navigation-blocking — `useBlocker` 的 `shouldBlockFn`、`enableBeforeUnload`、`withResolver`。
120. web.dev · CLS — https://web.dev/articles/cls — CLS ≤ 0.1（第 75 百分位）为良好。
121. web.dev · LCP — https://web.dev/articles/lcp — LCP ≤ 2.5 秒为良好。
122. web.dev · HTTP 缓存 — https://web.dev/articles/http-cache — 带哈希的静态资源长缓存，HTML 不缓存。
123. BREACH — https://www.breachattack.com/ — 压缩的响应里同时有秘密和攻击者可控的输入时，秘密可以被推断出来。
124. CodeMirror · 本地化 — https://codemirror.net/examples/translate/ — 用 `EditorState.phrases` 翻译界面文案。
125. CodeMirror · 参考手册（merge） — https://codemirror.net/docs/ref/#merge — `unifiedMergeView`、`allowInlineDiffs`、`mergeControls`、`collapseUnchanged`、`revertControls`。
