import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { z } from "zod";
import { CommandLineParser } from "../cli/command-line-parser.js";
import { SshConnectionConfigMap } from "../models/types.js";
import { RemoteAgentError } from "../services/remote-agent-client.js";

const remotePath = z.string().min(1).refine(value => posix.isAbsolute(value) && !value.includes("\0"), "Expected an absolute POSIX path");
const profileSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  bindingName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  connectionName: z.string().min(1),
  sshConfigFile: z.string().min(1),
  remoteRoot: remotePath,
  remoteStateDir: remotePath.refine(value => posix.normalize(value) !== "/", "State must not be stored at filesystem root"),
  // Absent means restricted; setup only writes the field for an explicit unrestricted choice.
  // The scope deliberately stays out of identity so flipping it never rekeys task ownership.
  directoryScope: z.enum(["restricted", "unrestricted"]).optional(),
  localStateDir: z.string().min(1).optional(),
  localRoot: z.string().min(1).optional(),
  pythonPath: remotePath.default("/usr/bin/python3"),
}).strict();

/** The MCP server name shown to ZCode; setup integration and recovery must derive it identically. */
export function serverNameForWorkspaceId(workspaceId: string): string {
  return "ssh-workspace-" + workspaceId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export interface WorkspaceConfig {
  workspaceId: string;
  bindingName?: string;
  identity: string;
  profilePath: string;
  connectionName: string;
  sshConfigFile: string;
  sshConfigs: SshConnectionConfigMap;
  remoteRoot: string;
  remoteStateDir: string;
  directoryScope: "restricted" | "unrestricted";
  localStateDir: string;
  localRoot: string;
  pythonPath: string;
}

export async function loadWorkspaceConfig(profilePath: string): Promise<WorkspaceConfig> {
  const absolute = resolve(profilePath);
  const profile = profileSchema.parse(JSON.parse(await readFile(absolute, "utf8")));
  const sshConfigFile = resolve(dirname(absolute), profile.sshConfigFile);
  const { configs } = CommandLineParser.parseArgs(["--config-file", sshConfigFile]);
  const connection = configs[profile.connectionName];
  if (!connection) throw new RemoteAgentError("INVALID_CONFIG", "The selected SSH connection is not configured");
  const root = posix.normalize(profile.remoteRoot);
  const identity = createHash("sha256").update(JSON.stringify({
    workspaceId: profile.workspaceId, host: connection.host, port: connection.port,
    username: connection.username, root, stateRoot: posix.normalize(profile.remoteStateDir),
  })).digest("hex");
  return { ...profile, identity, profilePath: absolute, sshConfigFile, sshConfigs: configs,
    remoteRoot: root, remoteStateDir: posix.join(profile.remoteStateDir, "workspaces", identity.slice(0, 24)),
    directoryScope: profile.directoryScope ?? "restricted",
    localStateDir: profile.localStateDir ? resolve(dirname(absolute), profile.localStateDir) : join(homedir(), ".ssh-mcp-agent"),
    localRoot: profile.localRoot ? resolve(dirname(absolute), profile.localRoot) : dirname(absolute),
  };
}
