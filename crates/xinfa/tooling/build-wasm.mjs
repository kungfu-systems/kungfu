#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bytesHash,
  reproducibleRustEnvironment,
  sourceTreeHash,
} from './engine-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLCHAIN = '1.95.0';
const TARGET = 'wasm32-unknown-unknown';
const ENGINE = path.join(ROOT, 'engine');
const TARGET_DIR = path.join(ROOT, 'target');
const BUILT = path.join(TARGET_DIR, TARGET, 'release', 'xinfa.wasm');

function rustupWhich(tool) {
  const result = cp.spawnSync(
    'rustup',
    ['which', tool, '--toolchain', TOOLCHAIN],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(
      `missing Rust ${TOOLCHAIN} ${tool}: ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

const cargo = rustupWhich('cargo');
const rustc = rustupWhich('rustc');
const version = cp.spawnSync(rustc, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) throw new Error(version.stderr.trim());

const build = cp.spawnSync(
  cargo,
  [
    'build',
    '--locked',
    '--release',
    '--lib',
    '--target',
    TARGET,
    '--manifest-path',
    path.join(ROOT, 'Cargo.toml'),
  ],
  {
    cwd: ROOT,
    env: {
      ...reproducibleRustEnvironment(ROOT, cargo),
      CARGO_TARGET_DIR: TARGET_DIR,
      RUSTC: rustc,
    },
    stdio: 'inherit',
  },
);
if (build.status !== 0) {
  throw new Error(
    `WASM build failed; ensure the target exists with: rustup target add ${TARGET} --toolchain ${TOOLCHAIN}`,
  );
}

const bytes = fs.readFileSync(BUILT);
fs.mkdirSync(ENGINE, { recursive: true });
fs.copyFileSync(BUILT, path.join(ENGINE, 'xinfa.wasm'));
const manifest = {
  schema: 'xinfa.engine-manifest/v1',
  abi: 'xinfa.engine-abi/v1',
  target: TARGET,
  source_tree_hash: sourceTreeHash(ROOT),
  wasm_sha256: bytesHash(bytes),
  rustc_version: version.stdout.trim(),
  size: bytes.length,
};
fs.writeFileSync(
  path.join(ENGINE, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest));
