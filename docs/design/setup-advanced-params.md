# setup 高级参数按需提供方案

状态：**待用户评审，尚未实施**。本轮只精简工作区工具的无效参数与传输调参；`remote_setup` 的现有接口保持不变。

## 目标与测量口径

目标是在保留完整运行时校验的前提下，减少不使用高级配置时仍需加载的输入 schema。不能仅把现有字段包进对象：完整声明的嵌套字段仍会进入上下文。

PR #48 文案精简后的 `remote_setup` 有 20 个顶层参数、43 个具名字段，包含参数说明的输入 schema 为 1,406 tokens。这里使用 `o200k_base` 对紧凑 JSON 分词，不计宿主包装；这是本地测量口径，不是客户端计费值。

本方案的静态 schema 演算结果为 11 个顶层参数、约 414 tokens（包含外层未知字段拒绝声明），比上述基线减少约 71%。演算尚未经过实现、宿主接入和模型使用验证，不能作为发布后的实测结果。

## 方案选择

| 方案 | 上下文影响 | 使用代价 | 判断 |
|---|---|---|---|
| 将强类型字段归入 `connection` 等对象 | 字段定义仍全部常驻；连接字段分组的演算从 1,406 增至 1,420 tokens | 改变调用路径 | 不选 |
| 拆成多个详细工具并同时注册 | 各工具仍常驻，公共参数还会重复 | 需要选择更多工具 | 不选 |
| 核心参数常驻，高级参数通过 `describe` 按需说明 | 高级字段类型不进入常驻 schema，服务端仍严格校验 | 使用高级配置前多一次读取 | 推荐，待评审 |

推荐方案继续使用一个 `remote_setup`，不依赖宿主支持动态隐藏工具，也不新增第二个完整 setup 服务。

## 推荐接口

保留以下 9 个核心顶层参数及现有类型约束：

| 参数 | 用途 |
|---|---|
| `action` | 保留现有动作，新增只读 `describe` |
| `localRoot` | 本机项目目录 |
| `bindingName` | 目标绑定 |
| `revision` | 更新、移除的并发校验凭据 |
| `remoteRoot` | 远端工程根 |
| `remoteStateDir` | 远端持久状态目录 |
| `sshConfigFile` | 已有 SSH MCP JSON 连接库 |
| `connectionName` | 连接库中的连接名 |
| `directoryScope` | 用户明确选择的文件工具目录边界 |

再增加两个顶层参数：

- `section`：仅供 `describe` 选择参数分组，不触发配置写入。
- `advanced`：结构化对象，不使用 JSON 字符串。常驻 schema 只声明对象，不展开内部字段；服务端仍按固定的高级参数定义进行严格校验。

下列 11 个原顶层参数移入 `advanced`，其数据类型、默认值和既有行为不变：

| 分组 | 字段 |
|---|---|
| `connection` | `host`、`port`、`username`、`privateKey`、`sshAgent` |
| `clients` | `clients` |
| `sessionStart` | `sessionStart` |
| `policy.limits` / `policy.retention` / `policy.search` / `policy.maintenance` | 对应 `policy` 子对象 |
| `runtime` | `workspaceId`、`pythonPath`、`localStateDir` |

这些分组只用于 `describe` 查询；`advanced` 内仍使用原字段名，例如 `advanced.policy.search`，不会产生 `advanced.connection.host` 这样的第二层映射。

## 按需说明与调用流程

首次配置仍可无参调用，工具返回缺项问题。常用连接库方式不要求读取高级参数。缺项问题可以指向对应 `describe` 分组，但不顺带返回全部高级 schema。

`action="describe"` 不要求项目目录，不读取现有 profile 或凭据文件，不连接 SSH，也不写文件。省略 `section` 时只返回简短分组目录；指定分组后返回该分组的字段路径、类型与限制、默认值、适用动作和最小示例。

例如，先查询搜索策略：

```json
{"action":"describe","section":"policy.search"}
```

已有绑定仍先 `inspect` 获得 revision，再更新所需字段：

```json
{
  "action": "update",
  "localRoot": "{{LocalRoot}}",
  "bindingName": "{{BindingName}}",
  "revision": "{{Revision}}",
  "advanced": {
    "policy": {"search": {"respectGitignore": true}}
  }
}
```

单次 `describe` 只返回一个分组，目标响应不超过 4 KiB。`inspect` 的现有脱敏结果和 revision 契约保持不变，不借本方案改变其他输出格式。

## 校验与授权

**隐藏类型声明不等于取消类型校验**。服务端应保留原始完整参数定义，先校验外层核心参数和 `advanced` 的允许字段，再合并为现有配置处理函数需要的输入。

- 外层和 `advanced` 均拒绝未知字段；`advanced` 不接受核心参数的别名或覆盖项。
- `policy` 保留嵌套严格校验、部分更新和默认值规则；错误需要指出完整字段路径，不得因拼写错误静默使用默认值。
- 更新允许字段、身份锁定、revision 冲突和移除前未确认任务检查继续由现有逻辑执行。
- 目录边界仍需用户明确选择；`describe` 不代表用户授权配置、解除边界或移除绑定。
- 私钥仍只接收本机文件路径；密码和私钥正文不进入聊天，按需说明也不返回真实认证信息。

## 兼容与落地边界

本方案会改变高级参数的调用位置，是需要单独发布的接口调整。已有 profile、SSH 配置和本地任务状态无需迁移；需要迁移的是客户端工具定义缓存与旧调用参数。

旧顶层高级参数必须明确拒绝并说明应迁入 `advanced`。不能利用默认的未知字段剔除行为，把旧参数静默丢弃；也不能为保留别名而重新将全部旧字段注册进常驻 schema。

试用时建议提供显式选择的紧凑 setup 启动模式，与现有模式互斥加载；默认模式切换和发布版本另行决定。客户端未验证前，不承诺开放对象参数已兼容 ZCode 或 Codex。

## 实施前与验收检查

- 在实际宿主中验证 `advanced` 开放对象的传递、嵌套错误显示以及工具缓存刷新方式。
- 从现有参数定义生成 `describe` 信息与内部校验，避免再维护一份手写字段规格。
- 对真实 `tools/list` 复测，目标输入 schema 不超过 800 tokens；不为运行时产品增加分词依赖。
- 对 `describe` 的零写入、零 SSH、脱敏和分组响应预算建立契约测试。
- 覆盖高级字段的正确更新、未知字段、错误类型、旧顶层参数、身份锁定、过期 revision 和移除拒绝。
- 用真实客户端完成普通连接库配置、Codex 接入、会话注入和策略调整，记录额外调用次数及模型能否正确使用 `advanced`。

只有方案经用户评审、实现及上述验证完成后，才能将本文件状态改为已实施。
