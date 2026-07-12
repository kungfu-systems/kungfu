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
  'SHIFU_CACHE_PROFILE_REF',
  'SHIFU_CACHE_PROFILE_DIGEST',
]);
const SECRET_KEY_RE =
  /(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|PRIVATE_KEY|AUTH)/;

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
  return parsed.toString();
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
    new Set(['kind', 'key', 'valueFrom']),
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
    for (const binding of service.bindings) {
      validateBinding(binding, serviceId);
      if (binding.kind !== 'environment') {
        throw new CacheProfileError(
          `runtime apply does not support ${binding.kind} binding ${serviceId}/${binding.key}`,
        );
      }
      validateEnvironmentKey(binding.key);
      assert(
        !Object.hasOwn(bindings, binding.key),
        `duplicate environment binding: ${binding.key}`,
      );
      bindings[binding.key] = endpointValue(endpoint, binding);
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
    };
  }
  return {
    profile,
    digest,
    platform: platform || platformId(),
    scope: scope || inferScope(),
    bindings,
    receiptServices,
  };
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
    const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
    const line = [quote('shifu.cmd'), ...args.map(quote)].join(' ');
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
  writeReceipt(resolved.receipt, receiptPath);
  const childEnv = { ...env, ...resolved.bindings, SHIFU_CACHE_ACTIVE: '1' };
  const result = spawnChild(command, args, {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error)
    throw new CacheProfileError(
      `cannot run ${command}: ${result.error.message}`,
    );
  return result.status ?? 1;
}
