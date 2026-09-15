# 绑定生命周期实施票据（按需指引 + 绑定移除）

状态：2026-09-14 拆票完成，#30–#33 共 4 张票据。#30 已实施（PR #34）；#31 已实施（PR #35，随 v2.1.0 发布）；#32–#33 已实施（PR #36，待审查）。实施顺序为线性链：#30 → #31 → #32 → #33。

规格：[按需指引 #29](https://github.com/ONEGAYI/ssh-mcp-server/issues/29) / [绑定移除 #28](https://github.com/ONEGAYI/ssh-mcp-server/issues/28)（决策记档见两 issue 评论）。需求访谈与领域术语见 [CONTEXT.md](CONTEXT.md)「绑定移除与按需指引访谈（2026-09-14）」一节。

## 依赖顺序

| 票据 | 交付 | Blocked by |
|---|---|---|
| [#30](https://github.com/ONEGAYI/ssh-mcp-server/issues/30) | feat: remote_help 按需指引工具与 instructions 引导 | 无 |
| [#31](https://github.com/ONEGAYI/ssh-mcp-server/issues/31) | feat: configure 停止落盘工作区文档并提供存量迁移清理 | #30 |
| [#32](https://github.com/ONEGAYI/ssh-mcp-server/issues/32) | feat: remote_setup 移除绑定动作（remove） | #31 |
| [#33](https://github.com/ONEGAYI/ssh-mcp-server/issues/33) | feat: 移除绑定 CLI 入口与文档收尾 | #32 |

#29（按需指引）是 #28（绑定移除）的前置基础：#31 落地后新项目无落盘文档，#32 的文档删除逻辑仅处理未迁移存量，并与 #31 复用同一匹配逻辑（v1/v2/v3 三代已知文本——v3 为 PR #34 审查修复引入的措辞演化，见 #31 评论；一次性不再增长）。无前置依赖的 #30 已标 ready-for-agent；其余票据解除依赖后再开始，有标签不代表已实现或用户已验收。功能票均含契约测试先行（仓库 TDD 约定）。

## 票据内容快照

### #30 feat: remote_help 按需指引工具与 instructions 引导

规格：#29。expand 阶段，不改现有行为。已实施（PR #34）。

- 工作区 MCP 新增 `remote_help`：零参数、不连 SSH、返回静态完整指引；文本改为指引视角。
- server instructions 末尾加引导句。
- 验收：工具可调、无远端交互与维护轮触发、instructions 引导、契约测试先行、README/usage 最小说明。

### #31 feat: configure 停止落盘工作区文档并提供存量迁移清理

规格：#29。contract 阶段。已实施（PR #35，随 v2.1.0 发布）。

- configure 不再写 `AGENTS.md` / `SSH-WORKSPACE-GUIDE.md` / `CLAUDE.md`。
- 一次性迁移清理：匹配 v1/v2/v3 三代已知文本才删并报告；用户改过的不删仅报告；`CLAUDE.md` 随 `AGENTS.md` 联动（存量）。清理逻辑独立可复用。
- setup 返回提示 gitignore `.ssh-mcp-*.json`。
- 验收：新项目零落盘、v1/v2/v3/改过/联动五类情形测试、文档更新。

### #32 feat: remote_setup 移除绑定动作（remove）

规格：#28（八项决策见其评论）。已实施（PR #36）。

- 入口仅 revision 防并发，`destructiveHint: true`；pending 任务/传输硬拒绝、不设 force（离线读本地登记、绑定级全量）。
- 摘除顺序：先摘钩子组与 MCP 条目（空节点保留），再删 profile；删除生成的连接配置，外部 sshConfigFile 永不删。
- 校验通过后整体删除本地 identity 状态目录；远端零连接，仅报告状态目录路径与手工清理指引。
- 存量文档：仅最后一个绑定时复用 #31 匹配逻辑删除并报告。
- 验收：各拒绝路径、多绑定隔离、顺序、空节点、外部配置不删，契约测试先行。

### #33 feat: 移除绑定 CLI 入口与文档收尾

规格：#28。已实施（PR #36，含两项记档项：CONTEXT.md 大文件访谈节时点更正、test/README.md 测试树补齐）。

- CLI 与 MCP 共用实现的 remove 入口（纯本地操作，无 MCP 客户端时可用）。
- README / usage / CONTEXT / 离线包 README 收尾对齐。
- 验收：CLI 行为与 MCP 一致（含拒绝路径）、冒测、文档与实际一致。
