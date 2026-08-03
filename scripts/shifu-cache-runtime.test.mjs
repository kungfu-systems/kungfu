// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { optionalAjv2020 } from './readonly-source-toolchain.mjs';
import {
  CacheProfileError,
  applyCacheProfile,
  conanStoragePartition,
  resolveCacheProfile,
  sha256,
  validateProfileBytes,
  windowsShifuCommandLine,
} from './shifu-cache-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Ajv2020 = optionalAjv2020();
const platform =
  process.platform === 'darwin'
    ? `darwin-${process.arch}`
    : process.platform === 'win32'
      ? `windows-${process.arch}`
      : `${process.platform}-${process.arch}`;

test('Windows cache re-entry leaves the welded shim token unquoted', () => {
  assert.equal(
    windowsShifuCommandLine(['install', 'argument with spaces']),
    'shifu.cmd install "argument with spaces"',
  );
});

function profile(overrides = {}) {
  return {
    $schema: 'https://libkungfu.dev/schemas/shifu/cache-profile-v1.schema.json',
    schema: 'shifu.cache-profile/v1',
    profileId: 'test.cache-profile',
    revision: 1,
    generatedAt: '2026-07-12T00:00:00Z',
    authority: {
      owner: 'test-inventory',
      sourceRef: 'test/inventory.json@revision-1',
      sourceDigest: `sha256:${'1'.repeat(64)}`,
    },
    subject: {
      principal: 'test:runner',
      platforms: [platform],
      scopes: ['development', 'self-hosted-runner', 'ci'],
    },
    policy: {
      mode: 'require',
      onUnavailable: 'fail',
      allowPublicFallback: false,
      secretPolicy: 'references-only',
    },
    services: {
      'npm-registry': {
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
    ...overrides,
  };
}

function bytes(value = profile()) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function writeFakeNodeCommand(directory, name, source) {
  const modulePath = path.join(directory, `fake-${name}.mjs`);
  fs.writeFileSync(modulePath, source);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(directory, `${name}.cmd`),
      `@node "%~dp0fake-${name}.mjs" %*\r\n`,
    );
  } else {
    fs.writeFileSync(
      path.join(directory, name),
      `#!/usr/bin/env node\nimport './fake-${name}.mjs';\n`,
      { mode: 0o700 },
    );
  }
}

function toolConfigProfile() {
  return profile({
    services: {
      'cargo-registry': {
        kind: 'source-index',
        mode: 'require',
        endpoint: {
          type: 'http',
          url: 'http://cache.example.invalid/cargo-index/',
        },
        bindings: [
          {
            kind: 'config-key',
            key: 'cargo.source.crates-io',
            name: 'workhub',
            valueFrom: 'endpoint.url',
          },
        ],
        fallback: { mode: 'fail' },
        verification: { method: 'tool-native' },
      },
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
      'rocksdb-source': {
        kind: 'generic-download',
        mode: 'require',
        endpoint: {
          type: 'http',
          url: 'http://cache.example.invalid/sources/rocksdb.tar.gz',
        },
        bindings: [
          {
            kind: 'environment',
            key: 'KUNGFU_CONAN_ROCKSDB_SOURCE_URL',
            valueFrom: 'endpoint.url',
          },
        ],
        fallback: { mode: 'fail' },
        verification: { method: 'sha256-manifest' },
      },
    },
  });
}

function pythonCacheProfile(endpoint, { strict = true } = {}) {
  return profile({
    policy: strict
      ? profile().policy
      : {
          mode: 'prefer',
          onUnavailable: 'fallback',
          allowPublicFallback: true,
          secretPolicy: 'references-only',
        },
    services: {
      'python-index': {
        kind: 'package-registry',
        mode: strict ? 'require' : 'prefer',
        endpoint: { type: 'http', url: endpoint },
        bindings: [
          {
            kind: 'environment',
            key: 'UV_DEFAULT_INDEX',
            valueFrom: 'endpoint.url',
          },
        ],
        fallback: strict
          ? { mode: 'fail' }
          : { mode: 'upstream', upstreamUrl: 'https://pypi.org/simple' },
        verification: { method: 'tool-native' },
      },
    },
  });
}

function minimalUvLock() {
  return `version = 1
revision = 3
requires-python = ">=3.12"

[[package]]
name = "demo"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/demo.tar.gz", hash = "sha256:${'a'.repeat(64)}", size = 1 }
`;
}

