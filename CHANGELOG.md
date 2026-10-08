# 更新日志

本仓库 [ONEGAYI/ssh-mcp-server](https://github.com/ONEGAYI/ssh-mcp-server) 是 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 的自维护 fork。上游 v1.9.2 及之前的变更见上游仓库。

## [2.4.0] - 2026-10-08

新增 ZCode / Codex 双宿主接入与可选的会话规则、技能目录注入。Windows 传输状态保存持续受阻时保留编号和数据，解除占用后可恢复，不再误记为失败终态。

### 新功能

**双宿主接入与会话上下文（setup / 恢复钩子）（PR [#38](https://github.com/ONEGAYI/ssh-mcp-server/pull/38)）**

- 每绑定可选择 ZCode、Codex 或同时接入两端，初始化、更新、恢复与移除保留其他绑定和用户自有配置
- 新增默认关闭的 `sessionStart` 开关，会话启动时读取远端根规则与工作区技能目录，按绑定限定范围和注入预算
- 技能只注入名称、描述和远端路径，正文按需读取；ZCode 使用 `.agents/skills` 与 `.zcode/skills`，Codex 使用 `.agents/skills`
- 存量绑定通过 `inspect → update` 启用新能力，认证信息和任务、传输身份保持不变

### Bug 修复

**Windows 状态保存受阻后的传输恢复（MCP / CLI）（PR [#39](https://github.com/ONEGAYI/ssh-mcp-server/pull/39)）**

- 小型传输状态 JSON 的原子替换遇到 Windows `EPERM/EBUSY` 时有限重试；持续拒绝则退出驱动并返回 `paused`，保留原编号、数据和诊断
- 解除文件访问问题后按原编号恢复；CLI `transfer wait` 返回暂停结果，不无限等待，暂停记录不能确认
- 上传远端已经提交、本机完成结果尚未保存时拒绝 `ack`，按原编号对账终态后再确认
- 旧 `failed` 的 `resume` 明确返回已保存的失败结果，不启动新尝试；明确取消请求不被数据退避阻塞

### 其他改进

- 工具说明区分命令任务 `jobId` 与文件传输 `transferId` 的取消入口，并说明未完成传输中的 SHA-256 是预期摘要，不能证明接收文件已经完成整文件校验（PR #39）

> **升级注意**：使用完整新离线包，包含新增的 `yaml`、`smol-toml` 依赖。存量绑定仍默认接入 ZCode、关闭会话注入；增加宿主或启用注入需先 `inspect`，再带 `revision` 更新 `clients` / `sessionStart`。Codex 项目与钩子信任需用户完成，ZCode 项目钩子按已确认的 3.14.x 环境验收。

> **恢复边界**：新暂停记录保留数据，应解除访问问题后恢复原编号；旧失败记录保持终态，处理原因后按需创建新传输。现场持锁进程尚未确定。

> **验收状态**：本机 Node 回归 327 项通过、17 项环境跳过、0 失败；真实 Windows 文件句柄探针验证释放占用后原编号完成 32 MiB 下载且字节一致。SSH 边界模拟，真实 ZCode / Codex 与 CentOS 7 内网使用仍待用户验收。本版附 Windows x64 离线包。

## [2.3.0] - 2026-10-08

大文件启动改为先返回可恢复编号，再由独立进程传输；补全离线发现、后台等待和确认指引。setup 提供显式连接列表，初始化绑定时可直接选择预存服务器。

### 新功能

**快速启动与离线恢复（MCP / CLI）（PR [#37](https://github.com/ONEGAYI/ssh-mcp-server/pull/37)）**

- 上传、下载在整文件摘要和 SSH 操作前持久登记编号，MCP 返回 `preparing` 后由独立 Node 进程驱动
- 新增 `remote_transfer_pending`，按会话离线分页列出传输；错误响应保留 `transferId`，编号丢失时可找回原传输
- `transfer wait` 观察或接回同一后台驱动，MCP 退出与驱动中断后可继续恢复；同一传输的执行权由操作系统 IPC 独占
- 新下载尚未取得远端大小时明确标记 `totalBytesKnown=false`；新传输的 `status` 返回本机驱动快照、错误和接回提示

**初始化绑定时列出预存服务器（setup）（PR [#37](https://github.com/ONEGAYI/ssh-mcp-server/pull/37)）**

- `remote_setup(action="list_connections")` 只读列出启动 `--config-file` 或调用 `sshConfigFile` 指定的 SSH MCP JSON 连接库中的名字
- 列表不要求工程目录，不写配置或连接 SSH，不回传主机及认证字段
- 未提供配置路径时只询问 JSON 文件路径；工具说明明确入口及它与 OpenSSH `.ssh/config` 的区别

### Bug 修复

**大文件调用超时后的可观察性（MCP）（PR [#37](https://github.com/ONEGAYI/ssh-mcp-server/pull/37)）**

- 全文摘要与数据驱动不再占用 MCP 启动调用的等待窗口，后台初始化错误写回登记并保存在 `driver.log`
- 指定编号登记可按同一意图重放，登记响应丢失后不会创建另一传输
- 结果状态与后续操作明确展示，未知发布状态结束 CLI 等待并返回非成功，不能作为可确认结果处理

### 其他改进

- 本机路径拒绝说明 `localRoot` / `allowedLocalPaths` 的允许范围；`remote_help` 与文档补全后台启动、等待、找回编号、显式确认和 Windows GNU tar 路径说明（PR #37）
- 新增 `npm run test:py` 并行 Python 套件入口，并强化既有探针、命令白名单与断言覆盖（提交 [93969b7](https://github.com/ONEGAYI/ssh-mcp-server/commit/93969b7176604fe1f95ebcd6c70c92478f8fa7ad)、[f643714](https://github.com/ONEGAYI/ssh-mcp-server/commit/f643714b3305e62813e469f1fdffba0ef570a5b0)）

> **升级注意**：MCP `start` 返回编号不代表完成，应在 ZCode 原生后台 Shell 中对原编号执行 `transfer wait`。已有同步 CLI 与旧传输记录仍可使用；结果处理后显式 `ack`，`unknown` 须人工核实且不能确认。

> **验收状态**：本机 JS 与 WSL Python 回归通过，另一台机器的真实 ZCode / CentOS 7 和大文件网络表现仍待用户验收。本版分发为含 Windows Node 运行时与依赖的离线包。

## [2.2.0] - 2026-09-15

绑定生命周期收口：remote_setup 新增移除绑定动作（remove），手工 CLI 提供对等入口，绑定从此具备完整的接入—调整—退役闭环。

### 新功能

- **remote_setup 移除绑定（remove）**（PR [#36](https://github.com/ONEGAYI/ssh-mcp-server/pull/36)，#28 决策，票据 #32）：`action: "remove"` 按 revision 防并发（与 update 一致）、标注 `destructiveHint`；绑定存在任何未确认任务或传输时硬拒绝（SETUP_PENDING_OPERATIONS，按绑定全量统计、不限当前对话，无 force 参数）；通过后按"先摘钩子与 MCP 条目、再删 profile"的顺序摘除 `.zcode/config.json` 中本绑定的接入（空节点原样保留，外部 MCP/钩子不动），删除 profile、setup 生成的连接文件与本机 identity 状态目录；外部引用的 sshConfigFile 永不删除。仅当移除最后一个绑定时，复用 #31 的匹配逻辑回收仍与已知生成文本一致的存量文档并报告。全程零 SSH 连接，远端状态目录仅报告路径与手工清理指引。
- **手工 CLI 移除入口**（PR [#36](https://github.com/ONEGAYI/ssh-mcp-server/pull/36)，票据 #33）：`node scripts/setup-workspace.mjs --workspace <profile> --remove [--revision <token>]` 与 MCP 共用同一实现；不带 revision 先返回包含当前 revision 与待确认工作清单的预览，带 revision 执行；移除流程的拒绝与失败以 JSON 输出到 stderr 并以非零码退出（参数误用仍为 Node 直接抛错）。注解为工具级——含破坏性动作后 remote_setup 整体标注 destructiveHint: true、idempotentHint: false（MCP 注解无 action 粒度，保守方向）。

### 其他改进

- **绑定级待确认判定**：任务与传输服务新增 `pendingAcross()`（全对话、离线读本地登记），供移除校验复用；恢复钩子的会话级 `pending` 语义不变。
- **路径身份匹配**：摘除 MCP 条目与恢复钩子时按"执行器 + `--workspace` 指向同一 profile 文件"匹配（文本精确匹配或 realpath 同一文件），大小写拼写差异或链接引用也能正确摘除，且不会误删外部条目。
- **文档收尾**（PR [#36](https://github.com/ONEGAYI/ssh-mcp-server/pull/36)，票据 #33）：README、usage 补移除流程；CONTEXT.md 大文件访谈节时点口径更正（#6–#21 已随 v2.0.0 实施）；test/README.md 测试结构树补齐至当前全量文件。
- **版本号对齐**：package.json 版本随发布更新至 2.2.0；v2.1.0 发布时遗漏了版本号更新，MCP 握手版本串在 v2.1.0 期间停留为 2.0.1，本次起恢复随发布同步。

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
[2.4.0]: https://github.com/ONEGAYI/ssh-mcp-server/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/ONEGAYI/ssh-mcp-server/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/ONEGAYI/ssh-mcp-server/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/ONEGAYI/ssh-mcp-server/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/ONEGAYI/ssh-mcp-server/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/ONEGAYI/ssh-mcp-server/commits/v2.0.0
