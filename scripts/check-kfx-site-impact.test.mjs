// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  KfxSiteImpactError,
  assertContractNotWeakened,
  changeBinding,
  createNoPublicChangeProof,
  evaluateKfxSiteImpact,
  repositoryChanges,
  validateImpactContract,
} from '../framework/site/tooling/check-kfx-site-impact.mjs';
import { sourceAcceptancePlan } from './source-acceptance.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const declaration = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'framework/site/src/kfx-site-bundle.source.json'),
    'utf8',
  ),
);
const contract = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'framework/site/src/kfx-site-impact.contract.json'),
    'utf8',
  ),
);
const BASE = 'a'.repeat(40);

function clone(value) {
  return structuredClone(value);
}

function change(relativePath, content = relativePath, status = 'modified') {
  return {
    path: relativePath,
    status,
    baseContentRoot: `sha256:${'1'.repeat(64)}`,
    contentRoot: `sha256:${Buffer.from(content).toString('hex').padEnd(64, '0').slice(0, 64)}`,
  };
}

function evaluate(overrides = {}) {
  return evaluateKfxSiteImpact({
    contract: overrides.contract || clone(contract),
    baseContract:
      overrides.baseContract === undefined
        ? clone(contract)
        : overrides.baseContract,
    declaration: overrides.declaration || clone(declaration),
    baseDeclaration: overrides.baseDeclaration || clone(declaration),
    baseRevision: overrides.baseRevision || BASE,
    changes: overrides.changes || [],
    proofs: overrides.proofs || [],
    refreshStaleProofs: overrides.refreshStaleProofs || false,
  });
}

function assertCode(code, operation) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof KfxSiteImpactError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function updateFacets(ids) {
  const current = clone(declaration);
  for (const facet of current.facets) {
    if (ids.includes(facet.id)) facet.summary = `${facet.summary} Reviewed.`;
  }
  return current;
}

test('repository changes ignore net-zero paths from union inventories', () => {
  const exactSource = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  assert.deepEqual(repositoryChanges(exactSource, ['AGENTS.md']), []);
  assert.deepEqual(
    repositoryChanges(exactSource, ['.nonexistent-kfx-union-path']),
    [],
  );
});

test('ignores changes outside KFX ownership', () => {
  assert.equal(
    evaluate({ changes: [change('framework/site/README.md')] }).status,
    'passing',
  );
});

test('source acceptance keeps deleted KFX paths impact-visible', () => {
  const deleted = 'extensions/example/src/kfx-deleted.ts';
  const plan = sourceAcceptancePlan([deleted], '', [deleted]);
  const impact = plan.find(
    (step) => step.label === 'KFX Site Bundle impact dispositions',
  );
  assert.ok(impact?.args.includes(deleted));
  assert.ok(
    !plan.some((step) => step.label === 'changed web source format and lint'),
  );
});

test('fails closed for an unmapped KFX-owned path', () => {
  assertCode('KFX_SITE_BUNDLE_IMPACT_UNMAPPED', () =>
    evaluate({ changes: [change('framework/new/kfx-engine.ts')] }),
  );
});

test('requires semantic updates for public KFX SDK changes', () => {
  assertCode('KFX_SITE_BUNDLE_UPDATE_REQUIRED', () =>
    evaluate({ changes: [change('framework/kfx/src/index.ts')] }),
  );
});

test('accepts meaningful facet declaration updates for public KFX changes', () => {
  const current = updateFacets([
    'architecture',
    'package-facets',
    'capabilities',
    'sdk-cli',
  ]);
  const result = evaluate({
    declaration: current,
    changes: [
      change('framework/kfx/src/index.ts'),
      change('framework/site/src/kfx-site-bundle.source.json'),
    ],
  });
  assert.equal(result.status, 'passing');
  assert.deepEqual(result.unresolvedFacets, []);
});

test('treats an updated bound source as the semantic Site Bundle update', () => {
  const result = evaluate({
    changes: [change('framework/kfx/kungfu-kfx.contract.json')],
  });
  assert.equal(result.status, 'passing');
  assert.deepEqual(result.semanticFacets, [
    'capabilities',
    'package-facets',
    'sdk-cli',
  ]);
});

test('accepts an exact content-addressed proof for eligible internal changes', () => {
  const changes = [
    change('framework/core/src/libkungfu/src/runtime/kfx/native_registry.cpp'),
  ];
  const facets = [
    'architecture',
    'capabilities',
    'registry-admission-lifecycle',
  ];
  const proof = createNoPublicChangeProof(
    changeBinding(BASE, changes, facets),
    'The refactor preserves every public contract and reader journey while changing only internal allocation order.',
  );
  const result = evaluate({
    changes: [
      ...changes,
      change(
        `framework/site/src/kfx-site-impact-proofs/${proof.proofRoot.slice(7)}.json`,
      ),
    ],
    proofs: [
      {
        path: `framework/site/src/kfx-site-impact-proofs/${proof.proofRoot.slice(7)}.json`,
        proof,
      },
    ],
  });
  assert.equal(result.proof, proof.proofRoot);
});

