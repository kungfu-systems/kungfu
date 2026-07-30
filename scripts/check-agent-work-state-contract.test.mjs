// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { validateAgentWorkProfile } from '../framework/agent-work/validate-profile.mjs';

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
const actionGeometry = readJson(
  'framework/action/action-geometry.contract.json',
);
const domainProfile = readJson(
  'framework/agent-work/kungfu-agent-work-domain-profile.contract.json',
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
const fixtureManifest = readJson('framework/agent-work/fixtures/manifest.json');
const continuityFixtures = readJson(
  'framework/agent-work/fixtures/continuity-evidence-cases.json',
);

test('registers one layered Agent Work contract with bounded claims', () => {
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
  assert.deepEqual(contract.semanticLayers.ontology, {
    name: 'Fact-Episode Ontology',
    bindings: ['fact', 'episode'],
  });
  assert.deepEqual(contract.semanticLayers.actionGeometry, {
    name: 'Action Geometry',
    mappings: ['pursuit', 'atlas', 'warrant'],
  });
  assert.equal(contract.status.runtimeProjection, 'partial');
  assert.equal(contract.status.releaseQualification, 'not-qualified');
  assert.equal(contract.qualification.status, 'not-qualified');
  assert.equal(contract.schema, 'kungfu.agent-work-state.contract/v2');
  assert.equal(contract.version, 2);
  assert.equal(contract.formalModel.version, 1);
  assert.equal(contract.actionBinding.primitive, false);
  assert.deepEqual(contract.actionBinding.requiredRoots, [
    'fact_cut_root',
    'pursuit_root',
    'atlas_root',
    'warrant_root',
  ]);
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

test('validates Profile shape and cross-object semantics from one contract', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => Number.isFinite(Date.parse(value)),
  });
  assert.equal(
    ajv.compile(contract.profileSchema).schema,
    contract.profileSchema,
  );

  for (const fixture of fixtureManifest.cases) {
    const profile = readJson(`framework/agent-work/fixtures/${fixture.path}`);
    const result = validateAgentWorkProfile(contract, profile);
    assert.equal(
      result.ok,
      fixture.ok,
      `${fixture.path}: ${JSON.stringify(result.issues)}`,
    );
    const codes = new Set(result.issues.map((issue) => issue.code));
    for (const code of fixture.codes ?? [])
      assert.ok(codes.has(code), `${fixture.path} must expose ${code}`);
  }
});

test('separates Action Geometry from the Agent Work Domain Profile by exact roots', () => {
  const geometryEntry = registry.contracts.find(
    (candidate) => candidate.surface === 'action-geometry',
  );
  const profileEntry = registry.contracts.find(
    (candidate) => candidate.surface === 'agent-work-domain-profile',
  );
  assert.ok(geometryEntry);
  assert.ok(profileEntry);

  const geometryRoot = `sha256:${crypto
    .createHash('sha256')
    .update(read('framework/action/action-geometry.contract.json'))
    .digest('hex')}`;
  const profileRoot = `sha256:${crypto
    .createHash('sha256')
    .update(
      read(
        'framework/agent-work/kungfu-agent-work-domain-profile.contract.json',
      ),
    )
    .digest('hex')}`;
  assert.equal(domainProfile.actionGeometry.root, geometryRoot);
  assert.equal(
    geometryEntry.contractSchemaRoot,
    `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(actionGeometry.contractSchema))
      .digest('hex')}`,
  );
  assert.equal(
    profileEntry.contractSchemaRoot,
    `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(domainProfile.contractSchema))
      .digest('hex')}`,
  );
  assert.equal(profileRoot.startsWith('sha256:'), true);
  assert.equal(actionGeometry.initialStates, undefined);
  assert.equal(actionGeometry.transitions, undefined);
  assert.equal(actionGeometry.presentation, undefined);
  assert.equal(actionGeometry.evidenceAndSuccess, undefined);

  for (const role of domainProfile.roleOrder) {
    const row = domainProfile.roleSchemas[role];
    const actual = `sha256:${crypto
      .createHash('sha256')
      .update(read(row.source))
      .digest('hex')}`;
    assert.equal(row.root, actual);
  }
  assert.deepEqual(
    profileEntry.extraArtifacts.map((row) => row.source),
    domainProfile.roleOrder.map(
      (role) => domainProfile.roleSchemas[role].source,
    ),
  );
});

