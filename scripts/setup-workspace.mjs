#!/usr/bin/env node
// Generate project-scoped integration; never modify the user's global ZCode config.
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadWorkspaceConfig } from '../build/config/workspace.js';

const { values } = parseArgs({ options: { workspace: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/setup-workspace.mjs --workspace <profile.json> [--apply]\nWithout --apply prints the proposed project integration; with --apply merges it atomically.');
} else {
  if (!values.workspace) throw new Error('--workspace is required');
  const profile = await loadWorkspaceConfig(resolve(values.workspace));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const configPath = join(profile.localRoot, '.zcode', 'config.json');
  let config = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const serverName = 'ssh-workspace-' + profile.workspaceId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const hook = { type: 'process', command: process.execPath,
    args: [join(packageRoot, 'build', 'cli', 'recovery.js'), '--workspace', profile.profilePath] };
  const events = config.hooks?.events ?? {};
  const existing = events.UserPromptSubmit ?? [];
  const sameHook = candidate => candidate.type === hook.type && candidate.command === hook.command && JSON.stringify(candidate.args) === JSON.stringify(hook.args);
  const hooks = existing.some(group => group.hooks?.some(sameHook)) ? existing : [...existing, { hooks: [hook] }];
  const updated = { ...config,
    mcp: { ...config.mcp, servers: { ...config.mcp?.servers, [serverName]: { command: process.execPath,
      args: [join(packageRoot, 'build', 'index.js'), '--workspace', profile.profilePath], enable: true } } },
    hooks: { ...config.hooks, enabled: true, events: { ...events, UserPromptSubmit: hooks } },
  };
  const rules = `# SSH 远端开发工作区\n\n本目录用于连接远端工程，源码位置是 Linux 的 ${profile.remoteRoot}。\n\n- 开始工作先调用 remote_workspace，并使用 remote_read 读取远端适用的 AGENTS.md / CLAUDE.md。\n- 文件读写、查找和传输优先使用 remote_* MCP 工具。读取凭据冲突时重新读取；不要改用 Shell 绕过工具报出的冲突。\n- 普通构建、测试等 Shell 命令保持可用。通过恢复钩子提供的 ssh-mcp-job run 命令入口运行，必须设置 ZCode 原生 Shell 的 run_in_background: true。\n- sessionId 使用恢复钩子提供的真实对话标识。不要猜测，也不要挪用其他对话的任务。\n- 继续对话时检查恢复钩子列出的待处理任务。对原任务使用 wait 挂接，不能再 run 原命令。\n- 收到后台通知后核对 task-result；需要时读 remote_output 的日志尾部。处理完成事件后使用 remote_ack 或 job CLI ack。重复事件按 eventId 去重。\n- 本机等待退出不代表远端取消。只有 remote_cancel / job CLI cancel 才是取消请求；核实状态后再报告结果。\n- unknown 表示无法确认执行结果，报告并检查记录，不自动重新执行可能有副作用的命令。\n`;
  const rulesPath = join(profile.localRoot, 'AGENTS.md');
  const claudePath = join(profile.localRoot, 'CLAUDE.md');
  const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const hasRules = await exists(rulesPath);
  const hasClaude = await exists(claudePath);
  if (values.apply) {
    await mkdir(dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, configPath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    if (!hasRules) await writeFile(rulesPath, rules, { flag: 'wx' });
    else await writeFile(join(profile.localRoot, 'SSH-WORKSPACE-GUIDE.md'), rules, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!hasClaude) await writeFile(claudePath, '@AGENTS.md\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ applied: Boolean(values.apply), configPath, config: updated,
    rulesPath: hasRules ? join(profile.localRoot, 'SSH-WORKSPACE-GUIDE.md') : rulesPath,
    note: 'Workspace hooks may require one-time trust in ZCode. The global configuration and external SSH credentials are unchanged.' }, null, 2));
}
