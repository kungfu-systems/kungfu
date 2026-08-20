// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baselineIntegrityIssues,
  baselineMeasurementRoot,
  digest,
  enrichIssue,
  protectedBaselineIssues,
} from '../framework/maintainability/complexity-governance.mjs';
import {
  baselineChangedPaths,
  classify,
  complexitySigningResidueAudit,
  composeRenameEvidence,
  dispositionSoftWarnings,
  git,
  hasGeneratedProvenance,
  isEligible,
  ownerFor,
  percentile,
  protectedBaselineCandidates,
  regressionIssues,
  renameEvidenceBase,
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

test('retired complexity signing residues fail closed with exact identifiers', () => {
  const retiredKey = ['ed25519-9ff2', '1f6e6f64c985'].join('');
  const retiredField = ['approval', '_receipt'].join('');
  const audit = complexitySigningResidueAudit([
    { path: 'docs/history.md', bytes: bytes(retiredKey) },
    {
      path: 'framework/maintainability/code-complexity-policy.json',
      bytes: bytes(retiredField),
    },
  ]);
  assert.equal(audit.verdict, 'fail');
  assert.deepEqual(
    audit.findings.map(({ marker }) => marker),
    [retiredKey, retiredField],
  );
  assert.ok(
    audit.globalMarkers.includes(['ed25519-6688', '12bf28659460'].join('')),
  );
  assert.ok(audit.globalMarkers.includes(retiredKey));
  assert.equal(
    complexitySigningResidueAudit([
      { path: 'unrelated.json', bytes: bytes(retiredField) },
    ]).verdict,
    'pass',
  );
});

test('git probes fail fast with a precise timeout', () => {
  assert.throws(
    () =>
      git(['show', 'HEAD:file'], {}, () => ({
        status: null,
        error: { code: 'ETIMEDOUT' },
      })),
    /timed out after 10000ms/,
  );
});

test('baseline path inventory avoids historical blob reads for rename scoring', () => {
  const calls = [];
  const changed = baselineChangedPaths('protected-base', (args) => {
    calls.push(args);
    return args[0] === 'diff'
      ? ['deleted.md', 'replacement.md']
      : ['untracked.mjs'];
  });

  assert.deepEqual(
    [...changed],
    ['deleted.md', 'replacement.md', 'untracked.mjs'],
  );
  assert.deepEqual(calls, [
    ['diff', '--no-renames', '--name-only', 'protected-base', '--'],
    ['ls-files', '--others', '--exclude-standard'],
  ]);
});

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

test('local qualification runtimes stay outside source complexity budgets', () => {
  const policy = {
    baselinePath: 'baseline.json',
    waiverDirectory: 'waivers',
    baselineGovernance: {},
    specialEligibleNames: [],
    eligibleExtensions: ['.cc', '.json'],
  };
  assert.equal(
    isEligible('.kungfu/qualification/runtime/vendor.cc', policy),
    false,
  );
  assert.equal(isEligible('.kungfu/episodes/a.json', policy), true);
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
  assert.equal(
    ownerFor('framework/core/src/python/kungfu/domain.py', { components: [] }, [
      {
        owner: 'core/python-domain',
        paths: ['framework/core/src/python/kungfu/domain.py'],
      },
    ]),
    'core/python-domain',
  );
  assert.equal(
    ownerFor('framework/core/src/python/kungfu/domain.py', { components: [] }, [
      {
        owner: 'core/python-domain-a',
        paths: ['framework/core/src/python/kungfu/domain.py'],
      },
      {
        owner: 'core/python-domain-b',
        paths: ['framework/core/src/python/kungfu/domain.py'],
      },
    ]),
    '',
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

test('advisory crossings are dispositioned without obscuring mainline budget', () => {
  const warning = {
    path: 'scripts/hotspot.mjs',
    currentLines: 90,
    softBudget: 80,
    hardBudget: 100,
  };
  const report = dispositionSoftWarnings(
    [warning],
    [handwritten(warning.path, warning.currentLines)],
    {
      advisoryDispositions: {
        [warning.path]: {
          action: 'decomposed-evidence-reader',
          extractedPaths: ['framework/maintainability/evidence-reader.mjs'],
          residualResponsibility: 'one bounded producer',
        },
        'scripts/resolved.mjs': {
          action: 'resolved-below-advisory',
          extractedPaths: [],
          residualResponsibility: 'one bounded command',
        },
      },
    },
  );
  assert.equal(report.active[0].thresholdClass, 'advisory');
  assert.equal(report.active[0].protectedMainlineBudget, 100);
  assert.equal(report.active[0].protectedMainlineState, 'within-budget');
  assert.equal(report.active[0].independentExactHeadReviewRequired, true);
  assert.equal(report.active[0].disposition, 'decomposed-evidence-reader');
  assert.equal(report.resolved[0].path, 'scripts/resolved.mjs');
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

test('new-file anti-gaming ignores helpers already present on the protected base', () => {
  const deleted = handwritten('scripts/legacy-hotspot.mjs', 120);
  const protectedHelpers = [
    handwritten('scripts/existing-reader.mjs', 5000),
    handwritten('scripts/existing-writer.mjs', 50),
    handwritten('scripts/existing-index.mjs', 20),
    handwritten('scripts/existing-query.mjs', 20),
  ];
  const issues = regressionIssues(
    protectedHelpers,
    { groups, files: [deleted] },
    {
      antiGaming: {
        maxNewHandwrittenFilesPerOwner: 3,
        newGeneratedProjectionRequiresProvenance: true,
      },
    },
    new Map(),
    new Set(),
  );
  assert.equal(
    issues.some((issue) => issue.code === 'responsibility-preserving-split'),
    false,
  );
  assert.equal(
    issues.some((issue) => issue.code === 'new-helper-proliferation'),
    false,
  );
  assert.equal(
    issues.some(
      (issue) => issue.code === 'new-handwritten-file-over-hard-budget',
    ),
    false,
  );
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

test('declared owner-prefix migrations apply only to one-to-one Git renames', () => {
  const previous = handwritten(
    'extensions/legacy/actions/adapter.mjs',
    80,
    'extension/legacy/actions',
  );
  const current = handwritten(
    'extensions/current/actions/adapter.mjs',
    80,
    'extension/current/actions',
  );
  const policy = {
    antiGaming: {
      allowedOwnerRenamePrefixes: [
        { from: 'extension/legacy', to: 'extension/current' },
      ],
    },
  };
  assert.deepEqual(
    regressionIssues(
      [current],
      { groups, files: [previous] },
      policy,
      new Map([[current.path, previous.path]]),
    ),
    [],
  );
  assert.ok(
    regressionIssues(
      [{ ...current, owner: 'extension/unrelated/actions' }],
      { groups, files: [previous] },
      policy,
      new Map([[current.path, previous.path]]),
    ).some((issue) => issue.code === 'classification-or-owner-relabeled'),
  );
  assert.ok(
    regressionIssues(
      [{ ...previous, owner: 'extension/current/actions' }],
      { groups, files: [previous] },
      policy,
    ).some((issue) => issue.code === 'classification-or-owner-relabeled'),
  );
});

test('rename evidence remains anchored to the measured baseline after a refactor merges', () => {
  const baselineRef = 'a'.repeat(40);
  assert.equal(
    renameEvidenceBase({
      baselineRef,
      baselineGovernance: { protectedRef: 'origin/HEAD' },
    }),
    baselineRef,
  );
  assert.throws(
    () => renameEvidenceBase({ baselineRef: 'origin/HEAD' }),
    /exact baseline ref/u,
  );
  assert.deepEqual(
    [
      ...composeRenameEvidence(
        'R100\told.ts\tmiddle.ts\nR060\tmiddle.ts\tnew.ts',
      ),
    ],
    [['new.ts', 'old.ts']],
  );
  assert.deepEqual(
    [
      ...composeRenameEvidence(
        'R100\told.ts\tcurrent.ts\nD\tcurrent.ts\nA\tcurrent.ts',
      ),
    ],
    [],
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

function waiverFixture() {
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
    'retirement_or_decomposition_ref',
  ];
  const policy = {
    status: 'p1-trusted-governance',
    waiver: {
      schema: 'kungfu.code-complexity-budget-waiver/v3',
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
  };
  const record = { file: 'waiver.json', value };
  return {
    policy,
    baseline,
    current,
    issue,
    record,
  };
}

test('waivers require an exact, author-bound, non-reusable scope', () => {
  const fixture = waiverFixture();
  const context = {
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

test('waivers reject candidate-author drift and stale measurements', () => {
  const fixture = waiverFixture();
  const context = {
    requester: fixture.record.value.requested_by,
    issue: fixture.issue,
  };
  const codes = (record, localContext = context) =>
    waiverIssues(record, fixture.policy, localContext).map((item) => item.code);
  assert.ok(
    codes(fixture.record, {
      ...context,
      requester: 'other@example.com',
    }).includes('forged-waiver-requester'),
  );
  const stale = structuredClone(fixture.record);
  stale.value.current_measurement[0].lines -= 1;
  assert.ok(codes(stale).includes('waiver-scope-mismatch'));
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

test('protected baseline refresh requires one exact deterministic transition', () => {
  const protectedBaseline = {
    measurementRoot: `sha256:${'1'.repeat(64)}`,
    baselineRef: 'a'.repeat(40),
  };
  const candidateBaseline = {
    measurementRoot: `sha256:${'2'.repeat(64)}`,
    baselineRef: 'b'.repeat(40),
  };
  const protectedPolicy = {
    status: 'p1-trusted-governance',
    baselineGovernance: {
      transitionSchema: 'kungfu.code-complexity-baseline-transition/v2',
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
  };
  const context = {
    protectedPolicy,
    protectedBaseline,
    candidatePolicy,
    candidateBaseline,
    requester: value.requested_by,
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
  const wrongRequester = structuredClone(context.transitions[0]);
  wrongRequester.value.requested_by = 'other@example.com';
  assert.equal(
    protectedBaselineIssues({
      ...context,
      transitions: [wrongRequester],
    })[0].code,
    'unauthorized-baseline-transition',
  );
  assert.equal(
    protectedBaselineIssues({
      ...context,
      transitions: [
        context.transitions[0],
        structuredClone(context.transitions[0]),
      ],
    })[0].code,
    'unauthorized-baseline-transition',
  );
});
