import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { CommandLineParser } from "../cli/command-line-parser.js";
import { RemoteAgentError } from "../services/remote-agent-client.js";
import { setupWorkspaceIntegration, writeAtomic } from "../services/workspace-setup.js";
import { bindingNamePattern, profileSchema } from "../config/workspace.js";
import { policySectionSchema, resolvePolicy, StoredPolicy } from "../config/policy.js";
import { SERVER_CONFIG } from "../config/server.js";

const optionalPath = z.string().min(1).optional();
const inputSchema = {
  action: z.enum(["configure", "inspect", "update"]).optional().describe("Operation on a workspace binding. Default 'configure' creates or idempotently re-confirms a binding. 'inspect' returns an existing binding's sanitized configuration and revision. 'update' changes only the fields you name and requires that revision"),
  revision: z.string().min(1).optional().describe("Revision token from a previous inspect; required for action='update' so concurrent changes are rejected instead of overwritten"),
  policy: policySectionSchema.optional().describe("Workspace policy: per-end space limits, retention periods, search filters and budgets, maintenance cadence. Provide only the fields to set; unspecified fields keep defaults or stored values. Saved values apply from the next operation or maintenance cycle and never recalculate existing records' expiry"),
  bindingName: z.string().regex(bindingNamePattern).optional().describe("Unique lowercase binding name for this local project when several remote targets coexist, e.g. eda-main; omit for this project's original unnamed binding"),
  localRoot: optionalPath.describe("Existing local Windows project directory to open in ZCode; ask the user, never assume the MCP process cwd"),
  remoteRoot: optionalPath.describe("Existing absolute Linux source directory"),
  remoteStateDir: optionalPath.describe("Writable persistent absolute Linux directory for helper scripts and task state"),
  sshConfigFile: optionalPath.describe("Path to an existing original SSH MCP JSON config; credentials stay in that file"),
  connectionName: z.string().min(1).optional(),
  host: z.string().min(1).optional().describe("SSH host when no existing sshConfigFile is used"),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).optional(),
  privateKey: optionalPath.describe("Absolute local path to an existing private key; never the key content. Encrypted keys should use an SSH agent or existing config"),
  sshAgent: z.string().min(1).optional().describe("SSH agent socket/named pipe, or pageant on Windows"),
  workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  directoryScope: z.enum(["restricted", "unrestricted"]).optional().describe("File-tool directory boundary. Ask the user first: default restricted keeps guarded file operations inside remoteRoot; unrestricted only when the user explicitly declines any directory limit. Unrestricted keeps read tokens, edit-range, and external-change checks; allowedRemotePaths in the SSH config still applies. remoteRoot remains the default execution directory either way (the remote home is a common unrestricted choice)"),
  pythonPath: optionalPath.describe("Absolute Linux Python >=3.6 executable, default /usr/bin/python3"),
  localStateDir: optionalPath.describe("Optional absolute local task-state directory; default is user-private state directory"),
};
const setupSchema = z.object(inputSchema);
type SetupInput = z.infer<typeof setupSchema>;

// Any explicit SSH field switches the whole call to explicit settings; the
// preset library is never field-merged with per-call credentials.
const hasExplicitSsh = (input: SetupInput) => Boolean(input.host || input.username || input.privateKey || input.sshAgent || input.port);

/** Changing any of these in place would rekey the binding identity or strand its recorded state. */
const IDENTITY_LOCKED: Record<string, string> = {
  sshConfigFile: "the referenced SSH config resolves the server connection",
  connectionName: "the selected connection identifies the server",
  host: "the server address is part of the binding identity",
  port: "the server port is part of the binding identity",
  username: "the login user is part of the binding identity",
  privateKey: "authentication must stay untouched by configuration updates",
  sshAgent: "authentication must stay untouched by configuration updates",
  remoteRoot: "the remote source root is part of the binding identity",
  remoteStateDir: "the remote state directory locates all remote task state",
  localStateDir: "the local state directory locates all local task registrations",
  workspaceId: "the workspace id is part of the binding identity",
};

