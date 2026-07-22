// SPDX-License-Identifier: Apache-2.0
// Audit/prune the packaged Electron app so the assembled kungfu runtime is shipped
// exactly once: Contents/Resources/kungfu. Workspace/package-manager layouts can
// otherwise copy @kungfu-tech/core through nested app dependencies.
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const supportsExecutableMode = process.platform !== 'win32';

function exists(p) {
  return fs.existsSync(p);
}

function listDirs(root) {
  if (!exists(root)) return [];
  const dirs = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    dirs.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return dirs;
}

function isScopedCoreDir(dir) {
  return (
    path.basename(dir) === 'core' &&
    path.basename(path.dirname(dir)) === '@kungfu-tech'
  );
}

function isUnderScopedCore(dir, appNodeModules) {
  const rel = path.relative(appNodeModules, dir).split(path.sep);
  for (let i = 0; i < rel.length - 1; i += 1) {
    if (rel[i] === '@kungfu-tech' && rel[i + 1] === 'core') return true;
  }
  return false;
}

function findDefaultApp() {
  const dist = path.join(__dirname, '..', 'dist');
  if (!exists(dist)) return null;
  const stack = [dist];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app')) return p;
      if (entry.isDirectory()) stack.push(p);
    }
  }
  return null;
}

function findAppFromContext(context) {
  const out = context.appOutDir;
  const expected = path.join(
    out,
    `${context.packager.appInfo.productFilename}.app`,
  );
  if (exists(expected)) return expected;
  const apps = fs
    .readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(out, entry.name));
  if (apps.length === 1) return apps[0];
  throw new Error(`could not resolve packaged .app under ${out}`);
}

function resolveExplicitApp(appArg) {
  if (path.isAbsolute(appArg) || exists(appArg)) return appArg;
  if (process.env.INIT_CWD) {
    const fromInitialCwd = path.resolve(process.env.INIT_CWD, appArg);
    if (exists(fromInitialCwd)) return fromInitialCwd;
  }
  return appArg;
}

function nodePtySpawnHelpers(appDir) {
  const prebuilds = path.join(
    appDir,
    'Contents',
    'Resources',
    'app',
    'node_modules',
    'node-pty',
    'prebuilds',
  );
  if (!exists(prebuilds)) return [];
  return fs
    .readdirSync(prebuilds, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('darwin-'))
    .map((entry) => path.join(prebuilds, entry.name, 'spawn-helper'))
    .filter(exists)
    .sort();
}

function repairNodePtySpawnHelpers(appDir) {
  const helpers = nodePtySpawnHelpers(appDir);
  if (helpers.length === 0) {
    throw new Error('missing packaged node-pty Darwin spawn-helper');
  }
  for (const helper of helpers) {
    if (!supportsExecutableMode) continue;
    const mode = fs.statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(helper, mode | 0o111);
      console.log(`[bundle-core-audit] restored executable mode: ${helper}`);
    }
  }
  return helpers;
}

function auditPackagedMainDependencies(appDir) {
  const appRoot = path.join(appDir, 'Contents', 'Resources', 'app');
  const packageJson = path.join(appRoot, 'package.json');
  if (!exists(packageJson)) {
    throw new Error(`missing packaged app metadata: ${packageJson}`);
  }
  const main = JSON.parse(fs.readFileSync(packageJson, 'utf8')).main;
  if (typeof main !== 'string' || main.length === 0) {
    throw new Error(`packaged app metadata has no main entry: ${packageJson}`);
  }
  const mainPath = path.join(appRoot, main);
  if (!exists(mainPath)) {
    throw new Error(`missing packaged app main entry: ${mainPath}`);
  }

  const code = fs.readFileSync(mainPath, 'utf8');
  const externalRequires = [...code.matchAll(/\brequire\(["']([^"']+)["']\)/g)]
    .map((match) => match[1])
    .filter(
      (specifier) =>
        specifier !== 'electron' &&
        !specifier.startsWith('node:') &&
        !specifier.startsWith('.') &&
        !path.isAbsolute(specifier),
    );
  const packagedRequire = createRequire(mainPath);
  const unresolved = [...new Set(externalRequires)]
    .sort()
    .filter((specifier) => {
      try {
        packagedRequire.resolve(specifier);
        return false;
      } catch {
        return true;
      }
    });
  if (unresolved.length > 0) {
    throw new Error(
      `unresolved packaged main dependencies:\n${unresolved.join('\n')}`,
    );
  }
  console.log(
    `[bundle-core-audit] ok: ${new Set(externalRequires).size} packaged main dependencies resolve`,
  );
}

