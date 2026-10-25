# 变更记录

本文件记录公开仓库的版本级变更。更细的开发过程记录在 `docs/` 下，属于历史材料，不代表当前验收结果。

## 0.2.0 — 2026-10-25（第五批维护 / 分享包 v5）

首次以版本号标记的公开更新，基线为上一版公开树的 `e3e5ccb`；本次共 85 个文件变更（50 修改、35 新增、0 删除）。

### 详情恢复与工作台

- 详情刷新失败时保留已有正文，错误面板可原地重试，不再退回空白骨架；已有内容时不再显示加载骨架。
- 活动抽屉改用主详情数据，不再为打开"调用记录"额外拉取完整 history；"版本 / 材料 / 讨论"仍按需读取。
- 切回未更新项目命中 main 缓存，不重复请求详情；切项目会取消旧请求。

### 本机存储与启动器

- `/api/health` 改为逐组件归因：workspace、connections、agents、connectionTests 各自报告 `ready`，任一主存储不可用返回 503，同时保留实例身份与诊断码。
- `connections` 检查不再连带初始化 workspace 存储，workspace 损坏时连接设置仍可用。
- 启动器遇到匹配实例但 `ready:false` 时保留服务并提示"部分本机存储不可用"，不再当作启动失败；记录 PID/owner 后可正常停止。

### CLI 文件边界

- 敏感路径拒绝名单从 45 条扩展到 65 条：新增 `.m2`、`.gradle`、`.terraform.d`、`.terraformrc`、`credentials.tfrc.json`、`*.tfstate`、`.pypirc`、`.vault-token`、`.s3cfg`、`.databrickscfg`、`.my.cnf`、`gcloud`、`application_default_credentials.json`、`service-account*.json`、`logins.json`、`key*.db`、`cert*.db`、`cookies.sqlite`、`Local State`、`Web Data`，并补上 `id_ecdsa`。
- 测试改为表驱动：先真实创建文件再断言"敏感路径"错误，避免把 ENOENT 误当拦截通过；新增 44 条拒绝用例（读与 `--out` 写两个方向）与 22 条"不误伤"对照。
- **限制未变**：这是不完整的文件名黑名单，不是操作系统沙箱。改名、换目录、未列名文件，以及把请求文件放在父目录后用子路径引用，仍可能被读取。

### 仓库与发布

- 本机证据（`docs/evidence`，155 项）与 9 份 Explorer `desktop.ini` 不再纳入 Git，磁盘文件保留；`.gitignore` 补齐 `.codex/`、`*.log`、`*.pid`、`desktop.ini`、`docs/evidence/`。
- 新增 GitHub Actions 质量工作流（`npm ci`、lint、typecheck、test、build）；不含 HTTP / Agent / 启动器 / 浏览器集成测试。
- 新增 `eslint.config.mjs`、`CHANGELOG.md`；README 更新版本与测试前提。

### 验证范围

干净 `npm ci` + 隔离副本（Windows / Node 24.21.0）：build 0，单元 115/115，HTTP 43/43，Agent 8/8，启动器 20/20，浏览器 detail 13/13（需仓库外 Playwright 模块与 `axe.min.js`，浏览器用本机 Edge），typecheck / lint / format:check 全通过。

未验证：真实付费模型调用与输出质量、macOS / Linux、远端 CI 运行结果。浏览器套件在干净安装后默认会因缺少 Playwright 而失败，属环境前提，不是回归。

## 0.1.0 — 2026-10-23

首个公开源码版本（MIT）。基础工作台：文稿审阅与人工采纳、定向审查与分项验收、模型连接配置、版本与 Markdown/DOCX 导出、本机 JSON 存储、可选 CLI 与 STDIO MCP 入口。
