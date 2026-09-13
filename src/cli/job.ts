#!/usr/bin/env node
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import { createWorkspaceRuntime } from "../services/workspace-runtime.js";
import { FileService } from "../services/file-service.js";
import { TransferService, TransferOutcome } from "../services/transfer-service.js";
import { MaintenanceService } from "../services/maintenance.js";
import { RemoteAgentError } from "../services/remote-agent-client.js";
import { RemoteTask } from "../services/task-service.js";

const HELP = `Usage: ssh-mcp-job <run|wait|status|cancel|pending|ack|cleanup|doctor|maintain> --workspace <profile.json> --session <session-id>
  run --command <shell text> [--cwd <remote directory>] [--env KEY=value]
      [--execution-timeout <ms>] [--max-output-bytes <bytes>]
  wait|status|cancel|ack --job-id <id>
  run|wait [--wait-timeout <ms>]
  transfer <start|wait|status|resume|cancel|ack|pending>
      start --direction upload|download --local <local path> --remote <remote path>
          [--create] [--overwrite] [--expected-version <version>]
          [--chunk-size <bytes>] [--budget <ms>]
      wait|status|resume|cancel|ack --transfer-id <id>
      wait|resume [--budget <ms>]  wait also takes [--wait-timeout <ms>]
  cleanup [--retention-days <days>]  Delete only acknowledged terminal logs (default 7 days)
  maintain                          Run one bounded expiry-reclamation round now (both ends);
                                    normally triggered automatically, at most hourly
  doctor                            Inspect remote capabilities and actual runtime libc
Run this command through ZCode's native background Shell tool for automatic completion delivery.
Ending this local waiter does not cancel the remote task or transfer. Results remain pending until ack.`;

const TASK_ACTIONS = ["run", "wait", "status", "cancel", "pending", "ack", "cleanup", "doctor", "maintain"];
const TRANSFER_ACTIONS = ["start", "wait", "status", "resume", "cancel", "ack", "pending"];
/** Transfer outcomes that end a background waiter (issue #15). */
const TERMINAL_TRANSFERS = new Set(["completed", "failed", "cancelled"]);

function numberOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RemoteAgentError("INVALID_OPTION", "Numeric options must be nonnegative safe integers");
  return number;
}

function taskExitCode(task: RemoteTask): number {
  if (task.state === "cancelled") return 130;
  if (task.reason === "EXECUTION_TIMEOUT") return 124;
  if (task.reason === "OUTPUT_LIMIT") return 125;
  if (task.state !== "exited" || task.exitCode === undefined) return 1;
  return task.exitCode >= 0 && task.exitCode <= 255 ? task.exitCode : 128 + Math.min(Math.abs(task.exitCode), 127);
}

/** Drive one transfer to a terminal outcome with bounded backoff on transport
 * breaks. Deliberately quiet: no per-block progress is printed -- the waiter
 * reports only on completion, failure or a pause (spec 6.3). */
