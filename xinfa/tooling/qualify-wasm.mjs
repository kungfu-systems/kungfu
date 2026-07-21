#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bytesHash, reproducibleRustEnvironment } from './engine-manifest.mjs';
import { engineStatus, run as runWasm } from './wasm-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLCHAIN = '1.95.0';
const TARGET = 'wasm32-unknown-unknown';

function command(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr}`,
    );
  return result;
}

function rustupWhich(tool) {
  return command('rustup', [
    'which',
    tool,
    '--toolchain',
    TOOLCHAIN,
  ]).stdout.trim();
}

function native(args) {
  return command('cargo', [
    'run',
    '--locked',
    '--quiet',
    '--manifest-path',
    path.join(ROOT, 'Cargo.toml'),
    '--',
    ...args,
  ]).stdout;
}

function nativeOutcome(args) {
  const result = cp.spawnSync(
    'cargo',
    [
      'run',
      '--locked',
      '--quiet',
      '--manifest-path',
      path.join(ROOT, 'Cargo.toml'),
      '--',
      ...args,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function commandParity(args) {
  const expected = nativeOutcome(args);
  const observed = await runWasm(args);
  assert.equal(observed.status, expected.status, args.join(' '));
  assert.equal(observed.stdout, expected.stdout, args.join(' '));
  assert.equal(observed.stderr, expected.stderr, args.join(' '));
}

function files(directory) {
  const output = new Map();
  function visit(current, relativeRoot) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) =>
        Buffer.from(left.name).compare(Buffer.from(right.name)),
      )) {
      const relative = relativeRoot
        ? `${relativeRoot}/${entry.name}`
        : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) output.set(relative, fs.readFileSync(absolute));
      else
        throw new Error(
          `qualification output has unsupported entry: ${absolute}`,
        );
    }
  }
  visit(directory, '');
  return output;
}

function equalDirectories(nativeDirectory, wasmDirectory) {
  const left = files(nativeDirectory);
  const right = files(wasmDirectory);
  assert.deepEqual([...right.keys()], [...left.keys()]);
  for (const [relative, bytes] of left)
    assert.deepEqual(right.get(relative), bytes, `${relative} differs`);
}

async function fixture(root, temporary) {
  const project = path.join(ROOT, 'fixtures', root, 'project.json');
  for (const product of ['pack', 'atlas']) {
    const nativeOutput = path.join(temporary, `${root}-${product}-native`);
    const wasmOutput = path.join(temporary, `${root}-${product}-wasm`);
    const args =
      product === 'pack'
        ? [
            'compile',
            '--project',
            project,
            '--root',
            path.dirname(project),
            '--output',
            nativeOutput,
            '--json',
          ]
        : [
            'atlas',
            'compile',
            '--project',
            project,
            '--root',
            path.dirname(project),
            '--output',
            nativeOutput,
            '--json',
          ];
    const nativeReceipt = native(args);
    const wasmArgs = args.map((argument) =>
      argument === nativeOutput ? wasmOutput : argument,
    );
    const wasm = await runWasm(wasmArgs);
    assert.equal(wasm.status, 0, wasm.stderr);
    assert.equal(wasm.stdout, nativeReceipt);
    equalDirectories(nativeOutput, wasmOutput);
  }
}

async function episodeFixture(temporary) {
  const fixture = path.join(ROOT, 'fixtures', 'repository-small');
  const project = path.join(fixture, 'project.json');
  const nativeBefore = path.join(temporary, 'episode-before-native');
  const wasmBefore = path.join(temporary, 'episode-before-wasm');
  native([
    'atlas',
    'compile',
    '--project',
    project,
    '--root',
    fixture,
    '--output',
    nativeBefore,
    '--json',
  ]);
  const before = await runWasm([
    'atlas',
    'compile',
    '--project',
    project,
    '--root',
    fixture,
    '--output',
    wasmBefore,
    '--json',
  ]);
  assert.equal(before.status, 0, before.stderr);
  const nativeAfter = path.join(temporary, 'episode-after-native');
  const wasmAfter = path.join(temporary, 'episode-after-wasm');
  const nativeReceipt = native([
    'episode',
    'compile',
    '--before',
    nativeBefore,
    '--project',
    project,
    '--submission',
    'evidence/episode-submission.json',
    '--output',
    nativeAfter,
    '--root',
    fixture,
    '--json',
  ]);
  const wasm = await runWasm([
    'episode',
    'compile',
    '--before',
    wasmBefore,
    '--project',
    project,
    '--submission',
    'evidence/episode-submission.json',
    '--output',
    wasmAfter,
    '--root',
    fixture,
    '--json',
  ]);
  assert.equal(wasm.status, 0, wasm.stderr);
  assert.equal(wasm.stdout, nativeReceipt);
  equalDirectories(nativeAfter, wasmAfter);
}

async function main() {
  const status = engineStatus();
  assert.equal(status.usable, true, status.reason);
  const manifest = status.manifest;
  const retainedQualification = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'qualification', 'wasm-engine-v1.json'),
      'utf8',
    ),
  );
  const currentPlatform = `${process.platform}-${os.arch()}`;
  const rebuildPlatform = retainedQualification.platform;
  assert.equal(
    typeof rebuildPlatform,
    'string',
    'retained wasm qualification must declare its rebuild platform',
  );
  const checked = fs.readFileSync(path.join(ROOT, 'engine', 'xinfa.wasm'));
  const printableEngine = checked.toString('latin1');
  assert.doesNotMatch(
    printableEngine,
    /\/(?:Users|home)\/[^/\0]+/u,
    'checked-in wasm exposes a host home path',
  );
  assert.doesNotMatch(
    printableEngine,
    /(?:10|127|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}/u,
    'checked-in wasm exposes a private host address',
  );
  assert.doesNotMatch(
    printableEngine,
    /[A-Za-z]:\\Users\\/u,
    'checked-in wasm exposes a Windows user path',
  );
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(checked))
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(exports, [
    '__data_end',
    '__heap_base',
    'memory',
    'xinfa_alloc',
    'xinfa_call',
    'xinfa_free',
  ]);

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'xinfa-wasm-qualification-'),
  );
  try {
    if (currentPlatform === rebuildPlatform) {
      const cargo = rustupWhich('cargo');
      const rustc = rustupWhich('rustc');
      command(
        cargo,
        [
          'build',
          '--locked',
          '--release',
          '--lib',
          '--target',
          TARGET,
          '--manifest-path',
          path.join(ROOT, 'Cargo.toml'),
        ],
        {
          env: {
            ...reproducibleRustEnvironment(ROOT, cargo),
            CARGO_TARGET_DIR: path.join(temporary, 'rebuild-target'),
            RUSTC: rustc,
          },
        },
      );
      const rebuilt = fs.readFileSync(
        path.join(temporary, 'rebuild-target', TARGET, 'release', 'xinfa.wasm'),
      );
      assert.equal(bytesHash(rebuilt), manifest.wasm_sha256);
      assert.deepEqual(
        rebuilt,
        checked,
        'pinned rebuild differs from checked-in wasm',
      );
    } else {
      console.log(
        `[xinfa] exact wasm rebuild is retained on ${rebuildPlatform}; ` +
          `${currentPlatform} verifies the pinned engine and semantic parity`,
      );
    }

    for (const root of ['repository-small', 'repository-medium'])
      await fixture(root, temporary);
    await episodeFixture(temporary);

    for (const name of [
      'project-alpha.json',
      'project-beta.json',
      ...fs
        .readdirSync(path.join(ROOT, 'fixtures', 'negative'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => `negative/${name}`),
    ]) {
      const project = path.join(ROOT, 'fixtures', name);
      for (const operation of ['validate', 'canonicalize', 'compile'])
        await commandParity([operation, '--project', project, '--json']);
    }
    for (const schema of [
      'project',
      'semantic-project',
      'context-ir',
      'context-pack',
      'pack-manifest',
      'pack-receipt',
      'atlas',
      'atlas-view',
      'atlas-manifest',
      'atlas-receipt',
      'human-view',
      'task-envelope',
      'route-resolution',
      'task-chart',
      'gui-view',
      'projection-recipe',
      'episode-provider-submission',
      'review-chart',
    ])
      await commandParity(['schema', schema]);

    const stdinBytes = fs.readFileSync(
      path.join(ROOT, 'fixtures', 'project-alpha.json'),
    );
    const stdinNative = cp.spawnSync(
      'cargo',
      [
        'run',
        '--locked',
        '--quiet',
        '--manifest-path',
        path.join(ROOT, 'Cargo.toml'),
        '--',
        'validate',
        '--project',
        '-',
        '--json',
      ],
      { cwd: ROOT, input: stdinBytes, encoding: 'utf8' },
    );
    const stdinWasm = cp.spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'tooling', 'wasm-host.mjs'),
        'validate',
        '--project',
        '-',
        '--json',
      ],
      { cwd: ROOT, input: stdinBytes, encoding: 'utf8' },
    );
    assert.equal(stdinWasm.status, stdinNative.status);
    assert.equal(stdinWasm.stdout, stdinNative.stdout);
    assert.equal(stdinWasm.stderr, stdinNative.stderr);

    const staleRoot = path.join(temporary, 'stale-engine');
    fs.cpSync(path.join(ROOT, 'src'), path.join(staleRoot, 'src'), {
      recursive: true,
    });
    fs.cpSync(path.join(ROOT, 'engine'), path.join(staleRoot, 'engine'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(staleRoot, 'src', 'stale-probe.rs'),
      '// drift\n',
    );
    const stale = engineStatus(staleRoot);
    assert.equal(stale.usable, false);
    assert.match(stale.reason || '', /stale/u);

    const nodeOnly = path.join(temporary, 'node-only-path');
    fs.mkdirSync(nodeOnly);
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    const shifu = command(
      '/bin/sh',
      [path.join(ROOT, '..', 'shifu'), 'xinfa', '--version'],
      {
        cwd: path.join(ROOT, '..'),
        env: { ...process.env, PATH: `${nodeOnly}:/usr/bin:/bin` },
      },
    );
    assert.equal(shifu.stdout, 'xinfa 0.1.0\n');
    assert.equal(shifu.stderr, '');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(
    '[xinfa] wasm engine and native equivalence qualification passed',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
