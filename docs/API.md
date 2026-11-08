# API

所有接口均为本机 HTTP，响应 JSON；失败为 `{ "error": "原因" }`。扫描与验证返回 `{id,status:"queued"}`，使用 `GET /api/jobs/:id` 查询状态，`POST /api/jobs/:id/cancel` 可取消正在运行的任务。

| 方法与地址 | 作用 |
| --- | --- |
| GET /api/status | 模型是否已配置 |
| GET /api/fixtures | 三个内置示例 |
| GET /api/projects | 项目列表 |
| POST /api/projects | multipart 文件 `file` 或字段 `fixture`，创建 V0 |
| POST /api/projects/import-url | 采集公开网页的本地快照，创建 V0 |
| GET /api/projects/:id | 项目、版本、当前与初始扫描及报告摘要 |
| POST /api/projects/:id/audits | 扫描当前版本 |
| GET /api/audits/:id/screenshot | 扫描截图 |
| GET /api/projects/:id/audits/:auditId/semantics | 重现扫描版本并读取目标元素的 Chromium 无障碍语义 |
| GET /api/knowledge/:rule | 本地 WCAG 映射 |
| POST /api/projects/:id/issues/:issueId/proposals | `{source:"manual",value:"..."}` 或 `{source:"ai"}` |
| POST /api/proposals/:id/apply | 审核后应用并异步验证 |
| POST /api/proposals/:id/reject | 拒绝建议 |
| PATCH /api/projects/:id/snapshots/:snapshotId | `{name:"图片替代文本修复"}` 重命名有效版本，返回 `{id,name}`。名称去除首尾空白，限 1–48 个字符、单行 |
| POST /api/projects/:id/rollback | `{snapshotId:"..."}` 恢复有效版本。切换到不同快照会取消项目此前的待审核补丁 |
| GET /api/projects/:id/reports | 报告数据 |
| GET /api/projects/:id/export | 源码、截图与报告 ZIP |

AI 修复统一使用 `source:"agent"`。旧 `source:"ai"` 路由到同一流程。可生成待审核补丁时返回 HTTP 201 和 `patch`，同时提供结构化的 `analysis`。图片分析和无法安全生成补丁的结果以 HTTP 200 返回，包含候选值、理由、视觉观察和可用来源；不会写入文件。图片预览由 `GET /api/projects/:id/issues/:issueId/image-preview?snapshot=…` 提供。手工图片补丁可带 `imagePurpose`，应用时用 `semanticReviewed:true` 记录人工确认。

补丁只允许 `set-alt`、`set-label`、`set-name`、`set-color`；后端重新检查规则、目标、版本与文件哈希。模型只提供值和解释，用户审核确认。URL 导入只允许符合下述限制的公开网页。

## URL 快照

`POST /api/projects/import-url` 接收 JSON `{"url":"https://example.com/page","mode":"rendered"}`。`mode` 可为 `rendered` 或 `static`，省略时为 `static`，界面默认选择 `rendered`。成功返回 HTTP 201 和常规项目字段，以及 `assets: {stylesheets,images,skipped}`；动态采集额外返回 `rendering: {mode,requests,blocked,empty}`。空白或缺少资源的快照不代表完整网页。应用补丁只会写入本地项目副本。

- 主页面须为公开 HTTP(S) 地址，使用默认端口且没有 URL 凭据。对主页面和资源的每一跳检查全部 DNS 地址，拒绝任一非公网地址。若本机代理 DNS 对域名仅返回 198.18.0.0/15 合成地址，使用阿里云公共 DNS 查询域名（不发送路径或参数）；校验其 A/AAAA 结果均为公网地址后固定连接到已校验的真实 IP。IP 字面量、普通私网或混合 DNS 结果不会触发回退。HTTPS 继续验证原始域名的证书。最多跟随四次重定向。
- 静态模式仅获取最终页面同源的 CSS 和 PNG、JPEG、GIF、WebP，动态模式还尝试跨源公开资源。CSS 的普通 `url()` 图片引用会尝试转为本地文件。每次最多尝试八个样式表和二十个不同图片，HTML 限 2 MB、静态 CSS 限 256 KB、动态 CSS 限 2 MB、单图限 1 MB，响应体总量静态限 8 MB、动态限 24 MB。单项请求含 DNS 和重定向限 6.5 秒，静态采集总期限 20 秒，动态采集 45 秒。
- 动态模式在独立无登录 Chromium 中执行脚本，最多 100 个请求；只允许 GET，WebSocket 和 service worker 禁用，所有请求由服务端验证公网地址并固定连接。渲染后的 DOM 去除脚本并保存，后续检测不会再次执行脚本。登录、POST、验证码、复杂交互及部分资源可能无法还原；采集结果不能直接修改原站或 JavaScript 源码。
- 静态模式不执行脚本。两种模式均不保留嵌套 CSS 导入、响应式图片资源和不支持的格式。请求失败、目标不受支持或校验失败时返回 400，并发上限触发时返回 429。