function installFakeUv(bin) {
  fs.writeFileSync(
    path.join(bin, 'fake-uv.mjs'),
    `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const projectAt = args.indexOf('--project');
const project = args[projectAt + 1];
if (args.includes('lock')) {
  if (process.env.FAKE_UV_FAIL_LOCK) process.exit(42);
  const file = path.join(project, 'uv.lock');
  const endpoint = args[args.indexOf('--default-index') + 1];
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replaceAll('https://pypi.org/simple', endpoint)
    .replaceAll('https://files.pythonhosted.org', new URL(endpoint).origin));
} else if (process.env.FAKE_UV_OUTPUT) {
  fs.writeFileSync(process.env.FAKE_UV_OUTPUT, JSON.stringify({
    args,
    environment: process.env.UV_PROJECT_ENVIRONMENT,
    frozen: process.env.UV_FROZEN,
    pdmIndex: process.env.PDM_PYPI_URL,
    pdmVerifySsl: process.env.PDM_PYPI_VERIFY_SSL,
  }));
}
`,
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(bin, 'uv.cmd'),
      '@node "%~dp0fake-uv.mjs" %*\r\n',
    );
  } else {
    fs.writeFileSync(
      path.join(bin, 'uv'),
      '#!/bin/sh\nexec node "$(dirname "$0")/fake-uv.mjs" "$@"\n',
      { mode: 0o700 },
    );
  }
}

test('validates exact bytes and applies only environment bindings', () => {
  const raw = bytes();
  const digest = sha256(raw);
  const resolved = validateProfileBytes(raw, {
    expectedDigest: digest,
    platform,
    scope: 'self-hosted-runner',
  });
  assert.equal(resolved.digest, digest);
  assert.deepEqual(resolved.bindings, {
    COREPACK_NPM_REGISTRY: 'http://cache.example.invalid/npm/',
  });
});

test('origin-only registry endpoints do not gain a trailing slash', () => {
  const value = profile();
  value.services['npm-registry'].endpoint.url = 'http://cache.example.invalid';
  value.services['npm-registry'].bindings.push({
    kind: 'environment',
    key: 'NPM_CONFIG_REGISTRY',
    valueFrom: 'endpoint.url',
  });
  const resolved = validateProfileBytes(bytes(value));
  assert.deepEqual(resolved.bindings, {
    COREPACK_NPM_REGISTRY: 'http://cache.example.invalid',
    NPM_CONFIG_REGISTRY: 'http://cache.example.invalid',
  });
});

test('fails closed on digest mismatch and secret-like environment keys', () => {
  assert.throws(
    () =>
      validateProfileBytes(bytes(), {
        expectedDigest: `sha256:${'0'.repeat(64)}`,
      }),
    /digest mismatch/,
  );
  const unsafe = profile();
  unsafe.services['npm-registry'].bindings[0].key = 'CACHE_AUTH_TOKEN';
  assert.throws(() => validateProfileBytes(bytes(unsafe)), /secret-like/);
  const forgedContext = profile();
  forgedContext.services['npm-registry'].bindings[0].key = 'SHIFU_CACHE_BYPASS';
  assert.throws(
    () => validateProfileBytes(bytes(forgedContext)),
    /environment binding key is protected/,
  );
});

test('rejects endpoint credentials, query strings, and unknown fields', () => {
  for (const url of [
    'https://user:pass@cache.example.invalid/npm/',
    'https://cache.example.invalid/npm/?token=redacted',
    'https://cache.example.invalid/npm/#fragment',
  ]) {
    const unsafe = profile();
    unsafe.services['npm-registry'].endpoint.url = url;
    assert.throws(() => validateProfileBytes(bytes(unsafe)), CacheProfileError);
  }
  const unknown = profile({ unexpected: true });
  assert.throws(() => validateProfileBytes(bytes(unknown)), /not supported/);
  const unsupportedConfig = toolConfigProfile();
  unsupportedConfig.services['cargo-registry'].bindings[0].key =
    'cargo.credentials';
  assert.throws(
    () => validateProfileBytes(bytes(unsupportedConfig)),
    /config-key is not supported/,
  );
  const unsafeAlias = toolConfigProfile();
  unsafeAlias.services['cargo-registry'].bindings[0].name = 'workhub.bad';
  assert.throws(
    () => validateProfileBytes(bytes(unsafeAlias)),
    /config-key name is invalid/,
  );
});

