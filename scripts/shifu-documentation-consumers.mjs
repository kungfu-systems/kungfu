#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = path.join(
  ROOT,
  'docs',
  'shifu',
  'examples',
  'documentation',
  'consumer-conformance.json',
);
const XINFA = path.join(
  ROOT,
  'xinfa',
  'target',
  'debug',
  process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
);

/** @param {string[]} args @param {string} cwd */
function run(args, cwd = ROOT) {
  const result = spawnSync(XINFA, args, { cwd, encoding: 'utf8' });
  let value = null;
  try {
    value = JSON.parse(result.stdout || '{}');
  } catch {
    value = { stdout: result.stdout, stderr: result.stderr };
  }
  return { status: result.status ?? 1, value };
}

/** @param {any} consumer */
function qualify(consumer) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xinfa-consumer-'));
  try {
    const roots = [];
    const timings = [];
    let firstAtlas = '';
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const output = path.join(temporary, `atlas-${iteration}`);
      const started = process.hrtime.bigint();
      const compile = run([
        'atlas',
        'compile',
        '--project',
        path.join(ROOT, consumer.project),
        '--output',
        output,
        '--root',
        path.join(ROOT, consumer.root),
        '--visibility',
        'public',
        '--json',
      ]);
      timings.push(Number(process.hrtime.bigint() - started) / 1_000_000);
      if (compile.status !== 0)
        throw new Error(
          `${consumer.id} compile failed: ${JSON.stringify(compile.value)}`,
        );
      const verify = run(['atlas', 'verify', '--atlas', output, '--json']);
      if (verify.status !== 0 || verify.value.valid !== true)
        throw new Error(`${consumer.id} verification failed`);
      roots.push({
        atlasRoot: compile.value.atlas_root,
        packRoot: compile.value.context_pack_root,
        manifestRoot: compile.value.manifest_root,
        receiptRoot: compile.value.receipt_root,
      });
      if (iteration === 0) firstAtlas = output;
    }
    if (JSON.stringify(roots[0]) !== JSON.stringify(roots[1]))
      throw new Error(`${consumer.id} clean rebuild roots drifted`);
    const project = JSON.parse(
      fs.readFileSync(path.join(ROOT, consumer.project), 'utf8'),
    );
    const modes = [
      ...new Set(
        project.nodes.map((/** @type {any} */ node) => node.verification.mode),
      ),
    ].sort();
    for (const required of consumer.requiredVerificationModes)
      if (!modes.includes(required))
        throw new Error(
          `${consumer.id} lacks ${required} verification coverage`,
        );
    const human = run([
      'read',
      '--atlas',
      firstAtlas,
      '--route',
      consumer.humanRoute,
      '--intent',
      'find authority constraints evidence and next action',
      '--surface',
      'human',
      '--max-hops',
      '2',
      '--json',
    ]);
    const agent = run([
      'context',
      '--atlas',
      firstAtlas,
      '--route',
      consumer.agentRoute,
      '--task',
      'review current documentation authority and evidence',
      '--role',
      'independent-reviewer',
      '--budget',
      '4096',
      '--json',
    ]);
    if (human.status !== 0 || agent.status !== 0)
      throw new Error(`${consumer.id} dual-first reader failed`);
    return {
      id: consumer.id,
      shape: consumer.shape,
      roots: roots[0],
      deterministic: true,
      verificationModes: modes,
      compileMilliseconds: timings,
      human: {
        route: consumer.humanRoute,
        maxHops: 2,
        atlasRoot: human.value.parity?.atlas_root || null,
        omissions: human.value.parity?.atlas_omissions || [],
      },
      agent: {
        route: consumer.agentRoute,
        budget: 4096,
        atlasRoot: agent.value.parity?.atlas_root || null,
        omissions: agent.value.parity?.atlas_omissions || [],
      },
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function runConsumerQualification() {
  const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
  const xinfaSource = fs
    .readdirSync(path.join(ROOT, 'xinfa', 'src'))
    .filter(
      (entry) =>
        entry.endsWith('.rs') &&
        !['episode.rs', 'episode_cli.rs'].includes(entry),
    )
    .map((entry) =>
      fs.readFileSync(path.join(ROOT, 'xinfa', 'src', entry), 'utf8'),
    )
    .join('\n');
  const assumptions = [...xinfaSource.matchAll(/kungfu/gi)].length;
  const consumers = contract.consumers.map(qualify);
  const parity = consumers.every(
    (consumer) =>
      consumer.human.atlasRoot === consumer.roots.atlasRoot &&
      consumer.agent.atlasRoot === consumer.roots.atlasRoot,
  );
  return {
    schema: 'shifu.documentation-consumer-qualification/v1',
    verdict: assumptions === 0 && parity ? 'pass' : 'fail',
    compilerAuthority: 'xinfa',
    compilerSourceChangesRequired: false,
    kungfuOnlyCompilerAssumptions: assumptions,
    excludedProjectAdapters: ['episode.rs', 'episode_cli.rs'],
    parity,
    consumers,
    negativeFixtures: contract.negativeFixtures,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const receipt = runConsumerQualification();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(receipt.verdict === 'pass' ? 0 : 1);
}