async function driveTransfer(transfers: TransferService, sessionId: string, transferId: string,
  options: { budgetMs?: number; waitTimeoutMs?: number }):
  Promise<{ outcome?: TransferOutcome; timedOut: boolean }> {
  const deadline = options.waitTimeoutMs === undefined ? Infinity : Date.now() + options.waitTimeoutMs;
  let retryDelay = 500;
  for (;;) {
    try {
      const outcome = await transfers.resume(sessionId, transferId, options.budgetMs);
      if (TERMINAL_TRANSFERS.has(outcome.state)) return { outcome, timedOut: false };
      retryDelay = 500; // progress happened; keep driving without backoff
    } catch (error) {
      if ((error as { retriable?: boolean })?.retriable !== true) {
        // A semantic refusal is the result of the wait; never a silent success.
        if (error instanceof Error && !("transferId" in error)) Object.assign(error, { transferId });
        throw error;
      }
      // Connection trouble: bounded backoff; the pause is observable, not fatal.
      if (Date.now() >= deadline) return { timedOut: true };
      await new Promise(resolve => setTimeout(resolve, Math.min(retryDelay, Math.max(0, deadline - Date.now()))));
      retryDelay = Math.min(retryDelay * 2, 8000);
      continue;
    }
    if (Date.now() >= deadline) return { timedOut: true };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean" }, workspace: { type: "string" }, session: { type: "string" },
    command: { type: "string" }, cwd: { type: "string" }, "job-id": { type: "string" },
    "transfer-id": { type: "string" }, direction: { type: "string" },
    local: { type: "string" }, remote: { type: "string" },
    create: { type: "boolean" }, overwrite: { type: "boolean" },
    "expected-version": { type: "string" }, "chunk-size": { type: "string" }, budget: { type: "string" },
    env: { type: "string", multiple: true }, "wait-timeout": { type: "string" },
    "execution-timeout": { type: "string" }, "max-output-bytes": { type: "string" },
    "retention-days": { type: "string" },
  } });
  if (values.help) { console.log(HELP); return; }
  if (!values.workspace || !values.session) throw new RemoteAgentError("INVALID_OPTION", "--workspace and --session are required");
  // `transfer <sub>` is the only two-positional form; everything else is flat.
  const transferMode = positionals[0] === "transfer";
  const action = transferMode ? positionals[1] : positionals[0];
  const expectedPositionals = transferMode ? 2 : 1;
  const validActions = transferMode ? TRANSFER_ACTIONS : TASK_ACTIONS;
  if (positionals.length !== expectedPositionals || !validActions.includes(action)) {
    throw new RemoteAgentError("INVALID_OPTION", HELP);
  }
  const runtime = await createWorkspaceRuntime(values.workspace);
  try {
    // Hourly online maintenance rides along with every CLI run (issue #16);
    // a failure here never blocks the requested action. `pending` stays an
    // offline-safe recovery query: no remote round-trip is added to it.
    const maintenance = new MaintenanceService(runtime.config, runtime.remote);
    if (action !== "maintain" && action !== "pending") {
      await maintenance.maybeMaintain().catch(() => undefined);
    }
    if (transferMode) {
      const files = new FileService(runtime.remote, runtime.config);
      const transfers = new TransferService(runtime.remote, runtime.config, files);
      if (action === "pending") {
        console.log(JSON.stringify({ transfers: await transfers.pending(values.session) }));
        return;
      }
      if (action === "start") {
        if (values.direction !== "upload" && values.direction !== "download") {
          throw new RemoteAgentError("INVALID_OPTION", "--direction must be upload or download");
        }
        if (!values.local || !values.remote) throw new RemoteAgentError("INVALID_OPTION", "start requires --local and --remote");
        const request = { localPath: values.local, path: values.remote,
          create: values.create || undefined, overwrite: values.overwrite || undefined,
          expectedVersion: values["expected-version"], chunkSize: numberOption(values["chunk-size"]),
          budgetMs: numberOption(values.budget) };
        const outcome = values.direction === "upload"
          ? await transfers.upload(values.session, request)
          : await transfers.download(values.session, request);
        if (TERMINAL_TRANSFERS.has(outcome.state)) {
          console.log(JSON.stringify({ kind: "transfer-result", ...outcome, acknowledgementRequired: true }));
          process.exitCode = outcome.state === "completed" ? 0 : 1;
        } else {
          console.log(JSON.stringify({ kind: "transfer-started", ...outcome,
            hint: "Attach ZCode's native background Shell to the durable id: ssh-mcp-job transfer wait --transfer-id " + outcome.transferId }));
        }
        return;
      }
      const transferId = values["transfer-id"];
      if (!transferId) throw new RemoteAgentError("INVALID_OPTION", action + " requires --transfer-id");
      if (action === "status") { console.log(JSON.stringify(await transfers.status(values.session, transferId))); return; }
      if (action === "cancel") { console.log(JSON.stringify(await transfers.cancel(values.session, transferId))); return; }
      if (action === "ack") {
        console.log(JSON.stringify(await transfers.acknowledge(values.session, transferId)));
        return;
      }
      if (action === "resume") {
        const outcome = await transfers.resume(values.session, transferId, numberOption(values.budget));
        if (TERMINAL_TRANSFERS.has(outcome.state)) {
          console.log(JSON.stringify({ kind: "transfer-result", ...outcome, acknowledgementRequired: true }));
          process.exitCode = outcome.state === "completed" ? 0 : 1;
        } else {
          console.log(JSON.stringify({ kind: "transfer-progress", ...outcome }));
        }
        return;
      }
      // wait: the ZCode background waiter (spec 6.3).
      const waited = await driveTransfer(transfers, values.session, transferId,
        { budgetMs: numberOption(values.budget), waitTimeoutMs: numberOption(values["wait-timeout"]) });
      if (waited.timedOut) {
        console.log(JSON.stringify({ kind: "transfer-wait-paused", transferId,
          message: "Wait timeout reached; the transfer keeps its durable progress. Reattach with transfer wait --transfer-id " + transferId }));
        return;
      }
      const outcome = waited.outcome!;
      console.log(JSON.stringify({ kind: "transfer-result", ...outcome, acknowledgementRequired: true }));
      process.exitCode = outcome.state === "completed" ? 0 : 1;
      return;
    }
    if (action === "cleanup") { console.log(JSON.stringify(await runtime.remote.call("cleanup", { retentionDays: numberOption(values["retention-days"]) ?? 7 }))); return; }
    if (action === "maintain") { console.log(JSON.stringify(await maintenance.maybeMaintain())); return; }
    if (action === "doctor") { console.log(JSON.stringify(await new FileService(runtime.remote, runtime.config).call("file_workspace", values.session))); return; }
    if (action === "pending") { console.log(JSON.stringify({ tasks: await runtime.tasks.pending(values.session) })); return; }
    let jobId = values["job-id"];
    if (action === "run") {
      if (!values.command) throw new RemoteAgentError("INVALID_OPTION", "--command is required for run");
      const env: Record<string, string> = {};
      for (const entry of values.env ?? []) {
        const at = entry.indexOf("=");
        if (at <= 0) throw new RemoteAgentError("INVALID_OPTION", "--env must have the form KEY=value");
        env[entry.slice(0, at)] = entry.slice(at + 1);
      }
      const record = await runtime.start({ sessionId: values.session, command: values.command,
        cwd: values.cwd ? posix.resolve(runtime.config.remoteRoot, values.cwd) : runtime.config.remoteRoot,
        env, executionTimeoutMs: numberOption(values["execution-timeout"]), maxOutputBytes: numberOption(values["max-output-bytes"]),
      });
      jobId = record.jobId;
      console.log(JSON.stringify({ kind: "task-started", jobId, sessionId: values.session, workspaceId: runtime.config.workspaceId }));
    }
    if (!jobId) throw new RemoteAgentError("INVALID_OPTION", "--job-id is required");
    const record = await runtime.tasks.record(jobId);
    if (record.sessionId !== values.session) throw new RemoteAgentError("TASK_SCOPE_MISMATCH", "Task belongs to another session");
    if (action === "status") { console.log(JSON.stringify(await runtime.tasks.status(jobId))); return; }
    if (action === "cancel") { console.log(JSON.stringify(await runtime.tasks.cancel(jobId))); return; }
    if (action === "ack") { await runtime.tasks.acknowledge(jobId, values.session); console.log(JSON.stringify({ acknowledged: true, jobId })); return; }
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let displayed = 0, omitted = 0;
    const result = await runtime.tasks.wait(jobId, { waitTimeoutMs: numberOption(values["wait-timeout"]),
      onOutput(stream, data) {
        const allowed = data.subarray(0, Math.max(0, 65536 - displayed));
        displayed += allowed.length; omitted += data.length - allowed.length;
        if (allowed.length) process[stream].write(decoders[stream].write(allowed));
      },
    });
    process.stdout.write(decoders.stdout.end()); process.stderr.write(decoders.stderr.end());
    omitted = Math.max(omitted, result.stdoutOffset + result.stderrOffset - displayed);
    if (omitted) console.log(`\n[${omitted} output bytes omitted here; use remote_output with byte offsets or tail=true to read logs]`);
    console.log("\n" + JSON.stringify({ kind: result.timedOut ? "wait-paused" : "task-result", ...result, acknowledgementRequired: true }));
    process.exitCode = result.timedOut ? 0 : taskExitCode(result.task);
  } finally { runtime.close(); }
}

main().catch(error => {
  console.error(JSON.stringify({ kind: "error", code: error.code ?? "UNEXPECTED_ERROR", jobId: error.jobId,
    transferId: error.transferId, message: error.message }));
  process.exitCode = 1;
});
