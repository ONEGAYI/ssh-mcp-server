#!/usr/bin/env node
/** Lightweight distribution packaging: a single tar.gz with the README,
 * the compiled server (build/, including remote/*.py) and package.json.
 * Recipients run `npm install --omit=dev` and start `node build/index.js`.
 * For air-gapped delivery with a bundled Node runtime use
 * scripts/package-offline.mjs instead. */
import { execFileSync } from 'node:child_process';
import { cp, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    output: { type: 'string', default: 'dist' },
    'no-build': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log('node scripts/package-dist.mjs [--output <directory>] [--no-build]\n' +
    'Builds (unless --no-build) and packs README*, LICENSE, package.json and build/ into\n' +
    'dist/ssh-mcp-server-<version>.tar.gz. Credentials, profiles and node_modules are never included.');
  process.exit(0);
}

/** The distribution manifest: which files travel in the tarball, as
 * package-relative paths with their absolute sources. Exported for tests. */
export async function collectDist(source) {
  const entries = [];
  const addTree = async (relative, filter) => {
    const walk = async directory => {
      for (const item of await readdir(join(source, directory), { withFileTypes: true })) {
        const relativePath = `${directory}/${item.name}`;
        if (filter && !filter(relativePath)) continue;
        if (item.isDirectory()) await walk(relativePath);
        else if (item.isFile()) entries.push({ path: relativePath, source: join(source, relativePath) });
      }
    };
    await walk(relative);
  };
  for (const name of ['README.md', 'README_EN.md', 'LICENSE', 'package.json']) {
    entries.push({ path: name, source: join(source, name) });
  }
  await addTree('build');
  return entries;
}

async function main() {
  const source = fileURLToPath(new URL('../', import.meta.url));
  if (!values['no-build']) {
    execFileSync(process.execPath, ['scripts/build.js'], { stdio: 'inherit', cwd: source });
  }
  const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const packageName = `ssh-mcp-server-${version}`;
  const output = resolve(source, values.output);
  const stage = join(output, packageName);
  await rm(stage, { recursive: true, force: true }); // restaging replaces an existing stage only
  await mkdir(stage, { recursive: true });
  for (const entry of await collectDist(source)) {
    const destination = join(stage, entry.path);
    if (entry.path.includes('/')) await mkdir(join(destination, '..'), { recursive: true });
    await copyFile(entry.source, destination);
  }
  // Pack from inside the output directory with relative names: a Windows
  // drive letter in an absolute -f argument reads as a remote host to GNU
  // tar. bsdtar ships with Windows 10+ and every Unix.
  execFileSync('tar', ['-czf', `${packageName}.tar.gz`, packageName], { cwd: output });
  const archive = join(output, `${packageName}.tar.gz`);
  const { size } = await stat(archive);
  console.log(JSON.stringify({ archive, files: (await collectDist(source)).length, bytes: size }));
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href;
if (invokedDirectly) await main();
