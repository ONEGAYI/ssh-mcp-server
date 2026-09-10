# 阶段 0 验证程序

这些程序验证接入条件，不是可直接用于开发工程的任务执行器。

## ZCode 原生后台与恢复钩子

在 Windows 项目目录运行：

```powershell
node scripts/probes/zcode-background.mjs --cli 'D:\APP\_ForCoder\ZCode\resources\glm\zcode.cjs'
node scripts/probes/zcode-background.mjs --cli 'D:\APP\_ForCoder\ZCode\resources\glm\zcode.cjs' --recover
```

- 默认模式验证主回合结束后，后台 Shell 完成通知启动下一轮。
- `--recover` 强制结束测试 runtime，恢复原 session，发送普通继续请求，验证 UserPromptSubmit 的恢复信息和新后台等待的完成回传。
- `--restart` 是不安装恢复钩子的对照。没有观察到自动回传时返回非零，并输出缺口；它不是通过完整功能的产品测试。
- `--output <dir>` 指定诊断目录；默认 `.artifacts/`，每次创建独立配置和状态目录。无需也不会更改已安装 ZCode 的配置。
- 模型由只监听 `127.0.0.1` 的固定响应服务模拟，不调用真实模型账户。运行的是已安装 ZCode 的真实 app-server、Bash 工具与 hook 执行链路，没有操作真实桌面任务。

程序校验原会话身份、当前 waiter 的 ZCode 任务编号、完成状态、退出码和该 waiter 的日志标记。它证明本机后台等待与钩子可以接入，不证明真实远端任务已经完整接通，更不证明任务启动去重或模型会理解任意业务结果。

测试等待命令带有寿命上限，退出时释放门控文件并关闭测试 runtime 与本机模型服务。配置、日志和 `result.json` 保存在输出目录中供审阅。

## CentOS 7 远端任务生命周期

将 `remote-task-lifecycle.sh` 与 `test/remote-lifecycle-probe.test.py` 按仓库相对结构复制到专用用户测试目录，然后运行：

```sh
/usr/bin/python3 test/remote-lifecycle-probe.test.py
```

Python 3.6 标准库仅用于测试驱动，探针执行器本身使用 Bash 与基础系统命令。测试覆盖启动进程退出后任务继续、独立进程读到日志/退出码，以及 worker 意外结束后不能仅凭残留标记报运行中。

该探针没有生产级取消、配额、启动去重和崩溃恢复。真实 SSH 断开测试目前由原版 SSH MCP 分步执行：启动门控任务、只终止当前用户所属 SSH 会话、确认工具连接断开、重连释放门控并检查结果。不要停止 SSH 服务或其他用户会话。
# 正式任务恢复验收

增加 `--workspace <profile.json>` 可把 ZCode 恢复探针接到正式远端任务服务与正式 UserPromptSubmit 钩子；与固定本机门控模式的验证范围不同。

```powershell
node scripts/probes/zcode-background.mjs --cli <zcode.cjs绝对路径> --recover --workspace <profile.json>
```

`--output` 目录须位于 profile 的 localRoot 内，才能通过恢复钩子的工程归属检查。测试在真实远端执行一次门控命令，重启测试 runtime 后恢复同一对话、再次后台等待、读取结果并通过模型工具调用 ack；核对原 jobId、后台通知身份、远端副作用只执行一次及待处理列表清空。

模型响应仍由本机回环测试服务控制。隔离 runtime 的用户级钩子不等同于实际桌面项目级钩子已完成首次信任；后者按使用指南人工验收。
