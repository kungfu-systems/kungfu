import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  semanticRoot,
  validateAgentConsoleEnvelope,
  validateRuntimeProfile,
  validateWorkRef,
} from '../src/session-contract.mjs';

const fixture = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/agent-session-core-golden.json', import.meta.url),
    'utf8',
  ),
);
const schema = JSON.parse(
  fs.readFileSync(
    new URL('../schemas/agent-session-core.schema.json', import.meta.url),
    'utf8',
  ),
);

test('canonical Agent Session schema and Node validators share golden roots', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schema);
  const workRefSchema = ajv.getSchema(`${schema.$id}#/$defs/workRef`);
  const envelopeSchema = ajv.getSchema(
    `${schema.$id}#/$defs/agentConsoleEnvelope`,
  );
  const runtimeProfileSchema = ajv.getSchema(
    `${schema.$id}#/$defs/runtimeProfile`,
  );
  const envelope = {
    ...fixture.envelopeBody,
    envelopeRoot: fixture.envelopeRoot,
  };

  assert.equal(workRefSchema(fixture.workRef), true, workRefSchema.errors);
  assert.equal(envelopeSchema(envelope), true, envelopeSchema.errors);
  assert.equal(semanticRoot(fixture.workRef), fixture.workRefRoot);
  assert.equal(semanticRoot(fixture.envelopeBody), fixture.envelopeRoot);
  assert.deepEqual(validateWorkRef(fixture.workRef), fixture.workRef);
  assert.deepEqual(validateAgentConsoleEnvelope(envelope), envelope);
  for (const profile of fixture.runtimeProfiles) {
    assert.equal(
      runtimeProfileSchema(profile),
      true,
      runtimeProfileSchema.errors,
    );
    assert.deepEqual(validateRuntimeProfile(profile), profile);
  }
});

test('strict writers reject ambiguous or extended values', () => {
  const legacy = structuredClone(fixture.workRef);
  Reflect.deleteProperty(legacy, 'initiativeId');
  assert.throws(() => validateWorkRef(legacy), /initiativeId/u);
  assert.deepEqual(validateWorkRef(legacy, { compatibility: true }), legacy);

  const extended = { ...fixture.workRef, privateLocator: '/tmp/authority' };
  assert.throws(() => validateWorkRef(extended), /unknown privateLocator/u);

  const envelope = {
    ...fixture.envelopeBody,
    runtimeRouting: { controlRuntimeDir: '/stale' },
    envelopeRoot: fixture.envelopeRoot,
  };
  assert.throws(
    () => validateAgentConsoleEnvelope(envelope),
    /unknown runtimeRouting/u,
  );

  const profile = structuredClone(fixture.runtimeProfiles[1]);
  profile.bootstrap.adapter = 'codex';
  assert.throws(() => validateRuntimeProfile(profile), /must match provider/u);
});

test('Agent Console carries only a bounded read-only Skill runtime pointer', () => {
  const body = {
    ...fixture.envelopeBody,
    skillRuntimeAudit: {
      schema: 'kungfu.skill-runtime-audit-pointer/v1',
      path: '/runtime/skill-manager/agent-console-attempt.json',
      runtimeAuditRoot: `sha256:${'1'.repeat(64)}`,
      registryStateRoot: `sha256:${'2'.repeat(64)}`,
      historyRoot: `sha256:${'3'.repeat(64)}`,
      diagnosisRoot: `sha256:${'4'.repeat(64)}`,
      authority: 'read-only-projection',
    },
  };
  const envelope = { ...body, envelopeRoot: semanticRoot(body) };

  assert.deepEqual(validateAgentConsoleEnvelope(envelope), envelope);
  assert.throws(
    () =>
      validateAgentConsoleEnvelope({
        ...envelope,
        skillRuntimeAudit: {
          ...envelope.skillRuntimeAudit,
          authority: 'agent-writer',
        },
      }),
    /read-only-projection/u,
  );
});
