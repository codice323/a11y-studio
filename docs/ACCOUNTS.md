# 账号、会话与项目归属

## 本机启动

A11y Studio 使用 Better Auth 1.7.18 的 SQLite 适配器和邮箱密码认证。运行 `openssl rand -base64 32` 生成密钥，写入本机 `.env` 的 `BETTER_AUTH_SECRET`。将 `BETTER_AUTH_URL` 设为浏览器访问的完整 Origin。通过 Vite 开发时使用 `http://localhost:5173`，从 Express 直接访问时使用 `http://localhost:4173`。用同一个主机名打开页面，Cookie 按主机保存。

也可以保留现有 AI 配置文件，将认证配置写入权限为 0600 的独立文件，并以 `node --env-file=/absolute/path/to/.env --env-file=/absolute/path/to/.env.accounts --import tsx apps/api/server.ts` 启动后端。开发时如需使用已有数据，启动前显式设置 `A11Y_DATA_DIR`。

Express 同源提供 API 和构建产物。Vite 通过现有 `/api` 代理转发到 Express。生产模式要求明确设置 HTTPS Origin，启用 Secure Cookie。开发和生产都使用 HttpOnly、SameSite=Lax 的 Cookie。会话在数据库校验，退出会撤销当前会话，并关闭该会话的实时浏览器。浏览器只读取公开账号资料，登录响应不提供可由脚本读取的 Session Token。开启邮件后，新注册账号必须验证邮箱才能使用私有工作区。旧账号可以继续登录并在个人菜单验证邮箱。新注册密码须为 8–20 个字符，前后端共用长度规则，V1 的旧密码仍可登录。Better Auth 负责密码哈希和验证。邮箱去除首尾空格并转换小写，SQLite 唯一索引防止并发重复注册。迁移遇到历史重复邮箱时会停止，原记录保留。

