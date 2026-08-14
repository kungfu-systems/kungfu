#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const XINFA_ROOT = path.join(ROOT, 'crates', 'xinfa');
const XINFA_MANIFEST = path.join(XINFA_ROOT, 'Cargo.toml');
const KFD_ROOT = path.dirname(
  fileURLToPath(import.meta.resolve('@kungfu-tech/kfd/package.json')),
);
const KFD_BIN = path.join(KFD_ROOT, 'bin', 'kfd.mjs');
const STABLE_BUILDCHAIN_PACKAGE = fileURLToPath(
  import.meta.resolve('@kungfu-tech/buildchain-stable/package.json'),
);
const NATIVE_KFD_ROOT = path.dirname(
  createRequire(STABLE_BUILDCHAIN_PACKAGE).resolve(
    '@kungfu-tech/kfd/package.json',
  ),
);
const NATIVE_KFD_BIN = path.join(NATIVE_KFD_ROOT, 'bin', 'kfd.mjs');
const KFD_ATLAS_FIXTURE = path.join(
  KFD_ROOT,
  'verifier',
  'fixtures',
  'xinfa',
  'repository-small-atlas',
);
const XINFA_ATLAS_GOLDEN = path.join(
  XINFA_ROOT,
  'fixtures',
  'golden',
  'repository-small-atlas-v1.json',
);

function run(command, args, cwd = ROOT, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verify(kind, objectPath, verifier = KFD_BIN) {
  const result = spawnSync(
    process.execPath,
    [verifier, 'verify', kind, objectPath, '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const report = JSON.parse(result.stdout);
  if (result.status !== 0 || report.valid !== true) {
    const observed =
      kind === 'atlas'
        ? JSON.parse(
            fs.readFileSync(path.join(objectPath, 'atlas.json'), 'utf8'),
          ).roots
        : undefined;
    throw new Error(
      `KFD rejected Kungfu-owned ${kind}: ${JSON.stringify({ status: result.status, issues: report.issues, observed })}`,
    );
  }
  return report.profile;
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-kfd-drift-'));
try {
  const cargoTarget = path.join(temporary, 'cargo-target');
  run('cargo', ['build', '--locked', '--manifest-path', XINFA_MANIFEST], ROOT, {
    ...process.env,
    CARGO_TARGET_DIR: cargoTarget,
  });
  const xinfaBinary = path.join(
    cargoTarget,
    'debug',
    process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
  );

  const fixture = path.join(XINFA_ROOT, 'fixtures', 'repository-small');
  const project = path.join(fixture, 'project.json');
  const packOutput = path.join(temporary, 'pack');
  run(xinfaBinary, [
    'compile',
    '--project',
    project,
    '--output',
    packOutput,
    '--json',
  ]);
  const atlasOutput = path.join(temporary, 'atlas');
  run(xinfaBinary, [
    'atlas',
    'compile',
    '--project',
    project,
    '--output',
    atlasOutput,
    '--json',
  ]);

  const atlasGolden = JSON.parse(fs.readFileSync(XINFA_ATLAS_GOLDEN, 'utf8'));
  const currentAtlas = JSON.parse(
    fs.readFileSync(path.join(atlasOutput, 'atlas.json'), 'utf8'),
  );
  const currentManifest = JSON.parse(
    fs.readFileSync(path.join(atlasOutput, 'manifest.json'), 'utf8'),
  );
  const currentReceipt = JSON.parse(
    fs.readFileSync(path.join(atlasOutput, 'receipt.json'), 'utf8'),
  );
  const bundledAtlas = JSON.parse(
    fs.readFileSync(path.join(KFD_ATLAS_FIXTURE, 'atlas.json'), 'utf8'),
  );
  assert.equal(currentAtlas.atlas_root, atlasGolden.atlas_root);
  assert.equal(currentAtlas.roots.context_pack, atlasGolden.context_pack_root);
  assert.equal(currentAtlas.roots.schema, atlasGolden.schema_root);
  assert.equal(currentManifest.manifest_root, atlasGolden.manifest_root);
  assert.equal(currentReceipt.receipt_root, atlasGolden.receipt_root);

  // Compiler release identity and schema evolution contribute to Pack and
  // Atlas content roots. The KFD-bundled fixture may therefore represent a
  // different Xinfa release and schema set, but it must retain the same
  // release-independent source and semantic closure. The KFD verification
  // below independently validates the bundled schema/root pair.
  assert.equal(bundledAtlas.compiler.product, 'xinfa');
  assert.equal(bundledAtlas.roots.cut, atlasGolden.cut_root);
  assert.equal(bundledAtlas.roots.semantic, atlasGolden.semantic_root);
  assert.equal(bundledAtlas.roots.provenance, atlasGolden.provenance_root);
  assert.equal(bundledAtlas.roots.verification, atlasGolden.verification_root);

  const episodeOutput = path.join(
    fixture,
    '.kungfu',
    'episodes',
    'sealed',
    'sha256',
    'aa',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  const profiles = {
    pack: verify('pack', packOutput, NATIVE_KFD_BIN),
    atlas: verify('atlas', atlasOutput, NATIVE_KFD_BIN),
    bundledAtlas: verify('atlas', KFD_ATLAS_FIXTURE),
    episode: verify('episode', episodeOutput, NATIVE_KFD_BIN),
  };
  console.log(
    `[kfd-verifier-drift] current Pack, Atlas, Episode, and bundled KFD Atlas accepted: ${JSON.stringify(profiles)}`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