test('resolves an HTTP reference and emits a redacted schema receipt', async (t) => {
  const raw = bytes();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(raw);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const reference = `http://127.0.0.1:${address.port}/profile.json`;
  const resolved = await resolveCacheProfile({
    reference,
    expectedDigest: sha256(raw),
    scope: 'self-hosted-runner',
  });
  assert.equal(resolved.receipt.schema, 'shifu.cache-resolution/v1');
  assert.equal(
    resolved.receipt.redaction,
    'credentials-userinfo-query-fragment',
  );
  assert.equal(
    resolved.receipt.services['npm-registry'].selected.url,
    'http://cache.example.invalid/npm/',
  );
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        '../docs/shifu/schema/cache-resolution-v1.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  if (!Ajv2020) return;
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat('date-time', (value) => Number.isFinite(Date.parse(value)));
  ajv.addFormat('uri-reference', () => true);
  const validate = ajv.compile(schema);
  assert.equal(
    validate(resolved.receipt),
    true,
    JSON.stringify(validate.errors),
  );
});

test('cache apply injects bindings and writes a receipt', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-apply-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = bytes();
  const profilePath = path.join(directory, 'profile.json');
  const outputPath = path.join(directory, 'child.json');
  const receiptPath = path.join(directory, 'receipt.json');
  fs.writeFileSync(profilePath, raw);
  const script = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({value: process.env.COREPACK_NPM_REGISTRY, active: process.env.SHIFU_CACHE_ACTIVE}))`;
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    receiptPath,
    command: process.execPath,
    args: ['-e', script],
  });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), {
    value: 'http://cache.example.invalid/npm/',
    active: '1',
  });
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.profile.digest, sha256(raw));
  assert.match(receipt.execution.id, /^run:/);
});

test('cache apply strips inherited uv transport when the profile has no Python index', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-no-uv-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = bytes();
  const profilePath = path.join(directory, 'profile.json');
  const outputPath = path.join(directory, 'child.json');
  fs.writeFileSync(profilePath, raw);
  const script = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({defaultIndex: process.env.UV_DEFAULT_INDEX, indexUrl: process.env.UV_INDEX_URL, noConfig: process.env.UV_NO_CONFIG}))`;
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: ['-e', script],
    env: {
      ...process.env,
      UV_DEFAULT_INDEX: 'http://cache.example.invalid/simple/',
      UV_INDEX_URL: 'http://cache.example.invalid/legacy/',
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), {
    noConfig: '1',
  });
});

test('strict Python cache uses a disposable effective lock and redacted receipt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-cache-uv-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo');
  const project = path.join(repo, 'framework', 'core');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(project, 'pyproject.toml'),
    '[project]\nname="demo"\nversion="1.0.0"\n',
  );
  fs.writeFileSync(path.join(project, 'uv.lock'), minimalUvLock());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync(
    'git',
    ['add', 'framework/core/pyproject.toml', 'framework/core/uv.lock'],
    { cwd: repo },
  );
  installFakeUv(bin);

  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/simple/`;
  const raw = bytes(pythonCacheProfile(endpoint));
  const profilePath = path.join(directory, 'profile.json');
  const outputPath = path.join(directory, 'uv-invocation.json');
  const receiptPath = path.join(directory, 'receipt.json');
  fs.writeFileSync(profilePath, raw);
  const canonical = fs.readFileSync(path.join(project, 'uv.lock'), 'utf8');
  const statusBefore = spawnSync('git', ['status', '--short'], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout;
  const script = `const result = require('node:child_process').spawnSync('uv', ['sync'], {stdio:'inherit', shell: process.platform === 'win32'}); process.exit(result.status ?? 1)`;
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'self-hosted-runner',
    receiptPath,
    command: process.execPath,
    args: ['-e', script],
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      SHIFU_UV_ORIGINAL_PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_UV_OUTPUT: outputPath,
    },
  });
  assert.equal(status, 0);
  assert.equal(
    fs.readFileSync(path.join(project, 'uv.lock'), 'utf8'),
    canonical,
  );
  assert.equal(
    spawnSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' })
      .stdout,
    statusBefore,
  );
  const invocation = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.match(invocation.environment, /shifu-uv-overlay-/);
  assert.equal(invocation.frozen, '1');
  assert.equal(invocation.pdmIndex, endpoint);
  assert.equal(invocation.pdmVerifySsl, 'false');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const service = receipt.services['python-index'];
  assert.equal(service.verification, 'passed');
  assert.equal(service.application.overlayCleanup, 'completed');
  assert.equal(service.application.toolEvidence.adapter, 'uv-effective-lock');
  assert.equal(service.application.toolEvidence.projectCount, 1);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /shifu-uv-overlay-|framework\/core/,
  );
});

test('strict Python cache fails before starting the child when effective lock rebinding fails', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-uv-fail-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo');
  const project = path.join(repo, 'framework', 'core');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(project, 'pyproject.toml'),
    '[project]\nname="demo"\nversion="1.0.0"\n',
  );
  fs.writeFileSync(path.join(project, 'uv.lock'), minimalUvLock());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync(
    'git',
    ['add', 'framework/core/pyproject.toml', 'framework/core/uv.lock'],
    { cwd: repo },
  );
  installFakeUv(bin);
  const raw = bytes(pythonCacheProfile('http://cache.example.invalid/simple/'));
  const profilePath = path.join(directory, 'profile.json');
  const receiptPath = path.join(directory, 'receipt.json');
  const childPath = path.join(directory, 'child-ran');
  fs.writeFileSync(profilePath, raw);
  await assert.rejects(
    applyCacheProfile({
      reference: profilePath,
      expectedDigest: sha256(raw),
      scope: 'self-hosted-runner',
      receiptPath,
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(childPath)}, 'ran')`,
      ],
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        SHIFU_UV_ORIGINAL_PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        FAKE_UV_FAIL_LOCK: '1',
      },
    }),
    /uv(?:\.cmd)? lock.*failed/,
  );
  assert.equal(fs.existsSync(childPath), false);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.services['python-index'].outcome, 'failed');
  assert.equal(receipt.services['python-index'].verification, 'failed');
});

