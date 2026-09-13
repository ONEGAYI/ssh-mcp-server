# 实施进展与验证证据

## 2026-09-13 票据 #17：回收过期读取凭据、旧 helper 与遗留临时文件

分支 `ticket/17-credential-reclamation`（基于 f6e21e0），按规格 7.1/7.2 与 ADR 0010 在 #16 的维护框架上扩展三类回收（TDD，先红后绿）：

1. **过期 readToken 物理回收**（`remote/reclaim.py`）：维护轮遍历 `<状态根>/reads/`，`now > expiresAt`（与读取路径 `READ_TOKEN_EXPIRED` 判定同一注入钟、同语义）的凭据记录删除；指向已删/已过期凭据的 `index-*.json` 同轮回收（名字序保证 32hex 凭据先于索引处理，grant_read 对悬空索引本就按首读处理）。回收后旧凭据编辑报 `READ_REQUIRED`；重读所需片段签发只覆盖新窗口的凭据，旧已读范围不复活（#9 判定 + #17 物理回收闭环）。
2. **旧 helper 镜像回收**（`remote/reclaim.py`）：镜像布局为 `<状态根>/helpers/<镜像 sha256>/<模块>.py`；保留集 = 正在执行维护的 helper 自身镜像（`__file__` 父目录名）+ /proc 命令行仍引用的镜像（运行中任务 worker 以 `<镜像>/agent.py … _worker` spawn、并发 helper 调用与安装进程的目标路径都在 cmdline 中）。其余 64-hex 目录整目录删除；非 64-hex 命名目录不是镜像、永不触碰。
3. **遗留临时资源回收**（两端）：按账本归属 + 持有进程（PID+boot 启动身份，年龄不参与判定）+ 对象身份（dev:ino）三重证据核实——持有者存活保留；死亡且身份匹配删文件并注销；文件已不存在或名字处是外来对象仅注销（不删外来文件）；持有身份或对象身份从未锚定为未知占用，登记原样保留（仅最小管理字段、字节量继续计入额度）。无账本归属的文件永不触碰。**由现存传输记录引用的 resourceId 跳过通用回收**——传输 temp 与登记跨多个短命 helper 进程存活（登记时的持有者必然已死），其回收由 #16 传输专属路径（槽锁证据 + 3 天期限）执行；本缺陷由 remote-transfer 套件回归暴露（活跃传输 temp 被懒清理误删）后修正并补锁定用例。
4. **本机侧**（`src/services/maintenance.ts`）：维护轮新增本机账本遗留登记回收（同构判定，本机以 pid 存活为占用证据——Windows 无 boot 锚定，沿用 SpaceLedger 既有局限说明）；同样跳过本机传输记录管理的 resourceId。普通临时文件「成功/确定失败立即清理」为 #8/#10/#13–#15 既有行为，本票以锁定用例固化（编辑+创建后无 `.ssh-mcp-*` 残留、账本清零）。

验证证据（2026-09-13，worktree ticket-17，profile wt17-largefile 与其他 worktree 隔离）：

- WSL Ubuntu / Python 3.12：`remote-reclaim.test.py` 21/21 通过（#17 新增 8 用例实现前 6 error 红——维护摘要无 removedReadTokens/removedHelpers/reclaimedResources 键、1 用例为既有行为锁定直接绿；覆盖凭据回收+重读恢复+旧范围不复活、活动引用与当前镜像保留、非镜像目录不删、崩溃残留核实回收、活动/未知保留与最小字段断言、无归属不删、传输管理登记不被通用回收竞夺、普通临时立即清理）。回归 remote-agent 13、remote-transfer 51、remote-files 44、remote-ledger 12、remote-discovery 27 全 OK。
- Windows Node 24.15：`npm test` 268 项（255 通过、13 门控跳过、0 失败；maintenance-service 新增 3 用例：已死持有者核实回收、活动/未锚定/外来对象/消失文件四分支、传输管理登记保护）。
- CentOS 7.9 VM 真实 SSH（两文件分开串行）：`workspace-mcp-remote.test.js` 5/5；`job-cli-remote.test.js` 8/8（#17 新用例：真实工作区一轮 maintenance 同时回收过期凭据（夹具改 expiresAt 加速，MCP 通道无法注入测试钟）、假 digest 旧镜像与核实过的崩溃残留，断言真镜像不在删除列表、旧凭据 READ_REQUIRED、重读片段恢复编辑且尾部旧范围仍拒绝）。
- 已知边界：升级窗口内恰无在途调用的旧版本客户端进程，其镜像可能被回收，该进程后续调用报 `HELPER_EXECUTION_FAILED`（重启自愈，安装幂等重装；升级纪律先停旧客户端，见 contracts「helper 镜像回收」）；未知占用的登记会一直保留（规格如此：继续核实，不计龄回收）；#19 空间汇总未动。
- 本票尚未由用户人工验收；最终内网离线现场验收仍未完成。

