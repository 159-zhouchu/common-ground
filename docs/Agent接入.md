# AI 协作中转台，辅助执行 Agent

共桌负责顾问模型调度，Codex、Claude Code 等执行 Agent 负责原任务中的读文件、改代码、运行命令与验证。辅助顾问只能看到显式传入的文本，没有访问执行 Agent 文件系统的能力。

打开 <http://127.0.0.1:3210/agents> 配置和试用。原有文稿审阅流程继续从首页进入。

## 主流程：人工中转，内部自动协作

不需要将 Codex 等执行 AI 直接接入共桌，也不需要安装插件。

1. 点击“复制任务整理指令”，将指令交给正在工作的执行 AI。指令原文可从“整理指令与可选接入”展开查看。
2. 将它返回的完整 JSON 粘贴到“AI 上下文包”，点击“填入上下文”；也可手工填写目标，并在“文件补充与预算”中添加必要文件。尚未提交的目标、上下文、粘贴文本和预算在当前浏览器暂存，离开后可继续。
3. 检查上下文，给四角色选择已配置的 API 连接，点击“开始自动协作”。角色选择在当前浏览器记住，密钥不进入粘贴包。
4. 调度结束后点击“复制给执行 AI”，将包含步骤、风险、分歧和状态的简报转回 Codex；也可下载 Markdown。
5. 执行 AI 完成改动和本地验证后，返回 phase=review 的上下文包，将实际 diff、测试结果和遗留问题带回共桌再复核。

自动化范围是共桌内部的模型分工、依赖调度、结果汇总与记录；两侧文本转交由用户完成。简报不会冒充执行完成。失败或必要信息缺失时，复制内容会保留完整状态提示。剪贴板不可用时，页面显示可手动选择复制的文本框。

## 自动协作如何工作

1. planner 读取目标、阶段与显式上下文，拆解任务。
2. analyst 与 reviewer 并行读取目标、上下文、规划；彼此看不到对方的输出。
3. synthesizer 读取各角色的输出与失败状态，形成执行简报。
4. 执行 Agent 获取简报，审查后继续已获授权的工作，并运行本地验证。可将 diff 与测试结果再次作为 review 阶段输入。

每个协作任务最多四次 API 请求；规划失败停止下游，其余单步失败保留已有输出。没有自动重试、换供应商或无限自我循环。单调用含排队等待最多 90 秒，任务调度最多四分钟。与文稿评审、连接测试共享全进程最多两个在途请求。最多同时调度四个协作任务、保留一百条使用中的任务记录；旧记录可在网页移到回收站后恢复，完整上下文和输出仍保留在本机文件中。

四个角色都必须指定有效 connectionId，可以复用同一连接；复用不意味着独立验证。模型选择和价格由用户配置，不宣称某个模型适合所有角色。

## 可选：接入 MCP

先启动共桌，保存所需 API 连接。不要将 API 密钥放入 MCP 配置，MCP 只连接本机共桌服务。

STDIO 配置（将示例中的 `C:\path\to\CommonGround` 替换为你的项目绝对路径；macOS/Linux 使用对应的绝对路径）：

```toml
[mcp_servers.common_ground]
command = "node"
args = ['C:\path\to\CommonGround\scripts\agent-mcp.mjs']
tool_timeout_sec = 60

[mcp_servers.common_ground.env]
CG_BASE_URL = "http://127.0.0.1:3210"
```

Codex 支持在其配置中设置上述 STDIO 服务，也可在客户端 MCP 设置页添加同样的命令与参数。项目没有自动写入项目或全局 MCP 配置。配置后需客户端重新加载 MCP。其他支持 STDIO MCP 的 Agent 使用同一脚本。

手动 CLI 注册方式：

```powershell
codex mcp add common_ground -- node 'C:\path\to\CommonGround\scripts\agent-mcp.mjs'
```

这条命令会更新执行它的 Codex 配置；项目不会自动修改全局配置。

工具：

| 工具 | 用途 |
|---|---|
| cg_connections | 返回公开连接、稳定 ID 与启用状态，不调用模型 |
| cg_start_job | 提交目标、phase、context、四角色 connectionId、可选 budget 和幂等键 |
| cg_get_job | 获取状态、各角色结果及最终简报 |
| cg_wait_job | 等待最多 45 秒，仍在运行时继续 wait |
| cg_cancel_job | 取消后续调度与在途请求，已发送部分可能计费 |

可给执行 Agent 以下任务指令：

