// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  QUALIFICATION_SUITES,
  evaluateQualification,
  qualificationSuiteEnvironment,
  qualificationSuiteInvocation,
  runSuite,
  validateComponentEvidence,
} from './run-zero-burden-product-qualification.mjs';

const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-zero-burden-'));
  const directory = path.join(root, 'component');
  fs.mkdirSync(directory);
  const bundle = Buffer.from('retained raw signal');
  fs.writeFileSync(path.join(directory, 'raw-logs.jsonl.gz'), bundle);
  fs.writeFileSync(
    path.join(directory, 'report.json'),
    JSON.stringify({
      verdict: 'passed',
      source: { revision: 'abc' },
      platform: { os: 'darwin', arch: 'arm64' },
      artifacts: {
        log_bundle: { path: 'raw-logs.jsonl.gz', sha256: sha256(bundle) },
      },
      claims: { product_artifacts_verified: true },
    }),
  );
  return { root, directory };
}

test('component evidence requires an adjacent digest-bound raw bundle', (t) => {
  const { root, directory } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const component = validateComponentEvidence(
    root,
    { id: 'runtime-activation', directory: 'component' },
    { sourceRevision: 'abc', platform: { os: 'darwin', arch: 'arm64' } },
  );
  assert.equal(component.verdict, 'passed');
  fs.writeFileSync(path.join(directory, 'raw-logs.jsonl.gz'), 'tampered');
  assert.throws(
    () =>
      validateComponentEvidence(
        root,
        { id: 'runtime-activation', directory: 'component' },
        { sourceRevision: 'abc', platform: { os: 'darwin', arch: 'arm64' } },
      ),
    /digest does not match/,
  );
});

test('aggregate qualification preserves product and non-claim boundaries', () => {
  const report = evaluateQualification({
    source: { revision: 'abc', tree: 'def', dirty: false },
    platform: { os: 'darwin', arch: 'arm64', release: 'test' },
    components: [
      { id: 'live-peer-continuity', verdict: 'passed', claims: {} },
      {
        id: 'runtime-activation',
        verdict: 'passed',
        claims: { product_artifacts_verified: true },
      },
    ],
    suites: [
      { id: 'agent-session-control-plane', status: 'passed' },
      { id: 'frontend-product-presentation', status: 'passed' },
    ],
    bundle: { path: 'raw-logs.jsonl.gz', sha256: 'abc' },
  });
  assert.equal(report.verdict, 'passed');
  assert.equal(report.claims.normal_single_host_zero_burden_runtime, true);
  assert.equal(report.claims.product_artifacts_verified, true);
  assert.equal(report.claims.authenticated_provider_dogfood, false);
  assert.equal(report.claims.interactive_gui_lifecycle, false);
});

test('aggregate control-plane coverage is independent of installed provider CLIs', () => {
  const suite = QUALIFICATION_SUITES.find(
    ({ id }) => id === 'agent-session-control-plane',
  );
  assert.deepEqual(suite.command.slice(1), [
    '--filter',
    '@kungfu-tech/agent-session',
    'test:control-plane',
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'framework/agent-session/package.json'),
      'utf8',
    ),
  );
  assert.match(
    manifest.scripts['test:control-plane'],
    /skip-pattern=installed/u,
  );
  assert.match(manifest.scripts['test:control-plane'], /--test-concurrency=1/u);
});

test('qualification suites restore the stable host temp for process endpoints', () => {
  const inherited = {
    TMPDIR: '/repo/.buildchain/tmp',
    TEMP: '/repo/.buildchain/tmp',
    TMP: '/repo/.buildchain/tmp',
    KUNGFU_QUALIFICATION_HOST_TEMP: '/runner/temp',
    KUNGFU_BUILDCHAIN_SOURCE_BUILD: '1',
  };
  const environment = qualificationSuiteEnvironment(inherited);
  assert.equal(environment.TMPDIR, '/runner/temp');
  assert.equal(environment.TEMP, '/runner/temp');
  assert.equal(environment.TMP, '/runner/temp');
  assert.equal(environment.KUNGFU_BUILDCHAIN_SOURCE_BUILD, '1');
  assert.equal(inherited.TMPDIR, '/repo/.buildchain/tmp');
});

