# 更新日志

本仓库 [ONEGAYI/ssh-mcp-server](https://github.com/ONEGAYI/ssh-mcp-server) 是 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 的自维护 fork。上游 v1.9.2 及之前的变更见上游仓库。

## [未发布]

绑定生命周期收口：remote_setup 新增移除绑定动作（remove），手工 CLI 提供对等入口，绑定从此具备完整的接入—调整—退役闭环。

### 新功能

- **remote_setup 移除绑定（remove）**（#28 决策，票据 #32）：`action: "remove"` 按 revision 防并发（与 update 一致）、标注 `destructiveHint`；绑定存在任何未确认任务或传输时硬拒绝（SETUP_PENDING_OPERATIONS，按绑定全量统计、不限当前对话，无 force 参数）；通过后按"先摘钩子与 MCP 条目、再删 profile"的顺序摘除 `.zcode/config.json` 中本绑定的接入（空节点原样保留，外部 MCP/钩子不动），删除 profile、setup 生成的连接文件与本机 identity 状态目录；外部引用的 sshConfigFile 永不删除。仅当移除最后一个绑定时，复用 #31 的匹配逻辑回收仍与已知生成文本一致的存量文档并报告。全程零 SSH 连接，远端状态目录仅报告路径与手工清理指引。
- **手工 CLI 移除入口**（票据 #33）：`node scripts/setup-workspace.mjs --workspace <profile> --remove [--revision <token>]` 与 MCP 共用同一实现；不带 revision 先返回包含当前 revision 与待确认工作清单的预览，带 revision 执行；拒绝路径与 MCP 一致，错误以 JSON 输出到 stderr 并以非零码退出。

### 其他改进

- **绑定级待确认判定**：任务与传输服务新增 `pendingAcross()`（全对话、离线读本地登记），供移除校验复用；恢复钩子的会话级 `pending` 语义不变。
- **路径身份匹配**：摘除 MCP 条目与恢复钩子时按"执行器 + `--workspace` 指向同一 profile 文件"匹配（文本精确匹配或 realpath 同一文件），大小写拼写差异或链接引用也能正确摘除，且不会误删外部条目。
- **文档收尾**（票据 #33）：README、usage 补移除流程；CONTEXT.md 大文件访谈节时点口径更正（#6–#21 已随 v2.0.0 实施）；test/README.md 测试结构树补齐至当前全量文件。

## [2.1.0] - 2026-09-14

按需指引起航版：工作区使用指引从落盘 markdown 迁移到 `remote_help` 工具，configure 不再向项目写任何文档文件，存量生成文档自动回收。

### 新功能

- **remote_help 按需指引**（PR [#34](https://github.com/ONEGAYI/ssh-mcp-server/pull/34)）：每个绑定的工作区 MCP 新增 `remote_help` 工具——零参数、纯本地静态文本、不连 SSH，返回完整使用指引（工作流顺序、后台任务、恢复与确认规则、SSH 不可达处置）；server instructions 附引导句。SSH 断连时指引依然可得。
- **configure 停止落盘文档**（PR [#35](https://github.com/ONEGAYI/ssh-mcp-server/pull/35)）：不再生成 `AGENTS.md` / `SSH-WORKSPACE-GUIDE.md` / `CLAUDE.md`，`remote_help` 成为唯一指引来源；项目 git 工作区不再被 setup 写入的文件污染。

### 其他改进

- **存量文档一次性迁移清理**（PR [#35](https://github.com/ONEGAYI/ssh-mcp-server/pull/35)）：重入 configure 时自动回收内容仍与已知生成文本（v1/v2/v3 三代）逐字一致的旧文档并在返回的 `legacyDocs` 中报告路径；用户修改过的文件保留不动、仅报告；`CLAUDE.md` 的一行导入仅随被回收的 `AGENTS.md` 联动删除；回收失败（如文件被编辑器锁定）不阻塞 configure，路径与原因进报告。清理逻辑独立导出，后续绑定移除动作复用。
- **gitignore 建议**（PR [#35](https://github.com/ONEGAYI/ssh-mcp-server/pull/35)）：configure 返回提示将 `.ssh-mcp-*.json` 加入项目 `.gitignore`（含主机与认证参数，不宜入库）；setup 不代改 `.gitignore`。
- 两项 PR 均经多轮独立代码审查修复收口（PR #34 三轮、PR #35 两轮 + 双轴审查），全部修复由未参与修复的审查者复核关闭。

## [2.0.1] - 2026-09-14

分发与验收口径修正版：确立「一律离线包」的分发纪律，并确认用户人工验收通过。

### 其他改进

- 确立分发纪律：对外分发一律使用离线目录包（`scripts/package-offline.mjs`，含 Node 运行时与全部依赖），移除轻量分发脚本 `package-dist`（PR #27 引入后按用户决策撤回）；v2.0.0 附带的轻量 tar.gz 资产已从 Release 移除。
- 用户人工验收通过（2026-09-14，覆盖 v2.0.0 全部功能）；相关文档口径同步更新。

## [2.0.0] - 2026-09-13

首个 fork 版本，覆盖上游 v1.9.2 之后合入 main 的全部演进（PR [#1](https://github.com/ONEGAYI/ssh-mcp-server/pull/1)、[#2](https://github.com/ONEGAYI/ssh-mcp-server/pull/2)、[#22](https://github.com/ONEGAYI/ssh-mcp-server/pull/22)、[#27](https://github.com/ONEGAYI/ssh-mcp-server/pull/27)）：从单一同步式 MCP 工具服务器演化为面向 CentOS 7 / Python 3.6 标准库 / 无 root / 离线内网的「远程原生 Agent 工作区」——远端只需 SSH 与 Python 3.6，本机 Agent 即可获得持久任务、断线恢复、流式大文件操作与有界状态管理的完整能力。

### 新功能

- **远程工作区与持久任务**（PR #1）：命令经 ZCode 原生后台 Shell 启动为持久任务，SSH 断线或客户端退出后远端继续，恢复钩子接回同一任务；读后写凭据与版本冲突检查保护文件编辑；`--setup` MCP 模式引导缺项询问并自动生成项目接入配置；提供含 Node 运行时与 SHA-256 清单的离线目录包。
- **预存 SSH 连接、多命名绑定与可选目录边界**（PR #2）：连接凭据库按名引用（缺项响应列出可用连接名、凭据不回传）；`bindingName` 命名绑定各自独立 profile、workspaceId、MCP 服务与恢复钩子；`directoryScope` 可选解除目录边界（restricted 缺省，unrestricted 不放松读后写保护）。
- **流式大文件读取与精确替换**（PR #22）：取消单文件 16 MiB 门槛，改为流式窗口读取与执行预算约束；元数据版本凭据（m1-/readToken）替代全文快照；跨块精确替换与显式版本绑定的整体覆盖。
- **可校验续传的流式传输事务**（PR #22）：上传/下载以 transferId 事务化（32 块清单、断点续传仅发未确认部分、提交对账自愈）；后台传输完成回传、恢复钩子离线列举待跟进、主动取消释放未提交数据；committing 窗口双证据裁决，结果未知不盲重做。
- **远端多后端搜索与可续扫分页**（PR #22）：rg → grep → python-walk 三后端按能力回退，文件名查找与内容搜索同规则；字节/时间双预算与游标续扫，不跳过大文件。
- **登记后执行协议**（PR #22）：任务与传输先登记后执行，旧标识重放一律 `REQUEST_EXPIRED_OR_UNKNOWN` 拒绝，不产生副作用。
- **空间额度与生命周期回收**（PR #22）：本机与远端每工作区各 10 GiB 可配额（状态、临时、预留同口径计量，预留与已写不双重计数）；3/30 天期限矩阵覆盖任务日志、结果记录、unknown 形态、中断传输、读取凭据、旧 helper 镜像与崩溃遗留（归属+占用+对象身份三重核实，无归属文件不删）；查询动作懒清理 + 每小时在线维护 + 离线重连补做；任务日志额度耗尽截断留因不杀子进程。
- **按需空间汇总与二次配置**（PR #22）：`remote_workspace` 的 `includeStorage` 返回两端用量/预留/限额与最近清理摘要（≤4 KiB，断线明确 unknown 不写零）；已有绑定增量配置与策略保存后下一操作自动生效，无需重启。
- **轻量分发打包**（PR #27）：`node scripts/package-dist.mjs` 一条命令产出含 README 与构建产物的 `tar.gz` 分发包，接收方 `npm install --omit=dev` 即可运行。

### 破坏性变更

- **移除 remote_move / remote_delete / remote_mkdir / remote_rmdir 四个文件管理工具**（PR #22，[ADR 0007](docs/adr/0007-file-management-through-shell.md)）：文件移动、删除与建目录改用远端 Shell 任务；Shell 路径不再拥有 readToken 保护，也不代表任何未来删除请求自动获授权。
- **文件大小约束模型变更**（PR #22）：16 MiB 门槛取消，改为流式处理 + 执行预算 + 空间额度的约束体系；旧行为中的全文快照与传输路径移除。
- **协议升级为 v2 登记后执行**（PR #22）：legacy「缺记录即启动」入口拒绝（`PROTOCOL_UPGRADE_REQUIRED`）；升级排空期间活动旧客户端阻止协议切换（`LOCK_SWITCH_BLOCKED`）。

### Bug 修复

- PR #22 范围内经三轮独立代码审查共修复 44 项确认缺陷（前半票据 23 项、后半票据 21 项），涵盖传输对账与取消窗口证据、维护轮类型防护闭合、上传记录生命周期收敛、空间汇总时间单位、本机锁自愈与失败退避等；全部修复经未参与修复的审查者独立复核关闭。
- PR #2 双轴（规范/需求）code-review 修复：恢复上下文补连接名、绑定名正则共享、helper 缺 directoryScope 字段的兼容缺陷等。

### 其他改进

- 建立中文文档体系：`docs/design/`（规格、契约、进度、使用指南、实施票据）与 `docs/adr/`（0003、0006–0011 共八项架构决策记录）；README 改为本 fork 中文入门。
- 建立三档测试体系：npm 全量（289 项）、WSL Python 远端套件（七套件）、CentOS 7.9 / Python 3.6.8 真实 VM SSH 门控；远端测试时钟可注入，无需真实等待期限。

<!-- 变更链接 -->
[2.1.0]: https://github.com/ONEGAYI/ssh-mcp-server/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/ONEGAYI/ssh-mcp-server/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/ONEGAYI/ssh-mcp-server/commits/v2.0.0
