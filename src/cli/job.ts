#!/usr/bin/env node
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import { createWorkspaceRuntime } from "../services/workspace-runtime.js";
import { FileService } from "../services/file-service.js";
import { RemoteAgentError } from "../services/remote-agent-client.js";
import { RemoteTask } from "../services/task-service.js";

const HELP = `Usage: ssh-mcp-job <run|wait|status|cancel|pending|ack|cleanup|doctor> --workspace <profile.json> --session <session-id>
  run --command <shell text> [--cwd <remote directory>] [--env KEY=value]
      [--execution-timeout <ms>] [--max-output-bytes <bytes>]
  wait|status|cancel|ack --job-id <id>
  run|wait [--wait-timeout <ms>]
  cleanup [--retention-days <days>]  Delete only acknowledged terminal logs (default 7 days)
  doctor                            Inspect remote capabilities and actual runtime libc
Run this command through ZCode's native background Shell tool for automatic completion delivery.
Ending this local waiter does not cancel the remote task. Results remain pending until ack.`;

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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean" }, workspace: { type: "string" }, session: { type: "string" },
    command: { type: "string" }, cwd: { type: "string" }, "job-id": { type: "string" },
    env: { type: "string", multiple: true }, "wait-timeout": { type: "string" },
    "execution-timeout": { type: "string" }, "max-output-bytes": { type: "string" },
    "retention-days": { type: "string" },
  } });
  if (values.help) { console.log(HELP); return; }
  if (!values.workspace || !values.session) throw new RemoteAgentError("INVALID_OPTION", "--workspace and --session are required");
  const action = positionals[0];
  if (positionals.length !== 1 || !["run", "wait", "status", "cancel", "pending", "ack", "cleanup", "doctor"].includes(action)) {
    throw new RemoteAgentError("INVALID_OPTION", HELP);
  }
  const runtime = await createWorkspaceRuntime(values.workspace);
  try {
    if (action === "cleanup") { console.log(JSON.stringify(await runtime.remote.call("cleanup", { retentionDays: numberOption(values["retention-days"]) ?? 7 }))); return; }
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
  console.error(JSON.stringify({ kind: "error", code: error.code ?? "UNEXPECTED_ERROR", jobId: error.jobId, message: error.message }));
  process.exitCode = 1;
});
