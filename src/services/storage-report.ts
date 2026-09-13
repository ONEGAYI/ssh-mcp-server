/**
 * On-demand two-end workspace storage summary (issue #19, spec 7.2).
 *
 * remote_workspace gains includeStorage (default false, zero extra work);
 * when enabled the reply carries ONLY this bounded report instead of the
 * capability listing. Each end reports the ledger's accounting categories
 * (stateBytes + tempBytes + reservedBytes = usedBytes, the same figures the
 * quota gate uses -- registered sibling temps counted, committed targets
 * excluded, reservations never double counted) plus the persisted last
 * maintenance round (time and counters, aggregated -- no per-item lists).
 *
 * An unreachable or failing remote end reports status="unknown" with a
 * bounded reason and NO numeric fields: absence of data is never guessed
 * into zeros, and the local half still returns real numbers.
 *
 * Size budget: the serialized reply stays within 4 KiB. The fixed schema is
 * already far below it; the trim ladder only guards pathological cases and
 * drops, in order, the maintenance counters, then the resource/reservation
 * counts. Measurement cost is bounded by construction: one state-directory
 * walk plus reading two small JSON files per end (never a full-disk du).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadPolicy, WorkspacePolicy } from "../config/policy.js";
import { WorkspaceConfig } from "../config/workspace.js";
import { SpaceLedger, UsageSummary, workspaceLedgerDirectory } from "./space-ledger.js";

export const STORAGE_REPORT_BUDGET_BYTES = 4096;
const REASON_LIMIT = 200;

interface MaintenanceCounters {
  lastCompletedAt: number;
  removedTasks?: number;
  removedTransfers?: number;
  itemsConsidered?: number;
}

interface EndSummary extends UsageSummary {
  maintenance: MaintenanceCounters;
}

export interface StorageReport {
  storage: { local: EndSummary; remote: unknown };
}

/** The files gateway into the helper (FileService.call); typed as the narrow
 * interface the report needs so tests can stub it without an SSH stack. */
export interface StorageFilesGateway {
  call(action: "file_workspace", sessionId: string, request?: Record<string, unknown>): Promise<unknown>;
}

interface LocalMaintenanceState {
  schemaVersion?: number;
  lastCompletedAt?: unknown;
  lastLocalSummary?: { removedTasks?: unknown; removedTransfers?: unknown; itemsConsidered?: unknown };
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Aggregate the persisted local maintenance record into counters. The stored
 * summary keeps per-item id lists (up to maxItemsPerRun entries); the report
 * must never echo them -- that is the real-world trim the 4 KiB budget needs. */
async function readLocalMaintenance(identityDirectory: string): Promise<MaintenanceCounters> {
  let state: LocalMaintenanceState;
  try {
    state = JSON.parse(await readFile(join(identityDirectory, "maintenance.json"), "utf8"));
  } catch {
    return { lastCompletedAt: 0, removedTasks: 0, removedTransfers: 0, itemsConsidered: 0 };
  }
  if (typeof state !== "object" || state === null) {
    return { lastCompletedAt: 0, removedTasks: 0, removedTransfers: 0, itemsConsidered: 0 };
  }
  const summary = typeof state.lastLocalSummary === "object" && state.lastLocalSummary !== null
    ? state.lastLocalSummary : {};
  return {
    lastCompletedAt: typeof state.lastCompletedAt === "number" ? state.lastCompletedAt : 0,
    removedTasks: Array.isArray(summary.removedTasks) ? summary.removedTasks.length : counter(summary.removedTasks),
    removedTransfers: Array.isArray(summary.removedTransfers) ? summary.removedTransfers.length : counter(summary.removedTransfers),
    itemsConsidered: counter(summary.itemsConsidered),
  };
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= REASON_LIMIT ? message : message.slice(0, REASON_LIMIT);
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isEndSummary(value: unknown): value is EndSummary {
  return typeof value === "object" && value !== null && typeof (value as EndSummary).usedBytes === "number";
}

/** Apply the documented trim ladder until the reply fits the budget. Steps:
 * counters of the maintenance section first, then the ledger counts. The
 * final fallback is unreachable for any honest ledger figure; it exists so
 * the budget can never be violated by construction. */
function capStorageReport(report: StorageReport): unknown {
  if (sizeOf(report) <= STORAGE_REPORT_BUDGET_BYTES) return report;
  const trimmed = structuredClone(report) as unknown as {
    storage: { local: Record<string, unknown>; remote: Record<string, unknown> };
  };
  for (const end of [trimmed.storage.local, trimmed.storage.remote]) {
    const maintenance = end.maintenance as MaintenanceCounters | undefined;
    if (maintenance !== undefined) end.maintenance = { lastCompletedAt: maintenance.lastCompletedAt };
  }
  if (sizeOf(trimmed) <= STORAGE_REPORT_BUDGET_BYTES) return trimmed;
  for (const end of [trimmed.storage.local, trimmed.storage.remote]) {
    delete end.resourceCount;
    delete end.reservationCount;
  }
  if (sizeOf(trimmed) <= STORAGE_REPORT_BUDGET_BYTES) return trimmed;
  return { storage: { local: { usedBytes: report.storage.local.usedBytes, limitBytes: report.storage.local.limitBytes },
    remote: isEndSummary(report.storage.remote)
      ? { usedBytes: report.storage.remote.usedBytes, limitBytes: report.storage.remote.limitBytes }
      : { status: "unknown" } } };
}

/** Assemble the report. Local figures come from the local ledger and the
 * persisted maintenance record; the remote half is whatever the helper's
 * file_workspace(includeStorage=true) produced, or an explicit unknown. */
export async function buildStorageReport(
  config: Pick<WorkspaceConfig, "localStateDir" | "identity" | "profilePath">,
  files: StorageFilesGateway,
  sessionId: string,
  policyLoader: (profilePath: string) => Promise<WorkspacePolicy> = loadPolicy,
): Promise<unknown> {
  const policy = await policyLoader(config.profilePath);
  const ledgerDirectory = workspaceLedgerDirectory(config.localStateDir, config.identity);
  const ledger = new SpaceLedger(ledgerDirectory, policy.limits.localWorkspaceBytes);
  const usage = await ledger.usage();
  const maintenance = await readLocalMaintenance(dirname(ledgerDirectory));
  const local: EndSummary = { ...usage, maintenance };
  let remote: unknown;
  try {
    const result = await files.call("file_workspace", sessionId, { includeStorage: true });
    const storage = (result as { storage?: unknown } | null)?.storage;
    if (isEndSummary(storage)) {
      remote = storage;
    } else {
      // Reachable helper without a storage section (upgrade window): absent
      // data is unknown, never zeros.
      remote = { status: "unknown", reason: "Remote helper reported no storage summary" };
    }
  } catch (error) {
    remote = { status: "unknown", reason: boundedReason(error) };
  }
  return capStorageReport({ storage: { local, remote } });
}
