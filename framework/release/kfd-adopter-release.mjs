// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPOSITORY = 'kungfu-systems/kungfu';
const REQUIRED_DECISIONS = [
  'KFD-1',
  'KFD-2',
  'KFD-3',
  'KFD-4',
  'KFD-5',
  'KFD-7',
];
const MANIFEST_RELATIVE_PATH = '.buildchain/runtime/kfd-adopter/manifest.json';
const GATE_RELATIVE_PATH = '.buildchain/runtime/kfd-adopter/gate.json';
const WARRANT_RELATIVE_PATH =
  'framework/kfx/evidence/kfd-10/runtime-warrant-adopter.json';
const LEGACY_WARRANT_RELATIVE_PATH =
  'framework/agent-work/evidence/kfd-7/warrant-decay-revocation.json';

function requireExactKfd10WitnessDeclaration(
  support,
  evidencePaths,
  implementationStatus,
  witnessPath,
  label,
) {
  if (
    support?.implementation?.status !== implementationStatus ||
    support?.verification?.status !== 'non-conforming-evidence' ||
    evidencePaths.length !== 1 ||
    evidencePaths[0] !== witnessPath
  ) {
    throw new Error(`KFD-10 ${label} adopter witness declaration drifted`);
  }
  return witnessPath;
}

export function resolveKfd10AdopterWitnessPath(support) {
  const evidencePaths = (support?.verification?.evidenceRoots || []).map(
    (entry) => entry?.path,
  );
  const specialized =
    support?.implementation?.status === 'implemented-specialized-witness' ||
    evidencePaths.includes(WARRANT_RELATIVE_PATH);
  if (!specialized) {
    return requireExactKfd10WitnessDeclaration(
      support,
      evidencePaths,
      'partial',
      LEGACY_WARRANT_RELATIVE_PATH,
      'legacy',
    );
  }
  return requireExactKfd10WitnessDeclaration(
    support,
    evidencePaths,
    'implemented-specialized-witness',
    WARRANT_RELATIVE_PATH,
    'specialized',
  );
}

function fileRoot(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderJson(value));
}

function assertCurrentIfPresent(filePath, value, label) {
  if (
    fs.existsSync(filePath) &&
    fs.readFileSync(filePath, 'utf8') !== renderJson(value)
  ) {
    throw new Error(
      `${label} is stale: ${path.relative(process.cwd(), filePath)}`,
    );
  }
}

function evidence(
  root,
  sourcePath,
  sourceSha,
  checkedAt,
  packageArtifactRoot,
  kind,
  evidenceRoot,
) {
  return {
    kind,
    coordinate: `git+https://github.com/${REPOSITORY}@${sourceSha}#${sourcePath}`,
    root: evidenceRoot || fileRoot(path.join(root, sourcePath)),
    observedAt: checkedAt,
    kfdPackageRoot: packageArtifactRoot,
  };
}