参考 [Express 集成](https://better-auth.com/docs/integrations/express)、[SQLite 迁移](https://better-auth.com/docs/concepts/database)、[会话及 Cookie](https://better-auth.com/docs/concepts/cookies)、[限流](https://better-auth.com/docs/concepts/rate-limit)和[安全设置](https://better-auth.com/docs/reference/security)。

## API 权限

- 匿名可访问 `GET /api/health`、登录页面和前端静态资源。认证 API 提供会话查询、注册、登录、退出、邮件操作和游客升级。游客升级申请与确认均校验当前游客会话。
- 其他 API 需要有效会话。项目列表和导入使用服务端会话 ID。已有示例导入时复制为账号私有项目。
- `/api/projects/:id/**` 在访问比较、AI、补丁、版本、报告、导出、实时及全景前检查项目所有权。嵌套审计、快照、补丁、截图和实时会话继续校验各自的项目关系。独立任务、截图和补丁地址通过资源表关联项目进行相同的所有权校验。
- 私有资源与账号响应禁止缓存。其他账号访问私有项目或资源返回 404。未登录访问返回 401。修改请求需要可信 Origin，跨源浏览器请求会被拒绝。项目文件保存在私有数据目录，Express 静态目录仅包含前端构建文件。
- 邮箱登录按连接 IP 限制为每 60 秒 5 次，注册每 60 秒 8 次，计数存入 SQLite。服务端覆盖限流用的 IP 请求头。使用反向代理时，同一代理的连接会共享后端额度，应在可信边缘配置按客户端限流。

## 邮箱验证和密码找回

使用 Resend 发送账号邮件。设置 `A11Y_RESEND_API_KEY` 和 `A11Y_MAIL_FROM`，发件域名须已在 Resend 验证。非生产可把 `A11Y_MAIL_TEST_DIR` 指向私有目录，邮件会写入权限为 0600 的测试文件，目录必须位于 Web 静态目录之外。测试文件包含一次性链接，验收完后应删除。生产模式忽略测试目录；未配置有效发信服务时拒绝新增正式账号和游客升级请求，不静默跳过验证。已有账号和游客体验可继续使用。

非生产可把 `A11Y_MAIL_TEST_DIR` 指向私有目录，邮件会写入权限为 0600 的测试文件，目录必须位于 Web 静态目录之外。测试文件包含一次性链接，验收完后应删除。生产模式忽略测试目录；未配置有效发信服务时拒绝新增正式账号和游客升级请求，不静默跳过验证。已有账号和游客体验可继续使用。

注册和重发验证邮件只包含一次性验证链接。链接有效期 30 分钟，点击后完成邮箱验证；重发时旧链接失效。

注册、重发和密码找回使用通用回复，SQLite 保留邮箱唯一约束。已验证邮箱可发起找回密码。验证链接有效期 30 分钟，重置与游客升级链接有效期 15 分钟。数据库保存 256 位随机令牌的 SHA-256 摘要，邮件链接把令牌放在 URL 片段，页面读取后清除。邮箱验证不创建会话。密码重置与旧会话撤销在同一事务完成，用户随后用新密码登录。

每个账号同类邮件至少间隔一分钟。重发验证、申请重置分别按连接 IP 每分钟限 4 次，验证和重置提交限 8 次。各接口对非法、过期和已使用链接返回相同提示。失败投递只记录操作类型，不记录邮箱、令牌或完整链接。

重发、验证、找回和重置分别使用 `POST /api/auth/resend-verification`、`confirm-email`、`forgot-password`、`complete-password-reset`。游客升级申请与确认分别使用 `POST /api/auth/upgrade-guest`、`complete-guest-upgrade`。

## 游客模式

Better Auth 为每次游客登录建立独立账号与会话。游客项目继续按项目所有者校验，游客退出后撤销会话。游客可以通过「保存我的项目 / 注册账号」创建正式登录凭据。配置邮件时，升级链接必须在原游客会话中确认。申请阶段对可用和已注册邮箱返回同样的结果。确认成功后事务保留原项目，撤销旧游客会话。未配置有效邮件服务时，游客仍可使用当前游客工作区，但不能通过升级申请创建正式账号。保留原有主体 ID，项目、快照、任务和补丁继续引用原记录。凭据写入、游客标记移除、会话切换和游客配额清除在同一个 SQLite 事务内完成。游客会话固定 24 小时过期，后台每 15 分钟清理一次，对正在运行的任务留出至少一小时。清理范围包括游客账号、项目文件、快照、扫描、补丁与截图。

同一连接 IP 每小时最多创建 4 个游客会话。每个游客最多创建 3 个项目、发起 5 次 AI 分析请求、执行 40 次工作区写操作、进行 20 次高开销预览或导出。额度写入 SQLite，刷新页面不重置。每位游客同时最多有一个前台任务、一个页面采集任务和两个直接预览或分析请求。实时浏览器另有单账号一个、服务进程两个的限制。AI 分析额度以用户发起的请求计，一次分析内部可包含多个模型调用。

## 项目管理与清理

`PATCH /api/projects/:id` 用于修改项目名，`DELETE /api/projects/:id` 要求提交 `{"confirm":true}`。两者都根据当前会话校验项目归属。项目运行任务或实时对比时，删除返回 409。删除与游客到期清理共用数据库事务，事务内删除关联记录并把待删除文件写入 `project_file_cleanup`。提交后清理源文件和截图，失败项在启动或定时清理时重试。

账号安全日志记录注册、登录、游客创建、升级、退出和项目删除的操作与状态。日志事件不包含密码、会话令牌或 API Key。游客升级申请按连接 IP 每小时最多 5 次，确认按分钟限 8 次。

## 数据迁移与旧项目认领

启动时先运行 Better Auth 官方的可重复迁移，再运行 `apps/api/migrations/001-account-ownership.ts`。未认领的旧项目保持空归属，已拥有归属的项目保留原所有者。V1.2 新增 `project_file_cleanup` 表。V1.3 通过 Better Auth 增加 `user.emailVerificationRequired` 和 `session.credentialCheckedAt`，并增加 `account_mail_tokens`、`guest_upgrade_tokens`。已有账号和项目记录无需回填。迁移前备份数据库、项目资源和本机配置，回滚时优先在独立数据目录还原同一批备份。原有快照、扫描、修复记录、文件与报告保留。旧任务缺少可信的归属记录，保留数据库记录，但无法通过个人 API 查询；已持久化的扫描、验证和报告仍随项目认领恢复访问。

先创建需要接收项目的账号，再由掌握 Mac 文件权限的管理员执行命令。显式使用目标数据目录，并提供启动服务所用的同一环境配置。

```bash
A11Y_DATA_DIR=/absolute/path/to/data node --import tsx scripts/claim-legacy-project.ts --list
A11Y_DATA_DIR=/absolute/path/to/data node --import tsx scripts/claim-legacy-project.ts --apply PROJECT_ID USER_ID
```

使用 `--env-file=/absolute/path/to/.env` 可明确加载该环境。命令按项目 ID、用户 ID 认领，写入审计记录，并拒绝重复转移已有归属的项目。认领能力只存在于本机命令行。

## 备份与恢复

在没有活动扫描、修复或上传时，使用 SQLite `.backup` 生成一致数据库副本，归档 `projects/`、`screenshots/` 和 `panorama/`。保护备份目录为 0700、备份文件为 0600，记录 SHA-256。校验数据库时可用 URI `file:/absolute/path/studio.sqlite?immutable=1` 执行 `PRAGMA integrity_check`。

恢复时先验证哈希，将数据库和归档解压到一个新的私有目录，然后将服务的 `A11Y_DATA_DIR` 指到该目录进行验证。若回到认证前的版本，使用迁移前备份和对应的代码版本，避免把认证后的数据放到旧服务中。

## 部署条件

上线前配置公开 HTTPS Origin、反向代理、秘密管理与备份恢复演练。既有数据目录应由应用运行账号独占，并设置为 0700。公开部署仍需要有效的邮件服务、真实邮件收发验证、可信边缘限流以及公网 HTTPS 验证。团队角色、社交登录和正式账号 AI 用量配额尚未提供。邮箱可作为本应用的登录标识，管理员认领旧项目时仍需独立核验使用者身份。对外开放注册前需要配置邮件与服务端用量政策。

密码长度本轮维持 8–20 个字符。若后续确认调整，可参考 [NIST SP 800-63B-4 §3.1.1](https://pages.nist.gov/800-63-4/sp800-63b.html#passwords)，单因素密码最少 15 个字符，允许的最大长度至少 64 个字符。


## 并发回归

`npm test` 将测试文件并发限制为 3。每个浏览器工作流使用自己的临时 SQLite 数据库、动态端口和浏览器上下文。单独运行 `npm run test:campus` 可避免与全量回归争抢 Chrome。专项测试在同一后端用两个正式账号和两个游客并发导入、扫描、修复、读取报告及导出，并验证相互隔离。初始复跑未稳定复现 V1.2 的全景超时。上轮出现超时的运行同时执行了多套 Chrome 回归，暂无数据库、端口或临时目录冲突证据。
