// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createLogBundle,
  defaultOutputDir,
  evaluateQualification,
  qualificationPlan,
  retainQualificationArtifacts,
  validateReport,
} from './run.mjs';

test('default evidence survives Core build-directory cleanup', () => {
  const output = defaultOutputDir('runtime-activation-test');
  assert.match(
    output,
    /\.buildchain[/\\]runtime[/\\]qualification[/\\]runtime-activation/,
  );
  assert.doesNotMatch(output, /framework[/\\]core[/\\]build/);
});

function source(dirty = false) {
  return {
    revision: '1'.repeat(40),
    tree: '2'.repeat(40),
    dirty,
  };
}

function platform() {
  return { os: 'darwin', arch: 'arm64', release: 'qualification-test' };
}

function suites(mode = 'execute', withProduct = true, failed = null) {
  return qualificationPlan({ mode, withProduct }).map((suite) => ({
    ...suite,
    status:
      suite.id === failed
        ? 'failed'
        : mode === 'dry-run'
          ? 'planned'
          : suite.required
            ? 'passed'
            : 'skipped',
    exit_code:
      mode === 'dry-run' || !suite.required
        ? null
        : suite.id === failed
          ? 1
          : 0,
    duration_ms: mode === 'dry-run' || !suite.required ? 0 : 1,
    raw_log: mode === 'dry-run' || !suite.required ? null : `${suite.id}.log`,
    raw_sha256: mode === 'dry-run' || !suite.required ? null : 'a'.repeat(64),
  }));
}

function report(overrides = {}) {
  const mode = overrides.mode || 'execute';
  const withProduct = overrides.withProduct ?? true;
  return evaluateQualification({
    mode,
    withProduct,
    source: overrides.source || source(),
    platform: platform(),
    suites:
      overrides.suites || suites(mode, withProduct, overrides.failed || null),
    runId: 'runtime-activation-test',
  });
}

test('dry-run plans every Shifu-owned qualification step without claims', () => {
  const value = report({ mode: 'dry-run' });
  validateReport(value);
  assert.equal(value.verdict, 'planned');
  assert.ok(
    value.suites.every((suite) => /shifu(?:\.cmd)?$/.test(suite.command[0])),
  );
  assert.ok(Object.values(value.claims).every((claim) => claim === false));
});

test('product verification checks the distribution outputs without rebuilding them', () => {
  const verification = qualificationPlan({
    mode: 'execute',
    withProduct: true,
  }).find((suite) => suite.id === 'product-verification');
  assert.deepEqual(verification.command.slice(1), ['verify', '--with-app']);
  assert.equal(verification.command.includes('--full'), false);
});

test('clean passing source qualifies exact product artifacts with bounded claims', () => {
  const value = report();
  validateReport(value);
  assert.equal(value.verdict, 'passed');
  assert.ok(value.coverage.every((item) => item.status === 'passed'));
  assert.equal(value.claims.native_readiness_publication, true);
  assert.equal(value.claims.product_artifacts_verified, true);
  assert.equal(value.claims.embedded_runtime_host, false);
});

test('omitted products and dirty source fail closed as unqualified', () => {
  const omitted = report({ withProduct: false });
  const dirty = report({ source: source(true) });
  validateReport(omitted);
  validateReport(dirty);
  assert.equal(omitted.verdict, 'unqualified');
  assert.match(omitted.violations.join('\n'), /product artifact/);
  assert.equal(dirty.verdict, 'unqualified');
  assert.match(dirty.violations.join('\n'), /dirty/);
  assert.ok(Object.values(dirty.claims).every((claim) => claim === false));
});

test('one failed suite fails its coverage and every supported claim', () => {
  const value = report({ failed: 'activation-core' });
  validateReport(value);
  assert.equal(value.verdict, 'failed');
  assert.equal(
    value.coverage.find((item) => item.id === 'native-readiness-publication')
      .status,
    'failed',
  );
  assert.ok(Object.values(value.claims).every((claim) => claim === false));
});

test('raw logs are retained as a checksummed gzip bundle beside the report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-log-bundle-'));
  const output = path.join(root, 'output');
  const retained = path.join(root, 'retained');
  try {
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'activation-core.log'), 'core output\n');
    fs.writeFileSync(
      path.join(output, 'product-catalog.log'),
      'catalog output\n',
    );
    const bundle = createLogBundle(output, [
      { id: 'activation-core', raw_log: 'activation-core.log' },
      { id: 'product-catalog', raw_log: 'product-catalog.log' },
    ]);
    assert.equal(bundle.path, 'raw-logs.jsonl.gz');
    assert.equal(bundle.entries.length, 2);
    assert.match(bundle.sha256, /^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(output, 'report.json'), '{}\n');
    retainQualificationArtifacts(output, retained, [
      'report.json',
      bundle.path,
    ]);
    assert.deepEqual(fs.readdirSync(retained).sort(), [
      'raw-logs.jsonl.gz',
      'report.json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
