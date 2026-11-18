import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceConfig } from "../config/workspace.js";
import { loadPolicy } from "../config/policy.js";
import { RemoteAgentClient, RemoteAgentError } from "./remote-agent-client.js";

export class FileService {
  constructor(private readonly remote: Pick<RemoteAgentClient, "call">, private readonly config: WorkspaceConfig) {}

  async call(action: string, sessionId: string, request: Record<string, unknown> = {}) {
    if (!sessionId || sessionId.length > 256 || sessionId.includes("\0")) throw new RemoteAgentError("INVALID_SESSION", "Use the actual session identifier supplied by the recovery hook");
    const connection = this.config.sshConfigs[this.config.connectionName];
    const scoped = { ...request, workspaceRoot: this.config.remoteRoot, sessionId,
      directoryScope: this.config.directoryScope,
      allowedRemotePaths: connection.allowedRemotePaths ?? [] };
    if (action !== "file_find" && action !== "file_search") return this.remote.call(action, scoped);

    const { search: { scanBudgetBytes, timeBudgetMs } } = await loadPolicy(this.config.profilePath);
    // Older profiles stored positive integers without the discovery helper's
    // bounds. Reject unsupported values for discovery, not for the binding.
    if (scanBudgetBytes < 64 * 1024 || scanBudgetBytes > 2 * 1024 ** 3) {
      throw new RemoteAgentError("INVALID_CONFIG", "policy.search.scanBudgetBytes must be between 65536 and 2147483648");
    }
    if (timeBudgetMs < 1_000 || timeBudgetMs > 60_000) {
      throw new RemoteAgentError("INVALID_CONFIG", "policy.search.timeBudgetMs must be between 1000 and 60000");
    }
    // Leave room for the helper's up-to-10 s backend drain and 2 s process
    // wait. An explicit connection cap still takes priority.
    const timeoutMs = timeBudgetMs + 15_000;
    const options = connection.commandTimeoutMs === undefined && timeoutMs > 30_000 ? { timeoutMs } : undefined;
    return this.remote.call(action, { ...scoped, scanBudgetBytes, scanBudgetMs: timeBudgetMs }, options);
  }

  /** Resolve and boundary-check a local transfer path (shared with the
   * transfer driver since issue #13; the old buffered upload path is gone,
   * and since issue #14 downloads are transactional transfers too). */
  async localPath(value: string, writing: boolean): Promise<string> {
    const absolute = resolve(this.config.localRoot, value);
    const parent = dirname(absolute);
    let canonical: string;
    try { canonical = await realpath(absolute); }
    catch (error) {
      if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = join(await realpath(parent), relative(parent, absolute));
    }
    const roots = [this.config.localRoot, ...(this.config.sshConfigs[this.config.connectionName].allowedLocalPaths ?? [])];
    for (const root of roots) {
      const base = await realpath(resolve(root));
      const child = relative(base, canonical);
      if (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep)) {
        if (writing) {
          try { if ((await lstat(absolute)).isSymbolicLink()) throw new RemoteAgentError("UNSUPPORTED_LINK", "Download destination must not be a symlink"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        return canonical;
      }
    }
    throw new RemoteAgentError("PATH_NOT_ALLOWED", `Local transfer path ${canonical} is outside the allowed roots: ${roots.join(", ")}. Place the source in the local workspace (${this.config.localRoot}), or configure a specific allowedLocalPaths root; temporary directories are not allowed automatically`);
  }
}
