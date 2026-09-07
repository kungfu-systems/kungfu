// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import workLifecycle from '@kungfu-tech/storage/generated/work-lifecycle-v1';

const read = (relative) => fs.readFileSync(relative, 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const matrix = readJson(
  'framework/work/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
);
const nativeContract = readJson(
  'framework/work/work-lifecycle/work-lifecycle-native.contract.json',
);

test('one matrix owns every language state, native owner, and reconciliation edge', () => {
  const membrane = matrix.authorityMembrane;
  assert.equal(membrane.semanticDecisionOwner, 'native-runtime-only');
  for (const operation of nativeContract.operations) {
    assert.match(operation.semanticOwner, /^libkungfu\/runtime\//u);
    assert.ok(
      ['available', 'degraded', 'unsupported', 'unavailable'].includes(
        operation.availability,
      ),
    );
    assert.equal(typeof operation.reasonCode, 'string');
    assert.deepEqual(operation.languageSurfaces, {
      cpp: 'projected',
      python: 'projected',
      node: 'projected',
      rust: 'projected',
    });
  }
  for (const target of [
    membrane.reconciles.layeredApi,
    membrane.reconciles.portableFormatAuthority,
    membrane.reconciles.primitiveCatalog,
  ])
    assert.equal(fs.existsSync(target), true, target);
  assert.equal('nativeWorkJournal' in membrane.reconciles, false);
  assert.equal(
    membrane.closedInventory.operations.runtimeAction.includes('work_journal'),
    false,
  );
});

test('raw Node membrane preserves exact request and response bytes including unknowns', () => {
  const requestBytes = Buffer.from(
    '{"action":"work_lifecycle","mode":"invoke","operationId":"work.lifecycle.unknown/v9","input":{"unknown":null,"falseValue":false,"ordered":[3,2,1]},"execute":false}',
  );
  const responseBytes = Buffer.from(
    '{"schema":"kungfu.action-runtime.result/v1","result":{"status":"unknown","reasonCode":"operation-state-unknown","extension":{"future":null}}}',
  );
  let observed;
  const client = {
    callRuntimeActionRaw(runtimeDir, bytes) {
      observed = { runtimeDir, bytes: Buffer.from(bytes) };
      return {
        protocolId: 'kungfu.runtime.action',
        protocolVersion: 1,
        schemaRef: 'kungfu.action-runtime.result/v1',
        encoding: 'application/json',
        bytes: responseBytes,
      };
    },
  };
  const response = workLifecycle.invokeRaw(
    client,
    '/isolated/runtime',
    requestBytes,
  );
  assert.equal(observed.runtimeDir, '/isolated/runtime');
  assert.deepEqual(observed.bytes, requestBytes);
  assert.deepEqual(response.bytes, responseBytes);
});

test('installed language projections expose raw transport and never pre-decide unknown operations', () => {
  const unknown = 'work.lifecycle.future-operation/v9';
  assert.equal(workLifecycle.request(unknown, {}, false).operationId, unknown);
  assert.throws(() => workLifecycle.request(unknown), /are required/u);
  const sources = {
    cpp: read(
      'framework/core/src/libkungfu/include/kungfu/sdk/generated/work_lifecycle_v1.hpp',
    ),
    python: read(
      'framework/storage/python/kungfu_sdk/generated/work_lifecycle_v1.py',
    ),
    node: read('framework/storage/generated/work-lifecycle-v1.js'),
    rust: read('crates/kungfu-sdk/src/generated/work_lifecycle_v1.rs'),
  };
  assert.match(sources.cpp, /invoke_raw/u);
  assert.match(sources.python, /def invoke_raw/u);
  assert.match(sources.node, /function invokeRaw/u);
  assert.match(sources.rust, /pub fn invoke_raw/u);
  for (const source of Object.values(sources)) {
    assert.doesNotMatch(source, /unknown Work lifecycle operation/u);
    assert.doesNotMatch(
      source,
      /writeFile|sqlite|journal_writer|open\([^)]*,\s*["']w/u,
    );
  }
});

test('Python conformance oracles are explicit and production fallback is absent', () => {
  const source = read(
    'framework/core/src/python/kungfu/agent/_work_profile/session.py',
  );
  assert.doesNotMatch(source, /_native_edge_available/u);
  assert.doesNotMatch(source, /fall back to the pure-Python/u);
  for (const name of [
    'capabilities_python',
    'session_compressibility_python',
    'session_valid_actions_python',
    'expand_session_python',
    'project_session_python',
  ]) {
    const start = source.indexOf(`def ${name}`);
    assert.notEqual(start, -1, name);
    const next = source.indexOf('\ndef ', start + 5);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.match(
      body,
      /require_conformance_oracle\(conformance=conformance\)/u,
    );
  }
  for (const name of [
    'capabilities',
    'session_compressibility',
    'session_valid_actions',
    'expand_session',
    'project_session',
  ]) {
    const start = source.indexOf(`def ${name}(`);
    assert.notEqual(start, -1, name);
    const next = source.indexOf('\ndef ', start + 5);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.match(body, /require_action_runtime\(\)/u);
  }
});

test('status taxonomy is not compatibility-remapped and bypass receipts stay fenced', () => {
  assert.doesNotMatch(
    read('framework/storage/python/kungfu_sdk/native.py'),
    /compatibility_status/u,
  );
  assert.doesNotMatch(
    read('crates/kungfu-sdk/src/lib.rs'),
    /compatibility_status/u,
  );
  const runtime = read(
    'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
  );
  const generated = read(
    'framework/core/src/libkungfu/include/kungfu/sdk/generated/work_lifecycle_v1.hpp',
  );
  assert.match(runtime, /bypass-not-admitted/u);
  assert.match(generated, /native-operation-unavailable/u);
  assert.match(runtime, /unsupported-operation/u);
  const fixture = readJson(
    'tests/qualification/work-lifecycle/four-language-v1.json',
  );
  const bypass = fixture.runtimeCases.find(
    (entry) => entry.id === 'cut-settle-bypass-receipt-not-admitted',
  );
  assert.ok(bypass);
  assert.equal(
    bypass.assert.some(
      (entry) =>
        entry.path.join('.') === 'result.admitted' && entry.equals === false,
    ),
    true,
  );
  const retiredWorkInspect = fixture.runtimeCases.find(
    (entry) => entry.id === 'retired-native-work-inspect-unsupported',
  );
  assert.ok(retiredWorkInspect);
  assert.equal(
    retiredWorkInspect.operationId,
    'work.lifecycle.work.inspect/v1',
  );
  assert.deepEqual(
    Object.fromEntries(
      retiredWorkInspect.assert.map((entry) => [
        entry.path.join('.'),
        entry.equals,
      ]),
    ),
    {
      'result.status': 'unsupported',
      'result.reasonCode': 'unsupported-operation',
      'result.admitted': false,
      'result.authorityExecuted': false,
    },
  );
});
