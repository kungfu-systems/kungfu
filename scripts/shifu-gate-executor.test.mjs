// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sha256 } from './shifu-cache-runtime.mjs';
import {
  buildGateActionInvocation,
  executeGateRun,
  validateGateReceipt,
} from './shifu-gate-executor.mjs';
import {
  gateDigest,
  validateGateRegistryBytes,
} from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_REF = 'docs/shifu/examples/gates/execution.gate-registry.json';
const loaded = validateGateRegistryBytes(
  fs.readFileSync(path.join(ROOT, REGISTRY_REF)),
);
const SOURCE = { sha: 'a'.repeat(40), dirty: false };
const WRITER = { write() {} };
const PLATFORM =
  process.platform === 'darwin'
    ? `darwin-${process.arch}`
    : process.platform === 'win32'
      ? `windows-${process.arch}`
      : `${process.platform}-${process.arch}`;

assert.deepEqual(loaded.issues, []);

/** @param {Record<string, any>} options */
async function run(options) {
  return executeGateRun(loaded.registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: loaded.digest,
    source: SOURCE,
    writer: WRITER,
    ...options,
  });
}

function conanCacheProfile() {
  return {
    $schema: 'https://libkungfu.dev/schemas/shifu/cache-profile-v1.schema.json',
    schema: 'shifu.cache-profile/v1',
    profileId: 'test.gate-executor-cache-profile',
    revision: 1,
    generatedAt: '2026-07-14T00:00:00Z',
    authority: {
      owner: 'test-inventory',
      sourceRef: 'test/inventory.json@revision-1',
      sourceDigest: `sha256:${'1'.repeat(64)}`,
    },
    subject: {
      principal: 'test:gate-executor',
      platforms: [PLATFORM],
      scopes: ['development', 'self-hosted-runner', 'ci'],
    },
    policy: {
      mode: 'require',
      onUnavailable: 'fail',
      allowPublicFallback: false,
      secretPolicy: 'references-only',
    },
    services: {
      'conan-registry': {
        kind: 'package-registry',
        mode: 'require',
        endpoint: {
          type: 'http',
          url: 'http://cache.example.invalid/conan/',
        },
        bindings: [
          {
            kind: 'config-key',
            key: 'conan.remote.conancenter',
            name: 'workhub-conan',
            valueFrom: 'endpoint.url',
          },
        ],
        fallback: { mode: 'fail' },
        verification: { method: 'tool-native' },
      },
      'conan-storage': {
        kind: 'artifact-cache',
        mode: 'require',
        endpoint: {
          type: 'local-path',
          path: '${SHIFU_CACHE_HOME}/conan/workhub-v1',
        },
        bindings: [
          {
            kind: 'config-key',
            key: 'conan.cache.storage',
            name: 'workhub-v1',
            valueFrom: 'endpoint.path',
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
}

async function withEnvironment(overrides, operation) {
  const previous = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

test('explicit multi-gate runs close and deduplicate shared dependencies', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-gate-test-'));
  const log = path.join(temporary, 'actions.log');
  const previous = process.env.SHIFU_GATE_FIXTURE_LOG;
  process.env.SHIFU_GATE_FIXTURE_LOG = log;
  try {
    const receipt = await run({
      explicitGates: ['fixture.left', 'fixture.right'],
    });
    assert.equal(receipt.status, 'pass');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.qualifying, false);
    assert.deepEqual(
      receipt.results.map((result) => result.gateId),
      ['fixture.prepare', 'fixture.left', 'fixture.right'],
    );
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').sort(), [
      'fixture.left',
      'fixture.prepare',
      'fixture.right',
    ]);
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(process.env, 'SHIFU_GATE_FIXTURE_LOG');
    else process.env.SHIFU_GATE_FIXTURE_LOG = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('explicit diagnostic runs can omit one declared dependency without becoming qualifying', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-gate-test-'));
  const log = path.join(temporary, 'actions.log');
  const previous = process.env.SHIFU_GATE_FIXTURE_LOG;
  process.env.SHIFU_GATE_FIXTURE_LOG = log;
  try {
    const receipt = await run({
      explicitGates: ['fixture.left'],
      omittedDependencies: ['fixture.prepare'],
    });
    assert.equal(receipt.status, 'pass');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.qualifying, false);
    assert.deepEqual(receipt.selection.omittedDependencies, [
      'fixture.prepare',
    ]);
    assert.deepEqual(
      receipt.results.map((result) => result.gateId),
      ['fixture.left'],
    );
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'fixture.left');
    assert.deepEqual(
      validateGateReceipt(receipt, loaded.registry, {
        root: ROOT,
        registryRef: REGISTRY_REF,
        registryDigest: loaded.digest,
        source: SOURCE,
      }),
      {
        valid: true,
        current: true,
        qualifying: false,
        issues: [
          {
            code: 'diagnostic-selection',
            path: '/selection',
            message: 'explicit gate selection is non-qualifying',
          },
        ],
      },
    );
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(process.env, 'SHIFU_GATE_FIXTURE_LOG');
    else process.env.SHIFU_GATE_FIXTURE_LOG = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('dependency omission rejects qualifying, explicit, and unrelated Gates', async () => {
  await assert.rejects(
    run({ profile: 'success', omittedDependencies: ['fixture.prepare'] }),
    /allowed only for explicit gate runs/,
  );
  await assert.rejects(
    run({
      explicitGates: ['fixture.left'],
      omittedDependencies: ['fixture.left'],
    }),
    /cannot omit explicitly selected gate/,
  );
  await assert.rejects(
    run({
      explicitGates: ['fixture.left'],
      omittedDependencies: ['fixture.evidence'],
    }),
    /cannot omit non-dependency gate/,
  );
});

test('a clean complete profile produces a current qualifying receipt', async () => {
  const receipt = await run({ profile: 'success' });
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.qualifying, true);
  assert.deepEqual(
    receipt.results.map((result) => result.gateId),
    ['fixture.prepare', 'fixture.left', 'fixture.right', 'fixture.aggregate'],
  );
  const validation = validateGateReceipt(receipt, loaded.registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: loaded.digest,
    source: SOURCE,
  });
  assert.deepEqual(validation, {
    valid: true,
    current: true,
    qualifying: true,
    issues: [],
  });
  const Ajv2020 = (await import('ajv/dist/2020.js')).default;
  const validateSchema = new Ajv2020({
    allErrors: true,
    strict: false,
  }).compile(
    JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'docs/shifu/schema/gate-receipt-v1.schema.json'),
        'utf8',
      ),
    ),
  );
  assert.equal(
    validateSchema(receipt),
    true,
    JSON.stringify(validateSchema.errors),
  );
});

