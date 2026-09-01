// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectProductLayout,
  invokeAfterIdentitySettlement,
  runtimeReady,
} from './product_smoke.mjs';
import {
  boundedFailureTail,
  createLogBundle,
  defaultOutputDir,
  evaluateQualification,
  executeQualificationSuites,
  productDistributionCommand,
  qualificationPlan,
  retainQualificationArtifacts,
  suiteEnvironment,
  suiteInvocation,
  validateReport,
} from './run.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

test('profile admission runner references current tracked profile suites', () => {
  const runner = fs.readFileSync(
    path.join(ROOT, 'scripts', 'run-agent-profile-sdk-tests.mjs'),
    'utf8',
  );
  const suites = [
    'test_agent_profile_sdk.py',
    'test_profile_composition.py',
    'test_work_control_profile.py',
  ];

  assert.doesNotMatch(runner, /test_mission_control_profile\.py/u);
  for (const suite of suites) {
    assert.match(runner, new RegExp(suite.replace('.', '\\.'), 'u'));
    assert.equal(
      fs.existsSync(
        path.join(ROOT, 'framework', 'core', 'tests', 'python', suite),
      ),
      true,
      `${suite} must remain tracked`,
    );
  }
});

test('failed suites print only a bounded normalized log tail', () => {
  assert.equal(
    boundedFailureTail('first\r\nsecond\r\nthird\r\nfourth\r\n', {
      maxBytes: 1024,
      maxLines: 2,
    }),
    'third\nfourth',
  );
  assert.equal(boundedFailureTail('', { maxBytes: 1024, maxLines: 2 }), '');
});

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
  assert.deepEqual(verification.command.slice(1), [
    'verify',
    '--with-app',
    '--skip-episode-qualification',
  ]);
  assert.equal(verification.command.includes('--full'), false);
});

test('product catalog qualification is bound to the build from this checkout', () => {
  const catalog = qualificationPlan({
    mode: 'execute',
    withProduct: true,
  }).find((suite) => suite.id === 'product-catalog');
  assert.deepEqual(catalog.command.slice(1), [
    'builds',
    '--json',
    '--verify-current',
  ]);
});

