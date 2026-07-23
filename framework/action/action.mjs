#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTION_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESPONSE_SCHEMA = 'kungfu.action.response/v1';
const REQUEST_SCHEMA = 'kungfu.action.request/v1';
const ALLOWED_HOSTS = new Set(['development-node', 'embedded-libnode']);
const ALLOWED_LAYOUTS = new Set(['source', 'installed']);

export class ActionKernelError extends Error {
  constructor(code, message, exitCode = 64) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalValue(value, location = '$') {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ActionKernelError(
        'unsafe-number',
        `${location} must be a safe integer`,
        65,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalValue(item, `${location}[${index}]`),
    );
  }
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort(utf8Compare)) {
      result[key] = canonicalValue(value[key], `${location}.${key}`);
    }
    return result;
  }
  throw new ActionKernelError(
    'unsupported-json-value',
    `${location} contains an unsupported JSON value`,
    65,
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ActionKernelError(
      'package-missing',
      `${label} is missing: ${path.basename(file)}`,
      66,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ActionKernelError(
      'package-invalid-json',
      `${label} is not valid JSON: ${path.basename(file)}`,
      66,
    );
  }
}

export function verifyPackage(actionDir = ACTION_DIR) {
  const manifestPath = path.join(actionDir, 'manifest.json');
  const manifest = readJson(manifestPath, 'Action package manifest');
  if (manifest.schema !== 'kungfu.action.package-manifest/v1') {
    throw new ActionKernelError(
      'package-manifest-schema',
      'Action package manifest schema is unsupported',
      66,
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new ActionKernelError(
      'package-manifest-files',
      'Action package manifest has no files',
      66,
    );
  }
  const verified = manifest.files.map((entry) => {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(entry.sha256 || '') ||
      path.basename(entry.path) !== entry.path
    ) {
      throw new ActionKernelError(
        'package-manifest-entry',
        'Action package manifest contains an invalid file entry',
        66,
      );
    }
    const file = path.join(actionDir, entry.path);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      throw new ActionKernelError(
        'package-missing',
        `Action package file is missing: ${entry.path}`,
        66,
      );
    }
    const actual = sha256Bytes(bytes);
    if (actual !== entry.sha256) {
      throw new ActionKernelError(
        'package-tampered',
        `Action package digest mismatch: ${entry.path}`,
        66,
      );
    }
    return { path: entry.path, sha256: actual };
  });
  return {
    schema: manifest.schema,
    root: sha256Json(verified),
    files: verified,
  };
}

function parseArgs(argv) {
  const normalized = argv[0] === 'action' ? argv.slice(1) : [...argv];
  const command = normalized.shift() || '';
  let json = false;
  let requestJson = '';
  while (normalized.length > 0) {
    const token = normalized.shift();
    if (token === '--json') {
      json = true;
    } else if (token === '--request-json') {
      if (normalized.length === 0) {
        throw new ActionKernelError(
          'missing-request-json',
          '--request-json requires a JSON object',
          65,
        );
      }
      requestJson = normalized.shift();
    } else {
      throw new ActionKernelError('unknown-option', `unknown option: ${token}`);
    }
  }
  if (!json) {
    throw new ActionKernelError(
      'json-required',
      'the bootstrap Action surface requires --json',
    );
  }
  if (command !== 'contract') {
    throw new ActionKernelError(
      'unknown-command',
      `unsupported Action command: ${command || '<empty>'}`,
    );
  }
  let request = { schema: REQUEST_SCHEMA, command, parameters: {} };
  if (requestJson) {
    try {
      request = JSON.parse(requestJson);
    } catch {
      throw new ActionKernelError(
        'invalid-request-json',
        '--request-json is not valid JSON',
        65,
      );
    }
  }
  if (!request || Array.isArray(request) || typeof request !== 'object') {
    throw new ActionKernelError(
      'invalid-request',
      'Action request must be a JSON object',
      65,
    );
  }
  if ((request.command || command) !== 'contract') {
    throw new ActionKernelError(
      'request-command-mismatch',
      'Action request command must be contract',
      65,
    );
  }
  return {
    request: {
      schema: request.schema || REQUEST_SCHEMA,
      command: 'contract',
      parameters: request.parameters || {},
    },
  };
}

function hostProvenance(env = process.env) {
  const runtime = env.KUNGFU_ACTION_HOST || 'development-node';
  const layout = env.KUNGFU_ACTION_LAYOUT || 'source';
  if (!ALLOWED_HOSTS.has(runtime)) {
    throw new ActionKernelError(
      'host-fallback-forbidden',
      `unsupported Action host: ${runtime}`,
      67,
    );
  }
  if (!ALLOWED_LAYOUTS.has(layout)) {
    throw new ActionKernelError(
      'layout-fallback-forbidden',
      `unsupported Action layout: ${layout}`,
      67,
    );
  }
  return { runtime, layout };
}

export function contractResponse(
  argv,
  env = process.env,
  actionDir = ACTION_DIR,
) {
  const { request } = parseArgs(argv);
  const packageReceipt = verifyPackage(actionDir);
  const payload = readJson(
    path.join(actionDir, 'action.contract.json'),
    'Action kernel contract',
  );
  const semantic = { request, payload, exitCode: 0 };
  return {
    schema: RESPONSE_SCHEMA,
    ok: true,
    exitCode: 0,
    request,
    payload,
    semanticRoot: sha256Json(semantic),
    host: hostProvenance(env),
    package: packageReceipt,
  };
}

export function parseSingleJsonDocument(text) {
  const trimmed = text.trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ActionKernelError(
      'stdout-contamination',
      'Action stdout must contain exactly one JSON document',
      68,
    );
  }
  if (canonicalJson(parsed) !== trimmed) {
    throw new ActionKernelError(
      'stdout-noncanonical',
      'Action stdout JSON must be canonical',
      68,
    );
  }
  return parsed;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const response = contractResponse(argv, env);
    fs.writeSync(process.stdout.fd, `${canonicalJson(response)}\n`);
    return response.exitCode;
  } catch (error) {
    const known = error instanceof ActionKernelError;
    const failure = {
      schema: 'kungfu.action.error/v1',
      ok: false,
      code: known ? error.code : 'internal-error',
      message: error instanceof Error ? error.message : String(error),
    };
    fs.writeSync(process.stderr.fd, `${canonicalJson(failure)}\n`);
    return known ? error.exitCode : 70;
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main();
}