test('receipt integrity binds the effective execution parameters', async () => {
  const executionContext = {
    executionProfile: 'alpha',
    effectiveParameters: {
      budgetSeconds: 1800,
      upstreamBudgetSeconds: 750,
      reserveSeconds: 240,
      fuzzSecondsPerTarget: 90,
      episodeProfile: 'mvp-smoke-v1',
      episodeTimeoutSeconds: 600,
    },
    policyDigest: `sha256:${'7'.repeat(64)}`,
    policyRef: 'docs/qualification/gates/execution-profiles.json',
  };
  const receipt = await run({ profile: 'success', executionContext });
  assert.deepEqual(receipt.execution, executionContext);
  const Ajv2020 = (await import('ajv/dist/2020.js')).default;
  const validateSchema = new Ajv2020({
    allErrors: true,
    strict: false,
  }).compile(
    JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'docs/shifu/schema/gate-receipt-v1.schema.json'),
        'utf8',
      ),
    ),
  );
  assert.equal(
    validateSchema(receipt),
    true,
    JSON.stringify(validateSchema.errors),
  );
  const changed = structuredClone(receipt);
  changed.execution.effectiveParameters.budgetSeconds = 1;
  const validation = validateGateReceipt(changed, loaded.registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: loaded.digest,
    source: SOURCE,
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === 'receipt-digest'));
});

test('advisory failures remain visible without blocking required qualification', async () => {
  const receipt = await run({ profile: 'advisory', includeAdvisory: true });
  assert.equal(receipt.status, 'advisory-fail');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.qualifying, true);
  assert.equal(
    receipt.results.find((result) => result.gateId === 'fixture.fail').status,
    'advisory-fail',
  );
});

test('required failures keep a copyable single-gate reproduction argv', async () => {
  const receipt = await run({ profile: 'required-failure' });
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.qualifying, false);
  const failed = receipt.results.find(
    (result) => result.gateId === 'fixture.fail',
  );
  assert.deepEqual(failed.reproduce.argv.slice(0, 3), [
    process.platform === 'win32' ? 'shifu.cmd' : './shifu',
    'gate',
    'run',
  ]);
});

test('task failure reasons retain a bounded diagnostic output tail', async () => {
  const registry = structuredClone(loaded.registry);
  const gate = registry.gates.find((item) => item.id === 'fixture.fail');
  gate.action = {
    kind: 'argv',
    command: process.execPath,
    args: [
      '-e',
      "console.error('fixture diagnostic output tail'); process.exit(7)",
    ],
  };
  const receipt = await executeGateRun(registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: loaded.digest,
    source: SOURCE,
    profile: 'required-failure',
    writer: WRITER,
  });
  const reason = receipt.results.find(
    (result) => result.gateId === 'fixture.fail',
  ).reason;
  assert.match(reason, /fixture diagnostic output tail/);
  assert.ok(reason.length <= 1000);
});

