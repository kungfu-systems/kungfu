// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkShifuCacheContract } from './check-shifu-cache-contract.mjs';
import {
  cacheDoctor,
  cacheStatus,
  cacheUnset,
  cacheUse,
  probeHttp,
} from './shifu-cache-operations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_MJS = path.join(ROOT, 'shifu.mjs');
const SHIFU_SH = path.join(ROOT, 'shifu');

function platformId() {
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  if (process.platform === 'win32') return `windows-${process.arch}`;
  return `${process.platform}-${process.arch}`;
}

function shellHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-auto-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fnm = path.join(bin, 'fnm');
  fs.writeFileSync(
    fnm,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIFU_TEST_TRACE"
if [ "$1" = install ]; then exit 0; fi
if [ "$1" = exec ]; then
  shift
  [ "\${1:-}" = --using-file ] && shift
  [ "\${1:-}" = -- ] && shift
  if [ "\${1:-}" = node ]; then shift; exec "$SHIFU_TEST_NODE" "$@"; fi
  if [ "\${1:-}" = corepack ] && [ "\${2:-}" = pnpm ]; then
    shift 2
    printf 'active=%s\\nregistry=%s\\nuv=%s\\nargs=%s\\n' "$SHIFU_CACHE_ACTIVE" "$COREPACK_NPM_REGISTRY" "$UV_DEFAULT_INDEX" "$*" > "$SHIFU_TEST_EVIDENCE"
    exit 0
  fi
fi
exit 64
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'uv'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const profile = {
    $schema: 'https://libkungfu.dev/schemas/shifu/cache-profile-v1.schema.json',
    schema: 'shifu.cache-profile/v1',
    profileId: 'test.auto-apply',
    revision: 1,
    generatedAt: '2026-07-13T00:00:00Z',
    authority: {
      owner: 'test',
      sourceRef: 'test/auto-apply',
      sourceDigest: `sha256:${'1'.repeat(64)}`,
    },
    subject: {
      principal: 'test:developer',
      platforms: [platformId()],
      scopes: ['development', 'self-hosted-runner', 'ci'],
    },
    policy: {
      mode: 'require',
      onUnavailable: 'fail',
      allowPublicFallback: false,
      secretPolicy: 'references-only',
    },
    services: {
      npm: {
        kind: 'package-registry',
        mode: 'require',
        endpoint: { type: 'http', url: 'http://cache.example.invalid/npm/' },
        bindings: [
          {
            kind: 'environment',
            key: 'COREPACK_NPM_REGISTRY',
            valueFrom: 'endpoint.url',
          },
        ],
        fallback: { mode: 'fail' },
        verification: { method: 'tool-native' },
      },
    },
    evidence: {
      enabled: true,
      redaction: 'credentials-userinfo-query-fragment',
    },
  };
  const raw = `${JSON.stringify(profile, null, 2)}\n`;
  const profilePath = path.join(root, 'profile.json');
  fs.writeFileSync(profilePath, raw);
  return {
    root,
    trace: path.join(root, 'trace.txt'),
    evidence: path.join(root, 'evidence.txt'),
    receipt: path.join(root, 'receipt.json'),
    profilePath,
    digest: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      SHIFU_NATIVE: '0',
      SHIFU_TEST_NODE: process.execPath,
      SHIFU_TEST_TRACE: path.join(root, 'trace.txt'),
      SHIFU_TEST_EVIDENCE: path.join(root, 'evidence.txt'),
      SHIFU_CACHE_RECEIPT: path.join(root, 'receipt.json'),
      SHIFU_CACHE_SCOPE: 'development',
      SHIFU_CACHE_BYPASS: '',
    },
  };
}

