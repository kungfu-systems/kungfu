#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// shifu.mjs — the "rich subset" (L2) of the shifu entrypoint.
//
// Three-tier subset model:
//   L1  shifu (sh)        bootstrap simple commands: load env / check fnm+uv / pin node / run pnpm,
//                               and delegate rich subcommands (proxy/config…) to this file.
//   L2  shifu.mjs (node)  rich commands available once fnm is installed (node implementation, pure builtins, no deps).
//                               currently: bootstrap build/rebuild, cache contract discovery, and local mirror config.
//   L3  (future) TUI            reuse kungfu's own TUI infrastructure / build-artifact runtime; directly import
//                               the readConfig/setKey config helpers below instead of reimplementing them.
//
// The config file lives user-global at ${XDG_CONFIG_HOME:-~/.config}/kungfu/build-local.env: the main repo and all
// git worktrees share one copy, it is naturally outside the repo (open-source safe), and only needs one sync across intranet machines.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cacheDoctor,
  cacheStatus,
  cacheUnset,
  cacheUse,
  printDiagnostic,
} from './scripts/shifu-cache-operations.mjs';
import {
  applyCacheProfile,
  resolveCacheProfile,
  validateProfileBytes,
  writeReceipt,
} from './scripts/shifu-cache-runtime.mjs';
import { runDocumentationCommand } from './scripts/shifu-documentation-cli.mjs';
import { runGateCommand } from './scripts/shifu-gate-cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEYS = [
  // mirrors / cache (per upstream)
  'FNM_NODE_DIST_MIRROR',
  'ELECTRON_MIRROR',
  'COREPACK_NPM_REGISTRY',
  'UV_DEFAULT_INDEX',
  'UV_PYTHON_INSTALL_MIRROR',
  // launcher distribution mirrors (native shifu binary + its fnm/uv bootstrap)
  'SHIFU_DIST_MIRROR',
  'KUNGFU_FNM_DIST_MIRROR',
  'KUNGFU_UV_DIST_MIRROR',
  'KUNGFU_BUILDCHAIN_DIST_MIRROR',
  'KUNGFU_BUILDCHAIN_VERSION',
  'KUNGFU_BUILDCHAIN_SHA256',
  // compile params (cap per machine, to avoid memory thrash on many-core machines)
  'KUNGFU_BUILD_JOBS',
];

const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'kungfu',
  'build-local.env',
);
const TEMPLATE = path.join(__dirname, 'build-local.env.example');
const CACHE_CONTRACT = path.join(
  __dirname,
  'docs',
  'shifu',
  'cache-contract.json',
);
/** @type {Record<string, string>} */
const CACHE_SCHEMAS = {
  profile: path.join(
    __dirname,
    'docs',
    'shifu',
    'schema',
    'cache-profile-v1.schema.json',
  ),
  resolution: path.join(
    __dirname,
    'docs',
    'shifu',
    'schema',
    'cache-resolution-v1.schema.json',
  ),
  diagnostic: path.join(
    __dirname,
    'docs',
    'shifu',
    'schema',
    'cache-diagnostic-v1.schema.json',
  ),
  configPlan: path.join(
    __dirname,
    'docs',
    'shifu',
    'schema',
    'cache-config-plan-v1.schema.json',
  ),
};

// ── Reusable config read/write module (an L3 TUI can require this file directly) ──────────────
function readRaw() {
  try {
    return fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Parse the config file into a key/value map.
 * @returns {Record<string, string>}
 */
function readConfig() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readRaw().split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"'))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Single-quote a value for safe embedding in the shell env file.
 * @param {string} v
 * @returns {string}
 */
function shQuote(v) {
  return `'${String(v).replace(/'/g, "'\\''")}'`;
}

function ensureDir() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
}

/**
 * Upsert one KEY=value entry in the config file.
 * @param {string} key
 * @param {string} val
 */
function setKey(key, val) {
  ensureDir();
  let text = readRaw();
  if (text && !text.endsWith('\n')) text += '\n';
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}=.*$`, 'm');
  const line = `export ${key}=${shQuote(val)}`;
  text = re.test(text) ? text.replace(re, line) : `${text + line}\n`;
  fs.writeFileSync(CONFIG_FILE, text);
}

/**
 * Remove one KEY=value entry from the config file.
 * @param {string} key
 */
function unsetKey(key) {
  const text = readRaw();
  if (!text) return;
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}=.*\\n?`, 'm');
  fs.writeFileSync(CONFIG_FILE, text.replace(re, ''));
}