test('runtime activation settles source suites before the product rebuild and consumers', async () => {
  const suites = qualificationPlan({ mode: 'execute', withProduct: true });
  const events = [];
  let active = 0;
  let peak = 0;
  const runner = async (suite) => {
    active += 1;
    peak = Math.max(peak, active);
    events.push(`start:${suite.id}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    events.push(`end:${suite.id}`);
    active -= 1;
    return {
      ...suite,
      status: suite.id === 'profile-action-admission' ? 'failed' : 'passed',
      exit_code: suite.id === 'profile-action-admission' ? 1 : 0,
      duration_ms: 2,
      raw_log: `${suite.id}.log`,
      raw_sha256: 'a'.repeat(64),
    };
  };
  const result = await executeQualificationSuites(suites, '/unused', runner, 2);
  assert.equal(peak, 2);
  assert.deepEqual(
    result.map((suite) => suite.id),
    suites.map((suite) => suite.id),
  );
  assert.equal(
    result.find((suite) => suite.id === 'profile-action-admission').status,
    'failed',
  );
  assert.ok(result.every((suite) => suite.status !== 'planned'));
  const productStart = events.indexOf('start:product-distribution');
  for (const id of [
    'activation-core',
    'profile-action-admission',
    'runtime-surface-parity',
    'activation-performance',
  ])
    assert.ok(events.indexOf(`end:${id}`) < productStart, id);
  const firstConsumer = Math.min(
    ...['product-runtime-smoke', 'product-verification', 'product-catalog'].map(
      (id) => events.indexOf(`start:${id}`),
    ),
  );
  assert.ok(
    events.indexOf('end:product-distribution') < firstConsumer,
    'product-distribution',
  );
});

test('source qualification uv runs preserve the exact tracked lockfile', () => {
  const uvSuites = qualificationPlan({
    mode: 'execute',
    withProduct: true,
  }).filter((suite) => suite.command.includes('uv'));
  assert.ok(uvSuites.length > 0);
  for (const suite of uvSuites) {
    assert.ok(suite.command.includes('--frozen'), suite.id);
  }
});

test('sealed release qualification verifies the prebuilt product without rebuilding it', () => {
  const root = `sha256:${'a'.repeat(64)}`;
  const command = productDistributionCommand({
    KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACTS: '1',
    KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACT_ROOT: root,
  });
  assert.equal(command.includes('dist'), false);
  assert.deepEqual(command.slice(-3), [
    'artifact-root-check',
    '--expected-root',
    root,
  ]);
  assert.deepEqual(productDistributionCommand({}), [
    process.platform === 'win32' ? 'shifu.cmd' : './shifu',
    'dist',
  ]);
  assert.throws(
    () =>
      productDistributionCommand({
        KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACTS: '1',
      }),
    /requires an exact release artifact root/u,
  );
});

test('only source-tree Python suites allow the hosted qualification interpreter', () => {
  const baseEnv = { Path: 'C:\\Windows\\System32', CUSTOM_MARKER: 'preserved' };
  for (const id of ['activation-core', 'activation-performance']) {
    const env = suiteEnvironment({ id }, baseEnv);
    assert.equal(env.KUNGFU_ALLOW_FOREIGN_RUNTIME, '1');
    assert.equal(env.Path, baseEnv.Path);
    assert.equal(env.CUSTOM_MARKER, 'preserved');
  }
  for (const id of ['product-distribution', 'product-runtime-smoke']) {
    const env = suiteEnvironment({ id }, baseEnv);
    assert.equal(env.KUNGFU_ALLOW_FOREIGN_RUNTIME, undefined);
  }
  assert.equal(baseEnv.KUNGFU_ALLOW_FOREIGN_RUNTIME, undefined);
});

test('Windows suites invoke the repository Shifu shim through ComSpec', () => {
  const invocation = suiteInvocation(
    { command: ['shifu.cmd', 'exec', 'argument with spaces'] },
    {
      platform: 'win32',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      env: {},
    },
  );
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    invocation.args[3],
    'call shifu.cmd exec "argument with spaces"',
  );
});

test('product smoke does not report runtime readiness before both identities settle', () => {
  assert.equal(
    runtimeReady({
      supervisor: { running: true, identityVerified: true },
      coordinator: { running: true, identityVerified: false },
    }),
    false,
  );
  assert.equal(
    runtimeReady({
      supervisor: { running: true, identityVerified: false },
      coordinator: { running: true, identityVerified: true },
    }),
    false,
  );
  assert.equal(
    runtimeReady({
      supervisor: { running: true, identityVerified: true },
      coordinator: { running: true, identityVerified: true },
    }),
    true,
  );
});

test('product smoke proves the assembled marker, Rust entry, and real CPython layout', (t) => {
  const product = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-product-layout-'),
  );
  t.after(() => fs.rmSync(product, { recursive: true, force: true }));
  const pythonRoot = path.join(product, 'python');
  fs.mkdirSync(path.join(pythonRoot, 'bin'), { recursive: true });
  const trunkBytes = Buffer.from('rust-trunk-entry');
  fs.writeFileSync(path.join(product, 'kungfu'), trunkBytes);
  fs.writeFileSync(path.join(product, 'kungfu-trunk'), trunkBytes);
  fs.writeFileSync(path.join(pythonRoot, 'bin', 'python3'), 'cpython');
  fs.writeFileSync(
    path.join(pythonRoot, 'kungfu-host.json'),
    JSON.stringify({
      schema: 'kungfu.host/v1',
      form: 'assembled',
      product_root: '..',
    }),
  );

  const layout = inspectProductLayout(product, {
    platform: 'darwin',
    environment: {},
  });

  assert.equal(layout.host.form, 'assembled');
  assert.equal(layout.entry.kind, 'rust-trunk');
  assert.equal(layout.python.interpreter, 'python/bin/python3');
  assert.deepEqual(layout.retiredPackagerEnvironmentKeys, []);
});

test('product smoke rejects retired packager process state', (t) => {
  const product = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-product-state-'),
  );
  t.after(() => fs.rmSync(product, { recursive: true, force: true }));
  const pythonRoot = path.join(product, 'python');
  fs.mkdirSync(path.join(pythonRoot, 'bin'), { recursive: true });
  for (const name of ['kungfu', 'kungfu-trunk']) {
    fs.writeFileSync(path.join(product, name), 'rust-trunk-entry');
  }
  fs.writeFileSync(path.join(pythonRoot, 'bin', 'python3'), 'cpython');
  fs.writeFileSync(
    path.join(pythonRoot, 'kungfu-host.json'),
    JSON.stringify({
      schema: 'kungfu.host/v1',
      form: 'assembled',
      product_root: '..',
    }),
  );
  const retiredKey = ['PY', 'INSTALLER', '_RESET_ENVIRONMENT'].join('');

  assert.throws(
    () =>
      inspectProductLayout(product, {
        platform: 'darwin',
        environment: { [retiredKey]: '1' },
      }),
    /retired product packager state is present/u,
  );
});

test('product smoke waits for a transient runtime identity handoff without bypassing preflight', () => {
  const calls = [];
  const result = invokeAfterIdentitySettlement(
    (_home, _configHome, args) => {
      calls.push(args);
      if (calls.length === 1) {
        throw new Error('runtime_identity_unverified: coordinator is starting');
      }
      if (args[1] === 'status') {
        return { payload: { coordinator: { running: true } } };
      }
      return { payload: { changed: false } };
    },
    'home',
    'config',
    ['runtime', 'ensure', '--json'],
    { attempts: 2, wait: () => calls.push(['wait']) },
  );

  assert.deepEqual(result, { payload: { changed: false } });
  assert.deepEqual(calls, [
    ['runtime', 'ensure', '--json'],
    ['runtime', 'status', '--json'],
    ['wait'],
    ['runtime', 'ensure', '--json'],
  ]);
});

test('product smoke settles when status inspection shares the transient identity handoff', () => {
  const calls = [];
  let ensureAttempts = 0;
  const identityError = new Error(
    'runtime_identity_unverified: coordinator is starting',
  );
  const result = invokeAfterIdentitySettlement(
    (_home, _configHome, args) => {
      calls.push(args);
      if (args[1] === 'status') throw identityError;
      ensureAttempts += 1;
      if (ensureAttempts === 1) throw identityError;
      return { payload: { changed: false } };
    },
    'home',
    'config',
    ['runtime', 'ensure', '--json'],
    { attempts: 2, wait: () => calls.push(['wait']) },
  );

  assert.deepEqual(result, { payload: { changed: false } });
  assert.deepEqual(calls, [
    ['runtime', 'ensure', '--json'],
    ['runtime', 'status', '--json'],
    ['wait'],
    ['runtime', 'ensure', '--json'],
  ]);
});

test('product smoke keeps persistent or unrelated identity failures fail-closed', () => {
  const persistent = new Error(
    'runtime_identity_unverified: coordinator identity never settled',
  );
  let attempts = 0;
  let statusAttempts = 0;
  assert.throws(
    () =>
      invokeAfterIdentitySettlement(
        (_home, _configHome, args) => {
          if (args[1] === 'status') {
            statusAttempts += 1;
            throw persistent;
          }
          attempts += 1;
          throw persistent;
        },
        'home',
        'config',
        ['runtime', 'ensure', '--json'],
        { attempts: 2 },
      ),
    (error) => error === persistent,
  );
  assert.equal(attempts, 2);
  assert.equal(statusAttempts, 2);

  assert.throws(
    () =>
      invokeAfterIdentitySettlement(
        () => {
          throw new Error('runtime_route_stale');
        },
        'home',
        'config',
        ['runtime', 'ensure', '--json'],
      ),
    /runtime_route_stale/,
  );
});

test('Windows suite invocation rejects cmd expansion syntax', () => {
  assert.throws(
    () =>
      suiteInvocation(
        { command: ['shifu.cmd', 'exec', 'task%PATH%'] },
        { platform: 'win32', env: {} },
      ),
    /unsafe cmd syntax/,
  );
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
