// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KFD_CANDIDATE_EVIDENCE_CONTRACT,
  SUPPORTED_KFD_PLATFORMS,
  finalizeKfdCandidateEvidence,
  kfdEvidenceRoot,
  prepareKfdArtifactWitness,
  releaseArtifactRoot,
  resolveKfdSourcePlatform,
  restoreKfdPrebuiltLayerArtifact,
  runVerifiedQualification,
  sealKfdPrebuiltLayerArtifacts,
  verifyKfdCandidatePayloadSet,
  verifyKfdManifestSet,
  verifyReleaseArtifactRoot,
} from '../framework/release/kfd-candidate-evidence.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const SOURCE_TREE = 'b'.repeat(40);

test('resolves KFD source platforms from explicit Buildchain identities', () => {
  assert.equal(
    resolveKfdSourcePlatform('macos-arm64', {
      BUILDCHAIN_PLATFORM_ID: 'linux-x64',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
    }),
    'macos-arm64',
  );
  assert.equal(
    resolveKfdSourcePlatform('', {
      BUILDCHAIN_PLATFORM_ID: 'linux-arm64',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
    }),
    'linux-arm64',
  );
  assert.equal(
    resolveKfdSourcePlatform('', {
      'INPUT_PLATFORM-ID': 'windows-x64',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
    }),
    'windows-x64',
  );
});

test('infers every supported KFD source platform from GitHub runner identity', () => {
  const cases = [
    ['Linux', 'X64', 'linux-x64'],
    ['Linux', 'ARM64', 'linux-arm64'],
    ['macOS', 'ARM64', 'macos-arm64'],
    ['Windows', 'X64', 'windows-x64'],
  ];
  for (const [runnerOs, runnerArch, expected] of cases) {
    assert.equal(
      resolveKfdSourcePlatform('', {
        RUNNER_OS: runnerOs,
        RUNNER_ARCH: runnerArch,
      }),
      expected,
    );
  }
});

test('keeps non-runner source sealing platform-neutral', () => {
  assert.equal(resolveKfdSourcePlatform('', {}), '');
});

test('rejects incomplete or unsupported GitHub runner platform identity', () => {
  assert.throws(
    () => resolveKfdSourcePlatform('', { RUNNER_OS: 'Linux' }),
    /incomplete GitHub runner platform identity/u,
  );
  assert.throws(
    () =>
      resolveKfdSourcePlatform('', {
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'X64',
      }),
    /unsupported GitHub runner platform identity/u,
  );
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfd-candidate-test-'),
  );
  for (const platform of SUPPORTED_KFD_PLATFORMS) {
    const evidenceDir = path.join(
      root,
      `kungfu-${platform}-${SOURCE_SHA}`,
      'product',
      'release',
      'qualification',
      'kfd',
    );
    const evidencePath = path.join(
      evidenceDir,
      'artifacts',
      `${platform}.json`,
    );
    writeJson(evidencePath, { platform, ok: true });
    const evidenceFiles = [
      {
        path: `artifacts/${platform}.json`,
        bytes: fs.statSync(evidencePath).size,
        sha256: `sha256:${awaitHash(evidencePath)}`,
      },
    ];
    const body = {
      schema: KFD_CANDIDATE_EVIDENCE_CONTRACT,
      status: 'passed',
      candidate: { sourceSha: SOURCE_SHA, sourceTree: SOURCE_TREE },
      platform,
      supportedPlatforms: SUPPORTED_KFD_PLATFORMS,
      sourceGateRoot: 'sha256:source',
      artifactRoot: 'sha256:artifact',
      evidenceFiles,
      evidenceRoot: kfdEvidenceRoot(evidenceFiles),
    };
    writeJson(path.join(evidenceDir, 'candidate-evidence.json'), {
      ...body,
      capsuleRoot: kfdEvidenceRoot(body),
    });
  }
  return root;
}

function awaitHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactFixture(platform = 'linux-x64') {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfd-artifact-test-'),
  );
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'KFD Test']);
  git(['config', 'user.email', 'kfd-test@example.invalid']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'source\n');
  git(['add', 'source.txt']);
  git(['commit', '-q', '-m', 'test source']);
  const sourceSha = git(['rev-parse', 'HEAD']);
  const sourceTree = git(['rev-parse', 'HEAD^{tree}']);
  const runtime = path.join(
    root,
    '.buildchain',
    'runtime',
    'kfd-candidate-evidence',
  );
  writeJson(path.join(runtime, 'source-gate.json'), {
    status: 'passed',
    platform,
    candidate: { sourceSha, sourceTree },
    gateRoot: 'sha256:source-gate',
  });
  writeJson(
    path.join(
      runtime,
      'source',
      'kfd-3',
      `collaboration-interface.${platform}.prebuild.json`,
    ),
    { id: `kungfu-collaboration-interface-${platform}` },
  );
  fs.mkdirSync(path.join(root, 'product', 'release'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'product', 'release', 'artifact.bin'),
    'artifact\n',
  );
  return { root, platform, sourceSha, sourceTree };
}

