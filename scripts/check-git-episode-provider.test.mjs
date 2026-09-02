// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { optionalAjv2020 } from './readonly-source-toolchain.mjs';

import {
  EPISODE_PROVIDER_CAPABILITY_MATRIX,
  buildGitEpisodeSegment,
  episodeProviderPaths,
  exportGitEpisode,
  fsckGitEpisode,
  importGitEpisode,
  inspectEpisodeProviderTemps,
  recoverGitEpisodeLease,
  sealGitEpisode,
} from '../framework/episode-provider/src/git-workspace-episode-provider.mjs';
import {
  canonicalJson,
  semanticRoot,
  sha256Bytes,
} from '../framework/project-cut/index.mjs';

const ROOT = 'a'.repeat(64);
const Ajv2020 = optionalAjv2020();
const MAX_SAFE_UINT64 = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_UINT64 = 18446744073709551615n;

function readJson(relative) {
  return JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', relative), 'utf8'),
  );
}

function validUint64Wire(value) {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0;
  if (typeof value !== 'string' || !/^[1-9][0-9]{15,19}$/u.test(value))
    return false;
  const parsed = BigInt(value);
  return parsed > MAX_SAFE_UINT64 && parsed <= MAX_UINT64;
}

function sortedUniqueRoots(values) {
  return values.every(
    (value, index) =>
      /^sha256:[0-9a-f]{64}$/u.test(value) &&
      (index === 0 ||
        Buffer.compare(
          Buffer.from(values[index - 1], 'utf8'),
          Buffer.from(value, 'utf8'),
        ) < 0),
  );
}

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
      begin_time: 1784209757092294458n,
    },
    records: [
      {
        manifest_frame_uid: 91,
        carrier_type: 10801,
        record: { episode_id: id, begin_time: 1784209757092294458n },
      },
      {
        manifest_frame_uid: 92,
        carrier_type: 10805,
        record: { episode_id: id },
      },
      {
        manifest_frame_uid: 93,
        carrier_type: 10806,
        record: { root_value: root },
      },
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

test('public schemas close producer bytes without claiming the native root', () => {
  const ajv = Ajv2020 ? new Ajv2020({ allErrors: true, strict: true }) : null;
  const validateManifest = ajv
    ? ajv.compile(
        readJson(
          'framework/episode-provider/schema/git-workspace-manifest-v1.schema.json',
        ),
      )
    : null;
  const validateSegment = ajv
    ? ajv.compile(
        readJson(
          'framework/episode-provider/schema/git-workspace-segment-v1.schema.json',
        ),
      )
    : null;
  const validateQualification = ajv
    ? ajv.compile(
        readJson(
          'framework/episode-provider/schema/episode-qualification-v1.schema.json',
        ),
      )
    : null;
  const validateProvider = ajv
    ? ajv.compile(
        readJson(
          'framework/episode-provider/schema/git-workspace-provider-contract-v1.schema.json',
        ),
      )
    : null;
  const providerContract = readJson(
    'framework/episode-provider/git-workspace-provider.contract.json',
  );
  const cases = readJson(
    'framework/episode-provider/fixtures/schema-cases-v1.json',
  );
  assert.deepEqual(cases.positive, [
    'provider-contract',
    'sealed-manifest',
    'qualification',
    'claims-jsonl-rows',
  ]);

  const input = bundle();
  input.refs = [
    { ref_hash: `sha256:${'b'.repeat(64)}` },
    { ref_hash: `sha256:${'a'.repeat(64)}` },
    { ref_hash: `sha256:${'a'.repeat(64)}` },
  ];
  input.dependencies = [{ episode_id: 9 }, { episode_id: 8 }];
  const qualified = qualification();
  const segment = buildGitEpisodeSegment(input, qualified);
  const rows = segment.claims
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((row) => JSON.parse(row));

  if (ajv) {
    assert.equal(validateProvider(providerContract), true, ajv.errorsText());
    assert.equal(validateManifest(segment.manifest), true, ajv.errorsText());
    assert.equal(validateQualification(qualified), true, ajv.errorsText());
    for (const row of rows)
      assert.equal(validateSegment(row), true, ajv.errorsText());
  }
  assert.equal(segment.claims.at(-1), 0x0a);
  assert.equal(segment.manifest.claims.count, rows.length);
  assert.equal(segment.manifest.claims.digest, sha256Bytes(segment.claims));
  assert.deepEqual(
    rows.map(({ index }) => index),
    rows.map((_, index) => index),
  );
  assert.equal(sortedUniqueRoots(segment.manifest.contentRefs), true);
  assert.deepEqual(segment.manifest.dependencies, input.dependencies);
  assert.equal(validUint64Wire(rows[0].record.record.begin_time), true);
  const { providerRoot, ...providerPreimage } = segment.manifest;
  assert.equal(providerRoot, semanticRoot(providerPreimage));
  assert.equal(segment.manifest.qualificationRoot, semanticRoot(qualified));
  assert.equal(segment.semanticRoot, `sha256:${ROOT}`);
  assert.equal(
    providerContract.equivalence.recomputesEpisodeSemanticRoot,
    false,
  );

  const manifestExtra = structuredClone(segment.manifest);
  manifestExtra.unexpected = true;
  if (ajv) {
    assert.equal(validateManifest(manifestExtra), false);
    assert.equal(validateSegment({ ...rows[0], index: -1 }), false);
    assert.equal(
      validateQualification({ ...qualified, policy_source: 'javascript' }),
      false,
    );
    assert.equal(
      validateProvider({ ...providerContract, authority: 'git-workspace' }),
      false,
    );
    assert.equal(
      validateProvider({
        ...providerContract,
        schemas: {
          ...providerContract.schemas,
          manifest: 'consumer-owned.json',
        },
      }),
      false,
    );
  }
  const unsafeDependency = structuredClone(segment.manifest);
  unsafeDependency.dependencies = [{ episode_id: 9007199254740992 }];
  if (validateManifest) assert.equal(validateManifest(unsafeDependency), false);
  assert.equal(
    sortedUniqueRoots([`sha256:${'b'.repeat(64)}`, `sha256:${'a'.repeat(64)}`]),
    false,
  );
  assert.equal(validUint64Wire('18446744073709551616'), false);
  assert.equal(validUint64Wire('9007199254740991'), false);
  assert.equal(validUint64Wire(9007199254740992), false);
  assert.equal(validUint64Wire('18446744073709551615'), true);
  assert.deepEqual(
    cases.adversarial.map(({ id }) => id),
    [
      'manifest-extra-field',
      'segment-negative-index',
      'qualification-wrong-policy',
      'provider-authority-widened',
      'provider-schema-path-substitution',
      'dependency-unsafe-integer',
      'content-ref-order',
      'uint64-overflow-string',
      'uint64-unsafe-number',
    ],
  );
  assert.equal(
    segment.qualificationBytes.toString('utf8'),
    `${canonicalJson(qualified)}\n`,
  );
});

test('seals one immutable JSONL segment and re-import is idempotent', (t) => {
  const root = workspace(t);
  const segment = buildGitEpisodeSegment(bundle(), qualification());
  const first = sealGitEpisode(root, segment, { writerId: 'writer-a' });
  assert.equal(first.status, 'sealed');
  assert.equal(
    fs.readFileSync(path.join(root, '.kungfu', '.gitignore'), 'utf8'),
    'runtime/\ninbox/\nepisodes/.tmp/\nprivate/\ncache/\nlocks/\nprojections/\n',
  );
  assert.equal(fsckGitEpisode(root, segment.semanticRoot).ok, true);
  assert.match(
    fs.readFileSync(
      path.join(
        episodeProviderPaths(root, segment.semanticRoot).segment,
        'claims.jsonl',
      ),
      'utf8',
    ),
    /"begin_time":"1784209757092294458"/u,
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          '.kungfu',
          'episodes',
          'sealed',
          'sha256',
          ROOT.slice(0, 2),
          ROOT,
          'qualification.json',
        ),
        'utf8',
      ),
    ),
    qualification(),
  );
  const second = sealGitEpisode(root, segment, { writerId: 'writer-b' });
  assert.equal(second.status, 'already-present');
  const exported = exportGitEpisode(root, segment.semanticRoot);
  assert.equal(exported.semanticRoot, segment.semanticRoot);
  assert.equal(exported.providerRoot, segment.providerRoot);
});

