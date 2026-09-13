# 实施进展与验证证据

## 2026-09-13 票据 #9：流式读取大文件与元数据版本凭据

分支 `ticket/09-streaming-read`，按规格 4.1/4.2 实施（TDD，测试先红后绿，测试与实现分开提交）：

1. **元数据版本**：`content_version` 改为 `m1-` + sha256(设备号, inode, 大小, mtime_ns, ctime_ns)，取消全文哈希；`current_version` 与提交前复核不再读全文。读取前后用描述符 fstat 并核对解析路径仍指向同一对象。
2. **读侧 16 MiB 上限取消**：`file_read` 改为 256 KiB 流式缓冲；文本序列化预算 56 KiB 与 `maxBytes`（返回预算）保留。写侧（编辑/覆盖/删除/移动/提交输出）16 MiB 全文边界不变，待 #10/#13。
3. **metadataOnly**：`remote_read` 新增参数，返回 `exists/version/size/bom` 或明确不存在状态，不返回内容、不签发凭据；#10 覆盖检查的 expectedVersion 来源。
4. **游标与按行扫描**：行请求顺序扫描定位（不回传前文、不缓存全文、无行索引），行模式返回 `lineStart/lineEnd/lineEndComplete`；超长行分块；UTF-8 不切断；窗口级编码校验；`expectedVersion` 拒绝旧游标。
5. **凭据期限**：readToken 记录含 `lastSuccessAt/expiresAt`（3 天常量），过期拒绝（`READ_TOKEN_EXPIRED`）且新读不复活旧范围；时钟经 `SSH_MCP_TEST_CLOCK` 窄入口注入。到期记录的物理回收属 #17。

验证证据（2026-09-13，worktree ticket-09）：

- WSL Ubuntu / Python 3.12：`remote-files.test.py` 32/32 通过（含 64 MiB 分页/行扫描、200 MiB 首中末、超长行、UTF-8 矩阵、时钟注入过期、VmRSS 内存自证增量 < 16 MiB）；`remote-agent.test.py` 通过。
- Windows Node 24.15：`npm test` 188 项（185 通过、3 门控跳过、0 失败）。
- CentOS 7.9 VM / Python 3.6.8（profile 按 workspaceId 隔离）：`workspace-mcp-remote.test.js` 通过，覆盖 metadataOnly 存在/不存在、`m1-` 版本、覆盖后旧游标 `FILE_CONFLICT`。
- 20/200 MiB 完整对比与网络成本测量留待 #21；本票仅做基础内存自证。

本票尚未由用户人工验收；`m1-` 前缀使升级前签发的旧凭据必然失效（要求重读，属预期迁移行为）。

## 当前状态

首版核心链路已实现：持久命令、ZCode 原生后台回传、继续原对话时恢复跟进、受保护文件工具、项目接入生成和离线目录打包。用户于 2026-09-11 报告：本机 ZCode 与 VMware CentOS 7 的人工验收全部通过，无遗留问题。最终内网离线环境尚未现场验收。

