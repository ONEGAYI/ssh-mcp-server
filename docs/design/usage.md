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

只列服务器时，调用 `remote_setup({"action":"list_connections"})`，只返回连接名和后续指引，不要求 `localRoot`、远端目录，也不创建绑定或连接 SSH。可用 `sshConfigFile` 指定另一个 JSON 连接库；随后 configure 须复用同一路径与选定连接名。未提供启动库或调用路径时，只询问 JSON 文件绝对路径，不去 `.ssh` 猜配置位置。SSH MCP JSON 与 OpenSSH `.ssh/config` 是两种配置格式。

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
- 可更新字段：`policy`（组内深合并，见下表）、`directoryScope`、`pythonPath`、`clients`、`sessionStart`。首次配置同样支持这些字段。
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

### 会话开始时加载规则和技能

对现有绑定先 inspect，再携带 revision 更新 `clients: ["zcode", "codex"]` 和 `sessionStart: { enabled: true }`。每个绑定独立保存；省略 clients 保持 ZCode 默认，省略开关默认关闭。关闭用 `sessionStart: { enabled: false }`，其余预算字段保留。

两端均读取远端根 `AGENTS.md` 与 `.agents/skills`；ZCode 额外读取 `.zcode/skills`，不支持 `.codex/skills`。技能只访问入口 `SKILL.md`，注入名称、描述、远端路径和按需读取引导，使用前仍需读取正文，不预读引用文件。可配总读取等待 `timeoutMs`（默认 5000）和注入大小 `maxBytes`（默认 8192）。缺失与失败可见，超限或超时不会静默注入半份规则。

约定 `sessionStart: { enabled: true, maxBytes: 0, timeoutMs: 10000 }` 表示取消本程序的大小限制，以 10 秒约束整批远端拉取，超时返回 `CONTEXT_TIMEOUT` 并跳过全部已拉取内容。宿主输出限制继续适用，尤其 ZCode 默认 32 KiB 的接收限制需按实际版本核实；详见 [会话注入说明](session-start-context.md)。

新配置在下一次 SessionStart 生效，旧对话中已注入的内容不会撤回。Codex 接入后需重开项目并信任项目配置与钩子（`/hooks`）；ZCode 接入目标为已确认项目钩子可用的 3.14.x。详见 [范围、协议与验收](session-start-context.md)。

### 移除绑定（remove）

一个绑定不再使用时，对其做本地退役（decommission）。对 Agent 说明：

> 请用 remote_setup 的 action=inspect 拿到这个绑定的 revision，然后执行 action=remove 移除它。

- `action: "remove"`（提供 `localRoot` 与 `revision`，多绑定时加 `bindingName`）摘除该绑定的全部本地接入痕迹：MCP 条目与恢复钩子（先摘钩子再删 profile，避免恢复钩子带悬空参数运行）、profile 文件、setup 生成的 `.ssh-mcp-connection[.<绑定名>].json`，以及本机 identity 状态目录。整个过程零 SSH 连接。
- **硬拒绝**：该绑定存在任何未确认任务或传输时返回 SETUP_PENDING_OPERATIONS（按绑定全量统计，不限当前对话），没有 force 参数；先逐个 ack/cancel 清完再移除。
- **外科手术边界**：只摘自己的条目，其他绑定与用户自有的 MCP/钩子不受影响；`.zcode/config.json` 摘空后的空节点原样保留；外部引用的 `sshConfigFile` 永不删除。
- **存量文档**：仅当移除的是最后一个绑定（config 中不再有 `ssh-workspace-*` 服务）时，才复用 #31 的匹配逻辑回收仍与已知生成文本一致的 AGENTS.md / CLAUDE.md / SSH-WORKSPACE-GUIDE.md 并报告；用户改过的保留。
- **远端收尾**：remove 不连 SSH，只在返回中报告远端状态目录绝对路径与手工清理指引；远端记录由维护轮按保留期自然回收。
- **移除前与中断后**：先关闭仍在使用该绑定的会话与 MCP 服务（重开本项目即可），避免移除期间新建的任务/传输登记被连带删除或成为孤儿。profile 删除后若清理步骤失败或进程中断，remove 无法重跑，按返回报告中的路径（connectionFile、localStateDir、legacyDocs）手工删除残留。
- 返回 `remoteStateDir` 与各步骤结果；若 profile 曾提交进 git，删除后由用户自行提交，remove 不执行任何 git 命令。

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

