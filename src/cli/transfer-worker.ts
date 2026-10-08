#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createWorkspaceRuntime } from "../services/workspace-runtime.js";
import { FileService } from "../services/file-service.js";
import { TransferService } from "../services/transfer-service.js";
import { readFile } from "node:fs/promises";
import { writeTransferState, TransferStateWriteError } from "../services/transfer-state.js";

const { values } = parseArgs({ options: { workspace: { type: "string" }, session: { type: "string" }, "transfer-id": { type: "string" } } });
if (!values.workspace || !values.session || !values["transfer-id"] || !process.send) throw new Error("The transfer worker requires a parent ownership handoff");
let started = false;
process.once("disconnect", () => { if (!started) process.exit(1); });
process.once("message", async (message: { token: string; recordPath: string }) => {
  started = true;
  let runtime;
  try {
    runtime = await createWorkspaceRuntime(values.workspace!);
    const transfers = new TransferService(runtime.remote, runtime.config, new FileService(runtime.remote, runtime.config));
    await transfers.runBackground(values.session!, values["transfer-id"]!, message.token);
  } catch (error) {
    const fault = error as Error & { code?: string };
    console.error(JSON.stringify(error instanceof TransferStateWriteError ? error : { code: fault.code ?? "TRANSFER_DRIVER_FAILED", message: fault.message }));
    const record = JSON.parse(await readFile(message.recordPath, "utf8"));
    record.error = error instanceof TransferStateWriteError ? error.toJSON()
      : { code: fault.code ?? "TRANSFER_DRIVER_FAILED", message: fault.message };
    if (error instanceof TransferStateWriteError) record.retryAfter = Date.now() + 1000;
    else if (!["completed", "cancelled", "failed", "unknown"].includes(record.state)) {
      record.state = fault.code === "TRANSFER_STATE_UNKNOWN" ? "unknown" : "failed";
      record.completedAt = Date.now();
    }
    await writeTransferState(message.recordPath, record);
    process.exitCode = 1;
  } finally { runtime?.close(); }
});
process.send!({ ready: true });
