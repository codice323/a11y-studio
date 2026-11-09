# 校园综合服务平台 · 综合验收 V1

同一套业务页面从 `tests/fixtures/campus/src/campus.tsx` 生成。React 源码版保留六条路由、筛选与排序、加载更多、本地报名结果、个人中心标签及弹窗。静态版保留内容、相对资源、链接和浏览器原生控件。所有插图、声音、短片及字幕均由本项目生成。故意缺陷和正确对照见 [annotations.json](../tests/fixtures/campus/annotations.json)。判定依据采用 [WCAG 2.2](https://www.w3.org/TR/WCAG22/)。

| 导入入口 | 测试资源 | 真实使用范围 |
|---|---|---|
| HTML | `campus-single.html` | 一个文件，内嵌 CSS 和资源，六个内容区使用页内锚点。工作台只有一个采集页面。 |
| ZIP | `campus-multipage.zip` | 根目录入口和五个相对路径子页，外部共享 CSS 和本地 PNG。工作台可选六页，按静态快照处理。普通 ZIP 拒绝 JS 文件，子页独立源码修复和跨文件补丁不在此入口覆盖范围内。 |
| 源码工程 | `campus-react-source.zip` | React、Vite、TypeScript。A11y Studio 用受控 esbuild 编译和 AST 定位，导出项目可由 Vite 重建。仅允许 React、React DOM 作为应用依赖，不运行上传者的构建命令或插件。 |
| URL | `url-site/` | 普通 HTTP 源站提供六页、CSS、图片、JS 和 JSON。静态模式保留离线公告，渲染模式保留 JS 执行后的实时公告。工作台保存单页快照，不会递归采集子页或恢复运行时交互。 |

普通 ZIP 可上传 HTML/HTM、CSS、PNG、JPEG、GIF 和 WebP。源码工程在此基础上接受受限 JS/TS/JSX/TSX、JSON、Markdown 和文本，支持静态工程与上述受限 React 工程。上传压缩文件最大 8 MB，解压最多 100 个文件、总计 20 MB。单 HTML/HTM 上传使用工作台内建的 `index.html` 快照名称。

音视频为嵌入式短资源，不需要向 ZIP 加入视频或字幕文件扩展名。工作台的隔离策略限制媒体加载，URL 快照明确移除音视频标签。播放器、字幕质量、屏幕阅读器播报及业务语义由人工复核，自动化结果不代表媒体合规。

## 运行

仓库需要 Node、依赖安装和本机 Chromium/Chrome。Mac 默认 Google Chrome。其他位置用 `CHROME_PATH` 指定。

```sh
npm run build
node --import tsx scripts/campus-fixtures.ts data/campus-fixtures
CAMPUS_STAGE=1 npm run test:campus
CAMPUS_STAGE=2 npm run test:campus
CAMPUS_STAGE=3 npm run test:campus
CAMPUS_STAGE=4 npm run test:campus
CAMPUS_STAGE=5 npm run test:campus
npm run typecheck
npm test
```

`CAMPUS_STAGE` 是从导入起执行到哪一轮，默认 5。重复执行时使用不同的 `CAMPUS_EVIDENCE_DIR` 保存每轮证据。每次启动新的本地服务和临时数据库，从首页实际操作。日志包含项目和版本 ID、浏览器 API 状态、复测结果和失败原因。完整轮次还会保存导出 ZIP。

URL 自动验收复用测试进程的固定源站映射。导入器仍运行真实地址检查、重定向校验、资源抓取及 Chromium 渲染。映射仅对测试用固定地址和临时 HTTP 服务生效。私网重定向被拒绝。可以用 `node --import tsx scripts/campus-fixtures.ts data/campus-fixtures --serve` 在 4191 本地预览源站。要在日常工作台手动使用 URL 入口，请把 `url-site/` 放到获授权的公开测试服务上。生产导入拒绝 localhost。

音视频及 PNG 已随源码提供。仅在需要重新制作时运行 `node scripts/campus-media.mjs`，随后重新生成导入资源。

## 人工复核角色

| 角色 | 复核操作 | 完成条件 |
|---|---|---|
| 网站管理员 | 从首页选择入口，读拒绝原因，重试。查看图片建议，审核预览，下载项目和报告。 | 能独立解释要改什么、改了哪个版本和文件。确认不会误改原网站。 |
| 前端开发者 | 源码工程查 TSX 和 CSS 差异，构建导出项目，核对路由、筛选、表单和副作用。 | 修复实际写入预期源文件。代码能构建，行为与业务预期一致。 |
| 无障碍体验审核人员 | 键盘检查校历焦点、Tab 顺序、编辑资料弹窗关闭后的焦点。用屏幕阅读器体验报名错误。播放短片并核对字幕。 | 记录具体现象、状态和辅助技术版本，分别填写通过、失败、需澄清。 |

自动脚本以这三类角色组织操作。真人可理解性、屏幕阅读器实际播报、字幕准确性及 WCAG 间距例外仍需独立签核。视觉 Mock 检查请求含真实图片字节和校园上下文，PNG 请求与本地图片逐字节比对。Agent Mock 使用真实工具链读问题、WCAG、源码和浏览器，再验证候选补丁。模型判断质量需要单独的限额真实模型测试。本轮配置为 0 次外部调用，外部成本为 0。

此站用于产品回归。跨网站泛化需要独立站点和原有留出集，本轮不改动历史标注或实验数据。

## 本轮验收结果

环境为 Mac Chrome、临时 A11y Studio 后端和独立测试数据库。验收前仓库为 `feat/panorama-workbench-v1`，HEAD 为 `fef91f6`，工作区干净。常驻 4173 和 5173 进程的工作目录均指向本仓库副本。本轮另起测试端口，未重启常驻服务。

| 用户步骤 | 观测结果 |
|---|---|
| 1. 导入 | HTML 拒绝错投的 ZIP，普通 ZIP 拒绝 JS 文件，源码工程拒绝额外运行依赖，URL 两个模式均拒绝私网重定向。五个场景都可在同一入口恢复、看到进度并导入成功。 |
| 2. 首次检测 | 五个入口场景各检出 4 项标注的 axe 违规，共 20 个匹配。三项辅助证据分别为悬空 ARIA 引用、不可见焦点和正 tabindex。目标尺寸、弹窗焦点与媒体留在人工复核范围。 |
| 3. 全景浏览 | ZIP 列出六页，可切到课程报名页。React 重放到「个人中心 → 我的设置 → 编辑资料」，浏览器语义含弹窗。HTML 与两类 URL 各有一个可查看的快照。 |
| 4. AI 与人工编辑 | 五次视觉 Mock 均收到图像数据和页面上下文。四个快照场景的第二项修复都使用了可编辑的标签建议。React 对比度修复使用两轮 Agent Mock 调用，并执行实际的工具读取、构建和复测。 |
| 5. 补丁预览 | 文件差异显示实际写入的内容。快照修改 `index.html`，源码工程修改 `src/campus.tsx` 和 `src/campus.css`。 |
| 6. 应用与复测 | 共 10 次成功修复，五个 V2 均未新增扫描违规。故意降低对比度的 HTML 补丁被拒绝，项目保留先前 V2。 |
| 7. 版本 | 五个场景均建立 V0、V1、V2，验证重命名、恢复、回退及只读对照。 |
| 8. 导出 | 五个下载均可解压并核对报告。浏览器打开导出页面验证图片和标签。ZIP 子页媒体可加载，React 导出后用本地依赖重建，实测课程搜索及报名错误、成功两种结果。 |

另用 1440px 和 390px 视口检查了测试源站的六页，未出现横向溢出，现有图片均加载成功。此检查覆盖页面布局和资源加载。真人操作理解、屏幕阅读器实际播报及字幕内容仍待人工签核。

本轮修正了导入页拖放或文件选取可绕过当前 HTML/ZIP 入口文件类型提示的问题。当前保留的主要产品缺口是普通 ZIP 的跨页、跨文件修复能力，URL 的多页与交互采集，以及隔离预览中的媒体复核能力。

最终核对通过了 `npm run test:campus`、`npm run typecheck` 和 `npm run build`。既有 `npm test` 回归共 28 项，全部通过。
