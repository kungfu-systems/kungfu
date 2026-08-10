// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(read(path));

const contractPath =
  'framework/release/kungfu-release-provenance.contract.json';
const artifactPath = 'config/release/kungfu-release-provenance.contract.json';
const contract = readJson(contractPath);

test('release provenance is a welded KFR2 semantic contract', () => {
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.rootProtocol, 'kungfu.fact-root.canonical/v2');
  assert.equal(contract.dualWrite.publicationAuthority, false);
  assert.deepEqual(
    new Set(contract.envelopes.requiredRelations),
    new Set([
      'derived-from',
      'acknowledges',
      'qualified-by',
      'authorized-by',
      'implements-contract',
      'projected-as',
    ]),
  );
  assert.equal(read(contractPath), read(artifactPath));

  const sourceRegistry = readJson(
    'framework/contract/kungfu-contracts.registry.json',
  );
  const runtimeRegistry = readJson('config/kungfu-contracts.registry.json');
  assert.deepEqual(sourceRegistry, runtimeRegistry);
  const factContract = sourceRegistry.contracts.find(
    ({ id }) => id === 'kungfu-fact-cut-kernel',
  );
  assert.ok(
    factContract.extraArtifacts.some(
      ({ source, artifact }) =>
        source === contractPath && artifact === artifactPath,
    ),
  );
});

test('candidate and promotion flows dual-write and retain rooted evidence', () => {
  const candidate = read('.github/workflows/dev-alpha-candidate-patrol.yml');
  const promotion = read('.github/workflows/release-new-version.yml');

  assert.match(candidate, /release-provenance-object\.py candidate/);
  assert.match(candidate, /release-provenance-object\.py verify/);
  assert.match(candidate, /release-provenance-candidate-/);
  assert.match(candidate, /priorStateRoot/);
  assert.match(
    candidate,
    /--candidate-id "release-candidate:\$RELEASE_ID:\$QUALIFICATION_STATE_ROOT"/,
  );
  assert.match(
    candidate,
    /--dev-cut-id "release-cut:\$RELEASE_ID:development:\$QUALIFICATION_STATE_ROOT"/,
  );
  assert.match(
    candidate,
    /--previous-alpha-id "release-cut:\$RELEASE_ID:previous-alpha:\$QUALIFICATION_STATE_ROOT"/,
  );

  assert.match(promotion, /release-provenance-object\.py candidate/);
  assert.match(promotion, /release-provenance-object\.py promotion/);
  assert.match(promotion, /release-provenance-object\.py verify/);
  assert.match(promotion, /candidate-provenance-root/);
  assert.match(promotion, /promotion-provenance-root/);
  assert.match(promotion, /release-provenance-promotion-/);
  assert.match(promotion, /candidate_ancestry_observed=false/);
  assert.match(
    promotion,
    /--candidate-id "release-candidate:\$RELEASE_ID:\$PREFLIGHT_RECEIPT_ROOT"/,
  );
  assert.match(
    promotion,
    /--dev-cut-id "release-cut:\$RELEASE_ID:development:\$PREFLIGHT_RECEIPT_ROOT"/,
  );
  assert.match(
    promotion,
    /--previous-alpha-id "release-cut:\$RELEASE_ID:previous-alpha:\$PREFLIGHT_RECEIPT_ROOT"/,
  );
  assert.match(
    promotion,
    /--promotion-id "release-promotion:\$\{\{ inputs\.target-ref \|\| github\.event\.pull_request\.base\.ref \}\}:\$PREFLIGHT_RECEIPT_ROOT"/,
  );

  for (const workflow of [candidate, promotion]) {
    assert.doesNotMatch(workflow, /release-provenance-object\.py publication/);
    assert.doesNotMatch(
      workflow,
      /--candidate-id "\$(?:candidate_sha|CANDIDATE_SHA)"/,
    );
    assert.doesNotMatch(
      workflow,
      /--dev-cut-id [^\n]*(?:SELECTED_SHA|dev_cut_sha)/,
    );
    assert.doesNotMatch(
      workflow,
      /--previous-alpha-id [^\n]*(?:previous_alpha_sha|PREVIOUS_ALPHA_SHA)/,
    );
  }
});

test('the package gate and source gate execute release provenance checks', () => {
  const scripts = readJson('package.json').scripts;
  assert.match(
    scripts['check:release-provenance-object'],
    /check-release-provenance-object\.test\.mjs/,
  );
  const sourceAcceptance = read('scripts/source-acceptance.mjs');
  assert.match(sourceAcceptance, /check-release-provenance-object\.test\.mjs/);
});
