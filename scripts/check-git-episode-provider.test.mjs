// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EPISODE_PROVIDER_CAPABILITY_MATRIX,
  buildGitEpisodeSegment,
  episodeProviderPaths,
  exportGitEpisode,
  fsckGitEpisode,
  inspectEpisodeProviderTemps,
  importGitEpisode,
  recoverGitEpisodeLease,
  sealGitEpisode,
} from '../framework/episode-provider/src/git-workspace-episode-provider.mjs';

const ROOT = 'a'.repeat(64);

function bundle(id = 7, root = ROOT) {
  return {
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
      content_root: root,
    },
    records: [
      { manifest_frame_uid: 91, carrier_type: 10801, record: { episode_id: id } },
      { manifest_frame_uid: 92, carrier_type: 10805, record: { episode_id: id } },
      { manifest_frame_uid: 93, carrier_type: 10806, record: { root_value: root } },
    ],
    refs: [],
    dependencies: [],
  };
}

function qualification(id = 7) {
  return {
    schema: 'kungfu.episode.qualification/v1',
    policy_source: 'cpp-typed-fold-fsck',
    episode_id: id,
    lifecycle: 'ended',
    status: 'ok',
    evidence: { manifest_integrity: { state: 'verified', issue_codes: [] } },
    issues: [],
    capabilities: [
      { name: 'export_evidence', safe: true, requires: [], blocked_by: [] },
    ],
    safe_capabilities: ['export_evidence'],
    contractions: [],
    repair_prerequisites: [],
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-git-episode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('seals one immutable JSONL segment and re-import is idempotent', (t) => {
  const root = workspace(t);
  const segment = buildGitEpisodeSegment(bundle(), qualification());
  const first = sealGitEpisode(root, segment, { writerId: 'writer-a' });
  assert.equal(first.status, 'sealed');
  assert.equal(
    fs.readFileSync(path.join(root, '.kungfu', '.gitignore'), 'utf8'),
    'runtime/\nepisodes/.tmp/\nprivate/\ncache/\n',
  );
  assert.equal(fsckGitEpisode(root, segment.semanticRoot).ok, true);
  const second = sealGitEpisode(root, segment, { writerId: 'writer-b' });
  assert.equal(second.status, 'already-present');
  const exported = exportGitEpisode(root, segment.semanticRoot);
  assert.equal(exported.semanticRoot, segment.semanticRoot);
  assert.equal(exported.providerRoot, segment.providerRoot);
});

test('provider export/import preserves both roots across workspaces', (t) => {
  const source = workspace(t);
  const destination = workspace(t);
  const segment = buildGitEpisodeSegment(bundle(), qualification());
  sealGitEpisode(source, segment, { writerId: 'source' });
  const exported = exportGitEpisode(source, segment.semanticRoot);
  const receipt = importGitEpisode(destination, exported, {
    writerId: 'destination',
  });
  assert.equal(receipt.status, 'sealed');
  assert.equal(receipt.semanticRoot, segment.semanticRoot);
  assert.equal(receipt.providerRoot, segment.providerRoot);
  assert.equal(fsckGitEpisode(destination, segment.semanticRoot).ok, true);
});

test('different Episodes have independent leases; the same Episode rejects a second writer', (t) => {
  const root = workspace(t);
  const one = buildGitEpisodeSegment(bundle(7, 'a'.repeat(64)), qualification(7));
  const two = buildGitEpisodeSegment(bundle(8, 'b'.repeat(64)), qualification(8));
  const onePaths = episodeProviderPaths(root, one.semanticRoot);
  fs.mkdirSync(path.dirname(onePaths.lease), { recursive: true });
  fs.writeFileSync(onePaths.lease, '{}\n');
  assert.throws(
    () => sealGitEpisode(root, one, { writerId: 'writer-b' }),
    { code: 'episode-writer-busy' },
  );
  assert.equal(
    sealGitEpisode(root, two, { writerId: 'writer-c' }).status,
    'sealed',
  );
});

test('crash before rename is bounded and leaves no published segment', (t) => {
  const root = workspace(t);
  const segment = buildGitEpisodeSegment(bundle(), qualification());
  assert.throws(
    () =>
      sealGitEpisode(root, segment, {
        writerId: 'writer-a',
        fault: 'before-rename',
      }),
    { code: 'injected-crash' },
  );
  assert.equal(fsckGitEpisode(root, segment.semanticRoot).ok, false);
  assert.equal(inspectEpisodeProviderTemps(root).length, 1);
  assert.throws(
    () => sealGitEpisode(root, segment, { writerId: 'writer-b', generation: 2 }),
    { code: 'episode-writer-busy' },
  );
  assert.throws(
    () =>
      recoverGitEpisodeLease(root, segment.semanticRoot, {
        expectedWriterId: 'wrong-writer',
        nextGeneration: 2,
      }),
    { code: 'episode-lease-generation-mismatch' },
  );
  const recovery = recoverGitEpisodeLease(root, segment.semanticRoot, {
    expectedWriterId: 'writer-a',
    nextGeneration: 2,
  });
  assert.equal(recovery.status, 'lease-recovered');
  assert.equal(
    sealGitEpisode(root, segment, { writerId: 'writer-b', generation: 2 }).status,
    'sealed',
  );
});

test('torn tail, duplicate, out-of-order, hash drift, and unknown schema fail visibly', (t) => {
  const mutations = [
    ['torn-tail', (raw) => raw.subarray(0, raw.length - 1)],
    [
      'duplicate-record',
      (raw) => {
        const rows = raw.toString().trimEnd().split('\n');
        const second = JSON.parse(rows[1]);
        second.index = 0;
        rows[1] = JSON.stringify(second);
        return Buffer.from(`${rows.join('\n')}\n`);
      },
    ],
    [
      'out-of-order',
      (raw) => {
        const rows = raw.toString().trimEnd().split('\n');
        const second = JSON.parse(rows[1]);
        second.index = 9;
        rows[1] = JSON.stringify(second);
        return Buffer.from(`${rows.join('\n')}\n`);
      },
    ],
    ['claims-hash-mismatch', (raw) => Buffer.concat([raw, Buffer.from(' ')])],
    [
      'unknown-schema',
      (raw) => Buffer.from(raw.toString().replace('/v1"', '/v2"')),
    ],
  ];
  for (const [expected, mutate] of mutations) {
    const root = workspace(t);
    const segment = buildGitEpisodeSegment(bundle(), qualification());
    sealGitEpisode(root, segment, { writerId: expected });
    const paths = episodeProviderPaths(root, segment.semanticRoot);
    const claims = path.join(paths.segment, 'claims.jsonl');
    fs.writeFileSync(claims, mutate(fs.readFileSync(claims)));
    const codes = fsckGitEpisode(root, segment.semanticRoot).issues.map(
      ({ code }) => code,
    );
    assert.ok(codes.includes(expected), `${expected}: ${codes.join(', ')}`);
  }
});

test('raw runtime material and unqualified roots are rejected', () => {
  assert.throws(
    () =>
      buildGitEpisodeSegment(
        { ...bundle(), self_contained: true, journals: [] },
        qualification(),
      ),
    { code: 'private-material-not-admitted' },
  );
  assert.throws(
    () => buildGitEpisodeSegment(bundle(), { ...qualification(), status: 'failed' }),
    { code: 'qualification-not-admissible' },
  );
});

test('an existing workspace ignore must retain every private/runtime exclusion', (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, '.kungfu'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kungfu', '.gitignore'), 'runtime/\n');
  const segment = buildGitEpisodeSegment(bundle(), qualification());
  assert.throws(
    () => sealGitEpisode(root, segment, { writerId: 'writer-a' }),
    { code: 'workspace-ignore-incomplete' },
  );
});

test('capability matrix keeps native authority separate from Git shadow storage', () => {
  assert.deepEqual(
    EPISODE_PROVIDER_CAPABILITY_MATRIX.map((entry) => [
      entry.provider,
      entry.authority,
      entry.computesSemanticRoot,
    ]),
    [
      ['yijinjing+content-addressed-file', true, true],
      ['yijinjing+rocksdb', true, true],
      ['git-workspace-jsonl/v1', false, false],
    ],
  );
});
