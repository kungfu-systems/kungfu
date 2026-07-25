#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function run(label, command, args, env = process.env) {
  process.stdout.write(`[native-admission] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('Core ABI, contract, and admission fixtures', 'ctest', [
  '--test-dir',
  path.join(root, 'framework/core/build'),
  '--build-config',
  'Release',
  '--output-on-failure',
  '--tests-regex',
  '^(kungfu_api_contract_tests|kungfu_native_kfx_contract_tests)$',
]);

const pythonPath = [
  path.join(root, 'framework/core/build/Release'),
  path.join(root, 'framework/core/src/python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

run(
  'Python binding, CLI, and Work golden replay',
  'uv',
  [
    'run',
    '--project',
    path.join(root, 'framework/core'),
    '--frozen',
    'pytest',
    path.join(root, 'framework/core/tests/python/test_native_kfx_contract.py'),
    path.join(root, 'framework/core/tests/python/test_action_envelope.py'),
  ],
  {
    ...process.env,
    KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
    PYTHONPATH: pythonPath,
  },
);

run('public API transport projection', 'pnpm', [
  '--filter',
  '@kungfu-tech/tui',
  'exec',
  'tsx',
  '--test',
  path.join(root, 'framework/api/tests/storage.test.ts'),
]);

run('public API type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/api',
  'run',
  'build',
]);

run('KFX type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/kfx',
  'run',
  'build',
]);

run('schema authority gate', 'node', [
  path.join(root, 'scripts/check-schema-authority.mjs'),
]);

run('incubation passport gate', 'node', [
  path.join(root, 'scripts/check-incubation-passport.mjs'),
]);

run('incubation passport contract tests', 'node', [
  '--test',
  path.join(root, 'scripts/check-incubation-passport.test.mjs'),
]);

run('layered API encoding authority', 'node', [
  '--test',
  path.join(root, 'scripts/check-layered-api-encoding-boundary.test.mjs'),
]);

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function gitBytes(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout;
}

function admissionReceipt() {
  const fixturePath = path.join(
    root,
    'tests/fixtures/native-admission/work-journal-v1.json',
  );
  const fixtureBytes = fs.readFileSync(fixturePath);
  const fixture = JSON.parse(fixtureBytes);
  const sourcePath = path.join(
    root,
    'framework/core/src/libkungfu/schemas/work_events.fbs',
  );
  const bfbsPath = path.join(
    root,
    'framework/core/src/libkungfu/schemas/work_events.bfbs',
  );
  const sourceRoot = sha256(fs.readFileSync(sourcePath));
  const bfbsRoot = sha256(fs.readFileSync(bfbsPath));
  const baseRef =
    process.env.KUNGFU_NATIVE_ADMISSION_BASE_REF ?? 'origin/dev/v4/v4.0';
  const baseRevision = gitBytes(['merge-base', 'HEAD', baseRef])
    .toString()
    .trim();
  const beforeSourceRoot = sha256(
    gitBytes([
      'show',
      `${baseRevision}:framework/core/src/python/kungfu/work/work_events.fbs`,
    ]),
  );
  const beforeBfbsRoot = sha256(
    gitBytes([
      'show',
      `${baseRevision}:framework/core/src/python/kungfu/work/work_events.bfbs`,
    ]),
  );
  if (
    fixture.schema !== 'kungfu.native-admission.vectors/v1' ||
    fixture.protocolId !== 'kungfu.work.record-root/v1' ||
    fixture.schemaSourceRoot !== sourceRoot ||
    fixture.schemaBfbsRoot !== bfbsRoot ||
    beforeSourceRoot !== sourceRoot ||
    beforeBfbsRoot !== bfbsRoot ||
    !Array.isArray(fixture.vectors) ||
    fixture.vectors.length !== 8
  ) {
    throw new Error('Work native admission fixture or schema roots drifted');
  }
  for (const vector of fixture.vectors) {
    const preimage = Buffer.from(vector.expected.recordRootPreimageHex, 'hex');
    if (sha256(preimage) !== vector.expected.recordRoot) {
      throw new Error(`Work native admission Root drifted: ${vector.id}`);
    }
  }
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(root, 'framework/incubation/incubation-passport.registry.json'),
    ),
  );
  const passport = registry.passports.find(
    (entry) => entry.id === 'kungfu.work-journal',
  );
  const languages = new Set(
    passport?.identityProtocol?.implementations?.map(
      (implementation) => implementation.language,
    ) ?? [],
  );
  if (
    passport?.incubation?.state !== 'admitted' ||
    !languages.has('cpp') ||
    !languages.has('python') ||
    !passport.identityProtocol.vectors.includes(
      'tests/fixtures/native-admission/work-journal-v1.json',
    )
  ) {
    throw new Error('Work journal passport is not natively admitted');
  }

  const implementationPaths = [
    'docs/architecture/work-events-schema-ownership-migration.md',
    'docs/adr/KF-ADR-019f8c53-6105-71e5-8f34-53f2a81ee61c.md',
    'docs/adr/KF-ADR-019f8759-ab29-7627-bc04-6aba547ea45f.md',
    'docs/document-metadata.registry.json',
    'framework/core/architecture/LAYERS.md',
    'framework/core/architecture/PUBLIC_CONTRACTS.cmake',
    'framework/core/architecture/TARGETS.cmake',
    'framework/core/architecture/kfd7-abi-conformance-v1.json',
    'framework/core/architecture/layers.json',
    'framework/core/architecture/layered-api-encoding-boundary.contract.json',
    'framework/core/schema-authority.json',
    'framework/core/src/libkungfu/CMakeLists.txt',
    'framework/core/src/libkungfu/include/kungfu/runtime/action/work_journal.h',
    'framework/core/src/libkungfu/schemas/work_event_schema.h.in',
    'framework/core/src/libkungfu/schemas/work_events.bfbs',
    'framework/core/src/libkungfu/schemas/work_events.fbs',
    'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
    'framework/core/src/libkungfu/src/runtime/action/work_journal.cpp',
    'framework/core/src/libkungfu/tests/api_contract_tests.cpp',
    'framework/core/src/python/kungfu/work/__init__.py',
    'framework/core/src/python/kungfu/work/events.py',
    'framework/core/src/python/kungfu/work/record_root.py',
    'framework/core/src/python/kungfu/work/store.py',
    'framework/core/tests/python/test_action_envelope.py',
    'framework/incubation/incubation-passport.baseline.json',
    'framework/incubation/incubation-passport.contract.json',
    'framework/incubation/incubation-passport.registry.json',
    'framework/incubation/schema/incubation-passport-contract-v1.schema.json',
    'package.json',
    'scripts/check-incubation-passport.mjs',
    'scripts/check-incubation-passport.test.mjs',
    'scripts/generate_work_native_admission_vectors.py',
    'scripts/run-native-kfx-admission-tests.mjs',
    'tests/fixtures/native-admission/work-journal-v1.json',
  ];
  const sourceTree = implementationPaths.map((relativePath) => ({
    path: relativePath,
    root: sha256(fs.readFileSync(path.join(root, relativePath))),
  }));
  const envelopeSet = fixture.vectors.map((vector) => ({
    id: vector.id,
    envelopeHex: vector.expected.envelopeHex,
    recordRoot: vector.expected.recordRoot,
  }));
  const receipt = {
    schema: 'kungfu.incubation-passport.admission-receipt/v1',
    candidateId: fixture.subjectId,
    assignmentId: passport.destinedAuthority.admissionAssignment,
    verdict: 'pass',
    fixtureRoot: sha256(fixtureBytes),
    sourceTreeRoot: sha256(canonical(sourceTree)),
    schemaBytes: {
      baselineRevision: baseRevision,
      beforeSourceRoot,
      afterSourceRoot: sourceRoot,
      beforeBfbsRoot,
      afterBfbsRoot: bfbsRoot,
      byteIdentical:
        beforeSourceRoot === sourceRoot && beforeBfbsRoot === bfbsRoot,
    },
    implementations: [...languages].sort(),
    platformEvidence: {
      platform: process.platform,
      arch: process.arch,
      abi: 'kungfu_get_api/KF_INTERFACE_RUNTIME_ACTION/v1',
      runner: 'scripts/run-native-kfx-admission-tests.mjs',
    },
    noRewrite: {
      policy: 'exact-envelope-replay-no-journal-mutation',
      historicalVectorCount: fixture.vectors.length,
      historicalFramesChanged: 0,
      envelopeSetRoot: sha256(canonical(envelopeSet)),
    },
  };
  receipt.receiptRoot = sha256(canonical(receipt));
  return receipt;
}

const receipt = admissionReceipt();
const receiptText = `${JSON.stringify(receipt)}\n`;
process.stdout.write(`[native-admission] receipt ${receiptText}`);
if (process.env.KUNGFU_NATIVE_ADMISSION_RECEIPT_OUT) {
  fs.writeFileSync(
    process.env.KUNGFU_NATIVE_ADMISSION_RECEIPT_OUT,
    receiptText,
  );
}
