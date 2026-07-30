// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectCommandPath, spawnSpecification } from './libwasm-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(
  root,
  'framework',
  'core',
  '.cmake',
  'libwasm-cargo-cache.cmake',
);
const crateRoot = path.join(root, 'crates', 'libwasm');

function cmakePath(value) {
  return value.replaceAll('\\', '/').replaceAll('"', '\\"');
}

function run(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const {
    capture = false,
    platform = process.platform,
    ...spawnOptions
  } = options;
  const specification = spawnSpecification(
    command,
    args,
    platform,
    spawnOptions.env || process.env,
  );
  const result = spawnSync(specification.command, specification.args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    ...spawnOptions,
    ...(specification.shell ? { shell: specification.shell } : {}),
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}${
      result.error ? `\n${result.error.stack || result.error.message}` : ''
    }`,
  );
  return { ...result, elapsedMs };
}

function commandPath(name) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = run(finder, [name], { capture: true });
  return selectCommandPath(result.stdout);
}

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-libwasm-qualify-'));
try {
  const cargo = commandPath('cargo');
  let cmakeCargo = cargo;
  if (process.platform === 'win32') {
    cmakeCargo = path.join(work, 'cargo.cmd');
    fs.writeFileSync(cmakeCargo, `@echo off\r\n"${cargo}" %*\r\n`);
  }
  const script = path.join(work, 'resolve.cmake');
  const cacheRoot = process.env.KF_LIBWASM_CARGO_TARGET_ROOT || '';
  const lines = [`include("${cmakePath(modulePath)}")`];
  for (const engine of ['wasmtime', 'wasmer']) {
    const manifestDir = path.join(crateRoot, engine);
    lines.push(`kungfu_resolve_libwasm_cargo_target(${engine.toUpperCase()}_DIR ${engine.toUpperCase()}_KEY
  NAME "${engine}"
  MANIFEST_DIR "${cmakePath(manifestDir)}"
  LOCKFILE "${cmakePath(path.join(manifestDir, 'Cargo.lock'))}"
  SOURCE_ROOT "${cmakePath(root)}"
  PROFILE release
  CARGO "${cmakePath(cmakeCargo)}"
  CACHE_ROOT "${cmakePath(cacheRoot)}")`);
    lines.push(
      `message("CACHE|${engine}|\${${engine.toUpperCase()}_KEY}|\${${engine.toUpperCase()}_DIR}")`,
    );
  }
  fs.writeFileSync(script, `${lines.join('\n')}\n`);
  const resolved = run(commandPath('cmake'), ['-P', script], {
    capture: true,
  });
  const cacheLines = `${resolved.stdout}${resolved.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.startsWith('CACHE|'));
  assert.equal(cacheLines.length, 2, `${resolved.stdout}\n${resolved.stderr}`);

  const caches = new Map(
    cacheLines.map((line) => {
      const [, engine, key, directory] = line.split('|');
      return [engine, { key, directory }];
    }),
  );
  assert.notEqual(
    caches.get('wasmtime').directory,
    caches.get('wasmer').directory,
  );

  const suffix =
    process.platform === 'win32'
      ? '.dll'
      : process.platform === 'darwin'
        ? '.dylib'
        : '.so';
  const prefix = process.platform === 'win32' ? '' : 'lib';
  const results = [];
  for (const engine of ['wasmtime', 'wasmer']) {
    const manifest = path.join(crateRoot, engine, 'Cargo.toml');
    const manifestDir = path.dirname(manifest);
    const artifact = path.join(
      caches.get(engine).directory,
      'release',
      `${prefix}kungfu_libwasm_${engine}${suffix}`,
    );
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: caches.get(engine).directory,
    };
    const cargoIdentity = run(cargo, ['-Vv'], {
      capture: true,
      cwd: manifestDir,
    }).stdout.split(/\r?\n/)[0];
    const first = run(
      cargo,
      ['build', '--release', '--locked', '--manifest-path', manifest],
      {
        capture: true,
        cwd: manifestDir,
        env,
      },
    );
    const firstStage = path.join(work, 'build-a', 'cargo-stage');
    fs.mkdirSync(firstStage, { recursive: true });
    fs.copyFileSync(artifact, path.join(firstStage, path.basename(artifact)));

    const second = run(
      cargo,
      ['build', '--release', '--locked', '--manifest-path', manifest],
      {
        capture: true,
        cwd: manifestDir,
        env,
      },
    );
    assert.doesNotMatch(
      `${second.stdout}${second.stderr}`,
      /^\s*Compiling /m,
      `${engine} warm build unexpectedly compiled crates`,
    );
    const secondStage = path.join(work, 'build-b', 'cargo-stage');
    fs.mkdirSync(secondStage, { recursive: true });
    const secondArtifact = path.join(secondStage, path.basename(artifact));
    fs.copyFileSync(artifact, secondArtifact);
    assert.equal(
      sha256(path.join(firstStage, path.basename(artifact))),
      sha256(secondArtifact),
    );
    results.push({
      engine,
      cargo: cargoIdentity,
      cache_key: caches.get(engine).key,
      cache_dir: caches.get(engine).directory,
      first_ms: Math.round(first.elapsedMs),
      warm_ms: Math.round(second.elapsedMs),
      staged_sha256: sha256(secondArtifact),
    });
  }

  console.log(JSON.stringify({ status: 'pass', results }, null, 2));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