export { CONFIG_FILE, KEYS, readConfig, setKey, unsetKey };

// ── CLI (entrypoint delegated from L1 sh) ────────────────────────────────────
/** @param {string} cmd */
function help(cmd) {
  console.error(
    `shifu ${cmd} — manage local build environment config: mirrors/cache + compile params (user-global build-local.env)
  ${cmd} path               print the config file path
  ${cmd} init               derive the config file from build-local.env.example (if absent)
  ${cmd} edit               open the config file with $EDITOR (create from template first if absent)
  ${cmd} list               show the current value of each entry
  ${cmd} get <KEY>          read one entry
  ${cmd} set <KEY> <VALUE>  set one entry (written to the user-global file)
  ${cmd} unset <KEY>        remove one entry
Known KEYs: ${KEYS.join(' ')}
The config lives outside the repo (user-global), shared by the main repo and all worktrees, synced once across intranet machines.`,
  );
}

/**
 * Run the repo-local bootstrap build script.
 * @param {'build' | 'rebuild'} cmd
 * @param {string[]} rest
 */
function runBuildCommand(cmd, rest) {
  const buildScript = path.join(__dirname, 'scripts', 'build.mjs');
  const args = cmd === 'rebuild' ? ['--rebuild', ...rest] : rest;
  const r = spawnSync(process.execPath, [buildScript, ...args], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

function cacheHelp() {
  console.error(`shifu cache — inspect the versioned cache contract owned by this checkout
  cache contract            print the canonical contract manifest
  cache schema profile      print the cache-profile JSON Schema
  cache schema resolution   print the resolution-evidence JSON Schema
  cache schema diagnostic   print the status/doctor JSON Schema
  cache schema configPlan   print the use/unset plan JSON Schema
  cache validate profile [FILE|-] [--digest SHA256]
                            validate one profile through the Shifu runtime
  cache resolve [OPTIONS]   resolve a trusted profile and print a redacted receipt
  cache apply [OPTIONS] -- COMMAND [ARGS...]
                            apply environment bindings to one child execution
  cache status [--json] [--receipt FILE]
                            inspect local projection and receipt without network I/O
  cache doctor [--json] [--probe] [--receipt FILE] [--timeout-ms N]
                            resolve the profile; --probe adds policy-aware bounded HEAD checks
  cache use --profile REF --digest SHA256 [--scope SCOPE] [--execute]
                            plan or write only Shifu's managed local config block
  cache unset [--execute]   plan or remove only Shifu's managed local config block

Runtime options:
  --profile REF             local path, file URL, or secret-free http(s) URL
  --digest SHA256           required exact sha256:<64 lowercase hex> digest
  --scope SCOPE             defaults to development, CI, or self-hosted-runner
  --receipt FILE            write the redacted resolution receipt atomically

SHIFU_CACHE_PROFILE_REF and SHIFU_CACHE_PROFILE_DIGEST provide the default
reference/digest. When both are absent, cache apply runs the command unchanged;
supplying only one fails closed.

Contract and schema discovery return the exact checked-in JSON. Private
inventories generate profile instances; they do not change or get embedded in
this contract. status/doctor distinguish configured, resolved, reachable,
effective, and cache-hit evidence; a resolution receipt never proves a hit.`);
}

function defaultReceiptPath() {
  if (process.env.SHIFU_CACHE_RECEIPT) return process.env.SHIFU_CACHE_RECEIPT;
  if (fs.existsSync(path.join(__dirname, '.buildchain'))) {
    return path.join(
      __dirname,
      '.buildchain',
      'diagnostics',
      'shifu-cache-resolution.json',
    );
  }
  return '';
}

/**
 * @typedef {object} CacheRuntimeOptions
 * @property {string} reference
 * @property {string} expectedDigest
 * @property {string} scope
 * @property {string} receiptPath
 * @property {string} command
 * @property {string[]} args
 */

/** @param {string[]} argv @returns {CacheRuntimeOptions} */
function parseCacheRuntimeOptions(argv) {
  /** @type {CacheRuntimeOptions} */
  const options = {
    reference: process.env.SHIFU_CACHE_PROFILE_REF || '',
    expectedDigest: process.env.SHIFU_CACHE_PROFILE_DIGEST || '',
    scope: process.env.SHIFU_CACHE_SCOPE || '',
    receiptPath: defaultReceiptPath(),
    command: '',
    args: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.command = argv[i + 1] || '';
      options.args = argv.slice(i + 2);
      return options;
    }
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--profile' || arg === '--profile-ref')
      options.reference = value();
    else if (arg === '--digest') options.expectedDigest = value();
    else if (arg === '--scope') options.scope = value();
    else if (arg === '--receipt') options.receiptPath = value();
    else throw new Error(`unknown cache runtime option: ${arg}`);
  }
  return options;
}

/**
 * @param {string[]} argv
 * @param {{allowProbe?: boolean}} [settings]
 */
function parseCacheDiagnosticOptions(argv, { allowProbe = false } = {}) {
  const options = {
    json: false,
    probe: false,
    receiptPath: defaultReceiptPath(),
    timeoutMs: 3000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--json') options.json = true;
    else if (arg === '--receipt') options.receiptPath = value();
    else if (arg === '--probe' && allowProbe) options.probe = true;
    else if (arg === '--timeout-ms' && allowProbe) {
      options.timeoutMs = Number(value());
      if (
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 100 ||
        options.timeoutMs > 30_000
      )
        throw new Error('--timeout-ms must be an integer from 100 to 30000');
    } else throw new Error(`unknown cache diagnostic option: ${arg}`);
  }
  return options;
}

/** @param {string[]} argv */
function parseCacheConfigOptions(argv) {
  const options = {
    reference: '',
    digest: '',
    scope: 'development',
    execute: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--profile' || arg === '--profile-ref')
      options.reference = value();
    else if (arg === '--digest') options.digest = value();
    else if (arg === '--scope') options.scope = value();
    else if (arg === '--execute') options.execute = true;
    else throw new Error(`unknown cache configuration option: ${arg}`);
  }
  if (!options.reference || !options.digest)
    throw new Error('cache use requires --profile REF and --digest SHA256');
  return options;
}

/** @param {string[]} argv */
async function runCacheCommand(argv) {
  const sub = argv[0] || 'help';
  if (sub === 'contract' && argv.length === 1) {
    process.stdout.write(fs.readFileSync(CACHE_CONTRACT));
    return;
  }
  if (sub === 'schema' && argv.length === 2 && CACHE_SCHEMAS[argv[1]]) {
    process.stdout.write(fs.readFileSync(CACHE_SCHEMAS[argv[1]]));
    return;
  }
  if (sub === 'validate' && argv[1] === 'profile') {
    let profilePath = '-';
    let expectedDigest = '';
    for (let i = 2; i < argv.length; i += 1) {
      if (argv[i] === '--digest') {
        expectedDigest = argv[i + 1] || '';
        i += 1;
      } else if (profilePath === '-') {
        profilePath = argv[i];
      } else {
        throw new Error(`unknown cache validate argument: ${argv[i]}`);
      }
    }
    const raw =
      profilePath === '-'
        ? fs.readFileSync(0)
        : fs.readFileSync(path.resolve(profilePath));
    const result = validateProfileBytes(raw, { expectedDigest });
    process.stdout.write(
      `${JSON.stringify({ schema: result.profile.schema, profileId: result.profile.profileId, digest: result.digest, valid: true }, null, 2)}\n`,
    );
    return;
  }
  if (sub === 'resolve') {
    const options = parseCacheRuntimeOptions(argv.slice(1));
    const resolved = await resolveCacheProfile(options);
    writeReceipt(resolved.receipt, options.receiptPath);
    process.stdout.write(`${JSON.stringify(resolved.receipt, null, 2)}\n`);
    return;
  }
  if (sub === 'apply') {
    const options = parseCacheRuntimeOptions(argv.slice(1));
    const status = await applyCacheProfile(options);
    process.exitCode = status;
    return;
  }
  if (sub === 'status') {
    const options = parseCacheDiagnosticOptions(argv.slice(1));
    printDiagnostic(
      cacheStatus({
        configFile: CONFIG_FILE,
        receiptPath: options.receiptPath,
      }),
      options.json,
    );
    return;
  }
  if (sub === 'doctor') {
    const options = parseCacheDiagnosticOptions(argv.slice(1), {
      allowProbe: true,
    });
    printDiagnostic(
      await cacheDoctor({
        configFile: CONFIG_FILE,
        receiptPath: options.receiptPath,
        probe: options.probe,
        timeoutMs: options.timeoutMs,
      }),
      options.json,
    );
    return;
  }
  if (sub === 'use') {
    const options = parseCacheConfigOptions(argv.slice(1));
    process.stdout.write(
      `${JSON.stringify(await cacheUse({ configFile: CONFIG_FILE, ...options }), null, 2)}\n`,
    );
    return;
  }
  if (sub === 'unset') {
    const args = argv.slice(1);
    if (
      args.some((arg) => arg !== '--execute') ||
      args.filter((arg) => arg === '--execute').length > 1
    )
      throw new Error('cache unset accepts only one optional --execute');
    const execute = args.includes('--execute');
    process.stdout.write(
      `${JSON.stringify(cacheUnset({ configFile: CONFIG_FILE, execute }), null, 2)}\n`,
    );
    return;
  }
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    cacheHelp();
    return;
  }
  cacheHelp();
  process.exitCode = 2;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'build' || cmd === 'rebuild') {
    runBuildCommand(cmd, argv.slice(1));
    return;
  }
  if (cmd === 'cache') {
    await runCacheCommand(argv.slice(1));
    return;
  }
  if (cmd === 'docs') {
    process.exitCode = await runDocumentationCommand(argv.slice(1), {
      root: __dirname,
    });
    return;
  }
  if (cmd === 'gate') {
    process.exitCode = await runGateCommand(argv.slice(1), { root: __dirname });
    return;
  }
  if (cmd !== 'proxy' && cmd !== 'config') {
    console.error(
      `shifu.mjs: unknown command ${cmd || '(empty)'} (supported: build/rebuild/cache/docs/gate/proxy/config)`,
    );
    process.exit(2);
  }
  const sub = argv[1] || 'help';
  switch (sub) {
    case 'path':
      console.log(CONFIG_FILE);
      break;
    case 'init':
      if (fs.existsSync(CONFIG_FILE)) {
        console.error(`Already exists, not overwritten: ${CONFIG_FILE}`);
      } else {
        ensureDir();
        fs.copyFileSync(TEMPLATE, CONFIG_FILE);
        console.error(
          `Created from template: ${CONFIG_FILE} (edit it or use set to fill values)`,
        );
      }
      break;
    case 'edit': {
      ensureDir();
      if (!fs.existsSync(CONFIG_FILE)) fs.copyFileSync(TEMPLATE, CONFIG_FILE);
      const r = spawnSync(process.env.EDITOR || 'vi', [CONFIG_FILE], {
        stdio: 'inherit',
      });
      process.exit(r.status || 0);
      break;
    }
    case 'list': {
      const cfg = readConfig();
      console.log(`# ${CONFIG_FILE}`);
      for (const k of KEYS) console.log(`${k}=${cfg[k] || ''}`);
      break;
    }
    case 'get': {
      const k = argv[2];
      if (!k) {
        console.error('Usage: proxy get <KEY>');
        process.exit(2);
      }
      console.log(readConfig()[k] || '');
      break;
    }
    case 'set': {
      const k = argv[2];
      const v = argv[3];
      if (!k || v === undefined) {
        console.error('Usage: proxy set <KEY> <VALUE>');
        process.exit(2);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        console.error(`Invalid KEY: ${k}`);
        process.exit(2);
      }
      setKey(k, v);
      console.error(`Set ${k} in ${CONFIG_FILE}`);
      break;
    }
    case 'unset': {
      const k = argv[2];
      if (!k) {
        console.error('Usage: proxy unset <KEY>');
        process.exit(2);
      }
      unsetKey(k);
      console.error(`Removed ${k}`);
      break;
    }
    case 'help':
    case '-h':
    case '--help':
      help(cmd);
      break;
    default:
      console.error(`Unknown subcommand: ${sub} (see ${cmd} help)`);
      process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`shifu: ${error.message}`);
    process.exitCode = 1;
  });
}