test('rejects stale proof roots and changed-path omissions', () => {
  const original = [
    change('framework/core/src/libkungfu/src/runtime/kfx/native_registry.cpp'),
  ];
  const facets = [
    'architecture',
    'capabilities',
    'registry-admission-lifecycle',
  ];
  const proof = createNoPublicChangeProof(
    changeBinding(BASE, original, facets),
    'The refactor preserves every public contract and reader journey while changing only internal allocation order.',
  );
  assertCode('KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID', () =>
    evaluate({
      changes: [
        ...original,
        change('README.md', 'an omitted change'),
        change(
          `framework/site/src/kfx-site-impact-proofs/${proof.proofRoot.slice(7)}.json`,
        ),
      ],
      proofs: [
        {
          path: `framework/site/src/kfx-site-impact-proofs/${proof.proofRoot.slice(7)}.json`,
          proof,
        },
      ],
    }),
  );
});

test('explicit proof refresh replaces stale proof candidates', () => {
  const changes = [
    change('framework/core/src/libkungfu/src/runtime/kfx/native_registry.cpp'),
  ];
  const facets = [
    'architecture',
    'capabilities',
    'registry-admission-lifecycle',
  ];
  const staleChanges = [...changes, change('README.md', 'stale path')];
  const staleProof = createNoPublicChangeProof(
    changeBinding(BASE, staleChanges, facets),
    'The previous refactor preserved public behavior but binds a superseded exact changed-path set.',
  );
  assertCode('KFX_SITE_BUNDLE_UPDATE_REQUIRED', () =>
    evaluate({
      changes,
      proofs: [
        {
          path: `framework/site/src/kfx-site-impact-proofs/${staleProof.proofRoot.slice(7)}.json`,
          proof: staleProof,
        },
      ],
      refreshStaleProofs: true,
    }),
  );
});

test('never accepts proof evidence for public KFX surfaces', () => {
  const changes = [change('framework/kfx/src/index.ts')];
  const proof = createNoPublicChangeProof(
    changeBinding(BASE, changes, ['package-facets', 'capabilities', 'sdk-cli']),
    'The implementation claims no public change even though this fixture touches a public exported contract surface.',
  );
  assertCode('KFX_SITE_BUNDLE_UPDATE_REQUIRED', () =>
    evaluate({
      changes,
      proofs: [{ path: `${proof.proofRoot.slice(7)}.json`, proof }],
    }),
  );
});

test('rejects generic proof rationales and proof-only mutations', () => {
  const binding = changeBinding(
    BASE,
    [
      change(
        'framework/core/src/libkungfu/src/runtime/kfx/native_registry.cpp',
      ),
    ],
    ['architecture'],
  );
  assertCode('KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID', () =>
    createNoPublicChangeProof(binding, 'internal only'),
  );
  assertCode('KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID', () =>
    evaluate({
      changes: [
        change(
          `framework/site/src/kfx-site-impact-proofs/${'2'.repeat(64)}.json`,
        ),
      ],
    }),
  );
});

test('semantic JSON no-ops do not satisfy public impact', () => {
  assertCode('KFX_SITE_BUNDLE_UPDATE_REQUIRED', () =>
    evaluate({
      declaration: clone(declaration),
      changes: [
        change('framework/kfx/src/index.ts'),
        change('framework/site/src/kfx-site-bundle.source.json'),
      ],
    }),
  );
});

test('same-change contract edits cannot widen exclusions or waivers', () => {
  const weakened = clone(contract);
  weakened.ownership.excludedSelectors.push({
    kind: 'prefix',
    value: 'framework/kfx/',
  });
  assertCode('KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED', () =>
    assertContractNotWeakened(contract, weakened),
  );
  const weakenedRule = clone(contract);
  weakenedRule.impactRules.find(
    ({ id }) => id === 'public-typescript-sdk',
  ).disposition = 'proof-eligible';
  assertCode('KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED', () =>
    assertContractNotWeakened(contract, weakenedRule),
  );
});

test('contract validation rejects unknown facets', () => {
  const invalid = clone(contract);
  invalid.impactRules[0].facets.push('not-a-site-facet');
  assertCode('KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID', () =>
    validateImpactContract(invalid, declaration),
  );
});
