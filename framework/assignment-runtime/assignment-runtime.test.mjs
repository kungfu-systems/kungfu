// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  contract,
  validateContract,
  validateEnvelope,
} from './validate-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures/contract-cases-v1.json'), 'utf8'),
);
const readRepoJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', relative), 'utf8'));
const readRepo = (relative) =>
  fs.readFileSync(path.join(HERE, '..', '..', relative), 'utf8');
const canonicalJson = (value) => {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const root = (value) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

test('freezes one backend-neutral Assignment Runtime contract', () => {
  assert.deepEqual(validateContract(), { ok: true, errors: [] });
  assert.equal(contract.protocol.id, 'kungfu.assignment-runtime/v1');
  assert.equal(contract.authority.writer, 'realm-runtime');
  assert.equal(Object.hasOwn(contract, 'compatibility'), false);
  assert.equal(contract.localRuntimeProfile.publicPathContract, false);
  assert.equal(contract.implementationStatus.localRuntime, 'implemented-r1');
  assert.deepEqual(contract.workSemantics.commandTypes, [
    'work.input.snapshot',
    'work.run.record',
    'work.effect.authorize',
    'work.effect.attempt',
    'work.effect.outcome',
  ]);
  assert.match(
    contract.workSemantics.ambiguousOutcome,
    /never permits blind repeat/,
  );
  assert.equal(
    contract.implementationStatus.clusterRuntime,
    'not-started-out-of-scope',
  );
});

test('registers one byte-identical discoverable contract surface', () => {
  const registry = readRepoJson(
    'framework/contract/kungfu-contracts.registry.json',
  );
  const policy = readRepoJson(
    'framework/contract/kungfu-agent-first-canonical-policy.json',
  );
  const entry = registry.contracts.find(
    (row) => row.surface === 'assignment-runtime',
  );
  const policyEntry = policy.surfaces.find(
    (row) => row.surface === 'assignment-runtime',
  );
  const sourceBytes = fs.readFileSync(
    path.join(HERE, 'assignment-runtime.contract.json'),
  );
  assert.ok(entry);
  assert.ok(policyEntry);
  assert.equal(entry.weldedSurface, contract.weldedSurface);
  assert.equal(
    entry.contractSchemaRoot,
    root(canonicalJson(contract.contractSchema)),
  );
  assert.equal(policyEntry.source.sha256, root(sourceBytes));
  assert.equal(policyEntry.source.renderedSha256, root(sourceBytes));
  assert.equal(policyEntry.artifact.expectedSha256, root(sourceBytes));
  assert.equal(policyEntry.source.byteForByte, true);
});

test('pins the current Assignment authority and client-path audit', () => {
  const audit = [
    [
      'framework/assignment-capture/assignment-capture.mjs',
      ['assignment-requests', 'assignment-request-captured'],
    ],
    [
      'framework/core/src/python/kungfu/cli/commands/assignment.py',
      ['def _runtime(', 'def _profile_action('],
    ],
    [
      'framework/core/src/python/kungfu/assignment_runtime/__init__.py',
      ['KF_EXTENSION_PATH does not name', 'runtime-host'],
    ],
    [
      'framework/core/src/python/kungfu/assignment_orchestration.py',
      ['def next_actions(', 'def gate(', 'def sealed_state_plan('],
    ],
    [
      'extensions/work-control/work-control-actions/domain/work_control_runtime.py',
      [
        'def claim_assignment_execution(',
        'def assignment_orchestration_status(',
        'def advance_assignment_phase(',
      ],
    ],
    [
      'extensions/work-dashboard/src/view/work-control-profile.ts',
      ['profile.memberCall<TResult>', 'createAssignment:', 'claimAssignment:'],
    ],
    [
      'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
      ['kungfu.agent.console.bind-work', 'kungfu.work.status'],
    ],
    [
      'extensions/work-control/actions/registry.json',
      ['create-assignment', 'advance-assignment'],
    ],
    [
      'extensions/work-control/collaboration/interface.json',
      ['"inspectViewId": "initiative-state"', '"actionId": "claim-assignment"'],
    ],
    ['framework/kfx/kungfu-kfx.contract.json', ['profile-member']],
  ];
  for (const [file, witnesses] of audit) {
    const text = readRepo(file);
    for (const witness of witnesses)
      assert.ok(text.includes(witness), `${file} must retain ${witness}`);
  }
});

test('zero-residue blockers fail closed across runtime, tests, and CLI registry', () => {
  const runtime = readRepo(
    'framework/core/src/python/kungfu/assignment_runtime/__init__.py',
  );
  const predecessorProfile = ['mission', 'control'].join('-');
  const removedPackage = ['kungfu', 'atlas'].join('.');
  const removedCliPrefixes = [
    ['kungfu', 'cli', 'commands', 'dev', 'mission', 'control'].join('.'),
    `${['kungfu', 'cli', 'commands', 'atlas'].join('.')}.`,
  ];
  const profileTest = readRepo(
    'framework/core/tests/python/test_work_control_profile.py',
  );
  const registry = readRepoJson(
    'framework/core/src/python/kungfu/cli/surface_contract.registry.json',
  );
  const registryText = canonicalJson(registry);

  assert.equal(runtime.includes(predecessorProfile), false);
  assert.match(runtime, /KF_EXTENSION_PATH does not name/u);
  assert.equal(profileTest.includes(removedPackage), false);
  for (const prefix of removedCliPrefixes)
    assert.equal(registryText.includes(prefix), false);
});

for (const fixture of fixtures.cases) {
  test(`contract fixture: ${fixture.id}`, () => {
    const request = validateEnvelope(fixture.request);
    assert.equal(
      request.ok,
      fixture.expected.requestValid,
      JSON.stringify(request.issues),
    );
    if (fixture.expected.requestCode) {
      assert.ok(
        request.issues.some((row) => row.code === fixture.expected.requestCode),
        JSON.stringify(request.issues),
      );
    }
    if (fixture.response) {
      const response = validateEnvelope(fixture.response);
      assert.equal(response.ok, true, JSON.stringify(response.issues));
      assert.equal(fixture.response.status, fixture.expected.responseStatus);
      assert.equal(
        fixture.response.error?.code ?? null,
        fixture.expected.errorCode ?? null,
      );
      assert.equal(
        fixture.response.result?.command?.disposition ?? null,
        fixture.expected.commandDisposition ?? null,
      );
    }
  });
}

test('fixtures never name a real Home path', () => {
  const text = JSON.stringify(fixtures);
  assert.equal(text.includes('/Users/'), false);
  assert.equal(text.includes('C:\\Users\\'), false);
  assert.equal(text.includes('~/.kungfu'), false);
});