function writePrebuiltLayerArtifacts(root) {
  const artifacts = {
    'product/release/spec/kungfu-spec.tgz': 'spec artifact\n',
    'framework/core/build/stage/sdk/python/kungfu.whl': 'wheel artifact\n',
    'product/release/npm/kungfu-core.tgz': 'npm artifact\n',
  };
  for (const [relativePath, content] of Object.entries(artifacts)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return artifacts;
}

test('accepts a complete sealed four-platform KFD payload set', () => {
  const root = fixture();
  assert.deepEqual(
    verifyKfdCandidatePayloadSet({
      payloadRoot: root,
      sourceSha: SOURCE_SHA,
      sourceTree: SOURCE_TREE,
    }),
    { ok: true, sourceSha: SOURCE_SHA, platforms: SUPPORTED_KFD_PLATFORMS },
  );
});

test('seals the artifact witness before qualification and the capsule after it', () => {
  const fixture = artifactFixture();
  const witness = prepareKfdArtifactWitness({
    ...fixture,
    buildArtifactWitness: () => ({
      id: 'kungfu-collaboration-interface',
      standard: 'kfd-3',
      witnessKind: 'artifact',
      exposedSurfaces: [],
    }),
  });
  assert.equal(
    witness.id,
    `kungfu-collaboration-interface-${fixture.platform}`,
  );
  assert.equal(witness.candidateBinding.platform, fixture.platform);
  assert.equal(
    fs.existsSync(
      path.join(
        fixture.root,
        'product',
        'release',
        'qualification',
        'kfd',
        'artifacts',
        `${fixture.platform}.json`,
      ),
    ),
    true,
  );
  const capsule = finalizeKfdCandidateEvidence(fixture);
  assert.equal(capsule.status, 'passed');
  assert.equal(capsule.platform, fixture.platform);
});

test('the Verify wrapper restores pre-qualification evidence after qualification cleanup', () => {
  const fixture = artifactFixture();
  let prepared = 0;
  const qualification = path.join(
    fixture.root,
    'product',
    'release',
    'qualification',
  );
  const command = [
    process.execPath,
    '-e',
    `const fs=require('node:fs');if(process.env.KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACTS!=='1'||!/^sha256:[a-f0-9]{64}$/.test(process.env.KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACT_ROOT||''))process.exit(23);fs.rmSync(${JSON.stringify(qualification)},{recursive:true,force:true});fs.mkdirSync(${JSON.stringify(qualification)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(qualification, 'qualification-passed.json'))},'{}\\n')`,
  ];
  assert.equal(
    runVerifiedQualification({
      ...fixture,
      command,
      prepareReleaseArtifacts() {
        prepared += 1;
        writePrebuiltLayerArtifacts(fixture.root);
        return 0;
      },
      buildArtifactWitness: () => ({
        id: 'kungfu-collaboration-interface',
        standard: 'kfd-3',
        witnessKind: 'artifact',
        exposedSurfaces: [],
      }),
    }),
    0,
  );
  assert.equal(prepared, 1);
  assert.equal(
    fs.existsSync(path.join(qualification, 'qualification-passed.json')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(qualification, 'kfd', 'candidate-evidence.json')),
    true,
  );
});

test('sealed prebuilt layer artifacts restore exact bytes and reject tampering', () => {
  const fixture = artifactFixture();
  const artifacts = writePrebuiltLayerArtifacts(fixture.root);
  const manifest = sealKfdPrebuiltLayerArtifacts(fixture);
  assert.equal(manifest.schema, 'kungfu.kfd-prebuilt-layer-artifacts/v1');
  for (const layer of ['format', 'sdk', 'surfaces']) {
    const relativePath = manifest.layers[layer].path;
    fs.rmSync(path.join(fixture.root, relativePath), {
      recursive: true,
      force: true,
    });
    restoreKfdPrebuiltLayerArtifact({ ...fixture, layer });
  }
  for (const [relativePath, content] of Object.entries(artifacts)) {
    assert.equal(
      fs.readFileSync(path.join(fixture.root, relativePath), 'utf8'),
      content,
    );
  }
  const sealedWheel = path.join(
    fixture.root,
    '.buildchain/runtime/kfd-candidate-evidence/prebuilt-layer-artifacts',
    'framework/core/build/stage/sdk/python/kungfu.whl',
  );
  fs.appendFileSync(sealedWheel, 'tampered\n');
  assert.throws(
    () => restoreKfdPrebuiltLayerArtifact({ ...fixture, layer: 'sdk' }),
    /sealed KFD sdk layer artifact digest mismatch/u,
  );
});

test('Verify stops before witnessing when release artifact materialization fails', () => {
  const fixture = artifactFixture();
  assert.equal(
    runVerifiedQualification({
      ...fixture,
      command: [process.execPath, '-e', 'process.exit(0)'],
      prepareReleaseArtifacts: () => 29,
    }),
    29,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        fixture.root,
        'product/release/qualification/kfd/artifacts',
        `${fixture.platform}.json`,
      ),
    ),
    false,
  );
});

