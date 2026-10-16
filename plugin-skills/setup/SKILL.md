---
name: setup
description: 安装或升级 ssh-mcp-server 插件的 npm 依赖并完成构建，使 ssh-mcp-setup MCP 服务可用。在插件刚安装或更新后、MCP 报无法启动、缺少 build 产物或 node_modules 时使用。
---

# ssh-mcp-server 安装与构建

本插件携带 ssh-mcp-server 的 TypeScript 源码发行，npm 依赖与构建产物不在仓库中，安装或更新插件后必须执行本技能的步骤，`ssh-mcp-setup` MCP 才能启动。

## 适用场景

- 插件刚从市场安装或更新到新版本
- `ssh-mcp-setup` MCP 启动失败，报找不到 `build/index.js` 或模块（如 `ssh2`、`@modelcontextprotocol/sdk`）

## 前置条件

- 本机 Node.js 18 或更高（`node --version` 检查），`npm` 可用
- 网络可达 npm 源

## 步骤

1. **定位插件根**：本技能文件位于 `<插件根>/plugin-skills/setup/SKILL.md`，向上两级即插件根。确认该目录下存在 `package.json` 与 `.zcode-plugin/plugin.json`。插件安装后通常位于 `~/.zcode/cli/plugins/cache/<市场名>/ssh-mcp-server/<版本>/`，每个版本是独立目录；以实际安装路径为准。

2. **安装依赖**：在插件根执行 `npm install`。仓库带 `package-lock.json`，按锁定版本安装。网络失败时如实报告错误并停止，不更换源、不重试超过一次。

3. **构建**：执行 `npm run build`，生成 `build/index.js` 与 `build/remote/*.py`。TypeScript 编译失败时报告完整错误输出，不要尝试修改源码绕过。

4. **冒烟验证**：执行 `node build/index.js --version`，应打印与 `.zcode-plugin/plugin.json` 一致的版本号后退出。

## 构建完成后

告知用户：依赖已装好、构建完成，新建任务后 `ssh-mcp-setup` MCP 生效。首次接入远端时在新任务中发送：

> 请调用 remote_setup，询问缺少的 SSH 和目录信息，帮我初始化这个项目的远端开发工作区。

若用户尚未持久化默认 SSH 配置且提供了配置文件路径，按"SSH 配置默认值持久化"一节顺带询问是否保存。之后的连接配置、项目绑定与日常使用见插件内的 `README.md` 与 `docs/design/usage.md`。

## SSH 配置默认值持久化

为避免每个新项目接入时重复提供 SSH MCP JSON 配置路径，用本技能自带的脚本保存本机默认值（保存在 `~/.ssh-mcp-setup-defaults.json`）：

```bash
node "<本技能目录>/scripts/set-default-config.mjs" "D:/Private/ssh-config.json"   # 保存默认
node "<本技能目录>/scripts/set-default-config.mjs" --show                        # 查询当前默认
```

- **保存**：脚本先验证该 JSON 能解析出至少一个连接，再只把**路径**写入默认值文件（凭据、密码与私钥内容永远不写入）；验证失败时退出码非 0 且不写文件。
- **生效**：此后 `remote_setup`（list_connections 与 configure）省略 `sshConfigFile` 时自动使用该默认，取值顺序为"显式传入路径 > 已保存默认 > `--config-file` 启动参数"。默认值文件损坏时 `remote_setup` 会报 `SETUP_INVALID_CONFIG`，修复或删除该文件即可。
- **边界**：仅在用户提供路径并希望免重复时执行保存；已配置绑定的 profile 不受默认值影响，不要修改既有绑定记录。`SSH_MCP_SETUP_DEFAULTS` 环境变量可在脚本与 MCP 两侧覆盖默认值文件的保存与读取位置。

新项目接入时可直接说：

> 用默认 SSH 配置，调用 remote_setup 完成这个项目的绑定。

## 升级说明

市场刷新并更新插件后，缓存中出现新的版本目录（旧目录保留），在新版本目录上重跑步骤 1–4。正在运行的旧 MCP 进程按仓库升级说明需重启。

## 边界

- 只处理依赖安装与构建；连接配置、凭据与远端初始化由 `remote_setup` 工具在对话中引导，不在本技能范围内。
- 不要执行 `npm publish`、不要改动用户全局 Node 环境。
