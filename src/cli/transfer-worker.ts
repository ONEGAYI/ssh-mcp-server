#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createWorkspaceRuntime } from "../services/workspace-runtime.js";
import { FileService } from "../services/file-service.js";
import { TransferService } from "../services/transfer-service.js";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

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
    const record = JSON.parse(await readFile(message.recordPath, "utf8"));
    record.error = { code: fault.code ?? "TRANSFER_DRIVER_FAILED", message: fault.message };
    if (!["completed", "cancelled", "failed", "unknown"].includes(record.state)) {
      record.state = fault.code === "TRANSFER_STATE_UNKNOWN" ? "unknown" : "failed";
      record.completedAt = Date.now();
    }
    const temporary = message.recordPath + "." + randomUUID() + ".tmp";
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, message.recordPath);
    } finally { await unlink(temporary).catch(cause => { if (cause.code !== "ENOENT") throw cause; }); }
    console.error(JSON.stringify(record.error));
    process.exitCode = 1;
  } finally { runtime?.close(); }
});
process.send!({ ready: true });
