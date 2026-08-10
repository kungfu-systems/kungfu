// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  auditDeprecations,
  compareSemver,
  evaluateZeroReferenceAudit,
  parseSemver,
} from '../framework/deprecation/deprecation-lifecycle.mjs';
import {
  changedFilesBetween,
  evaluateReleaseGate,
  loadAdrs,
  parsePrManifest,
  validateAdrAuthority,
} from './adr-release-gate.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DEPRECATION_CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(
      REPO_ROOT,
      'framework/deprecation/deprecation-lifecycle.contract.json',
    ),
    'utf8',
  ),
);

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

const contract = {
  schema: 'kungfu.adr-release-contract/v1',
  manifestSchema: 'kungfu.adr-release-pr/v1',
  manifestMarker: 'kungfu-adr-release:v1',
  adrRoots: ['adr'],
  dev: {
    featureBranchPattern: '^feature/',
    deliveryIntents: ['stage-ready', 'implemented'],
    stageReadyStatuses: ['partial', 'staged', 'implemented'],
    implementedCandidateStatuses: ['staged', 'implemented'],
  },
  alpha: {
    settlementStatuses: [
      'not-started',
      'partial',
      'staged',
      'implemented',
      'not-applicable',
    ],
  },
  stable: {
    requiredDecisionStatuses: ['accepted'],
    admittedImplementationStatuses: ['implemented', 'not-applicable'],
    requireQualificationForImplemented: true,
    waiverFile: 'docs/adr-release-waivers.json',
    waiverApprovers: ['release-admin'],
  },
};

function fixture(adrs, waivers = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-release-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'adr'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs/adr-release-waivers.json'),
    JSON.stringify({ schema: 'kungfu.adr-release-waivers/v1', waivers }),
  );
  for (const adr of adrs) {
    const qualifications = adr.qualified
      ? '\nqualification_refs: [tests/qualification.md]'
      : '';
    fs.writeFileSync(
      path.join(root, `adr/${adr.id}.md`),
      `---\nadr_id: ${adr.id}\ndecision_status: ${adr.decision || 'accepted'}\nimplementation_status: ${adr.status}${qualifications}\n---\n\n# ${adr.id}\n`,
    );
  }
  return root;
}

function run(root, mode, manifest, extra = {}) {
  return evaluateReleaseGate({
    root,
    contract,
    mode,
    manifest: { schema: contract.manifestSchema, ...manifest },
    authorityFindings: [],
    ...extra,
  });
}

function git(root, args, input = undefined) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
    encoding: 'utf8',
    input,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
  );
  return String(result.stdout || '').trim();
}

test('fails closed when ADR identity authority reports a structural finding', () => {
  const invalidId = ['ADR', '9999'].join('-');
  const root = fixture([{ id: invalidId, status: 'partial' }]);
  const result = run(
    root,
    'dev',
    { kind: 'adr-neutral', reason: 'Ordinary maintenance only' },
    {
      headRef: 'fix/maintenance',
      authorityFindings: [
        {
          code: 'adr-authority-adr-id-format',
          message: `${invalidId} is not canonical`,
        },
      ],
    },
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((finding) =>
      finding.code.startsWith('adr-authority-'),
    ),
  );
});

test('validates the repository ADR authority without injected findings', () => {
  assert.deepEqual(validateAdrAuthority(REPO_ROOT), []);
});

test('release loading fails closed on identity-looking noncanonical paths', () => {
  const id = 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910';
  for (const name of [`${id}-bypass.md`, `${id}.markdown`, `${id}.MD`]) {
    const root = fixture([]);
    fs.writeFileSync(path.join(root, 'adr', name), 'bypass\n');
    assert.throws(
      () => loadAdrs(root, contract),
      /must be direct lowercase \.md files/,
    );
  }
});

test('parses exactly one JSON manifest from the PR body', () => {
  const parsed = parsePrManifest(
    '<!-- kungfu-adr-release:v1\n{"kind":"adr-neutral"}\n-->',
    contract.manifestMarker,
  );
  assert.equal(parsed.kind, 'adr-neutral');
  assert.throws(() => parsePrManifest('no manifest', contract.manifestMarker));
});

