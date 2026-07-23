#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(
  root,
  'framework',
  'core',
  'src',
  'kfd-agent-runtime',
);
const mainPath = path.join(sourceDir, 'main.cpp');
const cmakePath = path.join(sourceDir, 'CMakeLists.txt');
const manifestPath = path.join(sourceDir, 'kfd-agent-runtime.manifest.json');
const workflowPath = path.join(
  root,
  '.github',
  'workflows',
  'embedding-membrane-spike.yml',
);
const main = fs.readFileSync(mainPath, 'utf8');
const cmake = fs.readFileSync(cmakePath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const kungfuIncludes = [...main.matchAll(/#include\s+[<"]([^>"]+)[>"]/g)]
  .map((match) => match[1])
  .filter((include) => include.startsWith('kungfu/'));
assert.deepEqual(kungfuIncludes.sort(), ['kungfu/api.h']);

for (const forbidden of [
  'src/libkungfu/src',
  'runtime/storage/',
  'service_internal',
  'pykungfu',
  'kungfu_node',
  'rule-table-adapter',
  'state-machine-adapter',
  'runtime-100.json',
]) {
  assert.equal(
    main.includes(forbidden),
    false,
    `adapter crossed a private or suite-owned boundary: ${forbidden}`,
  );
}

assert.match(
  cmake,
  /target_link_libraries\(kungfu-kfd-agent-runtime PRIVATE\s+\$\{LIBKUNGFU_NAME\}\s+nlohmann_json::nlohmann_json\s*\)/,
);
assert.doesNotMatch(cmake, /src\/libkungfu\/src|PRIVATE\s+.*runtime\/storage/);
assert.match(workflow, /library_pattern="libkungfu_runtime\.dylib"/);
assert.match(workflow, /library_pattern="libkungfu_runtime\.so"/);
assert.doesNotMatch(workflow, /library_pattern="libkungfu\.(?:dylib|so)"/);
assert.match(main, /if \(input\.contains\("actionBinding"\)\)/);
assert.match(main, /storage_retention = "not-requested"/);
assert.doesNotMatch(
  main,
  /value\("actionBinding", json::object\(\)\)/,
  'the standard KFD request must not be treated as if it supplied a Kungfu ActionBinding',
);
const qualificationHarness = fs.readFileSync(
  path.join(
    root,
    'framework',
    'core',
    'tests',
    'qualification',
    'kfd-agent-runtime',
    'run.mjs',
  ),
  'utf8',
);
assert.match(
  qualificationHarness,
  /\^libkungfu_runtime\\\.\(\?:dylib\|so/,
  'the qualification artifact must carry the standard runtime library',
);
assert.doesNotMatch(qualificationHarness, /acceptedVectorCount \+ 2/);
assert.equal(manifest.$schema, 'kungfu.kfd-agent-runtime.manifest/v1');
assert.equal(manifest.runtimeBoundary.languageHosts, 0);
assert.equal(manifest.runtimeBoundary.bootstrap, 'kungfu_get_api');
assert.equal(manifest.runtimeBoundary.abi, 1);
assert.deepEqual(manifest.runtimeBoundary.interfaces, [
  'stream',
  'ledger-action',
  'maintenance',
]);
assert.equal(manifest.suite.vectorCount, 100);
assert.equal(
  manifest.suite.vectorRoot,
  'sha256:1e996b8c43b0b3e38630ccd58acf8a714cbc24b339d3794318347faab9057e5f',
);
assert.match(
  workflow,
  /KFD_SHA: 03deef6bbc6e2ac8aecfedc76f17f6c74a72b878/,
  'the external conformance runner must use KFD v1.0.0-alpha.42 with the same Runtime 100 vector root',
);

process.stdout.write(
  `${JSON.stringify({
    schema: 'kungfu.kfd-agent-runtime.boundary-check/v1',
    ok: true,
    publicHeaders: kungfuIncludes,
    linkedTarget: '${LIBKUNGFU_NAME}',
    suiteRoot: manifest.suite.vectorRoot,
  })}\n`,
);
