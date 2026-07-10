#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// shifu.mjs — the "rich subset" (L2) of the shifu entrypoint.
//
// Three-tier subset model:
//   L1  shifu (sh)        bootstrap simple commands: load env / check fnm+uv / pin node / run pnpm,
//                               and delegate rich subcommands (proxy/config…) to this file.
//   L2  shifu.mjs (node)  rich commands available once fnm is installed (node implementation, pure builtins, no deps).
//                               currently: bootstrap build/rebuild and local cache/mirror proxy config management.
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
  // compile params (cap per machine, to avoid memory thrash on many-core machines)
  'KUNGFU_BUILD_JOBS',
];

const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'kungfu',
  'build-local.env',
);
const TEMPLATE = path.join(__dirname, 'build-local.env.example');

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

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'build' || cmd === 'rebuild') {
    runBuildCommand(cmd, argv.slice(1));
    return;
  }
  if (cmd !== 'proxy' && cmd !== 'config') {
    console.error(
      `shifu.mjs: unknown command ${cmd || '(empty)'} (supported: build/rebuild/proxy/config)`,
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
