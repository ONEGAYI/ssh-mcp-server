import { readFile } from "node:fs/promises";
import { z } from "zod";
import { RemoteAgentError } from "../services/remote-agent-client.js";

/**
 * Workspace policy (spec sections 5.1/5.2, 7.1/7.2 and 8): per-end space limits,
 * retention periods, search filtering/budgets and maintenance cadence.
 *
 * Enforcement consumers (cleanup, quota reservation, search budgets) arrive with
 * tickets #8/#16/#19; this module only defines the schema, spec defaults, and the
 * reload point those consumers must call per operation or maintenance cycle.
 */
const DAY_MS = 86400000;
const positiveInt = z.number().int().min(1);
// Retention periods allow 0: an explicit zero means "expire immediately".
const periodMs = z.number().int().min(0);

// Leaf validators for the stored/update form carry no defaults: an unspecified
// leaf must stay unspecified so partial updates never materialize sibling values.
const storedLeaves = {
  limits: {
    localWorkspaceBytes: positiveInt.describe("Per-workspace byte quota on this machine, default 10 GiB"),
    remoteWorkspaceBytes: positiveInt.describe("Per-workspace byte quota on the remote server, default 10 GiB"),
  },
  retention: {
    confirmedTaskLogMs: periodMs.describe("Keep acknowledged task logs this long, counted from acknowledgement, default 3 days"),
    confirmedResultMs: periodMs.describe("Keep acknowledged task/transfer results this long, default 30 days"),
    unconfirmedResultMs: periodMs.describe("Keep finished but unacknowledged results this long, default 30 days"),
    unknownRecordMs: periodMs.describe("Keep unknown-result records, diagnostics and recovery notes this long, default 30 days"),
    interruptedTransferDataMs: periodMs.describe("Keep interrupted transfer temporary data this long after its last real progress, default 3 days"),
    readTokenMs: periodMs.describe("Read credentials expire this long after the last successful related read or edit, default 3 days"),
  },
  search: {
    respectGitignore: z.boolean().describe("Honor hierarchy .gitignore files only when explicitly enabled, default false"),
    includeHidden: z.boolean().describe("Include hidden paths in search and find, default true; .git internals are always excluded"),
    scanBudgetBytes: positiveInt.describe("Remote scan budget per search page, default 512 MiB"),
    timeBudgetMs: positiveInt.describe("Remote scan time budget per search page, default 10000 ms"),
    pageSizeBytes: positiveInt.describe("Serialized bytes returned per search page, default 64 KiB"),
  },
  maintenance: {
    intervalMs: periodMs.min(1).describe("Online maintenance cadence, default hourly"),
    maxItemsPerRun: positiveInt.describe("Maximum items handled per maintenance run, default 100"),
    timeBudgetMs: positiveInt.describe("Time budget per maintenance run, default 2000 ms"),
  },
};

/** Spec defaults: every leaf has an effective value even when absent from the profile. */
export const policyDefaults = {
  limits: { localWorkspaceBytes: 10 * 1024 ** 3, remoteWorkspaceBytes: 10 * 1024 ** 3 },
  retention: { confirmedTaskLogMs: 3 * DAY_MS, confirmedResultMs: 30 * DAY_MS, unconfirmedResultMs: 30 * DAY_MS,
    unknownRecordMs: 30 * DAY_MS, interruptedTransferDataMs: 3 * DAY_MS, readTokenMs: 3 * DAY_MS },
  search: { respectGitignore: false, includeHidden: true, scanBudgetBytes: 512 * 1024 ** 2, timeBudgetMs: 10000, pageSizeBytes: 64 * 1024 },
  maintenance: { intervalMs: 3600000, maxItemsPerRun: 100, timeBudgetMs: 2000 },
};

/** Stored and update-patch form: every leaf optional, unknown keys rejected so typos fail loudly. */
export const policySectionSchema = z.object({
  limits: z.object(storedLeaves.limits).partial().strict().optional(),
  retention: z.object(storedLeaves.retention).partial().strict().optional(),
  search: z.object(storedLeaves.search).partial().strict().optional(),
  maintenance: z.object(storedLeaves.maintenance).partial().strict().optional(),
}).strict();

const resolvedPolicySchema = z.object({
  limits: z.object({
    localWorkspaceBytes: positiveInt.default(policyDefaults.limits.localWorkspaceBytes),
    remoteWorkspaceBytes: positiveInt.default(policyDefaults.limits.remoteWorkspaceBytes),
  }).strict(),
  retention: z.object({
    confirmedTaskLogMs: periodMs.default(policyDefaults.retention.confirmedTaskLogMs),
    confirmedResultMs: periodMs.default(policyDefaults.retention.confirmedResultMs),
    unconfirmedResultMs: periodMs.default(policyDefaults.retention.unconfirmedResultMs),
    unknownRecordMs: periodMs.default(policyDefaults.retention.unknownRecordMs),
    interruptedTransferDataMs: periodMs.default(policyDefaults.retention.interruptedTransferDataMs),
    readTokenMs: periodMs.default(policyDefaults.retention.readTokenMs),
  }).strict(),
  search: z.object({
    respectGitignore: z.boolean().default(policyDefaults.search.respectGitignore),
    includeHidden: z.boolean().default(policyDefaults.search.includeHidden),
    scanBudgetBytes: positiveInt.default(policyDefaults.search.scanBudgetBytes),
    timeBudgetMs: positiveInt.default(policyDefaults.search.timeBudgetMs),
    pageSizeBytes: positiveInt.default(policyDefaults.search.pageSizeBytes),
  }).strict(),
  maintenance: z.object({
    intervalMs: periodMs.min(1).default(policyDefaults.maintenance.intervalMs),
    maxItemsPerRun: positiveInt.default(policyDefaults.maintenance.maxItemsPerRun),
    timeBudgetMs: positiveInt.default(policyDefaults.maintenance.timeBudgetMs),
  }).strict(),
}).strict();

export type WorkspacePolicy = z.infer<typeof resolvedPolicySchema>;
export type StoredPolicy = z.infer<typeof policySectionSchema>;

/** Fills every unspecified leaf with its spec default; input is expected to come from policySectionSchema. */
export function resolvePolicy(stored: unknown): WorkspacePolicy {
  const input = (stored === undefined || stored === null ? {} : stored) as Record<string, unknown>;
  return resolvedPolicySchema.parse({
    limits: input.limits ?? {},
    retention: input.retention ?? {},
    search: input.search ?? {},
    maintenance: input.maintenance ?? {},
  });
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid value";
}

/**
 * Reload point for policy consumers: re-reads the profile from disk on every call
 * so saved changes apply from the next operation or maintenance cycle without a
 * server restart. Callers must not cache the result across operations.
 */
export async function loadPolicy(profilePath: string): Promise<WorkspacePolicy> {
  let stored: unknown;
  try {
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    stored = profile && typeof profile === "object" ? (profile as Record<string, unknown>).policy : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RemoteAgentError("INVALID_CONFIG", `Workspace profile not found at ${profilePath}`);
    }
    throw error;
  }
  const parsed = policySectionSchema.safeParse(stored ?? {});
  if (!parsed.success) {
    throw new RemoteAgentError("INVALID_CONFIG", `Invalid policy section in ${profilePath}: ${firstIssue(parsed.error)}`);
  }
  return resolvePolicy(parsed.data);
}
