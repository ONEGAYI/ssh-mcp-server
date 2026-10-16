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

之后的连接配置、项目绑定与日常使用见插件内的 `README.md` 与 `docs/design/usage.md`。

## 升级说明

市场刷新并更新插件后，缓存中出现新的版本目录（旧目录保留），在新版本目录上重跑步骤 1–4。正在运行的旧 MCP 进程按仓库升级说明需重启。

## 边界

- 只处理依赖安装与构建；连接配置、凭据与远端初始化由 `remote_setup` 工具在对话中引导，不在本技能范围内。
- 不要执行 `npm publish`、不要改动用户全局 Node 环境。