第一条展示具体变更；第二条合并写入项目 `.zcode/config.json`，保留已有 MCP 与其他钩子。setup 不写任何 markdown（#31 起），操作指引由工作区 MCP 的 `remote_help` 与恢复钩子注入提供；旧版本生成的 AGENTS.md / CLAUDE.md / SSH-WORKSPACE-GUIDE.md 若内容仍与已知生成文本一致会被自动回收并在返回中报告，用户改过的文件保留不动。

移除绑定走同一 CLI（两步：先预览拿 revision，再执行；与 MCP 行为一致，含拒绝路径）：

```powershell
node scripts/setup-workspace.mjs --workspace D:/RemoteWork/example/.ssh-mcp-workspace.json --remove
node scripts/setup-workspace.mjs --workspace D:/RemoteWork/example/.ssh-mcp-workspace.json --remove --revision <预览返回的revision>
```

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
- 读取时仅实际返回的范围计入 readToken。未读完时允许编辑已知范围；整文件覆盖与上传覆盖绑定 metadataOnly 观察版本（#10/#13），无需完整已读；下载覆盖绑定本机目标观察版本（#14，见下）。同一文件版本变化后旧凭据失效。

### 移动、删除与目录管理（远端 Shell）

`remote_move` / `remote_delete` / `remote_mkdir` / `remote_rmdir` 已移除（ADR 0007 / #20）。这些操作通过远端 Shell 完成，即用后台任务执行 `mv`、`rm`、`mkdir`、`rmdir` 等命令：

```text
node <安装目录>/build/cli/job.js run --workspace <配置文件> --session <会话标识> --command "mv old/name new/name"
```

**Shell 移动删除不再拥有 readToken 保护**：远端 Shell 不检查读取凭据、已读范围或文件版本，防误操作依靠操作规范与所在客户端的命令审查。这不代表任何未来删除请求自动获授权——实际操作仍需遵循当前任务范围和用户指令。文件工具的读取凭据、精确编辑与版本覆盖保护不受影响。

传入 `offset` 后按该位置读取至文件尾（再受单次上限限制），不再使用 fromLine/toLine 作为区间终点；它不是绑定原区间的游标。文本 offset 必须位于 UTF-8 字符边界，使用返回的 nextOffset 可避免手算。二进制使用 `encoding: "base64"` 与字节 offset。

### 连续编辑无需反复读取

成功的 `remote_edit` 返回新 `readToken`。下一次编辑优先使用这个新凭据，无需再次 read。原已读范围随编辑长度变化而调整，自己提交的替换文本成为已知内容，未读区间仍保持保护。

例如 `read → token A → edit → token B → edit → token C`。若初始只读了一部分文件，后续依然不能凭此覆盖整个文件；外部修改仍会使新凭据失效。

如果返回 `written=true`、`rereadRequired=true`、`readToken=null`，说明编辑已提交，但凭据更新未能确认（例如提交后发生外部替换或状态文件保存失败）。此时应重新 read 当前内容，不能直接重试同一编辑。该续期行为只适用于 edit，write/upload 不自动续期。

### 已读范围全部替换与同文件并行编辑

每条 `edits` 项独立设置 `replace_all`，默认 `false` 保持全文件唯一匹配；`true` 替换该凭据已读范围内的全部完整命中。一次调用可以混合两种模式：

```json
{
  "edits": [
    { "oldText": "settings mcp.%s", "newText": "settings next.%s", "replace_all": true },
    { "oldText": "const defaultPort = 22", "newText": "const defaultPort = 2222" }
  ]
}
```

