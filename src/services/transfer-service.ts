/**
 * Local driver for resumable verified upload transfers (issue #13).
 *
 * The Node side owns the block loop (spec 6.2): the model registers a
 * transfer and observes bounded progress, and this service streams the file
 * over the helper's SSH binary stdin -- one bounded JSON control line plus
 * one chunk of raw bytes per exec exchange, each with an extended per-block
 * timeout (the 30 s command default is too small for chunked exchange on a
 * slow link). No whole-file base64 ever enters a JSON request.
 *
 * Both ends keep small durable records: the remote side under
 * <remoteStateDir>/transfers/<transferId>/ is authoritative for state and the
 * confirmed offset; this side mirrors a registration under
 * <localStateDir>/<identity[:24]>/transfers/<transferId>/record.json so any
 * later process (same session) can resume by identifier, re-check the local
 * source identity (size + mtime, refusing a changed source) and continue
 * from the remote-confirmed offset without resending confirmed data.
 *
 * register-then-execute (issue #7 shape): transfer_register durably assigns
 * the identifier first, then start/resume/block/verify/commit only accept
 * that identifier. The start/resume budget (budgetMs) bounds one driving
 * call: when it runs out, the bounded progress returns with
 * budgetExhausted=true and a resume hint; nothing about the transfer itself
 * failed. Cancel/acknowledgement are issue #15 and are refused here.
 */
import { createHash, randomUUID } from "node:crypto";
import { FileHandle, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WorkspaceConfig } from "../config/workspace.js";
import { RemoteAgentClient, RemoteAgentError } from "./remote-agent-client.js";
import { FileService } from "./file-service.js";

export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_BUDGET_MS = 55_000;
export const MIN_BUDGET_MS = 1_000;
export const MAX_BUDGET_MS = 600_000;
/** Per-exchange SSH timeout for transfer actions; one block, one verify, one
 * commit each fit comfortably, where the 30 s command default would not on a
 * slow link (implementation-note risk #9). */
const EXCHANGE_TIMEOUT_MS = 60_000;
const DIGEST_BUFFER = 1024 * 1024;

export interface UploadRequest {
  localPath: string;
  path: string;
  create?: boolean;
  overwrite?: boolean;
  expectedVersion?: string;
  chunkSize?: number;
  budgetMs?: number;
}

export interface TransferOutcome {
  transferId: string;
  direction: "upload";
  state: string;
  path?: string;
  localPath: string;
  totalBytes: number;
  confirmedOffset: number;
  blocksSent: number;
  sha256?: string;
  bytesWritten?: number;
  committedAt?: number;
  budgetExhausted?: boolean;
  message?: string;
}

interface LocalTransferRecord {
  schemaVersion: 1;
  transferId: string;
  workspaceId: string;
  sessionId: string;
  direction: "upload";
  localPath: string;
  remotePath: string;
  sourceIdentity: { size: number; mtimeMs: number };
  totalBytes: number;
  totalSha256: string;
  chunkSize: number;
  overwrite: boolean;
  create: boolean;
  expectedVersion: string | null;
  createdAt: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
  }
}

/** Durable local ownership of transfer identities; the remote record stays authoritative. */
export class TransferService {
  private readonly directory: string;

  constructor(private readonly remote: RemoteAgentClient, private readonly config: WorkspaceConfig,
    private readonly files: Pick<FileService, "call" | "localPath">) {
    this.directory = join(config.localStateDir, createHash("sha256").update(config.identity).digest("hex").slice(0, 24), "transfers");
  }

  /** Issue one transfer action over the raw exchange path with the shared
   * request fields the remote boundary checks rebuild from. */
  private raw<T = Record<string, unknown>>(action: string, sessionId: string, request: Record<string, unknown>): Promise<T> {
    return this.remote.exchange<T>(action, Buffer.from(JSON.stringify({
      ...request, workspaceRoot: this.config.remoteRoot, sessionId,
      directoryScope: this.config.directoryScope,
      allowedRemotePaths: this.config.sshConfigs[this.config.connectionName].allowedRemotePaths ?? [],
    }), "utf8"), { timeoutMs: EXCHANGE_TIMEOUT_MS });
  }

  private async localRecord(transferId: string, sessionId: string): Promise<LocalTransferRecord> {
    if (!/^[a-f0-9]{32}$/.test(transferId)) throw new RemoteAgentError("TRANSFER_NOT_FOUND", "No local registration for this transfer");
    let record: LocalTransferRecord;
    try { record = JSON.parse(await readFile(join(this.directory, transferId, "record.json"), "utf8")); }
    catch (error) {
      if (isMissing(error)) throw new RemoteAgentError("TRANSFER_NOT_FOUND", "No local registration for this transfer");
      throw new RemoteAgentError("REGISTRY_CORRUPT", "Could not read the transfer registration");
    }
    if (record.schemaVersion !== 1 || record.workspaceId !== this.config.workspaceId || record.transferId !== transferId) {
      throw new RemoteAgentError("TRANSFER_SCOPE_MISMATCH", "Transfer registration does not match this workspace");
    }
    if (record.sessionId !== sessionId) throw new RemoteAgentError("TRANSFER_SCOPE_MISMATCH", "Transfer belongs to another conversation");
    return record;
  }

