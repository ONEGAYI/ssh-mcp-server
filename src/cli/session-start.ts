#!/usr/bin/env node
import { parseArgs } from "node:util";
import { clientSchema } from "../config/workspace.js";
import { sessionStartContext } from "../services/session-context.js";
import { RemoteAgentError } from "../services/remote-agent-client.js";

async function main() {
  const { values } = parseArgs({ options: { workspace: { type: "string" }, client: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    return "ssh-mcp-session-start --workspace profile.json --client zcode|codex — SessionStart JSON hook; optional per-binding AGENTS.md and skill catalog injection";
  }
  if (!values.workspace) throw new RemoteAgentError("INVALID_HOOK_INPUT", "--workspace is required");
  const client = clientSchema.parse(values.client ?? "zcode");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1048576) throw new RemoteAgentError("INVALID_HOOK_INPUT", "Hook input exceeds 1 MiB");
    chunks.push(data);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return sessionStartContext(values.workspace, client, input);
}

main().catch(error => {
  const code = error instanceof RemoteAgentError ? error.code : "CONTEXT_HOOK_FAILED";
  console.error(`SSH SessionStart failed: ${code}`);
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext:
    `SSH SessionStart 配置或输入读取失败：${code}。远端 AGENTS.md 与技能尚未注入，请核实该绑定配置。` } };
}).then(output => {
  // This dedicated hook process owns every connection. Flush the protocol
  // before exiting so unfinished SSH/proxy handshakes cannot extend its budget.
  process.stdout.write((typeof output === "string" ? output : JSON.stringify(output)) + "\n", () => process.exit(0));
});
