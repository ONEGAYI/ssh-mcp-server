import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, resolve } from "node:path";
import { CommandLineParser } from "../cli/command-line-parser.js";
import { RemoteAgentError } from "../services/remote-agent-client.js";
import { setupWorkspaceIntegration, writeAtomic } from "../services/workspace-setup.js";
import { SERVER_CONFIG } from "../config/server.js";

const optionalPath = z.string().min(1).optional();
const bindingNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const inputSchema = {
  bindingName: z.string().regex(bindingNamePattern).optional().describe("Unique lowercase binding name for this local project when several remote targets coexist, e.g. eda-main; omit for the legacy single binding"),
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

export async function configureFromTool(input: SetupInput, defaultSshConfigFile?: string) {
  // Explicit per-call SSH settings override the setup service's preset library.
  if (!input.sshConfigFile && !input.host && !input.username && !input.privateKey && !input.sshAgent && !input.port && defaultSshConfigFile) {
    input = { ...input, sshConfigFile: defaultSshConfigFile };
  }
  const questions: Array<{ fields: string[]; question: string }> = [];
  if (input.bindingName !== undefined && !bindingNamePattern.test(input.bindingName)) {
    throw new RemoteAgentError("SETUP_INVALID_BINDING", "bindingName must be 1-64 lowercase letters, digits, or hyphens and start with a letter or digit; this keeps binding files unambiguous on case-insensitive systems");
  }
  if (input.directoryScope !== undefined && input.directoryScope !== "restricted" && input.directoryScope !== "unrestricted") {
    throw new RemoteAgentError("SETUP_INVALID_SCOPE", "directoryScope must be 'restricted' or 'unrestricted'; an unrestricted scope requires the user's explicit decision, never a default");
  }
  if (!input.localRoot) questions.push({ fields: ["localRoot"], question: "用哪个本机绝对路径作为 ZCode 工作区？请选择独立项目目录。" });
  if (!input.remoteRoot || !input.remoteStateDir) questions.push({ fields: ["remoteRoot", "remoteStateDir"], question: "远端 Linux 的源码目录和可写的持久状态目录分别是什么？均需绝对路径。" });
  if (input.sshConfigFile && (input.host || input.username || input.privateKey || input.sshAgent || input.port)) {
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
    try { names = Object.keys(CommandLineParser.parseArgs(["--config-file", input.sshConfigFile]).configs); }
    catch { throw new RemoteAgentError("SETUP_INVALID_SSH_CONFIG", "Could not load the SSH config; check the file path and config format without sharing its credentials"); }
    if (!connectionName && names.length === 1) connectionName = names[0];
    connections = names;
    if (!connectionName) questions.push({ fields: ["connectionName"], question: `选择连接名：${names.slice(0, 20).join("、")}` });
    else if (!names.includes(connectionName)) throw new RemoteAgentError("SETUP_INVALID_CONNECTION", "The selected connection does not exist in the SSH config");
  }
  if (questions.length) return { status: "needs_input", questions, connections,
    instructions: "Ask the user for these missing values, reuse already confirmed information, then call remote_setup again with the complete fields. Never ask for passwords or private-key contents in chat. Nothing was written and no SSH connection was made." };
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
    ...(input.localStateDir ? { localStateDir: input.localStateDir } : {}) };
  const content = JSON.stringify(profile, null, 2) + "\n";
  // Dry-run integration first: a rejected binding must not leave a profile file behind.
  await setupWorkspaceIntegration({ localRoot, workspaceId, profilePath }, false);
  let old: string | undefined;
  try { old = await readFile(profilePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (old !== undefined && old !== content) throw new RemoteAgentError("SETUP_CONFLICT", "This project already has a different workspace profile. Inspect it before changing the target; choose an empty local project for a new target");
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
    hooksInstalled: true, sshVerified: false, instructions: integration.note + " After tools load, call remote_workspace to verify SSH/runtime and read remote rules. Use the real session ID from the recovery hook." };
}

export async function runSetupServer(defaultSshConfigFile?: string): Promise<void> {
  const server = new McpServer({ ...SERVER_CONFIG, name: "ssh-mcp-setup" }, {
    instructions: "First call remote_setup without arguments to discover required connection/workspace information. Ask the user for missing values and call it again to configure this project. This setup service does not execute remote commands or replace ZCode hook trust. Use the generated project MCP for remote file and task operations.",
  });
  server.registerTool("remote_setup", { description: "First-time setup for a ZCode SSH workspace. With missing fields, returns questions for you to ask the user. With complete fields, creates a local workspace profile, merges project MCP and recovery hooks, and prepares background CLI guidance. No manual setup command needed; no SSH connection during setup.",
    inputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await configureFromTool(input, defaultSshConfigFile)) }] }; }
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
