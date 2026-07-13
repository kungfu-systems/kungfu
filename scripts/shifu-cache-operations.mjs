// SPDX-License-Identifier: Apache-2.0
// Developer-facing cache configuration and diagnostics. This module owns only
// the local Shifu block; private inventory and central service maintenance stay
// outside Kungfu.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveCacheProfile, sha256 } from './shifu-cache-runtime.mjs';

const SHIFU_BEGIN = '# shifu-cache-profile begin';
const SHIFU_END = '# shifu-cache-profile end';
const CONTROLLER_BEGIN = '# atlas-shifu-cache-profile begin';
const CONTROLLER_END = '# atlas-shifu-cache-profile end';

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
      value = value.replaceAll("'\\''", "'");
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function block(reference, digest, scope) {
  return `${SHIFU_BEGIN}\nexport SHIFU_CACHE_PROFILE_REF=${quote(reference)}\nexport SHIFU_CACHE_PROFILE_DIGEST=${quote(digest)}\nexport SHIFU_CACHE_SCOPE=${quote(scope)}\n${SHIFU_END}\n`;
}

function delimited(text, begin, end) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (start >= 0 !== finish >= 0 || (start >= 0 && finish < start))
    throw new Error(`malformed managed block: ${begin}`);
  if (start < 0) return null;
  let after = finish + end.length;
  if (text[after] === '\n') after += 1;
  return { start, after };
}

function replaceBlock(text, replacement) {
  const found = delimited(text, SHIFU_BEGIN, SHIFU_END);
  if (found)
    return text.slice(0, found.start) + replacement + text.slice(found.after);
  const normalized = text && !text.endsWith('\n') ? `${text}\n` : text;
  return normalized + replacement;
}

function removeBlock(text) {
  const found = delimited(text, SHIFU_BEGIN, SHIFU_END);
  return found ? text.slice(0, found.start) + text.slice(found.after) : text;
}

