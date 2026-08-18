#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { identityFromAdrPath } from './adr-identity.mjs';
import { parseDumpbinExports } from './kfd7-public-symbols.mjs';
import {
  assertBootstrapAdmission,
  assertBootstrapDecisionDocuments,
  assertInstalledBootstrapExports,
  extractKfApiExportSymbols,
} from './libkungfu-bootstrap-admission.mjs';

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
const operationalSemanticsPath =
  'framework/core/architecture/kfd7-embedder-operational-semantics-v1.json';
const operationalSemantics = readJson(operationalSemanticsPath);
const releasePassport = readJson(
  'framework/core/architecture/kfd7-release-passport.json',
);
const symbolPolicyPath =
  'framework/core/architecture/libkungfu-symbol-policy.json';
const symbolPolicy = readJson(symbolPolicyPath);
const consumerGuide = read('docs/guides/libkungfu-abi-consumer.md');
const inventory = read('docs/architecture/kfd7-library-boundary.md');
const versioning = read('docs/development/versioning.md');
const embeddingSpike = read(
  'docs/research/libkungfu-embedding-membrane-spike.md',
);
const abiExports = read(
  'framework/core/src/libkungfu/src/runtime/abi_exports.cpp',
);
const retiredSymbols = [
  'kungfu_embedding_get_api',
  'kungfu_native_storage_get_api',
];

function baseSymbolPolicy() {
  const candidates = [
    process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : null,
    'origin/dev/v4/v4.0',
    'dev/v4/v4.0',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const mergeBase = spawnSync('git', ['merge-base', candidate, 'HEAD'], {
      encoding: 'utf8',
    });
    if (mergeBase.status !== 0) continue;
    const revision = mergeBase.stdout.trim();
    const source = spawnSync(
      'git',
      ['show', `${revision}:${symbolPolicyPath}`],
      { encoding: 'utf8' },
    );
    if (source.status === 0) {
      return JSON.parse(source.stdout);
    }
  }
  throw new Error(
    'cannot resolve the target-branch bootstrap admission policy',
  );
}

assert.equal(contract.$schema, 'kungfu.kfd7-library-boundary.contract/v1');
assert.ok(
  ['implemented-qualified', 'implemented-requalification-pending'].includes(
    contract.status,
  ),
);
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

const qualifiedBootstraps = assertBootstrapAdmission({
  policy: symbolPolicy,
  releasePassport,
  boundarySymbols: [...current.keys()],
  layerSymbols: [...registered.keys()],
  headerSymbols: extractKfApiExportSymbols(successorHeader),
  implementationSymbols: extractKfApiExportSymbols(abiExports),
  basePolicy: baseSymbolPolicy(),
});
assertBootstrapDecisionDocuments(symbolPolicy, (decision) =>
  fs.existsSync(decision) ? read(decision) : null,
);

assert.deepEqual(qualifiedBootstraps, ['kungfu_get_api']);
assert.deepEqual([...current.keys()].sort(), qualifiedBootstraps);
assert.deepEqual([...registered.keys()].sort(), qualifiedBootstraps);

for (const symbol of qualifiedBootstraps) {
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
  assert.equal(
    current.get(symbol).admissionId,
    registered.get(symbol).admission_id,
    `${symbol} admission id drifted between boundary contract and layer registry`,
  );
}

assert.equal(contract.currentPublicAbi.bootstrapAdmission.mode, 'closed-world');
assert.equal(contract.currentPublicAbi.bootstrapAdmission.default, 'deny');
assert.equal(
  contract.currentPublicAbi.bootstrapAdmission.policy,
  symbolPolicyPath,
);
assert.equal(
  contract.currentPublicAbi.bootstrapAdmission.implementationMaySelfAuthorize,
  false,
);
assert.equal(
  contract.currentPublicAbi.bootstrapAdmission
    .candidateMustPreexistOnTargetBranch,
  true,
);