## 2026-09-13 票据 #16：任务与传输结果到期回收且拒绝旧请求

分支 `ticket/16-expiry-reclamation`（基于 073d808），按规格 7.1/7.2 与 ADR 0010 实施（TDD，先红后绿）：

1. **远端回收**（`remote/reclaim.py` 新文件 + `agent.py` 分发 `maintenance` 动作）：期限矩阵——已确认任务日志 ack 后 3 天（purged.json 保留 dedup 记录）；已确认任务/传输记录 ack 后 30 天整目录回收；已结束未确认自 completedAt 起 30 天；unknown 形态任务自**首次观察**起 30 天（`unknown.json` 只写一次，查询不续期）；中断传输数据自最后实际进展（无进展则注册）起 3 天，远端在传输槽锁内确认无在途块后删 temp 并注销账本登记（#15 cancel 同款证据）。每轮 maintenance flock 非阻塞互斥（busy 明确 skipped）、逐项持久游标、项数/时长双预算（默认 100/2s），期限与预算参数可由请求覆盖（本机 loadPolicy 每轮传入）> ledger/policy.json 的 retentionMs/maintenance 节 > 规格默认；判定时钟经 `SSH_MCP_TEST_CLOCK` 注入。legacy v1 任务记录仅在 v2 协议激活后删除（避免升级窗口内旧请求经 legacy start 重跑）。
2. **懒清理**（`agent.py`）：status/output/transfer_status/file_read/file_list/file_find/file_search 七类查询动作在返回结果后顺带触发 60 秒节流的有界清理，失败吞掉不影响查询。
3. **任务日志额度**（`agent.py` worker）：写日志每满 1 MiB 经 `ledger.usage` 复查工作区额度，耗尽后停止保存新日志、记 `STORAGE_LIMIT` 截断原因并继续排空管道（不杀子进程——首版实现曾误把 STORAGE_LIMIT 并入 killpg 理由，由额度测试暴露后修复）；额度工具故障保守继续写。
4. **本机维护**（`src/services/maintenance.ts` 新文件）：`maybeMaintain` 按 `policy.maintenance.intervalMs`（默认 1h）节流，maintenance.lock 跨进程互斥（仅核实持有进程死亡才夺回），每轮先有界回收本机登记（同期限矩阵；非终态传输按记录 expiresAt 过期回收并连本机 temp 与账本登记一起释放，缺 expiresAt 保守保留），再带当轮 loadPolicy 期限调用远端 maintenance；远端失败不写 lastCompletedAt，下次触发自动重试。`lastCompletedAt` 持久化在 identity 目录——离线/退出期间到期数据在重连后首个操作补做。触发点：MCP 每工具调用、job CLI 每次运行（pending 保持离线安全不触发）、`ssh-mcp-job maintain` 显式子命令。
5. **额度每操作重读**（`space-ledger.ts` / `transfer-service.ts`）：SpaceLedger 构造接受固定值或 loader，TransferService 传 `loadPolicy(profilePath)` 的 `limits.localWorkspaceBytes`——保存的 policy 变更下一操作生效（补齐 #8 遗留、contracts 47 段标注的缺口）。

验证证据（2026-09-13，worktree ticket-16，profile wt16-largefile 与其他 worktree 隔离）：