test('proves context payload alone cannot determine action validity', () => {
  const [authorizedPath, deniedPath] = fixtureManifest.contextInsufficiencyPair;
  const authorized = readJson(
    `framework/agent-work/fixtures/${authorizedPath}`,
  );
  const denied = readJson(`framework/agent-work/fixtures/${deniedPath}`);

  assert.equal(
    authorized.atlases[0].contextPayloadRoot,
    denied.atlases[0].contextPayloadRoot,
  );
  assert.equal(
    authorized.actionBindings[0].candidateAction,
    denied.actionBindings[0].candidateAction,
  );
  assert.equal(authorized.actionBindings[0].decision, 'valid');
  assert.equal(denied.actionBindings[0].decision, 'denied');
  assert.equal(validateAgentWorkProfile(contract, authorized).ok, true);
  assert.equal(validateAgentWorkProfile(contract, denied).ok, true);
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
    Array.from({ length: 10 }, (_, index) => `FO${index + 1}`),
  );
  assert.equal(contract.relations.cardinality, 'many-to-many');
  assert.equal(contract.relations.inheritance, 'none');
  assert.deepEqual(Object.keys(contract.roleStateMachines), [
    'pursuit',
    'atlas',
    'warrant',
  ]);
  assert.match(
    contract.roleStateMachines.warrant.rule,
    /cannot amplify action, resource, target, time, or consequence scope/,
  );
});

test('separates continuity smoke, comparison, and public projection evidence', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => Number.isFinite(Date.parse(value)),
  });
  const validate = ajv.compile(contract.continuityValidation.evidenceSchema);
  const resolved = new Map();

  for (const fixture of continuityFixtures.cases) {
    let evidence;
    if (fixture.evidence) {
      evidence = structuredClone(fixture.evidence);
    } else {
      const source = resolved.get(fixture.copyFrom);
      assert.ok(source, `${fixture.id} must reference an earlier fixture`);
      evidence = structuredClone(source);
      for (const [key, value] of Object.entries(fixture.patch ?? {}))
        evidence[key] = value;
      for (const key of fixture.remove ?? []) delete evidence[key];
    }
    resolved.set(fixture.id, evidence);
    assert.equal(
      validate(evidence),
      fixture.ok,
      `${fixture.id}: ${JSON.stringify(validate.errors)}`,
    );
  }

  assert.equal(
    contract.continuityValidation.publicOutcome,
    'Keep the work when the chat ends.',
  );
  assert.match(contract.continuityValidation.firstContactRule, /not first-use/);
  assert.match(
    contract.continuityValidation.releaseClaimPolicy.buildchainRole,
    /does not invent benchmark meaning, upgrade a verdict, or infer a stronger claim/,
  );
  assert.match(
    contract.continuityValidation.releaseClaimPolicy.ordinaryPatchRule,
    /does not repeat the matched long-task comparison/,
  );
  assert.equal(
    contract.continuityValidation.pilotProtocol.command,
    './shifu qualify:continuity-pilot -- --output <disposable-output>',
  );
  assert.equal(
    contract.continuityValidation.pilotProtocol.documentation,
    'docs/qualification/continuity-pilot.md',
  );
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
  const adr = read('docs/adr/KF-ADR-019f86da-4f90-786d-aa24-a97705e13917.md');
  const map = read('docs/MAP.md');
  for (const text of [human, adr, map]) {
    assert.match(text, /kungfu agent work-model --json/);
  }
  assert.match(
    human,
    /framework\/agent-work\/kungfu-agent-work-state\.contract\.json/,
  );
  assert.match(human, /Keep the work when the chat ends\./);
  assert.match(human, /does not pass `FO10`/);

  const releaseGate = read('docs/qualification/gates/release-and-promotion.md');
  assert.match(releaseGate, /matched long-task comparison/);
  assert.match(releaseGate, /ordinary patch release/);
});
