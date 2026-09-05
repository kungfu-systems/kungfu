#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Pack @kungfu-tech/work with its Spec dependency and prove a clean consumer.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  platformCommand,
  platformCommandOptions,
} from './platform-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  ['@kungfu-tech/spec', 'framework/spec'],
  ['@kungfu-tech/work', 'framework/work'],
];

function fail(message) {
  throw new Error(message);
}

function run(executable, args, { cwd = ROOT, capture = false } = {}) {
  const result = spawnSync(platformCommand(executable), args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...platformCommandOptions(executable),
  });
  if (result.error || result.status !== 0) {
    if (capture && result.stdout) process.stdout.write(result.stdout);
    if (capture && result.stderr) process.stderr.write(result.stderr);
    fail(
      `${executable} ${args.join(' ')} failed (status=${result.status ?? 'spawn'})`,
    );
  }
  return (result.stdout || '').trim();
}

function archiveName(name, version) {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}

function tarEntries(archive) {
  return run('tar', ['-tzf', archive], { capture: true })
    .split('\n')
    .filter(Boolean);
}

export function qualifyWorkPackage() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-work-pack-'));
  const consumer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-work-consumer-'),
  );
  try {
    const archives = [];
    for (const [name, relative] of SOURCES) {
      const packageRoot = path.join(ROOT, relative);
      const pkg = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
      );
      if (
        pkg.name !== name ||
        pkg.version !== '4.0.0-alpha.5' ||
        pkg.publishConfig?.registry !== 'https://registry.npmjs.org/' ||
        pkg.publishConfig?.access !== 'public'
      )
        fail(`${name}: alpha publication metadata drifted`);
      run('pnpm', ['pack', '--pack-destination', staging], {
        cwd: packageRoot,
      });
      const archive = path.join(staging, archiveName(name, pkg.version));
      if (!fs.existsSync(archive)) fail(`${name}: archive was not produced`);
      archives.push(archive);
    }

    const workEntries = tarEntries(archives[1]);
    for (const required of [
      'package/package.json',
      'package/index.mjs',
      'package/action/index.mjs',
      'package/assignment-runtime/index.mjs',
      'package/evidence/index.mjs',
      'package/project-cut/index.mjs',
      'package/assignment-capture/qualified-assignment-core-consumer.d.mts',
    ])
      if (!workEntries.includes(required))
        fail(`@kungfu-tech/work: missing ${required}`);
    if (workEntries.some((entry) => entry.includes('/node_modules/')))
      fail('@kungfu-tech/work: archive contains node_modules');

    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
    );
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...archives],
      { cwd: consumer },
    );
    const result = JSON.parse(
      run(
        'node',
        [
          '--input-type=module',
          '-e',
          [
            "import {WORK_PACKAGE_BOUNDARY,action,assignmentRuntime,evidence,projectCut} from '@kungfu-tech/work';",
            "import * as actionPublic from '@kungfu-tech/work/action';",
            "import * as assignmentPublic from '@kungfu-tech/work/assignment-runtime';",
            "import * as evidencePublic from '@kungfu-tech/work/evidence';",
            "import * as cutPublic from '@kungfu-tech/work/project-cut';",
            "import assert from 'node:assert/strict';",
            "for (const entry of ['cut','cut/migration','episode-provider','project-cut/history','project-cut/receipt-evidence','project-cut/native-loop-qualification','work-design-advisor','work-design-preflight','work-design-policy-replay','work-history-selector']) assert.ok(Object.keys(await import('@kungfu-tech/work/' + entry)).length > 0);",
            "await assert.rejects(import('@kungfu-tech/work/project-cut/src/index.mjs'), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});",
            'process.stdout.write(JSON.stringify({boundary:WORK_PACKAGE_BOUNDARY,root:[typeof action.canonicalJson,typeof assignmentRuntime.validateContract,typeof evidence.createEvidenceEnvelope,typeof projectCut.buildProjectCut],subpaths:[typeof actionPublic.canonicalJson,typeof assignmentPublic.validateContract,typeof evidencePublic.createEvidenceEnvelope,typeof cutPublic.buildProjectCut]}));',
          ].join(''),
        ],
        { cwd: consumer, capture: true },
      ),
    );
    if (
      result.boundary?.semanticOwner !== 'work' ||
      result.boundary?.nativeWriterOwner !== '@kungfu-tech/core' ||
      [...result.root, ...result.subpaths].some((kind) => kind !== 'function')
    )
      fail('clean installed Work consumer qualification mismatch');

    fs.copyFileSync(
      path.join(
        ROOT,
        'tests/fixtures/work-package-consumer-types/consumer.mts.txt',
      ),
      path.join(consumer, 'consumer.mts'),
    );
    run(
      'node',
      [
        path.join(ROOT, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--module',
        'nodenext',
        '--noUncheckedSideEffectImports',
        'consumer.mts',
      ],
      { cwd: consumer },
    );

    return {
      schema: 'kungfu.work-package-qualification/v1',
      packageSet: SOURCES.map(([name]) => name),
      workArchiveEntries: workEntries.length,
      cleanConsumer: true,
      publicTypeConsumer: true,
      boundary: result.boundary,
      nonClaims: [
        'This qualification does not publish or reserve an npm coordinate.',
        'The Work package does not own native writer authority.',
      ],
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(consumer, { recursive: true, force: true });
  }
}

function main() {
  console.log(JSON.stringify(qualifyWorkPackage(), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[work-package-qualification] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