- WSL Ubuntu / Python 3.12：`remote-reclaim.test.py` 13/13 通过（实现前 11 error + 2 fail 红转绿；覆盖 3/30 天加速时钟、unknown 到期删除、回收后重放被拒、查询不续期、预算游标与互斥、懒清理、日志额度截断）；回归 remote-agent 13、remote-transfer 51、remote-files 44、remote-ledger 12 全通过。
- Windows Node 24.15：`npm test` 252 通过 / 0 失败（新增 maintenance-service 6 用例、space-ledger loader 用例；transfer-service fixture 改真实 profile 文件适配每操作重读；曾暴露非终态传输记录缺 expiresAt 被误删的缺陷，已改保守保留并用离线 pending 用例锁定）。
- CentOS 7.9 VM 真实 SSH（两文件分开串行）：`workspace-mcp-remote.test.js` 5/5；`job-cli-remote.test.js` 7/7（#16 新增 3 用例：加速期限下日志层 purged → 记录层回收 → status JOB_NOT_FOUND → task_start 重放 REQUEST_EXPIRED_OR_UNKNOWN 且 marker 仅执行一次；中断传输到期回收后 resume/status 拒绝；CLI maintain 真实两端一轮 + lastCompletedAt 节流——伪造 2 小时前的完成时间戳模拟离线补清理）。
- 已知边界：#17 域（账本遗留登记、无主临时文件、readToken/helper 回收）未动；#19 空间汇总未动；prepared 任务登记规格未设期限、不回收；远端 policy.json 的期限节仅支持手工放置（#18 的 update 不下发远端 policy）；懒清理节流与期限判定共用注入钟，虚拟时钟大幅前跳会重开懒清理窗口（测试依赖此语义）。
- 本票尚未由用户人工验收；最终内网离线现场验收仍未完成。

## 2026-09-13 票据 #15：后台传输完成回传、恢复与主动取消

分支 `ticket/15-background-transfers`，按规格 6.3/7.1 实施（TDD，测试先红后绿，测试与实现分开提交）：

1. **远端取消与确认**（`remote/transfer.py`）：`transfer_cancel` 在传输专属 flock 内观察状态——锁互斥即"无在途块"的操作性证据，确认停止后才释放数据；终态幂等；`committing` 窗口按 intent 身份+摘要双证据核对（发布已生效补回执认账 completed 绝不回滚 / temp 仍在则安全取消 / 证据不足 `TRANSFER_STATE_UNKNOWN` 不删不猜）；下载方向 sender 无本地数据仅置 cancelled。`transfer_ack` 仅终态可确认（unknown 不在集合内）、写 `ack.json` 幂等、与只读 status 分离。
2. **本机驱动**（`src/services/transfer-service.ts`）：`cancel()` 上传方向以远端为权威；下载方向本地权威——`committing` 窗口按"回执 → intent 身份+摘要 → temp 存在性"三步核对，`unknown` 拒绝取消且数据不动；取消后远端确认停止再删本地 temp/manifest 并释放本机账本。`resume` 补 cancelled 处理（取消后只观察不复活，修复了此前会继续驱动的缺陷）。`acknowledge()` 终态确认（unknown 拒绝），远端+本地幂等。`pending()` 离线列举同会话未确认登记（恢复钩子输入），构造参数抽 `TransferRemote` 接口支持无网络 stub。
3. **MCP 分派**（`workspace-server.ts`）：`remote_upload`/`remote_download` 的 `action=cancel|ack` 落地（原 `UNSUPPORTED_ACTION`），schema 不变，工具描述同步取消与确认语义。
4. **job CLI**（`src/cli/job.ts`）：新增 `transfer <start|wait|status|resume|cancel|ack|pending>` 子命令组。`wait` 为后台等待器：循环驱动至终态、期间不投递块级进度、断线有界退避（500ms×2 封顶 8s）、`--wait-timeout` 输出 `transfer-wait-paused` 正常退出；终态输出 `transfer-result`（completed 退出码 0，其余 1）。
5. **恢复钩子**（`src/cli/recovery.ts`）：离线列举同会话未确认传输（≤50 条+截断提示），注入 `transfer wait` 重挂模板与"只重传未确认数据、不对同一目标重新 start"指引；损坏登记计入 registryIssues。

验证证据（2026-09-13，worktree ticket-15，profile wt15-largefile 与其他 worktree 隔离）：

