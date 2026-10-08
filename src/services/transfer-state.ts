import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** A Windows refusal to replace a small transfer-state file can be resumed. */
export class TransferStateWriteError extends Error {
  readonly retriable = true;
  readonly phase = "transfer-state";
  readonly code: string;
  readonly syscall?: string;
  readonly path?: string;
  readonly dest?: string;
  cleanupError?: { code?: string; message: string; syscall?: string; path?: string };

  constructor(cause: NodeJS.ErrnoException & { dest?: string }) {
    super(cause.message, { cause });
    this.name = "TransferStateWriteError";
    this.code = cause.code!;
    this.syscall = cause.syscall;
    this.path = cause.path;
    this.dest = cause.dest;
  }

  toJSON() {
    return { code: this.code, message: this.message, retriable: this.retriable, phase: this.phase,
      syscall: this.syscall, path: this.path, dest: this.dest, cleanupError: this.cleanupError };
  }
}

/** Retry only Windows sharing refusals; keep the same synced temp and atomic replace. */
export async function writeTransferState(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let failure: unknown;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        const fault = error as NodeJS.ErrnoException & { dest?: string };
        if (process.platform !== "win32" || (fault.code !== "EPERM" && fault.code !== "EBUSY")) throw error;
        if (attempt === 4) throw new TransferStateWriteError(fault);
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      if (failure instanceof TransferStateWriteError) {
        failure.cleanupError = { code: error.code, message: error.message, syscall: error.syscall, path: error.path };
        throw failure;
      }
      throw error;
    });
  }
}
