#!/usr/bin/env node
import { cp, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/package-offline.mjs --output <new-directory>\nCopies built code, installed dependencies, current Node runtime and guides. Does not copy credentials, profiles or .artifacts.');
} else {
  if (!values.output) throw new Error('--output is required');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const output = resolve(values.output);
  await mkdir(output); // Existing destinations are never overwritten.
  for (const name of ['build', 'node_modules', 'docs', 'examples']) {
    await cp(join(source, name), join(output, name), { recursive: true, dereference: true,
      filter: entry => !entry.includes('.artifacts') });
  }
  for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'README.md']) {
    await copyFile(join(source, name), join(output, name));
  }
  await mkdir(join(output, 'scripts'));
  await copyFile(join(source, 'scripts', 'setup-workspace.mjs'), join(output, 'scripts', 'setup-workspace.mjs'));
  await mkdir(join(output, 'runtime'));
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  await copyFile(process.execPath, join(output, 'runtime', executable));
  const files = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const data = await readFile(path);
        files.push({ path: relative(output, path).replaceAll('\\', '/'), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      }
    }
  };
  await walk(output);
  const manifest = { formatVersion: 1, createdAt: new Date().toISOString(), platform: process.platform,
    arch: process.arch, nodeVersion: process.version, remoteRequirements: 'Linux Python >=3.6, /bin/bash, SSH exec; no remote network downloads', files };
  await writeFile(join(output, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output, files: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0), nodeVersion: process.version, platform: process.platform, arch: process.arch }));
}
