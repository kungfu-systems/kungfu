// SPDX-License-Identifier: Apache-2.0
// @ts-check

import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} root */
function filesUnder(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory */
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) =>
        Buffer.from(left.name).compare(Buffer.from(right.name)),
      )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile())
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      else
        throw new Error(
          `Xinfa source tree contains a non-file entry: ${absolute}`,
        );
    }
  }
  visit(root);
  return files;
}

/** @param {string} xinfaRoot */
export function sourceTreeHash(xinfaRoot) {
  const sourceRoot = path.join(xinfaRoot, 'src');
  const hash = crypto.createHash('sha256');
  for (const relative of filesUnder(sourceRoot)) {
    const bytes = fs.readFileSync(path.join(sourceRoot, relative));
    const pathBytes = Buffer.from(relative, 'utf8');
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(pathBytes.length), 0);
    lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
    hash.update(lengths);
    hash.update(pathBytes);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** @param {Buffer | Uint8Array} bytes */
export function bytesHash(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Keep Rust source locations stable and public in the checked-in engine.
 * Cargo registry host directories are machine-specific even when Cargo.lock is
 * identical, so every registry source root maps to the same logical prefix.
 *
 * @param {string} xinfaRoot
 * @param {string} cargo
 * @param {NodeJS.ProcessEnv} [environment]
 */
export function reproducibleRustEnvironment(
  xinfaRoot,
  cargo,
  environment = process.env,
) {
  const metadata = cp.spawnSync(
    cargo,
    [
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--manifest-path',
      path.join(xinfaRoot, 'Cargo.toml'),
    ],
    { cwd: xinfaRoot, encoding: 'utf8', env: environment },
  );
  if (metadata.status !== 0)
    throw new Error(`cannot inspect Cargo registry roots: ${metadata.stderr}`);

  const registryMarker = `${path.sep}registry${path.sep}src${path.sep}`;
  const registryRoots = new Set();
  for (const item of JSON.parse(metadata.stdout).packages || []) {
    const manifest = path.resolve(item.manifest_path);
    const marker = manifest.indexOf(registryMarker);
    if (marker === -1) continue;
    const sourceStart = marker + registryMarker.length;
    const sourceEnd = manifest.indexOf(path.sep, sourceStart);
    if (sourceEnd !== -1) registryRoots.add(manifest.slice(0, sourceEnd));
  }

  const remaps = [
    `--remap-path-prefix=${path.resolve(xinfaRoot)}=/workspace/xinfa`,
    ...[...registryRoots]
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      .map(
        (registryRoot) =>
          `--remap-path-prefix=${registryRoot}=/cargo/registry/src/registry`,
      ),
  ];
  return {
    ...environment,
    RUSTFLAGS: '',
    CARGO_ENCODED_RUSTFLAGS: remaps.join('\x1f'),
  };
}
