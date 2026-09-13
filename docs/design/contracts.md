# 首版接口与一致性契约

状态：用户确认的首版行为契约。核心链路已实现；交付限制与待人工验收项见 [usage.md](usage.md) 和 [progress.md](progress.md)。

2026-09-13 票据 [#17](https://github.com/ONEGAYI/ssh-mcp-server/issues/17) 已实施过期读取凭据、旧 helper 镜像与遗留临时资源的回收（规格 7.1/7.2）：维护轮在既有期限矩阵上扩展三类——过期 readToken 记录与悬空索引按其自身 `expiresAt` 物理删除（判定与读取路径同一时钟，回收后编辑按 `READ_REQUIRED` 拒绝、重读所需片段即恢复且不复活旧已读范围）；helpers/ 镜像按「当前运行版本 + /proc 命令行仍引用的版本」保留，其余在下轮清理（非 64-hex 命名的目录不是镜像、不删）；崩溃遗留的临时资源按账本归属 + 对象身份 + 持有进程（PID+启动身份）三重证据核实回收，未知占用的登记只保留最小管理字段并计入额度，无账本归属的文件永不触碰。本机维护轮同步回收本机账本的同类遗留（持有进程死亡 + 身份匹配才删临时）。详见「生命周期与回收」与「状态与临时数据的空间额度」两节。

2026-09-13 票据 [#16](https://github.com/ONEGAYI/ssh-mcp-server/issues/16) 已实施任务与传输结果到期回收：懒清理 + 每小时在线维护（互斥、游标、双预算），任务/传输结果、已确认日志与 unknown 观察记录按规格期限回收，回收后旧标识仍被拒绝；任务日志接入工作区额度（`STORAGE_LIMIT` 截断原因，不杀子进程）；本机 SpaceLedger 额度上限改为每次额度检查经 loadPolicy 重读（补齐 #8 遗留接线）。详见「任务生命周期」与「状态与临时数据的空间额度」两节。

2026-09-13 票据 [#9](https://github.com/ONEGAYI/ssh-mcp-server/issues/9) 已按 [ADR 0006](../adr/0006-large-file-version-checks.md) 实施读取侧：版本改为 Linux 元数据观察（取消全文摘要），读取取消 16 MiB 体积上限并改为有界流式交付，新增 metadataOnly 与字节游标续读，readToken 引入 3 天闲置过期判定（到期记录的回收执行仍属 #17）。票据 [#10](https://github.com/ONEGAYI/ssh-mcp-server/issues/10) 已实施写侧：精确替换与整体覆盖取消 16 MiB 全文边界，改为分块匹配与流式拼接提交，整体覆盖按 [ADR 0008](../adr/0008-explicit-version-bound-overwrite.md) 走显式 `overwrite` + `expectedVersion`。删除与移动仍保留首版 16 MiB 快照边界（其调整属 #20/#13）。下文「读取与版本」「写入提交」描述当前实现。

2026-09-12 大文件扩展其余已接受、尚未实施的调整仍见 [ADR 0006](../adr/0006-large-file-version-checks.md)。

整体覆盖规则已按 [ADR 0008](../adr/0008-explicit-version-bound-overwrite.md) 随 #10 实施：整体覆盖与上传替换不再要求模型完整已读，改为默认拒绝覆盖、调用显式声明覆盖并绑定目标版本、提交前检查版本冲突。局部 replace 的已读保护不因此取消。

## 工作区与公共返回

工作区配置包含稳定标识、SSH 连接名、远端工程根、远端辅助程序/任务数据目录，以及本机状态目录。一个工作区指向一个明确远端，任务记录不能只用可能重名的连接别名判断归属。

公共结果应区分有效操作结果与工具/传输错误。返回错误代码、可读说明及是否可重试；不得把“可重试查询”理解为“可以重跑原命令”。任务、文件、路径与游标均验证其归属。

路径以远端 POSIX 路径解释；相对路径基于配置工程根，拒绝 NUL。路径中的空格、中文和 Shell 元字符不能变成额外命令。新文件工具按解析后的真实位置执行已有路径范围约束，不能只用字符串前缀判断。

### 多绑定与目录边界（2026-09-12 扩展契约）

- 一个本机项目可承载多个命名绑定。每个绑定独立 profile（无名绑定保持 `.ssh-mcp-workspace.json`，命名绑定 `.ssh-mcp-workspace.<bindingName>.json`）、独立 workspaceId、独立 MCP 服务与恢复钩子；绑定名限小写字母/数字/连字符。
- 自动 workspaceId 由本机项目路径与绑定名联合派生；旧无名绑定算法不变，任何变更不得改变既有任务的 identity 归属。显式 workspaceId 冲突（同名 MCP 服务指向不同 profile）必须拒绝。
- setup 集成冲突检测先于 profile 落盘：被拒绝的绑定不得在项目里残留半配置 profile 文件。已知边界：检测通过到集成写入之间存在毫秒级窗口，并发改写项目配置可能留下"已写 profile、未集成"状态；重跑同一 setup 幂等收敛。update 的 writeAtomic 同为无锁原子写：expected revision 复核与写前重读把并发冲突窗口压到复检与 rename 之间的毫秒级，极端并发下仍可能 last-writer-wins（无半写，丢失一次并发更新）。
- 恢复钩子输出必须标明绑定名、连接名、对应 MCP serverName、远端工程根与目录边界模式；只列出属于当前真实会话且属于本绑定的任务。
- 文件工具目录边界默认 `restricted`（remoteRoot 内）。仅用户显式选择后记为 `unrestricted`：只解除目录边界，readToken、已读区间、外部变更检查、截断保护与 16 MiB 上限不变；SSH 配置显式 `allowedRemotePaths` 继续作为交集限制。缺省与未确认一律 restricted，不得隐式扩大访问。
- `directoryScope` 不参与 identity 计算；切换模式不得使旧任务或已签发凭据的归属键失效。unrestricted 绑定仍需存在的 remoteRoot 作为默认执行目录，不引入 `~` 记号。
- setup 服务可用 `--config-file` 预存 SSH 连接库；缺项响应只暴露连接名列表，永不回传凭据。单次调用出现任一显式 SSH 字段即整体改用显式信息，不做字段级合并。

### 已有绑定二次配置（2026-09-13 扩展契约）

remote_setup 增加可选 action 字段：缺省或 configure 保持首次配置语义不变（缺项询问、重复相同配置幂等、内容不同仍返回 SETUP_CONFLICT）。首次配置也可随调用提供初始 policy 覆盖。

action='inspect' 定位绑定（localRoot + 可选 bindingName），返回：脱敏 config（生效值，缺省字段以默认值呈现，含解析后的 policy）、authentication（凭据所在文件与连接名，只说明来源，不读取、不回显密码/私钥内容）、revision（profile 文本内容的 SHA-256）、updatable 与 identityLocked 字段清单。绑定不存在返回 SETUP_PROFILE_NOT_FOUND；inspect 不发起 SSH 连接。

action='update' 必须携带 inspect 返回的 revision（乐观并发）：缺 revision 返回 SETUP_REVISION_REQUIRED；revision 过期或保存时文件已变化返回 SETUP_CONFLICT，不产生半写（沿用 writeAtomic 原子写，失败不遗留临时文件）。update 只修改显式提供的字段：

- policy：组内深合并，只写提到的叶子；未提及的叶子与组原样保留，空结果不落键。
- directoryScope：可原位更新（不参与 identity，任务归属不变）；restricted 规范化为缺省（不落键）。
- pythonPath：可更新，须为绝对 POSIX 路径。

身份与认证字段在 update 中显式出现即拒绝（SETUP_IDENTITY_LOCKED，指引用新 bindingName 新建绑定、保留旧绑定跟进清理）：sshConfigFile、connectionName、host、port、username、privateKey、sshAgent、remoteRoot、remoteStateDir、localStateDir、workspaceId。update 不读取、不回显、不重写认证文件（预存库或生成的 .ssh-mcp-connection.json）。校验失败（SETUP_INVALID_POLICY / SETUP_INVALID_SCOPE / SETUP_INVALID_PATH）在写入前拒绝，profile 保持原样。

policy 配置节 schema 与规格默认值：limits（本机/远端每工作区各 10737418240 字节）、retention（确认任务日志 3 天；确认结果、未确认结果、unknown 记录各 30 天；中断传输临时数据 3 天；readToken 3 天）、search（respectGitignore=false、includeHidden=true、扫描预算 536870912 字节、时间预算 10000 ms、每页 65536 字节）、maintenance（间隔 3600000 ms、每轮 100 项、时间预算 2000 ms）。profile 中未写的叶子按默认值生效，不物化进文件。

生效时点：普通策略由消费方在每次操作或维护周期经 loadPolicy(profilePath) 重读最新值，无需重启；运行中的操作沿用其启动时快照。保留期限变更不追溯：已有记录保持原定到期时间，仅新生成记录采用新期限。directoryScope 与 pythonPath 在该绑定的工作区 MCP 服务下次启动时生效。额度预留已由票据 #8 接入本机下载链路（读 `limits.localWorkspaceBytes`），#16 起本机 SpaceLedger 每次额度检查经 loadPolicy 重读该值（保存的 policy 变更下一操作生效）；远端额度经 `<状态根>/ledger/policy.json` 每次操作重读；远端维护期限由本机维护轮次随请求传入（见「生命周期与回收」），远端 policy.json 的 retentionMs/maintenance 节可作本地缺省覆盖。搜索预算执行方仍属后续票据，接入前相应叶子仅完成存储、校验与重读，不得表述为已强制执行。

其余边界沿用 [ADR 0011](../adr/0011-binding-reconfiguration.md)：更换服务器或状态目录通过新建绑定处理，不做自动迁移。

## 文件接口

2026-09-13 已确认、尚未实施的用量概览：现有 remote_workspace 增加可选的空间统计查询，默认不附加统计，不新增独立 MCP 工具。开启时有界返回两端当前占用、预留额度、分类汇总和最近清理摘要，不列出全部状态文件；后台统计与清理不调用模型。参数名称和输出 schema 留待规格确定，详见 [ADR 0010](../adr/0010-state-cleanup-lifecycle.md)。

2026-09-12 已接受、尚未实施的工具调整见 [ADR 0007](../adr/0007-file-management-through-shell.md)：移除 remote_move、remote_delete、remote_mkdir、remote_rmdir，改用远端 Shell；移动与删除不再由专用工具强制检查读取凭据和版本。下表及后文仍保留当前首版实现的说明，实施时同步更新。

| 接口职责 | 主要输入 | 必须返回或保证 |
|---|---|---|
| 查看工作区 | 工作区标识 | 工程根、能力、规则文件位置；提供明确的远端规则读取指引 |
| 列目录/查找文件 | 路径、匹配条件、分页游标 | 类型、相对路径、下一页；不因枚举而签发读后写凭据 |
| 按行读取 | 路径、行范围、返回上限 | 内容、实际范围、编码/换行、截断标记、版本与读取凭据；无文件体积上限，流式交付有界窗口（#9 已实施） |
| 搜索内容 | 范围、模式、过滤条件、返回上限 | 文件/行号/命中内容、截断状态；默认不把命中片段视为已读取全文 |
| 编辑文本 | 读取凭据、预期版本、精确替换项 | 匹配数量明确；默认要求唯一匹配，歧义时拒绝；无体积上限，分块匹配与流式拼接提交（#10 已实施） |
| 覆盖写入/上传 | 显式覆盖意图、metadataOnly 观察版本、新内容或本机文件 | 覆盖必须 `overwrite=true` 并绑定观察版本；无需完整已读；默认拒绝覆盖已有目标（#10 已实施） |
| 创建文件 | 路径、新内容 | 必须不存在；存在时报冲突，不自动覆盖 |
| 删除/移动文件 | 源对象凭据、预期版本、目标及覆盖条件 | 源对象检查；目标覆盖也需目标凭据；无凭据时仅允许目标不存在 |
| 下载文件 | 远端路径、本机目标、覆盖策略 | 事务化传输（#14）：验证本机允许路径，返回持久 transferId 与有界传输结果，不签发读取凭据 |

新增目录与删除空目录可作为文件操作辅助；递归删除、覆盖整个目录树不纳入首版。首版对写入经过符号链接或涉及多硬链接的目标返回明确不支持，避免静默改变链接语义；后续可独立扩展。

### 大文件传输恢复（2026-09-13 票据 #13 上传、#14 下载、#15 取消与后台回传、#16 到期回收已实施）

2026-09-13 票据 #13 已实施可校验续传的流式上传事务、票据 #14 已实施下载方向（WSL Python 套件、npm test 与 VM 套件实测，内网现场未验收）；票据 #15 已实施主动取消、结果确认、job CLI 传输子命令、后台等待器与恢复钩子列举：

- **事务与记录**：上传走 `transfer_register`（服务端持久分配 32 hex `transferId`，不可自带）→ `transfer_start`（幂等）→ 分块交换 → `transfer_verify` → `transfer_commit` 的登记后执行协议；任何后续动作遇到缺记录一律 `REQUEST_EXPIRED_OR_UNKNOWN`，绝不落入创建分支。两端各存小型记录：远端 `<状态根>/transfers/<transferId>/` 下 `record.json`（身份、状态机、确认偏移、实际进展时间、到期时间、资源登记标识）、`chunks.jsonl`（每已确认块一行，追加写入、流式读取；撕裂的半行按清单结束于上一完整行处理，等价于该块未确认）、提交期 `intent.json`（目标预期版本、临时对象身份、最终摘要）与 `receipt.json`（回执）；本机 `<localStateDir>/<identity[:24]>/transfers/<transferId>/record.json` 承担归属与恢复登记。**会话核对覆盖全部传输动作**（start/resume/verify/commit/status 及块交换）：与登记会话不符一律 `TRANSFER_SCOPE_MISMATCH`。接收临时数据放目标同目录 `.ssh-mcp-upload-<id>`，先入 #8 资源账本（精确大小直接登记，无 reserve+register 双算；引用预留的登记按净增量计额度，预留与兑现不双重计数）再落盘，提交后注销、正式目标移出计量（对账补回执路径同样注销）。传输动作只受锁槽协议切换门槛约束，不检查任务协议排空门槛——两协议不写同一对象，legacy 写入检测由锁槽门槛承担。
- **状态机**：`prepared → transferring → verifying → committing → completed`，另有 `failed`（校验或提交复核失败——含 verify 尺寸不符与提交发布段的 OS 失败（目标消失/并发出现/权限），后者映射 `FILE_CONFLICT` 留痕，不裸抛 HELPER_ERROR 卡死状态机——留痕不复活）与规格预留的 `interrupted`、`cancelled`、`unknown`（`cancelled` 由 #15 的取消动作写入；`interrupted`/`unknown` 仍为预留观察态）。查询（status）只读，不启动新传输、不续期；实际块进展同时推进 lastProgressAt 与 3 天到期时间。非终态记录自最后实际进展（无进展则注册时刻）起按 `interruptedTransferDataMs`（默认 3 天）到期，分配成功但从未启动的记录同规则；到期由 #16 维护回收（见「生命周期与回收」），回收后标识按 `REQUEST_EXPIRED_OR_UNKNOWN` 拒绝，不伪装可续传。
- **分块与线格式**：默认 1 MiB（可配 64 KiB–8 MiB）；每工作区最多 2 个活动传输；每传输单个在途块、严格顺序接收。块经 SSH exec stdin 二进制流传输——一行有界 JSON 控制帧（transferId/index/offset/size/sha256/sessionId）+ 精确 `size` 原始字节，摘要校验通过且落盘后才追加清单并推进确认偏移；损坏块（`BLOCK_CHECKSUM_MISMATCH`）、乱序/重复块、短块一律拒绝且不推进。整文件不 Base64 进 JSON，模型不参与逐块调用（本机 Node 驱动循环，每次交换独立 60 秒超时，不沿用 30 秒默认命令超时）。
- **续传与校验**：`transfer_resume` 重读持久块流式重校验，可信边界按各清单条目的实际 `size` 累加（短尾块不影响——绝不用"块数 × 分块大小"推算），首个不可信边界处截断清单与临时文件（损坏块及其后数据从最近可信边界重传）；临时文件丢失从零重建；未启动过的事务 resume 拒绝（`INVALID_STATE`）。`transfer_start` 的崩溃残留（已创建临时文件与账本登记）在重试时按 `.ssh-mcp-upload-<id>` 的唯一命名自愈清理——prepared 态从未接收块，残留可安全重建。上传源=本机文件：登记时记录源身份（size+mtimeMs），start/resume 重报不符即 `TRANSFER_SOURCE_CHANGED`，本机驱动每块前后再核对。最终两端各自流式 SHA-256 核对相同全文摘要（`transfer_verify`），不跨网传全文；不匹配进 `failed`。
- **提交**：沿用 #10 骨架——默认目标不存在（link 防覆盖创建），覆盖必须 `overwrite=true` 绑定 metadataOnly 的 `expectedVersion`（register 时早检 + commit 时在目标槽位锁内复核），保留权限属组、fsync 文件与目录、原子替换。提交前持久化意图，提交后持久化回执；提交响应丢失重试时按对象身份（rename 保留 inode）加内容摘要双证据核对原事务补回执，证据不足保持 `TRANSFER_STATE_UNKNOWN`，不盲目再覆盖、不把偶然内容相同当作原提交证明。
- **下载方向（票据 #14，上传的反向）**：远端为发送方，本机 Node 驱动为接收方。`transfer_register(direction=download)` 时远端以 metadataOnly 的 `m1-` 版本观察源并流式摘要（前后双 stat 稳定窗），`totalBytes`/`totalSha256` 一律由发送方计算，调用方自带即拒绝；与上传共享每工作区 2 个活动传输的池。块交换走新 `transfer_fetch` 独立帧通道（与上传 `transfer_block` 的 stdin 模式对称的反向）：stdout 为一行有界 JSON 控制帧 + 精确 `size` 原始字节 + 换行 + 既有 `SSH_MCP_V1` 信封，错误时保持信封-only 形状；本机传输层新增二进制 stdout 通道（`Buffer` 不做 UTF-8 解码），按声明 size 结构化定位载荷，任意二进制内容不会污染解析。接收方确认位置权威：请求落在发送方已服务边界及之前时回退重取（响应丢失后发送方已推进的场景），之后严格顺序。每块前后核对源 `m1-` 版本，变化即置 `failed`（`TRANSFER_SOURCE_CHANGED`，不复活）。本机接收记录（`record.json`/`chunks.jsonl`/`intent.json`/`receipt.json`）为下载方向的权威状态；接收临时 `.ssh-mcp-download-<id>` 先入 #8 本机 SpaceLedger 再落盘，提交后注销移出计量；本机磁盘写满（ENOSPC）时清理临时与登记并从零续传。`transfer_verify` 携带接收方重算摘要，与发送方登记期摘要核对（两端各自流式 SHA-256，不跨网重读）；不匹配两端同置 `failed`。提交在本机执行：默认 link 防覆盖创建，覆盖须 `overwrite=true` 绑定本机目标观察版本（`l1-<size>:<mtimeMs>`，由拒绝消息给出，提交时复核），rename 原子替换；崩溃在 intent 与回执之间时按对象身份（dev:ino）加内容摘要双证据核对补回执，证据不足保持 `TRANSFER_STATE_UNKNOWN`。远端 `transfer_commit` 幂等记录发送方回执以释放共享活动槽位（本机回执权威）。`remote_download` 保持工具名、`action=start|status|resume|cancel|ack`（默认 start，后两者 #15 交付），预算与单块 60 秒交换超时同上传；瞬时通道错误驱动内有界重试。下载不签发 readToken、不授予模型已读范围；旧 base64 分块循环与 16 MiB 下载上限已移除。
- **公共入口**：`remote_upload` 保持工具名，`action=start|status|resume|cancel|ack`（默认 start；cancel/ack 由 #15 交付）。start 返回持久标识与有界状态（响应不含文件数据）；单次调用在 `budgetMs`（默认 55 秒，上限 600 秒）内驱动，预算耗尽返回 `transferring` + `confirmedOffset` + `budgetExhausted=true` 与 resume 指引；最后一块确认后才耗尽的预算同样先返回，verify/commit 延后到 resume 执行（尾部不逃出预算，两端同规则）；resume 只补未确认块。上传不再有 16 MiB 门槛，受两端空间额度约束。下载自 #14 起为同一事务结构的反向（见上一条目），`remote_download` 同样提供五动作入口。
- **主动取消（票据 #15）**：`transfer_cancel` 在传输专属 flock 内观察状态——锁互斥即"无在途块"的操作性证据，确认停止后才释放数据。终态幂等观察（completed/failed/cancelled 不转换）；`committing` 窗口按 intent 身份+摘要双证据核对：发布已生效则补回执认账 `completed` 绝不回滚，临时文件仍在则持锁证明发布无法再启动、删临时置 `cancelled`，两者皆非抛 `TRANSFER_STATE_UNKNOWN` 不删不猜；`prepared/transferring/verifying/interrupted` 上传方向删远端临时并注销账本登记，下载方向远端仅置 `cancelled`（接收方数据由本机侧清理）。本机（下载权威侧）取消顺序：先远端确认停止，再删本机接收临时与块清单、释放 #8 本机账本；本机 `committing` 窗口按"回执 → intent 身份+摘要 → 临时文件存在性"三步核对；本机 `unknown` 拒绝取消且数据不动。取消后的传输 resume 只观察不复活。会话归属与未知标识沿用 `TRANSFER_SCOPE_MISMATCH` / `REQUEST_EXPIRED_OR_UNKNOWN`。
- **结果确认（票据 #15）**：`transfer_ack` 是显式消费动作，与只读 status 分离；仅终态（completed/failed/cancelled/interrupted）可确认，`unknown` 不在集合内、不得被确认为已消费；远端 `transfers/<id>/ack.json` 与本机登记 ack 幂等落盘。本机 `pending(sessionId)` 离线扫描登记目录列同会话未确认传输（下载附本地 state 与 confirmedOffset），他会话/他工作区正常排除，损坏登记计入 registryIssues 不隐藏有效项——恢复钩子零网络列举的输入。
- **后台等待器与恢复（票据 #15）**：job CLI 新增 `transfer <start|wait|status|resume|cancel|ack|pending>` 子命令组，与 MCP 工具操作同一事务。`transfer wait` 为 ZCode 原生后台 Shell 的等待器：循环 resume 至终态，期间不投递任何块级进度（规格 6.3），只在终态输出一行 `transfer-result`（含 `acknowledgementRequired`）；断线有界退避（500ms 起、×2 封顶 8s）；`--wait-timeout` 到点输出 `transfer-wait-paused` 正常退出，durable 进度保留。等待器结束不取消传输；MCP/本机重启后以同一 `transferId` 重挂（VM 实测跨进程续传）。恢复钩子在任务清单之外列出同会话未确认传输并注入 `transfer wait` 重挂模板与"不对同一目标重新 start"指引。

主动取消时，确认传输停止后立即删除尚未提交且不再使用的临时数据，不保留续传窗口；已经提交的正式文件不回滚，取消与提交并发时先核对实际结果（#15 已实施，语义见上节）。此规则不改变意外中断的 3 天临时数据期限。

已确认取消 16 MiB 门槛，不另设统一文件体积上限。读取与搜索受返回量和执行预算限制，写入与传输还受已定空间额度及实际磁盘空间限制；不得因此采用无界内存、输出或执行。读取侧体积上限与全文哈希已随票据 #9 移除；写侧（编辑与整体覆盖）已随票据 #10 移除并改为流式提交；上传的流式事务已随 #13 实施，下载已随 #14 改为事务化传输（16 MiB 下载上限随之移除）。

完整上传下载采用分块校验支持续传，完成时核对整文件 SHA-256；校验在两端执行，不额外通过网络传输一遍全文。完整性校验不替代源版本稳定性与目标提交冲突检查。详见 [ADR 0009](../adr/0009-resumable-file-transfers.md)。

中断且确认无进程占用的传输临时数据，从最后一次实际传输进展起默认保留 3 天，单纯查询不延长期限。到期按 [ADR 0010](../adr/0010-state-cleanup-lifecycle.md) 的清理机制回收（#16 已实施：远端在传输槽锁内确认无在途块后删除临时文件并注销其账本登记——与 #15 取消同款证据，随后回收记录；本机镜像回收本机接收记录并释放本机 temp 与登记，缺可用 expiresAt 的非终态本机记录保守保留）。之后 resume/status 返回 `REQUEST_EXPIRED_OR_UNKNOWN`，明确不可续传、需重新注册传输。该期限不适用于正在使用的临时文件，小型传输记录（已确认 30 天/未确认终态 30 天）另按「生命周期与回收」节执行。

### 搜索忽略规则（2026-09-13 已实施，票据 #11）

- `remote_search` 默认不按 `.gitignore` 排除候选文件（`respectGitignore=false`），保留搜索生成网表等被 Git 忽略内容的能力；显式传 `respectGitignore=true` 才启用层级 `.gitignore` 过滤。语义子集（纯标准库自写）：否定规则、目录规则（尾 `/`）、转义（`\#`、`\!`、`\ `）、锚定与 basename 模式、嵌套 `.gitignore` 深层覆盖浅层、被忽略父目录不能通过否定重新包含子文件。不读全局 ignore 或其他 `.ignore` 文件。
- 默认包含点开头的文件和目录（`includeHidden=true`），可显式关闭；`.git/` 内部始终排除——递归枚举剪枝，显式指定 `.git` 内路径也拒绝（`PATH_NOT_ALLOWED`）。隐藏按名称点前缀定义。
- 三个后端共用同一候选筛选器（同一排序后的文件列表），后端选择不能隐式改变过滤结果。
- 本项不解除路径访问限制、二进制处理和结果预算。

### 内容搜索后端（2026-09-13 已实施，票据 #11）

| 远端操作系统 | 按可用性选择的优先顺序 |
|---|---|
| Linux | rg → GNU grep → Python 分块搜索 |
| Windows | rg → GNU grep → Python 分块搜索 → Windows PowerShell Select-String（未实施，见 #4） |

- 在执行搜索的远端用 `shutil.which` 检测实际可用性，不假定远端已装某工具。当前实现细节：
  - **统一语义**：字面量、大小写敏感、UTF-8、按字节匹配；`\n` 分行（`\r` 保留在行内）；pattern 含换行或 NUL 报 `INVALID_PATTERN`。外部后端以受控 stdin 流接收行对齐数据块（`-F -a -n`，pattern 经 argv 单参数传递，不拼接 Shell 文本），argv 以 bytes 传递、与远端 locale 无关（无 LANG/LC_* 的 exec 通道下 Python 3.6 的 ascii filesystem encoding 不影响中文 pattern 与路径），行号与字节位置由 helper 侧映射，三后端命中集合一致。
  - **大小文件路径**：≥1 MiB 的文件走外部后端；更小的文件直接用内建扫描（避免每文件 fork 开销）。`engine` 字段报告本页实际使用的后端；外部后端全部失败时如实报告 `python-literal`。
  - **崩溃不当无匹配**：外部进程退出码 >1 或被信号杀死时，撤销该文件已产出命中、当页计数 `fallbackFiles+1`、文件改用内建扫描重扫；连续 3 个文件失败后本页剩余文件全部内建。
  - **跳过摘要**：NUL 字节或 UTF-8 解码失败的文件计入 `skippedFiles`（`skippedDetail` 分 binary/encoding/io），不静默消失。超过 8 MiB 无换行的超长行按 1 MiB 片段加 `len(pattern)-1` 字节重叠报告，跨片段匹配不遗漏（重叠区命中极罕见地可能重复报告，行标记 `lineTruncated`）。
- 能力上报：`file_workspace` 的 `capabilities.searchEngine` 报最高可用后端，`searchBackends` 报有序可用列表（`python-literal` 恒在），`findEngine`/`findBackends` 报文件名查找后端（见下节），`gitignoreSearch: true`，并附默认扫描预算字段。

### 文件名查找后端与过滤（2026-09-13 已实施，票据 #12）

- **后端选择**：`remote_find` 的枚举按可用性取 rg → Python 遍历；**grep 不用于文件名枚举**（仅有 grep 的主机走 `python-walk` 且不调用 grep）。rg 存在时以 argv 列表执行 `rg --files --hidden --no-ignore --no-messages -0 -- <root>`：`--hidden`/`--no-ignore` 关闭 rg 自身的隐藏与忽略默认行为（公共筛选器是唯一裁决者），根路径作为单个参数传递、NUL 分隔增量读取，扫描时限与候选硬顶约束该进程。
- **结果不依赖后端**：rg 只提供文件条目；目录、符号链接等条目由 Python 骨架遍历（同一筛选规则、跳过普通文件）补齐，两路归并为一条全局按路径排序的流并去重。rg 崩溃或无法启动时本页回退纯 Python 遍历（不能冒充空树），`engine` 如实报本页实际使用的 `ripgrep-files` 或 `python-walk`。骨架遍历惰性产出（每目录排序的 k 路归并），预算中断留下的必然是真排序前缀。
- **glob 契约保持**：模式继续按 basename 或相对路径 `fnmatch` 匹配，条目仍为 `{path, type, size}`，顺序仍为全局路径排序；`file_list` 既有行为不变（非递归、摘要游标、无 engine 字段）。
- **过滤对齐 search**：`includeHidden` 默认 true、`respectGitignore` 默认 false，语义与 `remote_search` 完全同一（层级 .gitignore、被忽略父目录不能复活子文件、嵌套否定）；`.git` 内部始终排除，显式指定 `.git` 内路径拒绝 `PATH_NOT_ALLOWED`。
- **分页与预算**：复用 #11 机制——`limit` 与每页 64 KiB 结果预算（`RESULT_LIMIT`）；`scanBudgetBytes` 按本页新考虑候选的路径字节记账（已返回条目续页跳过不计费，保证小预算也能推进），`scanBudgetSeconds` 约束枚举（rg 读取与遍历共用时限）；预算耗尽返回 `truncated`、`reason`（`SCAN_BYTE_LIMIT`/`SCAN_TIME_LIMIT`）与可续游标，从最后考虑的候选之后继续，不重扫已返回条目；枚举阶段（含 rg `--files` 读取）耗尽同样返回 partial 与重启游标，不冒充 HELPER_ERROR；**续页在"跳过已返回候选"阶段就耗尽时间预算（游标零推进，重试必在同一位置再超时）时返回明确的 `SCAN_TIME_LIMIT` 错误**，指引缩小目录而非同游标 partial；枚举自然完成才报告 `totalEntries`（partial 页为 null，不冒充完整计数）。50000 候选硬顶（`SCAN_LIMIT`）保留。
- **游标**：绑定工作区、会话、根路径、模式、隐藏/忽略开关与预算参数；查询变化返回 `STALE_CURSOR`。目录枚举是尽力快照（规格 5.2），翻页期间目录增删不触发检测，需要新查询。

**未实测边界**：上述行为已在 WSL（假 rg 枚举后端 + 真实 Python 遍历）自动化验证；CentOS 7 VM 无 rg，仅实测 `python-walk` 路径。真实 ripgrep 二进制的 `--files` 输出顺序与旗标行为未经自动化覆盖（实现按路径排序后消费，不依赖其输出顺序）；最终内网离线现场验收仍未完成，见 usage/progress。

### 搜索分页与预算（2026-09-13 已实施，票据 #11）

- 每页序列化结果上限 64 KiB（`limit` 条数与字节预算任一满即停，`reason=RESULT_LIMIT`）；默认扫描预算 512 MiB / 10 秒（`reason=SCAN_BYTE_LIMIT` / `SCAN_TIME_LIMIT`；请求可用 `scanBudgetBytes`（64 KiB–2 GiB）、`scanBudgetSeconds`（1–60）钳制内覆盖，该两参数参与游标绑定；#18 policy 合入后改由配置提供）。预算按读取字节记账，单页最多超出一个读取块，小预算也能逐页推进。**无单文件大小排除，200 MiB 网表可搜索**。
- 预算或页满耗尽返回 `truncated=true`、`reason` 与 `nextCursor`，不冒充"没有匹配"；无匹配且扫完返回 `truncated=false, matches=[]`。
- 游标（base64 JSON）绑定查询串、文件名过滤、隐藏/ignore 开关、预算参数与**候选文件列表摘要**：列表变化（目录增删文件）→ `STALE_CURSOR`，需新查询；续扫文件版本（stat 元数据哈希）变化 → `CURSOR_CONFLICT`。已扫完的文件不再重扫（按候选列表位置跳过）；当前文件按字节/行位置续扫，回退锚点保证不丢已见未留的命中，行号过滤保证不重复。跨文件目录是尽力枚举，不承诺快照。
- 喂给扫描进程的输入流带背压（selectors 事件驱动读写，单行输出缓冲有界）；超时后强杀子进程时游标回退到最后一个已喂块，不越过被丢弃的输出。
- 搜索结果不签发 readToken；Agent 仍须 remote_read 目标片段。

**未实测边界**：上述行为已在 WSL（真 GNU grep + 假 rg/假 grep 后端）与 CentOS 7 VM（GNU grep 降级路径）自动化验证；最终内网离线现场验收仍未完成，见 usage/progress。

### 读取与版本（2026-09-13 票据 #9 实施后的当前行为）

readToken 的 3 天闲置过期判定随 #9 实施：连续 3 天没有成功的相关读取或编辑即过期（`READ_TOKEN_EXPIRED`），成功的相关操作续期；查询、失败操作和其他文件的操作不续期。过期即拒绝使用，且过期后的新读取不继承旧已读范围（旧凭据不会被合并复活）；过期记录文件与其会话路径索引的物理回收已随 #17 实施（见「生命周期与回收」），回收后的旧凭据按 `READ_REQUIRED`（记录不可用）拒绝，重读所需片段即恢复编辑且旧已读范围保持失效。文件外部变化仍立即使旧凭据失效（`FILE_CONFLICT`），服务成功编辑后的合法新凭据继续按映射规则处理。详见 [ADR 0010](../adr/0010-state-cleanup-lifecycle.md)。

- 版本由服务从 Linux 元数据（设备号、inode、文件大小、mtime_ns、ctime_ns）生成，字符串带 `m1-` 方案前缀；不再计算全文摘要。所有版本均由服务签发与核对，绑定当前工作区与解析后的规范路径（读取前后核对描述符与路径仍指向同一对象）。读取凭据由服务签发并校验，记录工作区、文件身份、版本、实际交付范围、调用作用域与到期时间。Agent 自填哈希或仅执行一次 `stat`（含 metadataOnly 观察本身）不算已经读取。
- 读取无文件体积上限：内容按 256 KiB 流式缓冲交付，文本输出序列化后控制在 56 KiB 内，`maxBytes`（1..1048576）是返回预算而非文件大小上限。读取不存在的路径返回 `PATH_NOT_FOUND`。
- `metadataOnly=true` 只接受路径（与观察无关的 `offset`/`fromLine`/`toLine`/`maxBytes`/`encoding`/`expectedVersion`/`readToken` 出现即 `INVALID_REQUEST`），返回服务观察的目标版本或明确的不存在状态（`exists=false`、`version=null`，存在时附 `size` 与 BOM 判定），不返回内容、不签发读取凭据；供 remote_write/上传的覆盖前置检查使用（#10 消费）。
- 按行请求（行边界以 LF 定义）从文件头顺序扫描定位，行号不能当字节偏移使用；不回传窗口之前的内容、不缓存全文、不建立永久行索引。行模式返回 `lineStart`/`lineEnd`/`lineEndComplete`；超长行按预算分块交付，续读用 `nextOffset` 字节游标。文本输出不切断 UTF-8 多字节字符；BOM 字节计入已读范围但不进入交付文本；`newline` 按交付窗口计算（窗口无换行时为 null），CRLF 信息保留。
- 字节游标（`offset`/`nextOffset`）可带可选 `expectedVersion`：与当前观察版本不符时返回 `FILE_CONFLICT`，拒绝在变化后的文件上续用旧游标。不带预期版本的续读会观察到新版本；旧凭据不会静默延伸到新版本。
- 交付窗口内的无效 UTF-8 明确报 `UNSUPPORTED_ENCODING`（提示改用 base64）；`offset` 落在多字节字符中间报 `INVALID_OFFSET`。
- 分段读取可在同一版本下累计范围。局部编辑须覆盖其匹配文本（#10 起匹配按字节区间判定，跨流式分块边界同样生效）；整文件覆盖已改为显式版本绑定（见「写入提交」），删除、移动仍要求完整已知范围并保留 16 MiB 快照边界（待 #20/#13）。外部修改后原凭据失效，不继承旧范围；本服务确认的精确编辑按下条续期。
- 工具输出被截断的部分不视为交付（仅实际交付字节计入凭据范围，零前进请求报 `INVALID_LIMIT`）。MCP 工具负责自己返回范围的真实性；无法证明模型在语义上理解了这些内容，也无法感知客户端在工具之外再次裁剪输出。
- `remote_edit` 成功后返回新的 `readToken`、`version`、`size`、`complete` 与 `rereadRequired=false`。工具按实际 UTF-8/BOM/CRLF 字节变化映射原已读区间，并将调用者提供的替换文本视为已知；未读间隔不被授予资格。后续使用新凭据可继续编辑，无需再次 read，旧凭据仍失效。
- 续期前核对写入后的实际内容与文件身份，不为未确认的外部内容签发凭据。若写入已完成，但提交后发生冲突或凭据存储失败，返回 `written=true`、`readToken=null`、`rereadRequired=true` 及原因；调用方须读取当前文件，不能把它当成未写入而盲目重复编辑。
- 该续期规则仅适用于精确编辑。`write/upload/delete/move` 不因成功自动签发新凭据，也不把整文件隐藏读取当成调用方已读；`download` 走 `grantRead=false` 传输路径，不签发凭据也不受 56 KiB 文本预算约束（每块仍受调用方 `maxBytes` 约束）。
- 文本编辑支持 UTF-8（含 BOM）与原换行保留；无法可靠解码的文件拒绝文本编辑，仍可传输。二进制覆盖如需先读保护，通过 base64 读取模式交付内容，不能以元数据冒充内容读取。
- `file_workspace` 能力上报相应调整：`maxGuardedFileBytes` 移除，新增 `streamedRead=true`、`streamedWrite=true`（写侧流式匹配与拼接，编辑/覆盖无体积上限）与 `readTokenTtlDays=3`；`maxCommitBytes` 已随 #10 移除。

### 写入提交

2026-09-13 票据 #8 已实施固定锁槽（WSL Python 套件与 VM 套件实测，内网现场未验收）：远端文件协作锁使用默认 256 个固定锁槽（`<状态根>/file-locks/slot-000…255`），按目标稳定标识（解析后路径字符串）哈希映射复用；不同目标可能共享槽而排队。多目标操作（如 move）对实际槽位去重并按槽号升序统一获取；槽文件使用期间不删除重建。从旧 per-path 锁到固定槽是一次性协议切换，以 `<状态根>/file-locks/slots.json` 标记；切换前逐一探测现存旧锁文件，任何一把仍被持有时以 `LOCK_SWITCH_BLOCKED` 拒绝切换（升级流程先停旧客户端排空，探测无法发现切换瞬间新启动的旧进程，属升级步骤约束）。锁序约定：槽锁（资源锁）可先于空间账本锁获取，禁止反向；切换锁独立且仅做非阻塞探测。

2026-09-13 票据 #8 已实施临时资源登记（实测范围同上）：编辑/写入的提交临时文件先在两端资源账本登记（路径、对象身份 dev:ino、归属、持有进程 PID+boot 起始身份、字节量），登记通过额度检查后才创建文件——临时文件不存在未登记即可被遗留的窗口；提交成功即注销登记，正式目标随之移出空间计量。占用核实证据由 `resource_inspect` 提供：持有进程存活（PID+启动身份，PID 重用不冒充持有者）、路径存在性与对象身份匹配；时间过旧不作为判断依据。崩溃遗留登记与残留文件的周期回收已随 #17 实施（见「生命周期与回收」）：维护轮按账本归属、对象身份与占用证据三重核实后删除并注销；无法核实的保留最小管理信息；无账本归属的文件不触碰。

2026-09-13 票据 #10 已实施流式精确替换与显式版本覆盖（WSL Python 套件、npm test 与 VM 套件实测，内网现场未验收）：

- **编辑路径无体积上限**：oldText 匹配改为对整个文件的分块字节扫描（256 KiB 块、携带跨块尾部），语义与首版全文匹配一致——恰好一次方可编辑，零匹配返回 `EDIT_MATCH_ERROR` 并提示重读，多匹配同样拒绝并要求扩大 oldText；完整匹配的字节区间必须落在 readToken 已交付范围内（跨块边界的匹配同样受已读保护）。UTF-8 自同步性保证字节级区间等价于原全文文本匹配；同一遍扫描完成全文 UTF-8 校验（文本编辑继续拒绝二进制目标）与换行普查（CRLF 保留）。
- **流式原子提交**：变长替换不再重组全文，而是按排序后的替换区间把源文件分块复制进已登记的同目录临时文件、在区间处拼接新字节；磁盘 I/O 与网络传输都只经过有界缓冲。多项替换全部定位成功后才写临时文件，任一项失败（歧义、未读、重叠）不产生部分提交；写入并 fsync 后在锁内复核版本，再原子替换并 fsync 目标目录（补上 #6 遗留的目录条目持久化缺口），任一失败保留原目标。成功编辑的凭据续期沿用区间重映射（后像验证改为身份+大小核对）；失败续签仍明确报告已提交。
- **整体覆盖显式化（ADR 0008）**：`file_write` 默认 create-only——目标存在而无 `overwrite=true` 时拒绝（`FILE_CONFLICT`，消息指引覆盖流程）；覆盖必须 `overwrite=true` 加 `expectedVersion`（metadataOnly 观察版本），二者缺一或与其他参数矛盾返回 `INVALID_REQUEST`；提交前复核版本，外部变化拒绝；创建与覆盖互斥，`readToken` 不再是 write 的参数（helper 层出现即拒绝，MCP schema 已不声明）。覆盖无需旧全文已读；文本覆盖保留 BOM/CRLF 并要求旧内容可解码（分块校验），base64 覆盖无此要求；权限与属组保留。局部编辑的已读区间保护不变。**inline 内容（text/base64 解码后）受 16 MiB 请求预算约束（规格 4.3）**：超出返回 `FILE_TOO_LARGE` 并指引改走 `remote_upload`；恰好 16 MiB 允许，编辑路径（oldText/newText）不受此门，MCP schema 层另有 64 MiB 字符粗防。写入已提交（原子替换完成）后的簿记失败（目录 fsync、账本注销）不掩盖已提交事实：报 `COMMITTED_UNCONFIRMED` 说明已写入与失败原因，调用方须重读当前文件、不得当未写入盲重试。
- 上传（`remote_upload`）沿用同一覆盖语义：覆盖已有远端目标同样走 `overwrite` + `expectedVersion`（register 早检 + commit 锁内复核）；自 #13 起上传整体改为可续传的流式传输事务（见「大文件传输恢复」一节），16 MiB 本机读取边界已移除，任意大小受两端空间额度约束。
- 临时文件登记量按流式输出的精确字节数（原大小减去被替换区间加新字节）计算，额度检查随登记在账本锁内完成；删除/移动仍走首版 16 MiB 快照路径。

普通临时文件回收规则已随 #17 落实并锁定：操作成功或明确失败后，本服务立即删除不再需要的临时文件并注销登记（编辑、写入与传输各路径在 #8/#10/#13–#15 已即时清理，#17 以行为测试锁定"无成功后残留"）；崩溃残留的登记与文件在下一轮维护按归属、对象身份与占用证据核实后清理，不额外保留数天——可核实的立即回收，未知占用的只保留最小管理信息。断点续传临时数据仍按 3 天期限处理，提交结果不明确时先核对状态；不清理用户命令自行生成的文件（无账本归属的文件永不触碰）。详见 [ADR 0010](../adr/0010-state-cleanup-lifecycle.md)。

新内容先写入目标所在文件系统的临时文件，再进入远端协作锁：核对目标身份与预期版本，保留支持的权限位，提交变更。创建和“目标必须不存在”的移动采用不会覆盖已出现目标的操作，不使用先判断后无条件覆盖的降级实现。

本服务的并发写入互相协调；任何阶段冲突必须保留原目标，返回 `FILE_CONFLICT`。临时文件清理只能作用于本次操作明确拥有的文件。跨文件系统移动拒绝并解释，不能悄然变成复制后删除。

**保证边界**：版本检查发现不一致就拒绝；协作锁保护本服务的校验与提交。对不遵守锁的外部进程，不承诺完全消除校验与替换间的竞争；也不证明文件历史上从未被改动后恢复。此边界不以“原子替换”掩盖。

## 命令入口

ZCode 的默认路径是：用原生后台 Shell 调用本机任务命令入口。主要参数为工作区、命令、工作目录、环境、归属信息和可选执行上限。程序在同一次运行中完成登记、启动与等待；后台管理由 ZCode 工具调用方式完成。

归属信息必须来自已验证的 ZCode 会话/工作区接入，不由模型猜测会话编号。第一阶段确定其获取方式；未完成绑定的任务不得宣称支持回传原对话。

MCP 提供查询、列举、读日志、短时等待和取消能力。若另行暴露直接启动接口，必须明确其完成跟进方式，不能用裸任务编号作为默认后台体验。旧的同步命令接口不承担新的持久任务保证。

### 启动与身份

- 启动前在本机持久记录请求标识、任务标识、配置身份及命令摘要，再向远端提交。
- 远端用请求标识和参数摘要去重。同一请求参数相同返回原任务；参数不同返回冲突。
- 远端执行任务前保存运行意图。若启动确认丢失，先核对原记录，不盲目启动第二份。
- 如果进程已经启动但状态记录不完整，进入核对/未知状态；不能仅凭超时推断“没有执行”。无法安全证明时向 Agent 返回状态未知，避免重复副作用。
- 命令标准输入默认关闭、默认无 PTY。一次命令内支持用户需要的 Shell 语法；不同任务不共享隐式 `cd` / `export` 状态。

### 登记后执行与协议切换（2026-09-13 实施，VM 已验证）

任务创建采用登记后执行协议（helper 协议版本 2，规格第 6.1、9 节）。创建是单独的显式动作：远端先持久化登记记录（`registration.json`）并分配任务标识，之后执行、重试、跟进只接受已登记标识；标识由远端分配，调用方不能自带，因此同一旧标识无法重新创建任务。

- 动作：`handshake`（幂等激活协议）、`task_register`（登记并分配标识）、`task_start`（执行已登记任务）。三个动作都要求显式 `protocol: 2` 字段，缺失返回 `INVALID_PROTOCOL`。
- `task_start` 找不到登记记录（含记录已被清理删除）一律返回 `REQUEST_EXPIRED_OR_UNKNOWN`，不走创建分支；重复 `task_start`（含启动响应丢失后的重试）按登记幂等，同一登记至多执行一次。
- 登记成功但从未启动的记录可观察为 `prepared` 状态；登记期参数校验失败（`INVALID_COMMAND` / `INVALID_ENV` / `INVALID_TIMEOUT` / `INVALID_LIMIT`）不产生任何本地或远端任务记录，错误原样透传。启动期工作目录缺失（`INVALID_CWD`）与远端记录消失（`REQUEST_EXPIRED_OR_UNKNOWN`）落本地 `rejected.json` 并归类 `START_REJECTED`，可按既有流程确认。
- 版本握手与排空门槛：升级时旧入口 `start` 在协议激活前仍可创建任务（升级窗口），激活后仅保留对已存在任务的幂等观察重放，创建一律拒绝 `PROTOCOL_UPGRADE_REQUIRED`。存在未达终态的旧协议任务时，握手与登记返回 `LEGACY_TASKS_PENDING` 并列出阻塞标识，不静默强杀；旧任务保持可查询、可取消、可确认。激活检查与旧入口创建经同一固定协议锁串行，两种协议不会同时接收新写入。
- 本机跟进记录新增 `protocol: 2` 标记区分新旧任务：协议任务的对账重放走 `task_start`（仅携带标识）；无标记的旧记录继续按旧入口形状重放。旧任务记录迁移与到期回收不在本契约段（见 #20、#16）。

### 数据与状态

| 记录 | 最低内容 |
|---|---|
| 远端任务记录 | 格式版本、工作区身份、请求/任务标识、命令摘要、工作目录、时间、执行器类型、受管理进程身份、日志位置、最终退出结果 |
| 本机跟进记录 | 格式版本、任务标识、真实远端身份、原对话/工作区绑定、日志游标、后台等待登记情况、待处理完成事件 |
| 完成事件 | 稳定事件标识、任务标识、退出结果、日志摘要/位置、投递与确认状态 |

任务生命周期：`prepared（仅协议任务，登记未执行）→ starting → running → exited / cancelled / interrupted`。另有状态核对结果 `unknown`；网络连接状态独立记录，断线不能把 `running` 直接改成失败。`exited` 保留实际退出码和信号，退出码非零不等于传输失败。

远端日志和结束记录为执行事实依据；本机记录不覆盖远端执行事实。记录更新使用可恢复的文件操作，格式带版本；每项任务独立存放，避免并发改写同一个全局 JSON。状态记录和写入权限限制在用户私有目录。

### 超时与取消

- `waitTimeout` 仅结束本次等待并返回当前状态，不杀远端进程。
- `executionTimeout` 是显式的远端任务执行上限；未设定时不沿用上游 30 秒命令超时自动终止任务。
- 本机 Shell 退出、MCP 重启或 SSH 断开都不是取消指令。
- 取消首先验证任务的进程身份，再对受管理进程组请求终止；宽限期后按策略升级，并核对实际结果。不能只依赖可复用 PID，也不能将“发出信号”当成“已经终止”。
- 取消与自然结束竞争时返回核实后的事实。主动逃离受管理进程组的程序不承诺全面回收，需在结果中区分控制范围。

### 日志与大输出

 stdout 与 stderr 在非 PTY 模式下分开保存和读取，各自拥有稳定字节游标；不能假定两路记录给出严格总时间顺序。读取返回内容、下一游标、当前是否到尾、任务是否结束及截断状态。

工具返回默认最多 64 KiB，可配置但必须有硬上限。返回上限不直接终止任务。远端存储上限独立配置；不得静默丢弃日志。首版默认每任务日志合计上限 256 MiB，达到上限后请求停止受管理任务并报告 `OUTPUT_LIMIT`；写入前按剩余额度裁剪，结果明确标注日志截断。

运行中任务和未确认完成结果不自动清理。终态且已确认的任务日志自确认起默认保留 3 天（`retention.confirmedTaskLogMs`）后清理，清理只删除本工作区明确拥有的任务目录内的日志，保留轻量去重记录（request/registration/state/claim）防止旧请求再次执行；任务与传输的结果记录按 30 天期限回收（见下节）。保留期与配额可配置。上文的 7 天保留值仅指首版手动 `cleanup` 动作（`retentionDays` 参数）的默认值，自动维护不使用该值。

`rg` 无匹配时原样返回其命令退出结果，提示没有匹配不等于 SSH 错误。命令输出按非可信数据处理，不能当成新的系统指令。

### 生命周期与回收（2026-09-13 票据 #16、#17 已实施）

按 [ADR 0010](../adr/0010-state-cleanup-lifecycle.md) 与规格 7.1/7.2 实施两级触发与四类期限，#17 在同一轮次内追加凭据、helper 与遗留临时三类：

- **触发**：懒清理挂在查询类 helper 动作上（status/output/transfer_status/file_read/file_list/file_find/file_search，在返回请求自身结果之后执行，失败不影响查询），60 秒节流；每小时在线维护由本机驱动——工作区 MCP 每个工具调用与 job CLI 每次运行触发 `maybeMaintain`（`pending` 保持离线安全查询不触发），按 `policy.maintenance.intervalMs`（默认 1 小时）节流，`ssh-mcp-job maintain` 可显式执行一轮。`lastCompletedAt` 持久化在本机 identity 目录：进程退出或 SSH 断连期间的到期数据在下一次触发（重连后首个操作）补做清理，无远端守护进程或 cron。
- **互斥与预算**：远端一轮持有 `<状态根>/locks/maintenance` flock（非阻塞，拿不到返回 `skipped:busy`），逐项持久化游标（jobs/transfers/reads/helpers/资源登记各自的名字序游标，预算中断下轮续扫，扫到头重置），每轮项数与时长双预算（默认 100 项/2 秒，`policy.maintenance` 可配，五段共享同一预算）。本机一轮同样有双预算，`maintenance.lock`（记录持有 pid，仅核实死亡才夺回）跨进程互斥。删除任务目录持该任务锁、删除传输目录持其传输槽锁（与 #15 取消同款"无在途块"证据），拿不到锁的条目本轮跳过；资源登记的回收逐项持账本锁（maintenance 锁 → 账本锁方向，符合槽锁先于账本锁的锁序）。
- **期限**（全部可经请求覆盖 > 远端 policy.json 的 retentionMs 节 > 规格默认；加速时钟 `SSH_MCP_TEST_CLOCK` 用于期限判定）：已确认任务日志自 ack 起 3 天（删 stdout/stderr/launcher.log 并写 purged.json，dedup 记录保留）；已确认任务/传输结果记录自 ack 起 30 天（整目录回收）；已结束未确认结果自 completedAt 起 30 天（整目录回收，含日志）；unknown 形态任务（starting 卡死/worker 消失的观察结论）自**首次观察**起 30 天——首次维护写入 `unknown.json` 仅记一次，查询与核实失败不续期；中断传输数据自最后实际进展（无进展则注册时刻）起 3 天。
- **读取凭据回收（#17）**：`<状态根>/reads/` 下过期（`now > expiresAt`，与读取路径 `READ_TOKEN_EXPIRED` 判定同时钟、同语义——晚到的成功操作不复活已过期记录）的 `<32hex>.json` 凭据记录被物理删除，指向已删或已过期凭据的 `index-*.json` 会话路径索引同轮回收（名字序保证凭据先于索引处理，悬空索引不留到下轮；grant_read 对悬空索引本就按首读处理）。回收后旧凭据编辑按 `READ_REQUIRED`（记录不可用）拒绝；重读所需片段签发只覆盖新窗口的新凭据，旧已读范围不复活。
- **helper 镜像回收（#17）**：远端 helpers/ 按「当前运行版本 + 活动依赖」保留——正在执行维护的 helper 自身所在镜像目录即当前版本；活动依赖以 /proc 命令行证据核实：运行中任务 worker（以 `<镜像>/agent.py --root … _worker` 形式 spawn）、并发 helper 调用与镜像安装进程（目标路径作为 argv）都会出现在 cmdline 中。两者之外的 64-hex 镜像目录在维护轮删除；非 64-hex 命名的目录不是本服务镜像，永不触碰。已知边界：升级窗口内仍在运行的旧版本客户端进程若此刻恰无在途调用，其镜像可能被回收，该进程后续调用将报 `HELPER_EXECUTION_FAILED`，重启进程即自愈（安装幂等重装）；按 #7/#20 的升级纪律应先停旧客户端再切换。
- **遗留临时资源回收（#17）**：维护轮遍历两端资源账本，逐项三重核实——归属（账本登记本身）、占用（持有进程 PID+boot 启动身份；PID 重用不冒充、年龄不参与判定）、对象身份（路径现存对象与登记的 dev:ino 匹配）。持有者存活 → 保留；持有者已死且身份匹配 → 删文件并注销登记；文件已不存在或名字处已是别的对象 → 仅注销登记（外来文件不删）；持有身份从未锚定或对象身份从未附加 → 未知占用，登记与文件原样保留（登记只含路径/身份/归属/占用证据/字节量等最小管理字段，不含任何结果正文，字节量继续计入额度）。无账本归属的文件（哪怕叫 `.ssh-mcp-*`）永不触碰。
- **回收后拒绝**：记录删除后旧标识不再落入任何创建分支——`task_start` 报 `REQUEST_EXPIRED_OR_UNKNOWN`，传输各动作经 `_load_record` 同码拒绝；登记后执行协议（#7）保证这一点，#16 的验收即覆盖"回收后重放被拒"。legacy（v1）任务记录仅在 v2 协议激活后删除：未激活工作区的 v1 记录只清日志不删记录，避免升级窗口内旧请求经 legacy start 重跑。
- **不做**：空间用量汇总（#19）、prepared 任务登记（规格未设期限，不回收）。
- **unknown 记录**：远端 unknown.json 与本机 rejected/unstarted 登记遵循上述期限；结果未知的任务或传输先查询原操作，不自动重跑或再次覆盖；到期停止自动恢复并删除结果详情、诊断与恢复记录，提示记录已过期、需人工核对实际结果；删除后旧请求仍拒绝。该期限不代表操作已失败或停止，不删除正式文件。

### 状态与临时数据的空间额度（2026-09-13 票据 #8 部分实施；#16 接入日志额度与每操作重读）

2026-09-13 票据 #8 已实施两端跨进程空间账本（WSL Python 套件、npm test 与 VM 套件实测，内网现场未验收）：默认每个工作区在本机和远端各有独立的 10 GiB 空间上限。计量口径 `used = 状态目录扫描 + 已登记临时资源 + 未消费预留`：状态扫描覆盖状态根下状态、日志、辅助程序、锁等本服务数据（排除账本自身目录，避免计量工具自引用抖动）；目标目录旁的编辑/下载/续传临时文件经资源登记计入；正式工程文件与提交后的目标文件不计入（提交注销登记即移出）。登记引用预留时按同量扣减，预留与已写占用不双重计数；预留与登记都在账本互斥锁内完成"检查额度-入账"，跨进程并发预留不超额。

- 远端落盘：`<状态根>/ledger/{ledger.json, ledger.lock}`，额度覆盖文件 `<状态根>/ledger/policy.json`（`{"spaceLimitBytes": N}`，每次操作重新加载）。
- 本机落盘：`<localStateDir>/<sha256(identity)[:24]>/ledger/{ledger.json, ledger.lock}`，额度来自 profile 统一 policy 节 `limits.localWorkspaceBytes`（#18 schema，缺省 10 GiB；#16 起每次额度检查经 loadPolicy 重读，保存的变更下一操作生效，无需重启）；远端 policy.json 下发接入统一 policy 属后续票据。
- 本机账本锁为独占创建文件记录持有 pid，仅当持有进程确认死亡才夺回，不因超时回收活动预留（活动预留的核实回收属 #16）。
- 失败码：额度不足 `WORKSPACE_QUOTA_EXCEEDED`（拒绝新占用并说明 used/limit/requesting）；物理写满 `STORAGE_FULL`（ENOSPC 映射，含账本自身持久化失败）；本机账本被持续占用 `LEDGER_BUSY`（可重试）；`RESOURCE_NOT_FOUND`、`INVALID_POLICY`、`LEDGER_UNAVAILABLE`。
- 远端 helper 公共动作（非 MCP 工具）：`resource_reserve / resource_release / resource_register / resource_forget / resource_inspect / resource_usage`，供 #10 提交前预留、#13 传输预留、#17 回收核实与 #19 用量汇总复用。

空间不足时先清理已过期且可安全回收的数据（#16 已实施任务/传输记录与已确认日志按上节期限回收；#17 起账本遗留登记与核实过的崩溃残留临时文件同样在维护轮回收，未知占用的登记保留待核实），仍不足则拒绝新增占用并报告原因，不提前删除未到期续传数据、未确认结果或正在使用的文件。任务和传输启动前检查并预留额度（已知大小的编辑/写入提交与下载已在 #8 接入；传输启动前预留属 #13）。任务日志是未知增量：worker 每写满 1 MiB 经 `ledger.usage` 复查工作区额度，耗尽后停止保存新日志、置 `outputTruncated=true` 并记 `reason=STORAGE_LIMIT`，继续排空输出管道避免阻塞子进程（不杀任务，命令照常跑完），额度工具故障时保守继续写；输出丢失不伪装完整——截断状态随状态返回。额度预留不承诺排除外部程序导致的磁盘不足或其他写入失败，详见 [ADR 0010](../adr/0010-state-cleanup-lifecycle.md)。

## 完成回传与恢复

辅助程序回收规则已随 #17 实施（规格 7.1/ADR 0010）：远端 helpers/ 仅保留当前运行版本及 /proc 命令行仍引用的活动版本（运行中任务 worker、并发调用与安装进程都构成引用证据），其余镜像在下一轮维护清理；非镜像命名的目录不受影响。回退需从对应本机离线包重新部署（安装幂等，重启旧客户端进程即自愈）；回收不触碰活动任务或连接正在使用的镜像。已知边界：升级窗口内恰无在途调用的旧版本客户端进程，其镜像可能被回收并使该进程后续调用报 `HELPER_EXECUTION_FAILED`——升级纪律要求先停旧客户端再切换（#7/#20）。

1. 正常连接时，本机等待程序获取远端结束记录，输出有界结果并退出，由 ZCode 原生后台机制继续原对话。
2. SSH 中断时，程序进行有界退避重连；远端任务持续。重连后读取原任务，不重新执行命令。
3. 本机进程或 ZCode 退出时，远端继续，本机持久记录保留。用户继续原对话时，UserPromptSubmit 恢复钩子提供真实挂起任务/未处理结果，Agent 重新登记原任务等待并处理待发结果；不要求仅启动应用就自行唤醒。
4. 结果使用稳定事件标识；采用可重复投递、消费端去重的方式恢复，不宣称网络和模型操作“恰好一次”。仅打印到 stdout 不等于模型已处理，确认必须来自已验证的接入步骤。
5. 如果原对话已删除或不可恢复，任务保留为未认领并显式报告，不将结果自动发送给另一个无关对话。

第 3–4 项已用真实 ZCode 运行时、正式任务服务、正式恢复钩子与 SSH 持久任务完成受控模型集成验证。用户于 2026-09-11 另报告真实 ZCode 桌面人工验收通过：钩子注入、重启存活、原任务 wait 挂接、无重复执行、结果确认均符合预期，详见 progress.md。最终内网离线部署尚未现场验收。

## 扩展位置

远端执行器只负责启动、观察和控制任务；任务身份、日志接口、跟进与文件服务独立。能力结果显式包含是否支持输入、PTY 和重附着；首版均不提供交互输入。未来新增输入/EOF/终端尺寸操作，通过新执行器实现，不修改既有任务身份。
