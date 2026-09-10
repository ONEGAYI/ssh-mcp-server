import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceConfig } from "../config/workspace.js";
import { RemoteAgentClient, RemoteAgentError } from "./remote-agent-client.js";

interface ReadResult {
  data: string; version: string; nextOffset: number | null; readToken: string; size: number;
}

export class FileService {
  constructor(private readonly remote: Pick<RemoteAgentClient, "call">, private readonly config: WorkspaceConfig) {}

  call(action: string, sessionId: string, request: Record<string, unknown> = {}) {
    if (!sessionId || sessionId.length > 256 || sessionId.includes("\0")) throw new RemoteAgentError("INVALID_SESSION", "Use the actual session identifier supplied by the recovery hook");
    return this.remote.call(action, { ...request, workspaceRoot: this.config.remoteRoot, sessionId,
      allowedRemotePaths: this.config.sshConfigs[this.config.connectionName].allowedRemotePaths ?? [] });
  }

  private async localPath(value: string, writing: boolean): Promise<string> {
    const absolute = resolve(this.config.localRoot, value);
    let canonical: string;
    try { canonical = await realpath(absolute); }
    catch (error) {
      if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = join(await realpath(dirname(absolute)), relative(dirname(absolute), absolute));
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

  async upload(sessionId: string, request: { localPath: string; path: string; create?: boolean; readToken?: string }) {
    const path = await this.localPath(request.localPath, false);
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new RemoteAgentError("FILE_TOO_LARGE", "Upload requires a regular file up to 16 MiB");
      const data = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < data.length) {
        const result = await handle.read(data, size, data.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      const after = await handle.stat();
      if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
        throw new RemoteAgentError("FILE_CONFLICT", "Local upload source changed while reading");
      }
      return this.call("file_write", sessionId, { path: request.path, create: request.create, readToken: request.readToken, data: data.subarray(0, size).toString("base64") });
    } finally { await handle.close(); }
  }

  async download(sessionId: string, request: { localPath: string; path: string; overwrite?: boolean }) {
    const path = await this.localPath(request.localPath, true);
    const temporary = join(dirname(path), `.ssh-mcp-download-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    let offset = 0, version: string | undefined;
    try {
      for (;;) {
        const result = await this.call("file_read", sessionId, { path: request.path, encoding: "base64", offset, maxBytes: 262144, grantRead: false }) as unknown as ReadResult;
        if (version !== undefined && result.version !== version) throw new RemoteAgentError("FILE_CONFLICT", "Remote download source changed between chunks");
        version = result.version;
        const data = Buffer.from(result.data, "base64");
        if (offset + data.length > 16 * 1024 * 1024) throw new RemoteAgentError("FILE_TOO_LARGE", "Download exceeds 16 MiB");
        await handle.writeFile(data);
        offset += data.length;
        if (result.nextOffset === null) break;
        if (result.nextOffset !== offset || !data.length) throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Invalid download cursor");
      }
      await handle.sync();
      await handle.close();
      if (await this.localPath(request.localPath, true) !== path) throw new RemoteAgentError("FILE_CONFLICT", "Local destination changed");
      if (request.overwrite) await rename(temporary, path);
      else {
        try { await link(temporary, path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RemoteAgentError("FILE_CONFLICT", "Local download target already exists");
          throw error;
        }
      }
      return { localPath: path, remotePath: request.path, bytesWritten: offset, version };
    } finally {
      await handle.close();
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
