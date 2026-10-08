import { quoteShell } from "./remote-agent-client.js";

/** The marker carries argv for exact ownership checks; the executable text must
 * also match, so a foreign command cannot borrow the marker to claim ownership. */
export function commandHook(argv: string[]) {
  const marker = "# ssh-mcp-hook " + Buffer.from(JSON.stringify(argv)).toString("base64");
  const command = marker + "\nexec " + argv.map(quoteShell).join(" ");
  const script = "& " + argv.map(value => "'" + value.replaceAll("'", "''") + "'").join(" ");
  return { type: "command", command,
    commandWindows: "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + Buffer.from(script, "utf16le").toString("base64") };
}

export function hookArgv(entry: any): string[] | undefined {
  if (Array.isArray(entry?.args)) return entry.args.every((value: unknown) => typeof value === "string") ? entry.args : undefined;
  if (typeof entry?.command !== "string") return undefined;
  const match = /^# ssh-mcp-hook ([A-Za-z0-9+/=]+)\n/.exec(entry.command);
  if (!match) return undefined;
  const raw = Buffer.from(match[1], "base64").toString("utf8");
  let argv: unknown;
  try { argv = JSON.parse(raw); }
  catch { return undefined; } // An unrecognized external command stays foreign.
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) return undefined;
  const expected = commandHook(argv);
  return entry.command === expected.command && entry.commandWindows === expected.commandWindows ? argv : undefined;
}
