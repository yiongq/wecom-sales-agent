# 后台 UX 重做 · 参考文献

spec.md 里的 [n] 指这里的编号。条目按研究视角分组，每条用一句话说明引用了它的什么。编号在修订中保持不变：换了来源的条目沿用原编号，新增的来源从 160 往后编。标「观点」的是个人或机构的看法，不当作规范引用。

## 一、B 端设计系统基础

1. Ant Design · 导航 — https://ant.design/docs/spec/navigation-cn — 侧边导航便于向下扩展，标签可以长；尽量少用面包屑。
2. GitLab Pajamas · 侧栏导航 — https://design.gitlab.com/patterns/navigation-sidebar — 只有两层；标签 1–2 个词；一级项各配唯一的图标；小屏时默认隐藏。
3. ProComponents · ProLayout — https://github.com/ant-design/pro-components/blob/master/site/components/layout.md — 菜单分组（`siderMenuType: 'group'`）。
4. Ant Design · 按钮 — https://ant.design/docs/spec/buttons-cn — 一个按钮区最多一个主按钮；有风险的操作放在最后。
5. Polaris React（已归档）· 资源索引页 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/patterns/resource-index-layout/variants/default.mdx — 「Always use the primary action in the top right corner for resource creation」。
6. Atlassian · 页头 — https://atlassian.design/components/page-header/usage — 每页一个页头；规定了标题、操作、筛选的位置。
7. ProComponents · PageContainer — https://github.com/ant-design/pro-components/blob/master/site/components/page-container.md — 页面操作区 `extra` 与底部工具栏。
8. Ant Design · 工作台 — https://ant.design/docs/spec/research-workbench-cn — 首屏放最常用的内容，给出到达目的地的最短路径。
9. Shopify · App 首页 — https://shopify.dev/docs/apps/design-guidelines/user-experience/app-home-page — 首页放快速统计、状态更新和可立即执行的操作。
10. Carbon · 数据表用法 — https://carbondesignsystem.com/components/data-table/usage/ — 行操作少于 3 个时放在行内。
11. Carbon · 数据表样式 — https://carbondesignsystem.com/components/data-table/style/ — 行高档位；两行内容用 64px 的超大行高。只用来支撑会话行 64px。
12. Carbon · 状态指示 — https://carbondesignsystem.com/patterns/status-indicator-pattern/ — 状态至少同时用上符号、形状、颜色、文字中的三样；草稿用灰色。
13. Ant Design · 数据列表 — https://ant.design/docs/spec/data-list-cn — 点标题进详情；调整筛选即时生效；不足一页不显示分页器。
14. Ant Design · 字体 — https://ant.design/docs/spec/font-cn — 主字号 14/22；字号 3–5 级，并给出 24、30、38 等档位；中文多数情况只用 regular 和 medium，semibold 用于英文加粗；表格数字用 tabular-nums。
15. GitLab · 筛选 — https://design.gitlab.com/patterns/filtering — 搜索在左、筛选随后、排序靠右；窄屏时筛选下移。
16. Polaris React（已归档）· 索引筛选 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/selection-and-input/index-filters.mdx — 「Include no more than 2 or 3 promoted filters」；筛选标签的命名。
17. NN/g · 无限滚动 — https://www.nngroup.com/articles/infinite-scrolling/ — 目标明确的查找任务不宜用无限滚动。
18. Carbon · 空状态 — https://carbondesignsystem.com/patterns/empty-states-pattern/ — 空状态替换原本的元素；标题宜用正向说法。
19. GitLab · 空状态 — https://design.gitlab.com/patterns/empty-states — 搜索无结果时不放 CTA；标题不超过 5 个词。
20. Carbon · 加载 — https://carbondesignsystem.com/patterns/loading-pattern/ — 用骨架屏代替转圈。
21. NN/g · 骨架屏 — https://www.nngroup.com/articles/skeleton-screens/ — 整页加载用骨架屏。
22. Carbon · 表单 — https://carbondesignsystem.com/patterns/forms-pattern/ — 标签 1–3 个词；帮助文字常驻；占位符不放关键内容；长表单不禁用主按钮。
23. GitLab · 表单 — https://design.gitlab.com/patterns/forms — 默认必填，只标选填。
24. Ant Design · 表单模板 — https://ant.design/docs/spec/research-form-cn — 基础、弱分组、区内分组、卡片分组四档。
25. Polaris React（已归档）· 资源详情页 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/patterns/resource-details-layout/variants/default.mdx — 「The primary content occupies two thirds of the page」；「Put supporting information such as status, metadata, and summaries in the secondary column」。
26. Carbon · 只读状态 — https://carbondesignsystem.com/patterns/read-only-states-pattern/ — 只读文字保持启用态的颜色，并满足 4.5:1。
27. GitLab · 设置管理 — https://design.gitlab.com/patterns/settings-management — 不能改的设置要写清原因。
28. Polaris React（已归档）· 上下文保存条 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/internal-only/contextual-save-bar.mdx — 表单有未保存的改动时出现，提供保存和放弃。
29. GitLab · 保存与反馈 — https://design.gitlab.com/patterns/saving-and-feedback — 错误「belongs in an alert rather than a toast, which auto-dismisses and cannot carry the retry action」；toast 不带操作；自动保存和手动保存二选一；离开时提示未保存，按钮是「保存」与「放弃改动并离开」。
30. Ant Design · 反馈 — https://ant.design/docs/spec/feedback-cn — 重要的失败通知用对话框或页内提示。
31. Polaris React（已归档）· 横幅 — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/feedback-indicators/banner.mdx — 页面级横幅「placed at the top of that page, below the page header」；至多一个主操作。
32. Polaris React（已归档）· Toast — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/internal-only/toast.mdx — 不鼓励用 toast 报错，只留给「网络断开」这类非用户造成、三个词说得清的错误；持续性的错误用横幅。
33. Atlassian · Flag — https://atlassian.design/components/flag/usage — 严重的警告和错误不要自动消失。
34. Fluent 2 · MessageBar — https://fluent2.microsoft.design/components/web/react/core/messagebar/usage — 错误和警告要带按钮或链接。
35. GitLab · 破坏性操作 — https://design.gitlab.com/patterns/destructive-actions — 按严重度分级，高严重度用模态确认；确认按钮用 danger 变体。
36. NN/g · 确认对话框 — https://www.nngroup.com/articles/confirmation-dialog/ — 写清具体后果；按钮用描述性的动词；不要滥用确认。
37. Carbon · 对话框 — https://carbondesignsystem.com/patterns/dialog-pattern/ — 不可逆操作用 danger 模态。
38. Atlassian · 色彩 — https://atlassian.design/foundations/color — danger 只用于危险或严重错误；有语义的地方不用装饰色代替。
39. Ant Design · 色彩 — https://ant.design/docs/spec/colors-cn — 功能色代表明确的信息和状态。
40. Ant Design · 暗黑模式 — https://ant.design/docs/spec/dark-cn — 避免强对比，和浅色保持一致。
41. Ant Design · 布局 — https://ant.design/docs/spec/layout-cn — 栅格基数 8；1440 设计画布与常见分辨率。
42. Ant Design · 亲密性 — https://ant.design/docs/spec/proximity-cn — 8 / 16 / 24 三档间距。
43. Atlassian · 间距 — https://atlassian.design/foundations/spacing — 组件内、组件间、布局三段 space token。
44. Ant Design · 文案 — https://ant.design/docs/spec/copywriting-cn — 说用户熟悉的话；省略无用的词；出错时用「无法」；「不能」「请勿」有命令感。
45. GitLab · 日期与时间 — https://design.gitlab.com/content/date-and-time — 审计用绝对时间；相对时间悬停给出绝对时间。
46. Ant Design · 数据格式 — https://ant.design/docs/spec/data-format-cn/ — 金额加千分位；数字右对齐；单位写在表头。
47. Ant Design · 数据录入 — https://ant.design/docs/spec/data-entry-cn/ — 给偶尔使用的人简单易懂的标签和就地提示。
48. NN/g · 十条可用性原则 — https://www.nngroup.com/articles/ten-usability-heuristics/ — 系统状态可见；说用户的话。
49. NN/g · 错误信息 — https://www.nngroup.com/articles/error-message-guidelines/ — 错误放在出错处附近，用平实的语言，并给出修复建议。
50. NN/g · 表单占位符 — https://www.nngroup.com/articles/form-design-placeholders/ — 关键信息不要只放在占位符里。

