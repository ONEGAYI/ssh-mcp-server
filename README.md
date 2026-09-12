# SSH MCP 工作区

在 Windows 上运行 ZCode，通过 SSH 操作 Linux 工程。支持受保护文件编辑、后台任务完成回传，以及客户端重启后继续跟进原任务。

这是 [ONEGAYI/ssh-mcp-server](https://github.com/ONEGAYI/ssh-mcp-server) 维护的 fork，基于 [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server)。本文介绍本 fork 的离线预览包与 MCP 引导接入；上游 npm 发行版不代表包含这些新增能力。

## 1. 使用前准备

| 位置 | 需要什么 |
|---|---|
| Windows | 已配置可用模型的 ZCode，以及本项目离线包；包内自带 Node.js 和运行依赖 |
| Linux | 可通过 SSH exec 连接，已有 Bash 和 Python 3.6+，工程目录及状态目录可写 |
| 网络 | Windows 能通过 SSH 访问 Linux；Linux 不需要访问外网 |

Linux 不需要安装 ZCode、Node.js 或手工部署本项目。首次远端操作时，Windows 会通过 SSH 自动上传 Python 辅助脚本、创建状态目录，无需 root。

**离线包不包含 ZCode、模型或 Linux Python。** 若 Linux 只有 Python 2.7，需要先准备兼容该机器的 Python 3.6+，再提供其绝对路径。

## 2. 解压到固定位置

例如将包内文件放到 `D:/Tools/ssh-mcp`。这个目录下应直接包含：

| 路径 | 用途 |
|---|---|
| `README.md` | 本使用说明 |
| `runtime/node.exe` | Windows Node.js |
| `build/index.js` | MCP 入口 |
| `examples/` | 可复制的 MCP 配置模板 |
| `docs/` | 详细使用说明和验证记录 |
| `MANIFEST.json` | 包内文件的 SHA-256 校验清单 |

另外选一个**已经存在的本机项目目录**，例如 `D:/RemoteWork/my-project`，用 ZCode 打开它。这个目录保存接入配置；真正的源码仍在 Linux，不会自动同步到 Windows。

## 3. 添加一份 setup MCP 配置

在 **ZCode → 设置 → MCP 服务 → 完整配置** 中添加下面的内容，按实际安装位置修改两处路径：

```json
{
  "mcpServers": {
    "ssh-mcp-setup": {
      "command": "D:/Tools/ssh-mcp/runtime/node.exe",
      "args": ["D:/Tools/ssh-mcp/build/index.js", "--setup"]
    }
  }
}
```

也可直接复制 [examples/mcp-setup.json](examples/mcp-setup.json)。

如果希望在 setup 对话中**复用已有 SSH 配置文件**（推荐），在启动参数中追加 `--config-file` 指向原版 SSH MCP 的 JSON 配置：

```json
{
  "mcpServers": {
    "ssh-mcp-setup": {
      "command": "D:/Tools/ssh-mcp/runtime/node.exe",
      "args": ["D:/Tools/ssh-mcp/build/index.js", "--setup", "--config-file", "D:/Private/ssh-config.json"]
    }
  }
}
```

配置一次后，Agent 在 setup 时只向你询问连接名（工具会列出可用的名字），不再需要每次提供地址、用户名或认证方式；文件中的凭据仍只留在本机文件里。两种配置结构的预存连接模板见 [examples/mcp-setup-config.json](examples/mcp-setup-config.json) 与 [examples/zcode-setup-config.json](examples/zcode-setup-config.json)。

**如果直接编辑 ZCode 原生配置文件**（项目 `.zcode/config.json` 或用户 `.zcode/cli/config.json`），使用 `mcp.servers` 结构，而不是上面的导入结构：

```json
{
  "mcp": {
    "servers": {
      "ssh-mcp-setup": {
        "command": "D:/Tools/ssh-mcp/runtime/node.exe",
        "args": ["D:/Tools/ssh-mcp/build/index.js", "--setup"]
      }
    }
  }
}
```

模板见 [examples/zcode-setup.json](examples/zcode-setup.json)。合并到已有配置中，保留其他服务和设置。

## 4. 让 Agent 完成首次 setup

在 ZCode 对话中发送：

> 请调用 remote_setup，询问缺少的 SSH 和目录信息，帮我初始化这个项目的远端开发工作区。

Agent 会先调用工具获取缺项，再向你询问：

| 信息 | 示例或说明 |
|---|---|
| 本机工作区 | `D:/RemoteWork/my-project`，需已存在 |
| SSH 连接 | 地址、端口（默认 22）、用户名；setup 配置了 `--config-file` 时只需从列出的名字中选连接名 |
| 认证 | 本机私钥文件路径或 SSH agent；也可引用已有原版 SSH MCP JSON 配置 |
| Linux 工程目录 | `/home/user/project`，需已存在；同时是文件工具的默认目录边界与命令默认执行目录 |
| Linux 持久状态目录 | `/home/user/.local/state/ssh-mcp-agent`，需有写入权限 |
| Python 路径 | 默认 `/usr/bin/python3`，可指定其他 Python 3.6+ |
| 绑定名（可选） | 同一项目接入第二个远端目标时提供，如 `eda-tests` |

使用密码或加密私钥口令时，在 Windows 本机的 SSH JSON 配置中填写，再告诉 Agent 配置文件路径和连接名。**不要把密码、口令或私钥内容发进对话。** 密码认证的最小配置示例：

```json
{
  "my-linux": {
    "host": "10.0.0.10",
    "port": 22,
    "username": "user",
    "password": "{{在本机填写密码}}"
  }
}
```

例如保存到 `D:/Private/ssh-config.json`，告诉 Agent 文件路径及连接名 `my-linux`。这是原版 SSH MCP 的 JSON 格式，不是 OpenSSH 的 `~/.ssh/config` 文本格式。

信息齐全后，Agent 再次调用 `remote_setup`，工具会自动：

- 生成本机工作区的 `.ssh-mcp-workspace.json`；提供 `bindingName` 时生成独立的 `.ssh-mcp-workspace.<名称>.json`。
- 合并项目 MCP 和恢复钩子到 `.zcode/config.json`，保留已有服务与规则；每个绑定一个 `ssh-workspace-*` MCP 服务和一个恢复钩子。
- 准备已随包附带的后台命令入口及 Agent 操作指引。
- 在直接提供私钥路径／SSH agent 的模式下，生成 `.ssh-mcp-connection.json`（命名绑定为 `.ssh-mcp-connection.<名称>.json`）；只记录连接参数，不复制私钥。

不需要手工运行 setup 脚本。成功返回中的 `sshVerified=false` 表示**配置已准备好，但还没有验证远端连接**。

重新打开指定的本机项目（如果新工具尚未出现），并确认 ZCode 提示的**首次项目钩子信任**。随后让 Agent 调用 `remote_workspace` 验证 SSH、Python 和远端目录，再读取远端规则。

setup 服务负责首次接入；日常文件和任务操作使用它生成的项目 MCP。

## 5. 添加更多绑定与解除目录边界

同一个本机项目可以同时连接多个远端目标：

- 同一台服务器的不同目录（如主代码库和测试目录），或不同服务器各一个目录。
- 再次调用 `remote_setup` 时提供 `bindingName`（小写字母、数字、连字符，如 `eda-tests`），并为该绑定单独选择连接、远端目录和状态目录。
- 每个绑定有独立的 MCP 服务名和恢复钩子；恢复信息只会列出属于当前对话、当前绑定的任务，不会串任务。

不提供 `bindingName` 的首次绑定保持原有文件名和行为，已有任务不受影响。

**目录边界**默认开启：文件工具只能访问远端工程目录内的路径。如果明确希望让文件工具访问远端任意绝对路径（例如要同时改工程目录之外的配置文件），在 setup 时向 Agent 明确说明"不限制目录"，Agent 会以 `directoryScope: "unrestricted"` 记录该选择；无边界绑定的默认执行目录通常建议填远端 home（如 `/home/user`）。解除边界**不会**取消读取凭据、已读区间、外部变更检查等保护；SSH 配置中显式写明的 `allowedRemotePaths` 仍会继续生效。未说明时一律按默认受限处理，不会隐式放开。

## 6. 日常怎么用

### 文件读取与连续编辑

可以直接告诉 Agent：

> 读取远端 src/example.py 的第 100–150 行，用 remote_edit 修改目标代码。后续编辑使用上次返回的新 readToken。

`remote_read` 支持指定行区间、字节续读和截断标记。**成功的 remote_edit 会返回新凭据，下一次编辑无需重复 read。**

保护仍然有效：未读部分不能直接编辑，整文件覆盖需要完整已知范围；外部修改会使凭据失效。若返回 `written=true` 且 `rereadRequired=true`，说明编辑已经提交但凭据更新未确认，应重新读取当前内容，不能盲目重复编辑。

### 后台构建与完成回传

> 请通过原生后台 Shell 在远端运行 make build，主回合先返回；收到完成通知后检查退出结果和日志，再确认处理。

Agent 使用恢复钩子提供的 job CLI，并设置 ZCode 原生 Shell 的 `run_in_background: true`。仅在命令后加 `&` 不等同于这条完成回传链路。

任务完成后，Agent 核对 `task-result`，必要时读取日志，再调用 `remote_ack`。只有处理确认后，任务才从 `remote_pending` 列表移除。

### 重启后继续原任务

关闭 ZCode 后，远端任务继续运行。重新进入**原对话**，发送：

> 继续。请检查恢复钩子中的任务，用原任务编号 wait 接回等待，不要重新 run 原命令。

恢复钩子会提供真实对话标识和未处理任务。只启动 ZCode、尚未继续原对话时，不保证自动唤醒。

### 停止任务

> 请取消这个远端任务，并核实它已结束。

取消需调用 `remote_cancel` 或 job CLI 的 cancel。关闭本机等待程序、SSH 断开和等待超时都不等于取消远端任务。

## 7. 常见问题

| 现象 | 处理方式 |
|---|---|
| 只有 remote_setup，没有文件工具 | 完成 setup，打开它返回的本机项目；必要时重新打开项目，检查生成的项目 MCP 是否启用 |
| 首条消息没有恢复信息 | 先检查首次钩子信任是否确认，再继续原对话；不要让 Agent 猜 sessionId |
| 返回 SETUP_CONFLICT | 检查已有工作区配置是否指向另一个目标或存在同名服务；不要直接覆盖旧配置 |
| 返回 FILE_CONFLICT | 文件发生变化，重新读取；连续 edit 应使用最新返回的 readToken |
| 返回 READ_REQUIRED | 当前凭据没有覆盖要修改的内容；补读相应区间或整个文件 |
| 返回 unknown | 无法确认远端执行状态；检查状态与日志，不自动重跑可能有副作用的命令 |
| Python 不可用 | 核对远端 pythonPath；本项目要求 Python 3.6+，不会自动安装 Python |

## 8. 升级

1. 关闭相关 MCP 进程；通常可先关闭 ZCode。
2. 将新包中的程序文件更新到**原安装目录**。
3. 保留本机工作区配置、SSH 配置，以及本机和远端任务状态目录。
4. 重启 ZCode/MCP，在原对话中继续跟进任务。

安装目录不变时，现有入口路径可继续使用。若更换安装目录，需要同步更新 setup MCP、已生成的项目 MCP 和恢复钩子的程序路径。旧 ZIP 和已经解压的旧程序不会自动升级。

远端辅助程序会按内容摘要部署新版本；升级 Windows 包不要求手工覆盖 Linux 脚本。

## 9. 当前范围

- 首版是非交互式 Shell：不提供 stdin 交互或 PTY。
- 专用文件操作上限 16 MiB；文件读取有独立的输出截断保护。
- 内置搜索是 Python 字面量匹配，不模拟 rg 的正则与 .gitignore；远端 rg 需要目标机自行具备。
- 普通 Shell 一直不做工作区目录沙箱；文件工具的目录边界默认开启，只有用户显式选择才解除，解除后其余文件保护仍然生效。
- 多绑定共享同一对话上下文，但任务登记与恢复按绑定隔离。
- 已有本机 ZCode + CentOS 7 VM 的人工验收，以及新 setup、连续编辑的自动验证；最终内网离线现场尚未验收。

进一步说明：[详细使用指南](docs/design/usage.md) · [接口契约](docs/design/contracts.md) · [验证进度](docs/design/progress.md)。

## 开发与打包

在与目标 Windows 架构一致的联网 Windows 开发机安装依赖后：

```powershell
npm install
npm test
node scripts/package-offline.mjs --output D:/Packages/ssh-mcp-preview
```

`npm test` 会先构建。打包脚本使用现有 build 和 node_modules，**生成新的目录包，不自动生成 ZIP**；随后可以压缩整个输出目录。已有目标目录会被拒绝，避免覆盖旧包。

以后每次离线打包都会把本 README 放在包根目录，连同 docs、examples 和运行程序一起写入校验清单。包中不复制工作区 profile、SSH 凭据或测试产物。

保留原版同步模式，可通过 `build/index.js --help` 查看入口；它不承担本工作区模式的持久任务保证。