test('accepts the original workspace ignore policy without widening it', (t) => {
  const root = workspace(t);
  const ignore = path.join(root, '.kungfu', '.gitignore');
  const original = 'runtime/\ninbox/\nepisodes/.tmp/\nprivate/\ncache/\n';
  fs.mkdirSync(path.dirname(ignore), { recursive: true });
  fs.writeFileSync(ignore, original);

  const segment = buildGitEpisodeSegment(bundle(), qualification());
  assert.equal(
    sealGitEpisode(root, segment, { writerId: 'legacy' }).status,
    'sealed',
  );
  assert.equal(fs.readFileSync(ignore, 'utf8'), original);
});

test('projects valid int63 Episode identities to lossless decimal strings', () => {
  const episodeId = 64635488523251540n;
  const input = bundle(episodeId);
  input.dependencies = [{ episode_id: episodeId }];
  const segment = buildGitEpisodeSegment(input, qualification(episodeId));
  const storedQualification = JSON.parse(
    segment.qualificationBytes.toString('utf8'),
  );

  assert.equal(segment.manifest.episodeId, episodeId.toString(10));
  assert.equal(
    segment.manifest.dependencies[0].episode_id,
    episodeId.toString(10),
  );
  assert.equal(storedQualification.episode_id, episodeId.toString(10));
  assert.equal(segment.qualification.episode_id, episodeId.toString(10));
  assert.equal(
    segment.manifest.qualificationRoot,
    semanticRoot(storedQualification),
  );
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
  const one = buildGitEpisodeSegment(
    bundle(7, 'a'.repeat(64)),
    qualification(7),
  );
  const two = buildGitEpisodeSegment(
    bundle(8, 'b'.repeat(64)),
    qualification(8),
  );
  const onePaths = episodeProviderPaths(root, one.semanticRoot);
  fs.mkdirSync(path.dirname(onePaths.lease), { recursive: true });
  fs.writeFileSync(onePaths.lease, '{}\n');
  assert.throws(() => sealGitEpisode(root, one, { writerId: 'writer-b' }), {
    code: 'episode-writer-busy',
  });
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
    () =>
      sealGitEpisode(root, segment, { writerId: 'writer-b', generation: 2 }),
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
    sealGitEpisode(root, segment, { writerId: 'writer-b', generation: 2 })
      .status,
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
    () =>
      buildGitEpisodeSegment(bundle(), {
        ...qualification(),
        status: 'failed',
      }),
    { code: 'qualification-not-admissible' },
  );
  const overflow = bundle();
  overflow.records[0].record.begin_time = 18446744073709551616n;
  assert.throws(() => buildGitEpisodeSegment(overflow, qualification()), {
    code: 'episode-uint64-invalid',
  });
});

test('qualification preimage drift fails visibly', (t) => {
  const root = workspace(t);
  const segment = buildGitEpisodeSegment(bundle(), qualification());
  sealGitEpisode(root, segment, { writerId: 'writer-a' });
  const paths = episodeProviderPaths(root, segment.semanticRoot);
  const file = path.join(paths.segment, 'qualification.json');
  const changed = { ...qualification(), status: 'failed' };
  fs.writeFileSync(file, `${JSON.stringify(changed)}\n`);
  const codes = fsckGitEpisode(root, segment.semanticRoot).issues.map(
    ({ code }) => code,
  );
  assert.ok(codes.includes('qualification-root-mismatch'));
  assert.ok(codes.includes('qualification-not-admissible'));
});

test('an existing workspace ignore must retain every private/runtime exclusion', (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, '.kungfu'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kungfu', '.gitignore'), 'runtime/\n');
  const segment = buildGitEpisodeSegment(bundle(), qualification());
  assert.throws(() => sealGitEpisode(root, segment, { writerId: 'writer-a' }), {
    code: 'workspace-ignore-incomplete',
  });
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
