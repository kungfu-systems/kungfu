// SPDX-License-Identifier: Apache-2.0
// Repo-local bootstrap build for a fresh Kungfu worktree.
//
// Goal:
//   ./shifu build
//   ./shifu product gui dev
//
// `build` prepares the runtime, GUI/TUI surfaces, SDK and every product-bundled KFX
// view. `rebuild` first removes generated build outputs, then runs the same
// build. Packaging remains `./shifu dist`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const EXTENSIONS_ROOT = path.join(ROOT, 'extensions');
const CORE_DIST = path.join(ROOT, 'framework', 'core', 'dist', 'kungfu');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const dryRun = args.includes('--dry-run');

function rel(p) {
  return path.relative(ROOT, p) || '.';
}

function exitLabel(result) {
  return result.status == null
    ? `signal ${result.signal}`
    : String(result.status);
}

function log(message = '') {
  console.log(message);
}

function run(label, cmd, commandArgs, options = {}) {
  log(`\n[build] ${label}`);
  log(`[build] $ ${[cmd, ...commandArgs].join(' ')}`);
  if (dryRun) return;
  const result = spawnSync(cmd, commandArgs, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${exitLabel(result)})`);
  }
}

function pnpm(label, commandArgs, options = {}) {
  run(label, 'pnpm', commandArgs, options);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertInsideRoot(target) {
  const resolved = path.resolve(target);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`refusing to touch path outside repo: ${resolved}`);
  }
}

function removeGenerated(target) {
  assertInsideRoot(target);
  if (dryRun) {
    log(`[build] rm -rf ${rel(target)}`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function listKfxPackages() {
  const packages = [];
  const visit = (dir, depth) => {
    if (depth > 2 || !fs.existsSync(dir)) return;
    const pkgPath = path.join(dir, 'package.json');
    const manifestPath = path.join(dir, 'kungfu.kfx.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg.kungfuProduct?.assembly === 'reference-only') return;
    }
    if (fs.existsSync(pkgPath) && fs.existsSync(manifestPath)) {
      const pkg = readJson(pkgPath);
      const manifest = readJson(manifestPath);
      if (manifest?.name && manifest?.kungfuConfig) {
        packages.push({
          name: manifest.name,
          dir,
          config: manifest.kungfuConfig,
          scripts: pkg.scripts || {},
        });
      }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(EXTENSIONS_ROOT, 0);
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function productKfxDependencies() {
  const pkg = readJson(path.join(ROOT, 'product', 'package.json'));
  return new Set(
    Object.keys(pkg.dependencies || {}).filter((name) =>
      name.startsWith('@kungfu-tech/kfx-'),
    ),
  );
}

function assertDeclaredKfx(packages) {
  const declared = productKfxDependencies();
  const actual = new Set(packages.map((pkg) => pkg.name));
  const missing = [...actual].filter((name) => !declared.has(name)).sort();
  const stale = [...declared].filter((name) => !actual.has(name)).sort();
  if (missing.length || stale.length) {
    throw new Error(
      [
        'product/package.json must declare every product-assembled KFX dependency',
        missing.length ? `missing: ${missing.join(', ')}` : '',
        stale.length ? `stale: ${stale.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  log(`[build] product-bundled KFX packages: ${packages.length}`);
}

function cleanOutputs(packages) {
  log('\n[build] clean generated build outputs');
  for (const target of [
    path.join(ROOT, 'framework', 'core', 'build'),
    path.join(ROOT, 'framework', 'core', 'dist'),
    path.join(ROOT, 'framework', 'gui', 'out'),
    path.join(ROOT, 'framework', 'gui', 'dist'),
    path.join(ROOT, 'framework', 'gui', 'node_modules', '.vite'),
    path.join(ROOT, 'framework', 'tui', 'dist'),
    path.join(ROOT, 'product', 'dist'),
    path.join(ROOT, 'product', 'extensions'),
  ]) {
    removeGenerated(target);
  }
  for (const pkg of packages) {
    removeGenerated(path.join(pkg.dir, 'dist'));
    removeGenerated(path.join(pkg.dir, 'build'));
  }
}

function assertCoreRuntime() {
  const kungfuBin = path.join(CORE_DIST, isWin ? 'kungfu.exe' : 'kungfu');
  const electronBinding = path.join(CORE_DIST, 'kungfu_electron.node');
  const nodeBinding = path.join(CORE_DIST, 'kungfu_node.node');
  const kfxContract = path.join(
    CORE_DIST,
    'config',
    'kungfu-kfx.contract.json',
  );
  // Windows deliberately builds the Electron runtime under kungfu_node.node:
  // the Node-runtime pass skips the addon there, so there is only one ABI
  // artifact to assert. POSIX builds retain distinct Node/Electron bindings.
  const bindings = isWin ? [nodeBinding] : [electronBinding, nodeBinding];
  for (const file of [kungfuBin, ...bindings, kfxContract]) {
    if (!fs.existsSync(file)) {
      throw new Error(`build did not produce ${rel(file)}`);
    }
  }
}

function buildKfx(packages) {
  const env = {
    ...process.env,
    PATH: `${CORE_DIST}${path.delimiter}${process.env.PATH || ''}`,
  };
  for (const pkg of packages) {
    if (!pkg.scripts.build) {
      log(`[build] skip ${pkg.name}: no build script`);
      continue;
    }
    pnpm(`build kfx ${pkg.name}`, ['--filter', pkg.name, 'run', 'build'], {
      env,
    });
    const view = pkg.config?.config?.view;
    if (!view) continue;
    const entry = view.entry || 'dist/view/index.js';
    const bundlePath = path.join(pkg.dir, entry);
    if (!dryRun && !fs.existsSync(bundlePath)) {
      throw new Error(`${pkg.name} build did not produce ${rel(bundlePath)}`);
    }
  }
}

function main() {
  const kfxPackages = listKfxPackages();
  assertDeclaredKfx(kfxPackages);

  if (rebuild) cleanOutputs(kfxPackages);

  pnpm('sync dependencies', ['install', '--frozen-lockfile']);
  pnpm('build core native runtime', [
    '--filter',
    '@kungfu-tech/core',
    'run',
    'build',
  ]);
  pnpm('freeze core CLI/runtime', [
    '--filter',
    '@kungfu-tech/core',
    'run',
    'freeze',
  ]);
  if (!dryRun) assertCoreRuntime();

  pnpm('build SDK', ['--filter', '@kungfu-tech/sdk', 'run', 'build']);
  pnpm('build kfx contract package', [
    '--filter',
    '@kungfu-tech/kfx',
    'run',
    'build',
  ]);
  buildKfx(kfxPackages);
  pnpm('build TUI', ['--filter', '@kungfu-tech/tui', 'run', 'build']);
  pnpm('build GUI', ['--filter', '@kungfu-tech/gui', 'run', 'build']);

  log('\n[build] complete');
  log('[build] next: ./shifu product gui dev');
}

try {
  main();
} catch (error) {
  console.error(
    `[build] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
