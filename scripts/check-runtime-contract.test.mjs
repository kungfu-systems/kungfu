// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkRuntimeContract,
  validateRuntimeContractValue,
} from './runtime-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'framework', 'runtime', 'kungfu-runtime.contract.json'),
    'utf8',
  ),
);
const WORK_CONTROL_ACTIONS = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'extensions', 'work-control', 'actions', 'registry.json'),
    'utf8',
  ),
);

test('runtime contract accepts positive fixtures and rejects all safety failures', async () => {
  const result = await checkRuntimeContract(ROOT);
  assert.equal(
    result.contract,
    'framework/runtime/kungfu-runtime.contract.json',
  );
  assert.equal(result.validFixtures, 5);
  assert.equal(result.rejectedFixtures, 7);
  assert.ok(['passed', 'skipped'].includes(result.schemaValidation));
});

test('process diagnostics do not upgrade a handle without a durable cut', () => {
  const value = {
    schema: 'kungfu.runtime.handle/v1',
    runtimeId: 'runtime-test',
    requirementId: 'request-test',
    workspaceId: 'workspace-test',
    generation: '1',
    state: 'ready',
    capabilities: ['runtime.peer-registry'],
    grantedAuthorities: ['runtime.coordinate'],
    readiness: {
      schema: 'kungfu.runtime.readiness/v1',
      state: 'ready',
      durableCut: null,
      projectionCut: null,
      evidence: [],
      observedAtNs: '1',
    },
    host: {
      kind: 'process',
      hostId: 'process-test',
      diagnostics: {
        supervisorPid: 100,
        coordinatorPid: 101,
        socketPath: null,
        serviceInstalled: true,
        guiVisible: true,
      },
    },
  };
  const issues = validateRuntimeContractValue('runtimeHandle', value, CONTRACT);
  assert.ok(issues.some((item) => item.code === 'pid-is-not-readiness'));
  assert.ok(issues.some((item) => item.code === 'readiness-cut-missing'));
});

test('process placement is explicit while semantic host and embedded remain non-claims', () => {
  assert.deepEqual(
    CONTRACT.hostKinds.currentTopology.map((item) => item.id),
    ['process'],
  );
  assert.equal(
    CONTRACT.hostKinds.currentTopology[0].contractAdapterImplemented,
    false,
  );
  const embedded = CONTRACT.hostKinds.reservedNonClaims.find(
    (item) => item.id === 'embedded',
  );
  assert.equal(embedded.productionEligible, false);
  assert.equal(CONTRACT.hostKinds.publicSemanticsDependOnHostKind, false);
});

test('operation registry classifies daemonless and live-required work from one authority', () => {
  const operations = new Map(
    CONTRACT.operationRegistry.operations.map((operation) => [
      operation.id,
      operation,
    ]),
  );
  assert.equal(
    CONTRACT.operationRegistry.schema,
    'kungfu.runtime-operation-registry/v1',
  );
  assert.deepEqual(operations.get('episode.append'), {
    id: 'episode.append',
    operationClass: 'storage-only',
    requiredCapabilities: [],
    requestedAuthorities: [],
    recoveryGuidance:
      'Append through the durable engine and return its receipt; do not activate a live host.',
  });
  assert.equal(
    operations.get('assessment.request').operationClass,
    'live-required',
  );
  assert.deepEqual(operations.get('assessment.request').requiredCapabilities, [
    'runtime.assessment-scheduling',
  ]);
});

test('the existing Profile action registry references the runtime operation authority', () => {
  const operations = new Map(
    CONTRACT.operationRegistry.operations.map((operation) => [
      operation.id,
      operation,
    ]),
  );
  for (const action of WORK_CONTROL_ACTIONS.actions) {
    assert.ok(
      operations.has(action.runtimeOperation),
      `${action.id} references an unknown runtime operation`,
    );
  }
  assert.equal(
    WORK_CONTROL_ACTIONS.actions.find(
      (action) => action.id === 'create-initiative',
    ).runtimeOperation,
    'episode.append',
  );
  assert.equal(
    WORK_CONTROL_ACTIONS.actions.some(
      (action) => action.id === 'create-mission' || action.id === 'create-go',
    ),
    false,
  );
  assert.equal(
    WORK_CONTROL_ACTIONS.actions.find(
      (action) => action.id === 'create-initiative',
    ).compatibility,
    undefined,
  );
  assert.equal(
    WORK_CONTROL_ACTIONS.actions.find(
      (action) => action.id === 'create-assignment',
    ).compatibility,
    undefined,
  );
  assert.equal(
    WORK_CONTROL_ACTIONS.actions.find(
      (action) => action.id === 'assess-progress',
    ).runtimeOperation,
    'assessment.request',
  );
});

test('standalone readiness and lease targets enforce their local invariants', () => {
  const readinessIssues = validateRuntimeContractValue(
    'runtimeReadiness',
    {
      state: 'ready',
      durableCut: null,
      evidence: [{ kind: 'process-pid' }],
    },
    CONTRACT,
  );
  assert.ok(
    readinessIssues.some((item) => item.code === 'readiness-cut-missing'),
  );
  assert.ok(
    readinessIssues.some((item) => item.code === 'pid-is-not-readiness'),
  );

  const leaseIssues = validateRuntimeContractValue(
    'runtimeLease',
    {
      state: 'active',
      generation: '0',
      issuedAtNs: '2',
      expiresAtNs: '1',
    },
    CONTRACT,
  );
  assert.ok(leaseIssues.some((item) => item.code === 'invalid-generation'));
  assert.ok(leaseIssues.some((item) => item.code === 'invalid-lease-window'));
});
