// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(
  root,
  'framework',
  'core',
  '.cmake',
  'libwasm-cargo-cache.cmake',
);

function cmakePath(value) {
  return value.replaceAll('\\', '/').replaceAll('"', '\\"');
}

function resolveCache({
  source,
  lock,
  name = 'wasmtime',
  toolchain = 'rust-1',
}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-libwasm-cache-'));
  const cacheRoot = path.join(work, 'cache');
  const script = path.join(work, 'resolve.cmake');
  fs.writeFileSync(
    script,
    `include("${cmakePath(modulePath)}")
kungfu_resolve_libwasm_cargo_target(OUT_DIR OUT_KEY
  NAME "${name}"
  MANIFEST_DIR "${cmakePath(source)}"
  LOCKFILE "${cmakePath(lock)}"
  SOURCE_ROOT "${cmakePath(source)}"
  PROFILE release
  CACHE_ROOT "${cmakePath(cacheRoot)}"
  TOOLCHAIN_FINGERPRINT "${toolchain}"
  TARGET "test-target")
message("RESULT|\${OUT_KEY}|\${OUT_DIR}")
`,
  );
  const result = spawnSync('cmake', ['-P', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const match = `${result.stdout}${result.stderr}`.match(
    /RESULT\|([^|]+)\|(.+)/,
  );
  assert.ok(match, `${result.stdout}\n${result.stderr}`);
  return { key: match[1], dir: match[2].trim(), cacheRoot };
}

test('libwasm Cargo cache key is stable and isolates invalidation axes', () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-libwasm-fixture-'),
  );
  const sourceA = path.join(fixture, 'source-a');
  const sourceB = path.join(fixture, 'source-b');
  fs.mkdirSync(sourceA);
  fs.mkdirSync(sourceB);
  const lockA = path.join(sourceA, 'Cargo.lock');
  const lockB = path.join(sourceB, 'Cargo.lock');
  fs.writeFileSync(lockA, 'version = 4\n');
  fs.writeFileSync(lockB, 'version = 4\n');

  const first = resolveCache({ source: sourceA, lock: lockA });
  const repeat = resolveCache({ source: sourceA, lock: lockA });
  assert.equal(first.key, repeat.key);
  assert.match(first.dir, /[/\\]wasmtime[/\\]release[/\\]v1-/);
  assert.ok(first.dir.startsWith(first.cacheRoot));

  fs.writeFileSync(lockA, 'version = 4\n# changed\n');
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceA, lock: lockA }).key,
  );
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceB, lock: lockB }).key,
  );
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceA, lock: lockB, name: 'wasmer' }).key,
  );
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceA, lock: lockB, toolchain: 'rust-2' }).key,
  );
});
