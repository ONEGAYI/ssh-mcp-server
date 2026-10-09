# 会话启动时注入远端规则与技能目录

## 范围与配置

用户确认的范围：ZCode 与 Codex 均接入现有 `UserPromptSubmit` 恢复钩子及新的 `SessionStart` 上下文钩子。远端根目录的 `AGENTS.md` 与工作区技能目录使用同一个绑定级开关；技能只注入名称、描述、远端 `SKILL.md` 路径，使用前再读取正文。

| 宿主 | 远端读取范围 |
|---|---|
| ZCode | `AGENTS.md`、`.agents/skills`、`.zcode/skills` |
| Codex | `AGENTS.md`、`.agents/skills` |

不读取 `.codex/skills`，不扫描远端用户级或工作区外的其他技能目录。当前只发现上述目录下的直接子目录或符号链接中的 `SKILL.md`；远端文件工具既有的目录边界和 `allowedRemotePaths` 继续适用。同名技能保留各自路径，不合并正文。

各绑定 profile 新增可选字段：

```json
{
  "clients": ["zcode", "codex"],
  "sessionStart": {
    "enabled": true,
    "timeoutMs": 5000,
    "maxBytes": 8192
  }
}
```

- `clients` 选择本机项目要接入的宿主。存量 profile 未写时保持 ZCode 默认；首次配置或 `inspect → update` 可以指定两端。
- `sessionStart.enabled` 未写时为 `false`，同时控制规则与技能目录，不影响恢复钩子。
- `timeoutMs` 默认 5000，允许 100–60000 毫秒，约束远端读取阶段的总等待。
- `maxBytes` 默认 8192；设为 1024–16384 时，约束本次注入上下文的 UTF-8 大小。**约定 `maxBytes: 0` 表示本程序不限制大小**：通过现有文件游标分块拉取，仍受 `timeoutMs` 总时间上限约束。取消程序内固定的 32768 字节 JSON 输出上限。

不限大小的配置示例：`sessionStart: { enabled: true, maxBytes: 0, timeoutMs: 10000 }`。`timeoutMs` 约束整批远端读取，包含连接、执行器准备和文件分页；每页不重新计时。超时返回 `CONTEXT_TIMEOUT` 诊断并丢弃整批已拉取内容，不注入半份 AGENTS.md 或已读到的部分技能。未写 `maxBytes` 时仍使用原默认值。

该约定仅取消本程序的字节限制，宿主与模型的限制继续适用。ZCode 官网列出的默认钩子 stdout 上限为 32768 字节，未说明无限值；本程序不猜测或自动改写宿主的 `maxOutputBytes`。ZCode 3.14.x 的大输出接收仍待实测。Codex 生成的钩子使用 `additionalContextLimit: 0` 关闭其上下文转存阈值，不能据此承诺模型上下文无限。

`inspect` 返回默认值、可更新字段与 `revision`。`update` 对 `sessionStart` 只合并明确提供的字段，关闭时保留此前设置的预算。上述字段不参与绑定 identity，切换开关或宿主不改变既有任务、传输的归属。切换宿主先保存接入配置，最后保存 profile；任一步失败则回滚已经保存的文件。并发编辑造成回滚冲突时明确报告残留路径，不覆盖外部修改。

## 两端接入

ZCode 使用项目 `.zcode/config.json` 的 MCP 与 hooks；接入目标为用户确认项目钩子可用的 **3.14.x**。当前官网对项目钩子的说明与该使用环境有差异，其他版本须先核实支持，不能将写入配置视为已触发。

Codex 使用项目 `.codex/config.toml` 的 `mcp_servers` 与 `.codex/hooks.json`。MCP 条目通过每绑定的生成块维护，原有 TOML 内容和注释保留；生成块混入其他配置、条目被占用或配置无效时明确拒绝。钩子按事件和 profile 路径识别归属，合并、重复 setup 与 remove 保留其他绑定和用户自有钩子。

Codex 项目层及钩子需要宿主信任，使用 `/hooks` 检查和信任定义；程序不代替用户完成信任操作。Windows 命令通过 PowerShell EncodedCommand 执行，避免路径中的空格和 Shell 元字符改变 argv。POSIX 宿主使用逐参数引用。

钩子显式传入 `--client zcode|codex`，不靠模型名称或环境猜测宿主。关闭后钩子仍可登记，但运行时在连接 SSH 前退出。恢复钩子继续完全离线读取本机任务与传输登记，并提供适合当前宿主的等待指引。

## 注入与失败语义

每次 `SessionStart` 重新读取 profile 和远端文件，包括宿主触发的恢复、清空、压缩事件。没有会话级永久去重或陈旧缓存。修改开关在下一次事件生效，已经进入当前对话的内容不会被撤回。

注入内容注明绑定、工作区、远端根和宿主，要求规则只适用于该绑定。技能只访问入口 `SKILL.md`，名称和描述从 YAML frontmatter 提取，并附上远端路径与按需读取正文的引导。不限大小时分页读取到完整 frontmatter 即停止；末页可能包含部分正文，但正文不注入，也不预读入口引用的文档或脚本。限大小时，frontmatter 超出读取预算或格式不合法均报告该技能未加载。分页通过 `expectedVersion` 保持同一文件版本，不拼接变化中的文件。

文件缺失、权限或网络错误均可见，不将错误误报为成功读取。每个技能目录最多读取首批 100 项；列表分页或预算不足时说明未列全，提示通过 `remote_list` 继续查询。总大小超限或总时间超时则本次不注入文件内容，只返回有界诊断。运行时关闭已有 SSH 连接，专用钩子进程完成协议输出后即退出，未完成的代理连接或 SSH 握手不会延长等待。注入不签发文件修改所需的 readToken，编辑前仍须通过受保护文件工具读取。

## 验证与人工验收

自动契约覆盖绑定独立开关、存量绑定接入 Codex、身份与认证保留、双端配置幂等、生成命令的真实 JSON 协议、移除范围、宿主技能目录选择、技能正文不注入、缺失/超限/超时与退出清理。远端文件读取在测试中模拟 SSH 边界，不将其等同于真实宿主或 CentOS 7 验收。

人工验收：分别在 ZCode 3.14.x 和 Codex 信任配置后新建会话，检查根规则和技能目录出现；关闭后新建会话，确认不注入；两绑定设置相反开关，确认范围；触发宿主压缩/恢复，确认规则重新加载；核实恢复钩子仍给出真实会话标识与原任务编号。额外使用 `maxBytes: 0` 测试超过 32768 字节的上下文，核实宿主完整接收；将总读取拖延到 `timeoutMs` 之后，确认只有诊断、没有此前拉取的规则或技能。

依据：[ZCode Hooks](https://zcode.z.ai/en/docs/hooks)、[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Codex 技能路径](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。官方能力与用户已确认版本分开记录，仍需真实客户端验收。