test('development Python cache records declared fallback when effective lock is unavailable', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-uv-fallback-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo');
  const project = path.join(repo, 'framework', 'core');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(project, 'pyproject.toml'),
    '[project]\nname="demo"\nversion="1.0.0"\n',
  );
  fs.writeFileSync(path.join(project, 'uv.lock'), minimalUvLock());
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync(
    'git',
    ['add', 'framework/core/pyproject.toml', 'framework/core/uv.lock'],
    { cwd: repo },
  );
  installFakeUv(bin);
  const raw = bytes(
    pythonCacheProfile('http://cache.example.invalid/simple/', {
      strict: false,
    }),
  );
  const profilePath = path.join(directory, 'profile.json');
  const receiptPath = path.join(directory, 'receipt.json');
  const childPath = path.join(directory, 'child-ran');
  fs.writeFileSync(profilePath, raw);
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    receiptPath,
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(childPath)}, 'ran')`,
    ],
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      SHIFU_UV_ORIGINAL_PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      FAKE_UV_FAIL_LOCK: '1',
    },
  });
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(childPath, 'utf8'), 'ran');
  const service = JSON.parse(fs.readFileSync(receiptPath, 'utf8')).services[
    'python-index'
  ];
  assert.equal(service.outcome, 'fallback');
  assert.equal(service.fallbackUsed, true);
  assert.equal(service.verification, 'failed');
});

test('cache apply overrides Cargo and isolates Conan without mutating persistent config', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-config-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const persistentCargo = path.join(directory, 'persistent-cargo');
  const persistentConan = path.join(directory, 'persistent-conan');
  fs.mkdirSync(persistentCargo);
  fs.mkdirSync(persistentConan);
  const cargoSentinel = '[sentinel]\nvalue = "persistent-cargo"\n';
  const conanSentinel = '{"sentinel":"persistent-conan"}\n';
  fs.writeFileSync(path.join(persistentCargo, 'config.toml'), cargoSentinel);
  fs.writeFileSync(path.join(persistentConan, 'remotes.json'), conanSentinel);

  const raw = bytes(toolConfigProfile());
  const profilePath = path.join(directory, 'profile.json');
  const outputPath = path.join(directory, 'child.json');
  const receiptPath = path.join(directory, 'receipt.json');
  const fakeCargoArgsPath = path.join(directory, 'fake-cargo-args.json');
  const fakeConanArgsPath = path.join(directory, 'fake-conan-args.json');
  const xdgCache = path.join(directory, 'cache');
  const partition = conanStoragePartition(
    'development',
    process.env,
    process.cwd(),
  );
  const conanStorage = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    partition,
  );
  const conanDownloads = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    'artifacts',
    'downloads',
  );
  const fakeBin = path.join(directory, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const fakeCargoModule = path.join(fakeBin, 'fake-cargo.mjs');
  fs.writeFileSync(
    fakeCargoModule,
    `import fs from 'node:fs'; fs.writeFileSync(process.env.FAKE_CARGO_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(fakeBin, 'cargo.cmd'),
      '@node "%~dp0fake-cargo.mjs" %*\r\n',
    );
  } else {
    fs.writeFileSync(
      path.join(fakeBin, 'cargo'),
      "#!/usr/bin/env node\nimport './fake-cargo.mjs';\n",
      { mode: 0o700 },
    );
  }
  writeFakeNodeCommand(
    fakeBin,
    'conan',
    `import fs from 'node:fs'; fs.writeFileSync(process.env.FAKE_CONAN_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.writeFileSync(profilePath, raw);
  const script = [
    "const cp = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const result = cp.spawnSync('cargo', ['metadata'], {stdio: 'inherit', shell: process.platform === 'win32'});",
    'if (result.status !== 0) process.exit(result.status || 1);',
    "const conan = cp.spawnSync('conan', ['--version'], {stdio: 'inherit', shell: process.platform === 'win32'});",
    'if (conan.status !== 0) process.exit(conan.status || 1);',
    `fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({`,
    'cargoHome: process.env.CARGO_HOME,',
    'conanHome: process.env.CONAN_HOME,',
    'wrapperDir: process.env.PATH.split(path.delimiter)[0],',
    "conanRemotes: JSON.parse(fs.readFileSync(path.join(process.env.CONAN_HOME, 'remotes.json'), 'utf8')),",
    "conanGlobal: fs.readFileSync(path.join(process.env.CONAN_HOME, 'global.conf'), 'utf8'),",
    'rocksdbSource: process.env.KUNGFU_CONAN_ROCKSDB_SOURCE_URL,',
    'managedConan: process.env.SHIFU_CACHE_MANAGED_CONAN,',
    'wrapperFiles: fs.readdirSync(process.env.PATH.split(path.delimiter)[0]).sort(),',
    `storageMarker: ${JSON.stringify(path.join(conanStorage, 'packages', 'marker'))},`,
    '}));',
    `fs.mkdirSync(${JSON.stringify(path.join(conanStorage, 'packages'))}, {recursive: true});`,
    `fs.writeFileSync(${JSON.stringify(path.join(conanStorage, 'packages', 'marker'))}, 'warm');`,
  ].join('');
  const {
    SHIFU_CARGO_ORIGINAL_PATH: _cargoOriginalPath,
    SHIFU_CONAN_ORIGINAL_PATH: _conanOriginalPath,
    ...isolatedEnv
  } = process.env;
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    receiptPath,
    command: process.execPath,
    args: ['-e', script],
    env: {
      ...isolatedEnv,
      CARGO_HOME: persistentCargo,
      CONAN_HOME: persistentConan,
      XDG_CACHE_HOME: xdgCache,
      FAKE_CARGO_ARGS: fakeCargoArgsPath,
      FAKE_CONAN_ARGS: fakeConanArgsPath,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    },
  });
  assert.equal(status, 0);
  const child = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(child.cargoHome, persistentCargo);
  assert.notEqual(child.conanHome, persistentConan);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(fakeCargoArgsPath, 'utf8')),
    process.platform === 'win32'
      ? [
          '--config',
          'source.crates-io.replace-with=workhub',
          '--config',
          'source.workhub.registry=sparse+http://cache.example.invalid/cargo-index/',
          'metadata',
        ]
      : [
          '--config',
          'source.crates-io.replace-with="workhub"',
          '--config',
          'source.workhub.registry="sparse+http://cache.example.invalid/cargo-index/"',
          'metadata',
        ],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(fakeConanArgsPath, 'utf8')), [
    '--version',
  ]);
  assert.deepEqual(child.conanRemotes, {
    remotes: [
      {
        name: 'workhub-conan',
        url: 'http://cache.example.invalid/conan/',
        verify_ssl: false,
      },
    ],
  });
  assert.equal(child.managedConan, '1');
  assert.deepEqual(child.wrapperFiles, [
    'cargo',
    'cargo-wrapper.mjs',
    'cargo.cmd',
    'conan',
    'conan-wrapper.mjs',
    'conan.cmd',
  ]);
  assert.equal(
    child.rocksdbSource,
    'http://cache.example.invalid/sources/rocksdb.tar.gz',
  );
  assert.ok(
    child.conanGlobal
      .replaceAll('\\', '/')
      .includes(
        `core.cache:storage_path = ${path.join(conanStorage, 'packages').replaceAll('\\', '/')}`,
      ),
  );
  assert.ok(
    child.conanGlobal
      .replaceAll('\\', '/')
      .includes(
        `core.download:download_cache = ${conanDownloads.replaceAll('\\', '/')}`,
      ),
  );
  assert.equal(fs.readFileSync(child.storageMarker, 'utf8'), 'warm');
  assert.equal(
    fs.readFileSync(path.join(persistentCargo, 'config.toml'), 'utf8'),
    cargoSentinel,
  );
  assert.equal(
    fs.readFileSync(path.join(persistentConan, 'remotes.json'), 'utf8'),
    conanSentinel,
  );
  assert.equal(fs.existsSync(child.wrapperDir), false);
  assert.equal(fs.existsSync(child.conanHome), false);

  const warmPath = path.join(directory, 'warm.txt');
  const warmStatus = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(warmPath)},fs.readFileSync(${JSON.stringify(path.join(conanStorage, 'packages', 'marker'))},'utf8'))`,
    ],
    env: { ...process.env, XDG_CACHE_HOME: xdgCache },
  });
  assert.equal(warmStatus, 0);
  assert.equal(fs.readFileSync(warmPath, 'utf8'), 'warm');

  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  for (const [serviceId, service] of Object.entries(receipt.services)) {
    assert.deepEqual(
      service.application.bindingKinds,
      serviceId === 'rocksdb-source' ? ['environment'] : ['config-key'],
    );
    assert.equal(service.application.scope, 'child-process');
    assert.equal(
      service.application.persistentConfig,
      'not-read-or-written-by-shifu',
    );
    assert.equal(
      service.application.overlayCleanup,
      serviceId === 'rocksdb-source' ? 'not-applicable' : 'completed',
    );
  }
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /persistent-cargo|persistent-conan/,
  );
  assert.doesNotMatch(JSON.stringify(receipt), /shifu-cache-overlay-/);
  assert.deepEqual(receipt.services['conan-storage'].application.conanStorage, {
    mode: 'persistent-host-local',
    namespace: 'workhub-v1',
    pathDigest: sha256(Buffer.from(conanStorage)),
    partitionDigest: sha256(Buffer.from(partition)),
    lock: 'on-demand',
    artifactLayer: {
      binaryAuthority: 'hosted-remote',
      identity: 'rrev-package-id-prev',
      downloadCache: 'shared-content-addressed',
      downloadPathDigest: sha256(Buffer.from(conanDownloads)),
      concurrency: 'conan-content-locks',
      worktreeIndependent: true,
    },
  });
});

