import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceConfig } from "../config/workspace.js";
import { RemoteAgentClient, RemoteAgentError } from "./remote-agent-client.js";

export class FileService {
  constructor(private readonly remote: Pick<RemoteAgentClient, "call">, private readonly config: WorkspaceConfig) {}

  call(action: string, sessionId: string, request: Record<string, unknown> = {}) {
    if (!sessionId || sessionId.length > 256 || sessionId.includes("\0")) throw new RemoteAgentError("INVALID_SESSION", "Use the actual session identifier supplied by the recovery hook");
    return this.remote.call(action, { ...request, workspaceRoot: this.config.remoteRoot, sessionId,
      directoryScope: this.config.directoryScope,
      allowedRemotePaths: this.config.sshConfigs[this.config.connectionName].allowedRemotePaths ?? [] });
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
    throw new RemoteAgentError("PATH_NOT_ALLOWED", "Local transfer path is outside the workspace and configured allowed roots");
  }
}
