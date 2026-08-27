// SPDX-License-Identifier: Apache-2.0
// @ts-check
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KFD_CANDIDATE_EVIDENCE_CONTRACT =
  'kungfu.kfd-candidate-evidence/v1';
export const KFD_SOURCE_GATE_CONTRACT = 'kungfu.kfd-source-gate/v1';
export const KFD_SOURCE_WITNESS_BINDING_CONTRACT =
  'kungfu.kfd-source-witness-binding/v1';
export const KFD_ARTIFACT_WITNESS_CONTRACT =
  'kungfu.kfd-artifact-witness-binding/v1';
export const SUPPORTED_KFD_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'macos-arm64',
  'windows-x64',
];
export const KFD_ARTIFACT_WITNESS_JSONS = SUPPORTED_KFD_PLATFORMS.map(
  (platform) => `product/release/qualification/kfd/artifacts/${platform}.json`,
);

const SOURCE_GATE_INPUTS = [
  '.buildchain/kfd/kfd-1/contract-world.witness.json',
  '.buildchain/kfd/kfd-1/documentation-pack.witness.json',
  '.buildchain/kfd/kfd-2/claims/agent-onboarding-pack.json',
  '.buildchain/kfd/kfd-2/claims/remote-fact-boundary.json',
  '.buildchain/kfd/kfd-2/claims/agent-work-state-contract.json',
  '.buildchain/kfd/kfd-2/claims/cross-language-authority-membrane.json',
  '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
  '.buildchain/kfd/support-matrix.json',
];

const GENERATED_SOURCE_FILES = [
  [
    '.buildchain/kfd/kfd-1/contract-world.witness.json',
    'kfd-1/contract-world.witness.json',
  ],
  [
    '.buildchain/kfd/kfd-1/documentation-pack.witness.json',
    'kfd-1/documentation-pack.witness.json',
  ],
  [
    '.buildchain/kfd/kfd-2/claims/agent-onboarding-pack.json',
    'kfd-2/claims/agent-onboarding-pack.json',
  ],
  [
    '.buildchain/kfd/kfd-2/claims/remote-fact-boundary.json',
    'kfd-2/claims/remote-fact-boundary.json',
  ],
  [
    '.buildchain/kfd/kfd-2/claims/agent-work-state-contract.json',
    'kfd-2/claims/agent-work-state-contract.json',
  ],
  [
    '.buildchain/kfd/kfd-2/claims/cross-language-authority-membrane.json',
    'kfd-2/claims/cross-language-authority-membrane.json',
  ],
  [
    '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
    'kfd-3/collaboration-interface.prebuild.json',
  ],
  [
    '.buildchain/runtime/kfd-adopter/manifest.json',
    'kfd-adopter/manifest.json',
  ],
  [
    '.buildchain/runtime/kfd-product-gates/kfd-4/gate.json',
    'kfd-product-gates/kfd-4/gate.json',
  ],
  [
    '.buildchain/runtime/kfd-product-gates/kfd-5/gate.json',
    'kfd-product-gates/kfd-5/gate.json',
  ],
  [
    '.buildchain/runtime/kfd-product-gates/kfd-7/gate.json',
    'kfd-product-gates/kfd-7/gate.json',
  ],
];

const GENERATOR_OWNED_PATHS = [
  '.buildchain/kfd',
  '.buildchain/runtime/kfd-adopter',
  '.buildchain/runtime/kfd-product-gates',
  'developer/sdk/kfd',
];

const GITHUB_RUNNER_PLATFORMS = new Map([
  ['Linux:X64', 'linux-x64'],
  ['Linux:ARM64', 'linux-arm64'],
  ['macOS:ARM64', 'macos-arm64'],
  ['Windows:X64', 'windows-x64'],
]);

