import { createHash } from "node:crypto";
import { createConnection } from "node:net";

/** OS-owned endpoint shared by drivers, observers and expiry maintenance. */
export function transferDriverEndpoint(identity: string, transferId: string): string {
  const name = "ssh-mcp-transfer-" + createHash("sha256").update(identity + transferId).digest("hex").slice(0, 48);
  return process.platform === "win32" ? "\\\\.\\pipe\\" + name : "\0" + name;
}

export function transferDriverRunning(identity: string, transferId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(transferDriverEndpoint(identity, transferId));
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", error => {
      socket.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}
