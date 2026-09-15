import { link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { identityStateDirectory, loadWorkspaceConfig, profileSchema, serverNameForWorkspaceId, WorkspaceConfig } from "../config/workspace.js";
import { TaskService } from "./task-service.js";
import { TransferService } from "./transfer-service.js";
import { RemoteAgentError } from "./remote-agent-client.js";

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

/** The profile fields integration needs; callers load or construct it, so checks can run before the profile file is written. */
export interface IntegrationProfile {
  localRoot: string;
  workspaceId: string;
  profilePath: string;
}

/** Reads and structurally validates the project ZCode config; setup merges into
 * it and remove unhooks from it, so both surfaces enforce the same shape. */
async function readProjectConfig(configPath: string): Promise<{ original: string | undefined; config: Record<string, any> }> {
  try {
    if ((await lstat(dirname(configPath))).isSymbolicLink()) throw new RemoteAgentError("SETUP_INVALID_PATH", "The project's .zcode directory must not be a symlink or junction");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
  const existing = config.hooks?.events?.UserPromptSubmit ?? [];
  if (!Array.isArray(existing) || existing.some(group => !group || !Array.isArray(group.hooks))) {
    throw new RemoteAgentError("SETUP_INVALID_CONFIG", "Existing UserPromptSubmit hooks must be valid hook groups");
  }
  return { original, config };
}

export async function setupWorkspaceIntegration(profile: IntegrationProfile, apply: boolean) {
  const buildRoot = fileURLToPath(new URL("../", import.meta.url));
  const configPath = join(profile.localRoot, ".zcode", "config.json");
  const { original, config } = await readProjectConfig(configPath);
  if (apply) await mkdir(dirname(configPath), { recursive: true });
  const serverName = serverNameForWorkspaceId(profile.workspaceId);
  const hook = { type: "process", command: process.execPath,
    args: [join(buildRoot, "cli", "recovery.js"), "--workspace", profile.profilePath] };
  const events = config.hooks?.events ?? {};
  const existing = events.UserPromptSubmit ?? [];
  const sameHook = (candidate: any) => candidate.type === hook.type && candidate.command === hook.command && JSON.stringify(candidate.args) === JSON.stringify(hook.args);
  const hooks = existing.some((group: any) => group.hooks.some(sameHook)) ? existing : [...existing, { hooks: [hook] }];
  const mcpServer = { command: process.execPath, args: [join(buildRoot, "index.js"), "--workspace", profile.profilePath] };
  const previous = config.mcp?.servers?.[serverName];
  if (previous && (!Array.isArray(previous.args) || !previous.args.includes(profile.profilePath))) {
    throw new RemoteAgentError("SETUP_CONFLICT", "A different MCP server already uses the generated name; choose another workspaceId");
  }
  const updated = { ...config,
    mcp: { ...config.mcp, servers: { ...config.mcp?.servers, [serverName]: { ...mcpServer, enable: true } } },
    hooks: { ...config.hooks, enabled: true, events: { ...events, UserPromptSubmit: hooks } },
  };
  // Issue #31: configure no longer writes project markdown — remote_help is
  // the single guidance source. The one-time migration below reclaims files
  // whose content still matches a known generated generation.
  let legacyDocs: LegacyDocCleanup | undefined;
  if (apply) {
    await writeAtomic(configPath, JSON.stringify(updated, null, 2) + "\n", original);
    legacyDocs = await cleanupLegacyGeneratedDocs(profile.localRoot);
  }
  return { applied: apply, configPath, config: updated, serverName, mcpServer,
    ...(legacyDocs ? { legacyDocs } : {}),
    note: "Project integration is prepared. Reopen this local project if its tools are not loaded yet, and confirm ZCode's first-time workspace-hook trust. No global config was changed. Suggest adding .ssh-mcp-*.json to this project's .gitignore — they carry host and authentication parameters; setup does not edit .gitignore itself." };
}

/** Frozen history of every markdown generation configure ever wrote. Never extend
 * this list: new wording simply leaves unmatched files to the kept report. */
const V1_PREFIX = "# SSH 远端开发工作区\n\n本目录连接 Linux 工程 ";
const V1_SUFFIX = "。\n\n- 开始工作先调用 remote_workspace，再用 remote_read 读取远端适用的 AGENTS.md / CLAUDE.md。\n- 文件读写优先使用 remote_* 工具。凭据冲突时重新读取，不用 Shell 绕过工具报出的冲突。\n- 构建和测试通过恢复钩子提供的 job CLI run 入口运行，必须使用 ZCode 原生后台 Shell 的 run_in_background: true。\n- sessionId 使用恢复钩子提供的真实对话标识，不猜测、不借用其他对话的任务。\n- 继续对话时用 wait 挂接原任务，不再 run 原命令。\n- 后台通知后检查 task-result 和日志，按 eventId 去重，处理后使用 remote_ack 或 CLI ack。\n- 本机等待退出不是远端取消；显式 cancel 后核实状态，unknown 不自动重跑。\n";
const V2_TEXT = "# SSH 远端开发工作区\n\n本目录可配置一个或多个 SSH 远端绑定：每个绑定连接一台服务器的某个目录，对应一个 `ssh-workspace-*` MCP 服务和一个恢复钩子。绑定清单见 `.zcode/config.json` 的 `mcp.servers`；各绑定当前的远端目录与待恢复任务由恢复钩子注入的上下文说明。\n\n- 开始工作先按目标绑定调用 remote_workspace，再用 remote_read 读取远端适用的 AGENTS.md / CLAUDE.md。\n- 文件读写优先使用 remote_* 工具。凭据冲突时重新读取，不用 Shell 绕过工具报出的冲突。\n- 构建和测试通过恢复钩子提供的 job CLI run 入口运行，必须使用 ZCode 原生后台 Shell 的 run_in_background: true。\n- sessionId 使用恢复钩子提供的真实对话标识，不猜测、不借用其他对话的任务。\n- 继续对话时用 wait 挂接原任务，不再 run 原命令。\n- 后台通知后检查 task-result 和日志，按 eventId 去重，处理后使用 remote_ack 或 CLI ack。\n- 本机等待退出不是远端取消；显式 cancel 后核实状态，unknown 不自动重跑。\n";
const V3_TEXT = "# SSH 远端开发工作区\n\n本目录可配置一个或多个 SSH 远端绑定：每个绑定连接一台服务器的某个目录，对应一个 `ssh-workspace-*` MCP 服务和一个恢复钩子。绑定清单见 `.zcode/config.json` 的 `mcp.servers`；各绑定当前的远端目录与待恢复任务由恢复钩子注入的上下文说明。\n\n- 开始工作先按目标绑定调用 remote_workspace，再用 remote_read 读取远端适用的 AGENTS.md / CLAUDE.md。\n- 文件读写优先使用 remote_* 工具。凭据冲突时重新读取，不用 Shell 绕过工具报出的冲突。\n- 远端命令（构建、测试、目录管理等）通过恢复钩子提供的 job CLI run 入口运行，必须使用 ZCode 原生后台 Shell 的 run_in_background: true。\n- sessionId 使用恢复钩子提供的真实对话标识，不猜测、不借用其他对话的任务。\n- 继续对话时用 wait 挂接原任务，不再 run 原命令。\n- 后台通知后检查 task-result 和日志，按 eventId 去重，处理后使用 remote_ack 或 CLI ack。\n- 本机等待退出不是远端取消；显式 cancel 后核实状态，unknown 不自动重跑。\n";
const CLAUDE_IMPORT = "@AGENTS.md\n";

type Generation = "v1" | "v2" | "v3";

function matchGeneration(text: string): Generation | undefined {
  if (text === V3_TEXT) return "v3";
  if (text === V2_TEXT) return "v2";
  // v1 interpolated a single-line remoteRoot; anything multi-line is not ours.
  if (text.length > V1_PREFIX.length + V1_SUFFIX.length && text.startsWith(V1_PREFIX) && text.endsWith(V1_SUFFIX)) {
    const root = text.slice(V1_PREFIX.length, text.length - V1_SUFFIX.length);
    if (!root.includes("\n")) return "v1";
  }
  return undefined;
}

export interface LegacyDocCleanup {
  removed: Array<{ path: string; generation: Generation }>;
  kept: Array<{ path: string; reason: string }>;
}

/** Reclaims markdown files configure generated in earlier versions. A file is
 * deleted only when its content still matches a known generation verbatim;
 * user-edited files stay untouched and are reported for manual handling. */
export async function cleanupLegacyGeneratedDocs(localRoot: string): Promise<LegacyDocCleanup> {
  const removed: LegacyDocCleanup["removed"] = [];
  const kept: LegacyDocCleanup["kept"] = [];
  const readAt = async (name: string) => {
    const path = join(localRoot, name);
    const text = await readOptional(path);
    return text === undefined ? undefined : { path, text };
  };
  // ENOENT still counts as reclaimed: a concurrent configure (and later the
  // remove action reusing this cleanup) may have already taken the file, and
  // the reached end state — file gone — is what the report records. Any other
  // failure (EPERM/EBUSY under an editor lock, EACCES) also stays inside the
  // report: integration is already complete at this point, so a locked file
  // must fail the reclaim, not the configure — the path stays visible in kept.
  const reclaim = async (path: string, generation: Generation) => {
    try {
      await unlink(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") { removed.push({ path, generation }); return; }
      kept.push({ path, reason: `reclaim failed (${code ?? "unknown"}); file left in place for manual removal` });
      return;
    }
    removed.push({ path, generation });
  };
  const agents = await readAt("AGENTS.md");
  if (agents) {
    const generation = matchGeneration(agents.text);
    if (generation) {
      await reclaim(agents.path, generation);
      // The generated one-line import dies with the file it imported; a user
      // import of a surviving AGENTS.md keeps working and stays.
      const claude = await readAt("CLAUDE.md");
      if (claude) {
        if (claude.text === CLAUDE_IMPORT) await reclaim(claude.path, generation);
        else kept.push({ path: claude.path, reason: "AGENTS.md was reclaimed but this CLAUDE.md is not the generated one-line import; kept for manual review" });
      }
    } else kept.push({ path: agents.path, reason: "content differs from every known generated generation; kept for manual review" });
  }
  const guide = await readAt("SSH-WORKSPACE-GUIDE.md");
  if (guide) {
    const generation = matchGeneration(guide.text);
    if (generation) await reclaim(guide.path, generation);
    else kept.push({ path: guide.path, reason: "content differs from every known generated generation; kept for manual review" });
  }
  return { removed, kept };
}

// ---------------------------------------------------------------------------
// Issue #28: remove — the local-only decommission of one binding, shared by
// the remote_setup MCP tool and the manual CLI. Zero SSH connections: remote
// state is only reported, never touched.

const WORKSPACE_FLAG = "--workspace";

/** True when both strings name the same file on disk: the exact text configure
 * wrote, or any spelling that still resolves to it (case on Windows, a link). */
async function samePath(candidate: string, target: string): Promise<boolean> {
  if (candidate === target) return true;
  try { return await realpath(candidate) === await realpath(target); }
  catch { return false; }
}

/** Matches the MCP server entry and recovery hook configure generated for this
 * profile: an executor whose basename is one of ours, our --workspace flag,
 * and a path naming this profile. The command itself is deliberately not
 * compared (a moved build root or a different node install still matches);
 * the --workspace target naming this exact profile is the real anchor. */
async function refersToProfile(entry: any, profilePath: string): Promise<boolean> {
  if (!entry || !Array.isArray(entry.args)) return false;
  const at = entry.args.indexOf(WORKSPACE_FLAG);
  if (at < 0 || at + 1 >= entry.args.length || typeof entry.args[at + 1] !== "string") return false;
  const executor = typeof entry.args[0] === "string" ? basename(entry.args[0]) : "";
  if (executor !== "index.js" && executor !== "recovery.js") return false;
  return await samePath(entry.args[at + 1], profilePath);
}

export interface RemovalPending {
  tasks: string[];
  transfers: string[];
  registryIssues: Array<{ source: "tasks" | "transfers"; id: string; code: string }>;
}

const removalOffline = {
  async call(): Promise<never> { throw new Error("No remote calls during removal"); },
  async localPath(): Promise<never> { throw new Error("No remote calls during removal"); },
  async exchange(): Promise<never> { throw new Error("No remote calls during removal"); },
  async exchangeBinary(): Promise<never> { throw new Error("No remote calls during removal"); },
};

/** Binding-level (every session) unacknowledged work, read offline from the
 * local registries exactly like recovery discovery. */
async function removalPending(config: WorkspaceConfig): Promise<RemovalPending> {
  const tasks = new TaskService(removalOffline, config.localStateDir, config.identity);
  const transfers = new TransferService(removalOffline, config, removalOffline);
  const pendingTasks = await tasks.pendingAcross();
  const pendingTransfers = await transfers.pendingAcross();
  return {
    tasks: pendingTasks.map(task => task.jobId),
    transfers: pendingTransfers.map(transfer => transfer.transferId),
    registryIssues: [
      ...tasks.registryIssues.map(issue => ({ source: "tasks" as const, id: issue.jobId, code: issue.code })),
      ...transfers.transferRegistryIssues.map(issue => ({ source: "transfers" as const, id: issue.transferId, code: issue.code })),
    ],
  };
}

/** Locates this binding's entries in the project config and returns the config
 * with them removed. Foreign entries and emptied nodes are left in place; the
 * caller decides whether to persist the result. */
async function planUnhook(projectConfig: Record<string, any>, config: WorkspaceConfig, profilePath: string) {
  const serverName = serverNameForWorkspaceId(config.workspaceId);
  let mcpServerEntry = false;
  let note: string | undefined;
  if (projectConfig.mcp?.servers?.[serverName] !== undefined) {
    if (await refersToProfile(projectConfig.mcp.servers[serverName], profilePath)) {
      const servers = { ...projectConfig.mcp.servers };
      delete servers[serverName];
      projectConfig.mcp = { ...projectConfig.mcp, servers };
      mcpServerEntry = true;
    } else {
      // An entry squatted on our generated name but pointing elsewhere is not
      // ours: it stays, and the report says why the entry was not removed.
      note = `an entry uses the generated name ${serverName} but points at a different workspace; it was left untouched`;
    }
  }
  let recoveryHooks = 0;
  const groups = projectConfig.hooks?.events?.UserPromptSubmit;
  if (Array.isArray(groups)) {
    const rebuilt: typeof groups = [];
    for (const group of groups) {
      const hooks: typeof group.hooks = [];
      for (const hook of group.hooks) {
        if (await refersToProfile(hook, profilePath)) recoveryHooks++;
        else hooks.push(hook);
      }
      // A group that still holds foreign hooks keeps them; emptied groups drop.
      if (hooks.length) rebuilt.push(hooks.length === group.hooks.length ? group : { ...group, hooks });
    }
    projectConfig.hooks.events.UserPromptSubmit = rebuilt;
  }
  const servers = projectConfig.mcp?.servers ?? {};
  const lastBinding = !Object.keys(servers).some(name => name.startsWith("ssh-workspace-"));
  return { serverName, mcpServerEntry, recoveryHooks, lastBinding, ...(note ? { note } : {}) };
}

export interface RemovalPreview {
  status: "removal_preview";
  revision: string;
  profilePath: string;
  bindingName?: string;
  serverName: string;
  blocked: boolean;
  pending: RemovalPending;
  wouldRemove: {
    mcpServerEntry: boolean;
    recoveryHooks: number;
    connectionFile: { path: string; generated: boolean };
    localStateDir: string;
    lastBinding: boolean;
  };
  instructions: string;
}

export interface RemoveOutcome {
  status: "removed";
  profilePath: string;
  bindingName?: string;
  serverName: string;
  unhooked: { mcpServerEntry: boolean; recoveryHooks: number; note?: string };
  connectionFile: { path: string; removed: boolean; reason?: string };
  localStateDir: { path: string; removed: boolean; reason?: string };
  remoteStateDir: string;
  lastBinding: boolean;
  legacyDocs?: LegacyDocCleanup;
  legacyCleanupError?: string;
  registryIssues?: RemovalPending["registryIssues"];
  instructions: string;
}

/** Removes one binding's local integration. With a revision the removal runs;
 * without one nothing is touched and a preview with the current revision and
 * pending state is returned (the manual CLI's two-step flow). */
export async function removeWorkspaceBinding(profilePath: string, revision?: string): Promise<RemoveOutcome | RemovalPreview> {
  const absolute = resolve(profilePath);
  let content: string;
  try { content = await readFile(absolute, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RemoteAgentError("SETUP_PROFILE_NOT_FOUND", `No workspace profile at ${absolute}`);
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(content); }
  catch { throw new RemoteAgentError("SETUP_INVALID_CONFIG", "The existing profile is not valid JSON; it was left untouched"); }
  if (!profileSchema.safeParse(raw).success) {
    throw new RemoteAgentError("SETUP_INVALID_CONFIG", "The existing profile is invalid; it was left untouched");
  }
  if (revision !== undefined && revision !== revisionOf(content)) {
    throw new RemoteAgentError("SETUP_CONFLICT", "The profile changed since it was inspected (stale revision); inspect again for the current revision and retry");
  }
  let config: WorkspaceConfig;
  try { config = await loadWorkspaceConfig(absolute); }
  catch (error) {
    if (error instanceof RemoteAgentError) throw error;
    throw new RemoteAgentError("SETUP_INVALID_SSH_CONFIG", "Could not derive the binding identity: the profile's referenced SSH config must stay readable until removal; it was left untouched");
  }
  const pending = await removalPending(config);
  const generatedConnection = join(config.localRoot, config.bindingName
    ? `.ssh-mcp-connection.${config.bindingName}.json` : ".ssh-mcp-connection.json");
  const generated = await samePath(config.sshConfigFile, generatedConnection);
  const statePath = identityStateDirectory(config.localStateDir, config.identity);
  const configPath = join(config.localRoot, ".zcode", "config.json");

  if (revision === undefined) {
    const { config: projectConfig } = await readProjectConfig(configPath);
    const plan = await planUnhook(projectConfig, config, absolute);
    return {
      status: "removal_preview", revision: revisionOf(content), profilePath: absolute,
      ...(config.bindingName ? { bindingName: config.bindingName } : {}),
      serverName: plan.serverName,
      blocked: pending.tasks.length + pending.transfers.length > 0,
      pending,
      wouldRemove: {
        mcpServerEntry: plan.mcpServerEntry, recoveryHooks: plan.recoveryHooks,
        connectionFile: { path: config.sshConfigFile, generated },
        localStateDir: statePath, lastBinding: plan.lastBinding,
      },
      instructions: "Pass this revision back to execute the removal. Blocked until every pending task and transfer is acknowledged; registryIssues list local registration defects worth checking first. No SSH connection is ever made.",
    };
  }

  if (pending.tasks.length || pending.transfers.length) {
    const parts: string[] = [];
    if (pending.tasks.length) parts.push(`${pending.tasks.length} unacknowledged task(s) [${pending.tasks.slice(0, 10).join(", ")}${pending.tasks.length > 10 ? ", …" : ""}]`);
    if (pending.transfers.length) parts.push(`${pending.transfers.length} unacknowledged transfer(s) [${pending.transfers.slice(0, 10).join(", ")}${pending.transfers.length > 10 ? ", …" : ""}]`);
    throw new RemoteAgentError("SETUP_PENDING_OPERATIONS", `This binding still has ${parts.join(" and ")} from its whole history, not just one conversation. Acknowledge or cancel each one first (job CLI / remote_ack for tasks, transfer acknowledgement); removal has no force option. Nothing was removed.`);
  }

  // Surgery order (issue #28): unhook first so the recovery hook never runs
  // against a deleted profile, then delete the profile, then the generated
  // connection file and the local identity state directory.
  const { original, config: projectConfig } = await readProjectConfig(configPath);
  const plan = await planUnhook(projectConfig, config, absolute);
  // Close the inspect-to-delete window as far as cheaply possible (the same
  // before-check writeAtomic uses): a profile rewritten behind our back
  // aborts here, before any mutation has happened.
  const fresh = await readOptional(absolute);
  if (fresh !== undefined && revisionOf(fresh) !== revision) {
    throw new RemoteAgentError("SETUP_CONFLICT", "The profile changed since it was inspected (stale revision); inspect again for the current revision and retry");
  }
  if ((plan.mcpServerEntry || plan.recoveryHooks) && original !== undefined) {
    await writeAtomic(configPath, JSON.stringify(projectConfig, null, 2) + "\n", original);
  }
  try { await unlink(absolute); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new RemoteAgentError("SETUP_REMOVE_PARTIAL",
      `The project integration was unhooked, but the profile could not be deleted (${code ?? "unknown"}): ${absolute}. Close whatever holds it and retry remove with the same revision; the generated connection file and local state directory were left in place.`);
  }
  let connectionFile: RemoveOutcome["connectionFile"];
  if (!generated) {
    connectionFile = { path: config.sshConfigFile, removed: false,
      reason: "external SSH config file is never deleted; remove it yourself if nothing else uses it" };
  } else {
    try { await unlink(config.sshConfigFile); connectionFile = { path: config.sshConfigFile, removed: true }; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      connectionFile = code === "ENOENT" ? { path: config.sshConfigFile, removed: true }
        : { path: config.sshConfigFile, removed: false, reason: `delete failed (${code ?? "unknown"}); remove the generated file manually` };
    }
  }
  let localState: RemoveOutcome["localStateDir"] = { path: statePath, removed: true };
  try { await rm(statePath, { recursive: true, force: true }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    localState = { path: statePath, removed: false, reason: `delete failed (${code ?? "unknown"}); remove the directory manually once nothing holds it` };
  }
  let legacyDocs: LegacyDocCleanup | undefined;
  let legacyCleanupError: string | undefined;
  if (plan.lastBinding) {
    // Everything binding-specific is already gone; a locked project root must
    // not cost the caller the removal report itself.
    try { legacyDocs = await cleanupLegacyGeneratedDocs(config.localRoot); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      legacyCleanupError = `legacy document cleanup failed (${code ?? "unknown"}); check the project root manually`;
    }
  }
  return {
    status: "removed", profilePath: absolute,
    ...(config.bindingName ? { bindingName: config.bindingName } : {}),
    serverName: plan.serverName,
    unhooked: { mcpServerEntry: plan.mcpServerEntry, recoveryHooks: plan.recoveryHooks, ...(plan.note ? { note: plan.note } : {}) },
    connectionFile, localStateDir: localState,
    remoteStateDir: config.remoteStateDir,
    lastBinding: plan.lastBinding,
    ...(legacyDocs ? { legacyDocs } : {}),
    ...(legacyCleanupError ? { legacyCleanupError } : {}),
    ...(pending.registryIssues.length ? { registryIssues: pending.registryIssues } : {}),
    instructions: "No SSH connection was made. The remote state directory keeps its records until the workspace server's maintenance cycles reclaim them by retention; delete it manually over SSH if it must go now. Keep any remaining .ssh-mcp-*.json (other bindings, external SSH configs) in this project's .gitignore; if the deleted files were ever committed, commit the deletions yourself — remove never runs git commands.",
  };
}
