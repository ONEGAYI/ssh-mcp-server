#!/usr/bin/env node
// Optional manual entry; remote_setup uses the same integration implementation.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadWorkspaceConfig } from '../build/config/workspace.js';
import { setupWorkspaceIntegration } from '../build/services/workspace-setup.js';

const { values } = parseArgs({ options: { workspace: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/setup-workspace.mjs --workspace <profile.json> [--apply]\nWithout --apply prints the proposed project integration; with --apply merges it atomically.');
} else {
  if (!values.workspace) throw new Error('--workspace is required');
  const profile = await loadWorkspaceConfig(resolve(values.workspace));
  console.log(JSON.stringify(await setupWorkspaceIntegration(profile, Boolean(values.apply)), null, 2));
}
