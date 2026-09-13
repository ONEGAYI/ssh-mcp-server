/**
 * Hourly online maintenance for one workspace (issue #16, spec 7.2 / ADR 0010).
 *
 * Every MCP tool call and job CLI run triggers maybeMaintain(); a persisted
 * timestamp throttles actual rounds to policy.maintenance.intervalMs (default
 * one hour). Because the timestamp survives process exits, an offline gap
 * (MCP closed, SSH down) is simply caught up by the first trigger after
 * reconnecting -- no daemon, no remote cron.
 *
 * One round is bounded (items and wall clock), serialized by a lock file
 * whose holder pid is only reclaimed when proven dead, and consists of:
 *   1. reclaiming expired LOCAL records (task registrations and transfer
 *      registrations under the workspace identity directory), mirroring the
 *      remote retention rules; a stalled download's receiver temp is
 *      released together with its ledger entry, exactly like cancellation;
 *      crash-leftover ledger resources whose holder is proven dead are
 *      reclaimed the same verified way (issue #17);
 *   2. one remote `maintenance` helper call carrying the freshly loaded
 *      policy (loadPolicy re-reads the profile every round). Only a
 *      successful remote round advances lastCompletedAt, so a failed
 *      attempt retries on the next trigger. The remote round itself also
 *      reclaims expired read credentials, stale helper images and verified
 *      crash-leftover temps (issue #17).
 *
 * Expired identifiers stay refused afterwards: local actions require the
 * registration record, the remote register-then-execute protocol rejects
 * unknown identifiers with REQUEST_EXPIRED_OR_UNKNOWN.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadPolicy } from "../config/policy.js";
import { WorkspaceConfig } from "../config/workspace.js";
import { SpaceLedger } from "./space-ledger.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TRANSFER_ID = /^[0-9a-f]{32}$/;
const TERMINAL_TRANSFER_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);
/** While consecutive remote rounds fail, the retry waits this long before
 * paying another connection timeout (review R12): offline windows must not
 * stack a 30 s SSH connect delay onto every tool call. */
const REMOTE_FAILURE_BACKOFF_MS = 300_000;

interface MaintenanceState {
  schemaVersion: 1;
  lastCompletedAt: number;
  /** The last round that actually ran, success or failure (the local twin of
   * the remote lastRunAt; review R3 -- both ends feed the storage report). */
  lastRunAt?: number;
  /** The last remote attempt; the failure backoff window is measured from
   * here (review R12). Cleared implicitly on success: a completed round
   * throttles by lastCompletedAt instead. */
  lastRemoteAttemptAt?: number;
  lastLocalSummary?: LocalSummary;
  lastRemoteSummary?: unknown;
  lastRemoteError?: string;
}

export interface LocalSummary {
  removedTasks: string[];
  removedTransfers: string[];
  reclaimedResources: string[];
  itemsConsidered: number;
}

export interface MaintenanceOutcome {
  skipped?: "interval" | "busy";
  local?: LocalSummary;
  remote?: unknown;
  remoteError?: string;
  /** The remote round was skipped by the failure backoff window (review R12);
   * local reclamation still ran and lastCompletedAt stays unset. */
  remoteSkipped?: "backoff";
  lastCompletedAt?: number;
}

export interface MaintenanceRemote {
  call<T = Record<string, unknown>>(action: string, request: Record<string, unknown>,
    options?: { timeoutMs?: number }): Promise<T>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // EPERM means the process exists but is not ours; only ESRCH proves death.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class MaintenanceService {
  private readonly identityDirectory: string;
  private readonly tasksDirectory: string;
  private readonly transfersDirectory: string;
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(private readonly config: Pick<WorkspaceConfig, "localStateDir" | "identity" | "profilePath">,
    private readonly remote: MaintenanceRemote | null) {
    this.identityDirectory = join(config.localStateDir, createHash("sha256").update(config.identity).digest("hex").slice(0, 24));
    this.tasksDirectory = join(this.identityDirectory, "tasks");
    this.transfersDirectory = join(this.identityDirectory, "transfers");
    this.statePath = join(this.identityDirectory, "maintenance.json");
    this.lockPath = join(this.identityDirectory, "maintenance.lock");
  }

