import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { serverNameForWorkspaceId } from "../config/workspace.js";
import { RemoteAgentError } from "./remote-agent-client.js";
import { commandHook, hookArgv } from "./client-hooks.js";

export interface IntegrationWrite { path: string; original?: string; content: string }

async function readConfig(path: string) {
  try {
    if ((await lstat(dirname(path))).isSymbolicLink()) throw new RemoteAgentError("SETUP_INVALID_PATH", "The project's .codex directory must not be a symlink or junction");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new RemoteAgentError("SETUP_INVALID_PATH", "Codex config files must not be symlinks");
    return await readFile(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function ownsProfile(entry: any, profilePath: string) {
  const argv = hookArgv(entry);
  if (!argv) return false;
  const at = argv.indexOf("--workspace");
  const executor = argv.find(value => ["index.js", "recovery.js", "session-start.js"].includes(basename(value)));
  if (!executor || at < 0 || typeof argv[at + 1] !== "string") return false;
  const canonical = async (path: string) => {
    try { return await realpath(resolve(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path); throw error; }
  };
  const [left, right] = await Promise.all([canonical(argv[at + 1]), canonical(profilePath)]);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function planCodexIntegration(profile: { localRoot: string; workspaceId: string; profilePath: string }, install: boolean) {
  const serverName = serverNameForWorkspaceId(profile.workspaceId);
  const configPath = join(profile.localRoot, ".codex", "config.toml");
  const hooksPath = join(profile.localRoot, ".codex", "hooks.json");
  const original = await readConfig(configPath);
  const originalHooks = await readConfig(hooksPath);
  let parsed: any;
  let config: any;
  try {
    parsed = parse(original ?? "", { integersAsBigInt: "asNeeded" });
    config = originalHooks === undefined ? {} : JSON.parse(originalHooks);
  } catch { throw new RemoteAgentError("SETUP_INVALID_CONFIG", "The existing Codex configuration is invalid; it was left untouched"); }
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)))) {
    throw new RemoteAgentError("SETUP_INVALID_CONFIG", "Codex hooks.json must contain a hooks object");
  }
  const events = config.hooks ?? {};
  const buildRoot = fileURLToPath(new URL("../", import.meta.url));
  let recoveryHooks = 0, sessionStartHooks = 0;
  for (const event of ["UserPromptSubmit", "SessionStart"]) {
    const existing = events[event] ?? [];
    if (!Array.isArray(existing) || existing.some(group => !group || !Array.isArray(group.hooks))) {
      throw new RemoteAgentError("SETUP_INVALID_CONFIG", `Codex ${event} must contain hook groups`);
    }
    const groups = [];
    let placed = false;
    const generated = { ...commandHook([process.execPath,
      join(buildRoot, "cli", event === "SessionStart" ? "session-start.js" : "recovery.js"),
      "--workspace", profile.profilePath, "--client", "codex"]), timeout: 65, additionalContextLimit: 0 };
    for (const group of existing) {
      const kept = [];
      for (const hook of group.hooks) {
        if (await ownsProfile(hook, profile.profilePath)) {
          if (event === "UserPromptSubmit") recoveryHooks++; else sessionStartHooks++;
          if (install && !placed) { kept.push(generated); placed = true; }
        } else kept.push(hook);
      }
      if (kept.length) groups.push({ ...group, hooks: kept });
    }
    if (install && !placed) groups.push({ hooks: [generated] });
    if (existing.length || install) events[event] = groups;
  }
  const begin = `# ssh-mcp begin ${serverName}\n`;
  const end = `# ssh-mcp end ${serverName}\n`;
  const source = original ?? "";
  const beginMatch = new RegExp(`^# ssh-mcp begin ${serverName}\\r?\\n`, "m").exec(source);
  const endMatch = new RegExp(`^# ssh-mcp end ${serverName}\\r?\\n`, "m").exec(source);
  const beginAt = beginMatch?.index ?? -1, endAt = endMatch?.index ?? -1;
  const endLength = endMatch?.[0].length ?? end.length;
  const previous = parsed.mcp_servers?.[serverName];
  const ownServer = previous !== undefined && await ownsProfile(previous, profile.profilePath);
  if (install && previous !== undefined && !ownServer) {
    throw new RemoteAgentError("SETUP_CONFLICT", `A different Codex MCP server already uses ${serverName}`);
  }
  let base = source;
  if (beginAt >= 0 || endAt >= 0) {
    if (beginAt < 0 || endAt < beginAt || !ownServer) throw new RemoteAgentError("SETUP_CONFLICT", "The generated Codex MCP block was edited; inspect it before replacing or removing it");
    base = source.slice(0, beginAt) + source.slice(endAt + endLength);
    const expected = structuredClone(parsed);
    delete expected.mcp_servers[serverName];
    if (!Object.keys(expected.mcp_servers).length) delete expected.mcp_servers;
    const without = parse(base, { integersAsBigInt: "asNeeded" }) as any;
    if (without.mcp_servers && !Object.keys(without.mcp_servers).length) delete without.mcp_servers;
    if (!isDeepStrictEqual(expected, structuredClone(without))) throw new RemoteAgentError("SETUP_CONFLICT", "The generated Codex block contains unrelated configuration; it was left untouched");
  } else if (ownServer) {
    throw new RemoteAgentError("SETUP_CONFLICT", "The Codex MCP entry has no generated block markers; it was left for manual review");
  }
  const mcpServer = { command: process.execPath, args: [join(buildRoot, "index.js"), "--workspace", profile.profilePath], enabled: true };
  const block = begin + stringify({ mcp_servers: { [serverName]: mcpServer } }) + end;
  const next = install ? (beginAt >= 0 ? source.slice(0, beginAt) + block + source.slice(endAt + endLength)
    : base + (base && !base.endsWith("\n") ? "\n" : "") + block) : base;
  try { parse(next, { integersAsBigInt: "asNeeded" }); }
  catch { throw new RemoteAgentError("SETUP_CONFLICT", "The Codex MCP entry cannot be added without conflicting with existing TOML tables"); }
  const writes: IntegrationWrite[] = [];
  if (next !== source) writes.push({ path: configPath, original, content: next });
  const nextHooks = JSON.stringify({ ...config, hooks: events }, null, 2) + "\n";
  if (install || recoveryHooks || sessionStartHooks) {
    if (nextHooks !== originalHooks) writes.push({ path: hooksPath, original: originalHooks, content: nextHooks });
  }
  return { writes, configPath, hooksPath, mcpServerEntry: ownServer, recoveryHooks, sessionStartHooks,
    lastBinding: !Object.keys((parse(next) as any).mcp_servers ?? {}).some(name => name.startsWith("ssh-workspace-")) };
}