assert.ok(
  [
    'implemented-consumer-ready-qualified',
    'implemented-consumer-ready-requalification-pending',
  ].includes(contract.successorAbi.status),
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
assert.match(
  successorHeader,
  /KF_SCHEMA_RUNTIME_ACTION_REQUEST_V1\s+"kungfu\.action-runtime\.operation\/v1"/,
);
assert.match(successorWrapper, /class context final/);
for (const retiredSymbol of retiredSymbols) {
  assert.doesNotMatch(successorHeader, new RegExp(retiredSymbol));
  assert.doesNotMatch(abiExports, new RegExp(retiredSymbol));
  assert.ok(
    !symbolPolicy.definedExports.includes(retiredSymbol),
    `retired symbol returned to public policy: ${retiredSymbol}`,
  );
}
for (const retiredPath of [
  'framework/core/src/libkungfu/include/kungfu/embedding.h',
  'framework/core/src/libkungfu/include/kungfu/embedding.hpp',
  'framework/core/src/libkungfu/include/kungfu/native_storage.h',
  'framework/core/src/libkungfu/tests/compat/public_contract_compatibility_tests.c',
]) {
  assert.ok(
    !fs.existsSync(retiredPath),
    `retired artifact returned: ${retiredPath}`,
  );
}
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
assert.equal(
  contract.authority.embedderOperationalSemantics,
  operationalSemanticsPath,
);
assert.equal(
  contract.successorAbi.operationalSemantics,
  operationalSemanticsPath,
);
assert.equal(conformance.operationalSemantics, operationalSemanticsPath);
assert.equal(
  operationalSemantics.$schema,
  'kungfu.kfd7-embedder-operational-semantics/v1',
);
assert.equal(operationalSemantics.timeout.statusCode.value, 11);
assert.equal(
  operationalSemantics.timeout.statusCode.disposition,
  'reserved-in-abi-v1',
);
assert.deepEqual(operationalSemantics.timeout.returnedByOperations, []);
assert.equal(
  operationalSemantics.cancellation.batchReader.checkpointIntervalFrames,
  32,
);
assert.equal(
  operationalSemantics.cancellation.batchReader.nonEmptyAtCheckpoint.status,
  'KF_OK',
);
assert.equal(
  operationalSemantics.cancellation.batchReader.nonEmptyAtCheckpoint
    .requestRemainsLatched,
  true,
);
assert.deepEqual(
  operationalSemantics.admission.operations
    .map((operation) => operation.name)
    .sort(),
  [
    'context_capabilities',
    'context_close',
    'context_last_error',
    'context_open',
    'context_request_cancel',
    'context_reset_cancel',
    'discovery.contract_get',
    'discovery.error_info',
    'discovery.interface_info',
    'discovery.result_release',
    'discovery.runtime_info',
    'interface_get',
    'kungfu_get_api',
    'ledger-action.binding_close',
    'ledger-action.binding_info',
    'ledger-action.binding_open',
    'ledger-action.execute',
    'ledger-action.result_release',
    'maintenance.execute',
    'maintenance.result_release',
    'stream.reader_close',
    'stream.reader_open',
    'stream.reader_read',
    'stream.reader_release',
  ],
);
assert.equal(operationalSemantics.recovery.discardableUnit, 'worker-process');
assert.equal(contract.operationalSemanticsQualification.status, 'pending');
assert.equal(
  releasePassport.operationalSemanticsQualification.status,
  'pending',
);
assert.equal(
  releasePassport.operationalSemanticsQualification.contract,
  operationalSemanticsPath,
);
assert.deepEqual(
  operationalSemantics.recovery.matrix.map((entry) => entry.class),
  [
    'process-local-context-handles-results-and-batches',
    'kungfu-append-only-journal-episode-and-receipt-backed-storage',
    'arbitrary-extension-or-third-party-side-effect',
  ],
);
assert.equal(operationalSemantics.admission.operations.length, 24);
for (const fixture of [
  'cancel-before-admission-output-unchanged',
  'cancel-after-admission-empty-batch',
  'cancel-after-admission-partial-batch',
  'context-owner-thread-violated',
  'result-slot-occupied',
]) {
  assert.ok(
    conformance.operationalFixtures.required.includes(fixture),
    `missing operational conformance fixture: ${fixture}`,
  );
}
assert.deepEqual(releasePassport.platformMatrix.required, [
  'darwin-arm64',
  'linux-x64',
  'win32-x64',
]);
assert.ok(
  ['pending', 'passed'].includes(
    releasePassport.platformMatrix.qualification.status,
  ),
);
assert.equal(
  releasePassport.platformMatrix.qualification.sourceRevision,
  contract.qualification.sourceRevision,
);
assert.equal(
  releasePassport.platformMatrix.qualification.workflowRun,
  contract.qualification.workflowRun,
);
if (releasePassport.platformMatrix.qualification.status === 'passed') {
  assert.equal(releasePassport.platformMatrix.qualification.reports.length, 3);
  for (const report of releasePassport.platformMatrix.qualification.reports) {
    assert.ok(
      report.endsWith(
        releasePassport.platformMatrix.qualification.sourceRevision,
      ),
      `qualification report is not revision-bound: ${report}`,
    );
  }
} else {
  assert.equal(
    releasePassport.platformMatrix.qualification.sourceRevision,
    null,
  );
  assert.equal(releasePassport.platformMatrix.qualification.workflowRun, null);
  assert.deepEqual(releasePassport.platformMatrix.qualification.reports, []);
}
assert.deepEqual(
  releasePassport.classifications.map(({ id, classification }) => ({
    id,
    classification,
  })),
  [
    { id: 'libkungfu-successor-c-abi', classification: 'consumer-ready' },
    { id: 'libyijinjing-source-static', classification: 'consumer-ready' },
    { id: 'rust-python-successor-wrappers', classification: 'consumer-ready' },
    { id: 'node-successor-abi-wrapper', classification: 'residual-risk' },
  ],
);
for (const entry of releasePassport.classifications) {
  for (const evidence of entry.evidence) {
    assert.ok(
      fs.existsSync(evidence),
      `release-passport evidence does not exist: ${entry.id}: ${evidence}`,
    );
  }
}
assert.ok(
  releasePassport.residualRisk.some((risk) =>
    risk.includes('Node package remains a direct in-process C++'),
  ),
  'Node successor-wrapper residual risk must remain explicit',
);
for (const retiredSymbol of retiredSymbols) {
  assert.ok(
    !JSON.stringify(releasePassport).includes(retiredSymbol),
    `release passport still treats ${retiredSymbol} as current evidence`,
  );
}
assert.deepEqual(contract.consumerReadiness.states, [
  'consumer-ready',
  'experimental',
  'residual-risk',
]);
assert.ok(
  contract.consumerReadiness.requiredEvidence.includes(
    'retired-bootstrap-absence-and-historical-evidence-separation',
  ),
);
assert.match(inventory, /The only public export is `kungfu_get_api`/);
assert.doesNotMatch(inventory, /compatibility-only/);
assert.match(versioning, /installed, one-bootstrap `libkungfu`/);
assert.match(embeddingSpike, /^document_status: deprecated$/m);
assert.match(consumerGuide, /find_package\(Kungfu 4 CONFIG REQUIRED\)/);
assert.match(consumerGuide, /cooperative before native admission/);
assert.match(consumerGuide, /reserved in ABI v1/);
assert.match(consumerGuide, /worker process/);
assert.match(consumerGuide, /pre-authorized on the\s+target branch/);
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
  [
    'discovery',
    'stream',
    'ledger-action',
    'maintenance',
    'runtime-action',
    'initiative-assignment',
  ],
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

const admitted = symbolPolicy.bootstrapAdmission.entries[0];
assert.equal(admitted.symbol, 'kungfu_get_api');
assert.equal(admitted.status, 'qualified');
assert.notEqual(
  admitted.authorization.changeAuthor,
  admitted.authorization.reviewer,
);
const clone = (value) => structuredClone(value);
const surfaceFixture = () => ({
  policy: clone(symbolPolicy),
  releasePassport: clone(releasePassport),
  boundarySymbols: ['kungfu_get_api'],
  layerSymbols: ['kungfu_get_api'],
  headerSymbols: ['kungfu_get_api'],
  implementationSymbols: ['kungfu_get_api'],
  basePolicy: clone(symbolPolicy),
});

{
  const fixture = surfaceFixture();
  fixture.headerSymbols.push('kungfu_unreviewed_get_api');
  assert.throws(
    () => assertBootstrapAdmission(fixture),
    /public header drifted from the qualified bootstrap admission set/,
  );
}

{
  const fixture = surfaceFixture();
  fixture.policy.bootstrapAdmission.entries[0].authorization.approval =
    'https://github.com/kungfu-systems/kungfu/pull/1191#pullrequestreview-4742718148';
  assert.throws(
    () => assertBootstrapAdmission(fixture),
    /approval must belong to the authorization change/,
  );
}

{
  const fixture = surfaceFixture();
  const decisionIdentity = identityFromAdrPath(
    fixture.policy.bootstrapAdmission.entries[0].decision,
  );
  assert.ok(decisionIdentity);
  assert.throws(
    () =>
      assertBootstrapDecisionDocuments(
        fixture.policy,
        () => `adr_id: ${decisionIdentity}\ndecision_status: proposed\n`,
      ),
    /decision is not accepted/,
  );
  assert.throws(
    () => assertBootstrapDecisionDocuments(fixture.policy, () => null),
    /decision document is missing/,
  );
  assert.throws(
    () =>
      assertBootstrapDecisionDocuments(
        fixture.policy,
        () =>
          'adr_id: KF-ADR-019f86da-4f90-7000-8000-000000000001\n' +
          'decision_status: accepted\n',
      ),
    /decision path does not match its ADR identity/,
  );
}

for (const actualSymbols of [
  [],
  ['kungfu_get_api', 'kungfu_unreviewed_get_api'],
]) {
  assert.throws(
    () =>
      assertInstalledBootstrapExports({
        policy: clone(symbolPolicy),
        releasePassport: clone(releasePassport),
        actualSymbols,
      }),
    /installed libkungfu exports drifted from the qualified bootstrap admission set/,
  );
}

{
  const fixture = surfaceFixture();
  const candidate = clone(admitted);
  candidate.id = 'libkungfu-bootstrap-unreviewed-v1';
  candidate.symbol = 'kungfu_unreviewed_get_api';
  candidate.authorization.change =
    'https://github.com/kungfu-systems/kungfu/pull/999999';
  candidate.authorization.approval =
    'https://github.com/kungfu-systems/kungfu/pull/999999#pullrequestreview-999999';
  fixture.policy.bootstrapAdmission.entries.push(candidate);
  fixture.policy.definedExports.push(candidate.symbol);
  for (const key of [
    'boundarySymbols',
    'layerSymbols',
    'headerSymbols',
    'implementationSymbols',
  ]) {
    fixture[key].push(candidate.symbol);
  }
  assert.throws(
    () => assertBootstrapAdmission(fixture),
    /was not authorized on the target branch before implementation/,
  );
}

{
  const fixture = surfaceFixture();
  const candidate = clone(admitted);
  candidate.id = 'libkungfu-bootstrap-authorized-v1';
  candidate.symbol = 'kungfu_authorized_get_api';
  candidate.status = 'authorized';
  candidate.qualification = {
    status: 'required',
    sourceRevision: null,
    workflowRun: null,
    requiredPlatforms: clone(releasePassport.platformMatrix.required),
  };
  candidate.authorization.approval = undefined;
  fixture.policy.bootstrapAdmission.entries.push(candidate);
  assert.throws(
    () => assertBootstrapAdmission(fixture),
    /approval must be a string/,
  );
}

{
  const fixture = surfaceFixture();
  const baseCandidate = clone(admitted);
  baseCandidate.id = 'libkungfu-bootstrap-authorized-v1';
  baseCandidate.symbol = 'kungfu_authorized_get_api';
  baseCandidate.status = 'authorized';
  baseCandidate.qualification = {
    status: 'required',
    sourceRevision: null,
    workflowRun: null,
    requiredPlatforms: clone(releasePassport.platformMatrix.required),
  };
  fixture.basePolicy.bootstrapAdmission.entries.push(baseCandidate);
  const qualifiedCandidate = clone(admitted);
  qualifiedCandidate.id = baseCandidate.id;
  qualifiedCandidate.symbol = baseCandidate.symbol;
  qualifiedCandidate.authorization = clone(baseCandidate.authorization);
  fixture.policy.bootstrapAdmission.entries.push(qualifiedCandidate);
  fixture.policy.definedExports.push(qualifiedCandidate.symbol);
  for (const key of [
    'boundarySymbols',
    'layerSymbols',
    'headerSymbols',
    'implementationSymbols',
  ]) {
    fixture[key].push(qualifiedCandidate.symbol);
  }
  assert.deepEqual(assertBootstrapAdmission(fixture), [
    'kungfu_authorized_get_api',
    'kungfu_get_api',
  ]);
  fixture.policy.bootstrapAdmission.entries[1].authorization.reviewer =
    'self-reviewer';
  assert.throws(
    () => assertBootstrapAdmission(fixture),
    /authorization changed in the implementation change/,
  );
}

{
  const fixture = surfaceFixture();
  fixture.policy.bootstrapAdmission.entries[0].qualification.sourceRevision =
    '0000000000000000000000000000000000000000';
  assert.throws(
    () => assertBootstrapAdmission(fixture),
    /qualification source revision drifted from the Release Passport/,
  );
}

for (const path of Object.values(contract.authority)) {
  assert.ok(fs.existsSync(path), `missing authority file ${path}`);
}

console.log('KFD-7 library boundary contract: ok');
