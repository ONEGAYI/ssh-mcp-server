// 契约测试：remote_write 的 inline 内容在工具 schema 层带粗防上限。工具描述
// 声称 "inline content is bounded by the request budget"；精确的 16 MiB 字节门
// 由远端 helper（remote/files.py）执行，这里验证 schema 声明的宽松字符上限
// （64 MiB）确实暴露给客户端，防止超大字符串无约束地进入请求管道。
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('remote_write bounds inline text and data with a coarse schema-level cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-write-schema-'));
  const client = new Client({ name: 'write-schema-test', version: '1' });
  try {
    await writeFile(join(directory, 'ssh.json'), JSON.stringify({ offline: { host: '127.0.0.1', port: 1, username: 'test', password: 'must-not-leak' } }));
    await writeFile(join(directory, 'workspace.json'), JSON.stringify({ workspaceId: 'schema', connectionName: 'offline', sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state' }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', join(directory, 'workspace.json')], stderr: 'pipe' }));
    const tools = await client.listTools();
    const write = tools.tools.find(tool => tool.name === 'remote_write');
    assert.ok(write, 'remote_write is advertised');
    for (const field of ['text', 'data']) {
      const property = write.inputSchema.properties[field];
      assert.ok(property, 'remote_write exposes ' + field);
      assert.equal(property.maxLength, 64 * 1024 * 1024, field + ' carries the coarse inline cap');
    }
  } finally {
    await client.close();
    const child = relative(tmpdir(), directory);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});