- WSL Ubuntu / Python 3.12：`remote-transfer.test.py` 50/50 通过（新增取消/确认 5 项由 UNSUPPORTED_ACTION 红转绿）。
- Windows Node 24.15：`npm test` 250 项（243 通过、7 门控跳过、0 失败；transfer-service 31/31、job-cli 离线 2/2、recovery-hook 2/2）。
- CentOS 7.9 VM 真实 SSH（两文件分开串行，规避同 profile 并行的 helper 部署竞争）：`workspace-mcp-remote.test.js` 5/5（#15 用例：32 MiB/64 KiB 块中途停→cancel→cancelled、status 只读、resume 不复活、远端 temp 已删、槽释放、已完成提交不回滚、ack 幂等、未知 id 拒绝）；`job-cli-remote.test.js` 4/4（#15 两用例：64 MiB 下载独立进程 wait 驱动至 completed 且摘要一致、pending→ack 清空；cancel 后本地 temp 立即释放、无半成品、槽释放、cancelled 可 ack）。
- 已知边界：zcode-background 探针本轮未做传输模式适配（需为传输新写探针模式，成本高）；"真实后台完成回传原对话"以 CLI 级集成测试覆盖（独立进程 transfer wait 驱动真实传输至 transfer-result），ZCode 后台通知机制本身已由任务链路探针在此前验收验证。VM 实测曾暴露 64 KiB 小块每块往返约 0.25s 的开销（512 块远超等待时限），测试改用默认 1 MiB 块。
- 本票尚未由用户人工验收；#16 到期回收将基于本票的 ack.json 起算保留期。

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

- 读侧与写侧均无文件体积上限（#9 流式读取、#10 流式提交、#13/#14 可续传上传下载事务均已实施）；inline 写入（text/base64）解码后受 16 MiB 请求预算约束，更大内容走上传。搜索为三后端字面量（rg → grep → Python，#11）且文件名查找后端对齐（#12）。
- 无交互式 stdin/PTY；延期方案见 interactive-assessment.md。
- 协作锁不能消除不遵守锁的外部写入者的最后竞争窗口。
- 不自动判断 ZCode 原对话是否已删除，不自动转投其他对话。
- 日志清理保留请求、结果、读取凭据及去重状态；当前不做整个状态库的自动定期压缩。
- 离线包使用当前 Windows/架构 Node 和已安装依赖。最终内网机器与现有 Python 环境需按 usage.md 验收，不能把联网 VM 测试称为最终离线现场验收。

接入与人工验收步骤见 [usage.md](usage.md)。

## 审查轮 1（2026-09-13，PR #22 内）

三个只读审查代理覆盖已合入的九张票（#6–#13、#18）+ #14 交叉检查，主代理逐项核实源码后确认 23 项缺陷并全部修复（三个并行修复分支 + 合并语义并集），无 P0；最严重为 P1 一项（上传续传 `_heal` 以"块数 × 分块大小"推算可信偏移，短尾块全部可信时把临时文件 truncate 零扩展、事务永久死循环——WSL 实证复现）。

修复要点（详见各 fix 提交正文）：传输层续传流式可信偏移、清单半行容错、提交对账补账本释放、发布段 OS 失败落 failed、崩溃残留自愈、五动作会话核对、verify/commit 尾部不逃出预算；两端账本预留兑现净增量；本机锁回收窗口收窄；搜索续页零推进明确报错、rg 枚举超时转 partial、argv bytes 化（实测 VM exec 通道当前带 LANG=en_US.UTF-8，`env -i` 下 3.6.8 退化为 ascii——bytes argv 使行为与 locale 解耦）；文件链路恢复 inline 16 MiB 请求预算门（规格 4.3）、`COMMITTED_UNCONFIRMED` 不掩盖已提交事实、metadataOnly 拒绝清单补全、symlink 复查前移；`task_start` 两写窗口崩溃自愈；`atomic_json` 补父目录 fsync。

#14 合并时把上述修复语义扩展到下载新增路径（本机 `healDownload` 同构短尾块缺陷、下载尾部预算），由新增的下载预算用例先红后绿捕获。已知测试限制：本机锁 TOCTOU 精确交错与 zod schema 行为级校验无法单进程构造，分别以回归用例与 `maxLength` 声明断言代替。

验证：npm 238 tests/231 pass/0 fail/7 skip（VM 门控项）；WSL 五套件 remote-files 44、remote-agent 13、remote-ledger 12、remote-discovery 27、remote-transfer 46 全 OK；VM 串行门控 workspace-mcp 4/4（含 200 MiB 上传 61 s、下载 64.5 s、编辑 8.8 s）与 job-cli 2/2。注意：两个 VM 套件同 profile 并行执行存在 helper 部署竞争抖动（`node --test` 按文件并行），验证时串行执行或拆 profile。

不修记档（后续票据对齐）：搜索预算参数未暴露 MCP schema 且 policy 层无消费者（#16/#19 接线时统一）；`_truncate_manifest` 固定临时名（锁内私有目录，可接受）；额度检查的递归扫描在锁内执行的性能特征（#19 汇总时观察）。
