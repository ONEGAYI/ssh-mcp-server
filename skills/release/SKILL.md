---
name: release
description: 准备并发布 ssh-mcp-server 仓库的新版本：版本号同步、CHANGELOG、离线包打包与 gh release 资产上传。在准备发布版本、编写 Release notes 或核对发布完整性时使用。
---

# ssh-mcp-server 版本发布

离线包是唯一对外分发物；发布以 `gh release create` 附带离线 zip 为完成标志，只发 CHANGELOG 不附包不算发布完成。

## 前置条件

- 本版变更已全部合入 main（仓库变更一律走 fork 内 PR）
- Node 回归（`npm test`）与 WSL Python 回归（`npm run test:py`）结果来自本版最终代码，如实记录通过、跳过与待验收项

## 版本号同步（四处）

版本号必须一致，缺一处即发布不完整：

1. `package.json` 的 `version`
2. `package-lock.json` 根与 `packages[""]` 两处 `version`（bump `package.json` 后在仓库根执行 `npm install --package-lock-only` 同步）
3. `.zcode-plugin/plugin.json` 的 `version`（ZCode 插件清单，安装缓存按它分版本目录）
4. `marketplace.json` 插件条目的 `version`

同时在 `AGENTS.md` 当前工作范围补记本版条目：交付内容、回归结果、待人工验收项；不写未实测的结论。

## CHANGELOG.md

根级 `CHANGELOG.md` 顶部插入本版条目，沿用既有格式：`## [版本] - 日期`、一段摘要、按"Bug 修复 / 新功能 / 其他改进"分节、变更附 PR 链接；有升级注意（如需重启共用绑定的 MCP 进程）与验证状态时，以引用块补在条目末。

## 构建与离线包

1. `npm run build`
2. `node scripts/package-offline.mjs --output <仓库外目录>/ssh-mcp-<版本>-offline`（输出目录必须不存在，脚本不覆盖既有目录）
3. 将离线目录压缩为同名 zip
4. 抽查：用包内 `runtime/node` 分别以 `build/index.js` 与 `--setup` 启动，完成 MCP 握手并报告本版版本号；zip 可完整解压

## 发布

```bash
gh release create v<版本> --title "v<版本>：<主题>" --notes-file <notes 路径> <zip 路径>
```

发布后核对 Release 资产含 zip。发布记录（Release 链接）按先例以 chore 提交通过 PR 合入（先例：PR #47）。

## 插件渠道说明

ZCode 插件随 git 市场分发，与上面的离线包发布相互独立：

- 插件版本即仓库版本，main 推送后市场即可刷新，无独立发布动作
- 用户侧更新顺序：市场刷新 → 插件更新 → 新任务运行 setup 技能（新版本缓存目录需重装依赖并重新构建）

## 边界

- 不提供轻量分发包；不发布 npm；不向上游提 PR
- `MANIFEST.json` 的 SHA-256 清单由打包脚本生成，不手改
- 发布准备提交只含版本、CHANGELOG、AGENTS.md 记录与清单同步，不夹带功能代码