工作分支：`feat/remote-agent-workspace` 已通过 [PR #1](https://github.com/ONEGAYI/ssh-mcp-server/pull/1) 合并进 main。2026-09-12 起的三项扩展（预存 SSH 连接、多命名绑定、可选目录边界）在 `feat/named-bindings` 分支开发，以新 PR 留痕。`origin` 指向 fork，`upstream` 保留 classfang 原仓库。

## 2026-09-12 扩展：预存连接、多绑定、目录边界

用户批准的三项能力，均已实现并自动验证：

1. **预存 SSH 连接库**：setup 服务支持 `--setup --config-file <path>` 启动参数。缺项响应返回可用连接名列表（不回传凭据）；单次调用的显式 SSH 信息优先于预存库。MCP 协议级测试验证了发现、不泄露密码、仅凭连接名完成配置。
2. **多命名绑定**：`remote_setup` 接受 `bindingName`（小写字母/数字/连字符）。命名绑定使用独立 profile `.ssh-mcp-workspace.<名称>.json` 与连接文件 `.ssh-mcp-connection.<名称>.json`；自动 workspaceId 由本机项目与绑定名联合派生，旧无名绑定算法与任务归属不变。集成冲突检测前置到 profile 落盘之前（干跑），被拒绝的绑定不再残留半配置文件。契约测试覆盖：旧无名 + 3 个命名绑定（同服务器多目录 + 跨服务器）共存、profile/serverName 唯一、重复 setup 幂等、同名改目标拒绝、任务存储按 identity 隔离、4 个恢复钩子各自只列本绑定本会话任务、共享 AGENTS 规则不写死首个目录、非法绑定名与显式 workspaceId 撞名拒绝。
3. **可选目录边界**：profile 新增可选 `directoryScope`（缺省 restricted，仅用户显式选择才写入 unrestricted；字段不参与 identity）。unrestricted 只解除 remoteRoot 目录边界，readToken、已读区间、外部变更检查、截断保护与 16 MiB 上限全部保留；SSH 配置显式 `allowedRemotePaths` 继续作为交集限制。恢复上下文与 `file_workspace` 报告当前模式；doctor 改走与 MCP 相同的参数注入；discovery 对工作区外路径回退绝对路径显示。

验证证据：

- Windows 全套 Node 套件 187 项：184 通过、3 按环境跳过、0 失败（含 `test/directory-scope.test.js` 与协议级 bindingName/directoryScope 透传测试）。
- CentOS 7.9 / Python 3.6.8 真实 VM（2026-09-12 晚复测）：`remote-files.test.py` 14/14 通过（含缺省受限拒绝外部路径、unrestricted 可读、显式 allowlist 交集、非法 scope 拒绝、discovery 外部绝对路径显示），`remote-agent.test.py` 7/7 通过。
- VM 首跑暴露并已修复一个兼容缺陷：helper 请求缺 `directoryScope` 字段时被误拒，现归一为 restricted（提交 `fix: helper 缺省 directoryScope 归一为 restricted`）。

本轮三项扩展尚未由用户人工验收；最终内网离线现场验收状态不变。

## 人工验收结果（2026-09-11 用户报告）

证据来源为用户在真实 ZCode 桌面中按“开始验收.md”完成的两大场景，不是本机固定模型探针结果。

| 场景 | 用户报告的结果 |
|---|---|
| 工作区与规则 | remote_workspace 与远端规则读取通过 |
| 文件保护 | readToken 保护下的文件编辑、编码保持通过 |
| 正常后台任务 | 原生后台 Shell → job CLI run → 完成通知 → task-result 核对 → ack → pending 清空通过 |
| 重启存活 | ZCode 关闭终止本机等待进程后，远端任务仍 running |
| 恢复归属 | 钩子注入真实对话标识和任务登记（编号前缀 6065f848）；wait 接回原任务，createdAt 仍为 16:10:17 |
| 执行去重 | build-runs.log 从恢复前 1 行变为恰好 2 行，sleep 60; make build 只执行一次 |
| 结果确认 | exitCode 0、stdout 正常；remote_ack 后 remote_pending 清空，无损坏登记 |

用户已将第一轮“钩子未注入”的发现销案，判断为当时首次钩子信任尚未确认；第二轮注入正常且标识一致，不作为遗留缺陷。此结论覆盖本机 ZCode 与 VMware VM，未扩展为真实内网离线部署已验收。

## MCP setup 封装（人工验收之后的新改动）

用户追加要求：以 MCP 能力供 Agent 首次 setup，询问 SSH 和目录并自动准备钩子与命令入口。新增 `--setup` 模式与 `remote_setup`，缺项时返回问题，信息齐全后合并生成项目接入；原有手工脚本改为复用同一实现。

已通过缺项询问、引用已有 SSH 配置、直接提供 host/SSH agent、重复调用、保留原规则及拒绝项目配置目录外部重定向的自动测试。完整 Node 套件 178 项通过、3 项按环境跳过。生成配置还通过真实 ZCode 运行时与 VM 的项目级 MCP/钩子恢复测试，最新证据位于 `.artifacts/zcode-background-2fEbKU/result.json`；首条消息的钩子注入及项目 MCP 工具加载也有断言。受控测试端仅对自己生成的隔离项目钩子显式授信，产品 setup 不包含授信操作。

此前用户人工验收覆盖旧版手工接入路径；本次新增 setup 的首次用户操作尚未由用户再次验收。最终内网离线部署的现场验收状态不变。

## 精确编辑后的凭据续期（追加修正）

用户要求修正连续 remote_edit 每次需要重新 read 的行为。现在成功编辑后返回新 readToken 和版本，继承并按实际字节变化调整已读范围；后续使用新凭据可直接继续编辑。未读间隔、不同会话及外部修改仍受保护，write/upload/delete/move 的行为不变。

CentOS 7 上 12 项文件契约测试通过，覆盖连续完整/局部编辑、多区间、中文、CRLF、范围位移、删除至空文件、外部修改，以及提交后续期失败。真实 SSH/MCP 测试也通过 read → edit → edit → upload，两个 edit 之间没有 read。完整 Node 套件 178 项通过、3 项按环境跳过。规范轴和需求轴复核未发现 P1/P2；规范轴另以独立逐字节模型做了 10,000 组范围映射随机校验，均一致。

本轮新增行为尚未由用户再次人工验收。部署需使用包含本次修正的新包并重启 MCP；旧离线包不会自动变化。

## 已核实环境

| 项目 | 实测结果 |
|---|---|
| 本机 | 当前 Windows，Node.js 24.15.0 |
| ZCode | 桌面安装版本 3.11.2；随附 CLI/runtime 自报 0.16.5 |
| VM | CentOS 7.9.2009，x86_64，内核 3.10.0；eda 普通用户，UID 1001，XFS |
| 实际 glibc | 2.17；通过 /usr/bin/getconf 与 /lib64/libc.so.6 交叉验证 |
| 标识干扰 | PATH 中 /usr/local/bin/getconf 报 2.35，用户确认伪造；doctor 使用 Python 运行时 confstr |
| Python/Bash | /usr/bin/python3 为 3.6.8，Bash 4.2.46 |
| 兼容差异 | setsid 2.23.2 不支持 -f；正式执行器通过 Python start_new_session 脱离 SSH |
| rg/tmux | 当前 PATH 未发现；不自动安装，内置搜索使用 Python 字面量匹配 |

## 已实现与自动验证

- **任务主链路**：本机先登记，SSH stdin 提交 JSON；远端按任务编号和参数去重，脱离 SSH，分别保存 stdout/stderr 和实际退出结果。
- **恢复**：新进程从本机登记接回原任务；启动确认丢失时沿用原编号核对。退避重连、显式未知状态、等待超时与执行超时分离。
- **取消**：检查 worker 身份；取消过程中保留尚未回收的主进程，避免进程组编号复用。主 Shell 先退出、同组子进程忽略 TERM 的回归测试已通过。
- **输出与清理**：持久日志按写入前额度限制；模型展示 64 KiB 前缀，后续查询尾部与游标。已确认终态日志默认 7 天后可清理，保留任务去重记录。
- **文件**：按行/字节/Base64 读取、版本凭据、范围累计、精确编辑、创建/覆盖、上传/下载、删除/移动、目录和有界查找/搜索。
- **保护**：旧版本、未读区域、歧义匹配、已有创建目标、符号链接写入均拒绝。BOM/CRLF/权限保持。下载不授予模型未见内容的读取范围。
- **接入**：工作区模式独立注册 remote_*，不暴露旧无读取保护的 upload；旧模式保持原入口。生成项目级 MCP 与 UserPromptSubmit 配置。

Node 完整套件及真实 SSH/MCP 的结果以本机 `.artifacts/current-test.log`、远端 Python 契约测试输出为准。远端测试在真实 CentOS 7 / Python 3.6.8 运行，未用 Windows 模拟代替 Linux 文件锁与进程语义。

## 关键端到端证据

生产链路的可重复入口：

```powershell
node scripts/probes/zcode-background.mjs --cli <ZCode安装目录>/resources/glm/zcode.cjs --recover --workspace <工作区配置>
```

测试使用真实 ZCode app-server、Bash 后台工具、正式恢复钩子、正式任务服务及真实 VM。模型使用仅监听本机回环地址的固定响应服务，不访问模型账号；隔离 profile 不修改已有全局配置。

验证步骤：主回合结束时远端仍运行 → 终止 ZCode 测试进程 → 恢复同一 session → 普通“继续”请求触发正式钩子 → 重新后台等待原 job → 释放远端门控 → 收到对应等待的完成通知 → 模型工具调用确认结果。

首个成功产物：`.artifacts/zcode-background-a0cQly/result.json`。`remoteExecutedOnce`、`resultAcknowledged`、`waiterCompletionVerified` 均为 true；远端副作用计数为一次，完成事件的 jobId 与原登记一致。

这是受控模型的运行时集成验证，尚不等于自然模型在真实桌面操作中每次都遵守提示词。项目级钩子的首次信任仍由 ZCode 管理。

阶段 0 另验证了真实 SSH 会话断开后任务存活、重连后读取退出码；只终止了 eda 所属测试会话，未停止 SSH 服务。

## 审阅修复

两位独立审阅者分别检查文件保护与任务恢复。已修复并加入回归验证：重叠文本匹配误判唯一、JSON 转义扩大输出、主 Shell 提前退出漏杀子进程、普通 channel 错误不进入重连、明确 unknown 无限等待、不完整登记屏蔽有效任务。

## 当前交付边界

- 读侧无文件体积上限（流式有界交付，#9 已实施）；写侧单文件 16 MiB 全文边界保留（编辑/覆盖/删除/移动/提交输出），待 #10/#13。Python 搜索不模拟 rg/.gitignore。
- 无交互式 stdin/PTY；延期方案见 interactive-assessment.md。
- 协作锁不能消除不遵守锁的外部写入者的最后竞争窗口。
- 不自动判断 ZCode 原对话是否已删除，不自动转投其他对话。
- 日志清理保留请求、结果、读取凭据及去重状态；当前不做整个状态库的自动定期压缩。
- 离线包使用当前 Windows/架构 Node 和已安装依赖。最终内网机器与现有 Python 环境需按 usage.md 验收，不能把联网 VM 测试称为最终离线现场验收。

接入与人工验收步骤见 [usage.md](usage.md)。
