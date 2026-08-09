// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildAlphaSettlementManifest,
  formatAlphaSettlementPrefix,
  parsePrManifest,
  renderAlphaSettlement,
} from './adr-release-gate.mjs';

const ADR_A = 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910';
const ADR_B = 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a';

function runGit(root, args) {
  return childProcess
    .execFileSync(
      'git',
      [
        '-c',
        'user.name=Kungfu Test',
        '-c',
        'user.email=kungfu-test@example.invalid',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    .trim();
}

function adr(id, implementationStatus) {
  return `---
adr_id: ${id}
decision_status: accepted
implementation_status: ${implementationStatus}
qualification_refs: [tests/exact-source-receipt.json]
---

# Fixture
`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-settlement-'));
  fs.mkdirSync(path.join(root, 'docs', 'adr'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'adr-release.contract.json'),
    `${JSON.stringify(
      {
        schema: 'kungfu.adr-release-contract/v1',
        manifestSchema: 'kungfu.adr-release-pr/v1',
        manifestMarker: 'kungfu-adr-release:v1',
        repository: 'kungfu-systems/kungfu',
        adrRoots: ['docs/adr'],
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
          waiverApprovers: ['dongkeren'],
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'docs', 'adr-release-waivers.json'),
    '{"schema":"kungfu.adr-release-waivers/v1","waivers":[]}\n',
  );
  const adrPath = path.join(root, 'docs', 'adr', `${ADR_A}.md`);
  fs.writeFileSync(adrPath, adr(ADR_A, 'partial'));
  runGit(root, ['init', '-q']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'base']);
  const baseSha = runGit(root, ['rev-parse', 'HEAD']);
  runGit(root, ['update-ref', 'refs/remotes/origin/alpha/v4/v4.0', baseSha]);
  fs.writeFileSync(adrPath, adr(ADR_A, 'staged'));
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'candidate']);
  return {
    root,
    selectedSha: runGit(root, ['rev-parse', 'HEAD']),
    outputPath: path.join(root, 'result', 'prefix.md'),
  };
}

test('manifest deterministically settles every changed accepted ADR', () => {
  const adrs = new Map([
    [
      ADR_B,
      {
        id: ADR_B,
        file: `docs/adr/${ADR_B}.md`,
        decisionStatus: 'accepted',
        implementationStatus: 'implemented',
      },
    ],
    [
      ADR_A,
      {
        id: ADR_A,
        file: `docs/adr/${ADR_A}.md`,
        decisionStatus: 'accepted',
        implementationStatus: 'staged',
      },
    ],
  ]);
  const manifest = buildAlphaSettlementManifest(adrs, [
    `docs/adr/${ADR_B}.md`,
    `docs/adr/${ADR_A}.md`,
  ]);
  assert.deepEqual(
    manifest.progress.map((entry) => [entry.adr, entry.to]),
    [
      [ADR_A, 'staged'],
      [ADR_B, 'implemented'],
    ],
  );
  assert.deepEqual(
    parsePrManifest(
      formatAlphaSettlementPrefix(manifest),
      'kungfu-adr-release:v1',
    ),
    manifest,
  );
});

test('manifest declares no progress only when no accepted ADR changed', () => {
  const manifest = buildAlphaSettlementManifest(new Map(), ['src/fix.cc']);
  assert.equal(manifest.progress, undefined);
  assert.match(
    manifest.no_adr_progress_reason,
    /no accepted ADR record changes/u,
  );
});

test('large exact-source settlement stays within the Buildchain renderer limit', () => {
  const adrs = new Map();
  const changedFiles = [];
  for (let index = 0; index < 200; index += 1) {
    const id = `KF-ADR-${String(index).padStart(36, '0')}`;
    const file = `docs/adr/${id}.md`;
    adrs.set(id, {
      id,
      file,
      decisionStatus: 'accepted',
      implementationStatus: 'implemented',
    });
    changedFiles.push(file);
  }
  const prefix = formatAlphaSettlementPrefix(
    buildAlphaSettlementManifest(adrs, changedFiles),
  );
  assert.ok(Buffer.byteLength(`${prefix}\n`, 'utf8') <= 32_768);
});

test('renderer binds the exact checkout and target delta', () => {
  const row = fixture();
  const result = renderAlphaSettlement({
    ...row,
    targetBranch: 'alpha/v4/v4.0',
  });
  assert.deepEqual(
    result.manifest.progress.map((entry) => [entry.adr, entry.to]),
    [[ADR_A, 'staged']],
  );
  assert.equal(fs.readFileSync(row.outputPath, 'utf8'), `${result.prefix}\n`);
  assert.throws(
    () =>
      renderAlphaSettlement({
        ...row,
        selectedSha: 'f'.repeat(40),
        targetBranch: 'alpha/v4/v4.0',
      }),
    /checkout HEAD does not match/u,
  );
});
