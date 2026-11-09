# API

所有接口均为本机 HTTP，响应 JSON；失败为 `{ "error": "原因" }`。扫描、异步源码 Agent 和验证以 HTTP 202 返回 `{id,kind:"job",type,status:"queued"}`。使用其中的任务 ID 调用 `GET /api/jobs/:id`，禁止用补丁、审计或验证记录 ID 代替。任务不存在时返回 HTTP 404 和 `JOB_NOT_FOUND`。服务重启后，原有未完成任务保留记录并标记为 `JOB_INTERRUPTED`。可通过 `POST /api/jobs/:id/cancel` 取消活动任务。

| 方法与地址 | 作用 |
| --- | --- |
| GET /api/status | 模型是否已配置 |
| GET /api/fixtures | 三个内置示例 |
| GET /api/projects | 项目列表 |
| POST /api/projects | multipart 文件 `file` 或字段 `fixture`，创建 V0 |
| POST /api/projects/import-url | 采集公开网页的本地快照，创建 V0 |
| GET /api/projects/:id | 项目、版本、当前与初始扫描及报告摘要 |
| GET /api/projects/:id/compare?left=…&right=… | 只读对比两个有效快照。可用 `issueId` 和 `selector` 定位元素。返回扫描和截图引用、文件差异、问题增减及待复核记录 |
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

项目详情和报告包含有效快照的 `name`、`parent_id` 以及根快照的 `originalSnapshotId`。旧快照自动按原始版本或补丁规则显示默认名称。`resolved` 是当前快照继承的、已通过验证且未在当前检测中再次出现的问题，每项关联 `verificationId`。`summary.resolved` 是该列表的数量。`verifications` 仍包含全部分支的成功和失败记录。

表单标签源码修复会采集浏览器中的 id、name、输入类型、自动填充、占位提示、表单及分组标题、关联名称和说明、紧邻文案。优先使用明确的表单语义或直接文案。字段标识符需有相互印证的命名或匹配的业务上下文，线索冲突时提示补充用途。此分支由浏览器证据和规则完成推荐。结果用 `analysis.labelDecision` 区分 `confirm`（建议人工确认）与 `needs-input`（需要补充字段用途）。编辑后可用 `source:"manual",sourceRepair:true,snapshotId,intent` 创建新的原生标签预览，预览不需要调用模型。原生标签仍须通过隔离复测并经用户确认才能应用。

待应用补丁可用 `GET /api/proposals/:id/preview` 读取隔离候选的浏览器语义、截图与可测对比度。接口重建补丁副本，不写入当前快照。链接名称优先引用实际同页标题或明确的 `title`；缺少证据时返回 `linkDecision:"needs-input"`，填写用途后可继续生成受控源码补丁。

## 样式修复和跨页验证

- `select-name` 保留为 axe 确定违规，并复用原生表单标签源码策略。缺少可信文案时可以手动填写用途。焦点和悬空 ARIA 引用的行为发现仍是复核线索。`target-size` 保留在检测结果中，目前需人工核对可点击面积和间距。
- 对比度与焦点方案可使用当前 HTML 文档或其直接链接的本地 CSS。Agent 读取 Chromium 的双视口计算样式、匹配规则、继承、页内和外链来源、媒体条件、伪元素与焦点状态。这些是有限的规则证据，复杂层叠仍由实际渲染验证。
- PostCSS 可改写能单独匹配目标的现有声明，或生成目标限定的声明。多页快照的 CSS 方案限制在当前文档。多页静态源码工程仅在目标 ID 在入口唯一且其他页面均不使用该 ID 时，允许改写同一 ID 限定的外部 CSS，并复验所有附页。现有内联 `!important` 可保留其优先级，源码策略不会新增该标记。
- CSS 方案在预览和提交阶段都复测入口目标及所有附页，附页最多八个。附页比较 axe 违规、Tab 轨迹、焦点证据和静态控件属性，并核对 900px、390px 下的无障碍语义与计算样式及布局指纹。截图摘要用于追查差异。检测到附页变化或证据不足时停止，提交失败沿用原版本和失败记录。静态快照校验不覆盖真实站点脚本、任意视口、触摸操作、Shadow DOM 或未导入资源。

## 源码工程 V1

- `POST /api/projects` 使用 multipart 字段 `file` 上传 ZIP，同时传 `mode=source`。项目状态和列表返回 `mode`，可为 `snapshot`、`static-source` 或 `react-source`。已有项目保持快照模式。
- 静态工程包含 HTML、CSS 和本地资源，可有多个 HTML 页面。React 工程要求 ZIP 根目录有 `index.html` 和 `package.json`，入口 HTML 使用单个本地 JSX/TSX 模块，运行依赖限于 React 和 React DOM。构建使用 A11y Studio 安装的工具链，不运行上传工程的 npm 命令、Vite 配置或插件。
- React 扫描结果的 `issues[].source` 在唯一映射时包含 `file`、`line`、`tag` 和定位键。标记只注入扫描用 bundle。动态展开属性、重复渲染导致的非唯一映射和无法验证的样式变更会安全停止。
- 工程补丁继续走现有 proposal、preview 和 verification API。React 补丁使用 `sourceRepair:true`。应用时需传 `sourceReviewed:true`。React 图片补丁还要求明确 `imagePurpose`，应用时传 `semanticReviewed:true`。扫描报告的 `build` 记录隔离编译结果及耗时。
- ZIP 导出保留原始目录结构，源码工程在 `source/`，网页快照在 `website/`，报告均在 `report/`。导出的 React 文件不包含扫描标记或生成 bundle。