test('hydrates exact promotion boundaries in a shallow build checkout', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-adr-release-shallow-'),
  );
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  const checkout = path.join(root, 'checkout');

  git(root, ['init', '--bare', remote]);
  fs.mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'ADR Test']);
  git(source, ['config', 'user.email', 'adr-test@example.invalid']);
  fs.mkdirSync(path.join(source, 'adr'));
  fs.writeFileSync(path.join(source, 'adr/decision.md'), 'alpha\n');
  git(source, ['add', 'adr/decision.md']);
  git(source, ['commit', '-m', 'alpha']);
  const alpha = git(source, ['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(source, 'adr/decision.md'), 'development\n');
  git(source, ['commit', '-am', 'development']);
  const development = git(source, ['rev-parse', 'HEAD']);
  const tree = git(source, ['rev-parse', 'HEAD^{tree}']);
  const promotion = git(
    source,
    ['commit-tree', tree, '-p', alpha, '-p', development],
    'promote\n',
  );
  const merge = git(
    source,
    ['commit-tree', tree, '-p', alpha, '-p', promotion],
    'pull request merge\n',
  );
  git(source, ['update-ref', 'refs/heads/merge', merge]);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', 'origin', 'refs/heads/merge']);
  git(root, [
    'clone',
    '--depth=1',
    '--branch=merge',
    `file://${remote}`,
    checkout,
  ]);

  const missingPromotion = childProcess.spawnSync(
    'git',
    ['cat-file', '-e', `${promotion}^{commit}`],
    {
      cwd: checkout,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      ),
      encoding: 'utf8',
    },
  );
  assert.notEqual(missingPromotion.status, 0);
  assert.deepEqual(changedFilesBetween(alpha, promotion, checkout), [
    'adr/decision.md',
  ]);
  assert.equal(git(checkout, ['rev-parse', '--is-shallow-repository']), 'true');
});

