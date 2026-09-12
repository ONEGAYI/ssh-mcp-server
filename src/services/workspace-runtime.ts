import { loadWorkspaceConfig } from "../config/workspace.js";
import { SSHConnectionManager } from "./ssh-connection-manager.js";
import { RemoteAgentClient } from "./remote-agent-client.js";
import { TaskRequest, TaskService } from "./task-service.js";

export async function createWorkspaceRuntime(profilePath: string) {
  const config = await loadWorkspaceConfig(profilePath);
  const ssh = SSHConnectionManager.getInstance();
  ssh.setConfig(config.sshConfigs, config.connectionName);
  const remote = new RemoteAgentClient(ssh, config);
  const tasks = new TaskService({ call<T>(action: string, request: Record<string, unknown>) {
    if (action === "start") ssh.assertCommandAllowed(request.command as string, config.connectionName);
    return remote.call<T>(action, request);
  } }, config.localStateDir, config.identity);
  return { config, ssh, remote, tasks,
    start(request: TaskRequest) {
      ssh.assertCommandAllowed(request.command, config.connectionName);
      return tasks.start(request);
    },
    close() { ssh.disconnect(); },
  };
}
