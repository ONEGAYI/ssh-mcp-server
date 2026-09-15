#!/usr/bin/env node
// Optional manual entry; remote_setup uses the same integration implementation.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadWorkspaceConfig } from '../build/config/workspace.js';
import { removeWorkspaceBinding, setupWorkspaceIntegration } from '../build/services/workspace-setup.js';

const { values } = parseArgs({ options: {
  workspace: { type: 'string' },
  apply: { type: 'boolean' },
  remove: { type: 'boolean' },
  revision: { type: 'string' },
  help: { type: 'boolean' },
} });

if (values.help) {
  console.log('node scripts/setup-workspace.mjs --workspace <profile.json> [--apply]\n' +
    'Without --apply prints the proposed project integration; with --apply merges it atomically.\n\n' +
    'node scripts/setup-workspace.mjs --workspace <profile.json> --remove [--revision <token>]\n' +
    'Without --revision prints a removal preview including the current revision and pending work;\n' +
    'with --revision removes the binding locally (profile, generated connection file, MCP entry,\n' +
    'recovery hook, local state; never any SSH connection).');
} else if (values.remove) {
  if (!values.workspace) throw new Error('--workspace is required');
  if (values.apply) throw new Error('--remove cannot be combined with --apply');
  if (values.revision === '') throw new Error('--revision must not be empty');
  try {
    // Purely local: works with no MCP client, and never opens an SSH connection.
    const result = await removeWorkspaceBinding(resolve(values.workspace), values.revision);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ code: error?.code ?? 'SETUP_FAILED',
      message: error instanceof Error ? error.message : 'Removal failed; nothing else was touched.' }));
    process.exitCode = 1;
  }
} else {
  if (values.revision !== undefined) throw new Error('--revision only applies together with --remove');
  if (!values.workspace) throw new Error('--workspace is required');
  const profile = await loadWorkspaceConfig(resolve(values.workspace));
  console.log(JSON.stringify(await setupWorkspaceIntegration(profile, Boolean(values.apply)), null, 2));
}