test('feature dev PR requires a stage-ready or implemented delivery', () => {
  const root = fixture([
    { id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910', status: 'partial' },
  ]);
  const neutral = run(
    root,
    'dev',
    { kind: 'adr-neutral', reason: 'ordinary cleanup' },
    { headRef: 'feature/new-surface' },
  );
  assert.ok(
    neutral.findings.some((finding) => finding.code === 'feature-neutral'),
  );

  const delivery = run(
    root,
    'dev',
    {
      kind: 'dev-delivery',
      intent: 'stage-ready',
      adrs: ['KF-ADR-019f86da-4f90-7179-a900-c40bdb498910'],
      summary: 'Complete bounded storage stage',
      verification: ['storage contract tests'],
    },
    {
      headRef: 'feature/new-surface',
      changedFiles: ['adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md'],
    },
  );
  assert.equal(delivery.ok, true);
});

test('implemented dev intent needs a staged/implemented qualified ADR', () => {
  const partialRoot = fixture([
    { id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910', status: 'partial' },
  ]);
  const result = run(
    partialRoot,
    'dev',
    {
      kind: 'dev-delivery',
      intent: 'implemented',
      adrs: ['KF-ADR-019f86da-4f90-7179-a900-c40bdb498910'],
      summary: 'Complete accepted decision scope',
      verification: ['full qualification'],
    },
    { headRef: 'feature/close-adr' },
  );
  assert.ok(result.findings.some((finding) => finding.code === 'dev-status'));
  assert.ok(
    result.findings.some(
      (finding) => finding.code === 'implemented-candidate-qualification',
    ),
  );
});

test('ADR-neutral bugfix remains available outside feature branches', () => {
  const root = fixture([
    {
      id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
      status: 'implemented',
      qualified: true,
    },
  ]);
  const result = run(
    root,
    'dev',
    { kind: 'adr-neutral', reason: 'Fix typo without contract change' },
    { headRef: 'fix/typo', changedFiles: ['src/fix.cc'] },
  );
  assert.equal(result.ok, true);
});

test('alpha settlement must match a changed ADR projection', () => {
  const root = fixture([
    {
      id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
      status: 'staged',
      qualified: true,
    },
  ]);
  const missingChange = run(root, 'alpha', {
    kind: 'alpha-settlement',
    progress: [
      {
        adr: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
        to: 'staged',
        summary: 'Stage is ready for alpha qualification',
      },
    ],
  });
  assert.ok(
    missingChange.findings.some((finding) => finding.code === 'alpha-evidence'),
  );

  const settled = run(
    root,
    'alpha',
    {
      kind: 'alpha-settlement',
      progress: [
        {
          adr: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
          to: 'staged',
          summary: 'Stage is ready for alpha qualification',
        },
      ],
    },
    { changedFiles: ['adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md'] },
  );
  assert.equal(settled.ok, true);
});

test('alpha allows an explicit no-ADR-progress settlement', () => {
  const root = fixture([
    {
      id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
      status: 'implemented',
      qualified: true,
    },
  ]);
  const result = run(root, 'alpha', {
    kind: 'alpha-settlement',
    no_adr_progress_reason: 'Promotion contains fixes only',
  });
  assert.equal(result.ok, true);
});

test('the release gate binds the common read-only deprecation audit', () => {
  const repositoryContract = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'docs/adr-release.contract.json')),
  );
  const result = evaluateReleaseGate({
    root: REPO_ROOT,
    contract: repositoryContract,
    mode: 'dev',
    manifest: {
      schema: repositoryContract.manifestSchema,
      kind: 'adr-neutral',
      reason: 'Read-only governance audit probe',
    },
    headRef: 'fix/deprecation-audit-probe',
    authorityFindings: [],
    adrs: new Map(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.deprecations.schema, 'kungfu.deprecation-audit/v1');
  assert.equal(result.deprecations.readOnly, true);
});

test('an overdue deprecation blocks the protected alpha settlement path', () => {
  const repositoryContract = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'docs/adr-release.contract.json')),
  );
  const result = evaluateReleaseGate({
    root: REPO_ROOT,
    contract: repositoryContract,
    mode: 'alpha',
    manifest: {
      schema: repositoryContract.manifestSchema,
      kind: 'alpha-settlement',
      no_adr_progress_reason: 'Promotion contains no ADR record change',
    },
    authorityFindings: [],
    adrs: new Map(),
    deprecationReport: {
      schema: 'kungfu.deprecation-audit/v1',
      ok: false,
      readOnly: true,
      findings: [
        {
          code: 'deprecation-overdue',
          entry: 'fixture.expired',
          message: 'qualified removal or exact Warrant required',
        },
      ],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((finding) => finding.code === 'deprecation-overdue'),
  );
});

test('alpha rejects changed accepted ADRs omitted from settlement', () => {
  const root = fixture([
    {
      id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
      status: 'staged',
      qualified: true,
    },
    { id: 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a', status: 'partial' },
  ]);
  const result = run(
    root,
    'alpha',
    {
      kind: 'alpha-settlement',
      progress: [
        {
          adr: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
          to: 'staged',
          summary: 'Stage is ready for alpha qualification',
        },
      ],
    },
    {
      changedFiles: [
        'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md',
        'adr/KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md',
      ],
    },
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === 'alpha-unsettled-change' &&
        finding.adr === 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a',
    ),
  );
});

