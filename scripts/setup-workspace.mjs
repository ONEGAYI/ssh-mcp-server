#!/usr/bin/env node
// Optional manual entry; remote_setup uses the same integration implementation.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupWorkspaceIntegration } from '../build/services/workspace-setup.js';

const { values } = parseArgs({ options: { workspace: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/setup-workspace.mjs --workspace <profile.json> [--apply]\nWithout --apply prints the proposed project integration; with --apply merges it atomically.');
} else {
  if (!values.workspace) throw new Error('--workspace is required');
  console.log(JSON.stringify(await setupWorkspaceIntegration(resolve(values.workspace), Boolean(values.apply)), null, 2));
}