**全部替换的范围由已读凭据决定**：未读命中不修改。`editResults` 按输入项返回 `scope`、`replacementsApplied` 与实际匹配的 `ranges`；区间是 `beforeVersion` 中的 UTF-8 字节偏移，左闭右开。整个请求最多展示 128 个区间，`rangesTruncated=true` 表示范围列表省略了部分条目，计数仍准确。`scope=readRanges` 不能表述为全文件已替换。每次最多规划 65,536 个替换区间，超出返回 `EDIT_LIMIT`，整次不提交；可采用更具体的原文缩小目标。

**同一会话的不重叠修改可以并行发出**：多个调用可使用同一旧凭据。服务端在文件锁内依次提交，通过同一 `sessionId` 的精确编辑历史还原读取版本并移动后方目标；重叠即拒绝，即使两个调用想写相同结果。每次调用保持原子性，任一项失败则整次不提交。

旧凭据的变更追踪保留最近 10 分钟，且每个会话/文件索引最多 128 次提交、4 MiB。`rebased=true` 表示本次使用了变更链；`concurrentReplayAvailable=false` 表示本次修改未进入可追踪记录，后续旧凭据需要重读。历史超期、超额、丢失、不同会话、Shell 或 write/upload 变更仍触发 `FILE_CONFLICT`。普通读取凭据的 3 天闲置期限不变，后续优先使用最新返回的凭据。

机制和验收项见 [精确编辑扩展规格](scoped-edit-spec.md)。

### 上传大文件（可续传传输事务）

`remote_upload` 使用默认 1 MiB 分块与两端 SHA-256，文件字节不经模型。当前 MCP `action=start` 先验证本机路径与源元数据，持久化编号，然后快速返回 `state=preparing` 与 `transferId`；独立 Node 进程完成摘要、远端登记和传输。启动调用不触发在线维护，也不等待全文传完。

- 用原生后台 Shell 的 `transfer wait` 挂接终态结果。MCP `status` 对新传输返回本机驱动快照（`observation=local-driver-snapshot`），包括状态、已确认偏移与摘要；`completed` 结果要求确认。
- 网络中断时保留原编号与已确认数据。`driverRunning=false`、`resumeRequired=true` 表示需要接回；`resume` 或 `transfer wait` 会重启原驱动。源文件在首次本机登记后变化则拒绝，不混合版本。
- Windows 状态文件替换在有限重试后仍被拒绝时，新驱动报告 `paused`，保留原编号和数据，返回 `error`、`diagnosticLog` 与 `retryAfter`。解除访问问题后按原编号接回；暂停不能 ack，CLI 等待返回 `transfer-wait-paused`（退出码 1）。实际目标发布拒绝及其他 I/O 错误仍为终态失败。
- `resumeAttempted` 表示本次是否派发新驱动，不表示已完成新的传输。对 `failed` 调用 resume 只返回已保存的失败结果，明确没有开始新尝试；重复错误和同一临时文件名不能证明仍在占用。
- MCP 错误响应保留已有编号；后台错误在登记的 `error` 字段中可查。编号丢失时用 `remote_transfer_pending` 或 CLI `transfer pending`，不再 start。
- `action=status` 不启动驱动，也不确认结果；本机登记列表属于快照，不等于实时远端状态。
- 覆盖已有远端目标须先 `remote_read metadataOnly` 拿版本，再带 `overwrite=true` 与 `expectedVersion`；默认目标必须不存在。
- 新传输的 `action=cancel` 可先返回 `cancelling`，只表示请求已保存；待驱动确认 `cancelled` / `completed` 后才算取消流程结束。未提交数据按原停止核实契约回收，已完成的提交不回滚，unknown 不猜。旧同步记录保留原取消行为。
- `action=ack` 在检查并处理完终态结果后确认消费（与 status 分离；`unknown` 结果不可确认）。

命令任务的 `remote_cancel` 使用 `jobId`，传输取消使用对应 `remote_upload` / `remote_download` 的 `action=cancel` 和 `transferId`。切换传输通道前先确认原驱动已停止；ack 不负责取消。

### 下载大文件（可续传传输事务）

