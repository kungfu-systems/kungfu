#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Register a successful desktop build in the user-global product build stash,
// so the freshest dev build stays usable after its worktree is cleaned and
// `shifu promote` can install it from any terminal.
//
// The directory IS the registry (no JSON, std-only consumers can read it):
//
//   ${XDG_CACHE_HOME:-~/.cache}/kungfu/product/<os>-<arch>/<utc-ts>-<sha>[-dirty]/
//     meta.env            KEY='VALUE' lines (same shape as build-local.env)
//     <artifact>          the unpacked .app (mac), nsis installer (win),
//                         or AppImage (linux)
//
// "Newest build" is the lexicographically greatest slot name. Retention is
// KUNGFU_PRODUCT_BUILDS_KEEP (default 2): older slots are removed after a new
// one lands. Invoked by dist.mjs after the desktop product is staged; runnable
// standalone (--dist-dir to point at a build output) for tests.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(PRODUCT_DIR, '..');

function parseArgs(argv) {
  const args = { distDir: path.join(PRODUCT_DIR, 'dist', 'desktop') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist-dir' && argv[i + 1]) {
      i += 1;
      args.distDir = path.resolve(argv[i]);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

// Match the rust side (std::env::consts) so the binary reads what we write.
function platformTag() {
  const osName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[
    process.platform
  ];
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  if (!osName || !arch) {
    throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  }
  return `${osName}-${arch}`;
}

function cacheRoot() {
  const base =
    process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME !== ''
      ? process.env.XDG_CACHE_HOME
      : path.join(os.homedir(), '.cache');
  return path.join(base, 'kungfu', 'product', platformTag());
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

// The artifact to stash, per platform: the unpacked .app needs no installer
// on mac; the nsis installer is self-contained on windows; the AppImage is
// the whole product on linux.
function findArtifact(distDir) {
  if (process.platform === 'darwin') {
    const entries = fs
      .readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'));
    for (const entry of entries) {
      const inner = path.join(distDir, entry.name);
      const app = fs.readdirSync(inner).find((name) => name.endsWith('.app'));
      if (app) {
        return { kind: 'app', source: path.join(inner, app), name: app };
      }
    }
    throw new Error(`no unpacked .app under ${distDir}`);
  }
  if (process.platform === 'win32') {
    const exe = fs
      .readdirSync(distDir)
      .find((name) => name.toLowerCase().endsWith('.exe'));
    if (!exe) throw new Error(`no nsis installer under ${distDir}`);
    return { kind: 'installer', source: path.join(distDir, exe), name: exe };
  }
  const image = fs
    .readdirSync(distDir)
    .find((name) => name.endsWith('.AppImage'));
  if (!image) throw new Error(`no AppImage under ${distDir}`);
  return { kind: 'appimage', source: path.join(distDir, image), name: image };
}

function copyArtifact(source, target) {
  if (process.platform === 'darwin') {
    // ditto preserves the .app faithfully (symlinks, permissions, xattrs).
    const result = spawnSync('ditto', [source, target], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`ditto failed copying ${source}`);
    }
    return;
  }
  fs.cpSync(source, target, { recursive: true });
}

function quote(value) {
  return `'${String(value).replace(/'/g, '')}'`;
}

function keepCount() {
  const raw = Number.parseInt(process.env.KUNGFU_PRODUCT_BUILDS_KEEP ?? '', 10);
  return Number.isInteger(raw) && raw >= 1 ? raw : 2;
}

function main() {
  const { distDir } = parseArgs(process.argv.slice(2));
  const artifact = findArtifact(distDir);

  const sha = git(['rev-parse', '--short=9', 'HEAD']) || 'unknown';
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
  const fingerprint = dirty ? `${sha}-dirty` : sha;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  const builtAt = new Date().toISOString();
  const stamp = builtAt.replace(/[-:]/g, '').replace(/\..*$/, 'Z');

  const root = cacheRoot();
  const slot = path.join(root, `${stamp}-${fingerprint}`);
  const staging = `${slot}.tmp-${process.pid}`;
  fs.mkdirSync(staging, { recursive: true });
  copyArtifact(artifact.source, path.join(staging, artifact.name));
  fs.writeFileSync(
    path.join(staging, 'meta.env'),
    [
      `KUNGFU_BUILD_SHA=${quote(fingerprint)}`,
      `KUNGFU_BUILD_BRANCH=${quote(branch)}`,
      `KUNGFU_BUILD_WORKTREE=${quote(ROOT)}`,
      `KUNGFU_BUILD_TIME=${quote(builtAt)}`,
      `KUNGFU_BUILD_KIND=${quote(artifact.kind)}`,
      `KUNGFU_BUILD_ARTIFACT=${quote(artifact.name)}`,
      '',
    ].join('\n'),
  );
  fs.rmSync(slot, { recursive: true, force: true });
  fs.renameSync(staging, slot);
  console.log(`[product] registered dev build -> ${slot}`);

  // Retention: keep the newest KUNGFU_PRODUCT_BUILDS_KEEP slots.
  const keep = keepCount();
  const slots = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.includes('.tmp-') &&
        fs.existsSync(path.join(root, entry.name, 'meta.env')),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of slots.slice(keep)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    console.log(`[product] retired dev build ${name} (keep ${keep})`);
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[register-build] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