export function syncKfdAdopterRelease(
  root,
  runtime,
  sourceSha,
  checkedAt,
  productGates,
  write,
) {
  const supportMatrixPath = path.join(
    root,
    '.buildchain/kfd/support-matrix.json',
  );
  const rows = new Map(
    (readJson(supportMatrixPath).rows || []).map((row) => [row.id, row]),
  );
  const kfd10WitnessPath = resolveKfd10AdopterWitnessPath(rows.get('KFD-10'));
  const sourcePaths = kfd10WitnessPath ? [kfd10WitnessPath] : [];
  for (const id of REQUIRED_DECISIONS) {
    const row = rows.get(id);
    const implementationPath = row?.implementation?.surfaces?.[0];
    const verificationPath = row?.verification?.evidenceRoots?.[0]?.path;
    if (!implementationPath || !verificationPath) {
      throw new Error(
        `${id} lacks implementation or verification evidence for the adopter manifest`,
      );
    }
    sourcePaths.push(implementationPath, verificationPath);
  }
  const files = [...new Set(sourcePaths)].sort().map((sourcePath) => ({
    path: sourcePath,
    sha256: fileRoot(path.join(root, sourcePath)),
  }));
  const packageArtifactRoot = runtime.adopter.installedKfdPackageArtifactRoot();
  const sourceRoot = runtime.productGates.kfdProductGateDigest({
    repository: REPOSITORY,
    sourceSha,
    files,
  });
  let manifest = runtime.adopter.initAdopterManifest({
    manifestId: `${REPOSITORY}:full-cut`,
    adopterId: REPOSITORY,
    artifactKind: 'git-commit',
    artifactCoordinate: `${REPOSITORY}@${sourceSha}`,
    artifactRoot: sourceRoot,
    scope: 'Kungfu release and protected delivery authority',
    packageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds: 86400,
  });
  const gateById = new Map(
    productGates.gates.map((gate) => [gate.standard.toUpperCase(), gate]),
  );
  for (const id of REQUIRED_DECISIONS) {
    const declaration = manifest.decisions.find((row) => row.id === id);
    const support = rows.get(id);
    const implementationPath = support.implementation.surfaces[0];
    const verificationPath = support.verification.evidenceRoots[0].path;
    declaration.state = 'candidate';
    declaration.usage = 'used';
    declaration.implementationEvidence = [
      evidence(
        root,
        implementationPath,
        sourceSha,
        checkedAt,
        packageArtifactRoot,
        'implementation',
      ),
    ];
    declaration.verificationEvidence = [
      evidence(
        root,
        verificationPath,
        sourceSha,
        checkedAt,
        packageArtifactRoot,
        'verification',
        gateById.get(id)?.gateRoot,
      ),
    ];
    declaration.gaps = [
      'Independent decision-specific assessment and certification remain external.',
    ];
  }
  const kfd6 = manifest.decisions.find((row) => row.id === 'KFD-6');
  kfd6.state = 'unsupported';
  kfd6.usage = 'unused';
  kfd6.gaps = ['Kungfu does not claim KFD-6 support in this cut.'];
  if (kfd10WitnessPath) {
    manifest = runtime.adopter.addAdopterWitness(manifest, {
      decisionId: 'KFD-10',
      profileId: 'kfd-warrant-evidence',
      witnessCoordinate: `git+https://github.com/${REPOSITORY}@${sourceSha}#${kfd10WitnessPath}`,
      witnessRoot: fileRoot(path.join(root, kfd10WitnessPath)),
      packageArtifactRoot,
      verifiedAt: checkedAt,
      maxAgeSeconds: 86400,
    });
  }
  const manifestGate = runtime.adopter.createKfdAdopterManifestGate({
    manifest,
    packageArtifactRoot,
    gateResults: productGates.gates,
    authorityPath: MANIFEST_RELATIVE_PATH,
    expectedAdopterId: REPOSITORY,
    expectedSourceRepository: REPOSITORY,
    expectedSourceSha: sourceSha,
    checkedAt,
  });
  const validation = runtime.adopter.validateKfdAdopterManifestGate(
    manifestGate,
    {
      expectedAdopterId: REPOSITORY,
      expectedSourceRepository: REPOSITORY,
      expectedSourceSha: sourceSha,
      checkedAt,
    },
  );
  if (!validation.valid) {
    throw new Error(
      `generated KFD adopter manifest gate failed: ${JSON.stringify(validation.issues)}`,
    );
  }
  const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);
  const gatePath = path.join(root, GATE_RELATIVE_PATH);
  if (write) {
    writeJson(manifestPath, manifest);
    writeJson(gatePath, manifestGate);
  } else {
    assertCurrentIfPresent(
      manifestPath,
      manifest,
      'Buildchain KFD adopter manifest',
    );
    assertCurrentIfPresent(
      gatePath,
      manifestGate,
      'Buildchain KFD adopter manifest gate',
    );
  }
}
