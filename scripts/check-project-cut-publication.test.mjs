// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildGitEpisodeSegment,
  sealGitEpisode,
} from '../framework/episode-provider/src/git-workspace-episode-provider.mjs';
import {
  buildProjectCut,
  canonicalJson,
  createProjectCutReceipt,
  semanticRoot,
} from '../framework/project-cut/index.mjs';
import * as publicationBoundary from '../framework/project-cut/publication.mjs';

const {
  advanceSettlementPublication,
  checkSettlementPublicationContract,
  classifySettlementPublicationTrigger,
  inspectSettlementPublication,
  materializeSettlementPublication,
  planSettlementPublication,
  reconcileSettlementPublication,
  verifySettlementPublication,
} = publicationBoundary;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PROJECT_CUT_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      REPO_ROOT,
      'framework/project-cut/fixtures/golden/project-cut-v1.json',
    ),
    'utf8',
  ),
);
const CLI = path.join(REPO_ROOT, 'framework/project-cut/bin/project-cut.mjs');

test('publication boundary exposes only the stable operations', () => {
  assert.deepEqual(Object.keys(publicationBoundary), [
    'advanceSettlementPublication',
    'checkSettlementPublicationContract',
    'classifySettlementPublicationTrigger',
    'inspectSettlementPublication',
    'materializeSettlementPublication',
    'planSettlementPublication',
    'reconcileSettlementPublication',
    'verifySettlementPublication',
  ]);
});

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`);
}

function episodeBundle(id, seed) {
  const episodeRoot = semanticRoot({ episode: seed });
  return {
    root: episodeRoot,
    bundle: {
      schema: 'kungfu.storage.episode-bundle/v1',
      bundle_id: `episode:${id}`,
      scope: 'episode',
      episode_id: id,
      authority: 'yijinjing-journal',
      manifest: {
        schema: 'kungfu.episode.manifest/v1',
        episode_id: id,
        opened: true,
        closed: true,
        status: 'ended',
        content_root_algorithm: 'sha256',
        content_root: episodeRoot.slice(7),
      },
      records: [
        {
          manifest_frame_uid: id * 10 + 1,
          carrier_type: 10801,
          record: { episode_id: id },
        },
        {
          manifest_frame_uid: id * 10 + 2,
          carrier_type: 10805,
          record: { episode_id: id },
        },
      ],
      refs: [],
      dependencies: [],
    },
    qualification: {
      schema: 'kungfu.episode.qualification/v1',
      policy_source: 'cpp-typed-fold-fsck',
      episode_id: id,
      lifecycle: 'ended',
      status: 'ok',
      evidence: {
        manifest_integrity: { state: 'verified', issue_codes: [] },
      },
      issues: [],
      capabilities: [
        {
          name: 'export_evidence',
          safe: true,
          requires: [],
          blocked_by: [],
        },
      ],
      safe_capabilities: ['export_evidence'],
      contractions: [],
      repair_prerequisites: [],
    },
  };
}

function projectCut(seed, episodeRoot) {
  const input = structuredClone(PROJECT_CUT_FIXTURE.projectCutInput);
  input.parentCutRoots = [];
  input.sourceProjection.root = semanticRoot({ source: seed });
  input.atlas.root = semanticRoot({ atlas: seed });
  input.episodeDelta.nativeRoots = [
    { provider: 'yijinjing/v1', root: episodeRoot },
  ];
  return buildProjectCut(input);
}

function addProjectCut(root, cut) {
  const hex = cut.cutRoot.slice(7);
  const directory = path.join(
    root,
    '.kungfu',
    'project-cuts',
    'sha256',
    hex.slice(0, 2),
    hex,
  );
  const manifestBytes = Buffer.from(`${canonicalJson(cut)}\n`);
  const receipt = createProjectCutReceipt(cut, manifestBytes);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), manifestBytes);
  writeJson(path.join(directory, 'receipt.json'), receipt);
  return cut.cutRoot;
}

function workspace(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'settlement-publication-'),
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, 'init', '-q', '-b', 'dev/v4/v4.0');
  git(root, 'config', 'user.name', 'Publication Test');
  git(root, 'config', 'user.email', 'publication@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'publication fixture\n');

  const firstEpisode = episodeBundle(7, 'first');
  const secondEpisode = episodeBundle(8, 'second');
  const sealedEpisodes = [firstEpisode, secondEpisode].map((entry) => {
    const segment = buildGitEpisodeSegment(entry.bundle, entry.qualification);
    sealGitEpisode(root, segment, { writerId: 'publication-test' });
    return segment;
  });
  const firstCut = projectCut('first', sealedEpisodes[0].providerRoot);
  const secondCut = projectCut('second', sealedEpisodes[1].providerRoot);
  addProjectCut(root, firstCut);
  addProjectCut(root, secondCut);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'test: seed sealed settlement material');
  return {
    root,
    episodes: sealedEpisodes.map((episode) => episode.semanticRoot).sort(),
    cuts: [firstCut.cutRoot, secondCut.cutRoot].sort(),
  };
}

function trigger(overrides = {}) {
  return {
    schema: 'kungfu.settlement-publication.trigger/v1',
    source: 'native-settlement',
    eventKind: 'project-cut-settled',
    headBranch: null,
    labels: [],
    generatedBy: null,
    publicationRoot: null,
    ...overrides,
  };
}

function request(fixture, overrides = {}) {
  return {
    schema: 'kungfu.settlement-publication.request/v1',
    batch: { kind: 'wave', id: 'wave-1' },
    repository: {
      id: 'kungfu-systems/kungfu',
      targetBranch: 'dev/v4/v4.0',
    },
    episodes: fixture.episodes,
    projectCuts: fixture.cuts,
    trigger: trigger(),
    ...overrides,
  };
}

function fakeAdapter() {
  const calls = { find: 0, publish: 0, open: 0 };
  let pullRequest = null;
  return {
    calls,
    get pullRequest() {
      return pullRequest;
    },
    findPullRequest() {
      calls.find += 1;
      return pullRequest;
    },
    publishSource(input) {
      calls.publish += 1;
      assert.equal(input.directTargetPush, false);
      assert.notEqual(input.head, input.base);
      return {
        branch: input.head,
        headSha: '1'.repeat(40),
        reused: calls.publish > 1,
      };
    },
    openPullRequest(input) {
      calls.open += 1;
      assert.match(input.body, /Kungfu-Settlement-Batch: sha256:/);
      pullRequest = {
        number: 17,
        url: 'https://example.invalid/pull/17',
        head: input.head,
        base: input.base,
        state: 'open',
        mergeCommit: null,
      };
      return pullRequest;
    },
  };
}

test('publication schemas and authority boundaries are rooted', () => {
  const result = checkSettlementPublicationContract();
  assert.equal(result.schemaFiles, 4);
  assert.match(result.schemaRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('planner is deterministic, order-independent, bounded, and root-sensitive', (t) => {
  const fixture = workspace(t);
  const first = planSettlementPublication(fixture.root, request(fixture));
  const second = planSettlementPublication(
    fixture.root,
    request(fixture, {
      episodes: [...fixture.episodes].reverse(),
      projectCuts: [...fixture.cuts].reverse(),
    }),
  );
  assert.equal(first.batchRoot, second.batchRoot);
  assert.equal(first.planRoot, second.planRoot);
  assert.equal(first.sourceBranch, second.sourceBranch);
  assert.equal(first.pullRequest.marker, second.pullRequest.marker);
  assert.notEqual(first.sourceBranch, first.repository.targetBranch);
  assert.equal(first.runtimeContinuationBlocked, false);
  assert.equal(
    first.manifest.runtimeContinuation.publicationIsAuthority,
    false,
  );
  assert.ok(
    first.manifest.selection.episodes.every(
      (episode) => episode.semanticRoot !== episode.providerRoot,
    ),
  );
  const selectedProviderRoots = new Set(
    first.manifest.selection.episodes.map((episode) => episode.providerRoot),
  );
  assert.ok(
    first.manifest.selection.projectCuts
      .flatMap((cut) => cut.episodeRoots)
      .every((episodeRoot) => selectedProviderRoots.has(episodeRoot)),
  );
  assert.equal(first.manifest.files.length, 10);

  const changed = planSettlementPublication(
    fixture.root,
    request(fixture, { batch: { kind: 'wave', id: 'wave-1-successor' } }),
  );
  assert.notEqual(changed.batchRoot, first.batchRoot);
  assert.notEqual(changed.sourceBranch, first.sourceBranch);

  assert.throws(
    () =>
      planSettlementPublication(
        fixture.root,
        request(fixture, {
          episodes: Array.from(
            { length: 257 },
            (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`,
          ),
        }),
      ),
    (error) => error.code === 'batch-bound-exceeded',
  );
});