function auditPackagedApp(appDir, options = {}) {
  const prune = Boolean(options.prune);
  const resources = path.join(appDir, 'Contents', 'Resources');
  const runtimeDir = path.join(resources, 'kungfu');
  const appNodeModules = path.join(resources, 'app', 'node_modules');
  const agentSessionPackage = path.join(
    appNodeModules,
    '@kungfu-tech',
    'agent-session',
  );

  if (!exists(runtimeDir)) {
    throw new Error(`missing bundled runtime directory: ${runtimeDir}`);
  }
  for (const required of [
    'kungfu',
    'kungfu_electron.node',
    'libkungfu.dylib',
    'libkungfu_runtime.dylib',
    'profile-kfd3.json',
  ]) {
    const p = path.join(runtimeDir, required);
    if (!exists(p)) throw new Error(`missing runtime file: ${p}`);
  }

  const dirs = listDirs(appNodeModules);
  const duplicateCoreDirs = dirs.filter(isScopedCoreDir);
  const duplicateRuntimeDirs = dirs.filter(
    (dir) =>
      path.basename(dir) === 'kungfu' &&
      path.basename(path.dirname(dir)) === 'dist' &&
      exists(path.join(dir, 'kungfu_electron.node')),
  );
  const devArtifactDirs = dirs.filter(
    (dir) =>
      isUnderScopedCore(dir, appNodeModules) &&
      (path.basename(dir) === '.venv' || path.basename(dir) === 'build'),
  );

  const toRemove = [
    ...duplicateCoreDirs,
    ...duplicateRuntimeDirs,
    ...devArtifactDirs,
  ];
  if (prune) {
    for (const dir of [...new Set(toRemove)].sort(
      (a, b) => b.length - a.length,
    )) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[bundle-core-audit] pruned ${dir}`);
    }
  }

  const remainingDirs = listDirs(appNodeModules);
  const remainingCore = remainingDirs.filter(isScopedCoreDir);
  const remainingRuntime = remainingDirs.filter(
    (dir) =>
      path.basename(dir) === 'kungfu' &&
      path.basename(path.dirname(dir)) === 'dist' &&
      exists(path.join(dir, 'kungfu_electron.node')),
  );
  const remainingDev = remainingDirs.filter(
    (dir) =>
      isUnderScopedCore(dir, appNodeModules) &&
      (path.basename(dir) === '.venv' || path.basename(dir) === 'build'),
  );

  const allRuntimeDirs = listDirs(resources).filter(
    (dir) =>
      exists(path.join(dir, 'kungfu_electron.node')) &&
      exists(path.join(dir, 'libkungfu.dylib')) &&
      exists(path.join(dir, 'libkungfu_runtime.dylib')),
  );
  const nonCanonicalRuntimeDirs = allRuntimeDirs.filter(
    (dir) => path.resolve(dir) !== path.resolve(runtimeDir),
  );

  const failures = [];
  for (const required of [
    'package.json',
    path.join('src', 'product-client.mjs'),
    path.join('src', 'product-worker.mjs'),
  ]) {
    const requiredPath = path.join(agentSessionPackage, required);
    if (!exists(requiredPath)) {
      failures.push(
        `missing packaged Agent Session runtime file: ${requiredPath}`,
      );
    }
  }
  const spawnHelpers = nodePtySpawnHelpers(appDir);
  if (spawnHelpers.length === 0) {
    failures.push('missing packaged node-pty Darwin spawn-helper');
  } else {
    const nonExecutableHelpers = supportsExecutableMode
      ? spawnHelpers.filter(
          (helper) => (fs.statSync(helper).mode & 0o111) === 0,
        )
      : [];
    if (nonExecutableHelpers.length > 0) {
      failures.push(
        `non-executable node-pty Darwin spawn-helper:\n${nonExecutableHelpers.join('\n')}`,
      );
    }
  }
  if (remainingCore.length > 0) {
    failures.push(
      `duplicate @kungfu-tech/core package trees:\n${remainingCore.join('\n')}`,
    );
  }
  if (remainingRuntime.length > 0) {
    failures.push(
      `duplicate dist/kungfu runtime trees:\n${remainingRuntime.join('\n')}`,
    );
  }
  if (remainingDev.length > 0) {
    failures.push(
      `first-party dev artifact directories:\n${remainingDev.join('\n')}`,
    );
  }
  if (nonCanonicalRuntimeDirs.length > 0) {
    failures.push(
      `runtime payload exists outside Contents/Resources/kungfu:\n${nonCanonicalRuntimeDirs.join('\n')}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n\n'));
  }

  auditPackagedMainDependencies(appDir);
  console.log(`[bundle-core-audit] ok: single kungfu runtime at ${runtimeDir}`);
}

if (require.main === module) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const prune = args.includes('--prune');
  const explicit = args.find((arg) => arg !== '--prune');
  const appDir = explicit ? resolveExplicitApp(explicit) : findDefaultApp();
  if (!appDir) {
    console.error(
      'usage: node scripts/bundle-core-audit.cjs [--prune] <Kungfu Episodes.app>',
    );
    process.exit(2);
  }
  try {
    auditPackagedApp(appDir, { prune });
  } catch (e) {
    console.error(`[bundle-core-audit] failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  auditPackagedApp,
  auditPackagedMainDependencies,
  findAppFromContext,
  repairNodePtySpawnHelpers,
};
