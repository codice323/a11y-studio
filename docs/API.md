# API

所有接口均为本机 HTTP，响应 JSON；失败为 `{ "error": "原因" }`。扫描与验证返回 `{id,status:"queued"}`，使用 `GET /api/jobs/:id` 查询状态，`POST /api/jobs/:id/cancel` 可取消正在运行的任务。

| 方法与地址 | 作用 |
| --- | --- |
| GET /api/status | 模型是否已配置 |
| GET /api/fixtures | 三个内置示例 |
| GET /api/projects | 项目列表 |
| POST /api/projects | multipart 文件 `file` 或字段 `fixture`，创建 V0 |
| POST /api/projects/import-url | 获取公开网页的本地静态快照，创建 V0 |
| GET /api/projects/:id | 项目、版本、当前与初始扫描及报告摘要 |
| POST /api/projects/:id/audits | 扫描当前版本 |
| GET /api/audits/:id/screenshot | 扫描截图 |
| GET /api/projects/:id/audits/:auditId/semantics | 重现扫描版本并读取目标元素的 Chromium 无障碍语义 |
| GET /api/knowledge/:rule | 本地 WCAG 映射 |
| POST /api/projects/:id/issues/:issueId/proposals | `{source:"manual",value:"..."}` 或 `{source:"ai"}` |
| POST /api/proposals/:id/apply | 审核后应用并异步验证 |
| POST /api/proposals/:id/reject | 拒绝建议 |
| POST /api/projects/:id/rollback | `{snapshotId:"..."}` 恢复有效版本 |
| GET /api/projects/:id/reports | 报告数据 |
| GET /api/projects/:id/export | 源码、截图与报告 ZIP |

补丁只允许 `set-alt`、`set-label`、`set-name`、`set-color`；后端重新检查规则、目标、版本与文件哈希。模型只提供值和解释，用户审核确认。URL 导入只允许符合下述限制的公开网页。

## URL 静态快照

`POST /api/projects/import-url` 接收 JSON `{"url":"https://example.com/page"}`。成功返回 HTTP 201 和常规项目字段 `id`、`name`、`entry`、`currentSnapshot`、`createdAt`，另含 `assets: {stylesheets,images,skipped}`。前两项为保存的文件数，`skipped` 为跳过或未获取的资源引用计数。资源缺失时仍可创建静态项目。创建后，调用已有的扫描接口。应用补丁只会写入本地项目副本。

- 主页面须为公开 HTTP(S) 地址，使用默认端口且没有 URL 凭据。对主页面和资源的每一跳检查全部 DNS 地址，拒绝任一非公网地址。连接固定到已校验的 IP，HTTPS 继续验证原始域名的证书。最多跟随四次重定向。
- 仅获取最终页面同源的 CSS 和 PNG、JPEG、GIF、WebP。CSS 的普通 `url()` 图片引用会尝试转为本地文件。每次最多尝试八个样式表和二十个不同图片，HTML 限 2 MB、CSS 限 256 KB、单图限 1 MB，响应体总量限 8 MB。单项请求含 DNS 和重定向限 6.5 秒，资源获取总期限 20 秒。
- 请求无用户登录状态，按静态内容保存。脚本、嵌入内容和外部资源不执行或加载，嵌套 CSS 导入、响应式图片资源和不受支持的格式会被跳过。请求失败、目标不受支持或校验失败时返回 400 和错误说明。并发上限触发时返回 429。

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

- `POST /api/projects/:id/audits/:auditId/ai-review`，请求体 `{"consent":true}`。显式确认后才向配置的模型发送最多 20 项可访问名称、角色、类型及附近文字。不会发送图片、完整 HTML 或补丁。成功后，同一扫描的重复请求返回已保存批次。模型不可用时，不影响已有规则、行为或修复记录。
- `PATCH /api/projects/:id/audits/:auditId/ai-review/:findingId`，请求体 `{"decision":"accepted"}`。可选 `accepted`、`rejected`、`needs-review`。结果保存到对应扫描和 JSON 报告。接受项既不进入自动违规列表，也不修改文件。
- AI 复核目前通过 API 和导出的 JSON 使用。图片 Alt 检查只看文本和邻近文字，无法辨认图片内容。
