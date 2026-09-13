/**
 * Local driver for resumable verified transfers, both directions (#13/#14).
 *
 * Uploads (#13): the Node side owns the block loop (spec 6.2) and streams the
 * file over the helper's SSH binary stdin -- one bounded JSON control line
 * plus one chunk of raw bytes per exec exchange. Downloads (#14) reverse the
 * roles: the remote end is the sender bound to its m1- source version, and
 * this service is the receiver -- it fetches framed blocks over a binary
 * stdout channel, verifies each digest, persists to a temp file next to the
 * local target, advances the confirmed offset, and finally publishes under
 * the issue #10 overwrite contract (explicit version binding, no-clobber
 * creation, receipt after the fact). No whole-file base64 ever enters a JSON
 * request; the model never carries file bytes and never gains read coverage.
 *
 * Both ends keep small durable records. For uploads the remote record is
 * authoritative for state and the confirmed offset; this side mirrors a
 * registration under <localStateDir>/<identity[:24]>/transfers/<id>/record.json.
 * For downloads those local records are the authoritative receiver state
 * (state machine, chunk manifest, intent and receipt) while the remote keeps
 * the sender-side registration and its own bookkeeping receipt.
 *
 * Register-then-execute (issue #7 shape): transfer_register durably assigns
 * the identifier first, then start/resume/block/fetch/verify/commit only
 * accept that identifier. The start/resume budget (budgetMs) bounds one
 * driving call: when it runs out, the bounded progress returns with
 * budgetExhausted=true and a resume hint; nothing about the transfer itself
 * failed. Cancellation (issue #15) confirms the stop -- the remote lock for
 * uploads, reconciled local evidence for downloads -- before releasing any
 * uncommitted data, never rolls back a proven publication, and reports
 * unknown rather than guessing; acknowledgement consumes a terminal result
 * and is kept apart from the read-only status.
 */
import { createHash, randomUUID } from "node:crypto";
import { FileHandle, link, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join } from "node:path";
import { WorkspaceConfig } from "../config/workspace.js";
import { loadPolicy } from "../config/policy.js";
import { RemoteAgentError } from "./remote-agent-client.js";
import { FileService } from "./file-service.js";
import { SpaceLedger, workspaceLedgerDirectory } from "./space-ledger.js";

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
const TRANSFER_TTL_MS = 3 * 24 * 3600 * 1000;
/** Bounded in-drive retries for one block whose exchange or digest failed
 * transiently; the durable resume path takes over afterwards. */
const FETCH_ATTEMPTS = 3;
/** Results an acknowledgement may consume (issue #15). `unknown` is absent by
 * design: an unverified outcome must never be acknowledged into "consumed". */
const TERMINAL_TRANSFER_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** The remote surface this driver needs; satisfied by RemoteAgentClient and by
 * offline stubs (the recovery hook lists registrations without any network). */
export interface TransferRemote {
  exchange<T = Record<string, unknown>>(action: string, input: Buffer, options?: { timeoutMs?: number }): Promise<T>;
  exchangeBinary(action: string, input: Buffer, options?: { timeoutMs?: number }):
    Promise<{ control: Record<string, unknown>; payload: Buffer; result: Record<string, unknown> }>;
}

export interface PendingTransfer {
  transferId: string;
  direction: "upload" | "download";
  path: string;
  localPath: string;
  totalBytes: number;
  confirmedOffset?: number;
  state?: string;
  createdAt: string;
}

export interface UploadRequest {
  localPath: string;
  path: string;
  create?: boolean;
  overwrite?: boolean;
  expectedVersion?: string;
  chunkSize?: number;
  budgetMs?: number;
}

export interface DownloadRequest {
  path: string;
  localPath: string;
  create?: boolean;
  overwrite?: boolean;
  expectedVersion?: string;
  chunkSize?: number;
  budgetMs?: number;
}

export interface TransferOutcome {
  transferId: string;
  direction: "upload" | "download";
  state: string;
  path?: string;
  localPath: string;
  totalBytes: number;
  confirmedOffset: number;
  blocksSent?: number;
  blocksFetched?: number;
  sha256?: string;
  bytesWritten?: number;
  committedAt?: number;
  budgetExhausted?: boolean;
  message?: string;
}

/** The observed identity of a local overwrite target, scheme l1- (the local
 * twin of the remote m1- metadata version): exact size and mtime. */
function localTargetVersion(identity: { size: number; mtimeMs: number }): string {
  return `l1-${identity.size}:${identity.mtimeMs}`;
}

interface LocalTransferRecord {
  schemaVersion: 1;
  transferId: string;
  workspaceId: string;
  sessionId: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  sourceIdentity?: { size: number; mtimeMs: number };
  totalBytes: number;
  totalSha256: string;
  chunkSize: number;
  overwrite: boolean;
  create: boolean;
  expectedVersion: string | null;
  createdAt: string;
  // Download receiver state (the local side is authoritative for downloads).
  sourceVersion?: string;
  targetIdentity?: { size: number; mtimeMs: number } | null;
  tempPath?: string;
  state?: string;
  confirmedOffset?: number;
  chunkCount?: number;
  resourceId?: string | null;
  registeredAt?: number;
  startedAt?: number | null;
  lastProgressAt?: number | null;
  expiresAt?: number;
  completedAt?: number | null;
  error?: { code: string; message: string } | null;
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
  private readonly ledger: SpaceLedger;
  readonly transferRegistryIssues: Array<{ transferId: string; code: string }> = [];