## 二、提示词与配置发布产品

51. Dify · 版本控制 — https://docs.dify.ai/en/use-dify/build/version-control — Current Draft「Not live for users」、Latest Version「The live version users see」；Restore 会把旧版本载入草稿并覆盖当前草稿。旧地址已经 404，这是 2026-09 核对过的现行地址。
52. n8n · 保存与发布 — https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows — 「Changes save automatically as you edit, typically within 1 to 5 seconds」；没有可发布的改动时发布按钮禁用；「Only one person can edit a workflow at a time」，并发靠编辑锁。
53. Dify · 讨论 #3610 — https://github.com/langgenius/dify/discussions/3610 — 用户反映：不带版本号的自动保存会覆盖别人的改动。
54. PromptLayer · 编辑与版本 — https://docs.promptlayer.com/features/prompt-registry/prompt-editor-versioning — 保存前看差异、填提交说明。
55. LangSmith · 管理提示词 — https://docs.langchain.com/langsmith/manage-prompts — 提交历史侧栏、Diff 开关；Promote 时显示将被替换的版本。
56. 扣子 · 版本列表 — https://docs.coze.cn/developer_guides_list_bot_versions — 每个版本都带更新说明。
57. Zendesk · 查看与恢复修订 — https://support.zendesk.com/hc/en-us/articles/9810823284122-Viewing-procedure-revisions-and-restoring-a-previous-version — 修订在正文里行内高亮；恢复的旧版本默认成为草稿。
58. Zendesk · 管理生成式流程 — https://support.zendesk.com/hc/en-us/articles/10040865503898-Managing-generative-procedures-for-AI-agents — 显示谁、多久前编辑过；测试总是用最新的草稿。
59. Fin · guidance 最佳实践 — https://fin.ai/help/en/articles/13975769-fin-guidance-best-practices — 每条指引只解决一个目标。
60. Fin · 具体指引 — https://fin.ai/help/en/articles/10644329-provide-fin-ai-agent-with-specific-guidance — 每条指引最多 2,500 字符；启用前可以预览。只是一家的做法，不代表「普遍」。
61. WordPress · 使用区块（用户文档） — https://wordpress.org/documentation/article/work-with-blocks/#how-to-lock-and-unlock-a-block — 「When a block is locked, a lock icon appears in the block toolbar and in List View」。
62. Decagon · AOP — https://decagon.ai/product/aop — 运营用自然语言写流程，工程保留护栏与集成。
63. OpenAI · 迁出 prompt object — https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object — 把 prompt 迁回代码，走与产品逻辑相同的评审和发布流程；本项目只对护栏这样做。
64. GOV.UK · 字数计数 — https://design-system.service.gov.uk/components/character-count/ — 边打字边更新；超限时不阻止输入；可以设显示阈值。
65. GOV.UK · 错误汇总 — https://design-system.service.gov.uk/components/error-summary/ — 汇总放在页顶，每条链接到对应位置，措辞与行内报错一致。
66. GitHub · 审阅改动 — https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request — 统一视图与并排视图可以切换，选择会沿用。
67. VS Code · 合并冲突 — https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts — 对方、当前、结果三栏；逐块接受；显示剩余冲突数。
68. Vellum · 部署生命周期 — https://docs.vellum.ai/product/deployments/deployment-lifecycle-management — 出问题时一键回退到之前的发布版本。
69. Contentful · 状态 — https://www.contentful.com/help/status/ — 「已发布但有未发布的改动」单独作为一种状态。
70. Google 文档 · 版本历史 — https://support.google.com/docs/answer/190843?hl=en — 侧栏版本历史与命名版本。
71. Notion · 恢复内容 — https://www.notion.com/help/duplicate-delete-and-restore-content — 恢复前可以预览影响。
72. PromptLayer · 发布标签 — https://docs.promptlayer.com/features/prompt-registry/release-labels — 面向开发者的发布标签与分流，作为未采用的对照。

