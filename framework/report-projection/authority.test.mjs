// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  digest,
  projectorDecision,
  reportRoot,
  verifyAuthorityBinding,
  verifyBundle,
  verifyReceipt,
} from './authority.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const currentRevision = spawnSync('git', ['rev-parse', 'HEAD^{commit}'], {
  cwd: ROOT,
  encoding: 'utf8',
}).stdout.trim();

function synthetic() {
  const reportBody = {
    schema: 'kungfu.synthetic-report/v1',
    sourceRevision: currentRevision,
    sourceRoot: digest({ source: 'candidate' }),
    result: 'pass',
  };
  const report = { ...reportBody, reportRoot: digest(reportBody) };
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const receiptBody = {
    schema: 'kungfu.generated-report-receipt/v1',
    reportId: 'synthetic',
    reportSchema: report.schema,
    sourceRevision: currentRevision,
    sourceRoot: report.sourceRoot,
    reportRoot: report.reportRoot,
    artifactRoot: digest(reportBytes),
    artifactPath: `reports/synthetic/${digest(reportBytes).slice(7)}.json`,
    artifactBytes: reportBytes.length,
    generator: { files: [], root: digest([]) },
    policy: { files: [], root: digest([]) },
    baseline: { kind: 'synthetic', root: digest('baseline') },
    authorityRoot: digest('authority'),
  };
  return {
    report,
    receipt: { ...receiptBody, receiptRoot: digest(receiptBody) },
  };
}

test('receipt binds exact source, source root, report, generator, policy, and baseline', () => {
  const { report, receipt } = synthetic();
  assert.equal(verifyReceipt(receipt, report), true);
  assert.equal(reportRoot(report), report.reportRoot);
  for (const key of [
    'sourceRevision',
    'sourceRoot',
    'reportRoot',
    'generator',
    'policy',
    'baseline',
    'authorityRoot',
  ])
    assert.ok(receipt[key], key);
});

test('tampered bytes and forged report roots fail closed', () => {
  const { report, receipt } = synthetic();
  assert.throws(
    () => verifyReceipt(receipt, { ...report, result: 'fail' }),
    /artifact root mismatch|report root/,
  );
  assert.throws(
    () => reportRoot({ ...report, reportRoot: digest('forged') }),
    /invalid embedded reportRoot/,
  );
});

test('forged generator, policy, baseline, or aggregate authority roots fail closed', () => {
  const { receipt } = synthetic();
  const expected = {
    generator: receipt.generator,
    policy: receipt.policy,
    baseline: receipt.baseline,
    authorityRoot: receipt.authorityRoot,
  };
  assert.equal(verifyAuthorityBinding(receipt, expected), true);
  for (const key of ['generator', 'policy', 'baseline', 'authorityRoot']) {
    const forged = structuredClone(receipt);
    forged[key] =
      key === 'authorityRoot' ? digest('forged') : { root: digest('forged') };
    assert.throws(
      () => verifyAuthorityBinding(forged, expected),
      new RegExp(`${key} binding mismatch`),
    );
  }
});

test('historical consumers verify immutable content without reinterpreting it as current', () => {
  const { report, receipt } = synthetic();
  const historicalRevision = '1'.repeat(40);
  report.sourceRevision = historicalRevision;
  const reportBody = Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== 'reportRoot'),
  );
  report.reportRoot = digest(reportBody);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  receipt.sourceRevision = historicalRevision;
  receipt.reportRoot = report.reportRoot;
  receipt.artifactRoot = digest(reportBytes);
  receipt.artifactPath = `reports/synthetic/${receipt.artifactRoot.slice(7)}.json`;
  receipt.artifactBytes = reportBytes.length;
  const body = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptRoot'),
  );
  receipt.receiptRoot = digest(body);
  assert.throws(
    () => verifyReceipt(receipt, report),
    /source revision mismatch/,
  );
  assert.equal(verifyReceipt(receipt, report, { historical: true }), true);
});

