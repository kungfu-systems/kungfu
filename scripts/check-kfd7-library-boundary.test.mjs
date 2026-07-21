#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseDumpbinExports } from './kfd7-public-symbols.mjs';

const read = (path) => fs.readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(read(path));

const contractPath =
  'framework/core/architecture/kfd7-library-boundary.contract.json';
const contract = readJson(contractPath);
const layers = readJson('framework/core/architecture/layers.json');
const successorHeader = read(
  'framework/core/src/libkungfu/include/kungfu/api.h',
);
const successorWrapper = read(
  'framework/core/src/libkungfu/include/kungfu/api.hpp',
);
const consumerCMake = read(
  'framework/core/examples/kfd7-consumer/CMakeLists.txt',
);
const installConfig = read('framework/core/cmake/KungfuConfig.cmake.in');
const conformance = readJson(
  'framework/core/architecture/kfd7-abi-conformance-v1.json',
);
const releasePassport = readJson(
  'framework/core/architecture/kfd7-release-passport.json',
);
const consumerGuide = read('docs/guides/libkungfu-abi-consumer.md');

assert.equal(contract.$schema, 'kungfu.kfd7-library-boundary.contract/v1');
assert.equal(contract.status, 'implemented-qualified');
assert.equal(contract.kfd7Status, 'draft');
assert.equal(contract.consumerReadiness.adopterCountGate, false);
assert.ok(
  contract.layers.some(
    (layer) =>
      layer.id === 'action-geometry' &&
      layer.forbids.includes('domain-fields-or-lifecycle-vocabulary'),
  ),
);
assert.equal(
  contract.authority.actionGeometryContract,
  'framework/action/action-geometry.contract.json',
);
assert.equal(
  contract.authority.agentWorkDomainProfile,
  'framework/agent-work/kungfu-agent-work-domain-profile.contract.json',
);

const current = new Map(
  contract.currentPublicAbi.symbols.map((entry) => [entry.name, entry]),
);
const registered = new Map(
  layers.public_contracts.stable_symbols.map((entry) => [entry.name, entry]),
);

for (const symbol of ['kungfu_get_api']) {
  assert.ok(
    current.has(symbol),
    `contract missing current public symbol ${symbol}`,
  );
  assert.ok(
    registered.has(symbol),
    `layer registry missing current public symbol ${symbol}`,
  );
  assert.deepEqual(
    current.get(symbol).versions,
    registered.get(symbol).abi_versions,
    `${symbol} ABI versions drifted between boundary contract and layer registry`,
  );
}

assert.equal(
  contract.successorAbi.status,
  'implemented-consumer-ready-qualified',
);
assert.equal(contract.successorAbi.bootstrap.symbol, 'kungfu_get_api');
assert.match(successorHeader, /KF_ABI_V1\s+UINT32_C\(1\)/);
assert.match(successorHeader, /kungfu_get_api\s*\(/);
assert.match(
  successorHeader,
  /KF_SCHEMA_LEDGER_ACTION_REQUEST_V1\s+"kungfu\.ledger-action\.request\/v1"/,
);
assert.match(
  successorHeader,
  /KF_SCHEMA_MAINTENANCE_REQUEST_V1\s+"kungfu\.maintenance\.request\/v1"/,
);
assert.match(successorWrapper, /class context final/);
assert.match(consumerCMake, /find_package\(Kungfu 4 CONFIG REQUIRED\)/);
assert.match(consumerCMake, /Kungfu::kungfu/);
assert.match(installConfig, /add_library\(Kungfu::kungfu SHARED IMPORTED\)/);
for (const path of [
  'framework/core/examples/kfd7-consumer/c/main.c',
  'framework/core/examples/kfd7-consumer/cpp/main.cpp',
  'framework/core/examples/kfd7-yijinjing-source/CMakeLists.txt',
  'framework/core/examples/kfd7-yijinjing-source/main.cpp',
  'framework/core/architecture/libkungfu-symbol-policy.json',
  'framework/core/architecture/kfd7-abi-conformance-v1.json',
  'framework/core/architecture/kfd7-release-passport.json',
  'docs/guides/libkungfu-abi-consumer.md',
  'scripts/qualify-kfd7-installed-consumer.mjs',
]) {
  assert.ok(fs.existsSync(path), `missing successor consumer artifact ${path}`);
}
assert.equal(
  conformance.actionBindingVector.bindingRoot,
  'sha256:c156cb56fc16603689f6b875985ed7b7d92bec5d5d5b76adc2f75c67fabb3739',
);
assert.deepEqual(releasePassport.platformMatrix.required, [
  'darwin-arm64',
  'linux-x64',
  'win32-x64',
]);
assert.equal(releasePassport.platformMatrix.qualification.status, 'passed');
assert.equal(
  releasePassport.platformMatrix.qualification.sourceRevision,
  contract.qualification.sourceRevision,
);
assert.equal(
  releasePassport.platformMatrix.qualification.workflowRun,
  contract.qualification.workflowRun,
);
assert.equal(releasePassport.platformMatrix.qualification.reports.length, 3);
assert.match(consumerGuide, /find_package\(Kungfu 4 CONFIG REQUIRED\)/);
assert.match(consumerGuide, /cooperative before native admission/);
assert.deepEqual(
  parseDumpbinExports(`
    ordinal hint RVA      name
          1    0 00012000 kungfu_get_api
  `),
  ['kungfu_get_api'],
);
assert.deepEqual(
  registered.get(contract.successorAbi.bootstrap.symbol).abi_versions,
  [1],
);

assert.deepEqual(
  contract.successorAbi.interfaces.map((entry) => entry.id),
  ['discovery', 'stream', 'ledger-action', 'maintenance'],
);
assert.deepEqual(
  contract.dependencies.map((entry) => entry.statusAtInventory),
  ['completed', 'completed', 'completed'],
);
assert.ok(
  contract.dependencies.every((entry) =>
    /^sha256:[0-9a-f]{64}$/.test(entry.admittedRoot),
  ),
  'completed dependencies must retain exact admitted roots',
);
assert.equal(contract.compatibility.status, 'retired');
assert.equal(contract.compatibility.replacement, 'kungfu_get_api');

for (const path of Object.values(contract.authority)) {
  assert.ok(fs.existsSync(path), `missing authority file ${path}`);
}

console.log('KFD-7 library boundary contract: ok');
