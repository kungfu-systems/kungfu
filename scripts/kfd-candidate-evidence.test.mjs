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
  kfdPlatformId,
  prepareKfdArtifactWitness,
  releaseArtifactRoot,
  runVerifiedQualification,
  verifyKfdCandidatePayloadSet,
  verifyKfdManifestSet,
} from '../framework/release/kfd-candidate-evidence.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const SOURCE_TREE = 'b'.repeat(40);

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

test('derives every supported Buildchain platform from the native host tuple', () => {
  assert.equal(kfdPlatformId('linux', 'x64'), 'linux-x64');
  assert.equal(kfdPlatformId('linux', 'arm64'), 'linux-arm64');
  assert.equal(kfdPlatformId('darwin', 'arm64'), 'macos-arm64');
  assert.equal(kfdPlatformId('win32', 'x64'), 'windows-x64');
  assert.equal(kfdPlatformId('darwin', 'x64'), '');
});

test('seals an artifact witness and candidate capsule in two phases', () => {
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

test('the Verify wrapper seals final artifacts after qualification cleanup', () => {
  const fixture = artifactFixture();
  const qualification = path.join(
    fixture.root,
    'product',
    'release',
    'qualification',
  );
  const finalArtifact = path.join(
    fixture.root,
    'product',
    'release',
    'artifact-after-qualification.bin',
  );
  const command = [
    process.execPath,
    '-e',
    `const fs=require('node:fs');fs.rmSync(${JSON.stringify(qualification)},{recursive:true,force:true});fs.mkdirSync(${JSON.stringify(qualification)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(qualification, 'qualification-passed.json'))},'{}\\n');fs.writeFileSync(${JSON.stringify(finalArtifact)},'final artifact\\n')`,
  ];
  assert.equal(
    runVerifiedQualification({
      ...fixture,
      command,
      buildArtifactWitness: () => {
        assert.equal(fs.existsSync(finalArtifact), true);
        return {
          id: 'kungfu-collaboration-interface',
          standard: 'kfd-3',
          witnessKind: 'artifact',
          exposedSurfaces: [],
        };
      },
    }),
    0,
  );
  assert.equal(
    fs.existsSync(path.join(qualification, 'qualification-passed.json')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(qualification, 'kfd', 'candidate-evidence.json')),
    true,
  );
  const witness = JSON.parse(
    fs.readFileSync(
      path.join(qualification, 'kfd', 'artifacts', `${fixture.platform}.json`),
      'utf8',
    ),
  );
  assert.equal(
    witness.candidateBinding.artifactRoot,
    releaseArtifactRoot(fixture.root).root,
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
    /KFD artifact digest mismatch/u,
  );
});

test('rejects a source gate sealed for another platform', () => {
  const fixture = artifactFixture();
  const sourceGate = path.join(
    fixture.root,
    '.buildchain',
    'runtime',
    'kfd-candidate-evidence',
    'source-gate.json',
  );
  const gate = JSON.parse(fs.readFileSync(sourceGate, 'utf8'));
  gate.platform = 'linux-arm64';
  writeJson(sourceGate, gate);
  assert.throws(
    () => prepareKfdArtifactWitness(fixture),
    /KFD source gate platform mismatch: expected linux-x64, got linux-arm64/u,
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