## 三、产品库与旅游行业后台

73. Polaris React（已归档）· IndexTable — https://github.com/Shopify/polaris-react-archive/blob/main/polaris.shopify.com/content/components/tables/index-table.mdx — 索引表的列、筛选与批量操作。
74. Shopify · 搜索、筛选与视图 — https://help.shopify.com/en/manual/shopify-admin/productivity-tools/searching-filtering-views — 默认视图页签与保存的视图。
75. Airbnb · 房源页 — https://www.airbnb.com/resources/hosting-homes/a/introducing-the-listings-tab-638 — 就地给出填写建议；信息更完整的房源预订更多。
76. 美团 · 跟团游后台操作指南（PDF） — https://s3plus.meituan.net/v1/mss_8127d978b5194b83a385154762f5a0cc/notify-publish-academy/%E8%B7%9F%E5%9B%A2%E6%B8%B8%E5%90%8E%E5%8F%B0%E6%93%8D%E4%BD%9C%E6%8C%87%E5%8D%97.pdf — 按业务分组；逐日行程写途经、交通、餐食、住宿；行程描述忌字数过多。
77. 飞猪 · 自由行与跟团游发布规范（CSDN 转载） — https://blog.csdn.net/roseaero/article/details/74783904 — 标题必须包含目的地、天数晚数、旅游形式；费用包含要写具体；费用不含要写明单房差和自费项目。官方规则中心 rule.fliggy.com 是动态页，没能直接链到原文，所以用这份转载，不算一手来源。
78. GetYourGuide · 产品描述 — https://supply.getyourguide.support/hc/en-us/articles/13980969821469-Describing-your-product — 亮点 3–5 条，以动词开头；包含项写简短。
79. GetYourGuide · 创建与编辑行程 — https://supply.getyourguide.support/hc/en-us/articles/14198398866077-Creating-and-editing-an-itinerary — 多日游必须完成逐日行程，完整度影响能否提交。
80. GetYourGuide · 行程常见问题 — https://supply.getyourguide.support/hc/en-us/articles/14198451690525-Itineraries-Frequently-Asked-Questions — 多日游按天录入。
81. Viator · 合作方 API — https://docs.viator.com/partner-api/technical/ — MULTI_DAY_TOUR 按天拆分，附餐食与住宿。
82. Travefy · 复制一天 — https://intercom.help/travefy/en/articles/3712808-how-to-duplicate-a-day — 行程编辑里可以复制某一天。
83. Shopify · 复制商品 — https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/products/duplicate-product — 复制商品时可以把副本设为草稿，并填新标题。替换了原来已失效的 Wetu 链接。
84. 有赞 · 商品发布 — https://help.youzan.com/displaylist/detail_4_4-2-11754 — 按商品类型、基本信息、价格库存、其他信息分组。
85. 有赞 · 商品导入 — https://help.youzan.com/displaylist/detail_5_5-2-11700 — 提供模板；可以下载未导入的结果，查看原因，改好后重新上传。
86. Cloudscape · 禁用与只读 — https://cloudscape.design/patterns/general/disabled-and-read-only-states/ — 需要看的内容用只读，不用禁用；禁用时写明原因和何时可用。
87. Stripe · 管理价格 — https://docs.stripe.com/products-prices/manage-prices — Price 的金额创建后不能改，改价要新建一个 Price；产品本身仍可编辑。
88. Shopify · 保存栏 — https://shopify.dev/docs/api/app-bridge-library/apis/save-bar — 有未保存的改动时出现保存与放弃。
89. Shopify · 添加与更新商品 — https://help.shopify.com/en/manual/products/add-update-products — 状态放在右栏；保存的改动立即在店铺生效，价格也能直接改。
90. NN/g · 表单报错 — https://www.nngroup.com/articles/errors-forms-design-guidelines/ — 报错放在行内；不在输入中途报错；汇总不能是唯一的报错位置。
91. Shopify · 导入商品 — https://help.shopify.com/en/manual/products/import-export/import-products — 先预览再导入；文件须为 UTF-8。
92. HubSpot · 导入报错 — https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors — 区分整行未导入与单个值未导入；可以下载出错的行。
93. Dromo · CSV 导入实践 — https://dromo.io/blog/5-best-practices-to-streamline-your-csv-import-process — 尽早报错，精确到行和列。
94. 微软 · 在 Excel 中正确打开 UTF-8 CSV — https://support.microsoft.com/en-us/excel/opening-csv-utf-8-files-correctly-in-excel — UTF-8 的 CSV 带 BOM 才能在 Excel 里直接打开。
95. Microsoft Q&A（社区回答）· Excel 2013 保存 UTF-8 CSV — https://learn.microsoft.com/en-us/answers/questions/4863777/how-can-i-save-a-csv-with-utf-8-encoding-using-exc — 「Instead of Unicode, Excel encodes CSV files using ANSI」。这是社区用户的回答，不是微软的官方文档，只作旁证；GBK 兜底以 spec 验收 15 的实测为准。替换了原来的 Salesforce 条目，那篇没有直接写这一点。
96. Airbnb · 2023 冬季更新 — https://www.airbnb.com/release/host/2023-winter — 入住指南「see exactly how it will appear to guests」。这里作为「按对方所见预览」的类比引用，不是房源预览。
97. Shopify · Badge — https://shopify.dev/docs/api/app-home/web-components/feedback-and-status-indicators/badge — 徽标色调各有专职：critical 只给紧急问题或破坏性操作，warning 给需要留意的问题。