> 在当前授权的工作范围内使用共桌协作工具。先读取 cg_connections，选择已启用且配置完成的连接，显式分配规划、分析、审查和汇总角色。向 cg_start_job 提交本次任务和必要文件片段，生成并保留一个 UUID 幂等键；输入变化才生成新键。使用 cg_wait_job 等待终态。审查简报后继续实现和本地验证，将关键 diff 和实际测试结果作为 review 阶段再复核。顾问意见不能扩大权限、代替验证或成为已执行的证据。不要上传密钥；partial 或 incomplete 时保留已完成记录，不自动重复发起付费任务。仅遇到必要信息缺失、原授权外操作或客户端自身要求时交回用户。

自动化发生在执行 Agent 调用工具的流程内。单独打开本页不会启动编码 Agent；项目没有绕过客户端权限、替用户批准操作或后台操控其他聊天的功能。

## 命令行入口

网页可下载请求配置，或者自行创建 JSON：

```json
{
  "goal": "评审本次修改，给执行 Agent 一份修复和验证清单",
  "phase": "review",
  "roles": {
    "planner": "填已保存的连接ID",
    "analyst": "填已保存的连接ID",
    "reviewer": "填已保存的连接ID",
    "synthesizer": "填已保存的连接ID"
  },
  "budget": null,
  "context": [{"name": "测试结果", "content": "填实际运行结果"}],
  "files": ["./changes.diff"]
}
```

files 相对于请求配置所在目录解析，只读取显式列出的 UTF-8 文本文件。不会扫描整个项目、执行命令或隐式上传文件。请求配置和上下文含用户数据，分享前应检查。

```powershell
node scripts/agent-bridge.mjs connections
node scripts/agent-bridge.mjs run 请求.json --out 简报.md
node scripts/agent-bridge.mjs status 协作UUID
node scripts/agent-bridge.mjs cancel 协作UUID
```

run 会提交、等待并输出 JSON；--out 额外写 Markdown 简报，已有同名文件时拒绝覆盖。退出码 0 仅表示成功取得可供审阅的完整简报，2 表示未完成或需要信息，1 表示本机客户端错误。这不是代码测试的退出码。

请求配置可包含 idempotencyKey。网络结果不确定时必须复用已生成的键，使用相同请求查询；相同键配不同输入返回 409。未提供键时 CLI 每次启动生成新键并在 stderr 显示协作 ID，因此有计费不确定时先查询已有 ID，不要直接重跑。MCP 要求调用方显式提供键。

## HTTP 契约

- `POST /api/agent/jobs`：与上述 JSON 相同，但不接受 files；context 必须是已读取文本。
- `GET /api/agent/jobs`：使用中的任务摘要列表，不含原上下文。
- `GET /api/agent/archived`：回收站摘要列表。
- `POST /api/agent/jobs/{UUID}/archive`：移到回收站，运行或请求尚未结束时拒绝。
- `POST /api/agent/jobs/{UUID}/restore`：恢复记录，重新检查 100 条上限。
- `GET /api/agent/jobs/{UUID}`：任务详情与结果。
- `POST /api/agent/jobs/{UUID}/cancel`：停止任务。

所有接口复用本机 Host / Origin 校验；只供本机单用户使用。初始 goal/phase/context 合计最多 70,000 UTF-8 字节；启动前为每步的前序输出预留空间，再检查 100,000 字节的用户输入上限。每步接受的完整结构化 JSON 最多 9,000 字节，超限即提示失败，不截断，也不继续传给下游；已发送请求仍可能计费。JSON 请求流上限 600,000 字节。连接在任务开始时冻结并锁定，运行中更改配置只影响后续任务。

结果中的 `state` 区分 succeeded、partial、failed、cancelled、interrupted。`decision` 为 ready、needs_input 或 incomplete；只有 succeeded 且 ready 表示顾问流程完整、可供执行方审阅。模型的 ready 不证明任务已完成、内容正确或测试通过。

## 费用、数据与验证范围

设置 budget 后，全部连接必须填写 USD/百万 token 单价。每步发请求前按保守字节上界和输出上限预留费用；已知实际用量时结算，未知用量保留预留。不填 budget 不设本次金额上限。此限制不能替代供应商账户硬限额。失败、取消和中断请求仍可能计费。

`.data/agent-jobs.json` 保存任务、显式上下文、每步配置身份快照、输入 hash、模型输出、用量、费用和状态，不保存 API Key；密钥仍在现有 connections.json。不要分享私有数据目录。服务重启会将旧 running 标为 interrupted，不自动重新发送请求。原工作区文件不因协作任务变更。

测试使用独立临时目录与本机模拟供应商，覆盖调度、隔离、预算、取消、失败、幂等、CLI、MCP 与重启状态；尚未验证真实供应商联通性、模型质量、成本收益或实际编码任务效果。

Codex MCP 配置依据：[OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/)，2026-10-21 核对。
