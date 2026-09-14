# SSH MCP Server — 自维护 fork

上游：https://github.com/classfang/ssh-mcp-server 。保留上游代码与贡献惯例，本地需求讨论使用中文。

维护仓库：https://github.com/ONEGAYI/ssh-mcp-server 。`origin` 指向本 fork，`upstream` 保留上游；默认向 `origin` 推送。

## 当前工作范围

- 为只能通过 SSH 使用的 CentOS 7 服务器提供接近远程原生 Agent 的操作体验。
- 全部演进已合入 main 并发布 v2.0.0（2026-09-13）：首版工作区（PR #1，用户人工验收通过）、三项扩展（PR #2）、大文件扩展总规格 16 张票据（PR #22，三轮代码审查 44 项修复收口）、轻量打包脚本（PR #27）。
- 保留边界：用户已人工验收通过（2026-09-14，覆盖 v2.0.0 全部功能）；审查记档项在 issues #23–#26 跟踪；远端 Windows 适配在 #4 跟踪；无 root 与旧 glibc 约束不变。
- 需求、术语和调查记录统一放在 `docs/design/`；已确认且难以逆转的架构决策放在 `docs/adr/`，按需创建。
- 未确认的建议必须标明待定；客户端支持、远端环境未经实测不得写成既成事实。
- **分发纪律**：对外分发一律使用 `scripts/package-offline.mjs` 生成的离线目录包（含 Node 运行时与全部依赖）；不提供轻量分发包（package-dist 已于 2026-09-14 移除）。
- 功能实施遵守测试先行。用户已授权创建个人 fork 并推送，变更通过 fork 内的 PR 审阅；未授权直接合并或向上游提交 PR。
- `AGENTS.md` 为通用规则入口；`CLAUDE.md` 仅导入并附加专属规则。

## 导航

- `docs/design/spec.md`：首版目标、用户故事、结构提案与范围。
- `docs/design/contracts.md`：文件读取/写入、任务状态、日志和完成恢复契约。
- `docs/design/implementation-plan.md`：分阶段实施、关键验证门槛及测试验收安排。
- `docs/design/progress.md`：当前实现进度、真实环境证据与未完成工作。
- `docs/design/usage.md`：工作区配置、Agent 使用、恢复边界与离线交付。
- `docs/design/CONTEXT.md`：用户已提供的背景、需求目标和领域术语。
- `docs/design/large-file-spec.md`：大文件读写、远端搜索、续传、状态清理与二次配置的扩展规格（票据 #6–#20 已实施，终验收尾见 #21）。
- `docs/design/large-file-tickets.md`：扩展实施票据、GitHub 链接、依赖和验收条件。
- `docs/design/discovery.md`：上游代码核实、候选方案与尚待回答的需求问题。
- `docs/design/interactive-assessment.md`：交互式功能复杂度、延期影响及首版扩展边界评估。
- `docs/adr/`：已确认的远端兼容约束、ZCode 后台 Shell 回传、文件写保护范围，以及非交互任务断线恢复要求。
- `README.md`：本 fork 的中文入门、setup、日常使用与升级说明；每次离线打包放入包根目录。
- `README_EN.md`：保留的上游英文旧模式说明。
- `src/`：MCP 服务、工具、SSH 连接与配置实现。
- `src/core/setup-server.ts`：通用 setup MCP，缺项询问与项目接入入口。
- `src/services/workspace-setup.ts`：MCP 与手工 CLI 共用的项目配置合并逻辑。
- `examples/`：标准 MCP 导入及 ZCode 原生配置的 setup 服务模板。
- `remote/`：Python 3.6 标准库执行器、持久任务、受保护文件操作与有界搜索。
- `test/` / `scripts/`：上游测试和构建脚本。
- `scripts/probes/`：ZCode 后台/恢复与 Linux 存活探针；可接正式工作区验证真实任务恢复，不是产品执行器。
- `scripts/setup-workspace.mjs`：合并生成项目级 ZCode MCP/恢复钩子接入配置。
- `scripts/package-offline.mjs`：生成含本机 Node、依赖和 SHA-256 清单的离线目录包。
- `skills/ssh-mcp-helper/`：上游提供的配置辅助技能。
- `images/`：上游说明文档图片。