## 四、会话与审计

98. 美洽 · 历史对话 — https://www.meiqia.com/help/article/history/ — 列表的首个字段是访客名字；可以导出当前筛选的结果。
99. 美洽 · 对话 — https://www.meiqia.com/help/article/conversation/ — 超时、待首次响应等状态；右侧放客户信息。
100.  企业微信 · 客服会话状态 — https://developer.work.weixin.qq.com/document/path/94698 — 智能助手接待、排队、人工接待等 service_state。
101.  Intercom · Fin 会话视图 — https://www.intercom.com/help/en/articles/7860256-view-fin-ai-agent-s-conversations-from-the-inbox — 按 AI 参与、转人工等维度划分的默认视图。
102.  Intercom · 收件箱排序 — https://www.intercom.com/help/en/articles/6989006-inbox-sorting — 按「等了多久」排序。
103.  Primer · RelativeTime — https://primer.style/product/components/relative-time/ — 默认超过 30 天改显示绝对日期。
104.  Vercel · 活动日志 — https://vercel.com/docs/activity-log — 事件配白话描述；相对时间悬停看精确时间。
105.  EnterpriseReady · 审计日志 — https://www.enterpriseready.io/features/audit-log/ — 事件要有人能读懂的描述；写入后不可改。
106.  GitHub · 审计事件 — https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/audit-log-events-for-your-organization — category.action 编码配一句白话。
107.  AppMaster · 活动流 — https://appmaster.io/blog/audit-logging-internal-tools-activity-feed — 动词 + 对象；时间线布局；系统操作与真人操作分开标注。
108.  AWS CloudTrail · 事件历史 — https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-console.html — 默认只看写操作；详情先列资源，再给原文。
109.  Linear · 审计日志 — https://linear.app/docs/audit-log — 可以过滤掉登录事件。
110.  Atlassian · 审计日志 — https://support.atlassian.com/security-and-access-policies/docs/view-audit-log-activities/ — 默认近 7 天；详情面板；导出当前筛选的结果。
111.  Front · 筛选 — https://help.front.com/en/articles/2163 — 每个筛选条件可以单独去掉。
112.  Zendesk · 视图筛选 — https://support.zendesk.com/hc/en-us/articles/5430058226330-Sorting-and-filtering-tickets-in-a-view-to-refine-results — 筛选条件显示成标签，另有一键清除。
113.  OWASP · CSV 注入 — https://community.owasp.org/attacks/CSV_Injection — 危险的开头字符有 `=`、`+`、`-`、`@`、制表符、回车、换行，以及它们的全角形式。给 Excel 的建议是在引号内加制表符前缀；同时提醒，Excel 另存再打开后，这些转义可能失效，制表符也会留在数据里。旧地址已 308 跳转到这里。

