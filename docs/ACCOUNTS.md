# 账号、会话与项目归属

## 本机启动

A11y Studio 使用 Better Auth 1.7.18 的 SQLite 适配器和邮箱密码认证。运行 `openssl rand -base64 32` 生成密钥，写入本机 `.env` 的 `BETTER_AUTH_SECRET`。将 `BETTER_AUTH_URL` 设为浏览器访问的完整 Origin。通过 Vite 开发时使用 `http://localhost:5173`，从 Express 直接访问时使用 `http://localhost:4173`。用同一个主机名打开页面，Cookie 按主机保存。

也可以保留现有 AI 配置文件，将认证配置写入权限为 0600 的独立文件，并以 `node --env-file=/absolute/path/to/.env --env-file=/absolute/path/to/.env.accounts --import tsx apps/api/server.ts` 启动后端。开发时如需使用已有数据，启动前显式设置 `A11Y_DATA_DIR`。

Express 同源提供 API 和构建产物。Vite 通过现有 `/api` 代理转发到 Express。生产模式要求明确设置 HTTPS Origin，启用 Secure Cookie。开发和生产都使用 HttpOnly、SameSite=Lax 的 Cookie。会话在数据库校验，退出会撤销当前会话，并关闭该会话的实时浏览器。浏览器只读取公开账号资料，登录响应不提供可由脚本读取的 Session Token。注册后需要单独登录。新注册密码须为 8–20 个字符，前后端共用长度规则，V1 的旧密码仍可登录。Better Auth 负责密码哈希和验证。邮箱去除首尾空格并转换小写，SQLite 唯一索引防止并发重复注册。迁移遇到历史重复邮箱时会停止，原记录保留。

参考 [Express 集成](https://better-auth.com/docs/integrations/express)、[SQLite 迁移](https://better-auth.com/docs/concepts/database)、[会话及 Cookie](https://better-auth.com/docs/concepts/cookies)、[限流](https://better-auth.com/docs/concepts/rate-limit)和[安全设置](https://better-auth.com/docs/reference/security)。

## API 权限

- 匿名可访问 `GET /api/health`、登录页面和前端静态资源。账号 API 仅开放 `GET /api/auth/get-session`、`POST /api/auth/sign-up/email`、`POST /api/auth/sign-in/email` 、`POST /api/auth/sign-in/anonymous` 和 `POST /api/auth/sign-out`。
- 其他 API 需要有效会话。项目列表和导入使用服务端会话 ID。已有示例导入时复制为账号私有项目。
- `/api/projects/:id/**` 在访问比较、AI、补丁、版本、报告、导出、实时及全景前检查项目所有权。嵌套审计、快照、补丁、截图和实时会话继续校验各自的项目关系。独立任务、截图和补丁地址通过资源表关联项目进行相同的所有权校验。
- 私有资源与账号响应禁止缓存。其他账号访问私有项目或资源返回 404。未登录访问返回 401。修改请求需要可信 Origin，跨源浏览器请求会被拒绝。项目文件保存在私有数据目录，Express 静态目录仅包含前端构建文件。
- 邮箱登录按连接 IP 限制为每 60 秒 5 次，注册每 60 秒 8 次，计数存入 SQLite。服务端覆盖限流用的 IP 请求头。使用反向代理时，同一代理的连接会共享后端额度，应在可信边缘配置按客户端限流。

## 游客模式

Better Auth 为每次游客登录建立独立账号与会话。游客项目继续按项目所有者校验，游客退出后撤销会话，游客项目不转移至正式账号。游客会话固定 24 小时过期，后台每 15 分钟清理一次，对正在运行的任务留出至少一小时。清理范围包括游客账号、项目文件、快照、扫描、补丁与截图。

同一连接 IP 每小时最多创建 4 个游客会话。每个游客最多创建 3 个项目、发起 5 次 AI 分析请求、执行 40 次工作区写操作、进行 20 次高开销预览或导出。额度写入 SQLite，刷新页面不重置。AI 分析额度以用户发起的请求计，一次分析内部可包含多个模型调用。

## 数据迁移与旧项目认领

启动时先运行 Better Auth 官方的可重复迁移，再运行 `apps/api/migrations/001-account-ownership.ts`。现有项目的 `owner_user_id` 保持为空。原有快照、扫描、修复记录、文件与报告保留。旧任务缺少可信的归属记录，保留数据库记录，但无法通过个人 API 查询；已持久化的扫描、验证和报告仍随项目认领恢复访问。

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

上线前配置公开 HTTPS Origin、反向代理、秘密管理与备份恢复演练。既有数据目录应由应用运行账号独占，并设置为 0700。V1 未接邮箱验证、密码重置邮件、团队角色、社交登录或正式账号的 AI 用量配额。邮箱可作为本应用的登录标识，管理员认领旧项目时仍需独立核验使用者身份。对外开放注册前需要配置邮件与服务端用量政策。
