#!/usr/bin/env node

const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const executable = require('./executable');
const shell = require('./shell');

/**
 * Resolve the installed TUI package's public bundle without weakening the
 * packaged Product contract. Installed launchers keep supplying their exact
 * KUNGFU_TUI_ENTRY; this fallback exists only when the dependency's bundle
 * is actually present.
 * @param {string} [coreLibDir]
 * @param {(candidate: string) => boolean} [exists]
 * @returns {string | undefined}
 */
function resolveSourceTuiEntry(coreLibDir = __dirname, exists = fs.existsSync) {
  try {
    const resolveFromCore = createRequire(
      path.resolve(coreLibDir, 'kungfu-cli.js'),
    );
    return [resolveFromCore.resolve('@kungfu-tech/tui/bundle')].find(exists);
  } catch {
    // A missing or unavailable optional source bundle leaves the installed
    // Product's explicit KUNGFU_TUI_ENTRY in control.
    return undefined;
  }
}

/**
 * Resolve the assembled Product extensions from this source checkout. The
 * frozen Python runtime cannot infer the repository root from its own module
 * path, so source launches must provide the same extension boundary that the
 * packaged Product launcher supplies.
 * @param {string} [coreLibDir]
 * @param {(candidate: string) => boolean} [exists]
 * @returns {string | undefined}
 */
function resolveSourceExtensionRoot(
  coreLibDir = __dirname,
  exists = fs.existsSync,
) {
  const repositoryRoot = path.resolve(coreLibDir, '..', '..', '..');
  const candidates = [
    path.join(repositoryRoot, 'product', 'extensions'),
    path.join(repositoryRoot, 'extensions'),
  ];

  return candidates.find((candidate) =>
    exists(
      path.join(
        candidate,
        'agent-work-lab',
        'experience',
        'starter-project.json',
      ),
    ),
  );
}

function nonEmptyEnvironmentValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [coreLibDir]
 * @param {(candidate: string) => boolean} [exists]
 * @returns {NodeJS.ProcessEnv}
 */
function sourceCliEnvironment(
  env = process.env,
  coreLibDir = __dirname,
  exists = fs.existsSync,
) {
  const tuiEntry = resolveSourceTuiEntry(coreLibDir, exists);
  const extensionRoot = resolveSourceExtensionRoot(coreLibDir, exists);
  const explicitTuiEntry = nonEmptyEnvironmentValue(env.KUNGFU_TUI_ENTRY);
  const explicitExtensionRoot = nonEmptyEnvironmentValue(
    env.KF_BUNDLED_EXTENSION_ROOT,
  );
  return {
    // kept for the runtime's cli command; the webpack-era CLI package this
    // used to resolve is retired, so the value is the same fallback the old
    // lookup always produced
    KF_CLI_DEV_PATH: path.resolve('.', 'lib', 'dev', 'cli.dev.js'),
    KF_LOG_LEVEL: 'trace',
    ...env,
    ...(explicitTuiEntry
      ? { KUNGFU_TUI_ENTRY: explicitTuiEntry }
      : tuiEntry
        ? { KUNGFU_TUI_ENTRY: tuiEntry }
        : {}),
    ...(explicitExtensionRoot
      ? { KF_BUNDLED_EXTENSION_ROOT: explicitExtensionRoot }
      : extensionRoot
        ? { KF_BUNDLED_EXTENSION_ROOT: extensionRoot }
        : {}),
  };
}

if (require.main === module) {
  shell.run(executable.kfc, process.argv.slice(2), true, {
    silent: true,
    env: sourceCliEnvironment(),
  });
}

module.exports = {
  resolveSourceExtensionRoot,
  resolveSourceTuiEntry,
  sourceCliEnvironment,
};
