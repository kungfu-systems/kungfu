#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
);
const toolNames = ['github-slugger', 'markdown-it', 'markdownlint-cli2'];
const identity = JSON.stringify({
  packageManager: manifest.packageManager,
  tools: Object.fromEntries(
    toolNames.map((name) => [name, manifest.devDependencies[name]]),
  ),
  lock: crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml')))
    .digest('hex'),
});
const key = crypto
  .createHash('sha256')
  .update(identity)
  .digest('hex')
  .slice(0, 20);
const cache = path.resolve(
  process.env.KUNGFU_DOCS_TOOL_CACHE ||
    path.join(os.homedir(), '.cache', 'kungfu', 'docs-tools'),
  key,
);
const modules = path.join(cache, 'node_modules');
const marker = path.join(cache, 'ready.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message || result.stderr || result.status}`,
    );
  return result.stdout || '';
}

try {
  const before = run('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  let ready = false;
  try {
    ready = JSON.parse(fs.readFileSync(marker, 'utf8')).identity === identity;
  } catch {}
  if (!ready) {
    fs.mkdirSync(cache, { recursive: true });
    const mirror = path.join(cache, 'manifest-mirror');
    fs.mkdirSync(mirror, { recursive: true });
    const manifests = run('git', [
      'ls-files',
      '-z',
      '--',
      'package.json',
      '**/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
    ])
      .split('\0')
      .filter(Boolean);
    for (const rel of manifests) {
      const target = path.join(mirror, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), target);
    }
    run(
      process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
      [
        'pnpm',
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--filter',
        '@kungfu-tech/workspaces',
        '--modules-dir',
        modules,
        '--virtual-store-dir',
        path.join(cache, '.pnpm'),
      ],
      { inherit: true, cwd: mirror },
    );
    fs.writeFileSync(marker, `${JSON.stringify({ identity }, null, 2)}\n`);
  }
  run(process.execPath, [path.join('scripts', 'run-docs-check.mjs')], {
    inherit: true,
    env: { ...process.env, KUNGFU_DOCS_MODULES: modules },
  });
  const after = run('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (after !== before)
    throw new Error('documentation gate changed the source checkout');
  console.log(`[docs:readonly] source unchanged; tools=${cache}`);
} catch (error) {
  console.error(
    `[docs:readonly] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