`remote_download` 的远端源绑定 `m1-` 观察版本，每块校验并持久化后才确认，全文摘要匹配后原子提交。**不签发 readToken**，下载不授予已读范围。MCP `start` 同样先返回 `preparing` 与本机持久编号，远端摘要由独立进程准备。

- 准备期 `totalBytesKnown=false`，总量暂未知；登记远端源后变为 true。按原编号 `transfer wait` 获取终态与摘要。
- 未 completed 前的 `sha256` 是预期源文件摘要，不能证明接收文件已经完成整文件校验；须核对完成状态、总大小与回执。Windows 状态保存暂停及旧失败快照语义与上传一致，详见 [状态文件访问失败修复](windows-transfer-state.md)。
- 新驱动被中断后通过 `resume` 或 `transfer wait` 接回；接收临时文件与块清单持久化在本机，恢复时先重校验，只补未确认数据。
- 断线或本机进程退出后，同样以 resume 接回；错误响应携带 `transferId`。
- 远端源文件在传输期间变化（`m1-` 版本不符）则拒绝原传输并置 `failed`（`TRANSFER_SOURCE_CHANGED`），需重新 start。
- 本机目标默认必须不存在；覆盖须带 `overwrite=true` 与本机目标观察版本 `l1-<size>:<mtimeMs>`（首次拒绝的 `FILE_CONFLICT` 消息会给出该值），提交前复核，目标变化拒绝覆盖。
- 本机磁盘写满（`STORAGE_FULL`）时清理接收临时文件后可重试，续传从零开始。
- `action=status` 只读查询进度，无副作用。
- `action=cancel` 可先返回 `cancelling`，待驱动沿原契约核实停止后再查询终态；先停发送方，再回收未提交接收数据。取消撞上提交窗口时仍按回执/意图核对，证据不足保持 unknown，正式文件不回滚。
- `action=ack` 在检查并处理完终态结果后确认消费（与 status 分离；`unknown` 结果不可确认）。

### 传输的后台等待与恢复（#15）

大文件传输的后台体验与任务同模式：durable `transferId` 跨进程有效，等待器由 ZCode 原生后台 Shell 执行，完成通知回到原对话。

```text
node <安装目录>/build/cli/job.js transfer start --direction download --remote <远端源> --local <本机目标> --workspace <配置文件> --session <会话标识> [--budget <毫秒>]
node <安装目录>/build/cli/job.js transfer wait --transfer-id <持久传输编号> --workspace <配置文件> --session <会话标识>
node <安装目录>/build/cli/job.js transfer status|resume|cancel|ack --transfer-id <持久传输编号> ...
node <安装目录>/build/cli/job.js transfer pending --workspace <配置文件> --session <会话标识>
```

- CLI `transfer start` 保持同步分段驱动，**整个启动命令必须放入原生后台 Shell**；完成输出 `transfer-result`，否则输出 `transfer-started` 与编号。默认 55 秒 budget 是步骤间检查的软预算，前置摘要/登记及在途 SSH 交换可越过它，不是客户端等待时限。旧记录的同步 resume 同样应通过后台 CLI 使用。
- MCP start 创建的新传输由独立进程驱动；CLI wait 观察它，驱动退出后接回原编号。并发等待不会各自写入下载文件；结果仍回到原生后台 Shell 的等待器。
- `transfer wait` 是后台等待器：循环驱动至终态，**期间不输出块级进度**，只在完成/失败/取消时输出一行 `transfer-result`（含 `acknowledgementRequired`）；断线按有界退避重试；`--wait-timeout` 到点输出 `transfer-wait-paused` 退出（durable 进度保留，重新 wait 即续）。
- 等待器被结束不取消传输；MCP 服务与本机重启后，用同一 `transferId` 重挂即可继续（只重传未确认数据）。
- 继续原对话时，恢复钩子除任务外还会列出同会话未确认的传输（离线读取本机登记），并给出 `transfer wait` 重挂模板；不要对同一目标重新 start 创建新传输。
- 传输结果同样保持 pending 直到显式 `transfer ack`（或 MCP `action=ack`）；cancelled 结果也需要确认消费。
- MCP 终态结果包含 `acknowledgementRequired=true` 与具体 `nextAction`；运行中及 unknown 不可确认。`remote_transfer_pending` 按会话分页（每页 50 条），不连接 SSH 或触发维护。
- 本机源/目标须处于工作区或 `allowedLocalPaths`；不自动允许 `%TEMP%`。GNU tar 的 Windows 归档路径使用 `/c/...` 等 MSYS 路径或 `--force-local`，该规则不泛化到其他 tar 实现。