  constructor(private readonly remote: TransferRemote, private readonly config: WorkspaceConfig,
    private readonly files: Pick<FileService, "call" | "localPath">) {
    const identityDirectory = join(config.localStateDir, createHash("sha256").update(config.identity).digest("hex").slice(0, 24));
    this.directory = join(identityDirectory, "transfers");
    // Download temps are local resources; the ledger is the same per-workspace
    // instrument the file tools use (issue #8). Since #16 the limit is re-read
    // from the profile on every quota check (loadPolicy), so saved policy
    // changes apply from the next operation without a restart.
    this.ledger = new SpaceLedger(join(identityDirectory, "ledger"),
      async () => (await loadPolicy(config.profilePath)).limits.localWorkspaceBytes);
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

  private async saveRecord(record: LocalTransferRecord): Promise<void> {
    await mkdir(join(this.directory, record.transferId), { recursive: true, mode: 0o700 });
    await atomicJson(join(this.directory, record.transferId, "record.json"), record);
  }

  private async digest(handle: FileHandle, size: number): Promise<string> {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(DIGEST_BUFFER);
    for (let offset = 0; offset < size;) {
      // Never read past the declared size: the temp may legitimately be
      // longer (a crash window before a heal), and an unbounded single read
      // would fold trailing bytes into the digest.
      const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!read.bytesRead) throw new RemoteAgentError("FILE_CONFLICT", "Local transfer data shrank while digesting");
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

  private validateChunk(chunkSize: number | undefined): number {
    if (typeof chunkSize !== "number" || !Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
      throw new RemoteAgentError("INVALID_REQUEST", `chunkSize must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`);
    }
    return chunkSize;
  }

  private validateBudget(budgetMs: number | undefined): number {
    if (typeof budgetMs !== "number" || !Number.isInteger(budgetMs) || budgetMs < MIN_BUDGET_MS || budgetMs > MAX_BUDGET_MS) {
      throw new RemoteAgentError("INVALID_REQUEST", `budgetMs must be between ${MIN_BUDGET_MS} and ${MAX_BUDGET_MS}`);
    }
    return budgetMs;
  }

  // --- upload direction (issue #13) -------------------------------------------

  async upload(sessionId: string, request: UploadRequest): Promise<TransferOutcome> {
    const chunkSize = this.validateChunk(request.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const budgetMs = this.validateBudget(request.budgetMs ?? DEFAULT_BUDGET_MS);
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
        expectedVersion: request.expectedVersion ?? null, createdAt: new Date().toISOString(),
        // The mirror carries the same 3-day TTL as a download receiver record
        // so the local maintenance pass can reclaim a stalled upload's
        // registration even though the remote side owns the state.
        expiresAt: Date.now() + TRANSFER_TTL_MS };
      await mkdir(join(this.directory, record.transferId), { recursive: true, mode: 0o700 });
      await atomicJson(join(this.directory, record.transferId, "record.json"), record);
      try {
        const started = await this.raw<{ state: string; confirmedOffset: number }>("transfer_start", sessionId,
          { protocol: 2, transferId: record.transferId, sourceIdentity });
        return await this.driveUpload(handle, record, sessionId, started.confirmedOffset, Date.now() + budgetMs);
      } catch (cause) {
        // The durable identifier is how the caller follows up on any break.
        if (cause instanceof Error) Object.assign(cause, { transferId: record.transferId });
        throw cause;
      }
    } finally { await handle.close(); }
  }

  /** The upload block loop plus the verify/commit tail; resumable from any offset. */
  private async driveUpload(handle: FileHandle, record: LocalTransferRecord, sessionId: string,
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
      await this.assertSourceStable(handle, record.localPath, record.sourceIdentity!);
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

  // --- download direction (issue #14) -----------------------------------------

  /** Observe the local overwrite target and enforce the explicit-version
   * contract (ADR 0008, local l1- scheme): creation refuses an existing
   * target and reports its observed version; overwrite binds to it. */
  private async checkLocalTarget(request: DownloadRequest, localPath: string):
    Promise<{ overwrite: boolean; create: boolean; expectedVersion: string | null; targetIdentity: { size: number; mtimeMs: number } | null }> {
    const overwriting = request.overwrite ?? false;
    const creating = request.create ?? false;
    if (overwriting && creating) {
      throw new RemoteAgentError("INVALID_REQUEST", "Choose create (target must be absent) or overwrite (bound to its observed version), not both");
    }
    if (overwriting && typeof request.expectedVersion !== "string") {
      throw new RemoteAgentError("INVALID_REQUEST", "overwrite requires the expectedVersion reported for the local target");
    }
    if (!overwriting && request.expectedVersion !== undefined) {
      throw new RemoteAgentError("INVALID_REQUEST", "expectedVersion only pairs with overwrite=true");
    }
    const info = await stat(localPath).catch(error => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!overwriting) {
      if (info) {
        throw new RemoteAgentError("FILE_CONFLICT",
          `Local download target already exists; to replace it re-issue with overwrite=true and expectedVersion "${localTargetVersion(info)}"`);
      }
      return { overwrite: false, create: creating, expectedVersion: null, targetIdentity: null };
    }
    if (!info) {
      throw new RemoteAgentError("FILE_CONFLICT", "Overwrite target does not exist; keep overwrite bound to an existing observed version or create instead");
    }
    if (!info.isFile()) throw new RemoteAgentError("UNSUPPORTED_FILE", "Only regular files are supported as download targets");
    const observed = localTargetVersion(info);
    if (request.expectedVersion !== observed) {
      throw new RemoteAgentError("FILE_CONFLICT",
        `Local target changed since the observed version; it is now "${observed}"`);
    }
    return { overwrite: true, create: false, expectedVersion: observed, targetIdentity: { size: info.size, mtimeMs: info.mtimeMs } };
  }

  async download(sessionId: string, request: DownloadRequest): Promise<TransferOutcome> {
    const chunkSize = this.validateChunk(request.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const budgetMs = this.validateBudget(request.budgetMs ?? DEFAULT_BUDGET_MS);
    const localPath = await this.files.localPath(request.localPath, true);
    const target = await this.checkLocalTarget(request, localPath);
    // The sender digests its own source at registration and returns the
    // observed version: nothing about the remote file is caller-asserted.
    const registration = await this.raw<{ transferId: string; totalBytes: number; sha256: string;
      sourceVersion: string }>("transfer_register", sessionId, {
      protocol: 2, direction: "download", sourcePath: request.path, targetPath: localPath,
      chunkSize, overwrite: target.overwrite, create: target.create, expectedVersion: target.expectedVersion,
    });
    const record: LocalTransferRecord = { schemaVersion: 1, transferId: registration.transferId,
      workspaceId: this.config.workspaceId, sessionId, direction: "download",
      localPath, remotePath: request.path, totalBytes: registration.totalBytes, totalSha256: registration.sha256,
      chunkSize, overwrite: target.overwrite, create: target.create, expectedVersion: target.expectedVersion,
      sourceVersion: registration.sourceVersion, targetIdentity: target.targetIdentity,
      tempPath: join(dirname(localPath), `.ssh-mcp-download-${registration.transferId}`),
      state: "prepared", confirmedOffset: 0, chunkCount: 0, resourceId: null,
      registeredAt: Date.now(), startedAt: null, lastProgressAt: null,
      expiresAt: Date.now() + TRANSFER_TTL_MS, completedAt: null, error: null,
      createdAt: new Date().toISOString() };
    await this.saveRecord(record);
    try {
      await this.raw("transfer_start", sessionId, { protocol: 2, transferId: record.transferId, sourceVersion: record.sourceVersion });
      await this.materializeDownload(record);
      return await this.driveDownload(record, sessionId, record.confirmedOffset!, Date.now() + budgetMs);
    } catch (cause) {
      if (cause instanceof Error) Object.assign(cause, { transferId: record.transferId });
      throw cause;
    }
  }

  /** Register the temp in the local ledger before it can exist (issue #8). */
  private async materializeDownload(record: LocalTransferRecord): Promise<void> {
    const { resourceId } = await this.ledger.register(record.tempPath!, record.totalBytes, "transfer-download");
    let handle: FileHandle | undefined;
    try { handle = await open(record.tempPath!, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await this.ledger.release(resourceId).catch(() => undefined);
        throw error;
      }
      // A crash leftover with the tracked name: keep it, heal re-verifies the
      // content before anything is trusted.
    }
    try {
      const info = handle ? await handle.stat() : await stat(record.tempPath!);
      await this.ledger.attachIdentity(resourceId, `${info.dev}:${info.ino}`);
    } finally { if (handle) await handle.close(); }
    record.resourceId = resourceId;
    record.state = "transferring";
    record.startedAt = record.startedAt ?? Date.now();
    await this.saveRecord(record);
  }

  /** One framed fetch with bounded transient retries. Digest and framing
   * failures of the delivered bytes are detected here (the receiver verifies
   * what actually arrived, not what the sender declared). */
  private async fetchBlock(record: LocalTransferRecord, sessionId: string,
    index: number, offset: number, length: number): Promise<Buffer> {
    const control = Buffer.from(JSON.stringify({ transferId: record.transferId, index, offset, size: length, sessionId }) + "\n", "utf8");
    let lastError: unknown;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await this.remote.exchangeBinary("transfer_fetch", control, { timeoutMs: EXCHANGE_TIMEOUT_MS });
      } catch (error) {
        const code = (error as RemoteAgentError)?.code;
        // Transient channel trouble is retried in drive; semantic refusals
        // propagate (the source-changed family also fails the durable local
        // record so the transfer cannot resurrect).
        const retriable = (error as { retriable?: boolean })?.retriable === true
          || code === "INVALID_HELPER_RESPONSE" || code === "HELPER_EXECUTION_FAILED";
        if (!retriable) {
          if (code === "TRANSFER_SOURCE_CHANGED") await this.failLocal(record, code, (error as Error).message);
          throw error;
        }
        lastError = error;
        continue;
      }
      const { control: frame, payload, result } = response;
      if (payload.length !== length
        || frame.index !== index || frame.offset !== offset
        || typeof frame.sha256 !== "string" || createHash("sha256").update(payload).digest("hex") !== frame.sha256) {
        lastError = new RemoteAgentError("BLOCK_CHECKSUM_MISMATCH", "Fetched block failed its digest or framing; refetching the block");
        continue;
      }
      if (result.confirmedOffset !== offset + length) {
        lastError = new RemoteAgentError("INVALID_HELPER_RESPONSE", "Sender confirmed an unexpected offset");
        continue;
      }
      return payload;
    }
    throw lastError;
  }

  /** The download fetch loop plus the verify/commit tail. */
  private async driveDownload(record: LocalTransferRecord, sessionId: string,
    offset: number, deadline: number): Promise<TransferOutcome> {
    const { chunkSize, totalBytes } = record;
    const handle = await open(record.tempPath!, "r+");
    let blocksFetched = 0;
    try {
      while (offset < totalBytes) {
        if (Date.now() >= deadline) {
          return { transferId: record.transferId, direction: "download", state: "transferring",
            path: record.remotePath, localPath: record.localPath, totalBytes, confirmedOffset: offset,
            blocksFetched, budgetExhausted: true,
            message: "Download budget exhausted before completion; call remote_download with action=resume and this transferId to continue from the confirmed offset" };
        }
        const index = Math.floor(offset / chunkSize);
        const length = Math.min(chunkSize, totalBytes - offset);
        const block = await this.fetchBlock(record, sessionId, index, offset, length);
        // Persist first, then confirm: the manifest line and the record only
        // advance after the bytes are on disk.
        try {
          await handle.write(block, 0, block.length, offset);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
            // A full local disk is a definite failure of this attempt: clear
            // the temp (and its registration) and rewind the transfer to zero
            // so a later resume restarts cleanly after space frees.
            await handle.close();
            await this.resetLocalTemp(record);
            await this.resetLocalProgress(record);
            throw new RemoteAgentError("STORAGE_FULL", "Local filesystem reported ENOSPC while receiving a block");
          }
          throw error;
        }
        await this.appendManifest(record, { index, offset, size: block.length,
          sha256: createHash("sha256").update(block).digest("hex") });
        offset += block.length;
        blocksFetched += 1;
        record.chunkCount = index + 1;
        record.confirmedOffset = offset;
        record.lastProgressAt = Date.now();
        record.expiresAt = Date.now() + TRANSFER_TTL_MS;
        await this.saveRecord(record);
      }
      // All blocks are persisted now, but the receiver digest, verify and
      // commit each spend up to the extended exchange timeout; when the budget
      // ran out with the last block, defer them to a resume (which skips the
      // (empty) fetch loop and goes straight to the tail).
      if (Date.now() >= deadline) {
        return { transferId: record.transferId, direction: "download", state: "transferring",
          path: record.remotePath, localPath: record.localPath, totalBytes, confirmedOffset: offset,
          blocksFetched, budgetExhausted: true,
          message: "Download budget exhausted after the last persisted block; call remote_download with action=resume and this transferId to run the final verify and commit" };
      }
      // Receiver-side whole-file digest; the remote compares the assertion to
      // the digest it streamed at registration (two-sided check, no re-read).
      const receiverDigest = await this.digest(handle, totalBytes);
      try {
        await this.raw("transfer_verify", sessionId, { protocol: 2, transferId: record.transferId, sha256: receiverDigest });
      } catch (error) {
        const code = (error as RemoteAgentError)?.code;
        await this.failLocal(record, code ?? "VERIFY_MISMATCH",
          (error as Error).message || "The download failed its final verification");
        throw error;
      }
      record.state = "verifying";
      await this.saveRecord(record);
      const receipt = await this.commitLocal(record, handle);
      await this.reconcileRemoteCompletion(record, sessionId);
      return { transferId: record.transferId, direction: "download", state: "completed",
        path: record.remotePath, localPath: record.localPath, totalBytes, confirmedOffset: totalBytes,
        blocksFetched, sha256: record.totalSha256, bytesWritten: receipt.bytes, committedAt: receipt.committedAt };
    } finally {
      // ENOSPC already closed the handle; closing twice is guarded.
      await handle.close().catch(() => undefined);
    }
  }

