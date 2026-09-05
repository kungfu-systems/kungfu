// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stageActionPackage } from '../../../product/scripts/dist.mjs';
import {
  ActionKernelError,
  canonicalJson,
  contractResponse,
  parseSingleJsonDocument,
  verifyPackage,
} from './action.mjs';

const ACTION_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(ACTION_DIR, '..', '..', '..');
const ENTRY = path.join(ACTION_DIR, 'action.mjs');

function runAction(args, env = {}) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function digest(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

test('source Action package manifest matches tracked bytes', () => {
  const manifest = verifyPackage(ACTION_DIR);
  assert.equal(manifest.schema, 'kungfu.action.package-manifest/v1');
  assert.ok(
    manifest.files.some((entry) => entry.path === 'action-loop.contract.json'),
  );
});

test('development Node and embedded libnode hosts retain one semantic root', () => {
  const request = JSON.stringify({
    schema: 'kungfu.action.request/v1',
    command: 'contract',
    parameters: { unicode: '可人', count: 2 },
  });
  const source = contractResponse(
    ['contract', '--json', '--request-json', request],
    {
      KUNGFU_ACTION_HOST: 'development-node',
      KUNGFU_ACTION_LAYOUT: 'source',
    },
  );
  const installed = contractResponse(
    ['contract', '--json', '--request-json', request],
    {
      KUNGFU_ACTION_HOST: 'embedded-libnode',
      KUNGFU_ACTION_LAYOUT: 'installed',
    },
  );
  assert.equal(source.semanticRoot, installed.semanticRoot);
  assert.deepEqual(source.payload, installed.payload);
  assert.equal(source.exitCode, installed.exitCode);
  assert.notDeepEqual(source.host, installed.host);
});

test('canonical JSON uses UTF-8 byte key ordering and safe integers', () => {
  assert.equal(canonicalJson({ '\u{10000}': 1, '\uE000': 2 }), '{"":2,"𐀀":1}');
  assert.throws(
    () => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 }),
    (error) =>
      error instanceof ActionKernelError && error.code === 'unsafe-number',
  );
});

test('source host executes the checked-out MJS through Shifu', () => {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', 'shifu.cmd action contract --json'],
          { cwd: ROOT, encoding: 'utf8' },
        )
      : spawnSync('./shifu', ['action', 'contract', '--json'], {
          cwd: ROOT,
          encoding: 'utf8',
        });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const response = parseSingleJsonDocument(result.stdout);
  assert.equal(response.host.runtime, 'development-node');
  assert.equal(response.host.layout, 'source');
});

test('unknown command, invalid JSON, and host fallback fail closed', () => {
  const unknown = runAction(['unknown', '--json']);
  assert.equal(unknown.status, 64);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /unknown-command/);

  const invalid = runAction([
    'contract',
    '--json',
    '--request-json',
    '{broken',
  ]);
  assert.equal(invalid.status, 65);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /invalid-request-json/);

  const fallback = runAction(['contract', '--json'], {
    KUNGFU_ACTION_HOST: 'system-node',
  });
  assert.equal(fallback.status, 67);
  assert.equal(fallback.stdout, '');
  assert.match(fallback.stderr, /host-fallback-forbidden/);
});

test('single-document parser rejects stdout contamination', () => {
  assert.throws(
    () => parseSingleJsonDocument(`debug\n{"ok":true}`),
    (error) =>
      error instanceof ActionKernelError &&
      error.code === 'stdout-contamination',
  );
});

test('package verification rejects missing and tampered installed bytes', () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-action-package-'),
  );
  const staged = path.join(parent, 'action');
  try {
    fs.cpSync(ACTION_DIR, staged, { recursive: true });
    fs.rmSync(path.join(staged, 'action.contract.json'));
    assert.throws(
      () => contractResponse(['contract', '--json'], process.env, staged),
      (error) =>
        error instanceof ActionKernelError && error.code === 'package-missing',
    );

    fs.rmSync(staged, { recursive: true, force: true });
    fs.cpSync(ACTION_DIR, staged, { recursive: true });
    fs.appendFileSync(path.join(staged, 'migration-map.json'), ' ');
    assert.throws(
      () => contractResponse(['contract', '--json'], process.env, staged),
      (error) =>
        error instanceof ActionKernelError && error.code === 'package-tampered',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('source package changes take effect without compile or install', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-action-fresh-'));
  const staged = path.join(parent, 'action');
  try {
    fs.cpSync(ACTION_DIR, staged, { recursive: true });
    const before = contractResponse(
      ['contract', '--json'],
      process.env,
      staged,
    );
    const contractPath = path.join(staged, 'action.contract.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    contract.version = '0.1.0-fixture';
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    const manifestPath = path.join(staged, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.find(
      (entry) => entry.path === 'action.contract.json',
    ).sha256 = digest(contractPath);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const after = contractResponse(['contract', '--json'], process.env, staged);
    assert.notEqual(after.semanticRoot, before.semanticRoot);
    assert.equal(after.payload.version, '0.1.0-fixture');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('product staging copies the exact Action package bytes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-action-stage-'));
  try {
    const staged = stageActionPackage(parent);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ACTION_DIR, 'manifest.json'), 'utf8'),
    );
    const expected = [
      'manifest.json',
      ...manifest.files.map(({ path }) => path),
    ];
    assert.deepEqual(fs.readdirSync(staged).sort(), expected.sort());
    for (const file of expected) {
      assert.deepEqual(
        fs.readFileSync(path.join(staged, file)),
        fs.readFileSync(path.join(ACTION_DIR, file)),
      );
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