test('stable blocks every unaccounted accepted ADR', () => {
  const root = fixture([
    {
      id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
      status: 'implemented',
      qualified: true,
    },
    { id: 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a', status: 'staged' },
    {
      id: 'KF-ADR-019f86da-4f90-7a30-8697-5c648120053d',
      status: 'not-started',
      decision: 'proposed',
    },
  ]);
  const result = run(
    root,
    'stable',
    { kind: 'stable-admission', release: '4.0.0' },
    { prUrl: 'https://github.com/kungfu-systems/kungfu/pull/99' },
  );
  assert.equal(result.summary.admitted, 1);
  assert.deepEqual(
    result.blocked.map((entry) => entry.adr),
    ['KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a'],
  );
});

test('stable admits an exact-release, exact-condition admin waiver', () => {
  const prUrl = 'https://github.com/kungfu-systems/kungfu/pull/99';
  const root = fixture(
    [{ id: 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a', status: 'staged' }],
    [
      {
        waiver_id: 'KFW-4.0.0-001',
        release: '4.0.0',
        adr: 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a',
        conditions: ['implementation_status:staged'],
        reason: 'Qualification remains incomplete',
        risk: 'The capability is not part of the default stable profile',
        mitigation: 'Keep the capability disabled by default',
        approved_by: 'release-admin',
        approval_pr: prUrl,
        expires_after: '4.0.0',
      },
    ],
  );
  const result = run(
    root,
    'stable',
    { kind: 'stable-admission', release: '4.0.0' },
    { prUrl },
  );
  assert.equal(result.ok, true);
  assert.equal(result.summary.waived, 1);
});

test('stable rejects stale, unauthorized, and broader waivers', () => {
  const prUrl = 'https://github.com/kungfu-systems/kungfu/pull/99';
  const root = fixture(
    [{ id: 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a', status: 'staged' }],
    [
      {
        waiver_id: 'KFW-4.0.0-001',
        release: '4.0.0',
        adr: 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a',
        conditions: ['implementation_status:staged', 'qualification:missing'],
        reason: 'Qualification remains incomplete',
        risk: 'The capability is not part of the default stable profile',
        mitigation: 'Keep the capability disabled by default',
        approved_by: 'someone-else',
        approval_pr: prUrl,
        expires_after: '4.0.1',
      },
    ],
  );
  const result = run(
    root,
    'stable',
    { kind: 'stable-admission', release: '4.0.0' },
    { prUrl },
  );
  assert.ok(
    result.findings.some((finding) => finding.code === 'stable-blocked'),
  );
  assert.ok(result.findings.some((finding) => finding.code === 'waiver-stale'));
});

test('implemented ADR without qualification evidence still blocks stable', () => {
  const root = fixture([
    {
      id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
      status: 'implemented',
    },
  ]);
  const result = run(
    root,
    'stable',
    { kind: 'stable-admission', release: '4.0.0' },
    { prUrl: 'https://github.com/kungfu-systems/kungfu/pull/99' },
  );
  assert.deepEqual(result.blocked[0].conditions, ['qualification:missing']);
});

function writeDeprecationFixture(root, rel, content = 'fixture\n') {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function deprecationEntry(overrides = {}) {
  return {
    id: 'fixture.alpha-surface',
    lifecycle: 'deprecated',
    surfaceClass: 'public-alpha-preview',
    classification: {
      authority: 'framework/core/architecture/layers.json',
      authorityType: 'core-public-contract',
      ruleId: 'fixture-source-api',
    },
    owner: 'fixture/owner',
    surface: {
      kind: 'source-api',
      path: 'src/surface.txt',
      symbols: ['old_surface'],
      markers: [
        {
          id: 'old-surface',
          dialect: 'cpp-deprecated-attribute',
          path: 'src/surface.txt',
        },
      ],
    },
    replacement: 'new_surface',
    migrationGuidance: 'docs/migration.md',
    deprecatedAt: {
      date: '2026-07-01',
      productVersion: '4.0.0-alpha.1',
      decision: 'docs/decision.md',
    },
    knownConsumers: [
      {
        id: 'fixture-consumer',
        status: 'known',
        evidence: 'tests/consumer.txt',
      },
    ],
    windows: {
      minimumCalendarDays: 30,
      minimumQualifiedReleases: 1,
    },
    earliestRemovalBoundary: 'pre-stable-or-major',
    removalConditions: [
      'current-head-zero-reference',
      'migration-qualified',
      'release-note-published',
      'retained-evidence-preserved',
    ],
    retainedEvidence: ['docs/decision.md'],
    zeroReferenceAudit: {
      checks: [
        {
          kind: 'text-absent',
          roots: ['src'],
          patterns: ['old_surface'],
        },
      ],
    },
    removalEvidence: null,
    extensionWarrant: null,
    ...overrides,
  };
}

function deprecationFixture(selected, releaseHistory = []) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-deprecation-lifecycle-'),
  );
  roots.push(root);
  for (const rel of [
    'docs/migration.md',
    'docs/decision.md',
    'docs/warrant.json',
    'docs/release-note.md',
    'docs/restoration.md',
    'tests/consumer.txt',
    'tests/migration.test.mjs',
    'tests/restoration.test.mjs',
  ]) {
    writeDeprecationFixture(root, rel);
  }
  writeDeprecationFixture(root, 'src/surface.txt', 'new_surface\n');
  writeDeprecationFixture(
    root,
    'framework/core/architecture/layers.json',
    JSON.stringify({
      public_contracts: {
        header_rules: [
          {
            id: 'fixture-source-api',
            include_files: ['src/surface.txt'],
            level: 'experimental',
          },
        ],
      },
    }),
  );
  return {
    root,
    registry: {
      schema: 'kungfu.deprecation-registry/v1',
      contract: 'framework/deprecation/deprecation-lifecycle.contract.json',
      productVersion: '5.0.0',
      releaseHistory,
      entries: [selected],
    },
  };
}

function auditDeprecationFixture(selected, options = {}) {
  const { root, registry } = deprecationFixture(
    selected,
    options.releaseHistory || [],
  );
  return auditDeprecations({
    root,
    contract: DEPRECATION_CONTRACT,
    registry,
    release: options.release,
    releaseDate: options.releaseDate || '2026-07-29',
    channel: options.channel || 'audit',
    strictDue: options.strictDue,
  });
}

test('checked-in deprecation authority distinguishes live debt from settled history', () => {
  const report = auditDeprecations({
    root: REPO_ROOT,
    releaseDate: '2026-07-29',
  });
  assert.equal(report.ok, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.summary.entries, 3);
  assert.equal(report.summary.dispositions['not-due'], 3);
  assert.equal(report.inventory.live.length, 9);
  assert.equal(report.inventory.settled.length, 0);
  assert.equal(report.inventory.classifications.historicalEvidence.length, 1);
});

test('deprecation versions preserve prerelease ordering and stable boundaries', () => {
  assert.ok(parseSemver('4.0.0-alpha.1'));
  assert.equal(parseSemver('4.0'), null);
  assert.equal(compareSemver('4.0.0-alpha.1', '4.0.0-alpha.2'), -1);
  assert.equal(compareSemver('4.0.0-alpha.2', '4.0.0'), -1);
  assert.equal(compareSemver('5.0.0', '4.99.99'), 1);
});

test('calendar and release windows jointly select the first eligible prerelease', () => {
  const before = auditDeprecationFixture(deprecationEntry(), {
    release: '4.0.0-alpha.2',
    releaseDate: '2026-07-15',
    channel: 'alpha',
    strictDue: true,
  });
  assert.equal(before.ok, true);
  assert.equal(before.entries[0].disposition, 'not-due');

  const due = auditDeprecationFixture(deprecationEntry(), {
    release: '4.0.0-alpha.2',
    releaseDate: '2026-07-31',
    channel: 'alpha',
    strictDue: true,
  });
  assert.equal(due.ok, false);
  assert.equal(due.entries[0].disposition, 'due');
  assert.equal(due.entries[0].eligibleRelease.version, '4.0.0-alpha.2');
});

test('class defaults are executable minima while stricter windows are preserved', () => {
  const below = auditDeprecationFixture(
    deprecationEntry({
      windows: { minimumCalendarDays: 29, minimumQualifiedReleases: 0 },
    }),
  );
  assert.equal(below.ok, false);
  assert.deepEqual(
    below.findings
      .filter((finding) => finding.code === 'deprecation-window-below-minimum')
      .map((finding) => finding.message),
    [
      'fixture.alpha-surface: windows.minimumCalendarDays 29 is below public-alpha-preview minimum 30',
      'fixture.alpha-surface: windows.minimumQualifiedReleases 0 is below public-alpha-preview minimum 1',
    ],
  );

  const stricter = auditDeprecationFixture(
    deprecationEntry({
      windows: { minimumCalendarDays: 45, minimumQualifiedReleases: 2 },
    }),
  );
  assert.equal(stricter.ok, true);
  assert.equal(stricter.entries[0].nextEligibleRelease.notBefore, '2026-08-15');
  assert.equal(
    stricter.entries[0].nextEligibleRelease.minimumQualifiedReleases,
    2,
  );
});

test('classification provenance prevents stable and artifact downgrades', () => {
  const cli = auditDeprecationFixture(
    deprecationEntry({
      id: 'fixture.cli-command',
      surfaceClass: 'public-alpha-preview',
      surface: {
        kind: 'cli-command',
        path: 'src/surface.txt',
        symbols: ['kungfu fixture'],
        markers: [
          {
            id: 'fixture-cli',
            dialect: 'cli-structured-compatibility',
            path: 'src/surface.txt',
          },
        ],
      },
      classification: {
        authority: 'framework/deprecation/deprecation-lifecycle.contract.json',
        authorityType: 'kind-policy',
        ruleId: 'cli-command',
      },
    }),
  );
  assert.equal(cli.ok, false);
  assert.match(
    cli.findings.find(
      (finding) => finding.code === 'deprecation-classification-integrity',
    ).message,
    /authority allows stable-cli-sdk-public-api/u,
  );

  const artifact = auditDeprecationFixture(
    deprecationEntry({
      id: 'fixture.artifact',
      surfaceClass: 'document',
      surface: {
        kind: 'document',
        path: 'src/surface.txt',
        symbols: ['fixture.tar.gz'],
        markers: [
          {
            id: 'fixture-artifact',
            dialect: 'artifact-structured-compatibility',
            path: 'src/surface.txt',
          },
        ],
      },
      classification: {
        authority: 'framework/deprecation/deprecation-lifecycle.contract.json',
        authorityType: 'kind-policy',
        ruleId: 'document',
      },
      windows: { minimumCalendarDays: 30, minimumQualifiedReleases: 1 },
      earliestRemovalBoundary: 'any-qualified-release',
    }),
  );
  assert.equal(artifact.ok, false);
  assert.match(
    artifact.findings.find(
      (finding) => finding.code === 'deprecation-classification-integrity',
    ).message,
    /dialect allows artifact/u,
  );
});

test('future dates and versions beyond product authority fail closed', () => {
  const future = auditDeprecationFixture(
    deprecationEntry({
      deprecatedAt: {
        date: '2026-08-01',
        productVersion: '4.0.0-alpha.1',
        decision: 'docs/decision.md',
      },
    }),
  );
  assert.equal(future.ok, false);
  assert.equal(future.findings[0].code, 'deprecation-date-after-context');

  const laterVersion = auditDeprecationFixture(
    deprecationEntry({
      deprecatedAt: {
        date: '2026-07-01',
        productVersion: '5.1.0',
        decision: 'docs/decision.md',
      },
    }),
  );
  assert.equal(laterVersion.ok, false);
  assert.ok(
    laterVersion.findings.some(
      (finding) => finding.code === 'deprecation-version-after-context',
    ),
  );
});

test('stable API removal remains blocked until a new major', () => {
  const stable = deprecationEntry({
    id: 'fixture.stable-api',
    surfaceClass: 'stable-cli-sdk-public-api',
    deprecatedAt: {
      date: '2026-01-01',
      productVersion: '4.1.0',
      decision: 'docs/decision.md',
    },
    windows: { minimumCalendarDays: 90, minimumQualifiedReleases: 1 },
    earliestRemovalBoundary: 'next-major',
  });
  const sameMajor = auditDeprecationFixture(stable, {
    release: '4.9.0',
    releaseDate: '2026-07-31',
    channel: 'stable',
    strictDue: true,
  });
  assert.equal(sameMajor.ok, true);
  assert.equal(sameMajor.entries[0].disposition, 'not-due');

  const nextMajor = auditDeprecationFixture(stable, {
    release: '5.0.0',
    releaseDate: '2026-07-31',
    channel: 'stable',
    strictDue: true,
  });
  assert.equal(nextMajor.ok, false);
  assert.equal(nextMajor.entries[0].disposition, 'due');
});

test('protocol removal fails closed without qualified historical support', () => {
  const report = auditDeprecationFixture(
    deprecationEntry({
      id: 'fixture.protocol',
      surfaceClass: 'persisted-schema-wire-protocol',
      surface: {
        kind: 'wire-protocol',
        path: 'src/surface.txt',
        symbols: ['fixture-wire-v1'],
        markers: [
          {
            id: 'fixture-wire-v1',
            dialect: 'persisted-schema-protocol',
            path: 'src/surface.txt',
          },
        ],
      },
      classification: {
        authority: 'framework/deprecation/deprecation-lifecycle.contract.json',
        authorityType: 'kind-policy',
        ruleId: 'wire-protocol',
      },
      deprecatedAt: {
        date: '2025-01-01',
        productVersion: '4.0.0',
        decision: 'docs/decision.md',
      },
      windows: { minimumCalendarDays: 180, minimumQualifiedReleases: 2 },
      earliestRemovalBoundary: 'next-major-and-support-policy',
    }),
    {
      release: '5.0.0',
      releaseDate: '2026-07-31',
      channel: 'stable',
      strictDue: true,
    },
  );
  assert.equal(report.ok, false);
  assert.equal(report.entries[0].disposition, 'invalid');
  assert.ok(
    report.findings.some(
      (finding) => finding.code === 'deprecation-support-evidence-invalid',
    ),
  );
});

test('protocol support claims require exact authority and evidence', () => {
  const report = auditDeprecationFixture(
    deprecationEntry({
      id: 'fixture.protocol-supported',
      surfaceClass: 'persisted-schema-wire-protocol',
      surface: {
        kind: 'wire-protocol',
        path: 'src/surface.txt',
        symbols: ['fixture-wire-v1'],
        markers: [
          {
            id: 'fixture-wire-v1',
            dialect: 'persisted-schema-protocol',
            path: 'src/surface.txt',
          },
        ],
      },
      classification: {
        authority: 'framework/deprecation/deprecation-lifecycle.contract.json',
        authorityType: 'kind-policy',
        ruleId: 'wire-protocol',
      },
      deprecatedAt: {
        date: '2025-01-01',
        productVersion: '4.0.0',
        decision: 'docs/decision.md',
      },
      windows: { minimumCalendarDays: 180, minimumQualifiedReleases: 2 },
      earliestRemovalBoundary: 'next-major-and-support-policy',
      supportPolicy: {
        historicalReaderOrMigrationQualified: true,
        authority: 'docs/decision.md',
        evidence: ['tests/migration.test.mjs'],
      },
    }),
  );
  assert.equal(report.ok, true);
  assert.equal(report.entries[0].disposition, 'not-due');
});

test('one exact bounded Warrant covers only its declared release and date', () => {
  const warrant = {
    authority: 'kungfu.warrant',
    warrantRoot: `sha256:${'a'.repeat(64)}`,
    entryId: 'fixture.alpha-surface',
    authorizedBy: 'release-admin',
    issuedAt: '2026-07-31',
    expiresOn: '2026-08-31',
    expiresAfterRelease: '4.0.0-alpha.2',
    evidenceRef: 'docs/warrant.json',
  };
  const covered = auditDeprecationFixture(
    deprecationEntry({ extensionWarrant: warrant }),
    {
      release: '4.0.0-alpha.2',
      releaseDate: '2026-08-01',
      channel: 'alpha',
      strictDue: true,
    },
  );
  assert.equal(covered.ok, true);
  assert.equal(covered.entries[0].disposition, 'extended-by-warrant');

  const stale = auditDeprecationFixture(
    deprecationEntry({ extensionWarrant: warrant }),
    {
      release: '4.0.0-alpha.3',
      releaseDate: '2026-09-01',
      channel: 'alpha',
      strictDue: true,
    },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.entries[0].disposition, 'due');
  assert.equal(stale.entries[0].blocker, 'extension-warrant-expired-or-stale');
});

test('renewing or unbounded Warrant projections fail closed', () => {
  const report = auditDeprecationFixture(
    deprecationEntry({
      extensionWarrant: {
        authority: 'kungfu.warrant',
        warrantRoot: `sha256:${'b'.repeat(64)}`,
        entryId: 'fixture.alpha-surface',
        authorizedBy: 'release-admin',
        issuedAt: '2026-07-31',
        expiresOn: '2027-07-31',
        expiresAfterRelease: '4.0.0-alpha.9',
        evidenceRef: 'docs/warrant.json',
        renewalOf: `sha256:${'c'.repeat(64)}`,
      },
    }),
  );
  assert.equal(report.ok, false);
  assert.equal(report.entries[0].disposition, 'invalid');
  assert.ok(
    report.findings.some((finding) =>
      String(finding.message).includes('forbids renewalOf'),
    ),
  );
  assert.ok(
    report.findings.some((finding) =>
      String(finding.message).includes('maximum calendar bound'),
    ),
  );
});

test('settlement requires zero current references and retained evidence', () => {
  const selected = deprecationEntry({
    lifecycle: 'settled',
    removalEvidence: {
      removedAt: {
        date: '2026-07-31',
        productVersion: '4.0.0-alpha.2',
      },
      gitCommit: '1'.repeat(40),
      migrationQualification: ['tests/migration.test.mjs'],
      releaseNote: 'docs/release-note.md',
      retainedEvidence: ['docs/missing-retained.md'],
    },
  });
  const { root, registry } = deprecationFixture(selected);
  writeDeprecationFixture(root, 'src/surface.txt', 'old_surface\n');
  const report = auditDeprecations({
    root,
    contract: DEPRECATION_CONTRACT,
    registry,
    releaseDate: '2026-07-31',
  });
  assert.equal(report.ok, false);
  assert.equal(report.entries[0].disposition, 'invalid');
  assert.ok(
    report.findings.some((finding) =>
      String(finding.message).includes('current-head reference'),
    ),
  );
  assert.ok(
    report.findings.some((finding) =>
      String(finding.message).includes('settlement retained evidence'),
    ),
  );
});

test('zero-reference JSON audits reject a catalog with aliases', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-deprecation-zero-ref-'),
  );
  roots.push(root);
  writeDeprecationFixture(
    root,
    'registry.json',
    '{"aliases":[{"path":"kungfu old"}]}\n',
  );
  const result = evaluateZeroReferenceAudit(root, {
    checks: [
      {
        kind: 'json-array-empty',
        path: 'registry.json',
        pointer: '/aliases',
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /must be an empty array/u);
});

test('restored support needs explicit decision and qualification evidence', () => {
  const missing = auditDeprecationFixture(
    deprecationEntry({ lifecycle: 'active' }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.entries[0].disposition, 'invalid');

  const restored = auditDeprecationFixture(
    deprecationEntry({
      lifecycle: 'active',
      restorationEvidence: {
        restoredAt: {
          date: '2026-07-29',
          productVersion: '4.0.0-alpha.2',
        },
        decision: 'docs/restoration.md',
        qualification: ['tests/restoration.test.mjs'],
      },
    }),
  );
  assert.equal(restored.ok, true);
  assert.equal(restored.entries[0].disposition, 'not-due');
});

test('ambiguous deprecation history and candidate versions are invalid', () => {
  const report = auditDeprecationFixture(deprecationEntry(), {
    release: 'next-alpha',
    releaseDate: '2026-07-31',
    channel: 'alpha',
    strictDue: true,
    releaseHistory: [
      {
        version: 'also-not-semver',
        date: 'unknown',
        channel: 'preview',
        qualified: 'yes',
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.entries[0].disposition, 'invalid');
  assert.ok(
    report.findings.some((finding) => finding.code === 'deprecation-release'),
  );
});
