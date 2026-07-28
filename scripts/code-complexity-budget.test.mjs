// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import {
  baselineIntegrityIssues,
  baselineMeasurementRoot,
  baselineTransitionAuthorization,
  digest,
  enrichIssue,
  protectedBaselineIssues,
  waiverAuthorization,
} from '../framework/maintainability/complexity-governance.mjs';
import {
  classify,
  hasGeneratedProvenance,
  ownerFor,
  percentile,
  protectedBaselineCandidates,
  regressionIssues,
  renameHistoryMap,
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
  contentRoot: digest({ path, lines, owner }),
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

test('protected baseline follows admitted dev authority without origin HEAD', () => {
  const policy = {
    baselineGovernance: {
      protectedRef: 'origin/HEAD',
      protectedRefEnv: 'KUNGFU_COMPLEXITY_PROTECTED_REF',
    },
  };
  assert.deepEqual(
    protectedBaselineCandidates(
      policy,
      { KUNGFU_DEV_BRANCH: 'dev/v10/v10.2' },
      { symbolicRemoteHead: () => '' },
    ),
    ['origin/dev/v10/v10.2', 'dev/v10/v10.2', 'origin/HEAD'],
  );
  assert.deepEqual(
    protectedBaselineCandidates(policy, {
      KUNGFU_COMPLEXITY_PROTECTED_REF: 'protected-snapshot',
    }),
    ['protected-snapshot'],
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

test('anti-gaming rejects relabeling, responsibility splits, and re-added debt', () => {
  const deleted = handwritten('scripts/hotspot.mjs', 120);
  const generated = {
    ...handwritten('scripts/generated/hotspot.mjs', 70),
    class: 'generated-projection',
    generatedProvenance: true,
  };
  const split = [
    handwritten('scripts/hotspot-reader.mjs', 50),
    handwritten('scripts/hotspot-writer.mjs', 50),
  ];
  const policy = {
    antiGaming: {
      maxNewHandwrittenFilesPerOwner: 3,
      newGeneratedProjectionRequiresProvenance: true,
    },
  };
  const replacementCodes = regressionIssues(
    [generated, ...split],
    { groups, files: [deleted] },
    policy,
  ).map((issue) => issue.code);
  assert.ok(replacementCodes.includes('generated-or-vendor-laundering'));
  assert.ok(replacementCodes.includes('responsibility-preserving-split'));

  const relabeledCodes = regressionIssues(
    [{ ...deleted, class: 'generated-projection' }],
    { groups, files: [deleted] },
    policy,
  ).map((issue) => issue.code);
  assert.ok(relabeledCodes.includes('classification-or-owner-relabeled'));

  const readdedCodes = regressionIssues(
    [{ ...deleted, lines: 121, contentRoot: digest('re-added') }],
    { groups, files: [deleted] },
    policy,
  ).map((issue) => issue.code);
  assert.ok(readdedCodes.includes('grandfathered-file-grew'));
});

test('one-to-one Git renames preserve the old budget without becoming helper splits', () => {
  const deleted = handwritten('scripts/legacy-lab.mjs', 120);
  const renamed = handwritten('scripts/current-lab.mjs', 121);
  const renamedFrom = new Map([
    ['scripts/current-lab.mjs', 'scripts/legacy-lab.mjs'],
  ]);
  const policy = {
    antiGaming: {
      maxNewHandwrittenFilesPerOwner: 3,
      newGeneratedProjectionRequiresProvenance: true,
    },
  };
  const issues = regressionIssues(
    [
      renamed,
      handwritten('scripts/existing-new-helper-a.mjs', 20),
      handwritten('scripts/existing-new-helper-b.mjs', 20),
      handwritten('scripts/existing-new-helper-c.mjs', 20),
    ],
    { groups, files: [deleted] },
    policy,
    renamedFrom,
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['grandfathered-file-grew'],
  );
  assert.deepEqual(issues[0].paths, [
    'scripts/legacy-lab.mjs',
    'scripts/current-lab.mjs',
  ]);
});

test('rename history keeps the baseline identity after the protected head advances', () => {
  assert.deepEqual(
    [
      ...renameHistoryMap(
        [
          'R100\tscripts/qualification-lab.mjs\tscripts/agent-work-lab.mjs',
          'R100\tscripts/agent-work-lab.mjs\tscripts/work-lab.mjs',
        ].join('\n'),
      ),
    ],
    [['scripts/work-lab.mjs', 'scripts/qualification-lab.mjs']],
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

function signedWaiverFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const requiredFields = [
    'schema',
    'issue_root',
    'issue_kind',
    'paths_or_scope',
    'budget_classes',
    'baseline_measurement',
    'current_measurement',
    'allowed_delta',
    'owner',
    'responsibility_boundary',
    'cohesion_rationale',
    'rejected_split_alternatives',
    'affected_tests_and_qualification',
    'requested_by',
    'approval_receipt',
    'retirement_or_decomposition_ref',
  ];
  const policy = {
    status: 'p1-trusted-governance',
    waiver: {
      schema: 'kungfu.code-complexity-budget-waiver/v2',
      approvalReceiptSchema:
        'kungfu.code-complexity-budget-approval-receipt/v1',
      maxApprovalAgeDays: 30,
      trustedAuthorities: [
        {
          authority_id: 'independent-reviewer',
          key_id: 'review-key-1',
          algorithm: 'ed25519',
          public_key_pem: publicKeyPem,
        },
      ],
      requiredFields,
    },
  };
  const baseline = handwritten('scripts/debt.mjs', 120);
  const current = handwritten('scripts/debt.mjs', 125);
  const issue = enrichIssue(
    {
      code: 'grandfathered-file-grew',
      path: current.path,
      paths: [current.path],
    },
    [baseline],
    [current],
  );
  const value = {
    schema: policy.waiver.schema,
    issue_root: issue.issueRoot,
    issue_kind: issue.issueKind,
    paths_or_scope: issue.paths,
    budget_classes: issue.budgetClasses,
    baseline_measurement: issue.baselineMeasurement,
    current_measurement: issue.currentMeasurement,
    allowed_delta: 5,
    owner: 'shifu/source-tooling',
    responsibility_boundary: 'one bounded compatibility adapter',
    cohesion_rationale: 'the adapter must remain atomic',
    rejected_split_alternatives: ['split would duplicate ordering'],
    affected_tests_and_qualification: ['scripts/debt.test.mjs'],
    requested_by: 'author@example.com',
    retirement_or_decomposition_ref: 'issue-123',
    approval_receipt: {
      schema: policy.waiver.approvalReceiptSchema,
      authority_id: 'independent-reviewer',
      key_id: 'review-key-1',
      algorithm: 'ed25519',
      issued_at: '2026-07-26T00:00:00Z',
      approved_at: '2026-07-26T00:01:00Z',
      expires_at: '2026-08-01T00:00:00Z',
      authorization_root: '',
      signature: '',
    },
  };
  const record = { file: 'waiver.json', value };
  value.approval_receipt.authorization_root = digest(
    waiverAuthorization(record, issue, value.requested_by),
  );
  value.approval_receipt.signature = sign(
    null,
    Buffer.from(value.approval_receipt.authorization_root),
    privateKey,
  ).toString('base64');
  return {
    privateKey,
    policy,
    baseline,
    current,
    issue,
    record,
    evaluationTime: new Date('2026-07-27T00:00:00Z'),
  };
}

test('waivers require independent signed exact non-reusable approval', () => {
  const fixture = signedWaiverFixture();
  const context = {
    evaluationTime: fixture.evaluationTime,
    requester: fixture.record.value.requested_by,
    issue: fixture.issue,
  };
  assert.deepEqual(waiverIssues(fixture.record, fixture.policy, context), []);
  assert.equal(
    validWaiverFor(
      fixture.issue,
      fixture.current,
      [fixture.record],
      fixture.policy,
      context,
    ),
    'waiver.json',
  );
  const partialIssue = {
    ...fixture.issue,
    paths: [...fixture.issue.paths, 'scripts/other.mjs'].sort(),
  };
  assert.equal(
    validWaiverFor(
      partialIssue,
      fixture.current,
      [fixture.record],
      fixture.policy,
      { ...context, issue: partialIssue },
    ),
    '',
  );
  const forged = structuredClone(fixture.record);
  forged.value.current_measurement[0].lines += 1;
  assert.equal(
    validWaiverFor(
      fixture.issue,
      fixture.current,
      [forged],
      fixture.policy,
      context,
    ),
    '',
  );
});

test('waiver approval rejects fabricated, unknown, same-authority, and stale receipts', () => {
  const fixture = signedWaiverFixture();
  const context = {
    evaluationTime: fixture.evaluationTime,
    requester: fixture.record.value.requested_by,
    issue: fixture.issue,
  };
  const codes = (record, policy = fixture.policy, localContext = context) =>
    waiverIssues(record, policy, localContext).map((item) => item.code);
  const fabricated = structuredClone(fixture.record);
  fabricated.value.approval_receipt.signature = 'AA==';
  assert.ok(codes(fabricated).includes('invalid-approval-signature'));
  const unknown = structuredClone(fixture.record);
  unknown.value.approval_receipt.key_id = 'unknown';
  assert.ok(codes(unknown).includes('unknown-approval-authority'));
  const samePolicy = structuredClone(fixture.policy);
  samePolicy.waiver.trustedAuthorities[0].authority_id =
    fixture.record.value.requested_by;
  const same = structuredClone(fixture.record);
  same.value.approval_receipt.authority_id = fixture.record.value.requested_by;
  assert.ok(codes(same, samePolicy).includes('same-authority-approval'));
  const stale = structuredClone(fixture.record);
  stale.value.approval_receipt.issued_at = '2026-05-01T00:00:00Z';
  stale.value.approval_receipt.approved_at = '2026-05-01T00:01:00Z';
  stale.value.approval_receipt.expires_at = '2026-08-01T00:00:00Z';
  assert.ok(codes(stale).includes('stale-approval'));
});

test('baseline integrity rejects forged measurements and artifact fields', () => {
  const baseline = {
    schema: 'kungfu.code-complexity-budget-baseline/v1',
    policyRoot: `sha256:${'1'.repeat(64)}`,
    baselineRef: 'a'.repeat(40),
    classification: 'ordered-policy-and-content-marker/v1',
    calibration: { hard: 100 },
    summary: { handwritten: { files: 1, lines: 10 } },
    groups: { handwritten: { hard: 100 } },
    grandfathered: [],
    files: [handwritten('scripts/a.mjs', 10)],
    issues: [],
  };
  baseline.measurementRoot = baselineMeasurementRoot(baseline);
  assert.deepEqual(
    baselineIntegrityIssues(baseline, baseline, 'base.json'),
    [],
  );
  const forged = structuredClone(baseline);
  forged.files[0].lines = 1;
  const codes = baselineIntegrityIssues(forged, baseline, 'base.json').map(
    (item) => item.code,
  );
  assert.ok(codes.includes('forged-baseline-artifact'));
});

test('protected baseline refresh requires one exact protected signed transition', () => {
  const fixture = signedWaiverFixture();
  const protectedBaseline = {
    measurementRoot: `sha256:${'1'.repeat(64)}`,
    baselineRef: 'a'.repeat(40),
  };
  const candidateBaseline = {
    measurementRoot: `sha256:${'2'.repeat(64)}`,
    baselineRef: 'b'.repeat(40),
  };
  const protectedPolicy = {
    ...fixture.policy,
    status: 'p1-trusted-governance',
    baselineGovernance: {
      transitionSchema: 'kungfu.code-complexity-baseline-transition/v1',
      maxChangedMeasurements: 10,
      maxAggregateLineDelta: 100,
    },
  };
  const candidatePolicy = {
    ...protectedPolicy,
    baselinePath: 'framework/maintainability/code-complexity-baseline.json',
  };
  const value = {
    schema: protectedPolicy.baselineGovernance.transitionSchema,
    expected_old_measurement_root: protectedBaseline.measurementRoot,
    expected_old_baseline_ref: protectedBaseline.baselineRef,
    new_measurement_root: candidateBaseline.measurementRoot,
    new_baseline_ref: candidateBaseline.baselineRef,
    changed_measurements: 1,
    aggregate_line_delta: 5,
    requested_by: 'author@example.com',
    reason: 'advance the frozen exact source cut',
    retirement_or_decomposition_ref: 'issue-456',
    approval_receipt: {
      schema: protectedPolicy.waiver.approvalReceiptSchema,
      authority_id: 'independent-reviewer',
      key_id: 'review-key-1',
      algorithm: 'ed25519',
      issued_at: '2026-07-26T00:00:00Z',
      approved_at: '2026-07-26T00:01:00Z',
      expires_at: '2026-08-01T00:00:00Z',
      authorization_root: '',
      signature: '',
    },
  };
  value.approval_receipt.authorization_root = digest(
    baselineTransitionAuthorization(value),
  );
  value.approval_receipt.signature = sign(
    null,
    Buffer.from(value.approval_receipt.authorization_root),
    fixture.privateKey,
  ).toString('base64');
  const context = {
    protectedPolicy,
    protectedBaseline,
    candidatePolicy,
    candidateBaseline,
    evaluationTime: fixture.evaluationTime,
    transitions: [{ file: 'transition.json', value }],
  };
  assert.deepEqual(protectedBaselineIssues(context), []);
  assert.equal(
    protectedBaselineIssues({ ...context, transitions: [] })[0].code,
    'unauthorized-baseline-transition',
  );
  const forged = structuredClone(context.transitions[0]);
  forged.value.new_baseline_ref = 'c'.repeat(40);
  assert.equal(
    protectedBaselineIssues({ ...context, transitions: [forged] })[0].code,
    'unauthorized-baseline-transition',
  );
});