test('planner fails closed on missing, mismatched, and unsealed inputs', (t) => {
  const fixture = workspace(t);
  assert.throws(
    () =>
      planSettlementPublication(
        fixture.root,
        request(fixture, {
          repository: {
            id: 'kungfu-systems/kungfu',
            targetBranch: 'refs/heads/../dev',
          },
        }),
      ),
    (error) => error.code === 'invalid-ref',
  );
  assert.throws(
    () =>
      planSettlementPublication(
        fixture.root,
        request(fixture, { episodes: [`sha256:${'f'.repeat(64)}`] }),
      ),
    (error) => error.code === 'tracked-material-missing',
  );

  const manifest = path.join(
    fixture.root,
    '.kungfu',
    'episodes',
    'sealed',
    'sha256',
    fixture.episodes[0].slice(7, 9),
    fixture.episodes[0].slice(7),
    'manifest.json',
  );
  const forged = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  forged.authority = 'not-authority';
  writeJson(manifest, forged);
  git(fixture.root, 'add', manifest);
  git(fixture.root, 'commit', '-qm', 'test: inject mismatched Episode shadow');
  assert.throws(
    () => planSettlementPublication(fixture.root, request(fixture)),
    (error) => error.code === 'episode-not-publishable',
  );
});

test('planner requires every Project Cut Episode in the bounded selection', (t) => {
  const fixture = workspace(t);
  assert.throws(
    () =>
      planSettlementPublication(
        fixture.root,
        request(fixture, { episodes: [fixture.episodes[0]] }),
      ),
    (error) => error.code === 'cut-episode-selection-incomplete',
  );
});

