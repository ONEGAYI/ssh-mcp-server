import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { clientSchema, loadWorkspaceConfig, WorkspaceClient, WorkspaceConfig } from "../config/workspace.js";
import { createWorkspaceRuntime } from "./workspace-runtime.js";
import { FileService } from "./file-service.js";
import { RemoteAgentError } from "./remote-agent-client.js";

interface ContextRuntime { files: Pick<FileService, "call">; close(): void }

async function openWorkspace(profilePath: string): Promise<ContextRuntime> {
  const runtime = await createWorkspaceRuntime(profilePath);
  return { files: new FileService(runtime.remote, runtime.config), close: runtime.close };
}

async function collect(config: WorkspaceConfig, client: WorkspaceClient, sessionId: string,
  files: ContextRuntime["files"], stopped: () => boolean) {
  const lines = [
    `远端规则与技能：绑定 ${config.bindingName ?? config.workspaceId}；工作区 ${config.workspaceId}；远端根 ${config.remoteRoot}；宿主 ${client}。`,
    "以下内容仅适用于这个远端绑定，不适用于本机或其他绑定。技能列表只包含名称、描述和远端路径；任务匹配时先用该绑定的 remote_read 读取 SKILL.md，再按需读取其引用文件。路径按远端目录解释。",
  ];
  const append = (text: string) => {
    lines.push(text);
    if (Buffer.byteLength(lines.join("\n"), "utf8") > config.sessionStart.maxBytes) {
      throw new RemoteAgentError("CONTEXT_TOO_LARGE", "Remote context exceeded the configured byte limit");
    }
  };
  const call = async (action: string, request: Record<string, unknown>) => {
    if (stopped()) throw new RemoteAgentError("CONTEXT_TIMEOUT", "Session context timed out");
    return files.call(action, sessionId, request) as Promise<any>;
  };
  const read = (path: string) => call("file_read", { path, maxBytes: config.sessionStart.maxBytes, grantRead: false });
  const issue = (path: string, error: unknown) => {
    const code = error instanceof RemoteAgentError ? error.code : "CONTEXT_READ_FAILED";
    if (code === "CONTEXT_TOO_LARGE" || code === "CONTEXT_TIMEOUT") throw error;
    append(`未加载 ${posix.join(config.remoteRoot, path)}：${code}。需要时用 remote_read/remote_list 核实。`);
  };
  try {
    const result = await read("AGENTS.md");
    if (result.truncated) throw new RemoteAgentError("CONTEXT_TOO_LARGE", "AGENTS.md exceeds the context budget");
    append(`远端 AGENTS.md（${posix.join(config.remoteRoot, "AGENTS.md")}）：\n${result.text}`);
  } catch (error) { issue("AGENTS.md", error); }
  const directories = [".agents/skills", ...(client === "zcode" ? [".zcode/skills"] : [])];
  for (const directory of directories) {
    let listing;
    try { listing = await call("file_list", { path: directory, limit: 100 }); }
    catch (error) { issue(directory, error); continue; }
    append(`远端技能目录 ${posix.join(config.remoteRoot, directory)}：`);
    for (const entry of listing.entries) {
      if (entry.type !== "directory" && entry.type !== "symlink") continue;
      const path = posix.join(directory, posix.basename(entry.path), "SKILL.md");
      try {
        const result = await read(path);
        const header = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(result.text);
        if (!header) throw new RemoteAgentError("INVALID_SKILL_METADATA", "Missing or oversized skill frontmatter");
        let metadata;
        try { metadata = parseYaml(header[1], { maxAliasCount: 0 }); }
        catch { throw new RemoteAgentError("INVALID_SKILL_METADATA", "Skill frontmatter is invalid YAML"); }
        if (!metadata || typeof metadata.name !== "string" || !metadata.name.trim() ||
            typeof metadata.description !== "string" || !metadata.description.trim()) {
          throw new RemoteAgentError("INVALID_SKILL_METADATA", "Skill name and description must be nonempty text");
        }
        append(JSON.stringify({ name: metadata.name, description: metadata.description, path: posix.join(config.remoteRoot, path) }));
      } catch (error) { issue(path, error); }
    }
    if (listing.truncated) append(`技能目录未列全：${posix.join(config.remoteRoot, directory)}。用 remote_list 继续查询。`);
  }
  return lines.join("\n");
}

/** Public hook seam: disabled/unrelated invocations stay offline. Each event
 * reloads the profile; no cached context or session-wide dedup hides compact. */
export async function sessionStartContext(profilePath: string, client: WorkspaceClient, input: any,
  open: (profilePath: string) => Promise<ContextRuntime> = openWorkspace) {
  clientSchema.parse(client);
  if (input.hook_event_name !== "SessionStart" || typeof input.cwd !== "string" || !isAbsolute(input.cwd) ||
      typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 256 || input.session_id.includes("\0")) return {};
  const config = await loadWorkspaceConfig(profilePath);
  if (!config.sessionStart.enabled || !config.clients.includes(client)) return {};
  const within = relative(await realpath(config.localRoot), await realpath(resolve(input.cwd)));
  if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep)) return {};
  const runtime = await open(profilePath);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stopped = true; reject(new RemoteAgentError("CONTEXT_TIMEOUT", "Remote context timed out")); }, config.sessionStart.timeoutMs);
    });
    const context = await Promise.race([collect(config, client, input.session_id, runtime.files, () => stopped), timeout]);
    const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
    if (Buffer.byteLength(JSON.stringify(output)) > 32768) throw new RemoteAgentError("CONTEXT_TOO_LARGE", "Encoded hook output exceeds the client limit");
    return output;
  } catch (error) {
    const code = error instanceof RemoteAgentError ? error.code : "CONTEXT_READ_FAILED";
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext:
      `远端绑定 ${config.bindingName ?? config.workspaceId} 的规则与技能上下文未完整加载：${code}。本次未注入文件内容。检查 sessionStart 配置，或用该绑定的 remote_read/remote_list 手工读取 AGENTS.md 和技能。` } };
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    runtime.close();
  }
}
