// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classify,
  hasGeneratedProvenance,
  ownerFor,
  percentile,
  regressionIssues,
  validWaiverFor,
  validateMeasured,
  waiverIssues,
} from './code-complexity-budget.mjs';

const bytes = (value = '') => Buffer.from(value);
const handwritten = (path, lines, owner = 'shifu/source-tooling') => ({
  path,
  class: 'first-party-handwritten-implementation',
  generatedProvenance: false,
  language: 'javascript-typescript',
  owner,
  lines,
});
const groups = {
  'first-party-handwritten-implementation:javascript-typescript': {
    hard: 100,
  },
  'generated-projection:javascript-typescript': { hard: 100 },
};

test('classification order covers every declared source class', () => {
  assert.equal(
    classify('.kungfu/episodes/sealed/x/manifest.json', bytes()),
    'retained-evidence',
  );
  assert.equal(
    classify('framework/core/.deps/vendor.cc', bytes()),
    'vendored-source',
  );
  assert.equal(
    classify(
      'src/generated/model.ts',
      bytes('// @generated source: schema/model.fbs'),
    ),
    'generated-projection',
  );
  assert.equal(classify('scripts/tool.test.mjs', bytes()), 'test-or-fixture');
  assert.equal(
    classify('framework/policy.json', bytes()),
    'declarative-schema-or-table',
  );
  assert.equal(
    classify('framework/demo/include/api.hpp', bytes()),
    'public-header-or-entrypoint',
  );
  assert.equal(
    classify('scripts/tool.mjs', bytes('const value = 1;')),
    'first-party-handwritten-implementation',
  );
});

test('generated projection requires a file-header provenance marker', () => {
  assert.equal(
    hasGeneratedProvenance(
      'src/generated/model.ts',
      bytes('// @generated source: schema/model.fbs'),
    ),
    true,
  );
  assert.equal(
    hasGeneratedProvenance(
      'src/generated/model.ts',
      bytes('// generated file\nconst source = "hidden";'),
    ),
    false,
  );
  assert.equal(
    classify(
      'scripts/check.mjs',
      bytes('const marker = /generated file|do not edit/u;'),
    ),
    'first-party-handwritten-implementation',
  );
});

test('calibration percentile and owner routes are deterministic', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(
    ownerFor('scripts/tool.mjs', { components: [] }),
    'shifu/source-tooling',
  );
  assert.equal(
    ownerFor('biome.json', { components: [] }),
    'kungfu/repository-contract',
  );
  assert.equal(
    ownerFor('.kungfu/project-cuts/sha256/x/manifest.json', { components: [] }),
    'kungfu/retained-native-evidence',
  );
});

test('P1 ratchet blocks new oversize, threshold crossing, and hotspot growth', () => {
  const baseline = {
    groups,
    files: [
      handwritten('scripts/within.mjs', 90),
      handwritten('scripts/debt.mjs', 120),
    ],
  };
  const issues = regressionIssues(
    [
      handwritten('scripts/within.mjs', 101),
      handwritten('scripts/debt.mjs', 121),
      handwritten('scripts/new.mjs', 101),
    ],
    baseline,
  );
  assert.deepEqual(issues.map((issue) => issue.code).sort(), [
    'existing-file-crossed-hard-budget',
    'grandfathered-file-grew',
    'new-handwritten-file-over-hard-budget',
  ]);
});

test('anti-gaming rejects helper proliferation and generated laundering', () => {
  const files = [
    ...['a', 'b', 'c', 'd'].map((name) =>
      handwritten(`scripts/${name}.mjs`, 10),
    ),
    {
      path: 'src/generated/hidden.ts',
      class: 'generated-projection',
      generatedProvenance: false,
      language: 'javascript-typescript',
      owner: 'framework/demo',
      lines: 10,
    },
  ];
  const issues = regressionIssues(
    files,
    { groups, files: [] },
    {
      antiGaming: {
        maxNewHandwrittenFilesPerOwner: 3,
        newGeneratedProjectionRequiresProvenance: true,
      },
    },
  );
  assert.ok(issues.some((issue) => issue.code === 'new-helper-proliferation'));
  assert.ok(
    issues.some((issue) => issue.code === 'unproven-generated-projection'),
  );
});

test('unknown classification or owner fails closed', () => {
  const issues = validateMeasured([
    { path: 'mystery', class: '', owner: '', lines: 1 },
  ]);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['unknown-classification', 'unknown-owner'],
  );
});

test('waivers require independent, current, exact, non-reusable approval', () => {
  const requiredFields = [
    'schema',
    'paths_or_scope',
    'file_class',
    'baseline_measurement',
    'requested_measurement',
    'allowed_delta',
    'owner',
    'responsibility_boundary',
    'cohesion_rationale',
    'rejected_split_alternatives',
    'affected_tests_and_qualification',
    'requested_by',
    'approved_by',
    'approved_at',
    'expires_at_or_review_by',
    'retirement_or_decomposition_ref',
  ];
  const policy = {
    waiver: {
      schema: 'kungfu.code-complexity-budget-waiver/v1',
      requiredFields,
    },
  };
  const value = {
    schema: policy.waiver.schema,
    paths_or_scope: ['scripts/debt.mjs'],
    file_class: 'first-party-handwritten-implementation',
    baseline_measurement: 120,
    requested_measurement: 125,
    allowed_delta: 5,
    owner: 'shifu/source-tooling',
    responsibility_boundary: 'one bounded compatibility adapter',
    cohesion_rationale: 'the adapter must remain atomic',
    rejected_split_alternatives: ['split would duplicate ordering'],
    affected_tests_and_qualification: ['scripts/debt.test.mjs'],
    requested_by: 'author',
    approved_by: 'independent-reviewer',
    approved_at: '2098-01-01T00:00:00Z',
    expires_at_or_review_by: '2099-01-01T00:00:00Z',
    retirement_or_decomposition_ref: 'issue-123',
  };
  const record = { file: 'waiver.json', value };
  const current = handwritten('scripts/debt.mjs', 125);
  const issue = { path: current.path };
  assert.deepEqual(waiverIssues(record, policy), []);
  assert.equal(validWaiverFor(issue, current, [record], policy), 'waiver.json');
  assert.equal(
    validWaiverFor(
      issue,
      { ...current, path: 'scripts/other.mjs' },
      [record],
      policy,
    ),
    '',
  );
  assert.equal(
    validWaiverFor(issue, { ...current, lines: 126 }, [record], policy),
    '',
  );
  assert.ok(
    waiverIssues(
      { file: 'self.json', value: { ...value, approved_by: 'author' } },
      policy,
    ).some((item) => item.code === 'self-approved-waiver'),
  );
  assert.ok(
    waiverIssues(
      {
        file: 'expired.json',
        value: { ...value, expires_at_or_review_by: '2020-01-01T00:00:00Z' },
      },
      policy,
    ).some((item) => item.code === 'expired-waiver'),
  );
});