test('cache apply cleans config overlays after a failing child', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-failure-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = bytes(toolConfigProfile());
  const profilePath = path.join(directory, 'profile.json');
  const outputPath = path.join(directory, 'child.json');
  const xdgCache = path.join(directory, 'cache');
  fs.writeFileSync(profilePath, raw);
  const script = `const path = require('node:path'); require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({wrapperDir: process.env.PATH.split(path.delimiter)[0], conanHome: process.env.CONAN_HOME})); process.exit(17)`;
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: ['-e', script],
    env: { ...process.env, XDG_CACHE_HOME: xdgCache },
  });
  assert.equal(status, 17);
  const child = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(fs.existsSync(child.wrapperDir), false);
  assert.equal(fs.existsSync(child.conanHome), false);
  const storage = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    conanStoragePartition('development', process.env, process.cwd()),
  );
  assert.equal(fs.existsSync(storage), true);
  assert.equal(fs.existsSync(path.join(storage, '.shifu-conan.lock')), false);
});

test('nested cache apply preserves the original tool PATH instead of wrapping a wrapper', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-nested-tools-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = bytes(toolConfigProfile());
  const profilePath = path.join(directory, 'profile.json');
  const childPath = path.join(directory, 'nested-apply.mjs');
  const outputPath = path.join(directory, 'nested.json');
  const fakeBin = path.join(directory, 'fake-bin');
  const originalPath = `${fakeBin}${path.delimiter}${process.env.PATH || ''}`;
  const expectedOriginalPath = originalPath;
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(profilePath, raw);
  fs.writeFileSync(
    childPath,
    `import fs from 'node:fs';
import path from 'node:path';
import { applyCacheProfile } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/shifu-cache-runtime.mjs')).href)};
const status = await applyCacheProfile({
  reference: ${JSON.stringify(profilePath)},
  expectedDigest: ${JSON.stringify(sha256(raw))},
  scope: 'development',
  command: process.execPath,
  args: ['-e', ${JSON.stringify(`const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ path: process.env.PATH.split(path.delimiter), cargoOriginalPath: process.env.SHIFU_CARGO_ORIGINAL_PATH, conanOriginalPath: process.env.SHIFU_CONAN_ORIGINAL_PATH }));`)}],
  env: process.env,
});
process.exit(status);
`,
  );
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: [childPath],
    env: {
      ...process.env,
      PATH: originalPath,
      SHIFU_CARGO_ORIGINAL_PATH: 'stale-outer-cargo-path',
      SHIFU_CONAN_ORIGINAL_PATH: 'stale-outer-conan-path',
      XDG_CACHE_HOME: path.join(directory, 'cache'),
    },
  });
  assert.equal(status, 0);
  const nested = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(nested.cargoOriginalPath, expectedOriginalPath);
  assert.equal(nested.conanOriginalPath, expectedOriginalPath);
  assert.match(nested.path[0], /shifu-cache-overlay-/);
  assert.match(nested.path[1], /shifu-cache-overlay-/);
  assert.notEqual(nested.path[0], nested.path[1]);
});

