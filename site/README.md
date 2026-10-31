# 官网构建

## 本机后台预览

从仓库根运行 `pnpm exec tsx scripts/product-sites/preview-stack.ts up`。需要本机 Docker/Colima；工具创建独立的 pgvector/pgvector:pg17，执行全部迁移，构建 console，以 prod、数据库配置/会话存储和离线模型启动服务。全部内容为合成数据，包括工业品牌、产品、话术、待审批报价、转人工会话及七天运行记录。

URL、端口和随机 owner/共享 agent 账号只保存在 gitignored 的 `var/preview-stack.json`（仅当前用户可读），不会打印。使用其中的 `http://localhost:<端口>/console/`；服务、控制端口及数据库映射仅监听 127.0.0.1，无 HTTPS 终止或自签证书。状态文件不再保留代理所用的 appPort。共享 agent 不能读设置或用量。不要把该文件或运行日志用于官网产物。工具不读取真实 env、不调用真实模型，也不连接已有数据库。

生产仍使用 HTTPS，cookie 名及 `Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age` 保持不变，无 Domain。Chrome/Firefox 接受 HTTP localhost 的 Secure cookie 例外；自检先校验全部属性，再按这类浏览器的同源 localhost 规则保存并回送 cookie，不直接把任意 Set-Cookie 当成登录成功。[Firefox 的实现记录](https://bugzilla.mozilla.org/show_bug.cgi?id=1618113)说明该例外；Safari/WebKit 的支持仍有[兼容限制](https://bugs.webkit.org/show_bug.cgi?id=232088)，不能把自检成功当成 Safari 登录通过。HTTP 预览请使用 Chrome/Firefox，不改生产 cookie 或放宽 prod 判定。

再次执行 `up` 会先清理上一套环境。结束后运行 `pnpm exec tsx scripts/product-sites/preview-stack.ts down`，停止服务并删除容器、卷、临时目录和账号文件。纯函数自测为 `pnpm exec tsx scripts/product-sites/preview-stack.selftest.ts`，不会启动 Docker；预览工具不接入 CI 的 test 行。

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