function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid value";
}

function parsePolicyPatch(value: StoredPolicy | undefined): StoredPolicy | undefined {
  if (value === undefined) return undefined;
  const candidate = policySectionSchema.safeParse(value);
  if (!candidate.success) throw new RemoteAgentError("SETUP_INVALID_POLICY", `Invalid policy section: ${firstIssue(candidate.error)}`);
  return candidate.data;
}

const askLocalRoot = {
  status: "needs_input",
  questions: [{ fields: ["localRoot"], question: "要查看或调整哪个本机项目目录中的绑定？请提供本机绝对路径。" }],
  instructions: "Ask the user for the local project directory, then call remote_setup again with the same action and that directory. Nothing was read or written.",
};

/** Locates and validates the existing profile an inspect/update call addresses. */
async function loadProfileForAction(input: SetupInput): Promise<{ profilePath: string; content: string; raw: Record<string, unknown> }> {
  if (!isAbsolute(input.localRoot!)) throw new RemoteAgentError("SETUP_INVALID_PATH", "Local directories must be absolute");
  const localRoot = await realpath(input.localRoot!);
  if (!await stat(localRoot).then(info => info.isDirectory())) throw new RemoteAgentError("SETUP_INVALID_PATH", "localRoot must be an existing directory");
  const profilePath = join(localRoot, input.bindingName ? `.ssh-mcp-workspace.${input.bindingName}.json` : ".ssh-mcp-workspace.json");
  let content: string;
  try { content = await readFile(profilePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RemoteAgentError("SETUP_PROFILE_NOT_FOUND", `No workspace profile ${input.bindingName ? `for binding '${input.bindingName}' ` : "for this project "}at ${profilePath}; call remote_setup without an action to create it`);
    }
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(content); }
  catch { throw new RemoteAgentError("SETUP_INVALID_CONFIG", "The existing profile is not valid JSON; it was left untouched"); }
  const validated = profileSchema.safeParse(raw);
  if (!validated.success) throw new RemoteAgentError("SETUP_INVALID_CONFIG", `The existing profile is invalid (${firstIssue(validated.error)}); it was left untouched`);
  return { profilePath, content, raw: raw as Record<string, unknown> };
}

function checkBindingName(input: SetupInput) {
  if (input.bindingName !== undefined && !bindingNamePattern.test(input.bindingName)) {
    throw new RemoteAgentError("SETUP_INVALID_BINDING", "bindingName must be 1-64 lowercase letters, digits, or hyphens and start with a letter or digit; this keeps binding files unambiguous on case-insensitive systems");
  }
}

async function inspectFromTool(input: SetupInput) {
  checkBindingName(input);
  if (!input.localRoot) return askLocalRoot;
  const { profilePath, content, raw } = await loadProfileForAction(input);
  const profile = profileSchema.parse(raw);
  return {
    status: "inspected", profilePath, revision: revisionOf(content),
    config: {
      workspaceId: profile.workspaceId,
      ...(profile.bindingName ? { bindingName: profile.bindingName } : {}),
      connectionName: profile.connectionName,
      sshConfigFile: profile.sshConfigFile,
      remoteRoot: profile.remoteRoot,
      remoteStateDir: profile.remoteStateDir,
      directoryScope: profile.directoryScope ?? "restricted",
      pythonPath: profile.pythonPath,
      ...(profile.localRoot ? { localRoot: profile.localRoot } : {}),
      ...(profile.localStateDir ? { localStateDir: profile.localStateDir } : {}),
      policy: resolvePolicy(profile.policy),
    },
    authentication: {
      source: resolve(dirname(profilePath), profile.sshConfigFile),
      connectionName: profile.connectionName,
      note: "Credentials stay inside the referenced SSH config file; inspect never reads, echoes, or rewrites passwords, passphrases, or private key contents",
    },
    updatable: ["policy", "directoryScope", "pythonPath"],
    identityLocked: Object.keys(IDENTITY_LOCKED),
    instructions: "config shows effective values including defaults. Change updatable fields with action='update' plus this revision. identityLocked fields (server connection, directories, workspaceId) cannot change in place: configure a new binding with a new bindingName for a new target and keep this binding until its tasks and state are finished and cleaned up. No SSH connection was made.",
  };
}