export function resolveKfdSourcePlatform(env = process.env) {
  const explicit = env.BUILDCHAIN_PLATFORM_ID || env['INPUT_PLATFORM-ID'];
  if (explicit) return explicit;
  const runnerOs = env.RUNNER_OS || '';
  const runnerArch = env.RUNNER_ARCH || '';
  if (!runnerOs && !runnerArch) return '';
  const platform = GITHUB_RUNNER_PLATFORMS.get(`${runnerOs}:${runnerArch}`);
  if (!platform) {
    throw new Error(
      `unsupported KFD source runner platform: ${runnerOs || '<empty>'}/${runnerArch || '<empty>'}`,
    );
  }
  return platform;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function rooted(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

export function kfdEvidenceRoot(value) {
  return rooted(value);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function gitValue(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${`${result.stdout || ''}${result.stderr || ''}`.trim()}`,
    );
  }
  return result.stdout.trim();
}

function resolveIdentity(root, sourceSha = '', sourceTree = '') {
  const head = gitValue(root, ['rev-parse', 'HEAD']);
  const tree = gitValue(root, ['rev-parse', 'HEAD^{tree}']);
  const resolvedSha = sourceSha || process.env.BUILDCHAIN_SOURCE_SHA || head;
  const resolvedTree =
    sourceTree || process.env.BUILDCHAIN_SOURCE_TREE_SHA || tree;
  if (resolvedSha !== head) {
    throw new Error(
      `candidate source root mismatch: expected ${resolvedSha}, checkout is ${head}`,
    );
  }
  if (resolvedTree !== tree) {
    throw new Error(
      `candidate source tree mismatch: expected ${resolvedTree}, checkout is ${tree}`,
    );
  }
  return { sourceSha: resolvedSha, sourceTree: resolvedTree };
}

function fileRows(root, relativePaths) {
  return relativePaths.map((relative) => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`missing KFD source evidence: ${relative}`);
    }
    return {
      path: toPosix(relative),
      bytes: fs.statSync(absolute).size,
      sha256: `sha256:${sha256File(absolute)}`,
    };
  });
}

export function createKfdPrebuildGate({
  root = process.cwd(),
  sourceSha = '',
  sourceTree = '',
} = {}) {
  const identity = resolveIdentity(root, sourceSha, sourceTree);
  const inputs = fileRows(root, SOURCE_GATE_INPUTS);
  const body = {
    schema: KFD_SOURCE_GATE_CONTRACT,
    status: 'passed',
    phase: 'prebuild',
    candidate: identity,
    inputs,
    inputRoot: rooted(inputs),
  };
  return { ...body, gateRoot: rooted(body) };
}

function snapshotPaths(root, relativePaths) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfd-source-snapshot-'),
  );
  const entries = relativePaths.map((relative, index) => {
    const source = path.join(root, relative);
    const target = path.join(temporary, String(index));
    const exists = fs.existsSync(source);
    if (exists)
      fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
    return { relative, target, exists };
  });
  return {
    restore() {
      for (const entry of entries) {
        const destination = path.join(root, entry.relative);
        fs.rmSync(destination, { recursive: true, force: true });
        if (entry.exists) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.cpSync(entry.target, destination, {
            recursive: true,
            preserveTimestamps: true,
          });
        }
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    },
  };
}

function runKfdGenerator(root, args, env = process.env) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'buildchain-kfd-evidence.mjs'), ...args],
    { cwd: root, env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `KFD evidence generator failed: ${`${result.stdout || ''}${result.stderr || ''}`.trim()}`,
    );
  }
  return result.stdout ? JSON.parse(result.stdout) : {};
}

export function sealKfdSourceEvidence({
  root = process.cwd(),
  outDir = path.join(root, '.buildchain', 'runtime', 'kfd-candidate-evidence'),
  expectedInputRoot = '',
  sourceSha = '',
  sourceTree = '',
  platform = resolveKfdSourcePlatform(),
} = {}) {
  if (platform) assertPlatform(platform);
  const prebuild = createKfdPrebuildGate({ root, sourceSha, sourceTree });
  if (expectedInputRoot && prebuild.inputRoot !== expectedInputRoot) {
    throw new Error(
      `KFD source input root mismatch: expected ${expectedInputRoot}, got ${prebuild.inputRoot}`,
    );
  }
  const snapshot = snapshotPaths(root, GENERATOR_OWNED_PATHS);
  const sourceDir = path.join(outDir, 'source');
  fs.rmSync(outDir, { recursive: true, force: true });
  try {
    runKfdGenerator(root, ['--write', '--json'], {
      ...process.env,
      BUILDCHAIN_SOURCE_SHA: prebuild.candidate.sourceSha,
      BUILDCHAIN_SOURCE_TREE_SHA: prebuild.candidate.sourceTree,
    });
    for (const [sourceRelative, targetRelative] of GENERATED_SOURCE_FILES) {
      const source = path.join(root, sourceRelative);
      if (!fs.existsSync(source)) {
        throw new Error(`generated KFD evidence is missing: ${sourceRelative}`);
      }
      const target = path.join(sourceDir, targetRelative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    if (platform) {
      const basePath = path.join(
        sourceDir,
        'kfd-3',
        'collaboration-interface.prebuild.json',
      );
      const platformWitness = readJson(basePath);
      platformWitness.id = `${platformWitness.id}-${platform}`;
      platformWitness.candidateBinding = {
        contract: KFD_SOURCE_WITNESS_BINDING_CONTRACT,
        phase: 'prebuild',
        platform,
        candidate: prebuild.candidate,
        prebuildGateRoot: prebuild.gateRoot,
      };
      writeJson(
        path.join(
          sourceDir,
          'kfd-3',
          `collaboration-interface.${platform}.prebuild.json`,
        ),
        platformWitness,
      );
    }
  } finally {
    snapshot.restore();
  }
  const generatedEvidence = listFiles(sourceDir, sourceDir);
  const body = {
    schema: KFD_SOURCE_GATE_CONTRACT,
    status: 'passed',
    phase: 'source-sealed',
    candidate: prebuild.candidate,
    ...(platform ? { platform } : {}),
    prebuildGateRoot: prebuild.gateRoot,
    sourceInputRoot: prebuild.inputRoot,
    generatedEvidence,
    evidenceRoot: rooted(generatedEvidence),
  };
  const gate = { ...body, gateRoot: rooted(body) };
  writeJson(path.join(outDir, 'source-gate.json'), gate);
  return gate;
}

function listFiles(directory, relativeRoot) {
  if (!fs.existsSync(directory)) return [];
  const rows = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        rows.push({
          path: toPosix(path.relative(relativeRoot, absolute)),
          bytes: fs.statSync(absolute).size,
          sha256: `sha256:${sha256File(absolute)}`,
        });
      }
    }
  };
  visit(directory);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

export function releaseArtifactRoot(root = process.cwd()) {
  const releaseDir = path.join(root, 'product', 'release');
  const rows = listFiles(releaseDir, releaseDir).filter(
    (row) =>
      row.path !== 'qualification' && !row.path.startsWith('qualification/'),
  );
  if (rows.length === 0)
    throw new Error('missing product/release artifact files');
  return { files: rows, root: rooted(rows) };
}

function assertPlatform(platform) {
  if (!SUPPORTED_KFD_PLATFORMS.includes(platform)) {
    throw new Error(
      `unsupported KFD candidate platform: ${platform || '<empty>'}`,
    );
  }
}

export function prepareKfdArtifactWitness({
  root = process.cwd(),
  platform = process.env.BUILDCHAIN_PLATFORM_ID || '',
  sourceSha = '',
  sourceTree = '',
  buildArtifactWitness = () =>
    runKfdGenerator(root, ['--artifact-witness', '--json']),
} = {}) {
  assertPlatform(platform);
  const identity = resolveIdentity(root, sourceSha, sourceTree);
  const runtimeDir = path.join(
    root,
    '.buildchain',
    'runtime',
    'kfd-candidate-evidence',
  );
  const sourceGatePath = path.join(runtimeDir, 'source-gate.json');
  if (!fs.existsSync(sourceGatePath))
    throw new Error('missing sealed KFD source gate');
  const sourceGate = readJson(sourceGatePath);
  if (
    sourceGate.status !== 'passed' ||
    sourceGate.platform !== platform ||
    sourceGate.candidate?.sourceSha !== identity.sourceSha ||
    sourceGate.candidate?.sourceTree !== identity.sourceTree
  ) {
    throw new Error('KFD source gate candidate/source root mismatch');
  }
  const artifact = releaseArtifactRoot(root);
  const baseWitness = buildArtifactWitness();
  const platformPrebuildPath = path.join(
    runtimeDir,
    'source',
    'kfd-3',
    `collaboration-interface.${platform}.prebuild.json`,
  );
  if (!fs.existsSync(platformPrebuildPath)) {
    throw new Error(`missing platform KFD prebuild witness: ${platform}`);
  }
  baseWitness.id = readJson(platformPrebuildPath).id;
  const bindingBody = {
    contract: KFD_ARTIFACT_WITNESS_CONTRACT,
    platform,
    candidate: identity,
    sourceGateRoot: sourceGate.gateRoot,
    artifactRoot: artifact.root,
  };
  const witness = {
    ...baseWitness,
    candidateBinding: { ...bindingBody, bindingRoot: rooted(bindingBody) },
  };
  const output = path.join(root, 'product', 'release', 'qualification', 'kfd');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(runtimeDir, 'source'), path.join(output, 'source'), {
    recursive: true,
  });
  fs.copyFileSync(sourceGatePath, path.join(output, 'source-gate.json'));
  const witnessPath = path.join(output, 'artifacts', `${platform}.json`);
  writeJson(witnessPath, witness);
  return witness;
}

export function finalizeKfdCandidateEvidence({
  root = process.cwd(),
  platform = process.env.BUILDCHAIN_PLATFORM_ID || '',
  sourceSha = '',
  sourceTree = '',
} = {}) {
  assertPlatform(platform);
  const identity = resolveIdentity(root, sourceSha, sourceTree);
  const output = path.join(root, 'product', 'release', 'qualification', 'kfd');
  const sourceGate = readJson(path.join(output, 'source-gate.json'));
  const witnessPath = path.join(output, 'artifacts', `${platform}.json`);
  if (!fs.existsSync(witnessPath))
    throw new Error(`missing KFD artifact witness: ${platform}`);
  const witness = readJson(witnessPath);
  const artifact = releaseArtifactRoot(root);
  if (witness.candidateBinding?.artifactRoot !== artifact.root) {
    throw new Error(
      `KFD artifact digest mismatch: expected ${witness.candidateBinding?.artifactRoot || '<empty>'}, got ${artifact.root}`,
    );
  }
  if (
    witness.candidateBinding?.candidate?.sourceSha !== identity.sourceSha ||
    witness.candidateBinding?.candidate?.sourceTree !== identity.sourceTree ||
    witness.candidateBinding?.sourceGateRoot !== sourceGate.gateRoot
  ) {
    throw new Error('KFD artifact witness candidate/source root mismatch');
  }
  const evidenceFiles = listFiles(output, output).filter(
    (row) => row.path !== 'candidate-evidence.json',
  );
  const body = {
    schema: KFD_CANDIDATE_EVIDENCE_CONTRACT,
    status: 'passed',
    candidate: identity,
    platform,
    supportedPlatforms: SUPPORTED_KFD_PLATFORMS,
    sourceGateRoot: sourceGate.gateRoot,
    artifactRoot: artifact.root,
    evidenceFiles,
    evidenceRoot: rooted(evidenceFiles),
  };
  const capsule = { ...body, capsuleRoot: rooted(body) };
  writeJson(path.join(output, 'candidate-evidence.json'), capsule);
  return capsule;
}

export function verifyKfdCandidatePayloadSet({
  payloadRoot,
  sourceSha,
  sourceTree = '',
  platforms = SUPPORTED_KFD_PLATFORMS,
} = {}) {
  if (!payloadRoot) throw new Error('payload root is required');
  const found = new Map();
  for (const file of findNamedFiles(payloadRoot, 'candidate-evidence.json')) {
    const capsule = readJson(file);
    if (capsule.schema !== KFD_CANDIDATE_EVIDENCE_CONTRACT) continue;
    if (found.has(capsule.platform)) {
      throw new Error(`duplicate KFD candidate platform: ${capsule.platform}`);
    }
    found.set(capsule.platform, { capsule, file });
  }
  const missing = platforms.filter((platform) => !found.has(platform));
  if (missing.length > 0) {
    throw new Error(
      `KFD candidate platform set incomplete: missing ${missing.join(', ')}`,
    );
  }
  for (const platform of platforms) {
    const { capsule, file } = found.get(platform);
    if (capsule.status !== 'passed')
      throw new Error(`KFD candidate ${platform} did not pass`);
    if (
      JSON.stringify(capsule.supportedPlatforms) !== JSON.stringify(platforms)
    ) {
      throw new Error(
        `KFD candidate platform contract mismatch on ${platform}`,
      );
    }
    if (capsule.candidate?.sourceSha !== sourceSha) {
      throw new Error(`KFD candidate/source root mismatch on ${platform}`);
    }
    if (sourceTree && capsule.candidate?.sourceTree !== sourceTree) {
      throw new Error(`KFD candidate/source tree mismatch on ${platform}`);
    }
    const { capsuleRoot, ...body } = capsule;
    if (capsuleRoot !== rooted(body)) {
      throw new Error(`KFD candidate capsule digest mismatch on ${platform}`);
    }
    if (capsule.evidenceRoot !== rooted(capsule.evidenceFiles || [])) {
      throw new Error(`KFD candidate evidence root mismatch on ${platform}`);
    }
    const evidenceRoot = path.dirname(file);
    for (const row of capsule.evidenceFiles || []) {
      const evidencePath = path.join(evidenceRoot, row.path);
      if (!fs.existsSync(evidencePath)) {
        throw new Error(
          `missing sealed KFD evidence on ${platform}: ${row.path}`,
        );
      }
      if (`sha256:${sha256File(evidencePath)}` !== row.sha256) {
        throw new Error(
          `tampered sealed KFD evidence on ${platform}: ${row.path}`,
        );
      }
    }
  }
  return { ok: true, sourceSha, platforms: [...platforms] };
}

function findNamedFiles(root, name) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === name) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

export function verifyKfdManifestSet({
  manifestRoot,
  sourceSha,
  platforms = SUPPORTED_KFD_PLATFORMS,
} = {}) {
  if (!manifestRoot) throw new Error('manifest root is required');
  const manifests = findNamedFiles(manifestRoot, 'manifest.json')
    .map(readJson)
    .filter((manifest) => manifest.contract === 'kungfu-buildchain-artifact');
  const byPlatform = new Map();
  for (const manifest of manifests) {
    const platform = manifest.platform?.id;
    if (byPlatform.has(platform)) {
      throw new Error(`duplicate KFD candidate platform manifest: ${platform}`);
    }
    byPlatform.set(platform, manifest);
  }
  const missing = platforms.filter((platform) => !byPlatform.has(platform));
  if (missing.length > 0) {
    throw new Error(
      `KFD candidate platform set incomplete: missing ${missing.join(', ')}`,
    );
  }
  for (const platform of platforms) {
    const manifest = byPlatform.get(platform);
    if (manifest.git?.sha !== sourceSha) {
      throw new Error(`KFD candidate/source root mismatch on ${platform}`);
    }
    const required = [
      `product/release/qualification/kfd/artifacts/${platform}.json`,
      `product/release/qualification/kfd/source/kfd-3/collaboration-interface.${platform}.prebuild.json`,
      'product/release/qualification/kfd/source-gate.json',
      'product/release/qualification/kfd/candidate-evidence.json',
    ];
    const files = new Map((manifest.files || []).map((row) => [row.path, row]));
    for (const requiredPath of required) {
      const row = files.get(requiredPath);
      if (!row)
        throw new Error(
          `missing sealed KFD manifest evidence on ${platform}: ${requiredPath}`,
        );
      if (!/^[a-f0-9]{64}$/u.test(String(row.sha256 || ''))) {
        throw new Error(
          `invalid sealed KFD manifest digest on ${platform}: ${requiredPath}`,
        );
      }
    }
  }
  return { ok: true, sourceSha, platforms: [...platforms] };
}

export function runVerifiedQualification({
  root,
  command,
  platform,
  sourceSha,
  sourceTree,
  buildArtifactWitness,
}) {
  prepareKfdArtifactWitness({
    root,
    platform,
    sourceSha,
    sourceTree,
    buildArtifactWitness,
  });
  const output = path.join(root, 'product', 'release', 'qualification', 'kfd');
  const sealed = path.join(
    root,
    '.buildchain',
    'runtime',
    'kfd-candidate-evidence',
    'artifact-before-verify',
  );
  fs.rmSync(sealed, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sealed), { recursive: true });
  fs.renameSync(output, sealed);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.renameSync(sealed, output);
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status || 1;
  finalizeKfdCandidateEvidence({ root, platform, sourceSha, sourceTree });
  return 0;
}