test('task output above the legacy 16 MiB buffer remains executable', async () => {
  const registry = structuredClone(loaded.registry);
  const gate = registry.gates.find((item) => item.id === 'fixture.fail');
  gate.cost.timeoutSeconds = 30;
  gate.action = {
    kind: 'argv',
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024))"],
  };
  const receipt = await executeGateRun(registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: loaded.digest,
    source: SOURCE,
    profile: 'required-failure',
    writer: WRITER,
  });
  const result = receipt.results.find((item) => item.gateId === 'fixture.fail');
  assert.equal(result.status, 'pass');
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, null);
});

test('required gate-specific evidence is enforced without embedding its content', async () => {
  const passed = await run({ profile: 'evidence-success' });
  assert.equal(passed.status, 'pass');
  assert.equal(passed.results[0].evidence.present, true);
  assert.deepEqual(passed.results[0].evidence.pointers, [
    { id: 'fixture-report', ref: 'build/fixture/report.json' },
  ]);

  const missing = await run({ profile: 'evidence-missing' });
  assert.equal(missing.status, 'fail');
  assert.match(missing.results[0].reason, /required gate evidence/);
});

test('unsafe evidence refs and inherited environment values cannot enter receipts', async () => {
  const registry = structuredClone(loaded.registry);
  const gate = registry.gates.find((item) => item.id === 'fixture.evidence');
  gate.action = { kind: 'handler', handler: 'fixture.unsafe-evidence' };
  const secret = 'do-not-store-this-sentinel';
  const previous = process.env.SHIFU_GATE_SECRET_SENTINEL;
  process.env.SHIFU_GATE_SECRET_SENTINEL = secret;
  try {
    const receipt = await executeGateRun(registry, {
      root: ROOT,
      registryRef: REGISTRY_REF,
      registryDigest: gateDigest(registry),
      profile: 'evidence-success',
      source: SOURCE,
      writer: WRITER,
      handlers: {
        'fixture.unsafe-evidence': async () => ({
          status: 'pass',
          evidence: {
            schema: 'fixture.evidence/v1',
            pointers: [
              {
                id: 'unsafe',
                ref: 'https://example.invalid/report?token=secret',
              },
            ],
          },
        }),
      },
    });
    assert.equal(receipt.status, 'error');
    assert.match(receipt.results[0].reason, /safe repository-relative ref/);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(receipt), /token=secret/);
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(process.env, 'SHIFU_GATE_SECRET_SENTINEL');
    else process.env.SHIFU_GATE_SECRET_SENTINEL = previous;
  }
});

test('a required handler skip is non-successful and non-qualifying', async () => {
  const registry = structuredClone(loaded.registry);
  const gate = registry.gates.find((item) => item.id === 'fixture.evidence');
  gate.action = { kind: 'handler', handler: 'fixture.skip' };
  const receipt = await executeGateRun(registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: gateDigest(registry),
    profile: 'evidence-success',
    source: SOURCE,
    writer: WRITER,
    handlers: {
      'fixture.skip': async () => ({
        status: 'skip',
        reason: 'not applicable',
      }),
    },
  });
  assert.equal(receipt.status, 'skip');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.qualifying, false);
});

test('handler reasons are bounded and redact paths, URLs and secret-like assignments', async () => {
  const registry = structuredClone(loaded.registry);
  const gate = registry.gates.find((item) => item.id === 'fixture.evidence');
  gate.action = { kind: 'handler', handler: 'fixture.error' };
  const receipt = await executeGateRun(registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: gateDigest(registry),
    profile: 'evidence-success',
    source: SOURCE,
    writer: WRITER,
    handlers: {
      'fixture.error': async () => ({
        status: 'error',
        reason: `${ROOT}/private.log https://example.invalid/a?token=x token=hidden`,
      }),
    },
  });
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, new RegExp(ROOT.replaceAll('/', '\\/')));
  assert.doesNotMatch(serialized, /example\.invalid|token=x|token=hidden/);
  assert.match(receipt.results[0].reason, /redacted/);
});

test('timeouts are bounded and recorded as errors', async () => {
  const receipt = await run({ profile: 'timeout' });
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.results[0].status, 'error');
  assert.match(receipt.results[0].reason, /timed out/);
});