  private async digest(handle: FileHandle, size: number): Promise<string> {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(DIGEST_BUFFER);
    for (let offset = 0; offset < size;) {
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (!read.bytesRead) throw new RemoteAgentError("FILE_CONFLICT", "Local upload source shrank while digesting");
      digest.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    return digest.digest("hex");
  }

  private async assertSourceStable(handle: FileHandle, localPath: string, identity: { size: number; mtimeMs: number }): Promise<void> {
    const [fdInfo, pathInfo] = [await handle.stat(), await stat(localPath)];
    if (fdInfo.size !== identity.size || fdInfo.mtimeMs !== identity.mtimeMs
      || pathInfo.size !== identity.size || pathInfo.mtimeMs !== identity.mtimeMs) {
      throw new RemoteAgentError("FILE_CONFLICT", "Local upload source changed while transferring; register a new transfer instead of mixing versions");
    }
  }

  async upload(sessionId: string, request: UploadRequest): Promise<TransferOutcome> {
    const chunkSize = request.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
      throw new RemoteAgentError("INVALID_REQUEST", `chunkSize must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`);
    }
    const budgetMs = request.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isInteger(budgetMs) || budgetMs < MIN_BUDGET_MS || budgetMs > MAX_BUDGET_MS) {
      throw new RemoteAgentError("INVALID_REQUEST", `budgetMs must be between ${MIN_BUDGET_MS} and ${MAX_BUDGET_MS}`);
    }
    const localPath = await this.files.localPath(request.localPath, false);
    const handle = await open(localPath, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new RemoteAgentError("UNSUPPORTED_FILE", "Upload requires a regular local file");
      const sourceIdentity = { size: info.size, mtimeMs: info.mtimeMs };
      const totalSha256 = await this.digest(handle, info.size);
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
        throw new RemoteAgentError("FILE_CONFLICT", "Local upload source changed while digesting; register again after it settles");
      }
      // Registration is durable on both ends before the first byte moves, so
      // a lost response can never anchor a duplicate transfer.
      const registration = await this.raw<{ transferId: string }>("transfer_register", sessionId, {
        protocol: 2, direction: "upload", targetPath: request.path,
        chunkSize, totalBytes: info.size, totalSha256, sourceIdentity,
        overwrite: request.overwrite ?? false, create: request.create ?? false,
        expectedVersion: request.expectedVersion,
      });
      const record: LocalTransferRecord = { schemaVersion: 1, transferId: registration.transferId,
        workspaceId: this.config.workspaceId, sessionId, direction: "upload",
        localPath, remotePath: request.path, sourceIdentity, totalBytes: info.size, totalSha256,
        chunkSize, overwrite: request.overwrite ?? false, create: request.create ?? false,
        expectedVersion: request.expectedVersion ?? null, createdAt: new Date().toISOString() };
      await mkdir(join(this.directory, record.transferId), { recursive: true, mode: 0o700 });
      await atomicJson(join(this.directory, record.transferId, "record.json"), record);
      try {
        const started = await this.raw<{ state: string; confirmedOffset: number }>("transfer_start", sessionId,
          { protocol: 2, transferId: record.transferId, sourceIdentity });
        return await this.drive(handle, record, sessionId, started.confirmedOffset, Date.now() + budgetMs);
      } catch (cause) {
        // The durable identifier is how the caller follows up on any break.
        if (cause instanceof Error) Object.assign(cause, { transferId: record.transferId });
        throw cause;
      }
    } finally { await handle.close(); }
  }

  async resume(sessionId: string, transferId: string, budgetMs?: number): Promise<TransferOutcome> {
    const budget = budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isInteger(budget) || budget < MIN_BUDGET_MS || budget > MAX_BUDGET_MS) {
      throw new RemoteAgentError("INVALID_REQUEST", `budgetMs must be between ${MIN_BUDGET_MS} and ${MAX_BUDGET_MS}`);
    }
    const record = await this.localRecord(transferId, sessionId);
    // The local source must still be the exact registered object before any
    // version of the transfer may continue.
    const info = await stat(record.localPath).catch(error => {
      if (isMissing(error)) throw new RemoteAgentError("FILE_CONFLICT", "Local upload source disappeared; the transfer cannot resume");
      throw error;
    });
    if (info.size !== record.sourceIdentity.size || info.mtimeMs !== record.sourceIdentity.mtimeMs) {
      throw new RemoteAgentError("FILE_CONFLICT", "Local upload source changed since registration; register a new transfer instead");
    }
    const state = await this.raw<{ state: string; confirmedOffset: number; totalBytes: number; sha256?: string; error?: { code: string; message: string } }>(
      "transfer_resume", sessionId, { protocol: 2, transferId, sourceIdentity: record.sourceIdentity });
    if (state.state === "completed") {
      return { transferId, direction: "upload", state: "completed", path: record.remotePath, localPath: record.localPath,
        totalBytes: record.totalBytes, confirmedOffset: record.totalBytes, blocksSent: 0,
        sha256: record.totalSha256, bytesWritten: record.totalBytes };
    }
    if (state.state === "failed") {
      return { transferId, direction: "upload", state: "failed", localPath: record.localPath,
        totalBytes: record.totalBytes, confirmedOffset: state.confirmedOffset, blocksSent: 0,
        message: state.error ? `${state.error.code}: ${state.error.message}` : "The transfer failed its final verification" };
    }
    const handle = await open(record.localPath, "r");
    try {
      return await this.drive(handle, record, sessionId, state.confirmedOffset, Date.now() + budget);
    } catch (cause) {
      if (cause instanceof Error) Object.assign(cause, { transferId });
      throw cause;
    } finally { await handle.close(); }
  }

  async status(sessionId: string, transferId: string): Promise<Record<string, unknown> & { localPath: string }> {
    await this.localRecord(transferId, sessionId);
    const remote = await this.raw("transfer_status", sessionId, { transferId });
    return { localPath: (await this.localRecord(transferId, sessionId)).localPath, ...remote };
  }

  /** The block loop plus the verify/commit tail; resumable from any offset. */
  private async drive(handle: FileHandle, record: LocalTransferRecord, sessionId: string,
    offset: number, deadline: number): Promise<TransferOutcome> {
    const { chunkSize, totalBytes } = record;
    const buffer = Buffer.alloc(chunkSize);
    let blocksSent = 0;
    while (offset < totalBytes) {
      if (Date.now() >= deadline) {
        return { transferId: record.transferId, direction: "upload", state: "transferring",
          path: record.remotePath, localPath: record.localPath, totalBytes, confirmedOffset: offset,
          blocksSent, budgetExhausted: true,
          message: "Upload budget exhausted before completion; call remote_upload with action=resume and this transferId to continue from the confirmed offset" };
      }
      await this.assertSourceStable(handle, record.localPath, record.sourceIdentity);
      const length = Math.min(chunkSize, totalBytes - offset);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead !== length) throw new RemoteAgentError("FILE_CONFLICT", "Local upload source shrank while transferring");
      const block = buffer.subarray(0, length);
      const control = Buffer.from(JSON.stringify({ transferId: record.transferId, index: Math.floor(offset / chunkSize),
        offset, size: length, sha256: createHash("sha256").update(block).digest("hex"), sessionId }) + "\n", "utf8");
      const confirmed = await this.remote.exchange<{ confirmedOffset: number }>("transfer_block",
        Buffer.concat([control, block]), { timeoutMs: EXCHANGE_TIMEOUT_MS });
      if (confirmed.confirmedOffset !== offset + length) {
        throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Remote confirmed an unexpected offset");
      }
      offset = confirmed.confirmedOffset;
      blocksSent += 1;
    }
    // All blocks are confirmed now, but verify and commit each spend up to a
    // full exchange timeout (60 s apiece); running them past the deadline
    // would let one call overshoot budgetMs by up to two exchanges. With the
    // budget already spent, return bounded progress instead -- resume skips
    // the (empty) block loop and goes straight to verify/commit.
    if (Date.now() >= deadline) {
      return { transferId: record.transferId, direction: "upload", state: "transferring",
        path: record.remotePath, localPath: record.localPath, totalBytes, confirmedOffset: offset,
        blocksSent, budgetExhausted: true,
        message: "Upload budget exhausted after the last confirmed block; call remote_upload with action=resume and this transferId to run the final verify and commit" };
    }
    // Both ends now hold the same full content; verify streams the digest
    // remotely, commit publishes through the issue #10 skeleton.
    await this.raw("transfer_verify", sessionId, { protocol: 2, transferId: record.transferId });
    const committed = await this.raw<{ path: string; bytesWritten: number; sha256: string; committedAt: number }>(
      "transfer_commit", sessionId, { protocol: 2, transferId: record.transferId });
    return { transferId: record.transferId, direction: "upload", state: "completed",
      path: committed.path, localPath: record.localPath, totalBytes, confirmedOffset: totalBytes,
      blocksSent, sha256: committed.sha256, bytesWritten: committed.bytesWritten, committedAt: committed.committedAt };
  }
}
