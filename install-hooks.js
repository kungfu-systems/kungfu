#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// install-hooks.js — install the repo's git hooks into this checkout.
//
// Copies .githooks/pre-commit to $(git --git-common-dir)/hooks/pre-commit (the
// standard location, shared by the main checkout and every worktree). It does
// NOT set core.hooksPath: a managed hooks-path guard may own that path and chain
// into this standard hook, so writing the standard location keeps both working.
//
// Run automatically from the root `prepare` script on install, or manually via
// `pnpm run hooks:install` (which passes --force). It is idempotent and refuses
// to clobber a developer's own pre-commit unless --force is given.
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OURS_MARKER = 'kungfu pre-commit hook';
const REPLACEABLE = [OURS_MARKER, '#yorkie']; // our own hook, or the dead yorkie shim

/**
 * Run git with the given args and return trimmed stdout, or null on failure.
 * @param {string[]} args
 * @returns {string | null}
 */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/** @param {string} msg */
function log(msg) {
  process.stderr.write(`[install-hooks] ${msg}\n`);
}

function main() {
  const force = process.argv.includes('--force');

  // Skip in environments that never commit (CI) unless explicitly forced.
  if (
    !force &&
    (process.env.KUNGFU_SKIP_INSTALL_HOOKS === '1' || process.env.CI === 'true')
  ) {
    log('skipped (CI / KUNGFU_SKIP_INSTALL_HOOKS); pass --force to override');
    return 0;
  }

  const commonDir = git(['rev-parse', '--git-common-dir']);
  if (!commonDir) {
    log('not a git repository; nothing to install');
    return 0; // never fail an install because hooks could not be placed
  }

  const src = path.join(__dirname, '.githooks', 'pre-commit');
  if (!fs.existsSync(src)) {
    log(`source hook missing: ${src}`);
    return 0;
  }

  const hooksDir = path.isAbsolute(commonDir)
    ? path.join(commonDir, 'hooks')
    : path.join(process.cwd(), commonDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const dest = path.join(hooksDir, 'pre-commit');

  if (fs.existsSync(dest) && !force) {
    const existing = fs.readFileSync(dest, 'utf8');
    const replaceable = REPLACEABLE.some((m) => existing.includes(m));
    if (!replaceable) {
      log(`kept existing pre-commit (not ours): ${dest}`);
      log('  review it and run `pnpm run hooks:install` (--force) to replace.');
      return 0;
    }
  }

  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  log(`installed pre-commit -> ${dest}`);

  // Informational: if core.hooksPath is redirected, git only runs this standard
  // hook when the configured path chains into it (e.g. a managed identity guard).
  const hooksPath = git(['config', '--get', 'core.hooksPath']);
  if (hooksPath) {
    log(
      `note: core.hooksPath=${hooksPath} — relies on that guard chaining into the standard hook`,
    );
  }
  return 0;
}

process.exit(main());