test('task actions re-enter an existing lightweight Shifu task beside an active qualification', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-gate-task-cache-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const xdgCache = path.join(directory, 'cache');
  const profilePath = path.join(directory, 'profile.json');
  const corepackHome =
    process.env.COREPACK_HOME ||
    path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
      'node',
      'corepack',
    );
  // Share the cache root with the simulated qualification; only the runner
  // identity and scope may keep this contract-only task off its partition.
  const runnerName = `shifu-gate-executor-test-${process.pid}`;
  const runnerPartition = `runner-${sha256(Buffer.from(runnerName)).slice(7, 19)}`;
  const profileBytes = Buffer.from(
    `${JSON.stringify(conanCacheProfile(), null, 2)}\n`,
  );
  const qualificationStorage = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    'development',
  );
  const qualificationLock = path.join(
    qualificationStorage,
    '.shifu-conan.lock',
  );
  const runnerLock = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    runnerPartition,
    '.shifu-conan.lock',
  );
  fs.mkdirSync(qualificationStorage, { recursive: true });
  fs.writeFileSync(qualificationLock, '{"qualification":true}\n');
  fs.writeFileSync(profilePath, profileBytes);

  await withEnvironment(
    {
      XDG_CACHE_HOME: xdgCache,
      COREPACK_HOME: corepackHome,
      SHIFU_CACHE_PROFILE_REF: profilePath,
      SHIFU_CACHE_PROFILE_DIGEST: sha256(profileBytes),
      SHIFU_CACHE_SCOPE: 'self-hosted-runner',
      RUNNER_NAME: runnerName,
      SHIFU_CACHE_ACTIVE: undefined,
      SHIFU_CACHE_BYPASS: undefined,
    },
    async () => {
      const output = [];
      const receipt = await run({
        profile: 'task-dogfood',
        writer: { write: (chunk) => output.push(String(chunk)) },
      });
      assert.equal(
        receipt.status,
        'pass',
        `${JSON.stringify(receipt.results[0])}\n${output.join('')}`,
      );
      assert.equal(receipt.results[0].gateId, 'fixture.task-dogfood');
      assert.equal(receipt.results[0].attempted, true);
    },
  );
  assert.equal(
    fs.readFileSync(qualificationLock, 'utf8'),
    '{"qualification":true}\n',
  );
  assert.equal(fs.existsSync(path.dirname(runnerLock)), true);
  assert.equal(fs.existsSync(runnerLock), false);
});

test('stale source, changed definitions and incomplete coverage fail receipt reuse', async () => {
  const receipt = await run({ profile: 'success' });
  const stale = validateGateReceipt(receipt, loaded.registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: loaded.digest,
    source: { sha: 'b'.repeat(40), dirty: false },
  });
  assert.equal(stale.current, false);
  assert.equal(stale.qualifying, false);
  assert.ok(stale.issues.some((issue) => issue.code === 'stale-source'));

  const changed = structuredClone(receipt);
  changed.results[0].definitionDigest = `sha256:${'0'.repeat(64)}`;
  const changedValidation = validateGateReceipt(changed, loaded.registry, {
    root: ROOT,
    registryRef: REGISTRY_REF,
    registryDigest: loaded.digest,
    source: SOURCE,
  });
  assert.equal(changedValidation.current, false);
  assert.equal(changedValidation.qualifying, false);
  assert.ok(
    changedValidation.issues.some(
      (issue) => issue.code === 'definition-digest',
    ),
  );

  const incomplete = structuredClone(receipt);
  incomplete.results.pop();
  const incompleteValidation = validateGateReceipt(
    incomplete,
    loaded.registry,
    {
      root: ROOT,
      registryRef: REGISTRY_REF,
      registryDigest: loaded.digest,
      source: SOURCE,
    },
  );
  assert.equal(incompleteValidation.valid, false);
  assert.equal(incompleteValidation.qualifying, false);
  assert.ok(
    incompleteValidation.issues.some(
      (issue) => issue.code === 'missing-result',
    ),
  );
});

test('task invocation uses the native Shifu entrypoint on POSIX and cmd.exe on Windows', () => {
  const action = { kind: 'task', task: 'check:source', args: ['--example'] };
  assert.deepEqual(buildGateActionInvocation(action, '/repo', 'linux'), {
    command: '/repo/shifu',
    args: ['check:source', '--example'],
  });
  const windows = buildGateActionInvocation(action, 'C:\\repo', 'windows');
  assert.match(windows.command.toLowerCase(), /cmd(?:\.exe)?$/);
  assert.deepEqual(windows.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(windows.args[3], /shifu\.cmd/);
  assert.equal(windows.windowsVerbatimArguments, true);
});