test('projector publishes only the expected protected head', () => {
  const expected = 'a'.repeat(40);
  assert.equal(projectorDecision(expected, expected), 'publish');
  assert.equal(projectorDecision(expected, 'b'.repeat(40)), 'discard-stale');
  assert.throws(() => projectorDecision('not-a-sha', expected), /full commit/);
});

test('missing report artifacts and duplicate receipts fail closed', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'generated-report-authority.'),
  );
  try {
    const { receipt } = synthetic();
    const receiptPath = `receipts/${receipt.receiptRoot.slice(7)}.json`;
    fs.mkdirSync(path.join(temporary, 'receipts'), { recursive: true });
    fs.writeFileSync(
      path.join(temporary, receiptPath),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    const pointers = [
      {
        reportId: receipt.reportId,
        receiptPath,
        receiptRoot: receipt.receiptRoot,
      },
    ];
    const body = {
      schema: 'kungfu.generated-report-bundle/v1',
      projectionKind: 'candidate',
      sourceRevision: currentRevision,
      inventoryPath: 'synthetic',
      inventoryRoot: digest('synthetic'),
      receipts: pointers,
    };
    const bundlePath = path.join(temporary, 'bundle.json');
    fs.writeFileSync(
      bundlePath,
      `${JSON.stringify({ ...body, bundleRoot: digest(body) }, null, 2)}\n`,
    );
    assert.throws(
      () => verifyBundle(bundlePath, { historical: true }),
      /ENOENT/,
    );

    body.receipts = [...pointers, ...pointers];
    fs.writeFileSync(
      bundlePath,
      `${JSON.stringify({ ...body, bundleRoot: digest(body) }, null, 2)}\n`,
    );
    assert.throws(
      () => verifyBundle(bundlePath, { historical: true }),
      /duplicate report receipt/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('workflow coalesces, cancels stale work, CAS-checks dev, and never writes the branch', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/report-projection.yml'),
    'utf8',
  );
  assert.match(workflow, /merge_group:/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /git ls-remote origin/);
  assert.match(workflow, /projector-decision/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.doesNotMatch(workflow, /contents: write|git push/);
  assert.doesNotMatch(workflow, /aws-us|macos-/);
});

test('tracked projections are explicitly historical and ordinary PRs do not update them', () => {
  const inventory = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'framework/report-projection/authority.json'),
      'utf8',
    ),
  );
  assert.equal(
    inventory.projectionContract.ordinaryPullRequestUpdatesTrackedReports,
    false,
  );
  assert.deepEqual(
    inventory.reports.map(({ id }) => id),
    ['abstraction-integrity', 'function-risk', 'semantic-amplification'],
  );
  for (const report of inventory.reports) {
    if (report.legacyProjection) {
      assert.match(report.legacyProjection.sourceRevision, /^[0-9a-f]{40}$/);
      assert.match(
        report.legacyProjection.artifactRoot,
        /^sha256:[0-9a-f]{64}$/,
      );
      assert.match(
        report.legacyProjection.disposition,
        /historical|compatibility/u,
      );
    } else {
      assert.equal(report.id, 'function-risk');
    }
  }
  assert.equal(
    inventory.currentNavigation.command,
    './shifu maintainability:function-risk --json',
  );
});

test('PR 2337 report-only conflict replays as source-only work without a heavy rerun', () => {
  const evidence = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'docs/qualification/evidence/generated-report-authority-queue/report.json',
      ),
      'utf8',
    ),
  );
  assert.equal(evidence.verdict, 'pass');
  assert.equal(evidence.case.pullRequest, 2337);
  assert.deepEqual(evidence.case.observedConflictPaths, [
    'framework/maintainability/abstraction-integrity-report.json',
  ]);
  assert.equal(evidence.replay.sourceOnlyApplyCheck, 'pass');
  assert.equal(evidence.replay.nativeBuildRequired, false);
  assert.equal(evidence.replay.heavyQualificationRerunRequired, false);

  const first = Buffer.from('{"candidate":1}\n');
  const second = Buffer.from('{"candidate":2}\n');
  assert.notEqual(digest(first), digest(second));
  assert.notEqual(
    `reports/example/${digest(first).slice(7)}.json`,
    `reports/example/${digest(second).slice(7)}.json`,
  );
});