## 五、视觉识别

114. Linear · 界面重做 — https://linear.app/now/how-we-redesigned-the-linear-ui — 用少量变量推导主题；导航区降噪。只支撑「倒 L」外框和少量变量推导主题。
115. Stripe · 无障碍色彩系统 — https://stripe.com/blog/accessible-color-systems — 在感知均匀的空间里定色阶，对比度用规则和代码保证。
116. Material · 深色主题 — https://m2.material.io/design/color/dark-theme.html — 用深灰不用纯黑；高饱和色要降饱和；层级靠表面明度区分。
117. 携程 · 暗黑模式实践 — https://blog.csdn.net/ctrip_tech/article/details/105131770 — 深底上的高饱和色会造成视觉抖动。
118. Vercel Geist · 色彩 — https://vercel.com/geist/colors — 色阶按用途分档：背景、边框、文字。
119. Vercel Geist · 材质 — https://vercel.com/geist/materials — 静止的卡片用无阴影的 base 材质；页内另有几档 raised 材质，浮层用 floating 材质。spec 据此写成「阴影主要留给浮层」。
120. Carbon · 动效 — https://carbondesignsystem.com/elements/motion/overview/ — 生产力型动效的时长与曲线。
121. Lucide · 图标规范 — https://lucide.dev/contribute/icon-design-guide — 描边统一，不混用粗细。
122. 紫色渐变问题（观点，dev.to 个人博文） — https://dev.to/james_anderson_h/the-purple-gradient-problem-why-ai-ui-all-looks-alike-and-how-to-fix-it-3j65 — AI 生成界面的同质化特征：紫蓝渐变。
123. AI 模板痕迹（观点，设计工作室博客） — https://www.925studios.co/blog/ai-slop-design-tells — 列出的信号有：全站用 Inter、蓝紫渐变、三张圆角阴影卡片排成一排。原文没有提 emoji，「不用 emoji」是本项目自定的规则。
124. 《清史稿》卷九十二 — https://zh.wikisource.org/zh-hans/%E6%B8%85%E5%8F%B2%E7%A8%BF/%E5%8D%B792 — 「百日内票本用蓝笔，文移蓝印」：清代国丧期间公文改用蓝印。
125. 王中旭：《千里江山图》如何用色（雅昌，摘自《千里江山：徽宗宫廷青绿山水与江山图》） — https://m-news.artron.net/20201222/n1019517.html — 「在石绿、淡石青色的基础上再涂石青色」；「赭石、墨是次要的颜色，用来皴染山脚和阴面」。替换了原来的科普征文，那篇没有提到赭石。
126. Aman 品牌（BP&O 评述） — https://bpando.org/2016/02/16/branding-aman/ — 以克制表达奢华，用的是大地色系。只作为灵感，不当作「一个品牌色」的规范。
127. 飞书 · 字体规范 — https://open.feishu.cn/document/design-specification/design-language/font?lang=zh-CN — 以 Regular / Medium 为主，Semibold 偶尔用于大标题。
128. Fontsource · Noto Serif SC — https://fontsource.org/fonts/noto-serif-sc — 思源宋体，OFL 许可。
129. Wikipedia · Unigrid — https://en.wikipedia.org/wiki/Unigrid — Vignelli 为美国国家公园管理局设计的手册系统，标题配黑色横带。方向 B 的来源；原来的 ndstudio.gov 链接已 404。
130. 登机牌重设计讨论 — https://blog.iso50.com/13468/boarding-passfail/ — 方向 C 的票面信息层级来源。

