import { access, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceConfig } from "../config/workspace.js";
import { RemoteAgentError } from "./remote-agent-client.js";

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function writeAtomic(path: string, content: string, expected?: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new RemoteAgentError("SETUP_INVALID_PATH", "Setup will not replace a linked configuration file");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const before = await readOptional(path);
  if (before !== expected) throw new RemoteAgentError("SETUP_CONFLICT", "Configuration changed; inspect it and retry setup");
  if (before === content) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const stream = await open(temporary, "wx", 0o600);
    try { await stream.writeFile(content); await stream.sync(); } finally { await stream.close(); }
    if (await readOptional(path) !== before) throw new RemoteAgentError("SETUP_CONFLICT", "Configuration changed before saving; retry setup");
    if (before === undefined) {
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RemoteAgentError("SETUP_CONFLICT", "Another setup created this file; retry after inspecting it");
        throw error;
      }
    } else await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export async function setupWorkspaceIntegration(profilePath: string, apply: boolean) {
  const profile = await loadWorkspaceConfig(profilePath);
  const buildRoot = fileURLToPath(new URL("../", import.meta.url));
  const configPath = join(profile.localRoot, ".zcode", "config.json");
  try {
    if ((await lstat(dirname(configPath))).isSymbolicLink()) throw new RemoteAgentError("SETUP_INVALID_PATH", "The project's .zcode directory must not be a symlink or junction");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (apply) await mkdir(dirname(configPath), { recursive: true });
  const original = await readOptional(configPath);
  let config: Record<string, any>;
  try {
    config = original === undefined ? {} : JSON.parse(original);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
  } catch { throw new RemoteAgentError("SETUP_INVALID_CONFIG", "The existing project ZCode config is not a JSON object; it was not overwritten"); }
  for (const section of [config.mcp, config.mcp?.servers, config.hooks, config.hooks?.events]) {
    if (section !== undefined && (!section || typeof section !== "object" || Array.isArray(section))) {
      throw new RemoteAgentError("SETUP_INVALID_CONFIG", "Existing MCP and hook configuration sections must be JSON objects");
    }
  }
  const serverName = "ssh-workspace-" + profile.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const hook = { type: "process", command: process.execPath,
    args: [join(buildRoot, "cli", "recovery.js"), "--workspace", profile.profilePath] };
  const events = config.hooks?.events ?? {};
  const existing = events.UserPromptSubmit ?? [];
  if (!Array.isArray(existing) || existing.some(group => !group || !Array.isArray(group.hooks))) {
    throw new RemoteAgentError("SETUP_INVALID_CONFIG", "Existing UserPromptSubmit hooks must be valid hook groups");
  }
  const sameHook = (candidate: any) => candidate.type === hook.type && candidate.command === hook.command && JSON.stringify(candidate.args) === JSON.stringify(hook.args);
  const hooks = existing.some(group => group.hooks.some(sameHook)) ? existing : [...existing, { hooks: [hook] }];
  const mcpServer = { command: process.execPath, args: [join(buildRoot, "index.js"), "--workspace", profile.profilePath] };
  const previous = config.mcp?.servers?.[serverName];
  if (previous && (!Array.isArray(previous.args) || !previous.args.includes(profile.profilePath))) {
    throw new RemoteAgentError("SETUP_CONFLICT", "A different MCP server already uses the generated name; choose another workspaceId");
  }
  const updated = { ...config,
    mcp: { ...config.mcp, servers: { ...config.mcp?.servers, [serverName]: { ...mcpServer, enable: true } } },
    hooks: { ...config.hooks, enabled: true, events: { ...events, UserPromptSubmit: hooks } },
  };
  const rules = `# SSH 远端开发工作区\n\n本目录连接 Linux 工程 ${profile.remoteRoot}。\n\n- 开始工作先调用 remote_workspace，再用 remote_read 读取远端适用的 AGENTS.md / CLAUDE.md。\n- 文件读写优先使用 remote_* 工具。凭据冲突时重新读取，不用 Shell 绕过工具报出的冲突。\n- 构建和测试通过恢复钩子提供的 job CLI run 入口运行，必须使用 ZCode 原生后台 Shell 的 run_in_background: true。\n- sessionId 使用恢复钩子提供的真实对话标识，不猜测、不借用其他对话的任务。\n- 继续对话时用 wait 挂接原任务，不再 run 原命令。\n- 后台通知后检查 task-result 和日志，按 eventId 去重，处理后使用 remote_ack 或 CLI ack。\n- 本机等待退出不是远端取消；显式 cancel 后核实状态，unknown 不自动重跑。\n`;
  const rulesPath = join(profile.localRoot, "AGENTS.md");
  const claudePath = join(profile.localRoot, "CLAUDE.md");
  const exists = async (path: string) => { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  const hasRules = await exists(rulesPath);
  const guide = hasRules ? join(profile.localRoot, "SSH-WORKSPACE-GUIDE.md") : rulesPath;
  if (apply) {
    await writeAtomic(configPath, JSON.stringify(updated, null, 2) + "\n", original);
    if (!await exists(guide)) await writeAtomic(guide, rules);
    if (!await exists(claudePath)) await writeAtomic(claudePath, "@AGENTS.md\n");
  }
  return { applied: apply, configPath, config: updated, rulesPath: guide, serverName, mcpServer,
    note: "Project integration is prepared. Reopen this local project if its tools are not loaded yet, and confirm ZCode's first-time workspace-hook trust. No global config was changed." };
}
