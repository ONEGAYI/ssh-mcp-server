/**
 * Local workspace space ledger (issue #8), the machine-side twin of the
 * remote helper's remote/ledger.py.
 *
 * Layout under the per-workspace state directory
 * (<localStateDir>/<sha256(identity)[:24]>/ledger/):
 *   ledger.json - registered temp resources + reservations (atomic writes)
 *   ledger.lock - cross-process mutex; exclusive-create file recording the
 *                 holder pid. Stolen only when the holder process is
 *                 confirmed dead (process.kill(pid, 0) -> ESRCH); never on
 *                 timeout alone, matching "active reservations must not be
 *                 reclaimed without verifying occupancy".
 *
 * Accounting mirrors the remote end: usedBytes = stateBytes + tempBytes +
 * reservedBytes; the state scan covers the workspace identity directory
 * except the ledger directory itself (the instrument is not re-measured);
 * registering a resource consumes the reservation it cites; committed
 * targets leave measurement when their registration is released.
 *
 * Occupancy evidence: object identity (dev:ino) plus holder process liveness.
 * On this end the holder check is pid liveness only; Windows offers no
 * boot-anchored start time, so a reused local PID is a documented limitation
 * (the remote end uses /proc identity for a strict verdict). Age never flips
 * a verdict here either.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { identityStateDirectory } from "../config/workspace.js";
import { RemoteAgentError } from "./remote-agent-client.js";

export const DEFAULT_SPACE_LIMIT_BYTES = 10 * 1024 ** 3;
const LEDGER_LOCK_TIMEOUT_MS = 5000;
const LEDGER_LOCK_POLL_MS = 10;
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const ID_PATTERN = /^[0-9a-f]{32}$/;

export interface ResourceRecord {
  kind: string; path: string; bytes: number; identity: string | null;
  holderPid: number; origin: string; reservationId: string | null; createdAt: number;
}

export interface ReservationRecord {
  bytes: number; holderPid: number; note: string; createdAt: number;
}

interface LedgerState {
  schemaVersion: number;
  resources: Record<string, ResourceRecord>;
  reservations: Record<string, ReservationRecord>;
}

export interface UsageSummary {
  usedBytes: number; stateBytes: number; tempBytes: number; reservedBytes: number;
  limitBytes: number; resourceCount: number; reservationCount: number;
}

export interface OccupancyEvidence {
  resourceId: string; kind: string; path: string; bytes: number; exists: boolean;
  identity: string | null; identityMatches: boolean | null; holderPid: number; holderAlive: boolean; createdAt: number;
}

/** The ledger directory shared by every local service of one workspace. */
export function workspaceLedgerDirectory(localStateDir: string, identity: string): string {
  return join(identityStateDirectory(localStateDir, identity), "ledger");
}

function emptyLedger(): LedgerState {
  return { schemaVersion: 1, resources: {}, reservations: {} };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // EPERM means the process exists but is not ours; only ESRCH proves death.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function byteCount(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > SAFE_INTEGER_MAX) {
    throw new RemoteAgentError("INVALID_REQUEST", `${field} must be an integer between ${minimum} and ${SAFE_INTEGER_MAX}`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new RemoteAgentError("INVALID_REQUEST", `${label} must be a 32-hex identifier`);
  }
  return value;
}

/** Sum of regular file sizes under the workspace identity directory,
 * excluding the ledger directory (self-referential measurement churn). */
async function measureStateBytes(identityDirectory: string): Promise<number> {
  const ledgerName = "ledger";
  let total = 0;
  async function walk(directory: string, isRoot: boolean): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        if (isRoot && entry.name === ledgerName) continue;
        if (entry.isSymbolicLink()) continue;
        await walk(join(directory, entry.name), false);
      } else if (entry.isFile()) {
        try { total += (await stat(join(directory, entry.name))).size; }
        catch (error) { if (!isMissing(error)) throw error; }
      }
    }
  }
  await walk(identityDirectory, true);
  return total;
}

/** Limit source: a fixed number, or a loader invoked on every quota check so
 * saved policy changes apply from the next operation without a restart
 * (spec section 8; the reload point is loadPolicy). */
export type SpaceLimitSource = number | (() => number | Promise<number>);

export class SpaceLedger {
  private readonly identityDirectory: string;
  private readonly directory: string;

  constructor(directory: string, private readonly limitSource: SpaceLimitSource = DEFAULT_SPACE_LIMIT_BYTES) {
    if (typeof limitSource === "number" && (!Number.isInteger(limitSource) || limitSource < 1)) {
      throw new RemoteAgentError("INVALID_CONFIG", "Workspace space limit must be a positive integer");
    }
    this.directory = directory;
    this.identityDirectory = dirname(directory);
  }