function backupName(file, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${file}.shifu-before-${stamp}`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function applyPlan(file, before, after, execute) {
  const changed = before !== after;
  const backup = changed && before ? backupName(file) : '';
  if (execute && changed) {
    if (before) fs.copyFileSync(file, backup);
    writeAtomic(file, after);
  }
  return {
    changed,
    backup: backup
      ? {
          created: execute,
          pathDigest: sha256(Buffer.from(path.resolve(backup))),
        }
      : null,
    rollback: !changed
      ? { action: 'none' }
      : backup
        ? {
            action: 'restore-backup',
            backupPathDigest: sha256(Buffer.from(path.resolve(backup))),
          }
        : { action: 'remove-shifu-managed-block' },
  };
}

function referenceEvidence(reference) {
  if (/^https?:/i.test(reference)) {
    try {
      const url = new URL(reference);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return { type: 'http', value: url.toString() };
    } catch {
      return { type: 'invalid', value: '' };
    }
  }
  return {
    type: reference.startsWith('file:') ? 'file' : 'local-path',
    pathDigest: sha256(Buffer.from(reference)),
  };
}

function receiptState(receiptPath, digest) {
  if (!receiptPath || !fs.existsSync(receiptPath))
    return {
      state: 'absent',
      pathDigest: receiptPath
        ? sha256(Buffer.from(path.resolve(receiptPath)))
        : '',
    };
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const current =
      receipt.schema === 'shifu.cache-resolution/v1' &&
      receipt.profile?.digest === digest;
    return {
      state: current ? 'current' : 'stale',
      pathDigest: sha256(Buffer.from(path.resolve(receiptPath))),
      resolvedAt: receipt.execution?.resolvedAt || '',
      profile: receipt.profile || null,
      services: receipt.services || {},
    };
  } catch {
    return {
      state: 'invalid',
      pathDigest: sha256(Buffer.from(path.resolve(receiptPath))),
    };
  }
}

function sourceOf(raw, config) {
  if (raw.includes(CONTROLLER_BEGIN)) return 'controller-projection';
  if (raw.includes(SHIFU_BEGIN)) return 'shifu-managed';
  if (config.SHIFU_CACHE_PROFILE_REF || config.SHIFU_CACHE_PROFILE_DIGEST)
    return 'user-config';
  return 'none';
}

function pairState(reference, digest) {
  if (reference && digest) return 'complete';
  if (reference || digest) return 'partial';
  return 'absent';
}

function serviceFacts(services, reachable = {}) {
  return Object.fromEntries(
    Object.entries(services).map(([id, service]) => [
      id,
      {
        probeEvidence: reachable[id] || null,
        configured: true,
        resolved: true,
        reachable: reachable[id]?.state || 'not-probed',
        effective: service.application?.scope === 'child-process',
        hit: 'unproven',
        reason:
          'resolution proves binding selection; cache hit requires provider evidence',
      },
    ]),
  );
}

function configurationState(configFile, env) {
  const raw = readText(configFile);
  const config = parseEnv(raw);
  const reference =
    env.SHIFU_CACHE_PROFILE_REF || config.SHIFU_CACHE_PROFILE_REF || '';
  const digest =
    env.SHIFU_CACHE_PROFILE_DIGEST || config.SHIFU_CACHE_PROFILE_DIGEST || '';
  const scope =
    env.SHIFU_CACHE_SCOPE || config.SHIFU_CACHE_SCOPE || 'development';
  const fileSource = sourceOf(raw, config);
  const source =
    fileSource !== 'none'
      ? fileSource
      : env.SHIFU_CACHE_PROFILE_REF || env.SHIFU_CACHE_PROFILE_DIGEST
        ? 'environment'
        : 'none';
  return { reference, digest, scope, source };
}

export function cacheStatus({ configFile, receiptPath, env = process.env }) {
  const configuration = configurationState(configFile, env);
  const { reference, digest, scope } = configuration;
  const pair = pairState(reference, digest);
  const receipt = receiptState(receiptPath, digest);
  const services =
    receipt.state === 'current' ? serviceFacts(receipt.services) : {};
  return {
    schema: 'shifu.cache-diagnostic/v1',
    mode: 'status',
    overall:
      pair === 'absent'
        ? 'unconfigured'
        : pair === 'partial'
          ? 'failed'
          : receipt.state === 'current'
            ? 'resolved'
            : 'configured',
    probe: false,
    configuration: {
      source: configuration.source,
      pair,
      scope,
      reference: reference ? referenceEvidence(reference) : null,
      digest: digest || '',
    },
    profile: receipt.profile || null,
    receipt: {
      state: receipt.state,
      pathDigest: receipt.pathDigest || '',
      resolvedAt: receipt.resolvedAt || '',
    },
    services,
    redaction: 'credentials-userinfo-query-fragment-and-local-path-digest',
  };
}

async function probeHttp(url, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      state:
        response.status >= 200 && response.status < 500
          ? 'reachable'
          : 'failed',
      method: 'HEAD',
      durationMs: Date.now() - started,
      status: response.status,
    };
  } catch (error) {
    return {
      state: 'failed',
      durationMs: Date.now() - started,
      method: 'HEAD',
      reason: error?.name === 'TimeoutError' ? 'timeout' : 'request-failed',
    };
  }
}

function redactedError(error, configuration) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [configuration.reference, osHome()]) {
    if (value) message = message.split(value).join('<redacted>');
  }
  return message.replace(/https?:\/\/[^\s]+/gi, '<redacted-url>');
}

function osHome() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

export async function cacheDoctor({
  configFile,
  receiptPath,
  env = process.env,
  probe = false,
  timeoutMs = 3000,
}) {
  const status = cacheStatus({ configFile, receiptPath, env });
  if (status.configuration.pair !== 'complete')
    return { ...status, mode: 'doctor', probe };
  const configuration = configurationState(configFile, env);
  try {
    const resolved = await resolveCacheProfile({
      reference: configuration.reference,
      expectedDigest: configuration.digest,
      scope: configuration.scope,
      timeoutMs,
    });
    const reachable = {};
    if (probe) {
      const results = await Promise.all(
        Object.entries(resolved.receipt.services).map(async ([id, service]) => [
          id,
          service.selected?.type === 'http'
            ? await probeHttp(service.selected.url, timeoutMs)
            : {
                state: 'not-applicable',
                method: 'none',
                durationMs: 0,
              },
        ]),
      );
      Object.assign(reachable, Object.fromEntries(results));
    }
    return {
      ...status,
      mode: 'doctor',
      overall: Object.values(reachable).some(
        (evidence) => evidence.state === 'failed',
      )
        ? 'degraded'
        : 'healthy',
      probe,
      profile: resolved.receipt.profile,
      services: serviceFacts(resolved.receipt.services, reachable),
    };
  } catch (error) {
    return {
      ...status,
      mode: 'doctor',
      overall: 'failed',
      error: redactedError(error, configuration),
    };
  }
}

export async function cacheUse({
  configFile,
  reference,
  digest,
  scope = 'development',
  execute = false,
}) {
  const before = readText(configFile);
  if (delimited(before, CONTROLLER_BEGIN, CONTROLLER_END))
    throw new Error(
      'cache configuration is controller-managed; local use refuses to overwrite it',
    );
  const resolved = await resolveCacheProfile({
    reference,
    expectedDigest: digest,
    scope,
  });
  const after = replaceBlock(before, block(reference, digest, scope));
  return {
    schema: 'shifu.cache-config-plan/v1',
    action: 'use',
    execute,
    configPathDigest: sha256(Buffer.from(path.resolve(configFile))),
    profile: resolved.receipt.profile,
    ...applyPlan(configFile, before, after, execute),
  };
}

export function cacheUnset({ configFile, execute = false }) {
  const before = readText(configFile);
  const after = removeBlock(before);
  return {
    schema: 'shifu.cache-config-plan/v1',
    action: 'unset',
    execute,
    configPathDigest: sha256(Buffer.from(path.resolve(configFile))),
    ...applyPlan(configFile, before, after, execute),
  };
}

export function printDiagnostic(value, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  console.log(`cache ${value.mode}: ${value.overall}`);
  console.log(
    `  configuration: ${value.configuration.source} (${value.configuration.pair})`,
  );
  console.log(`  scope: ${value.configuration.scope}`);
  console.log(`  profile: ${value.profile?.id || 'not resolved'}`);
  console.log(`  receipt: ${value.receipt.state}`);
  for (const [id, service] of Object.entries(value.services))
    console.log(
      `  ${id}: resolved=${service.resolved} reachable=${service.reachable} effective=${service.effective} hit=${service.hit}`,
    );
  if (value.error) console.log(`  error: ${value.error}`);
}
