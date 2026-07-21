// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  observeSettlementCommit,
  prepareSettlement,
  reconcileCommit,
  verifySettlement,
} from '../framework/project-cut/src/settlement.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(
  ROOT,
  'crates',
  'xinfa',
  'fixtures',
  'repository-small',
);
const PUBLIC_EPISODE_FIXTURE = path.join(
  ROOT,
  'framework',
  'project-cut',
  'fixtures',
  'public-runtime-episode',
);
const CLI = path.join(
  ROOT,
  'framework',
  'project-cut',
  'bin',
  'project-cut.mjs',
);
const BINARY = path.join(
  ROOT,
  'crates',
  'target',
  'debug',
  process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
);

function run(root, command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

test('settlement compiles and promotes a real Xinfa successor Atlas', (t) => {
  assert.equal(
    fs.existsSync(BINARY),
    true,
    'Xinfa binary must be built by the Shifu task',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-cut-xinfa-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, root, { recursive: true });
  run(root, 'git', ['init', '-q']);
  run(root, 'git', ['config', 'user.name', 'Settlement Integration']);
  run(root, 'git', ['config', 'user.email', 'settlement@example.invalid']);
  run(root, 'git', ['add', '--all']);
  run(root, 'git', ['commit', '-qm', 'test: Xinfa source fixture']);

  const before = path.join(root, '.xinfa', 'generated', 'before');
  fs.mkdirSync(path.dirname(before), { recursive: true });
  const baseline = JSON.parse(
    run(root, BINARY, [
      'atlas',
      'compile',
      '--project',
      'project.json',
      '--output',
      before,
      '--root',
      '.',
      '--visibility',
      'public',
      '--json',
    ]),
  );
  assert.equal(baseline.verdict, 'pass');
  fs.appendFileSync(
    path.join(root, 'src', 'runtime.rs'),
    '// unstaged workspace drift must not enter the successor Atlas\n',
  );

  const request = {
    schema: 'project.cut.settlement-request/v1',
    project: {
      id: 'small',
      identityRoot: `sha256:${'5'.repeat(64)}`,
    },
    parentCutRoots: [],
    visibility: 'public',
    authorityMode: 'bridge',
    source: { visibility: [] },
    atlas: {
      mode: 'episode-successor',
      before: '.xinfa/generated/before',
      project: 'project.json',
      submission: 'evidence/episode-submission.json',
      root: '.',
    },
    episodes: [{ semanticRoot: `sha256:${'a'.repeat(64)}` }],
    omissions: [],
    conflicts: [],
    unknowns: [],
  };
  const result = prepareSettlement(root, request, {
    xinfaBin: BINARY,
    execute: true,
    stage: true,
  });
  assert.notEqual(result.promotion.atlasRoot, baseline.atlas_root);
  assert.deepEqual(result.plan.unstagedPaths, ['src/runtime.rs']);
  assert.equal(verifySettlement(root, result.statePath).ok, true);
  assert.deepEqual(
    run(root, 'git', ['diff', '--cached', '--name-only']).split('\n'),
    [...result.plan.outputs].sort(),
  );
});

test('public runtime Episode seals and settles from a fresh checkout', (t) => {
  assert.equal(
    fs.existsSync(BINARY),
    true,
    'Xinfa binary must be built by the Shifu task',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-cut-public-'));
  const fresh = `${root}-fresh`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, root, { recursive: true });
  run(root, 'git', ['init', '-q']);
  run(root, 'git', ['config', 'user.name', 'Settlement Integration']);
  run(root, 'git', ['config', 'user.email', 'settlement@example.invalid']);
  run(root, 'git', ['add', '--all']);
  run(root, 'git', ['commit', '-qm', 'test: Xinfa source fixture']);

  const before = path.join(root, '.xinfa', 'generated', 'before');
  fs.mkdirSync(path.dirname(before), { recursive: true });
  const baseline = JSON.parse(
    run(root, BINARY, [
      'atlas',
      'compile',
      '--project',
      'project.json',
      '--output',
      before,
      '--root',
      '.',
      '--visibility',
      'public',
      '--json',
    ]),
  );
  assert.equal(baseline.verdict, 'pass');

  const sealArgs = [
    CLI,
    'episode-seal',
    '--root',
    root,
    '--bundle',
    path.join(PUBLIC_EPISODE_FIXTURE, 'bundle.json'),
    '--qualification',
    path.join(PUBLIC_EPISODE_FIXTURE, 'qualification.json'),
    '--writer-id',
    'settlement-integration',
    '--json',
  ];
  const plannedSeal = JSON.parse(run(root, process.execPath, sealArgs));
  assert.equal(plannedSeal.dryRun, true);
  assert.equal(
    plannedSeal.semanticRoot,
    'sha256:1953196f53ac451b64542456ba49c6333f6fda176975aa96518e2604a8237bcf',
  );
  assert.equal(
    plannedSeal.providerRoot,
    'sha256:97c263b6898e2ed7ac280472554cbdcfb55d203c6f946a26e1aa21cbc50f78f0',
  );
  assert.equal(
    plannedSeal.qualificationRoot,
    'sha256:8f161379ffa5bf4719e4fd759fb00bf062461019324bb27ed72697912af1bd9b',
  );
  const sealed = JSON.parse(
    run(root, process.execPath, [
      ...sealArgs.slice(0, -1),
      '--execute',
      '--stage',
      '--json',
    ]),
  );
  assert.equal(sealed.staged, true);

  const segment = `.kungfu/episodes/sealed/sha256/19/${plannedSeal.semanticRoot.slice(7)}`;
  const submissionPath = 'evidence/public-episode-submission.json';
  writeJson(path.join(root, submissionPath), {
    schema: 'xinfa.episode-provider-submission/v1',
    provider: 'git-workspace-jsonl/v1',
    providerId: 'small.public-runtime-episode',
    root: 'repository',
    beforeAtlasRoot: baseline.atlas_root,
    resultCut: { id: 'small.public-runtime-successor' },
    episodes: [
      {
        id: 'episode.public-runtime-61001',
        manifestPath: `${segment}/manifest.json`,
        claimsPath: `${segment}/claims.jsonl`,
        qualificationPath: `${segment}/qualification.json`,
        semanticRoot: plannedSeal.semanticRoot,
        providerRoot: plannedSeal.providerRoot,
        qualificationRoot: plannedSeal.qualificationRoot,
        visibility: 'public',
      },
    ],
    units: [
      {
        id: 'small.evidence.public-runtime-episode',
        type: 'proof-ref',
        episode: 'episode.public-runtime-61001',
        recordIndex: 1,
        dependsOn: [],
        routes: ['small.agent', 'small.human'],
      },
    ],
    edges: [],
  });
  run(root, 'git', ['add', '--', submissionPath]);
  const request = {
    schema: 'project.cut.settlement-request/v1',
    project: { id: 'small', identityRoot: `sha256:${'5'.repeat(64)}` },
    parentCutRoots: [],
    visibility: 'public',
    authorityMode: 'bridge',
    source: { visibility: [] },
    atlas: {
      mode: 'episode-successor',
      before: '.xinfa/generated/before',
      project: 'project.json',
      submission: submissionPath,
      root: '.',
    },
    episodes: [{ semanticRoot: plannedSeal.semanticRoot }],
    omissions: [],
    conflicts: [],
    unknowns: [],
  };
  const result = prepareSettlement(root, request, {
    xinfaBin: BINARY,
    execute: true,
    stage: true,
  });
  assert.equal(result.ok, true);
  const retainedBaseline = `.xinfa/baselines/sha256/${result.cut.atlas.root.slice(7)}`;
  assert.ok(
    result.plan.outputs.includes(`${retainedBaseline}/manifest.json`),
    'settlement must publish the baseline witness manifest',
  );
  assert.ok(
    result.plan.outputs.includes(`${retainedBaseline}/receipt.json`),
    'settlement must publish the baseline witness receipt',
  );
  assert.equal(
    result.plan.outputs.includes(`${retainedBaseline}/atlas.json`),
    false,
    'settlement must not publish the Atlas body through Git',
  );
  assert.equal(
    fs.existsSync(path.join(root, retainedBaseline, 'atlas.json')),
    true,
    'settlement must retain the Atlas body on disk as local immutable material',
  );
  assert.equal(
    result.cut.episodeDelta.nativeRoots[0].root,
    plannedSeal.providerRoot,
  );
  assert.equal(
    verifySettlement(root, result.statePath, { execute: true }).ok,
    true,
  );
  run(root, 'git', ['commit', '-qm', 'test: settle public runtime Episode']);
  const published = observeSettlementCommit(root, result.statePath, 'HEAD', {
    execute: true,
  });
  assert.equal(published.ok, true);
  assert.equal(published.state.status, 'published');

  // Reproduce an old settlement that published the Cut and promotion before
  // successor Atlas retention was introduced. Repair must add only the missing
  // baseline while accepting the already-indexed immutable outputs.
  run(root, 'git', ['rm', '-qr', '--', retainedBaseline]);
  run(root, 'git', [
    'commit',
    '-qm',
    'test: model legacy settlement without retained Atlas',
  ]);
  const repaired = prepareSettlement(root, request, {
    xinfaBin: BINARY,
    execute: true,
    stage: true,
  });
  assert.equal(repaired.ok, true);
  assert.deepEqual(
    run(root, 'git', ['diff', '--cached', '--name-only']).split('\n'),
    repaired.plan.outputs
      .filter((candidate) => candidate.startsWith(`${retainedBaseline}/`))
      .sort(),
  );
  assert.equal(
    verifySettlement(root, repaired.statePath, { execute: true }).ok,
    true,
  );
  run(root, 'git', ['commit', '-qm', 'test: repair retained Atlas baseline']);

  run(root, 'git', ['clone', '-q', root, fresh]);
  assert.equal(
    fs.existsSync(path.join(fresh, retainedBaseline, 'manifest.json')),
    true,
    'a fresh clone must retain the baseline witness manifest',
  );
  assert.equal(
    fs.existsSync(path.join(fresh, retainedBaseline, 'receipt.json')),
    true,
    'a fresh clone must retain the baseline witness receipt',
  );
  assert.equal(
    fs.existsSync(path.join(fresh, retainedBaseline, 'atlas.json')),
    false,
    'a fresh clone must not receive the Atlas body through Git',
  );
  const reconciled = reconcileCommit(fresh, 'HEAD');
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.cuts[0].cutRoot, result.cut.cutRoot);
  assert.equal(
    reconciled.cuts[0].sourceProjectionRoot,
    result.sourceProjection.root,
  );
});