  /** Resolve the effective limit for this operation. */
  private async resolveLimit(): Promise<number> {
    const value = typeof this.limitSource === "function" ? await this.limitSource() : this.limitSource;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RemoteAgentError("INVALID_CONFIG", "Workspace space limit must be a positive integer");
    }
    return value;
  }

  private lockPath(): string {
    return join(this.directory, "ledger.lock");
  }

  /** Steal the lock only from a holder proven dead; never on timeout alone. */
  private async reclaimDeadHolder(): Promise<void> {
    let holderPid: unknown;
    try {
      holderPid = JSON.parse(await readFile(this.lockPath(), "utf8"))?.pid;
    } catch {
      return; // released between the check and the read, or unreadable: keep waiting
    }
    if (typeof holderPid === "number" && processAlive(holderPid)) return;
    // TOCTOU narrowing: between the death verdict above and the unlink below,
    // another process may have reclaimed the lock already and written its own
    // pid; unlinking then would delete the new holder's lock file and let two
    // processes hold the ledger at once. Re-read and unlink only while the
    // file still names the pid we just judged dead. A millisecond-scale
    // window remains (this read and the unlink are separate steps); the
    // complete fix is a unique lock name per attempt plus an atomic rename,
    // deliberately deferred.
    try {
      if (JSON.parse(await readFile(this.lockPath(), "utf8"))?.pid !== holderPid) return;
    } catch {
      return; // released or unreadable meanwhile: keep waiting
    }
    await unlink(this.lockPath()).catch(error => { if (!isMissing(error)) throw error; });
  }

  /** Run one mutation while holding the cross-process ledger lock. */
  private async withLedger<T>(mutate: (state: LedgerState) => Promise<T> | T): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = this.lockPath();
    const startedAt = Date.now();
    for (;;) {
      let handle;
      try { handle = await open(lockPath, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.reclaimDeadHolder();
        if (Date.now() - startedAt > LEDGER_LOCK_TIMEOUT_MS) {
          throw new RemoteAgentError("LEDGER_BUSY", "Another process still holds the workspace ledger; retry later");
        }
        await sleep(LEDGER_LOCK_POLL_MS);
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        const state = await this.readState();
        const result = await mutate(state);
        await this.persist(state);
        return result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
          throw new RemoteAgentError("STORAGE_FULL", "Workspace ledger could not be persisted: the filesystem is full");
        }
        throw error;
      } finally {
        await handle.close();
        await unlink(lockPath).catch(error => { if (!isMissing(error)) throw error; });
      }
    }
  }

  private async readState(): Promise<LedgerState> {
    try {
      const state = JSON.parse(await readFile(join(this.directory, "ledger.json"), "utf8"));
      if (typeof state !== "object" || state === null || typeof state.resources !== "object"
        || typeof state.reservations !== "object") {
        throw new RemoteAgentError("LEDGER_UNAVAILABLE", "Workspace ledger has an unexpected shape");
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return emptyLedger();
      if (error instanceof RemoteAgentError) throw error;
      throw new RemoteAgentError("LEDGER_UNAVAILABLE", "Workspace ledger could not be read");
    }
  }

  private async persist(state: LedgerState): Promise<void> {
    const temporary = join(this.directory, `.${randomUUID()}.pending`);
    const target = join(this.directory, "ledger.json");
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, target); }
    finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
  }

  private async summary(state: LedgerState): Promise<UsageSummary> {
    const stateBytes = await measureStateBytes(this.identityDirectory);
    const limitBytes = await this.resolveLimit();
    let tempBytes = 0, reservedBytes = 0;
    for (const resource of Object.values(state.resources)) tempBytes += resource.bytes;
    for (const reservation of Object.values(state.reservations)) reservedBytes += reservation.bytes;
    return { stateBytes, tempBytes, reservedBytes,
      usedBytes: stateBytes + tempBytes + reservedBytes, limitBytes,
      resourceCount: Object.keys(state.resources).length,
      reservationCount: Object.keys(state.reservations).length };
  }

  private requireQuota(summary: UsageSummary, requested: number): void {
    if (summary.usedBytes + requested > summary.limitBytes) {
      throw new RemoteAgentError("WORKSPACE_QUOTA_EXCEEDED",
        `Workspace space limit is ${summary.limitBytes} bytes (used ${summary.usedBytes}, requesting ${requested}); rejecting the new usage`);
    }
  }

  async reserve(bytes: number, note = ""): Promise<{ reservationId: string; usedBytes: number; limitBytes: number }> {
    byteCount(bytes, "bytes", 1);
    if (typeof note !== "string" || note.length > 200) {
      throw new RemoteAgentError("INVALID_REQUEST", "note must be text of at most 200 characters");
    }
    const reservationId = randomUUID().replaceAll("-", "");
    return this.withLedger(async state => {
      const summary = await this.summary(state);
      this.requireQuota(summary, bytes);
      state.reservations[reservationId] = { bytes, holderPid: process.pid, note, createdAt: Date.now() };
      return { reservationId, usedBytes: summary.usedBytes + bytes, limitBytes: summary.limitBytes };
    });
  }

  async releaseReservation(reservationId: string): Promise<{ released: true; reservationId: string }> {
    requireId(reservationId, "reservationId");
    return this.withLedger(state => {
      if (!(reservationId in state.reservations)) {
        throw new RemoteAgentError("RESOURCE_NOT_FOUND", "Reservation is not registered");
      }
      delete state.reservations[reservationId];
      return { released: true as const, reservationId };
    });
  }

  async register(path: string, bytes: number, origin = "unspecified", reservationId?: string): Promise<{ resourceId: string; usedBytes: number; limitBytes: number }> {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
      throw new RemoteAgentError("INVALID_REQUEST", "path must be an absolute path");
    }
    byteCount(bytes, "bytes", 0);
    if (typeof origin !== "string" || origin.length > 64) {
      throw new RemoteAgentError("INVALID_REQUEST", "origin must be text of at most 64 characters");
    }
    if (reservationId !== undefined) requireId(reservationId, "reservationId");
    const resourceId = randomUUID().replaceAll("-", "");
    return this.withLedger(async state => {
      // A cited reservation must exist before any quota arithmetic: a stale
      // id is RESOURCE_NOT_FOUND regardless of the remaining quota headroom.
      const reservation = reservationId !== undefined
        ? state.reservations[reservationId] ?? null
        : null;
      if (reservationId !== undefined && reservation === null) {
        throw new RemoteAgentError("RESOURCE_NOT_FOUND", "Reservation is not registered or was fully consumed");
      }
      const summary = await this.summary(state);
      // The reservation's bytes are already inside summary.usedBytes, so
      // charging the full amount again would double count. Only the growth
      // beyond the cited reservation may consume quota: redeeming a
      // reservation that exactly fits is net zero even at the limit. This
      // mirrors the remote helper's net-delta check (remote/ledger.py).
      const net = reservation === null ? bytes : Math.max(0, bytes - reservation.bytes);
      this.requireQuota(summary, net);
      if (reservation !== null && reservationId !== undefined) {
        reservation.bytes -= bytes;
        if (reservation.bytes <= 0) delete state.reservations[reservationId];
      }
      state.resources[resourceId] = { kind: "temp-file", path, bytes, identity: null,
        holderPid: process.pid, origin, reservationId: reservationId ?? null, createdAt: Date.now() };
      return { resourceId, usedBytes: summary.usedBytes + net, limitBytes: summary.limitBytes };
    });
  }

  async attachIdentity(resourceId: string, identity: string): Promise<void> {
    requireId(resourceId, "resourceId");
    if (typeof identity !== "string" || identity.length === 0) {
      throw new RemoteAgentError("INVALID_REQUEST", "identity must be nonempty text");
    }
    await this.withLedger(state => {
      const resource = state.resources[resourceId];
      if (!resource) throw new RemoteAgentError("RESOURCE_NOT_FOUND", "Resource is not registered");
      resource.identity = identity;
    });
  }

  async release(resourceId: string): Promise<{ released: boolean; resourceId: string }> {
    requireId(resourceId, "resourceId");
    return this.withLedger(state => {
      const released = resourceId in state.resources;
      delete state.resources[resourceId];
      return { released, resourceId };
    });
  }

  async inspect(resourceId: string): Promise<OccupancyEvidence> {
    requireId(resourceId, "resourceId");
    return this.withLedger(async () => {
      const state = await this.readState();
      const resource = state.resources[resourceId];
      if (!resource) throw new RemoteAgentError("RESOURCE_NOT_FOUND", "Resource is not registered");
      let exists = false;
      let identityMatches: boolean | null = null;
      try {
        const info = await stat(resource.path);
        exists = true;
        if (resource.identity) identityMatches = resource.identity === `${info.dev}:${info.ino}`;
      } catch (error) { if (!isMissing(error)) throw error; }
      return { resourceId, kind: resource.kind, path: resource.path, bytes: resource.bytes, exists,
        identity: resource.identity, identityMatches, holderPid: resource.holderPid,
        holderAlive: processAlive(resource.holderPid), createdAt: resource.createdAt };
    });
  }

  async usage(): Promise<UsageSummary> {
    return this.withLedger(state => this.summary(state));
  }
}