  private async appendManifest(record: LocalTransferRecord, entry: { index: number; offset: number; size: number; sha256: string }): Promise<void> {
    const stream = await open(join(this.directory, record.transferId, "chunks.jsonl"), "a");
    try {
      await stream.writeFile(JSON.stringify(entry) + "\n");
      await stream.sync();
    } finally { await stream.close(); }
  }

  private async readManifest(record: LocalTransferRecord): Promise<Array<{ index: number; offset: number; size: number; sha256: string }>> {
    const path = join(this.directory, record.transferId, "chunks.jsonl");
    const entries = [];
    try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { entries.push(JSON.parse(trimmed)); }
      catch { break; } // torn append tail: the manifest ends at its last complete line
    }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return entries;
  }

  /** Re-verify persisted chunks and rewind to the last trusted boundary (the
   * local twin of the remote upload heal). A missing temp restarts at zero. */
  private async healDownload(record: LocalTransferRecord): Promise<LocalTransferRecord> {
    const temp = record.tempPath!;
    const entries = await this.readManifest(record);
    let trusted = 0;
    let trustedOffset = 0;
    const handle = await open(temp, "r+").catch(async error => {
      if (!isMissing(error)) throw error;
      // Lost temp: recreate tracked from zero (the manifest follows below).
      await this.materializeDownload(record);
      return null;
    });
    if (handle) {
      try {
        for (const entry of entries) {
          if (entry.offset !== trustedOffset) break;
          let window;
          try { window = await this.digestWindow(handle, entry.offset, entry.size); }
          catch (error) {
            // Persisted bytes ended early (power loss between the manifest
            // fsync and the data blocks): rewind to the last trusted boundary
            // instead of failing the resume outright.
            if ((error as RemoteAgentError)?.code !== "TRANSFER_DATA_SHORT") throw error;
            break;
          }
          if (window !== entry.sha256) break;
          trusted += 1;
          // The trusted boundary is the sum of the verified entries' sizes
          // (the final block may be short), never trusted * chunkSize --
          // that would extend the temp past the real content when every
          // block is already confirmed.
          trustedOffset += entry.size;
        }
        const size = (await handle.stat()).size;
        if (size !== trustedOffset) {
          await handle.truncate(trustedOffset);
          await handle.sync();
        }
      } finally { await handle.close(); }
      // Keep the ledger tracking honest across the crash window.
      if (!record.resourceId) await this.materializeDownload(record).catch(() => undefined);
      else {
        const info = await stat(temp).catch(() => null);
        if (info) await this.ledger.attachIdentity(record.resourceId, `${info.dev}:${info.ino}`).catch(() => undefined);
      }
    }
    if (trusted !== record.chunkCount) {
      const kept = entries.slice(0, trusted);
      const manifest = join(this.directory, record.transferId, "chunks.jsonl");
      const temporary = `${manifest}.${randomUUID()}.tmp`;
      const stream = await open(temporary, "wx", 0o600);
      try {
        for (const entry of kept) await stream.writeFile(JSON.stringify(entry) + "\n");
        await stream.sync();
      } finally { await stream.close(); }
      await rename(temporary, manifest).catch(async error => {
        await unlink(temporary).catch(() => undefined);
        throw error;
      });
      record.chunkCount = trusted;
      record.confirmedOffset = trustedOffset;
    }
    record.state = "transferring";
    return record;
  }

  private async digestWindow(handle: FileHandle, offset: number, size: number): Promise<string> {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(DIGEST_BUFFER);
    for (let position = 0; position < size;) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, size - position), offset + position);
      if (!read.bytesRead) throw new RemoteAgentError("TRANSFER_DATA_SHORT", "Persisted transfer data ended early");
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    return digest.digest("hex");
  }

  /** Delete the temp and release its ledger registration. */
  private async resetLocalTemp(record: LocalTransferRecord): Promise<void> {
    await unlink(record.tempPath!).catch(error => { if (!isMissing(error)) throw error; });
    if (record.resourceId) {
      await this.ledger.release(record.resourceId).catch(() => undefined);
      record.resourceId = null;
    }
  }

  /** Rewind progress to zero after the temp was cleared (ENOSPC path). */
  private async resetLocalProgress(record: LocalTransferRecord): Promise<void> {
    const manifest = join(this.directory, record.transferId, "chunks.jsonl");
    await unlink(manifest).catch(error => { if (!isMissing(error)) throw error; });
    record.chunkCount = 0;
    record.confirmedOffset = 0;
    await this.saveRecord(record);
  }

  private async failLocal(record: LocalTransferRecord, code: string, message: string): Promise<void> {
    record.state = "failed";
    record.error = { code, message };
    record.completedAt = Date.now();
    await this.saveRecord(record);
  }

  /** Publish the verified temp under the explicit local target contract. */
  private async commitLocal(record: LocalTransferRecord, handle: FileHandle): Promise<{ bytes: number; committedAt: number }> {
    const info = await handle.stat();
    if (info.size !== record.totalBytes) {
      await this.failLocal(record, "VERIFY_MISMATCH", "Verified temp changed size before commit");
      throw new RemoteAgentError("VERIFY_MISMATCH", "Verified temp changed size before commit");
    }
    const tempIdentity = `${info.dev}:${info.ino}`;
    await handle.sync(); // durability point: everything the commit publishes is on disk
    const intent = { schemaVersion: 1 as const, targetPath: record.localPath,
      expectedVersion: record.expectedVersion, overwrite: record.overwrite, create: record.create,
      tempIdentity, totalSha256: record.totalSha256, totalBytes: record.totalBytes, plannedAt: Date.now() };
    await atomicJson(join(this.directory, record.transferId, "intent.json"), intent);
    record.state = "committing";
    await this.saveRecord(record);
    const target = record.localPath;
    try {
      if (record.overwrite) {
        const observed = await stat(target).catch(error => {
          if (isMissing(error)) return null;
          throw error;
        });
        const expected = record.targetIdentity!;
        if (!observed || observed.size !== expected.size || observed.mtimeMs !== expected.mtimeMs) {
          throw new RemoteAgentError("FILE_CONFLICT", "Local target changed since the observed version; refusing to overwrite");
        }
        await rename(record.tempPath!, target); // atomic replace on POSIX and Win32
      } else {
        try { await link(record.tempPath!, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new RemoteAgentError("FILE_CONFLICT", "Creation target appeared before commit");
          }
          throw error;
        }
        await unlink(record.tempPath!).catch(error => { if (!isMissing(error)) throw error; });
      }
    } catch (error) {
      const code = (error as RemoteAgentError)?.code ?? "COMMIT_FAILED";
      await this.failLocal(record, code, (error as Error).message);
      throw error;
    }
    const receipt = { bytes: record.totalBytes, committedAt: Date.now(), targetIdentity: tempIdentity };
    await atomicJson(join(this.directory, record.transferId, "receipt.json"),
      { schemaVersion: 1, ...receipt });
    if (record.resourceId) {
      await this.ledger.release(record.resourceId).catch(() => undefined);
      record.resourceId = null;
    }
    record.state = "completed";
    record.completedAt = receipt.committedAt;
    await this.saveRecord(record);
    return receipt;
  }

  /** After the receiver published, the sender records the asserted outcome so
   * the shared active slot frees; the local receipt stays authoritative. */
  private async reconcileRemoteCompletion(record: LocalTransferRecord, sessionId: string): Promise<void> {
    await this.raw("transfer_commit", sessionId, { protocol: 2, transferId: record.transferId,
      targetIdentity: null }).catch(() => undefined);
  }

  /** Complete (or reconcile) a local publication across the verify/commit tail.
   *
   * A crash between the intent and the receipt reconciles by object identity:
   * rename and link preserve the temp's dev:ino on the published target, and
   * the intent's digest confirms the content -- identical bytes under a
   * different identity are NOT proof and stay unknown (the local twin of the
   * #13 remote reconciliation). */
  private async finishLocalCommit(record: LocalTransferRecord, sessionId: string): Promise<TransferOutcome> {
    const directory = join(this.directory, record.transferId);
    if (record.state === "completed") {
      await this.reconcileRemoteCompletion(record, sessionId);
      return this.completedOutcome(record);
    }
    const receiptPath = join(directory, "receipt.json");
    const receipt = await readFile(receiptPath, "utf8")
      .then(text => JSON.parse(text) as { bytes: number; committedAt: number })
      .catch(error => { if (!isMissing(error)) throw error; return null; });
    if (receipt) {
      record.state = "completed";
      record.completedAt = receipt.committedAt;
      if (record.resourceId) {
        await this.ledger.release(record.resourceId).catch(() => undefined);
        record.resourceId = null;
      }
      await this.saveRecord(record);
      await this.reconcileRemoteCompletion(record, sessionId);
      return this.completedOutcome(record);
    }
    if (record.state === "committing") {
      const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8")) as {
        tempIdentity: string; totalSha256: string; totalBytes: number };
      const info = await stat(record.localPath).catch(error => { if (isMissing(error)) return null; throw error; });
      let matches = !!info && `${info!.dev}:${info!.ino}` === intent.tempIdentity && info!.size === intent.totalBytes;
      if (matches) {
        const target = await open(record.localPath, "r");
        try { matches = await this.digest(target, info!.size) === intent.totalSha256; }
        finally { await target.close(); }
      }
      if (!matches) {
        const message = "Commit outcome cannot be reconciled with the persisted intent; inspect the target manually";
        // Unprovable outcomes stay unknown (contracts, transfer section): not
        // failed -- an unverified result must never enter the acknowledgeable
        // set -- and not completed. The unknown record keeps its recorded TTL;
        // the local maintenance pass reclaims it once that window lapses.
        record.state = "unknown";
        record.error = { code: "TRANSFER_STATE_UNKNOWN", message };
        record.completedAt = Date.now();
        await this.saveRecord(record);
        throw new RemoteAgentError("TRANSFER_STATE_UNKNOWN", message);
      }
      const completed = { bytes: intent.totalBytes, committedAt: Date.now(), targetIdentity: intent.tempIdentity };
      await atomicJson(receiptPath, { schemaVersion: 1, ...completed });
      record.state = "completed";
      record.completedAt = completed.committedAt;
      if (record.resourceId) {
        await this.ledger.release(record.resourceId).catch(() => undefined);
        record.resourceId = null;
      }
      await this.saveRecord(record);
      await this.reconcileRemoteCompletion(record, sessionId);
      return this.completedOutcome(record);
    }
    // state verifying: both digests already agreed; publish freshly.
    const handle = await open(record.tempPath!, "r+").catch(error => {
      if (isMissing(error)) throw new RemoteAgentError("TRANSFER_STATE_UNKNOWN", "The verified temp disappeared before commit; inspect the target manually");
      throw error;
    });
    try {
      await this.commitLocal(record, handle);
    } finally { await handle.close(); }
    await this.reconcileRemoteCompletion(record, sessionId);
    return this.completedOutcome(record);
  }

  private async completedOutcome(record: LocalTransferRecord): Promise<TransferOutcome> {
    return { transferId: record.transferId, direction: "download", state: "completed",
      path: record.remotePath, localPath: record.localPath, totalBytes: record.totalBytes,
      confirmedOffset: record.totalBytes, blocksFetched: 0, sha256: record.totalSha256,
      bytesWritten: record.totalBytes, committedAt: record.completedAt ?? undefined };
  }

  // --- shared follow-up entry points ------------------------------------------

  async resume(sessionId: string, transferId: string, budgetMs?: number): Promise<TransferOutcome> {
    const budget = this.validateBudget(budgetMs ?? DEFAULT_BUDGET_MS);
    const record = await this.localRecord(transferId, sessionId);
    if (record.direction === "download") return this.resumeDownload(record, sessionId, budget);
    // The local source must still be the exact registered object before any
    // version of the transfer may continue.
    const info = await stat(record.localPath).catch(error => {
      if (isMissing(error)) throw new RemoteAgentError("FILE_CONFLICT", "Local upload source disappeared; the transfer cannot resume");
      throw error;
    });
    if (info.size !== record.sourceIdentity!.size || info.mtimeMs !== record.sourceIdentity!.mtimeMs) {
      throw new RemoteAgentError("FILE_CONFLICT", "Local upload source changed since registration; register a new transfer instead");
    }
    let state;
    try {
      state = await this.raw<{ state: string; confirmedOffset: number; totalBytes: number; sha256?: string; error?: { code: string; message: string } }>(
        "transfer_resume", sessionId, { protocol: 2, transferId, sourceIdentity: record.sourceIdentity });
    } catch (error) {
      // The remote retention (#16) may have reclaimed the registration (3-day
      // TTL since the last real progress). Converge the local mirror to a
      // terminal failure so the recovery hook stops listing a transfer that
      // can never resume, then report the refusal itself.
      if ((error as RemoteAgentError).code === "REQUEST_EXPIRED_OR_UNKNOWN") {
        await this.failLocal(record, "REQUEST_EXPIRED_OR_UNKNOWN",
          "The remote registration expired and was reclaimed; register a new transfer instead of resuming");
      }
      throw error;
    }
    // The remote registration is alive again: refresh the mirrored TTL the
    // same way the download driver refreshes it on every confirmed block.
    record.expiresAt = Date.now() + TRANSFER_TTL_MS;
    await this.saveRecord(record);
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
    if (state.state === "cancelled") {
      // A cancelled transfer never resurrects through resume (issue #15).
      return { transferId, direction: "upload", state: "cancelled", path: record.remotePath,
        localPath: record.localPath, totalBytes: record.totalBytes,
        confirmedOffset: state.confirmedOffset, blocksSent: 0,
        message: "The transfer was cancelled; register a new transfer instead of resuming" };
    }
    const handle = await open(record.localPath, "r");
    try {
      return await this.driveUpload(handle, record, sessionId, state.confirmedOffset, Date.now() + budget);
    } catch (cause) {
      if (cause instanceof Error) Object.assign(cause, { transferId });
      throw cause;
    } finally { await handle.close(); }
  }

  private async resumeDownload(record: LocalTransferRecord, sessionId: string, budget: number): Promise<TransferOutcome> {
    if (record.state === "failed" || record.state === "unknown" || record.state === "cancelled") {
      return this.stoppedOutcome(record);
    }
    if (record.state === "prepared") {
      throw new RemoteAgentError("INVALID_STATE", "This transfer never started; call the download tool with action=start again with the same target");
    }
    if (record.state === "completed" || record.state === "committing" || record.state === "verifying") {
      return this.finishLocalCommit(record, sessionId);
    }
    const state = await this.raw<{ state: string; confirmedOffset: number; error?: { code: string; message: string } }>(
      "transfer_resume", sessionId, { protocol: 2, transferId: record.transferId, sourceVersion: record.sourceVersion });
    if (state.state === "failed") {
      await this.failLocal(record, state.error?.code ?? "TRANSFER_FAILED",
        state.error?.message ?? "The sender failed the transfer");
      return this.stoppedOutcome(record);
    }
    await this.healDownload(record);
    await this.saveRecord(record);
    return this.driveDownload(record, sessionId, record.confirmedOffset!, Date.now() + budget);
  }

  async status(sessionId: string, transferId: string): Promise<Record<string, unknown> & { localPath: string }> {
    const record = await this.localRecord(transferId, sessionId);
    if (record.direction === "upload") {
      const remote = await this.raw("transfer_status", sessionId, { transferId });
      return { localPath: record.localPath, ...remote };
    }
    if (record.state === "completed") await this.reconcileRemoteCompletion(record, sessionId);
    const remote = await this.raw<{ state?: string }>("transfer_status", sessionId, { transferId }).catch(() => null);
    return { transferId, direction: "download", state: record.state, localPath: record.localPath,
      path: record.remotePath, remotePath: record.remotePath, totalBytes: record.totalBytes,
      sha256: record.totalSha256, confirmedOffset: record.confirmedOffset ?? 0,
      chunkCount: record.chunkCount ?? 0, chunkSize: record.chunkSize,
      overwrite: record.overwrite, create: record.create,
      registeredAt: record.registeredAt, expiresAt: record.expiresAt,
      completedAt: record.completedAt ?? undefined,
      error: record.error ?? undefined, remoteState: remote?.state };
  }

  // --- cancellation and acknowledgement (issue #15) -----------------------------

  /** Stop a transfer and release its uncommitted data. A request is not the
   * proof: the remote per-transfer lock (uploads) or the reconciled local
   * evidence (downloads) confirms the stop before anything is deleted, and a
   * publication the evidence proves happened is never rolled back. */
  async cancel(sessionId: string, transferId: string): Promise<TransferOutcome> {
    const record = await this.localRecord(transferId, sessionId);
    return record.direction === "upload"
      ? this.cancelUpload(record, sessionId)
      : this.cancelDownload(record, sessionId);
  }

  /** Uploads keep the received data remotely; the remote record and its lock
   * are the authority for whether the transfer actually stopped. */
  private async cancelUpload(record: LocalTransferRecord, sessionId: string): Promise<TransferOutcome> {
    let remote;
    try {
      remote = await this.raw<{ state: string; confirmedOffset?: number; sha256?: string }>(
        "transfer_cancel", sessionId, { transferId: record.transferId });
    } catch (error) {
      // A reclaimed remote registration leaves nothing to cancel; converge
      // the local mirror to a terminal failure (resume/cancel can then never
      // loop on it again) and surface the refusal.
      if ((error as RemoteAgentError).code === "REQUEST_EXPIRED_OR_UNKNOWN") {
        await this.failLocal(record, "REQUEST_EXPIRED_OR_UNKNOWN",
          "The remote registration expired and was reclaimed; nothing remains to cancel");
      }
      throw error;
    }
    return { transferId: record.transferId, direction: "upload", state: remote.state,
      path: record.remotePath, localPath: record.localPath, totalBytes: record.totalBytes,
      confirmedOffset: remote.confirmedOffset ?? 0, blocksSent: 0,
      sha256: remote.state === "completed" ? (remote.sha256 ?? record.totalSha256) : undefined,
      message: remote.state === "completed"
        ? "The transfer had already committed; the published target is not rolled back"
        : remote.state === "cancelled" ? "Transfer cancelled and its uncommitted remote data released" : undefined };
  }

  /** Downloads keep the receiver data locally; this side reconciles its own
   * commit window by evidence before releasing anything. */
  private async cancelDownload(record: LocalTransferRecord, sessionId: string): Promise<TransferOutcome> {
    const state = record.state ?? "prepared";
    if (state === "completed") return this.completedOutcome(record);
    if (state === "failed" || state === "cancelled") return this.stoppedOutcome(record);
    if (state === "unknown") {
      throw new RemoteAgentError("TRANSFER_STATE_UNKNOWN",
        "The outcome is not yet verified; inspect the target manually before cancelling");
    }
    if (state === "committing") return this.cancelCommittingDownload(record, sessionId);
    // prepared / transferring / verifying / interrupted: stop the sender first,
    // then release this side's uncommitted receiver data.
    await this.raw("transfer_cancel", sessionId, { transferId: record.transferId });
    await this.releaseReceiverData(record);
    record.state = "cancelled";
    record.error = { code: "CANCELLED", message: "Cancelled by request" };
    record.completedAt = Date.now();
    await this.saveRecord(record);
    return this.stoppedOutcome(record);
  }

  /** The commit window is resolved by evidence, never by the cancel request:
   * a receipt or an intent-matching target completes the publication, a still
   * present temp proves the publish never happened, anything else stays
   * unknown and untouched. */
  private async cancelCommittingDownload(record: LocalTransferRecord, sessionId: string): Promise<TransferOutcome> {
    const directory = join(this.directory, record.transferId);
    const receipt = await readFile(join(directory, "receipt.json"), "utf8")
      .then(text => JSON.parse(text) as { committedAt: number })
      .catch(error => { if (!isMissing(error)) throw error; return null; });
    if (receipt) {
      record.state = "completed";
      record.completedAt = receipt.committedAt;
      if (record.resourceId) {
        await this.ledger.release(record.resourceId).catch(() => undefined);
        record.resourceId = null;
      }
      await this.saveRecord(record);
      return this.completedOutcome(record);
    }
    const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8")) as {
      tempIdentity: string; totalSha256: string; totalBytes: number };
    const info = await stat(record.localPath).catch(error => { if (isMissing(error)) return null; throw error; });
    let matches = !!info && `${info!.dev}:${info!.ino}` === intent.tempIdentity && info!.size === intent.totalBytes;
    if (matches) {
      const target = await open(record.localPath, "r");
      try { matches = await this.digest(target, info!.size) === intent.totalSha256; }
      finally { await target.close(); }
    }
    if (matches) {
      // The rename already happened before the cancel arrived: the publication
      // stands and the receipt trail completes, exactly like a lost response.
      const completed = { bytes: intent.totalBytes, committedAt: Date.now(), targetIdentity: intent.tempIdentity };
      await atomicJson(join(directory, "receipt.json"), { schemaVersion: 1, ...completed });
      record.state = "completed";
      record.completedAt = completed.committedAt;
      if (record.resourceId) {
        await this.ledger.release(record.resourceId).catch(() => undefined);
        record.resourceId = null;
      }
      await this.saveRecord(record);
      return this.completedOutcome(record);
    }
    const tempExists = await stat(record.tempPath!).then(() => true, error => {
      if (isMissing(error)) return false;
      throw error;
    });
    if (!tempExists) {
      throw new RemoteAgentError("TRANSFER_STATE_UNKNOWN",
        "Cancel raced the commit window without evidence of the outcome; inspect the target manually");
    }
    // The publish never took effect and the temp is still the intent's data:
    // release it and record the stop.
    await this.raw("transfer_cancel", sessionId, { transferId: record.transferId });
    await this.releaseReceiverData(record);
    record.state = "cancelled";
    record.error = { code: "CANCELLED", message: "Cancelled by request before the pending publication" };
    record.completedAt = Date.now();
    await this.saveRecord(record);
    return this.stoppedOutcome(record);
  }

  /** Delete the uncommitted receiver temp, its manifest and ledger entry. */
  private async releaseReceiverData(record: LocalTransferRecord): Promise<void> {
    await this.resetLocalTemp(record);
    await unlink(join(this.directory, record.transferId, "chunks.jsonl"))
      .catch(error => { if (!isMissing(error)) throw error; });
  }

  /** The observed outcome of a transfer that is no longer running. */
  private stoppedOutcome(record: LocalTransferRecord): TransferOutcome {
    return { transferId: record.transferId, direction: "download", state: record.state ?? "failed",
      path: record.remotePath, localPath: record.localPath, totalBytes: record.totalBytes,
      confirmedOffset: record.confirmedOffset ?? 0, blocksFetched: 0,
      message: record.error ? `${record.error.code}: ${record.error.message}` : `The transfer stopped in state ${record.state}` };
  }

  /** Consume a terminal result (issue #15). Kept separate from status, which
   * stays a read-only observation; an unknown outcome is never acknowledged. */
  async acknowledge(sessionId: string, transferId: string): Promise<{ acknowledged: boolean; transferId: string; state: string }> {
    const record = await this.localRecord(transferId, sessionId);
    const state = record.direction === "download"
      ? record.state ?? "prepared"
      : await this.raw<{ state: string }>("transfer_status", sessionId, { transferId })
        .then(observed => observed.state)
        .catch(error => {
          // The remote registration may already be reclaimed (#16). A locally
          // converged terminal mirror is then the only authority left, and it
          // is sufficient to consume: without this fallback a converged
          // upload record could never be acknowledged at all.
          if ((error as RemoteAgentError).code !== "REQUEST_EXPIRED_OR_UNKNOWN") throw error;
          if (typeof record.state !== "string") throw error;
          return record.state;
        });
    if (state === "unknown") {
      throw new RemoteAgentError("TRANSFER_STATE_UNKNOWN", "An unverified outcome cannot be acknowledged; inspect it first");
    }
    if (!TERMINAL_TRANSFER_STATES.has(state)) {
      throw new RemoteAgentError("TRANSFER_NOT_FINISHED", "Only a terminal transfer result can be acknowledged");
    }
    // A reclaimed remote registration has nothing left to consume remotely;
    // the local ack.json is then the whole record.
    await this.raw("transfer_ack", sessionId, { transferId }).catch(error => {
      if ((error as RemoteAgentError).code !== "REQUEST_EXPIRED_OR_UNKNOWN") throw error;
    });
    await atomicJson(join(this.directory, transferId, "ack.json"),
      { schemaVersion: 1, transferId, state, acknowledgedAt: new Date().toISOString() });
    return { acknowledged: true, transferId, state };
  }

  /** This conversation's registrations whose results have not been
   * acknowledged. Local read only: safe from the recovery hook. */
  async pending(sessionId: string): Promise<PendingTransfer[]> {
    this.transferRegistryIssues.length = 0;
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const pending: PendingTransfer[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      let record: LocalTransferRecord;
      try { record = await this.localRecord(entry.name, sessionId); }
      catch (error) {
        const code = (error as RemoteAgentError).code;
        // Another session's or workspace's registration is an ordinary
        // exclusion, not a defect; anything else is a registry issue.
        if (code === "TRANSFER_SCOPE_MISMATCH") continue;
        this.transferRegistryIssues.push({ transferId: entry.name, code: code ?? "REGISTRY_CORRUPT" });
        continue;
      }
      try {
        const ack = JSON.parse(await readFile(join(this.directory, entry.name, "ack.json"), "utf8"));
        if (ack.transferId !== entry.name) throw new RemoteAgentError("REGISTRY_CORRUPT", "Invalid transfer acknowledgement");
        continue; // already consumed
      } catch (error) {
        if (!isMissing(error)) {
          // An unreadable (torn JSON) or mismatching acknowledgement is an
          // INVALID one: the transfer stays pending with the defect reported,
          // never silently treated as consumed (contracts: pending section).
          if ((error as RemoteAgentError).code === "REGISTRY_CORRUPT" || error instanceof SyntaxError) {
            this.transferRegistryIssues.push({ transferId: entry.name, code: "INVALID_ACKNOWLEDGEMENT" });
          } else {
            this.transferRegistryIssues.push({ transferId: entry.name, code: "REGISTRY_CORRUPT" });
            continue;
          }
        }
      }
      pending.push({ transferId: entry.name, direction: record.direction,
        path: record.remotePath, localPath: record.localPath, totalBytes: record.totalBytes,
        confirmedOffset: record.direction === "download" ? record.confirmedOffset : undefined,
        state: record.direction === "download" ? record.state : undefined,
        createdAt: record.createdAt });
    }
    return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
