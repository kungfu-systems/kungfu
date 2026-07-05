#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Shared no-bash guard. The repo is fully migrated off .sh so every gate runs
// under node on every platform (Windows included); a reintroduced *.sh silently
// breaks off-Unix. One scan, two consumers:
//   - scripts/verify.mjs stage 0a → `node no-bash-guard.mjs`     (whole tree)
//   - .githooks/pre-commit        → imported scanStaged (staged adds)
//
// Vendored/generated dirs may carry upstream .sh out of our control and are
// skipped. The `.githooks/pre-commit` shim itself has no .sh extension, so it is
// not a false positive.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'build',
  'dist',
  'out',
]);

/** Repo-root path via git, or cwd if that fails. */
export function repoRoot(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

/** Every tracked-or-untracked *.sh under root, minus vendored/generated dirs. */
export function scanTree(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.name.endsWith('.sh')) {
        hits.push(path.relative(root, path.join(dir, e.name)));
      }
    }
  };
  walk(root);
  return hits.sort();
}

/** Staged (Added/Copied/Modified) *.sh files — the pre-commit scope. */
export function scanStaged(root) {
  const r = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
    { cwd: root, encoding: 'utf8' },
  );
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.sh'))
    .sort();
}

export function reportHits(
  hits,
  write = (s) => process.stderr.write(`${s}\n`),
) {
  write('bash scripts must be Node (.mjs) so gates run on Windows too:');
  for (const h of hits) write(`  ${h}`);
}

// CLI: `node no-bash-guard.mjs [--staged]` — exit 1 (+ list) on any hit.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = repoRoot();
  const hits = process.argv.includes('--staged')
    ? scanStaged(root)
    : scanTree(root);
  if (hits.length === 0) process.exit(0);
  reportHits(hits);
  process.exit(1);
}