## 浏览器语义证据

`GET /api/projects/:id/audits/:auditId/semantics?selector=...` 按同一项目内的已完成扫描重现对应快照，从 Chromium 无障碍树读取单一元素。选择器应使用扫描或验证记录中的原始选择器并做 URL 编码。

响应字段为 `name`、`role`、`ignored`、`ignoredReasons`、`focusable`、`states`、`bounds` 和 `size`。`states` 为 Chromium 返回的常用状态名和值。若元素没有可用于对齐原截图的位置，`bounds` 为 `null`。无法唯一定位时返回错误。历史前后截图继续使用原扫描 ID 和截图接口，验证结论来自已保存的 axe-core 复测记录。

## V2 检测证据及 AI 辅助复核

V2 扫描在原有结果上增加 `detection` 字段，旧扫描可没有此字段。原有 `issues`、`incomplete` 摘要、问题 ID、补丁及自动复测判定继续使用原有口径。

| 字段 | 用途 |
| --- | --- |
| `detection.engine`、`timing` | Chromium 页面中实际运行的 axe 版本、标签和各阶段耗时 |
| `detection.violations`、`incomplete` | WCAG 规则的完整节点与 checks 证据，分别为确定违规和待复核 |
| `detection.bestPractices` | 最佳实践的违规与不确定结果，独立于 WCAG 确定违规 |
| `detection.behavior` | 静态 Tab 轨迹、证据、覆盖边界和语义候选。状态有 `completed`、`partial`、`unavailable`。行为发现有 `observed` 或 `needs-review` |
| `detection.ai.findings` | 可选疑似结果与人工决定。接受后的条目仍保留 AI 来源，属于人工认可项 |

`issues` 和 `detection.violations` 保持确定性规则违规口径。`detection.incomplete`、最佳实践及行为发现独立记录。`observed` 表示浏览器提供了可核验的事实，例如计算出的可访问名称为空。`needs-review` 表示启发式风险或需要交互上下文的证据，均不会加入自动修复问题列表。

`focus-order-positive-tabindex` 记录真实 Tab 轨迹相对 DOM 顺序的逆序，并附上被超越的控件选择器。正 `tabindex` 本身仍可由 axe 最佳实践报告，但行为探查需要观察到逆序才发出提示。DOM 顺序是阅读顺序的近似，需结合业务任务判断。`focus-style-unchanged` 比较控件、伪元素和最多四层近邻祖先的计算样式，忽略全透明轮廓、边框和阴影。遮挡、对比度、远处指示器和动态交互仍需要人工复核。

- `POST /api/projects/:id/audits/:auditId/ai-review`，请求体 `{"consent":true}`。显式确认后才向配置的模型发送最多 20 项可访问名称、角色、类型及附近文字。不会发送图片、完整 HTML 或补丁。成功后，同一扫描的重复请求返回已保存批次。模型不可用时，不影响已有规则、行为或修复记录。
- `PATCH /api/projects/:id/audits/:auditId/ai-review/:findingId`，请求体 `{"decision":"accepted"}`。可选 `accepted`、`rejected`、`needs-review`。结果保存到对应扫描和 JSON 报告。接受项既不进入自动违规列表，也不修改文件。
- 工作台与结果报告显示 V2 行为证据、最佳实践及已保存的 AI 复核结果。AI 复核的请求和决定通过 API 提交。导出 ZIP 内的 JSON 保留完整证据。图片 Alt 检查只看文本和邻近文字，无法辨认图片内容。

项目详情和报告包含有效快照的 `name` 和 `parent_id`。旧快照自动按原始版本或补丁规则显示默认名称。`resolved` 是当前快照继承的、已通过验证且未在当前检测中再次出现的问题，每项关联 `verificationId`。`summary.resolved` 是该列表的数量。`verifications` 仍包含全部分支的成功和失败记录。
