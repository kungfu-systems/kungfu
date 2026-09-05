// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { activeProjection } from '../product/version-line/version-line-authority.mjs';
import {
  compareRuleset,
  digest,
  normalizeRuleset,
  validateContract,
} from './alpha-ruleset.mjs';

const contractPath = path.join(
  process.cwd(),
  'docs/qualification/alpha-ruleset.contract.json',
);
const stableContractPath = path.join(
  process.cwd(),
  'docs/qualification/stable-ruleset.contract.json',
);

function contract(file = contractPath) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('checked-in Alpha ruleset contract is exact-target and root-bound', () => {
  const value = contract();
  assert.equal(validateContract(value), value);
  assert.equal(value.ruleset.bypass_actors.length, 0);
  assert.deepEqual(
    normalizeRuleset(value.ruleset).rules.map(({ type }) => type),
    ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'],
  );
});

test('checked-in Stable ruleset contract reuses exact-target fail-closed governance', () => {
  const value = contract(stableContractPath);
  assert.equal(validateContract(value), value);
  assert.equal(value.targetRef, activeProjection().line.branches.stable);
  assert.equal(value.ruleset.bypass_actors.length, 0);
  assert.equal(compareRuleset(value, []).status, 'missing');
  assert.equal(compareRuleset(value, [value.ruleset]).status, 'matching');
});

test('missing and ambiguous exact-target rulesets fail closed', () => {
  const value = contract();
  assert.equal(compareRuleset(value, []).status, 'missing');
  assert.equal(
    compareRuleset(value, [value.ruleset, structuredClone(value.ruleset)])
      .status,
    'ambiguous',
  );
});

test('bypass, stale review, deletion, and required-check drift are detected', () => {
  const value = contract();
  const mutations = [
    (ruleset) =>
      ruleset.bypass_actors.push({
        actor_id: 1,
        actor_type: 'OrganizationAdmin',
        bypass_mode: 'always',
      }),
    (ruleset) => {
      ruleset.rules.find(
        ({ type }) => type === 'pull_request',
      ).parameters.dismiss_stale_reviews_on_push = false;
    },
    (ruleset) => {
      ruleset.rules = ruleset.rules.filter(({ type }) => type !== 'deletion');
    },
    (ruleset) => {
      ruleset.rules
        .find(({ type }) => type === 'required_status_checks')
        .parameters.required_status_checks.pop();
    },
  ];
  for (const mutate of mutations) {
    const drifted = structuredClone(value.ruleset);
    mutate(drifted);
    const result = compareRuleset(value, [drifted]);
    assert.equal(result.status, 'drifted');
    assert.equal(result.qualifying, false);
  }
});

test('contract tampering is rejected even when the desired rules look stronger', () => {
  const value = contract();
  value.ruleset.rules.push({ type: 'creation' });
  assert.throws(() => validateContract(value), /contract root mismatch/u);
  const { contractRoot: ignored, ...body } = value;
  value.contractRoot = digest(body);
  assert.equal(validateContract(value), value);
});
