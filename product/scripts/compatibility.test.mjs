// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256Tree } from './compatibility.mjs';
import {
  assertLibwasmArtifact,
  libwasmArtifactPaths,
} from './libwasm-artifact.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

test('standard native contract input exists', () => {
  assert.equal(
    fs.existsSync(
      path.join(repoRoot, 'framework/core/src/libkungfu/include/kungfu/api.h'),
    ),
    true,
  );
});

test('Windows ships the narrow standard ABI facade', () => {
  const cmake = fs.readFileSync(
    path.join(repoRoot, 'framework/core/src/libkungfu/CMakeLists.txt'),
    'utf8',
  );
  assert.match(
    cmake,
    /add_library\(kungfu_abi SHARED \$<TARGET_OBJECTS:kungfu_abi_exports>\)/,
  );
  assert.match(cmake, /KF_API_BUILD_SHARED=1/);
  assert.match(cmake, /OUTPUT_NAME kungfu/);
  assert.match(cmake, /WINDOWS_EXPORT_ALL_SYMBOLS OFF/);

  const freeze = fs.readFileSync(
    path.join(repoRoot, 'framework/core/.gyp/run-freeze.js'),
    'utf8',
  );
  assert.match(freeze, /findFileShallow\(buildDir, \/\^kungfu\\\.dll\$\/i\)/);
  assert.match(freeze, /\^kungfu_abi\\\.lib\$\/i/);
  assert.match(freeze, /copyPdbSibling\(storageDll, distKfc\)/);

  const rustBuild = fs.readFileSync(
    path.join(repoRoot, 'crates/kungfu-sdk/build.rs'),
    'utf8',
  );
  assert.match(rustBuild, /cargo:rustc-link-lib=dylib=kungfu_abi/);
});

test('compatibility tree hash is path-stable and content-sensitive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-compatibility-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    const first = sha256Tree(root);
    const second = sha256Tree(root);
    assert.equal(first, second);
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    assert.notEqual(sha256Tree(root), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('libwasm release qualification fails when any promised component is deleted', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-libwasm-artifact-'),
  );
  try {
    for (const relative of libwasmArtifactPaths('darwin')) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        relative.endsWith('contract.json')
          ? JSON.stringify({
              schema: 'kungfu.libwasm.contract/v1',
              world: 'kungfu:journal/batch@1.0.0',
              engines: { primary: 'wasmtime', fallback: 'wasmer' },
            })
          : 'fixture',
      );
    }
    assert.doesNotThrow(() => assertLibwasmArtifact(root, 'darwin'));
    fs.rmSync(path.join(root, 'libwasm', 'libkungfu_libwasm_wasmer.dylib'));
    assert.throws(
      () => assertLibwasmArtifact(root, 'darwin'),
      /production libwasm artifact incomplete/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
