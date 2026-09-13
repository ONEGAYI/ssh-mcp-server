# 更新日志

本仓库 [ONEGAYI/ssh-mcp-server](https://github.com/ONEGAYI/ssh-mcp-server) 是 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) 的自维护 fork。上游 v1.9.2 及之前的变更见上游仓库。

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
[2.0.0]: https://github.com/ONEGAYI/ssh-mcp-server/commits/v2.0.0
