#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Keep the shifu launcher version in lockstep with the monorepo version.
//
// lerna.json is the version single source of truth (see .buildchain/buildchain.toml);
// the launcher ships with the same release train, so crates/shifu/Cargo.toml —
// the pin the shifu shims read and the release workflow verifies tags against —
// must always equal it. lerna does not manage Cargo files, so this script closes
// the gap and is wired in twice:
//
//   - the root package.json "version" lifecycle runs it during `lerna version`,
//     so the bump commit carries the Cargo files;
//   - `shifu check` runs it with --check as a drift gate.
//
// Usage:
//   node scripts/sync-shifu-version.mjs           write Cargo.toml + Cargo.lock
//   node scripts/sync-shifu-version.mjs --check   exit 1 when out of sync
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LERNA = path.join(ROOT, 'lerna.json');
const CARGO_TOML = path.join(ROOT, 'crates', 'shifu', 'Cargo.toml');
const CARGO_LOCK = path.join(ROOT, 'crates', 'Cargo.lock');

const checkOnly = process.argv.includes('--check');

const version = JSON.parse(fs.readFileSync(LERNA, 'utf8')).version;
if (!version || typeof version !== 'string') {
  console.error('[shifu-version] lerna.json has no version');
  process.exit(1);
}

const toml = fs.readFileSync(CARGO_TOML, 'utf8');
const tomlVersion = toml.match(/^version = "(.*)"$/m)?.[1];
if (!tomlVersion) {
  console.error(`[shifu-version] no version field in ${CARGO_TOML}`);
  process.exit(1);
}

if (checkOnly) {
  if (tomlVersion !== version) {
    console.error(
      `[shifu-version] drift: lerna.json ${version} != crates/shifu/Cargo.toml ${tomlVersion}\n[shifu-version] run: node scripts/sync-shifu-version.mjs`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (tomlVersion !== version) {
  fs.writeFileSync(
    CARGO_TOML,
    toml.replace(/^version = ".*"$/m, `version = "${version}"`),
  );
  console.error(
    `[shifu-version] crates/shifu/Cargo.toml ${tomlVersion} -> ${version}`,
  );
}

// Keep Cargo.lock aligned so builds do not dirty the tree re-resolving it.
const lock = fs.readFileSync(CARGO_LOCK, 'utf8');
const nextLock = lock.replace(
  /(name = "shifu"\nversion = ")([^"]*)(")/,
  `$1${version}$3`,
);
if (nextLock !== lock) {
  fs.writeFileSync(CARGO_LOCK, nextLock);
  console.error(`[shifu-version] crates/Cargo.lock -> ${version}`);
}