### 后台任务


继续任意对话时，UserPromptSubmit 钩子给出真实 `sessionId`、工作区根和待处理任务。Agent 应先通过 `remote_workspace` / `remote_read` 读取远端规则，再使用 `remote_*` 文件工具；工作流规则不明确时调用工作区 MCP 的 `remote_help`（零参数、纯本地静态指引，不连 SSH，连接异常时也可用，#30）。

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
| 读后写 | 服务签发凭据；局部编辑只准修改已知范围；覆盖须显式绑定观察版本。移动、删除与目录管理不属文件工具（#20 / ADR 0007），走远端 Shell，无 readToken 保护 |
| 冲突 | 内容、身份或元数据变化后拒绝旧凭据；自身精确 edit 成功后核对写入结果并续期，其余写入口不自动续期。已提交写入的簿记失败报 `COMMITTED_UNCONFIRMED`（文件已写入，须重读后再操作，不得当未写入盲重试） |
| 编码 | 文本 UTF-8/BOM，保留原 CRLF 约定、权限与组；混合换行不整体重排。其他编码按 base64 传输 |
| 链接 | 经过符号链接的修改、多硬链接和非自有文件的替换明确不支持 |
| 搜索 | 字面量、大小写敏感、UTF-8；Linux 按 rg → GNU grep → Python 分块搜索选择后端，三后端结果一致（#11）。默认不读 .gitignore、包含隐藏文件，.git 内部始终排除；无单文件大小排除，200 MiB 网表可搜索；每页结果 64 KiB、默认扫描预算 512 MiB / 10 秒，预算耗尽返回 partial 与可续游标 |
| 查找 | 递归 glob 按文件名或相对路径匹配，目录分页；最多 50,000 个条目；rg 可用时用其枚举、否则 Python 遍历，结果一致（#12） |
| rg | VM 未安装；Shell 直接执行 rg 会按真实退出结果返回。可由用户另行提供兼容的离线 rg，不自动安装 |
| 工具返回 | 默认有界；read 只授权实际返回片段，edit 续期不扩大到未读间隔。文件文本输出按 JSON 序列化预算限制 |
| 命令日志 | stdout/stderr 分开持久保存。默认每任务合计 256 MiB，超限终止受管理命令并明确 OUTPUT_LIMIT；工作区额度耗尽时停止保存新日志并标注 STORAGE_LIMIT（命令继续运行） |
| 日志展示 | 本机最多展示 64 KiB 前缀，其余可用 remote_output 的字节游标或 tail=true 读取；不会为丢弃内容下载完整巨量日志 |

普通 Shell 命令仍可写文件。这套机制保护专用文件工具的开发操作，不拦截所有 Shell 写入。版本检查与原子替换之间，对不遵守协作锁的外部写入者仍有竞争窗口。文件工具的创建/覆盖提交使用同文件系统临时文件加原子替换；移动与目录管理属 Shell 命令（#20），本服务不约束其执行方式，操作前自行核对目标。

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
- **按需查看用量（#19）**：`remote_workspace` 传 `includeStorage: true` 时，返回（且仅返回）两端空间汇总：各自 `usedBytes / reservedBytes / limitBytes`、分类用量（状态目录 + 已登记临时 + 预留）、资源计数与最近一轮清理的时间和计数，序列化后不超过 4 KiB。默认不传该参数时响应与之前完全一致（不含统计）。远端不可达或统计失败时该端返回 `status: "unknown"` 与原因，不给出任何数字（不写零），本机一侧仍正常报告。计量与额度检查同口径：目标同目录的传输/编辑临时文件计入，提交后的正式目标不计入。统计与清理都不调用模型。

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
