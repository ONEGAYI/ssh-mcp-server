import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { identityStateDirectory } from "../config/workspace.js";
import { RemoteAgentError } from "./remote-agent-client.js";

interface RemoteCaller {
  call<T = Record<string, unknown>>(action: string, request: Record<string, unknown>): Promise<T>;
}

export interface RemoteTask {
  jobId: string;
  state: "prepared" | "starting" | "running" | "exited" | "cancelled" | "interrupted" | "unknown";
  exitCode?: number;
  completedAt?: number;
  reason?: string;
  cancelRequested?: boolean;
  eventId?: string;
}

export interface TaskRequest {
  sessionId: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface TaskRecord extends TaskRequest {
  schemaVersion: 1;
  /** Marker for tasks created through the register-then-execute protocol (v2). */
  protocol?: 2;
  jobId: string;
  workspaceId: string;
  createdAt: string;
}

interface OutputChunk {
  data: string;
  nextOffset: number;
  hasMore: boolean;
}

interface TaskOutput {
  jobId: string;
  state: RemoteTask["state"];
  terminal: boolean;
  stdout: OutputChunk;
  stderr: OutputChunk;
}

const TERMINAL = new Set(["exited", "cancelled", "interrupted"]);

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
  } finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
}

const WAIT_ELAPSED = Symbol("wait elapsed");
async function observedBefore<T>(operation: Promise<T>, deadline: number): Promise<T | typeof WAIT_ELAPSED> {
  if (!Number.isFinite(deadline)) return operation;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<typeof WAIT_ELAPSED>(resolve => {
      timer = setTimeout(() => resolve(WAIT_ELAPSED), Math.max(0, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Durable local ownership and result acknowledgement; remote execution remains authoritative. */
export class TaskService {
  private readonly directory: string;
  readonly registryIssues: Array<{ jobId: string; code: string }> = [];

  constructor(private readonly remote: RemoteCaller, stateDirectory: string, private readonly workspaceId: string) {
    if (!isAbsolute(stateDirectory)) throw new RemoteAgentError("INVALID_CONFIG", "Local state directory must be absolute");
    this.directory = join(identityStateDirectory(stateDirectory, workspaceId), "tasks");
  }

  private taskPath(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(jobId)) throw new RemoteAgentError("INVALID_JOB_ID", "Invalid task identifier");
    return join(this.directory, jobId);
  }

  async record(jobId: string): Promise<TaskRecord> {
    let record: TaskRecord;
    try { record = JSON.parse(await readFile(join(this.taskPath(jobId), "record.json"), "utf8")); }
    catch (error) {
      if (isMissing(error)) throw new RemoteAgentError("JOB_NOT_FOUND", "No local registration for this task");
      throw new RemoteAgentError("REGISTRY_CORRUPT", "Could not read the task registration");
    }
    if (record.schemaVersion !== 1 || record.jobId !== jobId || record.workspaceId !== this.workspaceId) {
      throw new RemoteAgentError("TASK_SCOPE_MISMATCH", "Task registration does not match this workspace");
    }
    return record;
  }

  async start(request: TaskRequest): Promise<TaskRecord> {
    if (!request.sessionId || request.sessionId.includes("\0")) throw new RemoteAgentError("INVALID_SESSION", "A real owner session identifier is required");
    // Register before executing: the remote side durably assigns the task
    // identifier first, so a lost response cannot anchor a duplicate retry.
    // Any failure here (parameter validation, drain gate, connection loss)
    // leaves no local record and has caused no execution side effect.
    const registration = await this.remote.call<{ jobId: string }>("task_register", {
      protocol: 2, command: request.command, cwd: request.cwd, env: request.env ?? {},
      executionTimeoutMs: request.executionTimeoutMs, maxOutputBytes: request.maxOutputBytes,
    });
    if (!registration?.jobId || typeof registration.jobId !== "string") {
      throw new RemoteAgentError("INVALID_HELPER_RESPONSE", "Registration did not return a task identifier");
    }
    const record: TaskRecord = { ...request, env: request.env ?? {}, schemaVersion: 1, protocol: 2,
      jobId: registration.jobId, workspaceId: this.workspaceId, createdAt: new Date().toISOString() };
    const directory = this.taskPath(record.jobId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Registration is durable on both sides before the first execution side effect.
    await atomicJson(join(directory, "record.json"), record);
    try {
      await this.remote.call("task_start", { protocol: 2, jobId: record.jobId });
      await atomicJson(join(directory, "started.json"), { confirmed: true });
    } catch (cause) {
      const rejected = await this.saveRejection(record.jobId, cause);
      const error = new RemoteAgentError(rejected ? "START_REJECTED" : "START_UNCONFIRMED", rejected
        ? `Task ${record.jobId} was rejected before execution: ${(cause as Error).message}`
        : `Task ${record.jobId} was registered, but its remote startup must be reconciled`);
      Object.assign(error, { jobId: record.jobId, cause });
      throw error;
    }
    return record;
  }

  private async saveRejection(jobId: string, error: unknown): Promise<boolean> {
    // These codes are emitted before any new remote execution exists.
    if (!(error instanceof RemoteAgentError) || !["INVALID_COMMAND", "INVALID_CWD", "INVALID_ENV",
      "INVALID_TIMEOUT", "INVALID_LIMIT", "REQUEST_EXPIRED_OR_UNKNOWN"].includes(error.code)) return false;
    await atomicJson(join(this.taskPath(jobId), "rejected.json"), { jobId, state: "interrupted", reason: "START_REJECTED", errorCode: error.code, completedAt: Date.now() / 1000 });
    return true;
  }

  private async rejection(jobId: string): Promise<RemoteTask | undefined> {
    try { return JSON.parse(await readFile(join(this.taskPath(jobId), "rejected.json"), "utf8")); }
    catch (error) { if (!isMissing(error)) throw error; return undefined; }
  }

  /** Replay only an already registered request with the same ID. The remote claim
   * reconciles ambiguity and never starts a second copy of an existing task.
   * Protocol-v2 records replay through task_start; legacy records keep the
   * legacy full-request replay entry. */
  async reconcile(jobId: string): Promise<void> {
    const record = await this.record(jobId);
    if (await this.rejection(jobId)) return;
    try {
      const receipt = JSON.parse(await readFile(join(this.taskPath(jobId), "started.json"), "utf8"));
      if (receipt.confirmed === true) return;
      throw new RemoteAgentError("REGISTRY_CORRUPT", "Invalid startup receipt");
    } catch (error) { if (!isMissing(error)) throw error; }
    try {
      if (record.protocol === 2) await this.remote.call("task_start", { protocol: 2, jobId });
      else await this.remote.call("start", record as unknown as Record<string, unknown>);
    } catch (error) { if (await this.saveRejection(jobId, error)) return; throw error; }
    await atomicJson(join(this.taskPath(jobId), "started.json"), { confirmed: true });
  }

  async status(jobId: string): Promise<RemoteTask> {
    await this.record(jobId);
    const task = await this.rejection(jobId) ?? await this.remote.call<RemoteTask>("status", { jobId });
    if (task.jobId !== jobId) throw new RemoteAgentError("TASK_SCOPE_MISMATCH", "Remote task identity mismatch");
    if (TERMINAL.has(task.state)) {
      task.eventId = createHash("sha256").update(JSON.stringify([this.workspaceId, jobId, task.state, task.completedAt])).digest("hex");
      await atomicJson(join(this.taskPath(jobId), "completion.json"), task);
    }
    return task;
  }

  async pending(sessionId: string): Promise<TaskRecord[]> {
    return this.unacknowledged(record => record.sessionId === sessionId);
  }

  /** Binding-level (every session) unacknowledged registrations. The remove
   * action uses this so another conversation's unfinished work blocks removal. */
  async pendingAcross(): Promise<TaskRecord[]> {
    return this.unacknowledged(undefined);
  }

  private async unacknowledged(match: ((record: TaskRecord) => boolean) | undefined): Promise<TaskRecord[]> {
    this.registryIssues.length = 0;
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const records: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let record: TaskRecord;
      try { record = await this.record(entry.name); }
      catch (error) {
        // A registration directory can be visible before its atomic record appears.
        this.registryIssues.push({ jobId: entry.name, code: (error as RemoteAgentError).code ?? "REGISTRY_CORRUPT" });
        continue;
      }
      if (match && !match(record)) continue;
      try {
        const ack = JSON.parse(await readFile(join(this.taskPath(entry.name), "ack.json"), "utf8"));
        if (ack.jobId !== entry.name || typeof ack.acknowledgedAt !== "string") throw new RemoteAgentError("REGISTRY_CORRUPT", "Invalid result acknowledgement");
      } catch (error) {
        if (!isMissing(error)) this.registryIssues.push({ jobId: entry.name, code: "INVALID_ACKNOWLEDGEMENT" });
        records.push(record);
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async acknowledge(jobId: string, sessionId: string): Promise<void> {
    const record = await this.record(jobId);
    if (record.sessionId !== sessionId) throw new RemoteAgentError("TASK_SCOPE_MISMATCH", "Task belongs to another session");
    const task = await this.status(jobId);
    if (!TERMINAL.has(task.state)) throw new RemoteAgentError("TASK_NOT_FINISHED", "Only a finished task result can be acknowledged");
    if (!await this.rejection(jobId)) await this.remote.call("ack", { jobId });
    await atomicJson(join(this.taskPath(jobId), "ack.json"), { jobId, eventId: task.eventId, completedAt: task.completedAt, acknowledgedAt: new Date().toISOString() });
  }

  async cancel(jobId: string): Promise<RemoteTask> {
    await this.record(jobId);
    return this.remote.call<RemoteTask>("cancel", { jobId });
  }

  async wait(jobId: string, options: {
    waitTimeoutMs?: number;
    onOutput?: (stream: "stdout" | "stderr", data: Buffer) => void;
    displayBytes?: number;
  } = {}): Promise<{ task: RemoteTask; timedOut: boolean; stdoutOffset: number; stderrOffset: number }> {
    await this.record(jobId);
    if (options.waitTimeoutMs !== undefined && (!Number.isSafeInteger(options.waitTimeoutMs) || options.waitTimeoutMs < 0)) {
      throw new RemoteAgentError("INVALID_TIMEOUT", "Wait timeout must be a nonnegative integer");
    }
    const deadline = options.waitTimeoutMs === undefined ? Infinity : Date.now() + options.waitTimeoutMs;
    let stdoutOffset = 0, stderrOffset = 0;
    let last: RemoteTask = { jobId, state: "unknown" };
    let retryDelay = 500;
    let reconciled = false;
    let delivered = 0;
    const displayBytes = options.displayBytes ?? 65536;
    for (;;) {
      try {
        if (!reconciled) {
          if (await observedBefore(this.reconcile(jobId), deadline) === WAIT_ELAPSED) return { task: last, timedOut: true, stdoutOffset, stderrOffset };
          reconciled = true;
          if (await this.rejection(jobId)) return { task: await this.status(jobId), timedOut: false, stdoutOffset, stderrOffset };
        }
        // Once the displayed prefix is exhausted, read only a tiny tail to obtain
        // current sizes/state. Do not transfer hundreds of MiB just to discard them.
        const skipping = delivered >= displayBytes;
        const output = await observedBefore(this.remote.call<TaskOutput>("output", { jobId, stdoutOffset, stderrOffset,
          maxBytes: skipping ? 1 : 32768, ...(skipping ? { tail: true } : {}) }), deadline);
        if (output === WAIT_ELAPSED) return { task: last, timedOut: true, stdoutOffset, stderrOffset };
        if (output.jobId !== jobId) throw new RemoteAgentError("TASK_SCOPE_MISMATCH", "Remote output identity mismatch");
        last = { jobId, state: output.state };
        for (const name of ["stdout", "stderr"] as const) {
          const chunk = Buffer.from(output[name].data, "base64");
          const shown = chunk.subarray(0, Math.max(0, displayBytes - delivered));
          delivered += shown.length;
          if (shown.length) options.onOutput?.(name, shown);
        }
        stdoutOffset = output.stdout.nextOffset;
        stderrOffset = output.stderr.nextOffset;
        if ((output.terminal && !output.stdout.hasMore && !output.stderr.hasMore) || output.state === "unknown") {
          const task = await observedBefore(this.status(jobId), deadline);
          return { task: task === WAIT_ELAPSED ? last : task, timedOut: task === WAIT_ELAPSED, stdoutOffset, stderrOffset };
        }
        if (Date.now() >= deadline) return { task: last, timedOut: true, stdoutOffset, stderrOffset };
        if (output.stdout.hasMore || output.stderr.hasMore) continue;
        retryDelay = 500;
      } catch (error) {
        if (!(error as { retriable?: boolean })?.retriable) throw error;
        last = { jobId, state: "unknown", reason: "CONNECTION_UNAVAILABLE" };
        if (Date.now() >= deadline) return { task: last, timedOut: true, stdoutOffset, stderrOffset };
        retryDelay = Math.min(retryDelay * 2, 8000);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(retryDelay, Math.max(0, deadline - Date.now()))));
    }
  }
}