test('Windows suites invoke the repository Shifu shim through ComSpec', () => {
  const invocation = qualificationSuiteInvocation(
    { command: ['shifu.cmd', '--filter', 'workspace with spaces', 'test'] },
    {
      platform: 'win32',
      root: 'C:\\kungfu checkout',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      env: {},
    },
  );
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, [
    '/d',
    '/s',
    '/c',
    'call',
    'C:\\kungfu checkout\\shifu.cmd',
    '--filter',
    'workspace with spaces',
    'test',
  ]);
});

test('Windows suite invocation rejects cmd expansion syntax', () => {
  assert.throws(
    () =>
      qualificationSuiteInvocation(
        { command: ['shifu.cmd', 'test%PATH%'] },
        { platform: 'win32', root: 'C:\\kungfu', env: {} },
      ),
    /unsafe cmd syntax/,
  );
});

test('qualification suites tee live output into retained raw evidence', async (t) => {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-zero-burden-suite-'),
  );
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const liveStdout = [];
  const liveStderr = [];
  const result = await runSuite(
    {
      id: 'live-tee-fixture',
      command: [
        process.execPath,
        '-e',
        "process.stdout.write('visible stdout\\n'); process.stderr.write('visible stderr\\n')",
      ],
    },
    outputDir,
    {
      timeoutMs: 5_000,
      stdout: { write: (chunk) => liveStdout.push(chunk.toString('utf8')) },
      stderr: { write: (chunk) => liveStderr.push(chunk.toString('utf8')) },
    },
  );
  assert.equal(result.status, 'passed');
  assert.equal(result.timed_out, false);
  assert.match(liveStdout.join(''), /visible stdout/u);
  assert.match(liveStderr.join(''), /visible stderr/u);
  const retained = fs.readFileSync(
    path.join(outputDir, result.raw_log),
    'utf8',
  );
  assert.match(retained, /visible stdout/u);
  assert.match(retained, /visible stderr/u);
  assert.equal(result.raw_sha256, sha256(Buffer.from(retained)));
});

test('qualification suites fail boundedly and retain timeout diagnostics', async (t) => {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-zero-burden-timeout-'),
  );
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const liveStderr = [];
  const result = await runSuite(
    {
      id: 'timeout-fixture',
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    },
    outputDir,
    {
      timeoutMs: 100,
      stdout: { write: () => {} },
      stderr: { write: (chunk) => liveStderr.push(chunk.toString('utf8')) },
    },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.timed_out, true);
  assert.match(liveStderr.join(''), /timed_out_after_ms=100/u);
  assert.match(
    fs.readFileSync(path.join(outputDir, result.raw_log), 'utf8'),
    /timed_out_after_ms=100/u,
  );
});

test('native Windows qualification reaps only its exact test-owned process tree', () => {
  for (const relative of [
    'framework/agent-session/tests/runtime-port.native.test.mjs',
    'framework/agent-session/tests/capsule-worker.test.mjs',
    'framework/agent-session/tests/codex-app-server-runtime.test.mjs',
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
    assert.match(source, /'taskkill\.exe'/u, relative);
    assert.match(
      source,
      /\['\/pid', String\((?:pid|child\.pid)\), '\/t', '\/f'\]/u,
      relative,
    );
    assert.doesNotMatch(source, /\/im/u, relative);
  }
});

test('provider approval dogfood delegates confirmation to the permission system', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts/run-agent-session-provider-dogfood.mjs'),
    'utf8',
  );
  assert.doesNotMatch(source, /Request confirmation instead of explaining/u);
  assert.match(
    source,
    /Do not use another tool or merely describe the command/u,
  );
});
