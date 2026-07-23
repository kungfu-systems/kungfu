// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the C++ probe searches the Windows libkungfu archive output directory', () => {
  const cmake = fs.readFileSync(
    path.join(ROOT, 'examples/probe-cpp/cmake/kungfu.cmake'),
    'utf8',
  );

  assert.match(
    cmake,
    /PATHS\s+"\$\{KF_CORE_DIR\}\/build\/Release"\s+"\$\{KF_CORE_DIR\}\/build"/,
  );
});

test('the C++ probe compiles public Core headers as UTF-8 on MSVC', () => {
  const cmake = fs.readFileSync(
    path.join(ROOT, 'examples/probe-cpp/cmake/kungfu.cmake'),
    'utf8',
  );

  assert.match(cmake, /CXX_COMPILER_ID:MSVC>:\/utf-8/);
});

test('the C++ probe links the separate Windows yijinjing archive', () => {
  const cmake = fs.readFileSync(
    path.join(ROOT, 'examples/probe-cpp/cmake/kungfu.cmake'),
    'utf8',
  );

  assert.match(cmake, /find_library\(KF_LIBYIJINJING/);
  assert.match(
    cmake,
    /if\(WIN32\)\s+target_link_libraries\(\$\{_target\} PRIVATE \$\{KF_LIBYIJINJING\}/,
  );
});

test('the C++ probe links the Windows yijinjing xxHash dependency', () => {
  const cmake = fs.readFileSync(
    path.join(ROOT, 'examples/probe-cpp/cmake/kungfu.cmake'),
    'utf8',
  );

  assert.match(cmake, /if\(WIN32\)\s+find_package\(xxHash REQUIRED\)/);
  assert.match(
    cmake,
    /target_link_libraries\(\$\{_target\} PRIVATE \$\{KF_LIBYIJINJING\} xxHash::xxhash\)/,
  );
});

test('the SDK resolves the real uv base interpreter for Windows CMake builds', () => {
  const sdk = fs.readFileSync(
    path.join(ROOT, 'developer/sdk/src/sdk.js'),
    'utf8',
  );

  assert.match(sdk, /function resolveCmakePython\(python\)/);
  assert.match(sdk, /os\.path\.realpath\(getattr\(sys, "_base_executable"/);
  assert.match(
    sdk,
    /const corePython = resolveCmakePython\(resolveCorePython\(coreDir\)\)/,
  );
});

test('the SDK pins multi-config C++ probe artifacts to the declared dist directory', () => {
  const sdk = fs.readFileSync(
    path.join(ROOT, 'developer/sdk/src/sdk.js'),
    'utf8',
  );

  assert.match(sdk, /-DCMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE=\$\{distDir\}/);
  assert.match(sdk, /-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=\$\{distDir\}/);
});