test('versioned no-recursion rule suppresses every generated ledger signal', () => {
  for (const candidate of [
    trigger({ generatedBy: 'kungfu-settlement-publication/v1' }),
    trigger({ labels: ['kungfu-machine-ledger'] }),
    trigger({ headBranch: `machine-ledger/settlement/${'a'.repeat(64)}` }),
    trigger({ publicationRoot: `sha256:${'a'.repeat(64)}` }),
  ]) {
    const result = classifySettlementPublicationTrigger(candidate);
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.length >= 1);
  }
  assert.equal(classifySettlementPublicationTrigger(trigger()).allowed, true);
});

test('materialization is immutable and CLI emits the same bounded plan', (t) => {
  const fixture = workspace(t);
  const requestValue = request(fixture);
  const plan = planSettlementPublication(fixture.root, requestValue);
  const dryRun = materializeSettlementPublication(fixture.root, plan);
  assert.equal(dryRun.executed, false);
  assert.equal(
    fs.existsSync(path.join(fixture.root, plan.manifestPath)),
    false,
  );
  const created = materializeSettlementPublication(fixture.root, plan, {
    execute: true,
    stage: true,
  });
  assert.equal(created.status, 'created');
  assert.match(
    git(fixture.root, 'status', '--short'),
    /^A {2}\.kungfu\/ledger/u,
  );
  assert.equal(
    materializeSettlementPublication(fixture.root, plan, {
      execute: true,
    }).status,
    'reused',
  );

  const requestPath = path.join(fixture.root, 'publication-request.json');
  writeJson(requestPath, requestValue);
  const response = JSON.parse(
    execFileSync(
      process.execPath,
      [
        CLI,
        'publication-prepare',
        '--request',
        requestPath,
        '--root',
        fixture.root,
        '--json',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(response.ok, true);
  assert.equal(response.plan.batchRoot, plan.batchRoot);
  assert.equal(response.materialization.executed, false);
});

test('duplicate and concurrent observations create at most one pull request', (t) => {
  const fixture = workspace(t);
  const plan = planSettlementPublication(fixture.root, request(fixture));
  materializeSettlementPublication(fixture.root, plan, { execute: true });
  const adapter = fakeAdapter();
  let nested = null;
  const publishSource = adapter.publishSource.bind(adapter);
  adapter.publishSource = (input) => {
    nested = advanceSettlementPublication(fixture.root, plan, adapter, {
      now: '2026-07-28T18:00:00Z',
    });
    return publishSource(input);
  };
  const first = advanceSettlementPublication(fixture.root, plan, adapter, {
    now: '2026-07-28T18:00:00Z',
  });
  const duplicate = advanceSettlementPublication(fixture.root, plan, adapter, {
    now: '2026-07-28T18:01:00Z',
  });
  assert.equal(nested.code, 'publication-busy');
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(first.pullRequest.number, 17);
  assert.equal(duplicate.pullRequest.number, 17);
  assert.equal(adapter.calls.publish, 1);
  assert.equal(adapter.calls.open, 1);
  assert.equal(duplicate.retryCount, 2);
});

test('protected target and malformed pull request observations fail closed', (t) => {
  const fixture = workspace(t);
  const plan = planSettlementPublication(fixture.root, request(fixture));
  materializeSettlementPublication(fixture.root, plan, { execute: true });
  const adapter = fakeAdapter();
  adapter.publishSource = (input) => ({
    branch: input.base,
    headSha: '1'.repeat(40),
  });
  const refused = advanceSettlementPublication(fixture.root, plan, adapter, {
    now: '2026-07-28T18:00:00Z',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'source-publication-mismatch');
  assert.equal(refused.runtimeContinuationBlocked, false);

  assert.throws(
    () =>
      reconcileSettlementPublication(fixture.root, plan, {
        schema: 'kungfu.settlement-publication.pull-request-observation/v1',
        batchRoot: plan.batchRoot,
        number: 17,
        url: 'https://example.invalid/pull/17',
        head: plan.sourceBranch,
        base: plan.repository.targetBranch,
        state: 'merged',
        mergeCommit: 'not-a-commit',
      }),
    (error) => error.code === 'pull-request-mismatch',
  );
});

test('partial failure is fail-visible and resumes without republishing source', (t) => {
  const fixture = workspace(t);
  const plan = planSettlementPublication(fixture.root, request(fixture));
  materializeSettlementPublication(fixture.root, plan, { execute: true });
  const adapter = fakeAdapter();
  const first = advanceSettlementPublication(fixture.root, plan, adapter, {
    now: '2026-07-28T18:00:00Z',
    fault: 'after-source',
  });
  assert.equal(first.ok, false);
  assert.equal(first.phase, 'source-published');
  assert.equal(first.unpublishedCutCount, 2);
  assert.match(first.latestFailureRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.runtimeContinuationBlocked, false);

  const resumed = advanceSettlementPublication(fixture.root, plan, adapter, {
    now: '2026-07-28T18:02:00Z',
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.phase, 'pull-request-open');
  assert.equal(resumed.publicationLagSeconds, 120);
  assert.equal(adapter.calls.publish, 1);
  assert.equal(adapter.calls.open, 1);

  const merged = reconcileSettlementPublication(
    fixture.root,
    plan,
    {
      schema: 'kungfu.settlement-publication.pull-request-observation/v1',
      batchRoot: plan.batchRoot,
      number: 17,
      url: 'https://example.invalid/pull/17',
      head: plan.sourceBranch,
      base: plan.repository.targetBranch,
      state: 'merged',
      mergeCommit: '2'.repeat(40),
    },
    { now: '2026-07-28T18:03:00Z' },
  );
  assert.equal(merged.phase, 'merged');
  assert.equal(merged.unpublishedCutCount, 0);
  assert.equal(merged.completionAuthority, 'kungfu-work-control');
  assert.equal(
    inspectSettlementPublication(fixture.root, plan, {
      now: '2026-07-28T18:04:00Z',
    }).phase,
    'merged',
  );
});

test('clean clone verifies exact published roots without runtime state', (t) => {
  const fixture = workspace(t);
  const plan = planSettlementPublication(fixture.root, request(fixture));
  materializeSettlementPublication(fixture.root, plan, {
    execute: true,
    stage: true,
  });
  git(fixture.root, 'commit', '-qm', 'test: publish settlement batch');
  const direct = verifySettlementPublication(fixture.root, plan.batchRoot);
  assert.equal(direct.ok, true, JSON.stringify(direct.diagnostics));

  const clone = fs.mkdtempSync(
    path.join(os.tmpdir(), 'settlement-publication-clone-'),
  );
  t.after(() => fs.rmSync(clone, { force: true, recursive: true }));
  execFileSync('git', ['clone', '-q', fixture.root, clone]);
  const clean = verifySettlementPublication(clone, plan.batchRoot);
  assert.equal(clean.ok, true, JSON.stringify(clean.diagnostics));
  assert.equal(clean.runtimeRequired, false);
  assert.equal(fs.existsSync(path.join(clone, '.kungfu', 'runtime')), false);

  const cli = spawnSync(
    process.execPath,
    [
      CLI,
      'publication-verify',
      '--batch-root',
      plan.batchRoot,
      '--root',
      clone,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stdout || cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ok, true);

  const manifestPath = path.join(clone, plan.manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.batchInput.episodes = [];
  const { manifestRoot: _manifestRoot, ...preimage } = manifest;
  manifest.manifestRoot = semanticRoot(preimage);
  writeJson(manifestPath, manifest);
  git(clone, 'add', manifestPath);
  git(clone, 'config', 'user.name', 'Publication Test');
  git(clone, 'config', 'user.email', 'publication@example.invalid');
  git(clone, 'commit', '-qm', 'test: inject internally inconsistent manifest');
  const inconsistent = verifySettlementPublication(clone, plan.batchRoot);
  assert.equal(inconsistent.ok, false);
  assert.ok(
    inconsistent.diagnostics.some(
      (diagnostic) => diagnostic.code === 'manifest-selection-mismatch',
    ),
  );
});