  private async readState(): Promise<MaintenanceState> {
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as MaintenanceState;
      if (typeof state !== "object" || state === null || typeof state.lastCompletedAt !== "number") {
        return { schemaVersion: 1, lastCompletedAt: 0 };
      }
      return { ...state, schemaVersion: 1 };
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, lastCompletedAt: 0 };
      throw error;
    }
  }

  private async writeState(state: MaintenanceState): Promise<void> {
    await mkdir(this.identityDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid.toString(16)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
      await rename(temporary, this.statePath);
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** Try to hold the cross-process maintenance lock. Steals it only from a
   * holder proven dead; a live holder means another process is maintaining
   * and this trigger simply skips. */
  private async acquireLock(): Promise<{ handle: import("node:fs/promises").FileHandle } | { busy: true }> {
    await mkdir(this.identityDirectory, { recursive: true, mode: 0o700 });
    for (;;) {
      let handle;
      try { handle = await open(this.lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let holderPid: unknown;
        try { holderPid = JSON.parse(await readFile(this.lockPath, "utf8"))?.pid; }
        catch { return { busy: true }; }
        if (typeof holderPid === "number" && processAlive(holderPid)) return { busy: true };
        // TOCTOU narrowing: unlink only while the file still names the dead pid.
        try {
          if (JSON.parse(await readFile(this.lockPath, "utf8"))?.pid !== holderPid) return { busy: true };
        } catch { return { busy: true }; }
        await unlink(this.lockPath).catch(() => undefined);
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        return { handle };
      } catch (error) {
        // The file was exclusively created by this attempt: a failed content
        // write (ENOSPC/EIO) must remove it again. Leaving a zero-byte lock
        // behind would parse as no holder on every later read and look busy
        // forever (review R8).
        await handle.close();
        await unlink(this.lockPath).catch(() => undefined);
        throw error;
      }
    }
  }

  /** Reclaim expired local task records (spec 7.1). */
  private async reclaimTask(jobId: string, retention: { confirmedResultMs: number; unconfirmedResultMs: number }, now: number): Promise<boolean> {
    const directory = join(this.tasksDirectory, jobId);
    const read = async (name: string): Promise<Record<string, unknown> | null> => {
      try { return JSON.parse(await readFile(join(directory, name), "utf8")); }
      catch (error) { if (isMissing(error)) return null; throw error; }
    };
    const ack = await read("ack.json");
    if (ack) {
      const acknowledgedAt = typeof ack.acknowledgedAt === "string" ? Date.parse(ack.acknowledgedAt) : 0;
      if (now - acknowledgedAt >= retention.confirmedResultMs) {
        await rm(directory, { recursive: true, force: true });
        return true;
      }
      return false;
    }
    // Finished but never acknowledged: the clock starts at completion.
    const completion = await read("completion.json") ?? await read("rejected.json");
    if (!completion) return false; // prepared registration: no expiry in the spec
    const completedAt = typeof completion.completedAt === "number" ? completion.completedAt * 1000 : 0;
    if (now - completedAt >= retention.unconfirmedResultMs) {
      await rm(directory, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  /** Reclaim expired local transfer records; stalled receiver temps are
   * released with their ledger entry like cancellation (#15 semantics). */
  private async reclaimTransfer(transferId: string, ledger: SpaceLedger,
    retention: { confirmedResultMs: number; unconfirmedResultMs: number }, now: number): Promise<boolean> {
    const directory = join(this.transfersDirectory, transferId);
    let record: Record<string, unknown>;
    try { record = JSON.parse(await readFile(join(directory, "record.json"), "utf8")); }
    catch (error) { if (isMissing(error)) return false; throw error; }
    const state = typeof record.state === "string" ? record.state : "prepared";
    if (TERMINAL_TRANSFER_STATES.has(state)) {
      let terminalAt = 0;
      try {
        const ack = JSON.parse(await readFile(join(directory, "ack.json"), "utf8"));
        terminalAt = typeof ack.acknowledgedAt === "string" ? Date.parse(ack.acknowledgedAt)
          : typeof record.completedAt === "number" ? record.completedAt : 0;
        if (now - terminalAt >= retention.confirmedResultMs) {
          await rm(directory, { recursive: true, force: true });
          return true;
        }
        return false;
      } catch (error) {
        if (!isMissing(error)) throw error;
        // No ack: unconfirmed retention from completion.
        const completedAt = typeof record.completedAt === "number" ? record.completedAt : 0;
        if (now - completedAt >= retention.unconfirmedResultMs) {
          await rm(directory, { recursive: true, force: true });
          return true;
        }
        return false;
      }
    }
    // Non-terminal: interrupted receiver data expires by its recorded TTL.
    // A record without a usable expiresAt stays (never guess an expiry); the
    // remote twin decides with lock evidence, this end only mirrors it.
    const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : Infinity;
    if (expiresAt > now) return false;
    const tempPath = typeof record.tempPath === "string" ? record.tempPath : null;
    if (tempPath) await unlink(tempPath).catch(error => { if (!isMissing(error)) throw error; });
    const resourceId = typeof record.resourceId === "string" ? record.resourceId : null;
    if (resourceId) await ledger.release(resourceId).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    return true;
  }

  /** Resource ids that living transfer records still manage themselves.
   *
   * A transfer's receiver temp and its ledger entry live across many short
   * helper processes, so the recorded holder is dead while the transfer is
   * alive. reclaimTransfer already releases those entries with the record's
   * own TTL evidence; the generic pass must never race it. */
  private async transferManagedResourceIds(): Promise<Set<string>> {
    const managed = new Set<string>();
    let entries;
    try { entries = await readdir(this.transfersDirectory, { withFileTypes: true }); }
    catch (error) { if (!isMissing(error)) throw error; return managed; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const record = JSON.parse(await readFile(join(this.transfersDirectory, entry.name, "record.json"), "utf8"));
        if (typeof record.resourceId === "string" && record.resourceId) managed.add(record.resourceId);
      } catch { /* a damaged record leaves its entry to the generic pass */ }
    }
    return managed;
  }

  /** Reclaim crash-leftover local ledger resources (spec 7.2, issue #17).
   *
   * Occupancy evidence mirrors the remote end: the holder pid decides
   * liveness (Windows offers no boot-anchored identity; that limitation is
   * documented on SpaceLedger), and the recorded dev:ino identity decides
   * whether the object at the registered path is still ours. A live holder
   * keeps everything; a dead holder releases the registration, deleting the
   * file only when the identity matches. A never-anchored identity stays
   * behind as management fields only; files without any registration are
   * never this pass's business. Age never flips a verdict. */
  private async reclaimLedgerResources(ledger: SpaceLedger,
    policy: Awaited<ReturnType<typeof loadPolicy>>, summary: LocalSummary, deadline: number): Promise<void> {
    let resources: Record<string, Record<string, unknown>> = {};
    try {
      // Atomic renames on the write side make an unlocked read consistent.
      const state = JSON.parse(await readFile(join(this.identityDirectory, "ledger", "ledger.json"), "utf8"));
      if (typeof state === "object" && state !== null && typeof state.resources === "object") {
        resources = state.resources;
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const managed = await this.transferManagedResourceIds();
    for (const resourceId of Object.keys(resources).sort()) {
      if (summary.itemsConsidered >= policy.maintenance.maxItemsPerRun || Date.now() >= deadline) return;
      // Real registrations are always 32-hex ids; anything else is not ours.
      if (!/^[0-9a-f]{32}$/.test(resourceId)) continue;
      if (managed.has(resourceId)) continue; // owned by a living transfer record
      const entry = resources[resourceId];
      if (typeof entry !== "object" || entry === null) continue;
      summary.itemsConsidered += 1;
      if (typeof entry.holderPid === "number" && processAlive(entry.holderPid)) continue;
      const path = typeof entry.path === "string" ? entry.path : null;
      let exists = false;
      let identityMatches: boolean | null = null;
      if (path) {
        try {
          const info = await stat(path);
          exists = true;
          if (typeof entry.identity === "string") identityMatches = entry.identity === `${info.dev}:${info.ino}`;
        } catch (error) { if (!isMissing(error)) throw error; }
      }
      if (exists && typeof entry.identity !== "string") continue; // never anchored: unverifiable, keep
      if (exists && identityMatches && path) {
        await unlink(path).catch(error => { if (!isMissing(error)) throw error; });
      }
      // A mismatching identity releases the registration but never deletes
      // the foreign object now living at that name; a missing file just
      // leaves the ledger.
      await ledger.release(resourceId).catch(() => undefined);
      summary.reclaimedResources.push(resourceId);
    }
  }

  private async reclaimLocal(policy: Awaited<ReturnType<typeof loadPolicy>>, deadline: number): Promise<LocalSummary> {
    const summary: LocalSummary = { removedTasks: [], removedTransfers: [], reclaimedResources: [], itemsConsidered: 0 };
    const now = Date.now();
    const ledger = new SpaceLedger(join(this.identityDirectory, "ledger"),
      policy.limits.localWorkspaceBytes);
    const consider = async (kind: "tasks" | "transfers"): Promise<void> => {
      let entries;
      try { entries = await readdir(kind === "tasks" ? this.tasksDirectory : this.transfersDirectory, { withFileTypes: true }); }
      catch (error) { if (isMissing(error)) return; throw error; }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) continue;
        if (summary.itemsConsidered >= policy.maintenance.maxItemsPerRun || Date.now() >= deadline) return;
        const valid = kind === "tasks" ? TASK_ID.test(entry.name) : TRANSFER_ID.test(entry.name);
        if (!valid) continue;
        summary.itemsConsidered += 1;
        const removed = kind === "tasks"
          ? await this.reclaimTask(entry.name, policy.retention, now)
          : await this.reclaimTransfer(entry.name, ledger, policy.retention, now);
        if (removed) (kind === "tasks" ? summary.removedTasks : summary.removedTransfers).push(entry.name);
      }
    };
    await consider("tasks");
    await consider("transfers");
    await this.reclaimLedgerResources(ledger, policy, summary, deadline);
    return summary;
  }

  /** Entry point for every tool call / CLI run. Cheap when throttled. */
  async maybeMaintain(): Promise<MaintenanceOutcome> {
    const policy = await loadPolicy(this.config.profilePath);
    const state = await this.readState();
    if (Date.now() - state.lastCompletedAt < policy.maintenance.intervalMs) {
      return { skipped: "interval" };
    }
    const lock = await this.acquireLock();
    if ("busy" in lock) return { skipped: "busy" };
    try {
      // Double-check under the lock: a concurrent round may have completed.
      const fresh = await this.readState();
      if (Date.now() - fresh.lastCompletedAt < policy.maintenance.intervalMs) {
        return { skipped: "interval" };
      }
      // A real round is running now, success or failure: stamp it durably
      // before anything can fail (review R3, the twin of the remote lastRunAt).
      const round = { ...fresh, schemaVersion: 1 as const, lastRunAt: Date.now() };
      await this.writeState(round);
      const deadline = Date.now() + policy.maintenance.timeBudgetMs;
      const local = await this.reclaimLocal(policy, deadline);
      const retentionMs = {
        confirmedTaskLogMs: policy.retention.confirmedTaskLogMs,
        confirmedResultMs: policy.retention.confirmedResultMs,
        unconfirmedResultMs: policy.retention.unconfirmedResultMs,
        unknownRecordMs: policy.retention.unknownRecordMs,
        interruptedTransferDataMs: policy.retention.interruptedTransferDataMs,
      };
      let remote: unknown;
      let remoteError: string | undefined;
      let remoteSkipped: "backoff" | undefined;
      if (this.remote) {
        // Consecutive-failure backoff (review R12): within the window after a
        // failed attempt the remote round is skipped entirely -- local
        // reclamation above still ran. Once the window lapses, the next
        // trigger retries for real (offline reconnect catch-up is preserved).
        if (typeof round.lastRemoteAttemptAt === "number"
          && Date.now() - round.lastRemoteAttemptAt < REMOTE_FAILURE_BACKOFF_MS) {
          remoteSkipped = "backoff";
        } else {
          // Persist the attempt moment before the call: a hard failure during
          // the exchange must still open the backoff window.
          await this.writeState({ ...round, lastRemoteAttemptAt: Date.now() });
          try {
            remote = await this.remote.call("maintenance", { retentionMs,
              maxItemsPerRun: policy.maintenance.maxItemsPerRun, timeBudgetMs: policy.maintenance.timeBudgetMs },
              // The remote round may legally spend the whole configured budget
              // (up to 3.6e6 ms); the 30 s command default would kill every
              // large-budget round at the client (review R6).
              { timeoutMs: Math.max(60_000, policy.maintenance.timeBudgetMs + 15_000) });
          } catch (error) {
            remoteError = (error as Error).message;
          }
        }
      }
      if (remoteError === undefined && remoteSkipped === undefined) {
        const completed: MaintenanceState = { schemaVersion: 1, lastCompletedAt: Date.now(),
          lastRunAt: round.lastRunAt, lastLocalSummary: local, lastRemoteSummary: remote };
        await this.writeState(completed);
        return { local, remote, lastCompletedAt: completed.lastCompletedAt };
      }
      if (remoteSkipped === "backoff") return { local, remoteSkipped };
      return { local, remoteError };
    } finally {
      await unlink(this.lockPath).catch(() => undefined);
      await lock.handle.close();
    }
  }
}
