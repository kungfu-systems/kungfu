#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Resolve one trusted Shifu cache profile, apply its bindings to one child,
// and emit a redacted resolution receipt. Pure Node builtins: this path is
// available before repository dependencies are installed.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareUvCacheOverlay } from './shifu-uv-cache-adapter.mjs';

const PROFILE_SCHEMA = 'shifu.cache-profile/v1';
const RECEIPT_SCHEMA = 'shifu.cache-resolution/v1';
const REDACTION = 'credentials-userinfo-query-fragment';
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NODE_OPTIONS',
  'CARGO_HOME',
  'UV_PROJECT',
  'UV_PROJECT_ENVIRONMENT',
  'UV_FROZEN',
  'UV_LOCKED',
  'UV_OFFLINE',
  'UV_INDEX',
  'UV_INDEX_URL',
  'UV_EXTRA_INDEX_URL',
  'UV_FIND_LINKS',
  'CONAN_HOME',
  'KF_LIBWASM_CARGO_REGISTRY',
  'SHIFU_CACHE_ACTIVE',
  'SHIFU_CACHE_BYPASS',
  'SHIFU_CARGO_ORIGINAL_PATH',
  'SHIFU_CARGO_REGISTRY',
  'SHIFU_CARGO_SOURCE_NAME',
  'SHIFU_CACHE_MANAGED_CONAN',
  'SHIFU_CACHE_PRINCIPAL',
  'SHIFU_CONAN_LOCK_TIMEOUT_MS',
  'SHIFU_CONAN_ORIGINAL_PATH',
  'SHIFU_CONAN_STORAGE_ROOT',
  'SHIFU_CACHE_PROFILE_REF',
  'SHIFU_CACHE_PROFILE_DIGEST',
]);
const UV_TRANSPORT_ENV_KEYS = [
  'UV_DEFAULT_INDEX',
  'UV_INDEX',
  'UV_INDEX_URL',
  'UV_EXTRA_INDEX_URL',
  'UV_FIND_LINKS',
];
const CONFIG_KEYS = new Set([
  'cargo.source.crates-io',
  'conan.remote.conancenter',
  'conan.cache.storage',
]);
const SHIFU_CACHE_HOME_TOKEN = '${SHIFU_CACHE_HOME}';
const SECRET_KEY_RE =
  /(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|PRIVATE_KEY|AUTH)/;
const VERIFICATION_METHODS = new Set([
  'upstream-checksum',
  'sha256-manifest',
  'signature',
  'tool-native',
  'transport-only',
  'none',
]);

export class CacheProfileError extends Error {}

function assert(condition, message) {
  if (!condition) throw new CacheProfileError(message);
}

function assertObject(value, label) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function assertExactKeys(value, allowed, required, label) {
  const object = assertObject(value, label);
  for (const key of required)
    assert(Object.hasOwn(object, key), `${label}.${key} is required`);
  for (const key of Object.keys(object))
    assert(allowed.has(key), `${label}.${key} is not supported`);
}

