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
  connectionName: z.string().min(1),
  sshConfigFile: z.string().min(1),
  remoteRoot: remotePath,
  remoteStateDir: remotePath.refine(value => posix.normalize(value) !== "/", "State must not be stored at filesystem root"),
  localStateDir: z.string().min(1).optional(),
  localRoot: z.string().min(1).optional(),
  pythonPath: remotePath.default("/usr/bin/python3"),
}).strict();

export interface WorkspaceConfig {
  workspaceId: string;
  identity: string;
  profilePath: string;
  connectionName: string;
  sshConfigFile: string;
  sshConfigs: SshConnectionConfigMap;
  remoteRoot: string;
  remoteStateDir: string;
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
    localStateDir: profile.localStateDir ? resolve(dirname(absolute), profile.localStateDir) : join(homedir(), ".ssh-mcp-agent"),
    localRoot: profile.localRoot ? resolve(dirname(absolute), profile.localRoot) : dirname(absolute),
  };
}
