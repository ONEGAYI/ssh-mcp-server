# SSH 远端工作区使用与验收

预览版，为 Windows 上的 ZCode 提供 SSH 远端文件工具和持久命令任务。源码与文档位于独立项目内，维护于 [ONEGAYI/ssh-mcp-server](https://github.com/ONEGAYI/ssh-mcp-server) 的 `feat/remote-agent-workspace` 分支；尚未发布到 npm 或合并至主分支。

## 运行条件

- Windows：本机 Node.js 或离线包内的 `runtime/node.exe`；ZCode 3.11.2 的随附运行时已做集成验证。
- Linux：SSH exec、`/bin/bash`、已有 Python 3.6 以上版本、可写的用户状态目录。实际 VM 是 glibc 2.17 / Python 3.6.8。
- Linux 无需访问外网、安装 Node.js 或拥有 root 权限。辅助 Python 文件通过现有 SSH 上传，以内容摘要区分版本。
- 不支持仅有交互式 shell transport 的连接；配置须使用 exec。原版 SSH 配置中的认证、代理与命令限制继续复用。

## 配置一个工作区

在本机为一个远端项目建立专用目录，例如 `D:\RemoteWork\example`。该目录保存接入配置和本机输出，Linux 源码不会自动同步到这里。

在目录内创建 `.ssh-mcp-workspace.json`：

```json
{
  "workspaceId": "example-linux",
  "connectionName": "my-linux",
  "sshConfigFile": "D:/Private/ssh-config.json",
  "remoteRoot": "/home/user/project",
  "remoteStateDir": "/home/user/.local/state/ssh-mcp-agent",
  "pythonPath": "/usr/bin/python3",
  "localStateDir": "./.ssh-mcp-state"
}
```

`sshConfigFile` 指向已有原版 SSH MCP 的 JSON，不复制密码或私钥。`remoteRoot` 必须已存在；状态目录可以自动在用户权限下创建。相对本机路径以配置文件所在目录解释。默认 `localRoot` 是配置文件目录，也可显式指定。

在源码目录运行（离线包则把 `node` 换成包内 `runtime/node.exe`）：

```powershell
node scripts/setup-workspace.mjs --workspace D:/RemoteWork/example/.ssh-mcp-workspace.json
node scripts/setup-workspace.mjs --workspace D:/RemoteWork/example/.ssh-mcp-workspace.json --apply
```

第一条展示具体变更；第二条合并写入项目 `.zcode/config.json`，保留已有 MCP 与其他钩子。项目缺少规则文件时生成 AGENTS.md / CLAUDE.md；已有 AGENTS.md 时另写 SSH-WORKSPACE-GUIDE.md，恢复钩子也会注入操作指引。

用 ZCode 打开该本机目录。恢复钩子属于项目级进程钩子，首次可能需要在 ZCode 中信任；这是 ZCode 的工作区钩子接入步骤。全局配置不被修改。官方文件路径说明见 [MCP 配置](https://zcode.z.ai/en/docs/mcp-services)，钩子输入与来源见 [Hooks](https://zcode.z.ai/en/docs/hooks)。

可先诊断连接：

```powershell
node build/cli/job.js doctor --workspace D:/RemoteWork/example/.ssh-mcp-workspace.json --session manual-diagnostic
```

诊断返回实际 Python 进程的 libc、工程根、规则文件和搜索能力。不会使用 PATH 中可能伪造的 getconf 标识作为兼容依据。

## Agent 日常工作

继续任意对话时，UserPromptSubmit 钩子给出真实 `sessionId`、工作区根和待处理任务。Agent 应先通过 `remote_workspace` / `remote_read` 读取远端规则，再使用 `remote_*` 文件工具。

命令通过本机入口运行，**必须由 ZCode 原生 Shell 设置 `run_in_background: true`**。仅在命令末尾加 `&` 不提供相同的原对话完成跟进。

```text
node <安装目录>/build/cli/job.js run --workspace <配置文件> --session <钩子提供的标识> --command "make build"
```

任务具有明确 cwd/env，不在不同任务间继承 `cd` 或 `export`。默认 stdin 关闭、无 PTY，未设置执行上限时不自动套用旧同步工具的 30 秒限制。

任务结束后，本机等待程序返回 `task-result`，ZCode 原生后台通知触发后续处理。`eventId` 是稳定的完成事件标识；处理后调用 `remote_ack` 或 CLI `ack`。仅打印日志不算已处理。

## 断线、重启与恢复

- SSH 断开时，本机等待程序退避重连；远端任务继续。
- ZCode 或等待程序退出时，登记仍保留。**继续原对话**触发恢复钩子；Agent 用 `wait --job-id <原编号>` 接回任务，不能再次 run 原命令。
- 启动确认丢失时，wait 以原编号和原参数核对远端记录。已有执行意图不重跑，无法确认时返回 unknown。
- 原对话不再使用时，结果仍保留。首版不自动检测 ZCode 对话是否已删除，也不把结果转发给其他对话；可用配置对应的本机登记目录核查归属。
- 仅启动 ZCode 不会主动唤醒原对话；这一恢复触发点已经按需求确认。

`wait --wait-timeout <毫秒>` 只结束本次观察。`run --execution-timeout <毫秒>` 才设置远端执行上限。主动取消使用 `remote_cancel` / CLI cancel，并核实返回状态。

## 文件与输出边界

| 项目 | 首版行为 |
|---|---|
| 文件大小 | 专用读写、上传、下载单文件最多 16 MiB；更大文件明确报错 |
| 读后写 | 服务签发凭据；分段读取按同一版本累计。局部编辑只准修改已返回范围；覆盖、删除、移动需要完整读取 |
| 冲突 | 内容、身份或元数据变化后拒绝旧凭据；成功写入不会自动签发新读取资格 |
| 编码 | 文本 UTF-8/BOM，保留原 CRLF 约定、权限与组；混合换行不整体重排。其他编码按 base64 传输 |
| 链接 | 经过符号链接的修改、多硬链接和非自有文件的替换明确不支持 |
| 查找 | 目录分页；递归 glob 查找最多 50,000 个条目 |
| 搜索 | Python 字面量搜索，跳过 .git、二进制和大于 16 MiB 的文件；单次最多扫描 64 MiB。不会模拟 rg 的正则或 .gitignore 语义 |
| rg | VM 未安装；Shell 直接执行 rg 会按真实退出结果返回。可由用户另行提供兼容的离线 rg，不自动安装 |
| 工具返回 | 默认有界；读取凭据只覆盖实际返回片段。文件文本输出按 JSON 序列化预算限制 |
| 命令日志 | stdout/stderr 分开持久保存。默认每任务合计 256 MiB，超限终止受管理命令并明确 OUTPUT_LIMIT |
| 日志展示 | 本机最多展示 64 KiB 前缀，其余可用 remote_output 的字节游标或 tail=true 读取；不会为丢弃内容下载完整巨量日志 |

普通 Shell 命令仍可写文件。这套机制保护专用文件工具的开发操作，不拦截所有 Shell 写入。版本检查与原子替换之间，对不遵守协作锁的外部写入者仍有竞争窗口。无覆盖移动使用同文件系统 link/unlink；两步间崩溃可能保留两个名字，后续多硬链接检查会明确拒绝继续修改。

## 日志清理

```powershell
node build/cli/job.js cleanup --workspace <配置文件> --session manual-maintenance
```

默认只清理已确认至少 7 天的终态日志；`--retention-days` 可调整，0 表示立即清理已确认日志。运行中任务和未确认结果不被清理。请求、结果与去重记录继续保留，旧任务编号不会因此再次执行。清理过的日志返回 LOGS_PURGED，不伪装成空输出。

## 离线交付

在联网 Windows 完成依赖安装、构建与测试后：

```powershell
node scripts/package-offline.mjs --output D:/Packages/ssh-mcp-windows-preview
```

输出目录包含当前 Windows Node 运行时、已安装依赖、构建代码、Python 辅助文件、接入脚本和文档。为避免迁移时遗漏间接依赖，预览包包含当前 node_modules 的开发依赖；没有复制 SSH 配置、凭据、工作区 profile 或测试产物。MANIFEST.json 提供每个文件的 SHA-256。

将目录复制到相同架构的内网 Windows 后，用 `runtime/node.exe scripts/setup-workspace.mjs ... --apply` 重新生成路径。打包目录不要求 npm install。Linux 端依然需要已有 Python 3.6+；当前未提供自带 Python 的发行物。

## 人工验收

1. 在专用本机工作区开始 ZCode 对话，确认能列出 remote_* 工具，钩子提供真实对话标识。
2. 要求 Agent 在远端创建小文件、读取并编辑；随后用外部 SSH 改动，再验证旧凭据被拒绝。
3. 要求执行 `sleep 20; printf 'build done\n'`，检查主对话先返回、任务结束后自动继续。
4. 运行约一分钟的任务，中途关闭 ZCode；重新进入原对话输入“继续”，检查同一任务被接回且没有重跑。
5. 查看处理完成后的待处理列表，确认仅在 Agent ack 后消失。

自动化证据与尚待人工验收的范围见 [progress.md](progress.md)。交互式 stdin/PTY 延期评估见 [interactive-assessment.md](interactive-assessment.md)。
