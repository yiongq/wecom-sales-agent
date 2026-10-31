# 官网构建

官网为四类静态页面和 404，无脚本、无租户 API、无成员 cookie。字体复用仓库内有许可的 Geist、Geist Mono、思源黑体；构建时复制到产物，附字体许可。部署静态根应指向 site/dist，404 响应映射由部署层完成。

从仓库根运行：

```sh
pnpm exec tsx scripts/product-sites/build.ts site --sample
pnpm exec tsx scripts/product-sites/build.ts all --input "$PRODUCT_PUBLISH_INPUT"
```

--sample 只生成合成输入用于本地验证，产物会显示「合成样例」，不得用于正式发布。正式构建必须传 --input 指定仓库外的 JSON，遵循 ProductPublishInput：bases.www/app/docs 为三个不同的 HTTPS 根地址；logoFile 为 PNG/WebP，faviconFile 为 PNG/ICO；legal.privacyFile/termsFile 为审定的纯文本正文，带 version 与 ISO 日期 effectiveDate；applicationInstructions 为申请说明，sourceRepositoryUrl 为公开源码入口。相对文件路径相对于 JSON 文件。缺少任何必填项、缺文件或未替换模板占位均失败；错误不回显私有值。

## 截图清单

只从 site/screenshots 读取 screenshots.ts 显式登记的文件，不扫描其他目录。现在显示文字占位，缺图不算失败。协调者在后台合入后以合成数据补 WebP：

| 文件名                 | 尺寸        | 内容                       |
| ---------------------- | ----------- | -------------------------- |
| rfq-workbench.webp     | 1600 × 1000 | 多行询价、缺规格、接手入口 |
| quote-review.webp      | 1600 × 1000 | 型号数量试算、审批前后边界 |
| settings-readonly.webp | 1600 × 1000 | 只读组织、配置与运行状态   |

禁止真实会话、个人信息、真实客服码、回调地址、部署地址与凭据。补图后保留图片旁的内容说明，图片失败时仍有文字。

## 法律正文

legal-templates 提供公开通用模板，必须由运营方在私有发布层审定并替换全部占位。输入检查只能验证完整性，不能代替法律审定。正式发布还须由协调者核对素材、法律版本、实际链接及发布授权。