## 六、可访问性、平台与工程

131. WCAG 2.2 · 1.4.3 最低对比度 — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html — 文字 4.5:1，大字 3:1；只有不可操作的组件豁免。
132. WCAG 2.2 · 1.4.11 非文字对比度 — https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html — 控件边界、焦点态和状态图形 3:1。
133. WCAG 2.2 · 1.4.1 颜色的使用 — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html — 颜色不能是唯一的表达手段。
134. WCAG 2.2 · 2.4.7 焦点可见 — https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html — 键盘焦点要看得见。
135. WCAG 2.2 · 1.4.10 重排 — https://www.w3.org/WAI/WCAG22/Understanding/reflow.html — 320px 宽下可以重排，数据表本身豁免。
136. WCAG 2.2 · 2.4.2 页面标题 — https://www.w3.org/WAI/WCAG22/Understanding/page-titled.html — 每页有描述性的标题。
137. WCAG 2.2 · 2.1.1 键盘 — https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html — 所有功能都能用键盘操作。
138. WCAG 2.2 · 4.1.2 名称、角色、值 — https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html — 控件要有可访问名称。
139. WCAG 2.2 · 2.5.8 目标尺寸（最小） — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html — 点击目标至少 24×24 CSS px。
140. MDN · prefers-reduced-motion — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion — 系统要求减少动效时关闭动画。
141. MDN · text-autospace — https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace — 中西文之间自动留间距，Baseline 2025。
142. W3C · 中文排版需求（clreq） — https://www.w3.org/TR/clreq/ — 汉字与西文、数字之间的间距不多于 1/4 汉字宽。
143. Typotheque · CJK 排版 — https://www.typotheque.com/articles/typesetting-cjk-text — CJK 正文行高约 1.7 更易读。只支撑行高，不支撑行宽。
144. MDN · CSP default-src — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/default-src — 没写的 font-src、img-src 回退到 default-src。
145. MDN · CSP style-src — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src — `setAttribute('style', …)` 与 `style.cssText =` 会被拦；直接给单个属性赋值（`el.style.display = …`）不受限。没有提到 `setProperty`。
146. Ant Design · 定制主题 — https://ant.design/docs/react/customize-theme-cn — seed / map / alias token；`algorithm`；`getDesignToken`；`cssVar`；`zeroRuntime`。spec 里「种子色会被算法重新派生」的结论，是在 antd 6.6.5 上用 `getDesignToken` 实测得到的。
147. Ant Design 6.0 发布说明 — https://github.com/ant-design/ant-design/issues/55805 — v6 默认纯 CSS 变量模式，支持 zeroRuntime。
148. Vite · 构建选项 — https://vite.dev/config/build-options — `assetsInlineLimit` 默认 4096，设 0 关闭内联；`chunkSizeWarningLimit` 默认 500 kB。
149. TanStack Router · 代码分割 — https://tanstack.com/router/latest/docs/framework/react/guide/code-splitting — 代码式路由用 `createLazyRoute` 与 `.lazy()` 拆分。
150. TanStack Router · 导航拦截 — https://tanstack.com/router/latest/docs/framework/react/guide/navigation-blocking — `useBlocker` 的 `shouldBlockFn`、`enableBeforeUnload`、`withResolver`。
151. web.dev · CLS — https://web.dev/articles/cls — CLS ≤ 0.1（第 75 百分位）为良好。
152. web.dev · LCP — https://web.dev/articles/lcp — LCP ≤ 2.5 秒为良好。
153. web.dev · HTTP 缓存 — https://web.dev/articles/http-cache — 带哈希的静态资源长缓存，HTML 不缓存。
154. BREACH — https://www.breachattack.com/ — 压缩的响应里同时有秘密和攻击者可控的输入时，秘密可以被推断出来。
155. CodeMirror · 本地化 — https://codemirror.net/examples/translate/ — 用 `EditorState.phrases` 翻译界面文案。
156. CodeMirror · Lint — https://codemirror.net/examples/lint/ — 带范围的诊断、下划线、悬停说明。
157. CodeMirror · 参考手册（merge） — https://codemirror.net/docs/ref/#merge — `unifiedMergeView`、`allowInlineDiffs`、`mergeControls`、`collapseUnchanged`、`revertControls`。
158. web.dev · prefers-color-scheme — https://web.dev/articles/prefers-color-scheme — 跟随系统深浅色，并提供手动切换。
159. rjsf · uiSchema — https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema/ — `ui:title`、`ui:description`、`ui:order`、`ui:widget` 等。