export function sha256(raw) {
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function checkedHttpUrl(value, label) {
  assert(typeof value === 'string', `${label} must be a string`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new CacheProfileError(`${label} is not a URL: ${error.message}`);
  }
  assert(
    parsed.protocol === 'http:' || parsed.protocol === 'https:',
    `${label} must use http(s)`,
  );
  assert(
    !parsed.username && !parsed.password,
    `${label} must not contain userinfo`,
  );
  assert(
    !parsed.search && !parsed.hash,
    `${label} must not contain query or fragment`,
  );
  const canonical = parsed.toString();
  // URL serialisation adds `/` to an origin-only URL. Preserve the profile's
  // no-trailing-slash form because base-URL consumers such as Corepack append
  // their own absolute path and otherwise request `//<package>/<version>`.
  if (parsed.pathname === '/' && !value.trimEnd().endsWith('/')) {
    return parsed.origin;
  }
  return canonical;
}

function platformId() {
  const osName =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'windows'
        : process.platform;
  const arch =
    process.arch === 'x64'
      ? 'x64'
      : process.arch === 'arm64'
        ? 'arm64'
        : process.arch;
  return `${osName}-${arch}`;
}

export function inferScope(env = process.env) {
  if (env.SHIFU_CACHE_SCOPE) return env.SHIFU_CACHE_SCOPE;
  if (env.RUNNER_ENVIRONMENT === 'self-hosted') return 'self-hosted-runner';
  if (String(env.CI || '').toLowerCase() === 'true') return 'ci';
  return 'development';
}

function expandLocalReference(reference, cwd) {
  if (reference.startsWith('file://')) return fileURLToPath(reference);
  if (reference === '~') return os.homedir();
  if (reference.startsWith('~/') || reference.startsWith('~\\')) {
    return path.join(os.homedir(), reference.slice(2));
  }
  return path.resolve(cwd, reference);
}

export async function readProfileReference(
  reference,
  { cwd = process.cwd(), timeoutMs = 10_000 } = {},
) {
  assert(
    typeof reference === 'string' && reference,
    'cache profile reference is required',
  );
  if (/^https?:\/\//.test(reference)) {
    const url = checkedHttpUrl(reference, 'cache profile reference');
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new CacheProfileError(
        `cannot fetch cache profile: ${error.message}`,
      );
    }
    assert(response.ok, `cannot fetch cache profile: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const local = expandLocalReference(reference, cwd);
  try {
    return fs.readFileSync(local);
  } catch (error) {
    throw new CacheProfileError(
      `cannot read cache profile ${local}: ${error.message}`,
    );
  }
}

function endpointValue(endpoint, binding) {
  if (binding.valueFrom === 'endpoint.url') {
    assert(
      endpoint.type === 'http',
      'endpoint.url binding requires an http endpoint',
    );
    return endpoint.url;
  }
  if (binding.valueFrom === 'endpoint.path') {
    assert(
      endpoint.type === 'local-path',
      'endpoint.path binding requires a local-path endpoint',
    );
    return endpoint.path;
  }
  throw new CacheProfileError(
    `unsupported binding valueFrom: ${binding.valueFrom}`,
  );
}

function validateBinding(binding, serviceId) {
  assertExactKeys(
    binding,
    new Set(['kind', 'key', 'name', 'valueFrom']),
    ['kind', 'key', 'valueFrom'],
    `services.${serviceId}.binding`,
  );
  assert(
    ['environment', 'argument', 'config-key'].includes(binding.kind),
    `services.${serviceId} binding kind is invalid`,
  );
  assert(
    typeof binding.key === 'string' && binding.key,
    `services.${serviceId} binding key is required`,
  );
  assert(
    ['endpoint.url', 'endpoint.path'].includes(binding.valueFrom),
    `services.${serviceId} binding valueFrom is invalid`,
  );
  if (binding.kind === 'config-key') {
    assert(
      CONFIG_KEYS.has(binding.key),
      `services.${serviceId} config-key is not supported: ${binding.key}`,
    );
    const expectedValueFrom =
      binding.key === 'conan.cache.storage' ? 'endpoint.path' : 'endpoint.url';
    assert(
      binding.valueFrom === expectedValueFrom,
      `services.${serviceId} config-key ${binding.key} requires ${expectedValueFrom}`,
    );
    assert(
      typeof binding.name === 'string' &&
        /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(binding.name),
      `services.${serviceId} config-key name is invalid`,
    );
  } else {
    assert(
      !Object.hasOwn(binding, 'name'),
      `services.${serviceId} ${binding.kind} binding cannot declare name`,
    );
  }
}

function validateEnvironmentKey(key) {
  assert(ENV_KEY_RE.test(key), `environment binding key is invalid: ${key}`);
  assert(
    !BLOCKED_ENV_KEYS.has(key),
    `environment binding key is protected: ${key}`,
  );
  assert(
    !SECRET_KEY_RE.test(key),
    `environment binding key is secret-like: ${key}`,
  );
}

function validateEndpoint(endpoint, serviceId) {
  assertObject(endpoint, `services.${serviceId}.endpoint`);
  if (endpoint.type === 'http') {
    assertExactKeys(
      endpoint,
      new Set(['type', 'url']),
      ['type', 'url'],
      `services.${serviceId}.endpoint`,
    );
    return {
      type: 'http',
      url: checkedHttpUrl(endpoint.url, `services.${serviceId}.endpoint.url`),
    };
  }
  assert(
    endpoint.type === 'local-path',
    `services.${serviceId} endpoint type is invalid`,
  );
  assertExactKeys(
    endpoint,
    new Set(['type', 'path']),
    ['type', 'path'],
    `services.${serviceId}.endpoint`,
  );
  assert(
    typeof endpoint.path === 'string' && endpoint.path,
    `services.${serviceId}.endpoint.path is required`,
  );
  return endpoint;
}

function validateVerification(verification, serviceId) {
  const label = `services.${serviceId}.verification`;
  assertExactKeys(
    verification,
    new Set(['method', 'rationale', 'probe']),
    ['method'],
    label,
  );
  assert(
    VERIFICATION_METHODS.has(verification.method),
    `${label}.method is invalid`,
  );
  if (Object.hasOwn(verification, 'rationale'))
    assert(
      typeof verification.rationale === 'string' &&
        verification.rationale.length >= 1 &&
        verification.rationale.length <= 512,
      `${label}.rationale must contain 1-512 characters`,
    );
  if (verification.method === 'none') {
    assert(
      Object.hasOwn(verification, 'rationale'),
      `${label}.rationale is required when method is none`,
    );
    assert(
      !Object.hasOwn(verification, 'probe'),
      `${label}.probe is incompatible with method none`,
    );
  }
  if (!Object.hasOwn(verification, 'probe')) return;
  const probe = verification.probe;
  assertExactKeys(
    probe,
    new Set(['path', 'timeoutMs', 'attempts', 'retryDelayMs']),
    [],
    `${label}.probe`,
  );
  if (Object.hasOwn(probe, 'path'))
    assert(
      typeof probe.path === 'string' &&
        probe.path.startsWith('/') &&
        !probe.path.startsWith('//') &&
        !/[?#\\]/.test(probe.path),
      `${label}.probe.path must be a same-origin absolute path without query or fragment`,
    );
  if (Object.hasOwn(probe, 'timeoutMs'))
    assert(
      Number.isInteger(probe.timeoutMs) &&
        probe.timeoutMs >= 100 &&
        probe.timeoutMs <= 30_000,
      `${label}.probe.timeoutMs must be an integer from 100 to 30000`,
    );
  if (Object.hasOwn(probe, 'attempts'))
    assert(
      Number.isInteger(probe.attempts) &&
        probe.attempts >= 1 &&
        probe.attempts <= 3,
      `${label}.probe.attempts must be an integer from 1 to 3`,
    );
  if (Object.hasOwn(probe, 'retryDelayMs'))
    assert(
      Number.isInteger(probe.retryDelayMs) &&
        probe.retryDelayMs >= 0 &&
        probe.retryDelayMs <= 2_000,
      `${label}.probe.retryDelayMs must be an integer from 0 to 2000`,
    );
}

export function validateProfileBytes(
  raw,
  { expectedDigest = '', scope = '', platform = '' } = {},
) {
  const digest = sha256(raw);
  if (expectedDigest) {
    assert(
      DIGEST_RE.test(expectedDigest),
      'expected profile digest must be sha256:<64 lowercase hex>',
    );
    assert(
      digest === expectedDigest,
      `cache profile digest mismatch: expected ${expectedDigest}, got ${digest}`,
    );
  }
  let profile;
  try {
    profile = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new CacheProfileError(
      `cache profile is invalid JSON: ${error.message}`,
    );
  }
  assertExactKeys(
    profile,
    new Set([
      '$schema',
      'schema',
      'profileId',
      'revision',
      'generatedAt',
      'authority',
      'subject',
      'policy',
      'services',
      'evidence',
    ]),
    [
      '$schema',
      'schema',
      'profileId',
      'revision',
      'generatedAt',
      'authority',
      'subject',
      'policy',
      'services',
      'evidence',
    ],
    'profile',
  );
  assert(
    profile.schema === PROFILE_SCHEMA,
    `unsupported cache profile schema: ${profile.schema}`,
  );
  assert(
    typeof profile.profileId === 'string' && profile.profileId,
    'profileId is required',
  );
  assert(
    Number.isInteger(profile.revision) && profile.revision >= 1,
    'revision must be >= 1',
  );
  assert(
    !Number.isNaN(Date.parse(profile.generatedAt)),
    'generatedAt must be a date-time',
  );
  assertExactKeys(
    profile.authority,
    new Set(['owner', 'sourceRef', 'sourceDigest']),
    ['owner', 'sourceRef', 'sourceDigest'],
    'authority',
  );
  assert(
    DIGEST_RE.test(profile.authority.sourceDigest),
    'authority.sourceDigest is invalid',
  );
  assertExactKeys(
    profile.subject,
    new Set(['principal', 'host', 'platforms', 'scopes']),
    ['principal', 'platforms', 'scopes'],
    'subject',
  );
  assert(
    Array.isArray(profile.subject.platforms) &&
      profile.subject.platforms.length > 0,
    'subject.platforms must not be empty',
  );
  assert(
    Array.isArray(profile.subject.scopes) && profile.subject.scopes.length > 0,
    'subject.scopes must not be empty',
  );
  if (platform)
    assert(
      profile.subject.platforms.includes(platform),
      `cache profile does not apply to platform ${platform}`,
    );
  if (scope)
    assert(
      profile.subject.scopes.includes(scope),
      `cache profile does not apply to scope ${scope}`,
    );
  assertExactKeys(
    profile.policy,
    new Set(['mode', 'onUnavailable', 'allowPublicFallback', 'secretPolicy']),
    ['mode', 'onUnavailable', 'allowPublicFallback', 'secretPolicy'],
    'policy',
  );
  assert(
    ['off', 'prefer', 'require'].includes(profile.policy.mode),
    'profile policy mode is invalid',
  );
  assert(
    ['bypass', 'fallback', 'fail'].includes(profile.policy.onUnavailable),
    'profile onUnavailable is invalid',
  );
  assert(
    profile.policy.secretPolicy === 'references-only',
    'profile secret policy must be references-only',
  );
  if (profile.policy.mode === 'require')
    assert(
      profile.policy.onUnavailable === 'fail',
      'required profile must fail when unavailable',
    );
  assertExactKeys(
    profile.evidence,
    new Set(['enabled', 'redaction']),
    ['enabled', 'redaction'],
    'evidence',
  );
  assert(
    profile.evidence.redaction === REDACTION,
    'unsupported evidence redaction policy',
  );

  const services = assertObject(profile.services, 'services');
  assert(Object.keys(services).length > 0, 'profile must contain services');
  const bindings = {};
  const configBindings = [];
  const receiptServices = {};
  for (const [serviceId, service] of Object.entries(services)) {
    assertExactKeys(
      service,
      new Set([
        'kind',
        'mode',
        'endpoint',
        'bindings',
        'fallback',
        'verification',
      ]),
      ['kind', 'endpoint', 'bindings', 'fallback', 'verification'],
      `services.${serviceId}`,
    );
    const endpoint = validateEndpoint(service.endpoint, serviceId);
    assert(
      Array.isArray(service.bindings) && service.bindings.length > 0,
      `services.${serviceId}.bindings must not be empty`,
    );
    const bindingKinds = new Set();
    for (const binding of service.bindings) {
      validateBinding(binding, serviceId);
      bindingKinds.add(binding.kind);
      if (binding.kind === 'argument') {
        throw new CacheProfileError(
          `runtime apply does not support ${binding.kind} binding ${serviceId}/${binding.key}`,
        );
      }
      if (binding.kind === 'environment') {
        validateEnvironmentKey(binding.key);
        assert(
          !Object.hasOwn(bindings, binding.key),
          `duplicate environment binding: ${binding.key}`,
        );
        bindings[binding.key] = endpointValue(endpoint, binding);
      } else {
        assert(
          !configBindings.some((item) => item.key === binding.key),
          `duplicate config-key binding: ${binding.key}`,
        );
        configBindings.push({
          serviceId,
          serviceKind: service.kind,
          key: binding.key,
          name: binding.name,
          value: endpointValue(endpoint, binding),
          fallback: service.fallback,
        });
      }
    }
    assertObject(service.fallback, `services.${serviceId}.fallback`);
    if (profile.policy.mode === 'require')
      assert(
        service.fallback.mode === 'fail',
        `required service ${serviceId} must fail`,
      );
    if (!profile.policy.allowPublicFallback)
      assert(
        service.fallback.mode !== 'upstream',
        `service ${serviceId} cannot use public fallback`,
      );
    validateVerification(service.verification, serviceId);
    receiptServices[serviceId] = {
      outcome: 'hit',
      selected:
        endpoint.type === 'http'
          ? { type: 'http', url: endpoint.url }
          : {
              type: 'local-path',
              pathDigest: sha256(Buffer.from(endpoint.path)),
            },
      fallbackUsed: false,
      verification: 'not-run',
      durationMs: 0,
      reason: 'profile binding selected',
      application: {
        bindingKinds: [...bindingKinds].sort(),
        scope: 'child-process',
        persistentConfig: 'not-read-or-written-by-shifu',
        overlayCleanup: bindingKinds.has('config-key')
          ? 'not-run'
          : 'not-applicable',
      },
    };
  }
  return {
    profile,
    digest,
    platform: platform || platformId(),
    scope: scope || inferScope(),
    bindings,
    configBindings,
    receiptServices,
  };
}

function conanRemotes(binding) {
  assert(
    binding.name !== 'conancenter',
    'managed Conan remote name must not shadow conancenter',
  );
  const remotes = [
    {
      name: binding.name,
      url: binding.value,
      verify_ssl: binding.value.startsWith('https:'),
    },
  ];
  if (binding.fallback?.mode === 'upstream') {
    const upstream = checkedHttpUrl(
      binding.fallback.upstreamUrl,
      `services.${binding.serviceId}.fallback.upstreamUrl`,
    );
    remotes.push({
      name: 'conancenter',
      url: upstream,
      verify_ssl: upstream.startsWith('https:'),
    });
  }
  return `${JSON.stringify({ remotes }, null, 1)}\n`;
}

function safePath(value) {
  return value.replaceAll('\\', '/');
}

function resolveShifuCachePath(template, baseEnv) {
  assert(
    template === SHIFU_CACHE_HOME_TOKEN ||
      template.startsWith(`${SHIFU_CACHE_HOME_TOKEN}/`),
    'managed Conan storage must be under ${SHIFU_CACHE_HOME}',
  );
  const relative = template
    .slice(SHIFU_CACHE_HOME_TOKEN.length)
    .replace(/^\//, '');
  const components = relative.split('/').filter(Boolean);
  assert(
    components.every((component) => component !== '.' && component !== '..'),
    'managed Conan storage must not contain path traversal',
  );
  const cacheBase = baseEnv.XDG_CACHE_HOME
    ? path.resolve(baseEnv.XDG_CACHE_HOME)
    : path.join(os.homedir(), '.cache');
  const root = path.resolve(cacheBase, 'kungfu');
  const resolved = path.resolve(root, ...components);
  assert(
    resolved === root || resolved.startsWith(`${root}${path.sep}`),
    'managed Conan storage escaped the Shifu cache root',
  );
  return resolved;
}

function gitWorktreePrincipal(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const root = result.status === 0 ? String(result.stdout || '').trim() : '';
  return path.normalize(root || path.resolve(cwd));
}

export function conanStoragePartition(
  scope,
  baseEnv = process.env,
  cwd = process.cwd(),
) {
  const explicit = String(baseEnv.SHIFU_CACHE_PRINCIPAL || '').trim();
  const runner = String(baseEnv.RUNNER_NAME || '').trim();
  let kind;
  let identity;
  if (scope === 'self-hosted-runner' || scope === 'ci') {
    kind = 'runner';
    identity = explicit || runner || 'default-runner';
  } else {
    kind = 'development';
    identity = explicit || gitWorktreePrincipal(cwd);
  }
  return `${kind}-${sha256(Buffer.from(identity)).slice(7, 19)}`;
}

export function conanStorageLayout(storageBase, partition) {
  const storageRoot = path.join(storageBase, partition);
  const artifactRoot = path.join(storageBase, 'artifacts');
  return {
    storageRoot,
    packageRoot: path.join(storageRoot, 'packages'),
    artifactRoot,
    downloadRoot: path.join(artifactRoot, 'downloads'),
  };
}

function conanGlobalConfig(storageRoot, artifactRoot) {
  const packages = safePath(path.join(storageRoot, 'packages'));
  const downloads = safePath(path.join(artifactRoot, 'downloads'));
  return [
    `core.cache:storage_path = ${packages}`,
    `core.download:download_cache = ${downloads}`,
    'core:non_interactive = True',
    '',
  ].join('\n');
}

function conanWrapperSource() {
  return `// Generated by Shifu for one child execution; contains no credentials.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const originalPath = process.env.SHIFU_CONAN_ORIGINAL_PATH || '';
const storageRoot = process.env.SHIFU_CONAN_STORAGE_ROOT || '';
const names = process.platform === 'win32'
  ? ['conan.exe', 'conan.cmd', 'conan.bat', 'conan']
  : ['conan'];
let realConan = '';
for (const directory of originalPath.split(path.delimiter).filter(Boolean)) {
  for (const name of names) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      realConan = candidate;
      break;
    } catch {}
  }
  if (realConan) break;
}
if (!realConan) {
  console.error('shifu cache: conan is not available on the original PATH');
  process.exit(127);
}
if (!storageRoot) {
  console.error('shifu cache: managed Conan storage root is missing');
  process.exit(1);
}

const lockPath = path.join(storageRoot, '.shifu-conan.lock');
const timeoutValue = Number(process.env.SHIFU_CONAN_LOCK_TIMEOUT_MS || 30000);
const timeoutMs = Number.isFinite(timeoutValue)
  ? Math.max(0, Math.min(300000, Math.floor(timeoutValue)))
  : 30000;
const token = crypto.randomUUID();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const startedAt = Date.now();
let reclaimedStale = false;

function readOwner() {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const value = JSON.parse(raw);
    return { raw, value };
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function reclaimDeadOwner(owner) {
  if (!owner || processIsAlive(owner.value?.pid) !== false) return false;
  try {
    if (fs.readFileSync(lockPath, 'utf8') !== owner.raw) return false;
    fs.unlinkSync(lockPath);
    reclaimedStale = true;
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

function acquire() {
  const deadline = startedAt + timeoutMs;
  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        descriptor,
        JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        }) + '\\n',
      );
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = readOwner();
      if (reclaimDeadOwner(owner)) continue;
      if (!owner) {
        throw new Error(
          'managed Conan storage has an unreadable lock; refusing unsafe reclamation',
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          'managed Conan storage is already in use; timed out waiting for the same partition',
        );
      }
      Atomics.wait(sleeper, 0, 0, Math.min(100, remaining));
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}

function release() {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    return;
  }
  if (current.token !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

try {
  acquire();
  if (reclaimedStale)
    console.error('shifu cache: reclaimed a managed Conan lock whose owner is no longer running');
  const result = spawnSync(realConan, process.argv.slice(2), {
    env: { ...process.env, PATH: originalPath },
    stdio: 'inherit',
    shell: /\\.(?:cmd|bat)$/i.test(realConan),
  });
  if (result.error) {
    console.error(\`shifu cache: cannot run conan: \${result.error.message}\`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(\`shifu cache: \${error.message}\`);
  process.exitCode = 1;
} finally {
  release();
}
`;
}

function cargoWrapperSource() {
  return `// Generated by Shifu for one child execution; contains no credentials.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const originalPath = process.env.SHIFU_CARGO_ORIGINAL_PATH || '';
const sourceName = process.env.SHIFU_CARGO_SOURCE_NAME || '';
const registry = process.env.SHIFU_CARGO_REGISTRY || '';
const names = process.platform === 'win32'
  ? ['cargo.exe', 'cargo.cmd', 'cargo.bat', 'cargo']
  : ['cargo'];
let realCargo = '';
for (const directory of originalPath.split(path.delimiter).filter(Boolean)) {
  for (const name of names) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      realCargo = candidate;
      break;
    } catch {}
  }
  if (realCargo) break;
}
if (!realCargo) {
  console.error('shifu cache: cargo is not available on the original PATH');
  process.exit(127);
}
const config = [
  '--config',
  \`source.crates-io.replace-with=\"\${sourceName}\"\`,
  '--config',
  \`source.\${sourceName}.registry=\"sparse+\${registry}\"\`,
];
const result = spawnSync(realCargo, [...config, ...process.argv.slice(2)], {
  env: { ...process.env, PATH: originalPath },
  stdio: 'inherit',
  shell: /\\.(?:cmd|bat)$/i.test(realCargo),
});
if (result.error) {
  console.error(\`shifu cache: cannot run cargo: \${result.error.message}\`);
  process.exit(1);
}
process.exit(result.status ?? 1);
`;
}

function originalToolPath(baseEnv, originalPathKey) {
  const candidate = baseEnv.PATH || '';
  const inherited = baseEnv[originalPathKey] || '';
  const unchangedFromCaller =
    candidate === (process.env.PATH || '') &&
    inherited === (process.env[originalPathKey] || '');
  return unchangedFromCaller && inherited ? inherited : candidate;
}

function prepareConfigOverlays(configBindings, baseEnv, scope, cwd) {
  if (configBindings.length === 0) return { env: {}, root: '', cleanup() {} };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-cache-overlay-'));
  fs.chmodSync(root, 0o700);
  const overlayEnv = {};
  let conanStorage = null;
  let wrapperDir = '';
  const ensureWrapperDir = () => {
    if (wrapperDir) return wrapperDir;
    wrapperDir = path.join(root, 'bin');
    fs.mkdirSync(wrapperDir, { mode: 0o700 });
    const originalPath = baseEnv.PATH || '';
    overlayEnv.PATH = `${wrapperDir}${path.delimiter}${originalPath}`;
    return wrapperDir;
  };
  try {
    for (const binding of configBindings) {
      if (binding.key === 'cargo.source.crates-io') {
        assert(
          binding.serviceKind === 'source-index',
          `${binding.key} requires a source-index service`,
        );
        assert(
          binding.name !== 'crates-io',
          'managed Cargo source name must not be crates-io',
        );
        const wrapperDir = ensureWrapperDir();
        const wrapperModule = path.join(wrapperDir, 'cargo-wrapper.mjs');
        fs.writeFileSync(wrapperModule, cargoWrapperSource(), { mode: 0o600 });
        fs.writeFileSync(
          path.join(wrapperDir, 'cargo'),
          "#!/usr/bin/env node\nimport './cargo-wrapper.mjs';\n",
          { mode: 0o700 },
        );
        fs.writeFileSync(
          path.join(wrapperDir, 'cargo.cmd'),
          '@node "%~dp0cargo-wrapper.mjs" %*\r\n',
          { mode: 0o600 },
        );
        const originalPath = originalToolPath(
          baseEnv,
          'SHIFU_CARGO_ORIGINAL_PATH',
        );
        overlayEnv.SHIFU_CARGO_ORIGINAL_PATH = originalPath;
        overlayEnv.SHIFU_CARGO_SOURCE_NAME = binding.name;
        overlayEnv.SHIFU_CARGO_REGISTRY = binding.value;
      }
    }
    const conanRemote = configBindings.find(
      (binding) => binding.key === 'conan.remote.conancenter',
    );
    const conanStorageBinding = configBindings.find(
      (binding) => binding.key === 'conan.cache.storage',
    );
    if (conanRemote || conanStorageBinding) {
      assert(
        conanRemote,
        'managed Conan storage requires a managed remote binding',
      );
      assert(
        conanRemote.serviceKind === 'package-registry',
        `${conanRemote.key} requires a package-registry service`,
      );
      const conanHome = path.join(root, 'conan-home');
      fs.mkdirSync(conanHome, { mode: 0o700 });
      fs.writeFileSync(
        path.join(conanHome, 'remotes.json'),
        conanRemotes(conanRemote),
        { mode: 0o600 },
      );
      if (conanStorageBinding) {
        assert(
          conanStorageBinding.serviceKind === 'artifact-cache',
          `${conanStorageBinding.key} requires an artifact-cache service`,
        );
        const storageBase = resolveShifuCachePath(
          conanStorageBinding.value,
          baseEnv,
        );
        const partition = conanStoragePartition(scope, baseEnv, cwd);
        const { storageRoot, artifactRoot, downloadRoot } = conanStorageLayout(
          storageBase,
          partition,
        );
        fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
        fs.mkdirSync(downloadRoot, {
          recursive: true,
          mode: 0o700,
        });
        const wrapperDir = ensureWrapperDir();
        const wrapperModule = path.join(wrapperDir, 'conan-wrapper.mjs');
        fs.writeFileSync(wrapperModule, conanWrapperSource(), { mode: 0o600 });
        fs.writeFileSync(
          path.join(wrapperDir, 'conan'),
          "#!/usr/bin/env node\nimport './conan-wrapper.mjs';\n",
          { mode: 0o700 },
        );
        fs.writeFileSync(
          path.join(wrapperDir, 'conan.cmd'),
          '@node "%~dp0conan-wrapper.mjs" %*\r\n',
          { mode: 0o600 },
        );
        overlayEnv.SHIFU_CONAN_ORIGINAL_PATH = originalToolPath(
          baseEnv,
          'SHIFU_CONAN_ORIGINAL_PATH',
        );
        overlayEnv.SHIFU_CONAN_STORAGE_ROOT = storageRoot;
        overlayEnv.SHIFU_CONAN_STORAGE_BASE = storageBase;
        overlayEnv.SHIFU_CONAN_SHARED_DOWNLOAD_ROOT = downloadRoot;
        fs.writeFileSync(
          path.join(conanHome, 'global.conf'),
          conanGlobalConfig(storageRoot, artifactRoot),
          { mode: 0o600 },
        );
        conanStorage = {
          serviceId: conanStorageBinding.serviceId,
          namespace: conanStorageBinding.name,
          pathDigest: sha256(Buffer.from(storageRoot)),
          partitionDigest: sha256(Buffer.from(partition)),
          evidence: {
            mode: 'persistent-host-local',
            namespace: conanStorageBinding.name,
            pathDigest: sha256(Buffer.from(storageRoot)),
            partitionDigest: sha256(Buffer.from(partition)),
            lock: 'on-demand',
            artifactLayer: {
              binaryAuthority: 'hosted-remote',
              identity: 'rrev-package-id-prev',
              downloadCache: 'shared-content-addressed',
              downloadPathDigest: sha256(Buffer.from(downloadRoot)),
              concurrency: 'conan-content-locks',
              worktreeIndependent: true,
            },
          },
        };
      }
      overlayEnv.CONAN_HOME = conanHome;
      overlayEnv.SHIFU_CACHE_MANAGED_CONAN = '1';
    }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    env: overlayEnv,
    root,
    conanStorage,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function markConanStorage(receipt, conanStorage) {
  if (!conanStorage) return;
  receipt.services[conanStorage.serviceId].application.conanStorage =
    conanStorage.evidence;
}

function markOverlayCleanup(receipt) {
  for (const service of Object.values(receipt.services)) {
    if (service.application.overlayCleanup === 'not-run')
      service.application.overlayCleanup = 'completed';
  }
}

function pythonCacheBinding(resolved) {
  for (const [serviceId, service] of Object.entries(
    resolved.profile.services,
  )) {
    const binding = service.bindings.find(
      (item) => item.kind === 'environment' && item.key === 'UV_DEFAULT_INDEX',
    );
    if (binding)
      return {
        serviceId,
        endpoint: resolved.bindings.UV_DEFAULT_INDEX,
        strict:
          resolved.profile.policy.mode === 'require' &&
          resolved.profile.policy.onUnavailable === 'fail' &&
          !resolved.profile.policy.allowPublicFallback,
      };
  }
  return null;
}

function markPythonVerification(receipt, pythonCache, evidence, durationMs) {
  const service = receipt.services[pythonCache.serviceId];
  service.verification =
    evidence.enforcement === 'not-applicable' ? 'not-applicable' : 'passed';
  service.durationMs = durationMs;
  service.reason =
    evidence.enforcement === 'not-applicable'
      ? 'no tracked uv project in execution repository'
      : 'effective uv lock rebound and semantic digest verified';
  service.application.overlayCleanup =
    evidence.enforcement === 'not-applicable' ? 'not-applicable' : 'not-run';
  service.application.toolEvidence = evidence;
}

function markPythonFailure(receipt, pythonCache, durationMs) {
  const service = receipt.services[pythonCache.serviceId];
  service.outcome = 'failed';
  service.verification = 'failed';
  service.durationMs = durationMs;
  service.reason =
    'required Python cache verification failed before child execution';
}

function markPythonFallback(receipt, pythonCache, durationMs) {
  const service = receipt.services[pythonCache.serviceId];
  service.outcome = 'fallback';
  service.fallbackUsed = true;
  service.verification = 'failed';
  service.durationMs = durationMs;
  service.reason =
    'effective lock unavailable; declared canonical public-lock fallback selected';
}

function receiptFor(resolved) {
  return {
    $schema:
      'https://libkungfu.dev/schemas/shifu/cache-resolution-v1.schema.json',
    schema: RECEIPT_SCHEMA,
    profile: {
      id: resolved.profile.profileId,
      revision: resolved.profile.revision,
      digest: resolved.digest,
    },
    execution: {
      id: `run:${crypto.randomUUID()}`,
      platform: resolved.platform,
      scope: resolved.scope,
      resolvedAt: new Date().toISOString(),
    },
    services: resolved.receiptServices,
    redaction: REDACTION,
  };
}

/**
 * @param {{reference?: string, expectedDigest?: string, scope?: string,
 *   cwd?: string, timeoutMs?: number}} [options]
 */
export async function resolveCacheProfile({
  reference,
  expectedDigest,
  scope,
  cwd = process.cwd(),
  timeoutMs,
} = {}) {
  assert(reference, 'cache profile reference is required');
  assert(expectedDigest, 'cache profile digest is required');
  const raw = await readProfileReference(reference, { cwd, timeoutMs });
  const resolved = validateProfileBytes(raw, {
    expectedDigest,
    scope: scope || inferScope(),
    platform: platformId(),
  });
  return { ...resolved, receipt: receiptFor(resolved) };
}

/** @param {Record<string, unknown>} receipt @param {string} receiptPath */
export function writeReceipt(receipt, receiptPath) {
  if (!receiptPath) return;
  const target = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
}

export function windowsShifuCommandLine(args = []) {
  const quote = (value) => {
    const text = String(value);
    if (/^[A-Za-z0-9_./:@=+\\-]+$/.test(text)) return text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return ['shifu.cmd', ...args.map(quote)].join(' ');
}

function spawnChild(command, args, options) {
  if (
    process.platform === 'win32' &&
    [
      'shifu',
      './shifu',
      '.\\shifu',
      'shifu.cmd',
      './shifu.cmd',
      '.\\shifu.cmd',
    ].includes(command)
  ) {
    // With /s /c, quoting the command name itself makes cmd.exe preserve the
    // quotes as part of the executable token on current Windows runners.
    // The welded shim name has no spaces; quote only its arguments.
    const line = windowsShifuCommandLine(args);
    return spawnSync('cmd.exe', ['/d', '/s', '/c', line], options);
  }
  return spawnSync(command, args, options);
}

/**
 * @param {{reference?: string, expectedDigest?: string, scope?: string,
 *   receiptPath?: string, command?: string, args?: string[], cwd?: string,
 *   env?: NodeJS.ProcessEnv}} [options]
 */
export async function applyCacheProfile({
  reference,
  expectedDigest,
  scope,
  receiptPath,
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  assert(command, 'cache apply requires a command after --');
  if (!reference && !expectedDigest) {
    const result = spawnChild(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
    });
    if (result.error)
      throw new CacheProfileError(
        `cannot run ${command}: ${result.error.message}`,
      );
    return result.status ?? 1;
  }
  assert(
    reference && expectedDigest,
    'cache profile reference and digest must be supplied together',
  );
  const resolved = await resolveCacheProfile({
    reference,
    expectedDigest,
    scope,
    cwd,
  });
  const pythonCache = pythonCacheBinding(resolved);
  let overlays = { env: {}, cleanup() {} };
  let uvOverlay = { env: {}, cleanup() {} };
  const verificationStarted = Date.now();
  let result;
  try {
    overlays = prepareConfigOverlays(
      resolved.configBindings,
      env,
      resolved.scope,
      cwd,
    );
    markConanStorage(resolved.receipt, overlays.conanStorage);
    const boundEnv = {
      ...env,
      ...resolved.bindings,
      ...overlays.env,
    };
    if (!pythonCache) {
      for (const key of UV_TRANSPORT_ENV_KEYS) delete boundEnv[key];
      boundEnv.UV_NO_CONFIG = '1';
    }
    if (pythonCache) {
      // PDM does not consume UV_DEFAULT_INDEX.  Keep every Python package
      // manager inside the same governed index projection when a lifecycle
      // reaches `kungfu dev engage pdm ...` beneath Shifu.
      boundEnv.PDM_PYPI_URL = pythonCache.endpoint;
      // PDM rejects plain-HTTP indexes unless pypi.verify_ssl is explicitly
      // disabled.  Scope that decision to the same governed PDM index instead
      // of relying on runner-global trusted-host configuration.
      boundEnv.PDM_PYPI_VERIFY_SSL =
        new URL(pythonCache.endpoint).protocol === 'https:' ? 'true' : 'false';
      try {
        uvOverlay = prepareUvCacheOverlay({
          cwd,
          env: boundEnv,
          endpoint: pythonCache.endpoint,
        });
        markPythonVerification(
          resolved.receipt,
          pythonCache,
          uvOverlay.evidence,
          Date.now() - verificationStarted,
        );
      } catch (error) {
        if (pythonCache.strict) {
          markPythonFailure(
            resolved.receipt,
            pythonCache,
            Date.now() - verificationStarted,
          );
          throw error;
        }
        markPythonFallback(
          resolved.receipt,
          pythonCache,
          Date.now() - verificationStarted,
        );
        console.warn(
          'shifu cache: Python effective lock unavailable; using declared public fallback',
        );
      }
    }
    const childEnv = {
      ...boundEnv,
      ...uvOverlay.env,
      SHIFU_CACHE_ACTIVE: '1',
      SHIFU_CACHE_BYPASS: '',
    };
    result = spawnChild(command, args, {
      cwd,
      env: childEnv,
      stdio: 'inherit',
      shell: false,
    });
  } finally {
    uvOverlay.cleanup();
    overlays.cleanup();
    markOverlayCleanup(resolved.receipt);
    writeReceipt(resolved.receipt, receiptPath);
  }
  if (result.error)
    throw new CacheProfileError(
      `cannot run ${command}: ${result.error.message}`,
    );
  return result.status ?? 1;
}