test('nested Gate task re-entry does not acquire Conan storage when Conan is unused', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-gate-reentry-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'checkout');
  const xdgCache = path.join(directory, 'cache');
  const outputPath = path.join(directory, 'nested.json');
  const profilePath = path.join(directory, 'profile.json');
  const childPath = path.join(directory, 'run-gate.mjs');
  const nestedPath = path.join(directory, 'nested-shifu.mjs');
  const registryPath = path.join(
    ROOT,
    'docs/shifu/examples/gates/execution.gate-registry.json',
  );
  const storage = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    conanStoragePartition('development', process.env, root),
  );
  const lock = path.join(storage, '.shifu-conan.lock');
  fs.mkdirSync(root, { recursive: true });
  const raw = bytes(toolConfigProfile());
  fs.writeFileSync(profilePath, raw);
  fs.writeFileSync(
    nestedPath,
    `import fs from 'node:fs';
const active = process.env.SHIFU_CACHE_ACTIVE || '';
const lock = process.env.SHIFU_REENTRY_LOCK;
if (active !== '1') {
  try {
    fs.closeSync(fs.openSync(lock, 'wx'));
  } catch (error) {
    process.stderr.write(\`nested cache apply collided with outer lock: \${error.code}\\n\`);
    process.exit(23);
  }
}
fs.writeFileSync(process.env.SHIFU_REENTRY_OUTPUT, JSON.stringify({
  active,
  bypass: process.env.SHIFU_CACHE_BYPASS || '',
  conanHome: process.env.CONAN_HOME || '',
  lockHeld: fs.existsSync(lock),
}));
`,
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(root, 'shifu.cmd'),
      `@echo off\r\n"${process.execPath}" "${nestedPath}" %*\r\n`,
    );
  } else {
    fs.writeFileSync(
      path.join(root, 'shifu'),
      `#!/bin/sh\nexec "${process.execPath}" "${nestedPath}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  const executorUrl = pathToFileURL(
    path.join(ROOT, 'scripts/shifu-gate-executor.mjs'),
  ).href;
  const runtimeUrl = pathToFileURL(
    path.join(ROOT, 'scripts/shifu-gate-runtime.mjs'),
  ).href;
  fs.writeFileSync(
    childPath,
    `import fs from 'node:fs';
import { executeGateRun } from ${JSON.stringify(executorUrl)};
import { validateGateRegistryBytes } from ${JSON.stringify(runtimeUrl)};
const loaded = validateGateRegistryBytes(fs.readFileSync(${JSON.stringify(registryPath)}));
if (loaded.issues.length) throw new Error(JSON.stringify(loaded.issues));
const receipt = await executeGateRun(loaded.registry, {
  root: ${JSON.stringify(root)},
  registryRef: 'fixture.gate-registry.json',
  registryDigest: loaded.digest,
  explicitGates: ['fixture.task-dogfood'],
  source: { sha: '${'a'.repeat(40)}', dirty: false },
  writer: process.stderr,
});
process.exit(receipt.ok ? 0 : 1);
`,
  );
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: [childPath],
    cwd: root,
    env: {
      ...process.env,
      XDG_CACHE_HOME: xdgCache,
      SHIFU_REENTRY_LOCK: lock,
      SHIFU_REENTRY_OUTPUT: outputPath,
    },
  });
  assert.equal(status, 0);
  const nested = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(nested.active, '1');
  assert.equal(nested.bypass, '');
  assert.match(nested.conanHome, /shifu-cache-overlay-.*conan-home/);
  assert.equal(nested.lockHeld, false);
  assert.equal(fs.existsSync(lock), false);
});

test('a non-Conan child does not contend with an occupied Conan partition', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-conan-lock-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const xdgCache = path.join(directory, 'cache');
  const principal = 'non-conan-child';
  const partition = conanStoragePartition('development', {
    SHIFU_CACHE_PRINCIPAL: principal,
  });
  const storage = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    partition,
  );
  fs.mkdirSync(storage, { recursive: true });
  const lock = path.join(storage, '.shifu-conan.lock');
  const liveOwner = `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`;
  fs.writeFileSync(lock, liveOwner);
  const raw = bytes(toolConfigProfile());
  const profilePath = path.join(directory, 'profile.json');
  fs.writeFileSync(profilePath, raw);
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: {
      ...process.env,
      XDG_CACHE_HOME: xdgCache,
      SHIFU_CACHE_PRINCIPAL: principal,
    },
  });
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), liveOwner);
});

test('a Conan child waits boundedly and preserves a live same-partition lock', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-conan-live-lock-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const principal = 'live-lock';
  const xdgCache = path.join(directory, 'cache');
  const storage = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    conanStoragePartition('development', {
      SHIFU_CACHE_PRINCIPAL: principal,
    }),
  );
  fs.mkdirSync(storage, { recursive: true });
  const lock = path.join(storage, '.shifu-conan.lock');
  const owner = `${JSON.stringify({ pid: process.pid, token: 'owner', acquiredAt: new Date().toISOString() })}\n`;
  fs.writeFileSync(lock, owner);
  const fakeBin = path.join(directory, 'fake-bin');
  fs.mkdirSync(fakeBin);
  writeFakeNodeCommand(fakeBin, 'conan', 'process.exit(0);\n');
  const raw = bytes(toolConfigProfile());
  const profilePath = path.join(directory, 'profile.json');
  fs.writeFileSync(profilePath, raw);
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: [
      '-e',
      "const r=require('node:child_process').spawnSync('conan',['--version'],{stdio:'inherit',shell:process.platform==='win32'});process.exit(r.status??1)",
    ],
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      XDG_CACHE_HOME: xdgCache,
      SHIFU_CACHE_PRINCIPAL: principal,
      SHIFU_CONAN_LOCK_TIMEOUT_MS: '20',
    },
  });
  assert.equal(status, 1);
  assert.equal(fs.readFileSync(lock, 'utf8'), owner);
});

test('a Conan child reclaims a lock whose recorded process is dead', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-cache-conan-stale-lock-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const principal = 'stale-lock';
  const xdgCache = path.join(directory, 'cache');
  const storage = path.join(
    xdgCache,
    'kungfu',
    'conan',
    'workhub-v1',
    conanStoragePartition('development', {
      SHIFU_CACHE_PRINCIPAL: principal,
    }),
  );
  fs.mkdirSync(storage, { recursive: true });
  const lock = path.join(storage, '.shifu-conan.lock');
  fs.writeFileSync(
    lock,
    `${JSON.stringify({ pid: 2147483647, token: 'dead-owner', acquiredAt: '2026-07-14T00:00:00Z' })}\n`,
  );
  const fakeBin = path.join(directory, 'fake-bin');
  fs.mkdirSync(fakeBin);
  writeFakeNodeCommand(fakeBin, 'conan', 'process.exit(0);\n');
  const raw = bytes(toolConfigProfile());
  const profilePath = path.join(directory, 'profile.json');
  fs.writeFileSync(profilePath, raw);
  const status = await applyCacheProfile({
    reference: profilePath,
    expectedDigest: sha256(raw),
    scope: 'development',
    command: process.execPath,
    args: [
      '-e',
      "const r=require('node:child_process').spawnSync('conan',['--version'],{stdio:'inherit',shell:process.platform==='win32'});process.exit(r.status??1)",
    ],
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      XDG_CACHE_HOME: xdgCache,
      SHIFU_CACHE_PRINCIPAL: principal,
    },
  });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(lock), false);
});

test('cache apply is a transparent pass-through when no profile is configured', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-cache-pass-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, 'ran');
  const status = await applyCacheProfile({
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, 'yes')`,
    ],
  });
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'yes');
});