test('cache contract schemas accept valid fixtures and reject unsafe policy', async () => {
  const result = await checkShifuCacheContract(ROOT);
  const counts = result.validFixtures === 0 ? [0, 0] : [3, 2];
  assert.deepEqual(result, {
    contract: 'docs/shifu/cache-contract.json',
    profileSchema: 'docs/shifu/schema/cache-profile-v1.schema.json',
    resolutionSchema: 'docs/shifu/schema/cache-resolution-v1.schema.json',
    diagnosticSchema: 'docs/shifu/schema/cache-diagnostic-v1.schema.json',
    configPlanSchema: 'docs/shifu/schema/cache-config-plan-v1.schema.json',
    validFixtures: counts[0],
    rejectedFixtures: counts[1],
  });
});

for (const [label, args, source] of [
  ['contract', ['cache', 'contract'], 'docs/shifu/cache-contract.json'],
  [
    'profile schema',
    ['cache', 'schema', 'profile'],
    'docs/shifu/schema/cache-profile-v1.schema.json',
  ],
  [
    'resolution schema',
    ['cache', 'schema', 'resolution'],
    'docs/shifu/schema/cache-resolution-v1.schema.json',
  ],
  [
    'diagnostic schema',
    ['cache', 'schema', 'diagnostic'],
    'docs/shifu/schema/cache-diagnostic-v1.schema.json',
  ],
  [
    'config plan schema',
    ['cache', 'schema', 'configPlan'],
    'docs/shifu/schema/cache-config-plan-v1.schema.json',
  ],
]) {
  test(`shifu exposes the exact checked-in ${label}`, () => {
    const result = spawnSync(process.execPath, [SHIFU_MJS, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      fs.readFileSync(path.join(ROOT, source), 'utf8'),
    );
  });
}

test('unknown cache schema fails with usage', () => {
  const result = spawnSync(
    process.execPath,
    [SHIFU_MJS, 'cache', 'schema', 'unknown'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cache schema profile/);
});

test('shifu validates a profile through its runtime authority', () => {
  const profile = path.join(
    ROOT,
    'docs',
    'shifu',
    'examples',
    'development.cache-profile.json',
  );
  const result = spawnSync(
    process.execPath,
    [SHIFU_MJS, 'cache', 'validate', 'profile', profile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
});

test('cache apply is transparent when no profile projection is configured', () => {
  const result = spawnSync(
    process.execPath,
    [
      SHIFU_MJS,
      'cache',
      'apply',
      '--',
      process.execPath,
      '-e',
      'process.stdout.write("cache-pass-through")',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SHIFU_CACHE_PROFILE_REF: '',
        SHIFU_CACHE_PROFILE_DIGEST: '',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'cache-pass-through');
});

test('cache status is local-only and distinguishes absent from partial configuration', (t) => {
  const fixture = shellHarness(t);
  const configFile = path.join(fixture.root, 'build-local.env');
  assert.deepEqual(
    cacheStatus({ configFile, receiptPath: fixture.receipt, env: {} })
      .configuration,
    {
      source: 'none',
      pair: 'absent',
      scope: 'development',
      reference: null,
      digest: '',
    },
  );
  fs.writeFileSync(
    configFile,
    `export SHIFU_CACHE_PROFILE_REF='${fixture.profilePath}'\n`,
  );
  const partial = cacheStatus({
    configFile,
    receiptPath: fixture.receipt,
    env: {},
  });
  assert.equal(partial.overall, 'failed');
  assert.equal(partial.configuration.source, 'user-config');
  assert.equal(partial.configuration.pair, 'partial');
  assert.equal(partial.configuration.reference.type, 'local-path');
  assert.doesNotMatch(JSON.stringify(partial), new RegExp(fixture.root));
});

test('cache use is dry-run by default and manages only its delimited block', async (t) => {
  const fixture = shellHarness(t);
  const configFile = path.join(fixture.root, 'build-local.env');
  const quotedProfile = path.join(fixture.root, "profile's.json");
  fs.copyFileSync(fixture.profilePath, quotedProfile);
  fs.writeFileSync(configFile, "export KEEP_ME='yes'\n");
  const options = {
    configFile,
    reference: quotedProfile,
    digest: fixture.digest,
    scope: 'development',
  };
  const plan = await cacheUse(options);
  assert.equal(plan.execute, false);
  assert.equal(plan.changed, true);
  assert.equal(fs.readFileSync(configFile, 'utf8'), "export KEEP_ME='yes'\n");
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(fixture.root));

  const applied = await cacheUse({ ...options, execute: true });
  assert.equal(applied.backup.created, true);
  const configured = fs.readFileSync(configFile, 'utf8');
  assert.match(configured, /export KEEP_ME='yes'/);
  assert.match(configured, /# shifu-cache-profile begin/);
  assert.match(configured, /SHIFU_CACHE_PROFILE_DIGEST/);
  assert.equal(
    cacheStatus({ configFile, receiptPath: fixture.receipt, env: {} })
      .configuration.source,
    'shifu-managed',
  );
  assert.equal(
    (
      await cacheDoctor({
        configFile,
        receiptPath: fixture.receipt,
        env: {},
      })
    ).overall,
    'healthy',
  );

  const unsetPlan = cacheUnset({ configFile });
  assert.equal(unsetPlan.changed, true);
  assert.match(
    fs.readFileSync(configFile, 'utf8'),
    /shifu-cache-profile begin/,
  );
  cacheUnset({ configFile, execute: true });
  const after = fs.readFileSync(configFile, 'utf8');
  assert.equal(after, "export KEEP_ME='yes'\n");
});

test('cache use refuses to overwrite an Atlas controller projection', async (t) => {
  const fixture = shellHarness(t);
  const configFile = path.join(fixture.root, 'build-local.env');
  fs.writeFileSync(
    configFile,
    '# atlas-shifu-cache-profile begin\n# atlas-shifu-cache-profile end\n',
  );
  assert.equal(
    cacheStatus({
      configFile,
      receiptPath: fixture.receipt,
      env: {
        SHIFU_CACHE_PROFILE_REF: fixture.profilePath,
        SHIFU_CACHE_PROFILE_DIGEST: fixture.digest,
      },
    }).configuration.source,
    'controller-projection',
  );
  await assert.rejects(
    cacheUse({
      configFile,
      reference: fixture.profilePath,
      digest: fixture.digest,
    }),
    /controller-managed/,
  );
});

test('cache doctor resolves configured profiles while leaving hit evidence unproven', async (t) => {
  const fixture = shellHarness(t);
  const configFile = path.join(fixture.root, 'build-local.env');
  fs.writeFileSync(
    configFile,
    `# shifu-cache-profile begin\nexport SHIFU_CACHE_PROFILE_REF='${fixture.profilePath}'\nexport SHIFU_CACHE_PROFILE_DIGEST='${fixture.digest}'\nexport SHIFU_CACHE_SCOPE='development'\n# shifu-cache-profile end\n`,
  );
  const diagnostic = await cacheDoctor({
    configFile,
    receiptPath: fixture.receipt,
    env: {},
  });
  assert.equal(diagnostic.overall, 'healthy');
  assert.equal(diagnostic.services.npm.reachable, 'not-probed');
  assert.equal(diagnostic.services.npm.effective, true);
  assert.equal(diagnostic.services.npm.hit, 'unproven');
});

test('cache doctor probes selected HTTP endpoints only when requested', async (t) => {
  const fixture = shellHarness(t);
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'HEAD');
    assert.equal(request.url, '/healthz');
    response.writeHead(200).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  const profile = JSON.parse(fs.readFileSync(fixture.profilePath, 'utf8'));
  profile.services.npm.endpoint.url = `http://127.0.0.1:${address.port}/npm/`;
  profile.services.npm.verification.probe = {
    path: '/healthz',
    timeoutMs: 250,
    attempts: 3,
    retryDelayMs: 0,
  };
  const raw = `${JSON.stringify(profile, null, 2)}\n`;
  fs.writeFileSync(fixture.profilePath, raw);
  const digest = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  const configFile = path.join(fixture.root, 'build-local.env');
  fs.writeFileSync(
    configFile,
    `export SHIFU_CACHE_PROFILE_REF='${fixture.profilePath}'\nexport SHIFU_CACHE_PROFILE_DIGEST='${digest}'\n`,
  );
  const diagnostic = await cacheDoctor({
    configFile,
    receiptPath: fixture.receipt,
    env: {},
    probe: true,
    timeoutMs: 1000,
  });
  assert.equal(diagnostic.overall, 'healthy');
  assert.equal(diagnostic.probe, true);
  assert.equal(diagnostic.services.npm.reachable, 'reachable');
  assert.deepEqual(diagnostic.services.npm.probeEvidence, {
    state: 'reachable',
    method: 'HEAD',
    status: 200,
    durationMs: diagnostic.services.npm.probeEvidence.durationMs,
    attempts: 1,
    timeoutMs: 250,
    target: 'same-origin-path',
  });
});

test('cache doctor uses the lightweight devpi API for legacy Python profiles', async (t) => {
  const fixture = shellHarness(t);
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  const profile = JSON.parse(fs.readFileSync(fixture.profilePath, 'utf8'));
  profile.services = { 'python-index': profile.services.npm };
  profile.services['python-index'].endpoint.url =
    `http://127.0.0.1:${address.port}/root/pypi/+simple/`;
  profile.services['python-index'].bindings[0].key = 'UV_DEFAULT_INDEX';
  const raw = `${JSON.stringify(profile, null, 2)}\n`;
  fs.writeFileSync(fixture.profilePath, raw);
  const digest = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  const configFile = path.join(fixture.root, 'build-local.env');
  fs.writeFileSync(
    configFile,
    `export SHIFU_CACHE_PROFILE_REF='${fixture.profilePath}'\nexport SHIFU_CACHE_PROFILE_DIGEST='${digest}'\n`,
  );

  const diagnostic = await cacheDoctor({
    configFile,
    receiptPath: fixture.receipt,
    env: {},
    probe: true,
    timeoutMs: 1000,
  });

  assert.equal(diagnostic.overall, 'healthy');
  assert.deepEqual(requests, [{ method: 'HEAD', url: '/+api' }]);
  assert.equal(
    diagnostic.services['python-index'].probeEvidence.target,
    'provider-health',
  );
  assert.equal(
    diagnostic.services['python-index'].probeEvidence.timeoutMs,
    5000,
  );
});

test('HTTP probe retries a transient timeout and succeeds', async () => {
  let requests = 0;
  const timeout = Object.assign(new Error('timed out'), {
    name: 'TimeoutError',
  });
  const evidence = await probeHttp('https://cache.example.invalid/health', {
    timeoutMs: 100,
    attempts: 2,
    retryDelayMs: 0,
    request: async () => {
      requests += 1;
      if (requests === 1) throw timeout;
      return { status: 200 };
    },
  });
  assert.equal(requests, 2);
  assert.equal(evidence.state, 'reachable');
  assert.equal(evidence.attempts, 2);
  assert.equal(evidence.status, 200);
});

test('HTTP probe keeps persistent timeouts failed at the attempt bound', async () => {
  let requests = 0;
  const evidence = await probeHttp('https://cache.example.invalid/health', {
    timeoutMs: 100,
    attempts: 3,
    retryDelayMs: 0,
    request: async () => {
      requests += 1;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    },
  });
  assert.equal(requests, 3);
  assert.equal(evidence.state, 'failed');
  assert.equal(evidence.reason, 'timeout');
  assert.equal(evidence.attempts, 3);
});

test('HTTP probe retries 5xx but accepts a reachable 4xx without retry', async () => {
  let retryableRequests = 0;
  const recovered = await probeHttp('https://cache.example.invalid/health', {
    timeoutMs: 100,
    attempts: 2,
    retryDelayMs: 0,
    request: async () => ({
      status: ++retryableRequests === 1 ? 503 : 204,
    }),
  });
  assert.equal(retryableRequests, 2);
  assert.equal(recovered.state, 'reachable');
  assert.equal(recovered.attempts, 2);

  let nonRetryableRequests = 0;
  const reachable = await probeHttp('https://cache.example.invalid/missing', {
    timeoutMs: 100,
    attempts: 3,
    retryDelayMs: 0,
    request: async () => {
      nonRetryableRequests += 1;
      return { status: 404 };
    },
  });
  assert.equal(nonRetryableRequests, 1);
  assert.equal(reachable.state, 'reachable');
  assert.equal(reachable.status, 404);
});

test('cache profile runtime rejects probe attempts above the schema bound', async (t) => {
  const fixture = shellHarness(t);
  const profile = JSON.parse(fs.readFileSync(fixture.profilePath, 'utf8'));
  profile.services.npm.verification.probe = { attempts: 4 };
  const raw = `${JSON.stringify(profile, null, 2)}\n`;
  fs.writeFileSync(fixture.profilePath, raw);
  const digest = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  const configFile = path.join(fixture.root, 'build-local.env');
  fs.writeFileSync(
    configFile,
    `export SHIFU_CACHE_PROFILE_REF='${fixture.profilePath}'\nexport SHIFU_CACHE_PROFILE_DIGEST='${digest}'\n`,
  );
  const diagnostic = await cacheDoctor({
    configFile,
    receiptPath: fixture.receipt,
    env: {},
  });
  assert.equal(diagnostic.overall, 'failed');
  assert.match(
    diagnostic.error,
    /probe\.attempts must be an integer from 1 to 3/,
  );
});

test('cache status CLI emits the diagnostic receipt as JSON', (t) => {
  const fixture = shellHarness(t);
  const result = spawnSync(
    process.execPath,
    [SHIFU_MJS, 'cache', 'status', '--json'],
    { cwd: ROOT, encoding: 'utf8', env: fixture.env },
  );
  assert.equal(result.status, 0, result.stderr);
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.schema, 'shifu.cache-diagnostic/v1');
  assert.equal(diagnostic.mode, 'status');
});

test(
  'shell shim keeps cache on L2 when native task execution is forced',
  { skip: process.platform === 'win32' },
  () => {
    const result = spawnSync(SHIFU_SH, ['cache', 'contract'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SHIFU_NATIVE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schema, 'shifu.cache-contract/v1');
  },
);

test(
  'ordinary shell task auto-applies a projected profile exactly once',
  { skip: process.platform === 'win32' },
  (t) => {
    const fixture = shellHarness(t);
    const result = spawnSync(SHIFU_SH, ['test:auto-cache', '--flag'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...fixture.env,
        SHIFU_CACHE_ACTIVE: '',
        SHIFU_CACHE_PROFILE_REF: fixture.profilePath,
        SHIFU_CACHE_PROFILE_DIGEST: fixture.digest,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(fixture.evidence, 'utf8'), /active=1/);
    assert.match(
      fs.readFileSync(fixture.evidence, 'utf8'),
      /registry=http:\/\/cache\.example\.invalid\/npm\//,
    );
    assert.match(
      fs.readFileSync(fixture.evidence, 'utf8'),
      /args=test:auto-cache --flag/,
    );
    const applications = fs
      .readFileSync(fixture.trace, 'utf8')
      .split('\n')
      .filter((line) => line.includes('shifu.mjs cache apply'));
    assert.equal(applications.length, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(fixture.receipt, 'utf8')).profile.id,
      'test.auto-apply',
    );
  },
);

test(
  'explicit runner projection overrides user-global development config',
  { skip: process.platform === 'win32' },
  (t) => {
    const fixture = shellHarness(t);
    const configDir = path.join(fixture.root, 'config', 'kungfu');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'build-local.env'),
      [
        "export SHIFU_CACHE_PROFILE_REF='missing-development-profile.json'",
        `export SHIFU_CACHE_PROFILE_DIGEST='sha256:${'0'.repeat(64)}'`,
        "export SHIFU_CACHE_SCOPE='development'",
        '',
      ].join('\n'),
    );
    const result = spawnSync(SHIFU_SH, ['test:runner-projection'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...fixture.env,
        SHIFU_CACHE_ACTIVE: '',
        SHIFU_CACHE_PROFILE_REF: fixture.profilePath,
        SHIFU_CACHE_PROFILE_DIGEST: fixture.digest,
        SHIFU_CACHE_SCOPE: 'self-hosted-runner',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(fixture.receipt, 'utf8')).execution.scope,
      'self-hosted-runner',
    );
  },
);

test(
  'shell gate run applies a projected profile once at the outer boundary',
  { skip: process.platform === 'win32' },
  (t) => {
    const fixture = shellHarness(t);
    const result = spawnSync(
      SHIFU_SH,
      [
        'gate',
        'run',
        'fixture.prepare',
        '--registry',
        'docs/shifu/examples/gates/execution.gate-registry.json',
        '--json',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...fixture.env,
          SHIFU_CACHE_ACTIVE: '',
          SHIFU_CACHE_PROFILE_REF: fixture.profilePath,
          SHIFU_CACHE_PROFILE_DIGEST: fixture.digest,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'pass');
    const trace = fs.readFileSync(fixture.trace, 'utf8');
    assert.equal(
      trace.split('\n').filter((line) => line.includes('shifu.mjs cache apply'))
        .length,
      1,
    );
    assert.match(trace, /shifu\.mjs gate run fixture\.prepare/);
  },
);

test(
  'active child and absent projection bypass automatic cache application',
  { skip: process.platform === 'win32' },
  (t) => {
    for (const [label, projection] of [
      [
        'active',
        {
          SHIFU_CACHE_ACTIVE: '1',
          SHIFU_CACHE_PROFILE_REF: 'profile.json',
          SHIFU_CACHE_PROFILE_DIGEST: 'sha256:abc',
        },
      ],
      [
        'absent',
        {
          SHIFU_CACHE_ACTIVE: '',
          SHIFU_CACHE_PROFILE_REF: '',
          SHIFU_CACHE_PROFILE_DIGEST: '',
        },
      ],
      [
        'source-bypass',
        {
          SHIFU_CACHE_ACTIVE: '',
          SHIFU_CACHE_BYPASS: 'source-acceptance',
          SHIFU_CACHE_PROFILE_REF: 'profile.json',
          SHIFU_CACHE_PROFILE_DIGEST: 'sha256:abc',
        },
      ],
    ]) {
      const fixture = shellHarness(t);
      const result = spawnSync(SHIFU_SH, [`test:${label}`], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...fixture.env, ...projection },
      });
      assert.equal(result.status, 0, result.stderr);
      const trace = fs.readFileSync(fixture.trace, 'utf8');
      assert.doesNotMatch(trace, /shifu\.mjs cache apply/);
    }
  },
);

test(
  'active child does not reload developer bindings omitted by its cache profile',
  { skip: process.platform === 'win32' },
  (t) => {
    const fixture = shellHarness(t);
    const configDir = path.join(fixture.root, 'config', 'kungfu');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'build-local.env'),
      "export UV_DEFAULT_INDEX='http://developer-cache.example.invalid/simple/'\n",
    );
    const result = spawnSync(SHIFU_SH, ['test:active-env'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...fixture.env,
        SHIFU_CACHE_ACTIVE: '1',
        SHIFU_CACHE_PROFILE_REF: fixture.profilePath,
        SHIFU_CACHE_PROFILE_DIGEST: fixture.digest,
        UV_DEFAULT_INDEX: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(fixture.evidence, 'utf8'), /\nuv=\n/);
  },
);

test(
  'partial projection reaches the resolver and fails closed',
  { skip: process.platform === 'win32' },
  (t) => {
    const fixture = shellHarness(t);
    const result = spawnSync(SHIFU_SH, ['test:partial'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...fixture.env,
        SHIFU_CACHE_ACTIVE: '',
        SHIFU_CACHE_PROFILE_REF: fixture.profilePath,
        SHIFU_CACHE_PROFILE_DIGEST: '',
      },
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /profile reference and digest must be supplied together/,
    );
    assert.equal(fs.existsSync(fixture.evidence), false);
  },
);
