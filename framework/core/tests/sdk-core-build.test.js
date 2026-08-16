// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CORE = path.resolve(__dirname, '..');
const ROOT = path.resolve(CORE, '..', '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('SDK Core build freezes the minimum installed-artifact target closure', () => {
  const plan = JSON.parse(
    fs.readFileSync(
      path.join(CORE, 'architecture', 'sdk-build-plan.json'),
      'utf8',
    ),
  );

  assert.equal(plan.$schema, 'kungfu.core-sdk-build-plan/v1');
  assert.equal(plan.profile, 'full');
  assert.equal(plan.runtime, 'node');
  assert.equal(plan.target, 'kungfu_node');
  assert.deepEqual(plan.cmake_definitions, {
    CMAKE_CXX_SCAN_FOR_MODULES: 'OFF',
    KUNGFU_WITH_CORE_TESTS: 'OFF',
  });
  assert.deepEqual(plan.required_artifacts.common, [
    'kungfu-core-build-identity.json',
    'kungfubuildinfo.json',
    'kungfu_node.node',
  ]);
  assert.deepEqual(plan.required_artifacts.darwin, [
    'libkungfu.dylib',
    'libkungfu_runtime.dylib',
  ]);
  assert.deepEqual(plan.required_artifacts.linux, [
    'libkungfu.so',
    'libkungfu_runtime.so',
  ]);
  assert.deepEqual(plan.required_artifacts.win32, ['kungfu.dll']);
  assert.deepEqual(plan.excluded_work, [
    'core-native-tests',
    'electron-runtime-configure-and-build',
    'full-default-target',
    'node-drone-addon',
    'node-runtime-host',
    'production-libwasm-dual-engine-build',
    'pykungfu-binding-stubs-and-wheel',
    'public-header-self-compilation',
    'unused-cxx-module-dependency-scans',
  ]);
});

test('SDK Core build plan drives both orchestrators and the queue workflow', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const corePackage = JSON.parse(read('framework/core/package.json'));
  const build = read('framework/core/.gyp/run-build.js');
  const conan = read('framework/core/conanfile.py');
  const coreCmake = read('framework/core/CMakeLists.txt');
  const compiler = read('framework/core/.cmake/compiler.cmake');
  const libwasm = read('framework/core/src/libwasm/CMakeLists.txt');
  const workflow = read('.github/workflows/affected-native-pr.yml');
  const warrantedExecution = read(
    '.github/actions/native-execution-under-warrant/action.yml',
  );

  assert.equal(
    rootPackage.scripts['build:core:sdk'],
    'node scripts/require-shifu.mjs build:core:sdk && pnpm --filter @kungfu-tech/core run build:sdk',
  );
  assert.equal(
    corePackage.scripts['build:sdk'],
    'node .gyp/run-build.js build-sdk',
  );
  assert.match(build, /require\('\.\.\/architecture\/sdk-build-plan\.json'\)/);
  assert.match(build, /\.command\('build-sdk', \(\) => build\('sdk'\)\)/);
  assert.match(
    build,
    /case 'darwin':[\s\S]*case 'linux':[\s\S]*case 'win32':[\s\S]*default:[\s\S]*unsupported SDK Core build platform/,
  );
  assert.match(
    conan,
    /sdk-build-plan\.json[\s\S]*target=SDK_BUILD_PLAN\["target"\][\s\S]*cmake_definitions=SDK_BUILD_PLAN\["cmake_definitions"\]/,
  );
  assert.match(
    conan,
    /scope == "full"[\s\S]*full_cmake_definitions = \{"KUNGFU_WITH_CORE_TESTS": "ON"\}[\s\S]*"node", cmake_definitions=full_cmake_definitions[\s\S]*"electron", cmake_definitions=full_cmake_definitions/,
  );
  assert.match(
    conan,
    /target_option = \["--target", target\] if cmd == "build" and target else \[\]/,
  );
  assert.match(conan, /python_path = sys\.executable/);
  assert.match(conan, /--CDCMAKE_MAKE_PROGRAM=\{_cmake_path\(ninja_path\)\}/);
  assert.match(conan, /cargo_parallel_level = max\(1, parallel_level - 1\)/);
  assert.match(conan, /--CDKF_LIBWASM_CARGO_JOBS=\{cargo_parallel_level\}/);
  assert.match(
    libwasm,
    /KF_LIBWASM_CARGO_JOBS[\s\S]*KF_LIBWASM_CARGO_JOB_ARGS --jobs[\s\S]*\$\{KF_LIBWASM_CARGO_JOB_ARGS\}/,
  );
  assert.doesNotMatch(compiler, /<CXX_COMPILER_ID:MSVC>:[^>]*\/MP/);
  assert.match(
    coreCmake,
    /TARGET pybind11::windows_extras[\s\S]*list\(FILTER KUNGFU_PYBIND11_WINDOWS_COMPILE_OPTIONS[\s\S]*EXCLUDE REGEX "\/MP"\)/,
  );
  assert.match(
    workflow,
    /uses: \.\/\.github\/actions\/native-execution-under-warrant[\s\S]*command: \|[\s\S]*\.\/shifu build:core:sdk/,
  );
  assert.doesNotMatch(
    workflow,
    /uses: \.\/\.github\/actions\/native-execution-under-warrant[\s\S]*command: \|[\s\S]*\.\/shifu build:core(?:\s|$)/,
  );
  assert.match(
    warrantedExecution,
    /KUNGFU_NATIVE_COMMAND: \$\{\{ inputs\.command \}\}[\s\S]*native-execution-under-warrant\.mjs/,
  );
});
