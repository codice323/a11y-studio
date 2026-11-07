# API

所有接口均为本机 HTTP，响应 JSON；失败为 `{ "error": "原因" }`。扫描与验证返回 `{id,status:"queued"}`，使用 `GET /api/jobs/:id` 查询状态，`POST /api/jobs/:id/cancel` 可取消正在运行的任务。

| 方法与地址 | 作用 |
| --- | --- |
| GET /api/status | 模型是否已配置 |
| GET /api/fixtures | 三个内置示例 |
| GET /api/projects | 项目列表 |
| POST /api/projects | multipart 文件 `file` 或字段 `fixture`，创建 V0 |
| GET /api/projects/:id | 项目、版本、当前与初始扫描及报告摘要 |
| POST /api/projects/:id/audits | 扫描当前版本 |
| GET /api/audits/:id/screenshot | 扫描截图 |
| GET /api/knowledge/:rule | 本地 WCAG 映射 |
| POST /api/projects/:id/issues/:issueId/proposals | `{source:"manual",value:"..."}` 或 `{source:"ai"}` |
| POST /api/proposals/:id/apply | 审核后应用并异步验证 |
| POST /api/proposals/:id/reject | 拒绝建议 |
| POST /api/projects/:id/rollback | `{snapshotId:"..."}` 恢复有效版本 |
| GET /api/projects/:id/reports | 报告数据 |
| GET /api/projects/:id/export | 源码、截图与报告 ZIP |

补丁只允许 `set-alt`、`set-label`、`set-name`、`set-color`；后端重新检查规则、目标、版本与文件哈希。模型只提供值和解释，用户审核确认。接口不提供任意 URL 访问。
