#!/usr/bin/env node
// Persists this machine's default SSH MCP JSON library path so remote_setup
// calls that omit sshConfigFile stop asking for it. The read side lives in
// the setup MCP (setup-server readDefaultConfig); this script is the writer.
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const defaultsPath = process.env.SSH_MCP_SETUP_DEFAULTS ?? join(homedir(), ".ssh-mcp-setup-defaults.json");
const argument = process.argv[2];
const say = value => { console.log(JSON.stringify(value)); };
const usage = "Usage: node set-default-config.mjs <absolute-ssh-config-path> | --show";

if (argument === "--show") {
  try {
    const saved = JSON.parse(await readFile(defaultsPath, "utf8"));
    say({ ok: true, defaultsPath, sshConfigFile: saved.sshConfigFile ?? null });
  } catch (error) {
    if (error.code === "ENOENT") say({ ok: true, defaultsPath, sshConfigFile: null });
    else { say({ ok: false, error: `Could not read ${defaultsPath}: ${error.message}` }); process.exitCode = 1; }
  }
} else if (isAbsolute(argument ?? "")) {
  try {
    const library = JSON.parse(await readFile(argument, "utf8"));
    if (!library || typeof library !== "object" || Array.isArray(library) || Object.keys(library).length === 0) {
      throw new Error("the file is not a non-empty SSH MCP JSON connection library");
    }
    const content = JSON.stringify({ sshConfigFile: argument }, null, 2) + "\n";
    const temporary = join(dirname(defaultsPath), `.${basename(defaultsPath)}.tmp-${process.pid}`);
    await writeFile(temporary, content);
    await rename(temporary, defaultsPath);
    say({ ok: true, defaultsPath, sshConfigFile: argument });
  } catch (error) {
    process.exitCode = 1;
    say({ ok: false, error: `Could not save the default (only the path is stored; credentials stay in the library): ${error.message}` });
  }
} else {
  process.exitCode = 1;
  say({ ok: false, error: usage });
}