## 七、本轮新增

160. Jim Nielsen · The AI Aesthetic（观点，2026-07-29） — https://blog.jim-nielsen.com/2026/ai-aesthetic/ — 点名的 AI 产品通病有「beige/cream colors, orange accents, and serif typefaces」，以及比原生应用「much smaller, thinner icons」的侧栏图标。
161. Material Web · 参考色板（M3 tokens） — https://github.com/material-components/material-web/blob/cbd34a8921915af94d5ef65c2a69eece41d5b4f3/tokens/versions/latest/sass/_md-ref-palette.scss — M3 基线 error 色阶里的 `#B3261E`，也就是上一稿朱砂的原值。
162. Tailwind CSS · 颜色 — https://tailwindcss.com/docs/colors — 默认色板，用来检查石青是否撞上通用色（上一稿的石青与 cyan-800 过近）。
163. Ant Design · Timeline — https://ant.design/components/timeline-cn — 默认是圆点加浅色尾线。`RouteLine` 用方形站点和石青实线来区别于它。
164. Contentful Forma 36 · EntityStatusBadge — https://github.com/contentful/forma-36/blob/main/packages/components/badge/src/EntityStatusBadge/EntityStatusBadge.tsx — `published: 'positive'`、`draft: 'warning'`、`changed: 'primary'`：「已发布但有改动」用 primary，不用警示色。
165. Ant Design · Layout — https://ant.design/components/layout-cn — `Sider` 的 `breakpoint` 只接一档（lg 992、xl 1200……），`collapsedWidth` 只有一个值，做不出 1280/992 三档，所以改成受控收起。
166. Ant Design · Form — https://ant.design/components/form-cn — `requiredMark` 可以设为布尔、`'optional'` 或自定义函数；它是 Form 级的配置，也可以经 ConfigProvider 统一设置。
167. rjsf · Form props — https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/form-props/ — `liveValidate: 'onBlur'` 在失焦时校验整张表单；`extraErrors`；`showErrorList`；`translateString` 可以翻译 rjsf 的全部内部文案。
168. rjsf · 自定义模板 — https://rjsf-team.github.io/react-jsonschema-form/docs/advanced-customization/custom-templates/ — `ButtonTemplates`（AddButton、RemoveButton、MoveUpButton、MoveDownButton、SubmitButton）只能经 `templates` 全局覆盖。
169. MDN · font-synthesis — https://developer.mozilla.org/en-US/docs/Web/CSS/font-synthesis — `none` 禁止浏览器合成粗体、斜体；CJK 字体通常没有这些变体，合成会影响可读性。
170. MDN · rel=preload — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload — 字体预加载要写 `as="font"`、`type` 和 `crossorigin`。
171. MDN · font-display — https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display — `swap` 先用回退字体显示，字体到了再换上。
172. WCAG 2.2 · 2.5.7 拖动 — https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html — 用拖动完成的功能，都要能用不拖动的单指针方式完成（AA 级）。
173. 人人都是产品经理 · 一行多少字最合适（经验文章，非规范） — https://www.woshipm.com/pd/5823078.html — 中文 14 号字时每行建议 35–45 字，书籍版心常见 32 字。spec 的 40em 行宽是本项目自己的取值，这篇只作旁证。
174. Ant Design 组件样式源码 — https://github.com/ant-design/ant-design/tree/master/components — 在 console 安装的 antd 6.6.5 里核对过：Tabs、Pagination 的选中色，Button 默认按钮的悬停色，Input/Select 的激活边框都取自 `colorPrimary` 系；`Radio.Button` 描边型的选中字色写死为 `colorPrimary`；Tag 状态预设的字色取 `color{Type}` 而不是 `*Text`；Badge 计数是白字配 `colorError`；Form 必填星号取 `labelRequiredMarkColor`（默认等于 `colorError`）；焦点框取 `colorPrimaryBorder`。
175. @codemirror/lint 6.9.7 发布源码 — https://cdn.jsdelivr.net/npm/@codemirror/lint@6.9.7/dist/index.js — baseTheme 给 `.cm-lintRange-*` 用的是 `backgroundImage: url('data:image/svg+xml,…')`，在 `default-src 'self'` 下会被拦。同一次核对还确认了：`@codemirror/merge` 的 baseTheme 带 `#ee4433`、`#ff000033`、`#e43`、`#d43` 等红色，默认渲染英文的 Accept / Reject / Revert this chunk。