async function updateFromTool(input: SetupInput) {
  checkBindingName(input);
  if (!input.localRoot) return askLocalRoot;
  if (!input.revision) throw new RemoteAgentError("SETUP_REVISION_REQUIRED", "Update requires the revision returned by a previous inspect of this binding; inspect first, then retry with that revision");
  const { profilePath, content, raw } = await loadProfileForAction(input);
  if (revisionOf(content) !== input.revision) {
    throw new RemoteAgentError("SETUP_CONFLICT", "The profile changed since it was inspected (stale revision); inspect again for the current revision and retry");
  }
  const locked = Object.keys(IDENTITY_LOCKED).find(field => (input as unknown as Record<string, unknown>)[field] !== undefined);
  if (locked) {
    throw new RemoteAgentError("SETUP_IDENTITY_LOCKED", `'${locked}' cannot be updated in place: ${IDENTITY_LOCKED[locked]}. Changing it would strand this binding's tasks, read credentials, and transfer records. Configure a new binding (a new bindingName via remote_setup) for the new target and keep this binding until its old state is finished and cleaned up`);
  }
  if (input.directoryScope !== undefined && input.directoryScope !== "restricted" && input.directoryScope !== "unrestricted") {
    throw new RemoteAgentError("SETUP_INVALID_SCOPE", "directoryScope must be 'restricted' or 'unrestricted'; an unrestricted scope requires the user's explicit decision, never a default");
  }
  if (input.pythonPath !== undefined && (!posix.isAbsolute(input.pythonPath) || input.pythonPath.includes("\0"))) {
    throw new RemoteAgentError("SETUP_INVALID_PATH", "pythonPath must be an absolute POSIX path without NUL");
  }
  const patch = parsePolicyPatch(input.policy);
  const changed: string[] = [];
  // Mutate a copy of the parsed JSON so unnamed fields and key order survive byte-for-byte.
  const updated: Record<string, unknown> = { ...raw };
  if (input.directoryScope !== undefined) {
    const before = (updated.directoryScope as string | undefined) ?? "restricted";
    if (input.directoryScope === "unrestricted") updated.directoryScope = "unrestricted";
    else delete updated.directoryScope;
    if (((updated.directoryScope as string | undefined) ?? "restricted") !== before) changed.push("directoryScope");
  }
  if (input.pythonPath !== undefined && updated.pythonPath !== input.pythonPath) {
    updated.pythonPath = input.pythonPath;
    changed.push("pythonPath");
  }
  if (patch) {
    const stored = updated.policy && typeof updated.policy === "object" && !Array.isArray(updated.policy)
      ? updated.policy as Record<string, unknown> : {};
    const merged: Record<string, Record<string, unknown>> = {};
    const incoming = patch as unknown as Record<string, unknown>;
    for (const group of new Set([...Object.keys(stored), ...Object.keys(incoming)])) {
      const existing = stored[group];
      if (incoming[group] === undefined) {
        if (existing !== undefined) merged[group] = { ...(existing as Record<string, unknown>) };
        continue;
      }
      const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
      merged[group] = { ...base, ...(incoming[group] as Record<string, unknown>) };
    }
    for (const [group, leaves] of Object.entries(incoming)) {
      if (!leaves || typeof leaves !== "object") continue;
      const previous = stored[group] && typeof stored[group] === "object" && !Array.isArray(stored[group])
        ? stored[group] as Record<string, unknown> : {};
      for (const leaf of Object.keys(leaves as Record<string, unknown>)) {
        if (previous[leaf] !== merged[group][leaf]) changed.push(`policy.${group}.${leaf}`);
      }
    }
    if (Object.keys(merged).length) updated.policy = merged;
    else delete updated.policy;
  }
  const finalCheck = profileSchema.safeParse(updated);
  if (!finalCheck.success) {
    throw new RemoteAgentError("SETUP_INVALID_POLICY", `The update would produce an invalid profile (${firstIssue(finalCheck.error)}); nothing was written`);
  }
  const next = JSON.stringify(updated, null, 2) + "\n";
  await writeAtomic(profilePath, next, content);
  return {
    status: "updated", profilePath, revision: revisionOf(next), changed,
    policy: resolvePolicy(updated.policy),
    effective: "Policy changes apply from the next operation or maintenance cycle; operations already running keep the snapshot they started with. Retention-period changes affect only records created afterwards — existing expiresAt values are never recalculated. directoryScope and pythonPath changes apply the next time this binding's workspace MCP server starts.",
    instructions: "Only the listed fields changed; authentication was neither read nor rewritten. Verify with action='inspect'. Identity and authentication fields stay locked — configure a new binding for a new server or directory target.",
  };
}