## 页面与状态对照

任务结果逐侧区分 `captured`（已采集）、`unmatched`（页面或操作无法可靠对应）、`failed`（采集失败）和 `skipped`（前置状态未就绪，未执行）。页面目录来自两侧实际版本，采集证据以项目、版本、状态三者关联。同 URL 的不同操作序列可以独立保存。

- `GET /api/projects/:id/panorama?left=<snapshotId>&right=<snapshotId>` 列出版本中已有的本地 HTML、项目保存的交互状态、步骤及两侧已采集问题数。状态的 `counts` 只包含有独立检测结果、且最近一次尝试未失败或中断的版本。0 表示确定性违规为零，仍可能存在待复核证据。截图可用性单独判断。`entries` 按版本 ID 提供已有扫描的入口文件、整页截图路径和尺寸，作为尚未采集入口状态时的只读预览。
- `POST /api/projects/:id/panorama` 创建可取消的 `panorama` 任务。进行中的相同请求返回同一任务 ID，已完成且截图齐全的状态直接复用证据。请求提供 `left`、`right`，并传 `start`（已导入的 HTML 文件）或 `stateId`。延伸状态时附加 `step` 与 `from: "left" | "right"`。操作支持 `click`、`fill`、`validate`、`tab`、`shift-tab`、`escape` 和 `scroll`。带控件的步骤只接受角色及精确可访问名称。输入使用固定测试值，校验只触发原生约束检查。
- 同一 POST 入口传入 `{left,right,site:true}`，按实际 HTML 文件批量采集。React 工程也会执行入口导航区域中同源、可唯一定位的链接，保存实际路由及逐页检测结果。任务至多运行 100 秒，并返回 `failures`。
- URL 导入可选 `discover:true`，跟踪两层同源导航、最多保存六页。抓取总时限为 55 秒，所有请求继续经过地址与重定向校验，公开源站页面保存为本地静态快照。渲染模式实际点击可唯一定位的同源导航链接，保存来源和目标路径；导入副本不继续执行脚本。
- 任务在 `/api/jobs/:id` 提供阶段进度和取消。成功采集的一侧按项目、版本和状态缓存，重试可复用。无法重放的一侧返回 `unmatched`、错误与步骤编号，禁止拿其他截图替代。
- `GET /api/projects/:id/panorama/captures/:captureId/:kind` 返回该项目的 `viewport` 或 `full` 截图。状态还包含精简 DOM、Chromium 无障碍树、焦点顺序、axe 问题和可用源码定位。截图丢失后会返回明确错误，重试只补采证据缺失的版本。
- `POST /api/projects/:id/panorama/proposals` 接受 `stateId`、当前 `snapshotId`、`issueId`。传 `source: "agent"` 生成待人工确认的名称建议，传 `source: "manual"` 和审核后的 `value` 生成可定位的原生按钮名称补丁。沿用现有预览、审核与应用接口。应用任何补丁时，已采集状态会在候选副本中重放。新增违规、无法可靠重放、键盘回归和其他路由中未获审核的布局或语义变化会阻止应用。
- 每个版本列出归档内实际存在的 HTML 文件。源码工程自动发现时受 12 页总量和 3 层导航深度限制。每项目最多 12 个额外交互状态，每个序列最多 6 步。不会自动枚举全站。URL 快照仅能浏览本地证据。React 路由由隔离后的客户端脚本重放，静态工程仅执行浏览器原生行为。截图遮盖普通文本输入区域，仍应只导入有权限且去除真实个人数据的工程。

`GET /api/projects/:id/reports` 和 ZIP 中的 `report.json` 含当前版本已采集的页面及状态、源路径、操作步骤、截图、DOM、可访问语义、自动检测结果与未检测的已知路径。首页问题与全站状态问题的计数分开。


### 全站检测记录

- 向同一采集接口提交 `{left,right,site:true}`，重新检测所选版本中实际存在的 HTML 文件和已记录的安全交互状态。ZIP 的路径来自快照文件，带编码、查询参数或锚点的链接不会为同一文件创建额外扫描。源码 SPA 只追踪可安全重放的同源导航链接，最多发现三层。URL 导入仍使用原有的有限同源发现，报告只统计已保存的 URL 快照。
- `GET /api/projects/:id/reports` 和导出的 JSON 含 `site`。顶层是项目及当前快照 ID，`pages` 按页面标注检测状态和确定性问题数，`states` 按页面 ID 和状态 ID 提供 DOM、无障碍树、截图以及逐状态结果。较新的结果另含 Chrome/axe-core 版本、规则标签及每条规则的实际结果、axe 待复核节点、V2 行为证据及资源加载结果。
- `site.confirmed` 为全站确定性违规数。相同问题在同一页面的多个状态间去重，跨页面独立计数。`site.attempts` 记录未完成的扫描，`pages[].issues: null` 表示没有完成的可计数结果。重扫失败后，上次的快照证据仍可查看。
- 静态快照不会执行原站 JavaScript。动态初始状态与操作重放状态分开标注。有限的自动规则、键盘探查和页面发现不能代表全站的人工审查。
