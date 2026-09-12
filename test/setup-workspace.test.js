import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('setup merges project MCP/hooks idempotently and preserves existing rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-setup-'));
  try {
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ offline: { host: 'localhost', port: 22, username: 'test', password: 'test-only' } }));
    const profile = join(root, 'profile.json');
    await writeFile(profile, JSON.stringify({ workspaceId: 'test', connectionName: 'offline', sshConfigFile: 'ssh.json', remoteRoot: '/work', remoteStateDir: '/state' }));
    await mkdir(join(root, '.zcode'));
    await writeFile(join(root, '.zcode', 'config.json'), JSON.stringify({ mcp: { servers: { existing: { command: 'keep' } } }, hooks: { events: { Stop: [] } } }));
    await writeFile(join(root, 'AGENTS.md'), 'keep rules');
    for (let i = 0; i < 2; i++) {
      const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/setup-workspace.mjs', import.meta.url)), '--workspace', profile, '--apply'], { encoding: 'utf8', timeout: 10000 });
      assert.equal(run.status, 0, run.stderr);
    }
    const config = JSON.parse(await readFile(join(root, '.zcode', 'config.json'), 'utf8'));
    assert.equal(config.mcp.servers.existing.command, 'keep');
    assert.ok(config.mcp.servers['ssh-workspace-test']);
    assert.equal(config.hooks.events.UserPromptSubmit.length, 1);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'keep rules');
    assert.equal(await readFile(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
