# 实施进展与验证证据

## 当前状态

首版核心链路已实现：持久命令、ZCode 原生后台回传、继续原对话时恢复跟进、受保护文件工具、项目接入生成和离线目录打包。当前交付是本地预览版，实际 ZCode 桌面会话与最终内网环境仍待人工验收。

工作分支：`feat/remote-agent-workspace`。四批功能提交已推送至 [ONEGAYI/ssh-mcp-server](https://github.com/ONEGAYI/ssh-mcp-server)，在 fork 内以草稿 PR 留痕，等待人工验收；不直接合并，也不向上游提交 PR。`origin` 指向 fork，`upstream` 保留 classfang 原仓库。

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

- 专用文件操作单文件上限 16 MiB；Python 搜索不模拟 rg/.gitignore。
- 无交互式 stdin/PTY；延期方案见 interactive-assessment.md。
- 协作锁不能消除不遵守锁的外部写入者的最后竞争窗口。
- 不自动判断 ZCode 原对话是否已删除，不自动转投其他对话。
- 日志清理保留请求、结果、读取凭据及去重状态；当前不做整个状态库的自动定期压缩。
- 离线包使用当前 Windows/架构 Node 和已安装依赖。最终内网机器与现有 Python 环境需按 usage.md 验收，不能把联网 VM 测试称为最终离线现场验收。

接入与人工验收步骤见 [usage.md](usage.md)。
