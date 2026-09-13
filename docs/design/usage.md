# SSH 远端工作区使用与验收

预览版，为 Windows 上的 ZCode 提供 SSH 远端文件工具和持久命令任务。源码与文档位于独立项目内，维护于 [ONEGAYI/ssh-mcp-server](https://github.com/ONEGAYI/ssh-mcp-server)；首个工作区 PR 已合并，多绑定/目录边界/预存连接扩展在 `feat/named-bindings` 分支，尚未发布到 npm。

## 运行条件

- Windows：本机 Node.js 或离线包内的 `runtime/node.exe`；ZCode 3.11.2 的随附运行时已做集成验证。
- Linux：SSH exec、`/bin/bash`、已有 Python 3.6 以上版本、可写的用户状态目录。实际 VM 是 glibc 2.17 / Python 3.6.8。
- Linux 无需访问外网、安装 Node.js 或拥有 root 权限。辅助 Python 文件通过现有 SSH 上传，以内容摘要区分版本。
- 不支持仅有交互式 shell transport 的连接；配置须使用 exec。原版 SSH 配置中的认证、代理与命令限制继续复用。

## 配置一个工作区

### 推荐：只添加 setup MCP，让 Agent 完成接入

离线包解压到固定目录后，只需添加一个 setup 服务。以下示例假设解压后的根目录为 `D:/Tools/ssh-mcp`，其中包含 runtime、build 和 examples。

在 ZCode 设置 → MCP 服务 → 完整配置中导入 [examples/mcp-setup.json](../../examples/mcp-setup.json)，按实际解压位置修改两处路径：

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

如果直接编辑 ZCode 的 `.zcode/config.json` 或用户级 `.zcode/cli/config.json`，其原生字段是 `mcp.servers`，使用 [examples/zcode-setup.json](../../examples/zcode-setup.json) 并合并现有字段。`mcpServers` 是完整配置导入格式，不是任意配置文件都使用的字段；不是单数 mcpServer。

setup 服务还支持 `--config-file <本机 SSH JSON 路径>` 启动参数，把已有连接库预存给 setup（模板见 [examples/mcp-setup-config.json](../../examples/mcp-setup-config.json) / [examples/zcode-setup-config.json](../../examples/zcode-setup-config.json)）。预存后 `remote_setup({})` 会在缺项响应中列出可用连接名，Agent 只需向用户确认连接名；凭据始终留在本机文件，不进入对话。单次调用只要出现任一显式 SSH 字段（host/用户名/端口/私钥/agent），本次就整体改用显式信息，不与预存库做字段级合并。

已知客户端限制（ZCode 3.11.2 实测）：完整配置导入会把 `args` 数组中含空格的元素按空格拆分成多个参数，破坏带空格的文件路径。预存连接文件请放在无空格路径；已有带空格路径的文件可用同盘硬链接建一个无空格名称（`New-Item -ItemType HardLink`），内容改动自动同步、凭据不重复存放。

然后对 Agent 说：

> 请调用 remote_setup 帮我配置这个项目的 SSH 远端开发。先询问缺少的连接和目录信息，再生成接入配置。

`remote_setup({})` 返回供 Agent 询问的缺项清单，不写文件、不连接 SSH。Agent 收齐信息后再次调用同一工具，自动完成：

- 在指定本机项目创建 `.ssh-mcp-workspace.json`，你不必手写。
- 合并项目 `.zcode/config.json` 中的远端 MCP 和 UserPromptSubmit 钩子，保留其他 MCP、钩子和已有规则。
- 配置已随包附带的 job CLI；恢复钩子会告诉 Agent 正确的后台 run/wait 命令入口。
- 私钥或 SSH agent 模式可直接提供主机、用户名和端口；工具生成只含连接参数/私钥路径的 `.ssh-mcp-connection.json`，不复制私钥。
- 密码或加密私钥口令留在本机已有原版 SSH MCP JSON 中，通过 `sshConfigFile` 引用，不在对话中询问或保存密码内容。

所需信息包括已有本机项目绝对路径、Linux 工程目录和持久状态目录，以及 SSH 连接。Linux Python 默认 `/usr/bin/python3`，可指定其他已有的 Python 3.6+ 路径。

工具成功只表示本机配置准备完成，返回 `sshVerified=false`。重新打开指定项目（如果新工具尚未加载），完成 ZCode 的首次项目钩子信任，再让 Agent 调用生成的 `remote_workspace` 检查实际 SSH 与 Python。setup 服务本身负责接入，日常操作由它生成的项目 MCP 提供；setup 不修改用户全局配置，也不代替 ZCode 授予钩子信任。

重复传入相同信息不会重复追加钩子。已有不同工作区 profile、同名不相关 MCP 或重定向的 .zcode 目录会返回冲突，避免静默改动项目指向；根据错误检查配置后再继续。

### 多个绑定与目录边界

- 再次调用 `remote_setup` 并提供 `bindingName`（小写字母/数字/连字符，1–64 字符）即可接入第二个远端目标；同服务器多目录或跨服务器均可。命名绑定使用独立 profile 文件 `.ssh-mcp-workspace.<名称>.json`，自动 workspaceId 按本机项目与绑定名联合派生，与首个无名绑定不会冲突。
- 每个绑定各自选择连接、默认执行目录与状态目录，合并为独立的 `ssh-workspace-*` MCP 服务和恢复钩子。重复 setup 同一绑定幂等；同名改目标返回 SETUP_CONFLICT。任务登记按绑定 identity 隔离，恢复钩子只列出属于当前对话、当前绑定的任务。
- 恢复上下文标明绑定名、连接名、MCP 服务名、远端工程根与目录边界模式，避免 Agent 混用目标。
- 文件工具的目录边界默认 `restricted`：受保护读写/查找/搜索只能访问 remoteRoot 内路径。仅当用户明确表示不限制目录时，Agent 才以 `directoryScope: "unrestricted"` 记录；该选择只解除目录边界，readToken、已读区间、外部变更检查与截断保护不变，SSH 配置中显式的 `allowedRemotePaths` 继续作为交集限制生效。未填写一律视为 restricted，不隐式放开。
- 无边界绑定仍需 remoteRoot 作为默认执行目录与相对路径基点，建议填远端 home（如 `/home/user`）；不使用 `~` 记号。
- 显式同名 workspaceId 的两个绑定会在 MCP 服务名上冲突并被拒绝；旧无名绑定的 workspaceId 算法不变，已有任务归属不受影响。

已知边界：无边界绑定的搜索从 `/` 等挂载点根开始时，`/proc`、`/sys` 下的伪文件（如 environ、cmdline）同样会被扫描命中——这与文件工具可直读任意路径的 unrestricted 语义一致；如不希望搜索噪声，把搜索路径收窄到具体目录。手工运行 `build/cli/recovery.js` 不带 `--workspace` 时只向上寻找旧无名 profile，命名绑定依赖 setup 登记的显式钩子参数。新版生成的 profile 含 `bindingName`/`directoryScope` 字段，旧版本程序回退后不识别（解析报错）；回退需删除对应 profile 并重新 setup。

### 调整已有绑定（inspect / update）

已有绑定无需重新填写 SSH 信息即可调整策略参数。对 Agent 说明：

> 请用 remote_setup 的 action=inspect 查看这个项目的绑定配置和 revision，然后按我要调整的字段执行 action=update。

- `action: "inspect"`（提供 `localRoot`，多绑定时加 `bindingName`）返回脱敏配置、生效策略（含默认值）、凭据来源说明和 `revision`。凭据永不回显，inspect 不连接 SSH。
- `action: "update"` 必须带上 inspect 返回的 `revision`：只改显式提供的字段，其余原样保留；revision 过期或配置已被并发修改会返回 SETUP_CONFLICT，重新 inspect 后再试。
- 可更新字段：`policy`（组内深合并，见下表）、`directoryScope`、`pythonPath`。首次配置时也可以直接随调用提供 `policy`。
- 服务器连接、认证、remoteRoot、remoteStateDir、localStateDir、workspaceId 属身份字段，update 显式修改即拒绝（SETUP_IDENTITY_LOCKED）：换目标请用新 `bindingName` 新建绑定，旧绑定保留到任务和状态清理完成。

policy 组与默认值（未写的字段按默认生效）：

| 组 | 字段 | 默认值 |
|---|---|---|
| limits | localWorkspaceBytes / remoteWorkspaceBytes | 各 10737418240（10 GiB，两端每工作区） |
| retention | confirmedTaskLogMs | 259200000（3 天，自 ack 起） |
| retention | confirmedResultMs / unconfirmedResultMs / unknownRecordMs | 各 2592000000（30 天） |
| retention | interruptedTransferDataMs / readTokenMs | 各 259200000（3 天） |
| search | respectGitignore / includeHidden | false / true（.git 内部始终排除） |
| search | scanBudgetBytes / timeBudgetMs / pageSizeBytes | 536870912 / 10000 / 65536 |
| maintenance | intervalMs / maxItemsPerRun / timeBudgetMs | 3600000 / 100 / 2000 |

生效时点：策略保存后由消费方在下一次操作或维护周期读取新值，无需重启；运行中的操作沿用启动时快照。保留期限变更只影响新生成记录，已有记录的到期时间不变。`directoryScope` 与 `pythonPath` 在工作区 MCP 服务下次启动时生效。额度预留（本机 SpaceLedger 自 #16 起每次额度检查经 loadPolicy 重读 `limits.localWorkspaceBytes`）与到期清理（见「到期回收与在线维护」）已接入强制执行；搜索预算的强制执行仍属后续票据，当前仅完成存储、校验与按次重读。

手工编辑 profile 中的 policy 节同样受 schema 校验：未知字段、非正整数或布尔类型错误会让配置加载失败并明确报出字段位置。

### 手工入口（保留兼容）

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

`sshConfigFile` 指向已有原版 SSH MCP 的 JSON，不复制密码或私钥。`remoteRoot` 必须已存在；状态目录可以自动在用户权限下创建。相对本机路径以配置文件所在目录解释。默认 `localRoot` 是配置文件目录，也可显式指定。多绑定时可加 `bindingName`；需要解除文件目录边界时显式加 `"directoryScope": "unrestricted"`，缺省为 restricted。

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

### 指定读取区间与截断保护

`remote_read` 支持 `fromLine` / `toLine`（从 1 开始，两端包含），也支持 `offset` 字节续读。例如读取第 100–150 行：

```json
{
  "sessionId": "{{恢复钩子提供的真实对话标识}}",
  "path": "src/example.py",
  "fromLine": 100,
  "toLine": 150,
  "maxBytes": 16384
}
```

- `maxBytes` 默认 65536，可设 1–1048576；它限制原始内容字节数，实际返回仍受独立的 64 KiB JSON 输出预算约束。文件本身无体积上限（#9 起流式交付）。
- `truncated` 表示本次请求区间是否因上限未返回完整；`nextOffset` 给出可继续读取的字节位置，`startOffset` / `endOffset` 标出本次实际范围。
- `complete` 表示当前凭据的已知范围覆盖整个文件（来自实际读取及自身编辑后的继承）。局部区间读完可以同时出现 `truncated=false`、`complete=false`。
- 读取时仅实际返回的范围计入 readToken。未读完时允许编辑已知范围；整文件覆盖与上传覆盖绑定 metadataOnly 观察版本（#10/#13），无需完整已读；下载覆盖绑定本机目标观察版本（#14，见下）；删除或移动仍须具有完整已知范围。同一文件版本变化后旧凭据失效。

传入 `offset` 后按该位置读取至文件尾（再受单次上限限制），不再使用 fromLine/toLine 作为区间终点；它不是绑定原区间的游标。文本 offset 必须位于 UTF-8 字符边界，使用返回的 nextOffset 可避免手算。二进制使用 `encoding: "base64"` 与字节 offset。

### 连续编辑无需反复读取

成功的 `remote_edit` 返回新 `readToken`。下一次编辑使用这个新凭据即可，无需 read；不能继续使用旧凭据。原已读范围随编辑长度变化而调整，自己提交的替换文本成为已知内容，未读区间仍保持保护。

例如 `read → token A → edit → token B → edit → token C`。若初始只读了一部分文件，后续依然不能凭此覆盖整个文件；外部修改仍会使新凭据失效。

如果返回 `written=true`、`rereadRequired=true`、`readToken=null`，说明编辑已提交，但凭据更新未能确认（例如提交后发生外部替换或状态文件保存失败）。此时应重新 read 当前内容，不能直接重试同一编辑。该续期行为只适用于 edit，write/upload/delete/move 不自动续期。

### 上传大文件（可续传传输事务）

`remote_upload` 任意大小可用（默认 1 MiB 分块、两端流式 SHA-256 校验，文件字节不经模型）。默认 `action=start` 在单次调用预算（`budgetMs`，默认 55 秒）内驱动传输：

- 正常完成返回 `state=completed` 与 `transferId`、`sha256`、`bytesWritten`。
- 预算耗尽未传完时返回 `state=transferring`、`confirmedOffset` 与 `budgetExhausted=true`；用 `action=resume` 加同一 `transferId` 继续，只补未确认数据。预算也可调大（上限 600 秒）。
- 传输中出错（断线、超时）时错误响应携带 `transferId`，同样以 resume 接回；本机源文件在传输期间变化则拒绝续传，需重新 start。
- `action=status` 只读查询进度，无副作用。
- 覆盖已有远端目标须先 `remote_read metadataOnly` 拿版本，再带 `overwrite=true` 与 `expectedVersion`；默认目标必须不存在。
- `action=cancel` 主动取消（#15）：远端确认停止后才删除未提交的临时数据；已完成的提交不回滚（返回 `completed` 而非 `cancelled`）；结果未知时返回 `TRANSFER_STATE_UNKNOWN` 不猜。取消后 resume 只观察不复活。
- `action=ack` 在检查并处理完终态结果后确认消费（与 status 分离；`unknown` 结果不可确认）。

### 下载大文件（可续传传输事务）

`remote_download` 自 #14 起与上传对称：远端源绑定其 `m1-` 观察版本，默认 1 MiB 分块、每块摘要校验后确认，两端各自流式 SHA-256；文件字节不经模型，**不签发 readToken**（下载不授予已读范围）。默认 `action=start` 在单次调用预算（`budgetMs`，默认 55 秒）内驱动：

- 正常完成返回 `state=completed` 与 `transferId`、`sha256`、`bytesWritten`、`blocksFetched`。
- 预算耗尽未传完时返回 `state=transferring`、`confirmedOffset` 与 `budgetExhausted=true`；用 `action=resume` 加同一 `transferId` 继续，只补未确认数据（接收临时文件与块清单持久化在本机状态目录，恢复时先重校验再续传）。
- 断线或本机进程退出后，同样以 resume 接回；错误响应携带 `transferId`。
- 远端源文件在传输期间变化（`m1-` 版本不符）则拒绝原传输并置 `failed`（`TRANSFER_SOURCE_CHANGED`），需重新 start。
- 本机目标默认必须不存在；覆盖须带 `overwrite=true` 与本机目标观察版本 `l1-<size>:<mtimeMs>`（首次拒绝的 `FILE_CONFLICT` 消息会给出该值），提交前复核，目标变化拒绝覆盖。
- 本机磁盘写满（`STORAGE_FULL`）时清理接收临时文件后可重试，续传从零开始。
- `action=status` 只读查询进度，无副作用。
- `action=cancel` 主动取消（#15）：先停远端发送方，再删除本机未提交的接收临时数据与块清单、释放空间登记；已完成的提交不回滚；取消撞上提交窗口时按回执/意图证据核对，证据不足返回 `TRANSFER_STATE_UNKNOWN` 且不动数据。取消后 resume 只观察不复活。
- `action=ack` 在检查并处理完终态结果后确认消费（与 status 分离；`unknown` 结果不可确认）。

### 传输的后台等待与恢复（#15）

大文件传输的后台体验与任务同模式：durable `transferId` 跨进程有效，等待器由 ZCode 原生后台 Shell 执行，完成通知回到原对话。

```text
node <安装目录>/build/cli/job.js transfer start --direction download --remote <远端源> --local <本机目标> --workspace <配置文件> --session <会话标识> [--budget <毫秒>]
node <安装目录>/build/cli/job.js transfer wait --transfer-id <持久传输编号> --workspace <配置文件> --session <会话标识>
node <安装目录>/build/cli/job.js transfer status|resume|cancel|ack --transfer-id <持久传输编号> ...
node <安装目录>/build/cli/job.js transfer pending --workspace <配置文件> --session <会话标识>
```

- `transfer start` 单次预算内驱动；预算内完成输出 `transfer-result`，否则输出 `transfer-started` 与 durable 编号。也可继续用 MCP `remote_upload`/`remote_download` 的 start/resume 驱动，两种入口操作同一事务。
- `transfer wait` 是后台等待器：循环驱动至终态，**期间不输出块级进度**，只在完成/失败/取消时输出一行 `transfer-result`（含 `acknowledgementRequired`）；断线按有界退避重试；`--wait-timeout` 到点输出 `transfer-wait-paused` 退出（durable 进度保留，重新 wait 即续）。
- 等待器被结束不取消传输；MCP 服务与本机重启后，用同一 `transferId` 重挂即可继续（只重传未确认数据）。
- 继续原对话时，恢复钩子除任务外还会列出同会话未确认的传输（离线读取本机登记），并给出 `transfer wait` 重挂模板；不要对同一目标重新 start 创建新传输。
- 传输结果同样保持 pending 直到显式 `transfer ack`（或 MCP `action=ack`）；cancelled 结果也需要确认消费。

### 后台任务


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
| 目录边界 | 默认限制在 remoteRoot 内；仅用户显式选择 unrestricted 后文件工具可按绝对路径访问远端任意位置，其余文件保护不变 |
| 文件大小 | 读取与编辑无上限（流式，#9/#10）；上传与下载均无上限，走可续传传输事务（#13/#14）。inline 写入（text/base64）解码后最大 16 MiB，更大内容走上传 |
| 读后写 | 服务签发凭据；局部编辑只准修改已知范围；覆盖、删除、移动需要完整已知范围 |
| 冲突 | 内容、身份或元数据变化后拒绝旧凭据；自身精确 edit 成功后核对写入结果并续期，其余写入口不自动续期。已提交写入的簿记失败报 `COMMITTED_UNCONFIRMED`（文件已写入，须重读后再操作，不得当未写入盲重试） |
| 编码 | 文本 UTF-8/BOM，保留原 CRLF 约定、权限与组；混合换行不整体重排。其他编码按 base64 传输 |
| 链接 | 经过符号链接的修改、多硬链接和非自有文件的替换明确不支持 |
| 搜索 | 字面量、大小写敏感、UTF-8；Linux 按 rg → GNU grep → Python 分块搜索选择后端，三后端结果一致（#11）。默认不读 .gitignore、包含隐藏文件，.git 内部始终排除；无单文件大小排除，200 MiB 网表可搜索；每页结果 64 KiB、默认扫描预算 512 MiB / 10 秒，预算耗尽返回 partial 与可续游标 |
| 查找 | 递归 glob 按文件名或相对路径匹配，目录分页；最多 50,000 个条目；rg 可用时用其枚举、否则 Python 遍历，结果一致（#12） |
| rg | VM 未安装；Shell 直接执行 rg 会按真实退出结果返回。可由用户另行提供兼容的离线 rg，不自动安装 |
| 工具返回 | 默认有界；read 只授权实际返回片段，edit 续期不扩大到未读间隔。文件文本输出按 JSON 序列化预算限制 |
| 命令日志 | stdout/stderr 分开持久保存。默认每任务合计 256 MiB，超限终止受管理命令并明确 OUTPUT_LIMIT；工作区额度耗尽时停止保存新日志并标注 STORAGE_LIMIT（命令继续运行） |
| 日志展示 | 本机最多展示 64 KiB 前缀，其余可用 remote_output 的字节游标或 tail=true 读取；不会为丢弃内容下载完整巨量日志 |

普通 Shell 命令仍可写文件。这套机制保护专用文件工具的开发操作，不拦截所有 Shell 写入。版本检查与原子替换之间，对不遵守协作锁的外部写入者仍有竞争窗口。无覆盖移动使用同文件系统 link/unlink；两步间崩溃可能保留两个名字，后续多硬链接检查会明确拒绝继续修改。

## 到期回收与在线维护

任务和传输的结果、日志、读取凭据、旧 helper 与遗留临时文件按保留规则自动回收，无需定期手工清理：

- **两级触发**：远端查询类动作（status/output/transfer_status 与文件查询）顺带做一次有界懒清理（60 秒节流）；工作区 MCP 每个工具调用与 job CLI 每次运行触发本机维护检查，距上一轮完成超过 `policy.maintenance.intervalMs`（默认 1 小时）才真正执行一轮——每轮先回收本机登记（任务与传输记录同规则），再驱动远端一轮，两端各自有互斥锁、持久游标与项数/时长双预算（默认 100 项/2 秒），预算中断下轮从游标续扫。
- **离线补做**：完成时间戳持久化在本机状态目录；ZCode 退出或 SSH 断连期间到期不保证立即删除，重连后第一次操作自动补做。没有远端守护进程或 cron。
- **期限**（policy.retention 可配，变更只影响新记录）：已确认任务日志自 ack 起 3 天；已确认任务/传输结果记录自 ack 起 30 天；已结束未确认结果自结束起 30 天；结果 unknown 的记录自首次观察起 30 天（查询不续期）；中断传输数据自最后实际进展（无进展则注册）起 3 天。
- **读取凭据**：readToken 连续 3 天无成功相关读取或编辑即失效，失效的凭据记录与索引由维护轮物理删除；被回收后编辑按 READ_REQUIRED 拒绝，重新读取需要的片段即可继续编辑（旧已读范围不会复活）。
- **旧 helper 镜像**：远端 helpers/ 只保留正在运行的版本和仍被运行中进程引用的版本，其余在下一轮维护删除。升级期间的旧版本客户端重启后会自动重装所需镜像；回退部署请使用对应的离线包。
- **遗留临时文件**：编辑、写入与传输自身产生的临时文件在操作成功或明确失败时立即清理；崩溃残留（如断线时同目录下的 `.ssh-mcp-*` 临时文件）在下一次维护轮按账本登记、对象身份与持有进程三重证据核实后回收。账本查不到归属的文件不属于本服务，永远不会被自动删除；证据不全的残留保留最小管理记录并计入空间额度，继续等待核实。
- **回收后的旧请求**：标识一旦回收即被拒绝（REQUEST_EXPIRED_OR_UNKNOWN），不会因记录不存在而重新执行命令、重复提交传输或再次覆盖文件；传输过期后需重新注册传输，不伪装可续传。
- **显式执行**：`node build/cli/job.js maintain --workspace <配置文件> --session manual-maintenance` 立即跑一轮（同样受 1 小时节流）并输出两端摘要。

任务日志同时受工作区空间额度约束（与 256 MiB 每任务上限独立）：额度耗尽时停止保存新日志并明确标注 `STORAGE_LIMIT` 截断，命令本身继续运行不受影响。

## 手动日志清理（首版入口，保留兼容）

```powershell
node build/cli/job.js cleanup --workspace <配置文件> --session manual-maintenance
```

默认只清理已确认至少 7 天的终态日志；`--retention-days` 可调整，0 表示立即清理已确认日志。运行中任务和未确认结果不被清理。请求、结果与去重记录继续保留，旧任务编号不会因此再次执行。清理过的日志返回 LOGS_PURGED，不伪装成空输出。自动维护（上一节）不使用该入口的 7 天默认值。

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

用户已于 2026-09-11 报告上述本机 ZCode / VMware VM 人工验收通过。自动化证据、人工报告及尚待完成的真实内网离线现场验收范围见 [progress.md](progress.md)。交互式 stdin/PTY 延期评估见 [interactive-assessment.md](interactive-assessment.md)。
