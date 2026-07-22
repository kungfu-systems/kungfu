// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyPrecondition,
  classifyRecovery,
  validateEnvelope,
} from './action-loop.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  fs.readFileSync(path.join(DIR, 'action-loop.contract.json'), 'utf8'),
);
const fixtures = JSON.parse(
  fs.readFileSync(path.join(DIR, 'action-loop-fixtures.json'), 'utf8'),
);
const orderedStepIds = contract.orderedSteps.map(({ id }) => id);

function envelope(state, acceptedSteps = []) {
  return {
    schema: contract.envelope.schema,
    loopId: 'loop:source-dogfood',
    loopRoot: fixtures.roots.loop,
    idempotencyKey: 'action-loop-source-dogfood-v0',
    state,
    roles: {
      pursuit: {
        id: 'pursuit:go',
        root: fixtures.roots.pursuit,
        state: 'active',
      },
      atlas: {
        id: 'atlas:xinfa',
        root: fixtures.roots.atlas,
        state: 'current',
      },
      warrant: {
        id: 'warrant:bounded',
        root: fixtures.roots.warrant,
        state: 'issued',
      },
      episode: {
        id: 'episode:runtime',
        root: ['planned', 'bound', 'running'].includes(state)
          ? null
          : fixtures.roots.episode,
        state:
          state === 'episode-sealed' ||
          orderedStepIds.indexOf(acceptedSteps.at(-1)) >= 2
            ? 'sealed'
            : 'open',
      },
      fact: { id: 'fact:ref', root: fixtures.roots.fact, state: 'declared' },
    },
    factRef: {
      name: 'action-loop/source-dogfood',
      cutRoot: fixtures.roots.fact,
      revision: 1,
    },
    acceptedSteps,
    residualRisk: [],
  };
}

function receipt(loopEnvelope, stepId, ordinal) {
  const hex = (ordinal + 1).toString(16).padStart(64, '0');
  return {
    schema: contract.stepReceipt.schema,
    loopId: loopEnvelope.loopId,
    stepId,
    idempotencyKey: loopEnvelope.idempotencyKey,
    receiptRoot: `sha256:${hex}`,
    status: 'accepted',
    preconditionRoots: [fixtures.roots.loop],
    resultRoots: [fixtures.roots.fact],
  };
}

test('contract preserves five explicit roles and one authority boundary', () => {
  assert.equal(contract.publicNamingFrozen, false);
  assert.deepEqual(
    contract.roles.map(({ id }) => id),
    ['pursuit', 'atlas', 'warrant', 'episode', 'fact'],
  );
  assert.deepEqual(
    contract.orderedSteps.map(({ from, to }) => [from, to]),
    [
      ['planned', 'bound'],
      ['bound', 'running'],
      ['running', 'episode-sealed'],
      ['episode-sealed', 'atlas-refreshed'],
      ['atlas-refreshed', 'reviewed'],
      ['reviewed', 'settled'],
    ],
  );
  assert.ok(contract.ownership.forbidden.some((row) => /mints Fact/.test(row)));
  assert.ok(contract.nonClaims.some((row) => /does not qualify P17/.test(row)));
});

test('deterministic recovery fixtures classify the next safe step', () => {
  for (const fixture of fixtures.recoveryCases) {
    const loopEnvelope = envelope(fixture.state, fixture.acceptedSteps);
    const receipts = fixture.acceptedSteps.map((stepId, index) =>
      receipt(loopEnvelope, stepId, orderedStepIds.indexOf(stepId)),
    );
    const actual = classifyRecovery(contract, loopEnvelope, receipts);
    assert.equal(actual.ok, fixture.expected.ok, fixture.id);
    assert.equal(actual.code, fixture.expected.code, fixture.id);
    if (Object.hasOwn(fixture.expected, 'nextStep'))
      assert.equal(actual.nextStep, fixture.expected.nextStep, fixture.id);
  }
});

test('same accepted settle receipt is reuse but a conflicting receipt is refused', () => {
  const loopEnvelope = envelope('settled', orderedStepIds);
  const receipts = orderedStepIds.map((stepId, index) =>
    receipt(loopEnvelope, stepId, index),
  );
  receipts.push({ ...receipts.at(-1) });
  assert.equal(
    classifyRecovery(contract, loopEnvelope, receipts).code,
    'already-settled',
  );
  receipts.at(-1).receiptRoot = `sha256:${'9'.repeat(64)}`;
  assert.equal(
    classifyRecovery(contract, loopEnvelope, receipts).code,
    'idempotency-conflict',
  );
});

test('stale authority and external uncertainty fail with stable typed results', () => {
  const loopEnvelope = envelope('running', ['bind-roles', 'open-episode']);
  for (const fixture of fixtures.preconditionCases) {
    const actual = classifyPrecondition(loopEnvelope, fixture.observation);
    assert.equal(actual.ok, false, fixture.id);
    assert.equal(actual.code, fixture.expectedCode, fixture.id);
  }
});

test('missing roles and sealed Episode roots cannot be synthesized', () => {
  const missing = envelope('running', ['bind-roles', 'open-episode']);
  missing.roles.warrant = undefined;
  assert.equal(validateEnvelope(contract, missing).code, 'missing-role');

  const sealed = envelope('episode-sealed', [
    'bind-roles',
    'open-episode',
    'seal-episode',
  ]);
  sealed.roles.episode.root = null;
  assert.equal(validateEnvelope(contract, sealed).code, 'invalid-root');
});

test('fault matrix covers every accepted state boundary and external uncertainty', () => {
  const declared = new Map(contract.faultMatrix.map((row) => [row.after, row]));
  for (const step of contract.orderedSteps) {
    assert.equal(declared.get(step.id).observedState, step.to);
  }
  assert.equal(
    declared.get('external-effect-before-receipt').recovery,
    'external-effect-unknown',
  );
  assert.equal(declared.get('stale-fact-cas').recovery, 'stale-ref');
});
