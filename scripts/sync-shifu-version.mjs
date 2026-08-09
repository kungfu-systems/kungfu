#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Keep user-visible native component versions in lockstep with the monorepo.
//
// lerna.json is the version single source of truth (see .buildchain/buildchain.toml);
// Shifu and Xinfa ship with the same product release train, so their Cargo.toml
// versions — which the shims and release workflow bind to — must always equal
// it. Xinfa retains its own protocol/schema versions and release tag namespace;
// this script governs only the user-visible component release number. Lerna
// does not manage Cargo files, so this script closes the gap and is wired twice:
//
//   - the root package.json "version" lifecycle runs it during `lerna version`,
//     so the bump commit carries the Cargo files;
//   - `shifu check` runs it with --check as a drift gate.
//
// Usage:
//   node scripts/sync-shifu-version.mjs           write manifests + lockfiles
//   node scripts/sync-shifu-version.mjs --check   exit 1 when out of sync
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LERNA = path.join(ROOT, 'lerna.json');
const CARGO_LOCK = path.join(ROOT, 'crates', 'Cargo.lock');
const XINFA_CARGO_LOCK = path.join(ROOT, 'crates', 'xinfa', 'Cargo.lock');
const COMPONENTS = ['shifu', 'xinfa'].map((id) => ({
  id,
  manifest: path.join(ROOT, 'crates', id, 'Cargo.toml'),
}));

const checkOnly = process.argv.includes('--check');

const version = JSON.parse(fs.readFileSync(LERNA, 'utf8')).version;
if (!version || typeof version !== 'string') {
  console.error('[component-version] lerna.json has no version');
  process.exit(1);
}

const manifests = COMPONENTS.map((component) => {
  const source = fs.readFileSync(component.manifest, 'utf8');
  const current = source.match(/^version = "(.*)"$/m)?.[1];
  if (!current) {
    console.error(
      `[component-version] no version field in ${component.manifest}`,
    );
    process.exit(1);
  }
  return { ...component, source, current };
});

const lock = fs.readFileSync(CARGO_LOCK, 'utf8');
const lockVersions = new Map(
  COMPONENTS.map(({ id }) => [
    id,
    lock.match(new RegExp(`name = "${id}"\\nversion = "([^"]+)"`))?.[1] || '',
  ]),
);
const xinfaLock = fs.readFileSync(XINFA_CARGO_LOCK, 'utf8');
const xinfaLockVersion =
  xinfaLock.match(/name = "xinfa"\nversion = "([^"]+)"/)?.[1] || '';

if (checkOnly) {
  const drift = [];
  for (const { id, current } of manifests) {
    if (current !== version)
      drift.push(`lerna.json ${version} != crates/${id}/Cargo.toml ${current}`);
    if (lockVersions.get(id) !== version)
      drift.push(
        `lerna.json ${version} != crates/Cargo.lock ${id} ${lockVersions.get(id) || '<missing>'}`,
      );
  }
  if (xinfaLockVersion !== version)
    drift.push(
      `lerna.json ${version} != crates/xinfa/Cargo.lock xinfa ${xinfaLockVersion || '<missing>'}`,
    );
  if (drift.length > 0) {
    console.error(
      `[component-version] drift:\n- ${drift.join('\n- ')}\n[component-version] run: node scripts/sync-shifu-version.mjs`,
    );
    process.exit(1);
  }
  process.exit(0);
}

for (const { id, manifest, source, current } of manifests) {
  if (current === version) continue;
  fs.writeFileSync(
    manifest,
    source.replace(/^version = ".*"$/m, `version = "${version}"`),
  );
  console.error(
    `[component-version] crates/${id}/Cargo.toml ${current} -> ${version}`,
  );
}

// Keep Cargo.lock aligned so builds do not dirty the tree re-resolving it.
let nextLock = lock;
for (const { id } of COMPONENTS)
  nextLock = nextLock.replace(
    new RegExp(`(name = "${id}"\\nversion = ")([^"]*)(")`),
    `$1${version}$3`,
  );
if (nextLock !== lock) {
  fs.writeFileSync(CARGO_LOCK, nextLock);
  console.error(`[component-version] crates/Cargo.lock -> ${version}`);
}

const nextXinfaLock = xinfaLock.replace(
  /(name = "xinfa"\nversion = ")([^"]*)(")/,
  `$1${version}$3`,
);
if (nextXinfaLock !== xinfaLock) {
  fs.writeFileSync(XINFA_CARGO_LOCK, nextXinfaLock);
  console.error(`[component-version] crates/xinfa/Cargo.lock -> ${version}`);
}
