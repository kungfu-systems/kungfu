// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
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

const contract = readJson(
  'framework/agent-work/kungfu-agent-work-state.contract.json',
);
const registry = readJson('framework/contract/kungfu-contracts.registry.json');
const commands = readJson(
  'framework/core/src/python/kungfu/agent/commands.json',
);
const kfd3 = readJson(
  'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
);
const kfd2 = readJson('.buildchain/kfd/kfd-2/registry.json');
const canonicalPolicy = readJson(
  'framework/contract/kungfu-agent-first-canonical-policy.json',
);

test('registers one four-role welded contract with bounded claims', () => {
  const entry = registry.contracts.find(
    (candidate) => candidate.surface === 'agent-work-state',
  );
  assert.ok(entry);
  assert.equal(
    entry.contractSchemaRoot,
    `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(contract.contractSchema))
      .digest('hex')}`,
  );
  assert.equal(
    entry.source,
    'framework/agent-work/kungfu-agent-work-state.contract.json',
  );
  assert.equal(entry.weldedSurface, 'agent-work-state-contract');
  const policyEntry = canonicalPolicy.surfaces.find(
    (candidate) => candidate.surface === 'agent-work-state',
  );
  const sourceRoot = `sha256:${crypto
    .createHash('sha256')
    .update(read('framework/agent-work/kungfu-agent-work-state.contract.json'))
    .digest('hex')}`;
  assert.ok(policyEntry);
  assert.equal(policyEntry.source.sha256, sourceRoot);
  assert.equal(policyEntry.source.renderedSha256, sourceRoot);
  assert.equal(policyEntry.artifact.expectedSha256, sourceRoot);
  assert.deepEqual(contract.roleOrder, [
    'pursuit',
    'atlas',
    'warrant',
    'episode',
  ]);
  assert.deepEqual(
    contract.roles.map((role) => role.id),
    contract.roleOrder,
  );
  assert.equal(contract.status.runtimeProjection, 'partial');
  assert.equal(contract.status.releaseQualification, 'not-qualified');
  assert.equal(contract.qualification.status, 'not-qualified');
  assert.ok(contract.nonClaims.includes('P17 is release-qualified.'));
  assert.deepEqual(contract.publicSurfaces.governance, {
    contract: 'kfd-1-generic-query',
    agent: 'kfd-3-collaboration-interface',
    agentDiscovery: 'kfd-3-collaboration-interface',
    human: 'documentation',
    decision: 'architecture-decision',
    register: 'kfd-1-register',
  });
  assert.ok(
    kfd2.claims.some((claim) => claim.id === 'agent-work-state-contract'),
  );
});

test('publishes every invalid inference and P17 check', () => {
  assert.deepEqual(
    new Set(contract.invalidInferences.map((row) => row.id)),
    new Set([
      'goal-is-authority',
      'context-is-reality',
      'plan-is-occurrence',
      'occurrence-is-completion',
      'parent-warrant-authorizes-descendant',
    ]),
  );
  assert.deepEqual(
    contract.qualification.checks.map((row) => row.id),
    Array.from({ length: 8 }, (_, index) => `FO${index + 1}`),
  );
  assert.equal(contract.relations.cardinality, 'many-to-many');
  assert.equal(contract.relations.inheritance, 'none');
});

test('human and agent routes point to the same contract authority', () => {
  const api = kfd3.apis.find((row) => row.id === 'kungfu.agent.work-model');
  const command = commands.commands.find(
    (row) => row.apiId === 'kungfu.agent.work-model',
  );
  assert.ok(api);
  assert.ok(command);
  assert.equal(api.anchor.kind, 'runtime-click');
  assert.equal(api.anchor.symbol, 'work_model');
  assert.equal(command.name, contract.publicSurfaces.agent);

  const human = read('docs/profiles/agent-work-state.md');
  const adr = read(
    'docs/adr/ADR-0109-four-object-agent-work-state-contract.md',
  );
  const map = read('docs/MAP.md');
  for (const text of [human, adr, map]) {
    assert.match(text, /kungfu agent work-model --json/);
  }
  assert.match(
    human,
    /framework\/agent-work\/kungfu-agent-work-state\.contract\.json/,
  );
});