test('fails before Verify completion when artifact bytes change after witnessing', () => {
  const fixture = artifactFixture();
  prepareKfdArtifactWitness({
    ...fixture,
    buildArtifactWitness: () => ({
      id: 'kungfu-collaboration-interface',
      standard: 'kfd-3',
      witnessKind: 'artifact',
      exposedSurfaces: [],
    }),
  });
  fs.appendFileSync(
    path.join(fixture.root, 'product', 'release', 'artifact.bin'),
    'tampered\n',
  );
  assert.throws(
    () => finalizeKfdCandidateEvidence(fixture),
    /KFD artifact digest mismatch:.*changed=artifact\.bin/u,
  );
});

test('reports added, removed, and changed release artifacts without restoring them', () => {
  const fixture = artifactFixture();
  const before = verifyReleaseArtifactRoot({
    root: fixture.root,
    expectedRoot: releaseArtifactRoot(fixture.root).root,
  });
  fs.appendFileSync(
    path.join(fixture.root, 'product/release/artifact.bin'),
    'changed\n',
  );
  fs.writeFileSync(
    path.join(fixture.root, 'product/release/added.bin'),
    'added\n',
  );
  assert.throws(
    () =>
      verifyReleaseArtifactRoot({
        root: fixture.root,
        expectedRoot: before.root,
        expectedFiles: [
          ...before.files,
          { path: 'removed.bin', bytes: 1, sha256: `sha256:${'0'.repeat(64)}` },
        ],
      }),
    /added=added\.bin; removed=removed\.bin; changed=artifact\.bin/u,
  );
});

test('rejects a missing KFD evidence file', () => {
  const root = fixture();
  fs.rmSync(
    path.join(
      root,
      `kungfu-linux-x64-${SOURCE_SHA}`,
      'product',
      'release',
      'qualification',
      'kfd',
      'artifacts',
      'linux-x64.json',
    ),
  );
  assert.throws(
    () =>
      verifyKfdCandidatePayloadSet({
        payloadRoot: root,
        sourceSha: SOURCE_SHA,
      }),
    /missing sealed KFD evidence/u,
  );
});

test('rejects tampered KFD evidence', () => {
  const root = fixture();
  fs.appendFileSync(
    path.join(
      root,
      `kungfu-macos-arm64-${SOURCE_SHA}`,
      'product',
      'release',
      'qualification',
      'kfd',
      'artifacts',
      'macos-arm64.json',
    ),
    'tampered\n',
  );
  assert.throws(
    () =>
      verifyKfdCandidatePayloadSet({
        payloadRoot: root,
        sourceSha: SOURCE_SHA,
      }),
    /tampered sealed KFD evidence/u,
  );
});

test('rejects an incomplete platform set', () => {
  const root = fixture();
  fs.rmSync(path.join(root, `kungfu-windows-x64-${SOURCE_SHA}`), {
    recursive: true,
    force: true,
  });
  assert.throws(
    () =>
      verifyKfdCandidatePayloadSet({
        payloadRoot: root,
        sourceSha: SOURCE_SHA,
      }),
    /platform set incomplete: missing windows-x64/u,
  );
});

test('rejects a candidate/source root mismatch', () => {
  const root = fixture();
  assert.throws(
    () =>
      verifyKfdCandidatePayloadSet({
        payloadRoot: root,
        sourceSha: 'c'.repeat(40),
      }),
    /candidate\/source root mismatch/u,
  );
});

test('manifest fan-in rejects a missing platform before promotion', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfd-manifest-test-'),
  );
  for (const platform of SUPPORTED_KFD_PLATFORMS.slice(0, -1)) {
    writeJson(path.join(root, platform, 'manifest.json'), {
      contract: 'kungfu-buildchain-artifact',
      platform: { id: platform },
      git: { sha: SOURCE_SHA },
      files: [
        `product/release/qualification/kfd/artifacts/${platform}.json`,
        `product/release/qualification/kfd/source/kfd-3/collaboration-interface.${platform}.prebuild.json`,
        'product/release/qualification/kfd/source-gate.json',
        'product/release/qualification/kfd/candidate-evidence.json',
      ].map((filePath) => ({ path: filePath, sha256: 'd'.repeat(64) })),
    });
  }
  assert.throws(
    () => verifyKfdManifestSet({ manifestRoot: root, sourceSha: SOURCE_SHA }),
    /platform set incomplete: missing windows-x64/u,
  );
});
