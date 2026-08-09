#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XINFA = path.join(
  ROOT,
  'crates',
  'xinfa',
  'tooling',
  process.platform === 'win32' ? 'source-xinfa.cmd' : 'source-xinfa',
);
const QUALIFIER = path.join(
  ROOT,
  'crates',
  'xinfa',
  'tooling',
  'qualify-context-quality.mjs',
);
const CORPUS = path.join(
  ROOT,
  'crates',
  'xinfa',
  'fixtures',
  'golden',
  'context-quality-corpus-v1.json',
);
const RETAINED = path.join(
  ROOT,
  'crates',
  'xinfa',
  'qualification',
  'context-quality-v1.json',
);

/** @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** @param {unknown} value */
function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest('hex')}`;
}

/** @param {any} retained @param {any} current */
export function verifyRetainedReceipt(retained, current) {
  if (retained.schema !== 'xinfa.context-quality-qualification/v1')
    throw new Error('retained context-quality receipt schema is invalid');
  const { qualification_root: claimedRoot, ...content } = retained;
  if (claimedRoot !== digest(content))
    throw new Error('retained context-quality receipt root is invalid');
  if (retained.verdict !== 'pass')
    throw new Error('retained context-quality receipt is not passing');
  if (retained.actor !== current.actor)
    throw new Error('retained context-quality actor drifted');
  if (retained.corpus_root !== current.corpus_root)
    throw new Error(
      'retained context-quality corpus drifted; run with --write',
    );
  if (
    JSON.stringify(canonical(retained.thresholds)) !==
    JSON.stringify(canonical(current.thresholds))
  )
    throw new Error(
      'retained context-quality thresholds drifted; run with --write',
    );
}

/** @param {string} command @param {string[]} args */
function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.cmd$/i.test(command),
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${path.basename(command)} failed: ${result.error?.message || result.stderr || result.status}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${path.basename(command)} did not emit JSON`);
  }
}

function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  if (
    process.argv.slice(2).some((arg) => !['--write', '--check'].includes(arg))
  )
    throw new Error(
      'usage: qualify-xinfa-context-quality.mjs [--check|--write]',
    );
  if (!fs.existsSync(XINFA))
    throw new Error(
      `Xinfa source resolver is missing: ${path.relative(ROOT, XINFA)}`,
    );

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xinfa-context-quality-'),
  );
  try {
    const atlas = path.join(temporary, 'atlas');
    const graph = runJson(
      path.join(ROOT, process.platform === 'win32' ? 'shifu.cmd' : 'shifu'),
      ['docs', 'graph', '--output', atlas, '--xinfa', XINFA, '--json'],
    );
    if (
      graph.verdict !== 'pass' ||
      graph.xinfa?.verify?.valid !== true ||
      graph.closure?.unclassified !== 0
    )
      throw new Error(
        'repository Documentation Atlas is not closed and verified',
      );

    const generated = path.join(temporary, 'context-quality-v1.json');
    const receipt = runJson(process.execPath, [
      QUALIFIER,
      '--xinfa',
      XINFA,
      '--atlas',
      atlas,
      '--corpus',
      CORPUS,
      '--actor',
      'context-quality-v1',
      '--output',
      generated,
    ]);
    if (receipt.verdict !== 'pass')
      throw new Error('context-quality qualification failed');
    const expected = fs.readFileSync(generated);
    if (write) fs.writeFileSync(RETAINED, expected);
    if (check) {
      if (!fs.existsSync(RETAINED))
        throw new Error('retained context-quality receipt is missing');
      const retainedBytes = fs.readFileSync(RETAINED);
      const retained = JSON.parse(retainedBytes.toString('utf8'));
      verifyRetainedReceipt(retained, receipt);
      if (
        retained.atlas_root === receipt.atlas_root &&
        !retainedBytes.equals(expected)
      )
        throw new Error(
          'retained context-quality receipt drifted for the same Atlas root; run with --write',
        );
    }
    process.stdout.write(
      `[xinfa-quality] cases=${receipt.metrics.cases} routes=${receipt.metrics.route_families} atlas=${receipt.atlas_root} root=${receipt.qualification_root}\n`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `[xinfa-quality] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
