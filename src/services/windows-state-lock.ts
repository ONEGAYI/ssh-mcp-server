import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";

/** Try to own one local Windows state lock. The OS releases the name on exit. */
export async function tryAcquireWindowsStateLock(directory: string, kind: "maintenance" | "ledger"):
  Promise<(() => Promise<void>) | undefined> {
  // Match the actual directory instead of folding path strings: junctions
  // and extended paths can name the same object, and Unicode case folding
  // can collapse strings that refer to different objects. Keep the full ID.
  const { dev, ino } = await stat(directory, { bigint: true });
  if (ino === 0n) throw new Error(`The filesystem did not provide an identity for Windows state directory: ${directory}`);
  const server = createServer(socket => socket.destroy());
  try {
    server.listen(`\\\\.\\pipe\\ssh-mcp-state-${kind}-${dev}-${ino}`);
    await once(server, "listening");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
    throw error;
  }
  return () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
