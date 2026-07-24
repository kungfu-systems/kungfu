// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  changedFilesBetween,
  evaluateReleaseGate,
  loadAdrs,
  parsePrManifest,
  validateAdrAuthority,
} from './adr-release-gate.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

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
