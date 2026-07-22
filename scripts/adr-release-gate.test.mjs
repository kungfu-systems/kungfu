// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
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
      path.join(root, `adr/${adr.id}-decision.md`),
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

test('fails closed when ADR identity authority reports a structural finding', () => {
  const root = fixture([{ id: 'ADR-9999', status: 'partial' }]);
  const result = run(
    root,
    'dev',
    { kind: 'adr-neutral', reason: 'Ordinary maintenance only' },
    {
      headRef: 'fix/maintenance',
      authorityFindings: [
        {
          code: 'adr-authority-adr-legacy-identity-not-grandfathered',
          message: 'ADR-9999 is not grandfathered',
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
  for (const name of [
    'ADR-9999-bypass.markdown',
    'ADR-9999-bypass.txt',
    'ADR-9999-bypass.MD',
  ]) {
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

test('feature dev PR requires a stage-ready or implemented delivery', () => {
  const root = fixture([{ id: 'ADR-0001', status: 'partial' }]);
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
      adrs: ['ADR-0001'],
      summary: 'Complete bounded storage stage',
      verification: ['storage contract tests'],
    },
    {
      headRef: 'feature/new-surface',
      changedFiles: ['adr/ADR-0001-decision.md'],
    },
  );
  assert.equal(delivery.ok, true);
});

test('implemented dev intent needs a staged/implemented qualified ADR', () => {
  const partialRoot = fixture([{ id: 'ADR-0001', status: 'partial' }]);
  const result = run(
    partialRoot,
    'dev',
    {
      kind: 'dev-delivery',
      intent: 'implemented',
      adrs: ['ADR-0001'],
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
    { id: 'ADR-0001', status: 'implemented', qualified: true },
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
  const root = fixture([{ id: 'ADR-0001', status: 'staged', qualified: true }]);
  const missingChange = run(root, 'alpha', {
    kind: 'alpha-settlement',
    progress: [
      {
        adr: 'ADR-0001',
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
          adr: 'ADR-0001',
          to: 'staged',
          summary: 'Stage is ready for alpha qualification',
        },
      ],
    },
    { changedFiles: ['adr/ADR-0001-decision.md'] },
  );
  assert.equal(settled.ok, true);
});

test('alpha allows an explicit no-ADR-progress settlement', () => {
  const root = fixture([
    { id: 'ADR-0001', status: 'implemented', qualified: true },
  ]);
  const result = run(root, 'alpha', {
    kind: 'alpha-settlement',
    no_adr_progress_reason: 'Promotion contains fixes only',
  });
  assert.equal(result.ok, true);
});

test('alpha rejects changed accepted ADRs omitted from settlement', () => {
  const root = fixture([
    { id: 'ADR-0001', status: 'staged', qualified: true },
    { id: 'ADR-0002', status: 'partial' },
  ]);
  const result = run(
    root,
    'alpha',
    {
      kind: 'alpha-settlement',
      progress: [
        {
          adr: 'ADR-0001',
          to: 'staged',
          summary: 'Stage is ready for alpha qualification',
        },
      ],
    },
    { changedFiles: ['adr/ADR-0001-decision.md', 'adr/ADR-0002-decision.md'] },
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === 'alpha-unsettled-change' && finding.adr === 'ADR-0002',
    ),
  );
});

test('stable blocks every unaccounted accepted ADR', () => {
  const root = fixture([
    { id: 'ADR-0001', status: 'implemented', qualified: true },
    { id: 'ADR-0002', status: 'staged' },
    { id: 'ADR-0003', status: 'not-started', decision: 'proposed' },
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
    ['ADR-0002'],
  );
});

test('stable admits an exact-release, exact-condition admin waiver', () => {
  const prUrl = 'https://github.com/kungfu-systems/kungfu/pull/99';
  const root = fixture(
    [{ id: 'ADR-0002', status: 'staged' }],
    [
      {
        waiver_id: 'KFW-4.0.0-001',
        release: '4.0.0',
        adr: 'ADR-0002',
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
    [{ id: 'ADR-0002', status: 'staged' }],
    [
      {
        waiver_id: 'KFW-4.0.0-001',
        release: '4.0.0',
        adr: 'ADR-0002',
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
  const root = fixture([{ id: 'ADR-0001', status: 'implemented' }]);
  const result = run(
    root,
    'stable',
    { kind: 'stable-admission', release: '4.0.0' },
    { prUrl: 'https://github.com/kungfu-systems/kungfu/pull/99' },
  );
  assert.deepEqual(result.blocked[0].conditions, ['qualification:missing']);
});
