#!/usr/bin/env node
// Persists this machine's default SSH MCP JSON library path so remote_setup
// calls that omit sshConfigFile stop asking for it. The read side lives in
// the setup MCP (setup-server readDefaultConfig); this script is the writer.
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const defaultsPath = process.env.SSH_MCP_SETUP_DEFAULTS ?? join(homedir(), ".ssh-mcp-setup-defaults.json");
const args = process.argv.slice(2);
const say = value => { console.log(JSON.stringify(value)); };
const fail = message => { say({ ok: false, error: message }); process.exitCode = 1; };
const usage = "Usage: node set-default-config.mjs <absolute-ssh-config-path> | --show";

const main = async () => {
  if (args.length > 1) return fail(usage);
  if (args[0] === "--show") {
    try {
      const saved = JSON.parse(await readFile(defaultsPath, "utf8"));
      say({ ok: true, defaultsPath, sshConfigFile: saved?.sshConfigFile ?? null });
    } catch (error) {
      if (error.code === "ENOENT") say({ ok: true, defaultsPath, sshConfigFile: null });
      else fail(`Could not parse the saved default ${defaultsPath}: ${error.message}`);
    }
    return;
  }
  if (!isAbsolute(args[0] ?? "")) return fail(usage);
  let CommandLineParser;
  try {
    ({ CommandLineParser } = await import(new URL("../../../build/cli/command-line-parser.js", import.meta.url)));
  } catch (error) {
    return fail(`The plugin build is missing; run this skill's npm install and npm run build steps first (${error.code ?? error.message})`);
  }
  try {
    // Same acceptance test as the setup MCP's connection listing, including
    // upstream's array library format, so what saves here is usable there.
    const configs = CommandLineParser.parseArgs(["--config-file", args[0]]).configs;
    const connections = Object.keys(configs ?? {});
    if (connections.length === 0) throw new Error("the file does not define any SSH MCP connection");
    const content = JSON.stringify({ sshConfigFile: args[0] }, null, 2) + "\n";
    const temporary = join(dirname(defaultsPath), `.${basename(defaultsPath)}.tmp-${process.pid}`);
    try {
      await writeFile(temporary, content);
      await rename(temporary, defaultsPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    say({ ok: true, defaultsPath, sshConfigFile: args[0], connections });
  } catch (error) {
    fail(`Could not save the default (only the path is stored; credentials stay in the library): ${error.message}`);
  }
};
await main();
