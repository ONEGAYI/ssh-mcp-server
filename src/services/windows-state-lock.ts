import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";

/** Try to own one local Windows state lock. The OS releases the name on exit. */
export async function tryAcquireWindowsStateLock(directory: string, kind: "maintenance" | "ledger"):
  Promise<(() => Promise<void>) | undefined> {
  // Different spellings of the same state directory must contend, including
  // paths that arrive via a junction.
  const canonical = (await realpath(directory)).toLowerCase();
  const key = createHash("sha256").update(canonical).digest("hex");
  const server = createServer(socket => socket.destroy());
  try {
    server.listen(`\\\\.\\pipe\\ssh-mcp-state-${kind}-${key}`);
    await once(server, "listening");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
    throw error;
  }
  return () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
