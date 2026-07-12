#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeValeProjection } from './vocabulary-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALE_VERSION = '3.14.2';
const IMAGE =
  'jdkato/vale:v3.14.2@sha256:8a05ad36f77df250cea8c98142c4232b8281c5222b4d9ae6d45d9cc5da0a7483';
const required = process.argv.includes('--required');
const minAlertLevel = required ? 'error' : 'warning';
const isWin = process.platform === 'win32';

/** @param {string} command */
function has(command) {
  return (
    spawnSync(isWin ? 'where' : 'which', [command], { stdio: 'ignore' })
      .status === 0
  );
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) {
    throw new Error(
      `${command} could not start: ${result.error.code || result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Vale found ${minAlertLevel}-level prose violations (exit ${result.status ?? result.signal})`,
    );
  }
}

/** @param {string} command @param {string[]} prefix @param {string} fixture */
function proveNegativeFixture(command, prefix, fixture) {
  const result = spawnSync(command, [...prefix, '--output=JSON', fixture], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: isWin,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (
    result.error ||
    result.status === 0 ||
    !output.includes('RetiredPhrase1')
  ) {
    throw new Error(
      `Vale negative fixture did not prove the retired-phrase rule: ${output.trim() || result.error?.message || 'unexpected success'}`,
    );
  }
  console.log('[docs:prose] negative fixture proved the required Vale rule');
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-vale-'));

try {
  const projection = writeValeProjection(temporary, { minAlertLevel });
  console.log(
    `[docs:prose] Vale ${VALE_VERSION} policy projection: ${projection.files.length} public files, minimum level ${minAlertLevel}`,
  );
  const negativeFixture = path.join(temporary, 'negative-fixture.md');
  fs.writeFileSync(
    negativeFixture,
    '# Negative fixture\n\nRecord an agent run, then open it.\n',
  );
  if (has('vale')) {
    const version = spawnSync('vale', ['--version'], { encoding: 'utf8' });
    const observed = `${version.stdout || ''}${version.stderr || ''}`;
    if (!observed.includes(VALE_VERSION)) {
      throw new Error(
        `Vale ${VALE_VERSION} is required; local binary reports ${observed.trim() || 'an unknown version'}`,
      );
    }
    const prefix = [`--config=${projection.config}`];
    proveNegativeFixture('vale', prefix, negativeFixture);
    run('vale', [...prefix, ...projection.files]);
  } else if (has('docker')) {
    const prefix = [
      'run',
      '--init',
      '--rm',
      '-v',
      `${ROOT}:/work:ro`,
      '-v',
      `${temporary}:/vale-config:ro`,
      '-w',
      '/work',
      IMAGE,
      '--config=/vale-config/.vale.ini',
    ];
    proveNegativeFixture('docker', prefix, '/vale-config/negative-fixture.md');
    run('docker', [
      ...prefix,
      ...projection.files.map((file) => `/work/${file}`),
    ]);
  } else {
    throw new Error(
      `Vale ${VALE_VERSION} is not installed and Docker is unavailable`,
    );
  }
  console.log(`[docs:prose] ${minAlertLevel}-level prose policy passed`);
} catch (error) {
  console.error(
    `[docs:prose] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
