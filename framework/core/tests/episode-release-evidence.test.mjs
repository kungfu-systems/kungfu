// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseEvidence,
  canonicalDigest,
  sealEvidence,
  validateReleaseEvidence,
} from './qualification/episode/release_evidence.mjs';

const coreDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const rootDir = path.resolve(coreDir, '..', '..');
const scriptPath = path.join(
  coreDir,
  'tests',
  'qualification',
  'episode',
  'release_evidence.mjs',
);
const profilePath = path.join(
  coreDir,
  'tests',
  'qualification',
  'episode',
  'profiles',
  'mvp-baseline-v1.json',
);
const profileDocument = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const dimensionNames = profileDocument.semantic.required_dimensions;

function profile() {
  return {
    name: 'mvp-baseline-v1',
    schema: profileDocument.schema,
    path: path.relative(rootDir, profilePath).split(path.sep).join('/'),
    canonical_json_sha256: canonicalDigest(profileDocument),
    document: profileDocument,
  };
}

function report() {
  const scenarioCount =
    profileDocument.seeds.length *
    (profileDocument.accumulation.checkpoints.length +
      profileDocument.contention.workers.length);
  const dimensions = Object.fromEntries(
    dimensionNames.map((name) => [
      name,
      {
        status: 'passed',
        cases_executed: 1,
        violations: [],
        evidence: [`fixture:${name}`],
        reason: null,
      },
    ]),
  );
  return {
    schema: 'kungfu.episode.trust-report/v2',
    source_revision: '1'.repeat(40),
    source_dirty: false,
    episode_contract: 'kungfu.episode.manifest/v1',
    profile: 'mvp-baseline-v1',
    platform: { os: 'test', arch: 'test', node: process.version },
    hardware: { logical_cpus: 1, total_memory_bytes: 1 },
    backend_capabilities: {
      manifest_authority: 'yijinjing-journal',
      writer_ownership: 'one-logical-manifest-writer-per-data-root',
      payload_profile: 'metadata-only',
      query_profile: 'episode-manifest-direct',
      retry_policy: {},
    },
    workload: {
      profile: 'mvp-baseline-v1',
      seeds: profileDocument.seeds,
      duration_seconds: 1,
      scenarios: Array.from({ length: scenarioCount }, (_, index) => ({
        kind: index % 2 ? 'contention' : 'accumulation',
        ok: true,
      })),
    },
    fault_coverage: {
      writer_contention_exercised: true,
      writer_contention_observed: true,
      fresh_process_readback: true,
      clean_recovery: true,
      interrupted_open_recovery: true,
      missing_content_and_hash_rejection: true,
      dependency_failure_containment: true,
      projection_drift_and_rebuild: true,
    },
    correctness: {
      count_mismatches: 0,
      readback_mismatches: 0,
      fsck_failures: 0,
      recovery_mismatches: 0,
      retry_exhausted: 0,
      unexpected_errors: 0,
      progress_timeouts: 0,
    },
    semantic_evidence: {
      oracle: 'kungfu.episode.semantic-oracle/v1',
      oracle_check: {
        status: 'passed',
        histories_checked: 48,
        violation: null,
      },
      required_dimensions: dimensionNames,
      dimensions,
      cases: [],
      process: null,
    },
    performance: { scenarios: [] },
    gaps: ['fixture has no capacity claim'],
    qualified: true,
  };
}

function context() {
  return {
    profile: profile(),
    sourceRevision: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    startedAt: '2026-07-10T00:00:00.000Z',
    completedAt: '2026-07-10T00:00:01.000Z',
    durationSeconds: 1,
    harnessExit: 0,
    shifuEntrypoint: true,
    runtimeArtifacts: [
      {
        path: 'framework/core/dist/kungfu/pykungfu.test.so',
        bytes: 1,
        sha256: `sha256:${'3'.repeat(64)}`,
      },
    ],
    toolchain: {
      shifu: { version: '4.0.0-alpha.1', entrypoint_provenance: true },
      node: process.version,
      python: 'Python 3.13.0',
      uv: 'uv 0.8.0',
      package_manager: 'pnpm@11.7.0',
      buildchain_package: '@kungfu-tech/buildchain@0.0.0-test',
      pins: { node: '22.22.3', fnm: '1.39.0', uv: '0.8.0' },
    },
    ci: { provider: 'local' },
  };
}

test('builds a qualified self-contained release evidence envelope', () => {
  const evidence = buildReleaseEvidence(report(), context());
  const validation = validateReleaseEvidence(evidence, { profilePath });
  assert.equal(evidence.verdict, 'qualified');
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(
    evidence.qualification.hard_gates.every((row) => row.passed),
    true,
  );
});

test('rejects a recomputed envelope whose Trust Report is no longer qualified', () => {
  const evidence = buildReleaseEvidence(report(), context());
  evidence.trust_report.qualified = false;
  evidence.qualification.trust_report_canonical_sha256 = canonicalDigest(
    evidence.trust_report,
  );
  const resealed = sealEvidence(evidence);
  const validation = validateReleaseEvidence(resealed, { profilePath });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /hard-gate|verdict|not qualified/);
});

test('rejects profile drift even when the outer evidence digest is recomputed', () => {
  const evidence = buildReleaseEvidence(report(), context());
  evidence.profile.document.contention.total_episodes += 1;
  const resealed = sealEvidence(evidence);
  const validation = validateReleaseEvidence(resealed, { profilePath });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /profile digest/);
});

test('rejects a Buildchain source SHA that differs from the qualified revision', () => {
  const buildContext = context();
  buildContext.ci = {
    provider: 'github-actions',
    source_sha: '9'.repeat(40),
  };
  const evidence = buildReleaseEvidence(report(), buildContext);
  const validation = validateReleaseEvidence(evidence, { profilePath });
  assert.equal(evidence.verdict, 'failed');
  assert.equal(validation.ok, false);
  assert.equal(
    evidence.qualification.hard_gates.find(
      (row) => row.id === 'ci_source_revision',
    )?.passed,
    false,
  );
});

test('rejects a Windows absolute profile path in a resealed envelope', () => {
  const evidence = buildReleaseEvidence(report(), context());
  evidence.profile.path = 'C:\\outside\\mvp-baseline-v1.json';
  const validation = validateReleaseEvidence(sealEvidence(evidence));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /repository-relative/);
});

test('CLI verification checks both JSON schemas and internal digests', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kf-episode-evidence-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const evidencePath = path.join(directory, 'evidence.json');
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(buildReleaseEvidence(report(), context()), null, 2)}\n`,
  );
  const child = spawnSync(
    process.execPath,
    [scriptPath, 'verify', '--evidence', evidencePath, '--json'],
    { cwd: rootDir, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.checks.release_schema, true);
  assert.equal(result.checks.trust_report_schema, true);
});