/** Single entry the MCP tool calls; dispatches on the optional action field. */
export async function setupFromTool(input: SetupInput, defaultSshConfigFile?: string) {
  const action = input.action ?? "configure";
  if (action === "inspect") return inspectFromTool(input);
  if (action === "update") return updateFromTool(input);
  return configureFromTool(input, defaultSshConfigFile);
}

export async function configureFromTool(input: SetupInput, defaultSshConfigFile?: string) {
  // Explicit per-call SSH settings override the setup service's preset library.
  if (!input.sshConfigFile && !hasExplicitSsh(input) && defaultSshConfigFile) {
    input = { ...input, sshConfigFile: defaultSshConfigFile };
  }
  const questions: Array<{ fields: string[]; question: string }> = [];
  checkBindingName(input);
  if (input.directoryScope !== undefined && input.directoryScope !== "restricted" && input.directoryScope !== "unrestricted") {
    throw new RemoteAgentError("SETUP_INVALID_SCOPE", "directoryScope must be 'restricted' or 'unrestricted'; an unrestricted scope requires the user's explicit decision, never a default");
  }
  const initialPolicy = parsePolicyPatch(input.policy);
  if (!input.localRoot) questions.push({ fields: ["localRoot"], question: "用哪个本机绝对路径作为 ZCode 工作区？请选择独立项目目录。" });
  if (!input.remoteRoot || !input.remoteStateDir) questions.push({ fields: ["remoteRoot", "remoteStateDir"], question: input.directoryScope === "unrestricted"
    ? "无边界绑定的远端默认执行目录（建议远端 home，如 /home/user）和可写的持久状态目录分别是什么？均需绝对路径。"
    : "远端 Linux 的源码目录和可写的持久状态目录分别是什么？均需绝对路径。" });
  if (input.sshConfigFile && hasExplicitSsh(input)) {
    throw new RemoteAgentError("SETUP_CONFLICT", "Choose either an existing SSH config or host/auth fields, not both");
  }
  if (!input.sshConfigFile) {
    if (!input.host || !input.username) questions.push({ fields: ["sshConfigFile", "host", "username", "port"], question: "提供 SSH 地址、用户名、端口（默认 22），或已有原版 SSH MCP JSON 配置文件路径。" });
    if (!input.privateKey && !input.sshAgent) questions.push({ fields: ["privateKey", "sshAgent", "sshConfigFile"], question: "使用哪个本机私钥文件或 SSH agent？若用密码/密钥口令，请在本机已有 SSH 配置中填写，再提供该配置路径；不要把密码、口令或私钥内容发到对话。" });
  }
  let connectionName = input.connectionName;
  let connections: string[] = [];
  if (input.sshConfigFile) {
    if (!isAbsolute(input.sshConfigFile)) throw new RemoteAgentError("SETUP_INVALID_PATH", "sshConfigFile must be an absolute local path");
    let names: string[];
    try {
      // An empty library fails deep inside the parser with a misleading "missing parameters" message; name the real cause.
      const parsed = JSON.parse(await readFile(input.sshConfigFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
        throw new RemoteAgentError("SETUP_INVALID_SSH_CONFIG", "The SSH config file contains no connections; fix the file or provide host/username fields instead of a config path");
      }
      names = Object.keys(CommandLineParser.parseArgs(["--config-file", input.sshConfigFile]).configs);
    }
    catch (error) {
      if (error instanceof RemoteAgentError) throw error;
      throw new RemoteAgentError("SETUP_INVALID_SSH_CONFIG", "Could not load the SSH config; check the file path and config format without sharing its credentials");
    }
    if (!connectionName && names.length === 1) connectionName = names[0];
    connections = names;
    if (!connectionName) questions.push({ fields: ["connectionName"], question: `选择连接名：${names.slice(0, 20).join("、")}（选定即完成连接配置，主机与认证细节都在预存库内，无需另行查证）` });
    else if (!names.includes(connectionName)) throw new RemoteAgentError("SETUP_INVALID_CONNECTION", "The selected connection does not exist in the SSH config");
  }
  if (questions.length) return { status: "needs_input", questions, connections,
    instructions: "Ask the user for these missing values, reuse already confirmed information, then call remote_setup again with the complete fields. A connection name from the preset library is the complete connection choice — host and credentials stay inside it, so there is nothing to look up or verify. Remote directories and connection choices come only from the user — not from local SSH configs, not from guessing, and no address probing: setup never connects, so a probe proves nothing. Never ask for passwords or private-key contents in chat. Nothing was written and no SSH connection was made." };
  if (!isAbsolute(input.localRoot!) || (input.localStateDir && !isAbsolute(input.localStateDir))) throw new RemoteAgentError("SETUP_INVALID_PATH", "Local directories must be absolute");
  for (const value of [input.remoteRoot!, input.remoteStateDir!, input.pythonPath ?? "/usr/bin/python3"]) {
    if (!posix.isAbsolute(value) || value.includes("\0")) throw new RemoteAgentError("SETUP_INVALID_PATH", "Linux paths must be absolute POSIX paths without NUL");
  }
  if (posix.normalize(input.remoteStateDir!) === "/") throw new RemoteAgentError("SETUP_INVALID_PATH", "Do not use the Linux filesystem root for task state");
  const localRoot = await realpath(input.localRoot!);
  if (!await stat(localRoot).then(info => info.isDirectory())) throw new RemoteAgentError("SETUP_INVALID_PATH", "localRoot must be an existing directory");
  if (input.privateKey && (!isAbsolute(input.privateKey) || !await stat(input.privateKey).then(info => info.isFile()))) {
    throw new RemoteAgentError("SETUP_INVALID_PATH", "privateKey must be the absolute path of an existing local file");
  }
  // Legacy unnamed bindings keep their original workspaceId and file names so existing task ownership survives.
  const localKey = process.platform === "win32" ? localRoot.toLowerCase() : localRoot;
  const binding = input.bindingName;
  const workspaceId = input.workspaceId ?? (binding
    ? `remote-${binding}-` + createHash("sha256").update(localKey + "\0" + binding).digest("hex").slice(0, 12)
    : "remote-" + createHash("sha256").update(localKey).digest("hex").slice(0, 12));
  const profilePath = join(localRoot, binding ? `.ssh-mcp-workspace.${binding}.json` : ".ssh-mcp-workspace.json");
  const sshConfigFile = input.sshConfigFile ? resolve(input.sshConfigFile) : join(localRoot, binding ? `.ssh-mcp-connection.${binding}.json` : ".ssh-mcp-connection.json");
  connectionName = connectionName ?? "remote";
  const profile = { workspaceId, ...(binding ? { bindingName: binding } : {}), connectionName, sshConfigFile, localRoot,
    remoteRoot: input.remoteRoot, remoteStateDir: input.remoteStateDir, pythonPath: input.pythonPath ?? "/usr/bin/python3",
    ...(input.directoryScope === "unrestricted" ? { directoryScope: "unrestricted" as const } : {}),
    ...(input.localStateDir ? { localStateDir: input.localStateDir } : {}),
    ...(initialPolicy && Object.keys(initialPolicy).length ? { policy: initialPolicy } : {}) };
  const content = JSON.stringify(profile, null, 2) + "\n";
  // Dry-run integration first: a rejected binding must not leave a profile file behind.
  await setupWorkspaceIntegration({ localRoot, workspaceId, profilePath }, false);
  let old: string | undefined;
  try { old = await readFile(profilePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (old !== undefined && old !== content) throw new RemoteAgentError("SETUP_CONFLICT", "This project already has a different workspace profile. Use remote_setup action='inspect'/'update' for this binding's adjustable fields, or choose an empty local project for a new target");
  if (!input.sshConfigFile) {
    const auth = JSON.stringify({ [connectionName]: { host: input.host, port: input.port ?? 22, username: input.username,
      ...(input.privateKey ? { privateKey: resolve(input.privateKey) } : {}), ...(input.sshAgent ? { agent: input.sshAgent } : {}) } }, null, 2) + "\n";
    let previous: string | undefined;
    try { previous = await readFile(sshConfigFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous !== undefined && previous !== auth) throw new RemoteAgentError("SETUP_CONFLICT", "Generated SSH connection settings differ; inspect the existing file before changing authentication");
    await writeAtomic(sshConfigFile, auth, previous);
  }
  await writeAtomic(profilePath, content, old);
  const integration = await setupWorkspaceIntegration({ localRoot, workspaceId, profilePath }, true);
  return { status: "configured", localRoot, profilePath, serverName: integration.serverName, mcpServer: integration.mcpServer,
    directoryScope: input.directoryScope === "unrestricted" ? "unrestricted" : "restricted",
    hooksInstalled: true, sshVerified: false,
    ...(integration.legacyDocs ? { legacyDocs: integration.legacyDocs } : {}),
    instructions: integration.note + " Suggest adding .ssh-mcp-*.json to this project's .gitignore — they carry host and authentication parameters; setup does not edit .gitignore itself. Guidance lives in the workspace MCP's remote_help tool; legacy markdown files configure used to write are reclaimed and reported in legacyDocs when they still match known generated text. After tools load, call remote_workspace to verify SSH/runtime and read remote rules. Use the real session ID from the recovery hook. Call remote_setup again with a new bindingName whenever the user wants another remote target in this project." };
}

export async function runSetupServer(defaultSshConfigFile?: string): Promise<void> {
  const server = new McpServer({ ...SERVER_CONFIG, name: "ssh-mcp-setup" }, {
    instructions: "First call remote_setup without arguments to discover required connection/workspace information. Ask the user for missing values and call it again to configure this project. Call it again with a bindingName whenever the user wants to add another remote target to the same project; each binding gets its own MCP server and recovery hook. Existing bindings are adjustable without re-entering SSH details: action='inspect' returns a sanitized view with a revision, action='update' changes only the named policy/directoryScope/pythonPath fields. This setup service does not execute remote commands or replace ZCode hook trust. Use the generated project MCP for remote file and task operations.",
  });
  server.registerTool("remote_setup", { description: "Configure one binding to a remote SSH workspace for this project, or adjust an existing binding. Default action (or action='configure'): with missing fields returns questions for you to ask the user; with complete fields creates or updates that binding's profile, merges project MCP and recovery hooks, and prepares background CLI guidance; supply a bindingName to add another remote target alongside existing ones — repeat identical calls are safe. action='inspect': returns an existing binding's sanitized configuration, effective policy, and revision; credentials are never read or echoed. action='update': requires that revision and changes only the fields you name (policy, directoryScope, pythonPath); identity and authentication fields are rejected — configure a new bindingName for a new server or directory target. No manual setup command needed; no SSH connection during setup.",
    inputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await setupFromTool(input, defaultSshConfigFile)) }] }; }
    catch (error) {
      const known = error instanceof RemoteAgentError;
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: known ? error.code : "SETUP_FAILED",
        message: known ? error.message : "Could not prepare project integration. Check directory access and existing configuration. Retry after resolving the error.", retriable: false }) }] };
    }
  });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close()); process.stdin.once("end", () => void close());
  await server.connect(new StdioServerTransport());
}
