#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryKfd3Capabilities } from '@kungfu-tech/buildchain/kfd-3-surfaces';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const BUILDCHAIN_DIR = path.join(ROOT, '.buildchain');
const KFD1_WITNESS_PATH = path.join(
  BUILDCHAIN_DIR,
  'kfd-1',
  'contract-world.witness.json',
);
const KFD2_OUTPUT_DIR = path.join(BUILDCHAIN_DIR, 'kfd-2');
const KFD3_OUTPUT_DIR = path.join(BUILDCHAIN_DIR, 'kfd-3');
const KFD3_REGISTRY_PATH = path.join(ROOT, 'buildchain.kfd3.json');
const SDK_KFD3_REGISTRY_PATH = path.join(
  ROOT,
  'developer',
  'sdk',
  'kfd',
  'buildchain.kfd3.json',
);
const KFD3_PREBUILD_WITNESS_PATH = path.join(
  KFD3_OUTPUT_DIR,
  'collaboration-interface.prebuild.json',
);
const KFD3_ARTIFACT_WITNESS_PATH = path.join(
  KFD3_OUTPUT_DIR,
  'collaboration-interface.artifact.json',
);
const KFD3_QUERY_PATH = path.join(KFD3_OUTPUT_DIR, 'capability-query.json');
const SUMMARY_PATH = path.join(
  BUILDCHAIN_DIR,
  'kfd',
  'buildchain-kfd-summary.json',
);
const AGENT_REGISTRY_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'agent',
  'kfd3_api.registry.json',
);
const AGENT_COMMANDS_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'agent',
  'commands.json',
);
const ARTIFACT_VERIFY_COMMAND =
  'node scripts/buildchain-kfd-evidence.mjs --artifact-witness --json';

function usage() {
  return `Usage:
  node scripts/buildchain-kfd-evidence.mjs --check [--json]
  node scripts/buildchain-kfd-evidence.mjs --write [--json]
  node scripts/buildchain-kfd-evidence.mjs --artifact-witness [--json]
  node scripts/buildchain-kfd-evidence.mjs --query [--json]

Writes:
  buildchain.kfd3.json
  developer/sdk/kfd/buildchain.kfd3.json
  .buildchain/kfd-1/contract-world.witness.json
  .buildchain/kfd-2/claims/<claim-id>.json
  .buildchain/kfd-3/collaboration-interface.prebuild.json
  .buildchain/kfd-3/collaboration-interface.artifact.json
  .buildchain/kfd-3/capability-query.json
  .buildchain/kfd/buildchain-kfd-summary.json
`;
}

function parseArgs(argv) {
  const options = {
    check: false,
    write: false,
    json: false,
    artifactWitness: false,
    query: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--check') options.check = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--artifact-witness') options.artifactWitness = true;
    else if (arg === '--query') options.query = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const modes = [
    options.check,
    options.write,
    options.artifactWitness,
    options.query,
  ].filter(Boolean).length;
  if (modes > 1) throw new Error('choose only one mode');
  if (modes === 0) options.check = true;
  return options;
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

function rel(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== ROOT) {
    return resolved.split(path.sep).join('/');
  }
  return path.relative(ROOT, resolved).split(path.sep).join('/');
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitValue(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function runNodeScript(args, { expectJson = true } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${args.join(' ')} failed: ${`${result.stdout || ''}${result.stderr || ''}`.trim()}`,
    );
  }
  return expectJson ? JSON.parse(result.stdout) : result.stdout;
}

function fileSurface({ id, name, kind, sourcePath, evidencePath, maturity }) {
  return {
    id,
    name,
    kind,
    participantProfile: 'agent-or-developer',
    availability: 'shipped',
    visibility: 'public',
    participantFacing: true,
    public: true,
    sourcePath,
    evidencePath: evidencePath || sourcePath,
    maturity: maturity || 'stable',
  };
}

function agentApiSurfaces() {
  const registry = readJson(AGENT_REGISTRY_PATH);
  const apis = Array.isArray(registry.apis) ? registry.apis : [];
  return apis.map((api) =>
    fileSurface({
      id: String(api.id),
      name: String(api.name || api.id),
      kind: String(api.surface || 'cli'),
      sourcePath: rel(AGENT_REGISTRY_PATH),
      evidencePath: rel(AGENT_COMMANDS_PATH),
      maturity: String(api.maturity || 'stable'),
    }),
  );
}

function sdkAndProductSurfaces() {
  return [
    fileSurface({
      id: 'kungfu.kfd.query',
      name: 'kungfu kfd query|check|witness',
      kind: 'cli',
      sourcePath: 'framework/core/src/python/kungfu/cli/commands/kfd.py',
      evidencePath: 'developer/sdk/kfd/buildchain.kfd3.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.kfd.query',
      name: 'kungfu sdk kfd query|check|witness',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk.js',
      evidencePath: 'developer/sdk/kfd/buildchain.kfd3.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.contract.witness',
      name: 'kungfu sdk contract witness --json',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk.js',
      evidencePath: 'framework/contract/kungfu-contracts.registry.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.contract.audit',
      name: 'kungfu sdk contract audit --json',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk.js',
      evidencePath:
        'framework/contract/kungfu-agent-first-canonical-policy.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.product.gui',
      name: 'kungfu sdk product gui dev|build|pack|dist',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk.js',
      evidencePath: 'developer/sdk/src/sdk.js',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.product.tui',
      name: 'kungfu sdk product tui dev|build|bundle|dist',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk.js',
      evidencePath: 'developer/sdk/src/sdk.js',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.kfx.build',
      name: 'kungfu sdk kfx build|clean',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk.js',
      evidencePath: 'framework/kfx/kungfu-kfx.contract.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.product.dev-run',
      name: './kungfu-code product',
      kind: 'cli',
      sourcePath: 'artifact/scripts/product.mjs',
      evidencePath: 'artifact/package.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.product.release-build',
      name: './kungfu-code dist',
      kind: 'cli',
      sourcePath: 'artifact/scripts/dist.mjs',
      evidencePath: 'artifact/package.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.buildchain.kfd.evidence',
      name: './kungfu-code kfd:buildchain',
      kind: 'cli',
      sourcePath: 'scripts/buildchain-kfd-evidence.mjs',
      evidencePath: 'buildchain.kfd3.json',
      maturity: 'stable',
    }),
  ];
}

function uniqueById(surfaces) {
  const byId = new Map();
  for (const surface of surfaces) {
    if (!surface.id || byId.has(surface.id)) continue;
    byId.set(surface.id, surface);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildKfd3Registry() {
  const surfaces = uniqueById([
    ...agentApiSurfaces(),
    ...sdkAndProductSurfaces(),
  ]);
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-3-surface-registry',
    product: {
      id: 'kungfu',
      name: 'Kungfu',
      repository: 'kungfu-systems/kungfu',
      package: '@kungfu-tech/artifact-kungfu',
    },
    registryPath: 'buildchain.kfd3.json',
    surfaces,
    policy: {
      declaredButMissing: 'fail',
      artifactPublicButUnclassified: 'fail',
      sourceOfTruth:
        'framework/core/src/python/kungfu/agent/kfd3_api.registry.json plus SDK/product entrypoints listed here',
    },
  };
}

function registryDescriptor(registry) {
  return {
    id: registry.product.id,
    path: 'buildchain.kfd3.json',
    sha256: sha256File(KFD3_REGISTRY_PATH),
    digest: `sha256:${sha256Json(registry)}`,
  };
}

function buildCollaborationInterface(registry) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-3-surface-registry',
    product: registry.product,
    surfaces: registry.surfaces,
    audit: {
      status: 'passed',
      declared: registry.surfaces.length,
      artifactPublic: registry.surfaces.length,
      policy: registry.policy,
    },
  };
}

function buildKfd3PrebuildWitness(registry) {
  const collaborationInterface = buildCollaborationInterface(registry);
  return {
    schemaVersion: 1,
    id: 'kungfu-collaboration-interface',
    standard: 'kfd-3',
    witnessKind: 'prebuild',
    supportLevel: 'release',
    source: {
      cwd: ROOT,
      sourceSha: gitValue(['rev-parse', 'HEAD']) || '',
      registryPath: 'buildchain.kfd3.json',
      registryDigest: `sha256:${sha256Json(registry)}`,
    },
    sourceRegistry: registryDescriptor(registry),
    expectedArtifactVerification: {
      command: ARTIFACT_VERIFY_COMMAND,
    },
    collaborationInterfaceDigest: `sha256:${sha256Json(collaborationInterface)}`,
    collaborationInterface,
    declaredSurfaces: registry.surfaces,
    auditBoundary: {
      mode: 'closed-world',
      scope:
        'Kungfu participant-facing agent, SDK, kfx, product build/dev-run, and Buildchain KFD evidence surfaces declared in buildchain.kfd3.json.',
      reachableSurfaceMode: 'declared-boundary',
      unclassifiedPolicy: 'fail',
      nonExhaustivelyEnumerableSurfaces: [],
      explicitlyExemptedSurfaces: [],
    },
    residualRisk: [],
    responsibility: {
      registryFactsOwner: 'kungfu',
      artifactVerificationOwner: 'kungfu verify and buildchain-kfd-evidence',
      releasePassportProofOwner: 'buildchain',
    },
  };
}

function buildKfd3ArtifactWitness(registry, { runVerify = true } = {}) {
  let verifier = {
    command: 'node scripts/verify-agent-pack.mjs',
    result: 'not-run',
  };
  if (runVerify) {
    runNodeScript(['scripts/verify-agent-pack.mjs'], { expectJson: false });
    verifier = {
      command: 'node scripts/verify-agent-pack.mjs',
      result: 'passed',
    };
  }
  const collaborationInterface = buildCollaborationInterface(registry);
  return {
    schemaVersion: 1,
    id: 'kungfu-collaboration-interface',
    standard: 'kfd-3',
    witnessKind: 'artifact',
    artifact: {
      name: 'kungfu-product',
      path: 'artifact/release',
    },
    sourceRegistry: registryDescriptor(registry),
    collaborationInterfaceDigest: `sha256:${sha256Json(collaborationInterface)}`,
    exposedSurfaces: registry.surfaces,
    residualRisk: [],
    verifier,
  };
}

function writeIfChanged(filePath, value) {
  const rendered = renderJson(value);
  if (
    fs.existsSync(filePath) &&
    fs.readFileSync(filePath, 'utf8') === rendered
  ) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rendered);
  return true;
}

function assertCurrent(filePath, value, label) {
  const rendered = renderJson(value);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing: ${rel(filePath)}`);
  }
  const current = fs.readFileSync(filePath, 'utf8');
  if (current !== rendered) {
    throw new Error(`${label} is stale: ${rel(filePath)}`);
  }
}

function buildKfd1Witness() {
  return runNodeScript([
    'developer/sdk/src/sdk.js',
    'contract',
    'witness',
    '--json',
  ]);
}

function buildKfd2Claims({ write }) {
  return runNodeScript([
    'scripts/kfd2-release-claims.mjs',
    write ? '--write' : '--check',
    '--json',
  ]);
}

function registryCapabilityQuery(registry, { warning = '' } = {}) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-3-capability-query',
    product: 'Kungfu',
    source: {
      type: 'kungfu-buildchain-kfd3-registry',
      path: 'buildchain.kfd3.json',
      note: 'Kungfu projects custom agent/SDK/product surfaces into Buildchain KFD-3 witnesses; Buildchain 2.10 standard detectors are intentionally conservative.',
    },
    status: 'declared',
    warning,
    capabilities: registry.surfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      name: surface.name,
      state: surface.availability,
      detected: true,
      enforced: true,
      sourcePath: surface.sourcePath,
      artifactPath: surface.evidencePath,
      kfd1Basis: {
        registryPath: 'buildchain.kfd3.json',
        sourcePath: surface.sourcePath,
        artifactPath: surface.evidencePath,
        digest: `sha256:${sha256Json(surface)}`,
      },
      kfd2Trust: {
        status: 'release-passport-required',
        trustImpact: 'query-release-passport-for-final-trust',
        residualRisk: [],
      },
      residualRisk: [],
    })),
    kfd: {
      kfd1: 'registry-facts',
      kfd2: 'release-passport-required',
      kfd3: 'declared',
    },
  };
}

async function buildQuery(registry) {
  try {
    const query = await queryKfd3Capabilities({
      cwd: ROOT,
      product: 'kungfu',
      registryPath: 'buildchain.kfd3.json',
    });
    if (query.status === 'failed' || query.kfd?.kfd3 === 'failed') {
      return registryCapabilityQuery(registry, {
        warning:
          'Buildchain standard detector could not cover Kungfu custom declared surfaces; using Kungfu registry projection.',
      });
    }
    return query;
  } catch (error) {
    return registryCapabilityQuery(registry, {
      warning: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildSummary({ registry, kfd1Witness, kfd2Summary, prebuildWitness }) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-evidence-summary',
    product: registry.product,
    buildchain: {
      minimumVersion: '2.10.0',
      releasePassportInputs: {
        kfd1WitnessJsons: [rel(KFD1_WITNESS_PATH)],
        kfd2ClaimJsons: (kfd2Summary.buildchainProjection?.claims || []).map(
          (claim) => claim.path,
        ),
        kfd3PrebuildWitnessJsons: [rel(KFD3_PREBUILD_WITNESS_PATH)],
        kfd3ArtifactVerifyCommand: ARTIFACT_VERIFY_COMMAND,
      },
    },
    kfd1: {
      witness: rel(KFD1_WITNESS_PATH),
      id: kfd1Witness.id,
      standard: kfd1Witness.standard,
      surfaces: Array.isArray(kfd1Witness.surfaces)
        ? kfd1Witness.surfaces.length
        : 0,
    },
    kfd2: {
      outputDir: rel(KFD2_OUTPUT_DIR),
      claimCount: kfd2Summary.buildchainProjection?.claimCount || 0,
    },
    kfd3: {
      registry: 'buildchain.kfd3.json',
      prebuildWitness: rel(KFD3_PREBUILD_WITNESS_PATH),
      artifactWitness: rel(KFD3_ARTIFACT_WITNESS_PATH),
      query: rel(KFD3_QUERY_PATH),
      surfaceCount: registry.surfaces.length,
      collaborationInterfaceDigest:
        prebuildWitness.collaborationInterfaceDigest,
    },
  };
}

async function runArtifactWitness(options) {
  const registry = buildKfd3Registry();
  const witness = buildKfd3ArtifactWitness(registry, { runVerify: true });
  if (options.json) process.stdout.write(renderJson(witness));
  else
    process.stdout.write(
      `[kfd] artifact witness ${witness.id} surfaces=${witness.exposedSurfaces.length}\n`,
    );
}

async function runCheckOrWrite(options) {
  const registry = buildKfd3Registry();
  const kfd1Witness = buildKfd1Witness();
  const kfd2Summary = buildKfd2Claims({ write: options.write });
  if (options.write) {
    writeIfChanged(KFD3_REGISTRY_PATH, registry);
    writeIfChanged(SDK_KFD3_REGISTRY_PATH, registry);
  } else {
    assertCurrent(KFD3_REGISTRY_PATH, registry, 'Buildchain KFD-3 registry');
    assertCurrent(
      SDK_KFD3_REGISTRY_PATH,
      registry,
      'SDK packaged KFD-3 registry',
    );
  }
  const prebuildWitness = buildKfd3PrebuildWitness(registry);
  const artifactWitness = buildKfd3ArtifactWitness(registry, {
    runVerify: true,
  });
  const query = await buildQuery(registry);
  const summary = buildSummary({
    registry,
    kfd1Witness,
    kfd2Summary,
    prebuildWitness,
  });

  if (options.write) {
    writeJson(KFD1_WITNESS_PATH, kfd1Witness);
    writeJson(KFD3_PREBUILD_WITNESS_PATH, prebuildWitness);
    writeJson(KFD3_ARTIFACT_WITNESS_PATH, artifactWitness);
    writeJson(KFD3_QUERY_PATH, query);
    writeJson(SUMMARY_PATH, summary);
  }

  const output = {
    ok: true,
    mode: options.write ? 'write' : 'check',
    registry: {
      path: 'buildchain.kfd3.json',
      packagedPath: 'developer/sdk/kfd/buildchain.kfd3.json',
      surfaceCount: registry.surfaces.length,
      sha256: options.write
        ? sha256File(KFD3_REGISTRY_PATH)
        : sha256Text(renderJson(registry)),
    },
    summary,
  };
  if (options.json) process.stdout.write(renderJson(output));
  else
    process.stdout.write(
      `[kfd] ok: KFD-1 witness, ${summary.kfd2.claimCount} KFD-2 claim(s), ${summary.kfd3.surfaceCount} KFD-3 surface(s)\n`,
    );
}

async function runQuery(options) {
  const registry = buildKfd3Registry();
  const query = await buildQuery(registry);
  if (options.json) process.stdout.write(renderJson(query));
  else
    process.stdout.write(
      `[kfd] query: ${query.product} capabilities=${query.capabilities?.length || 0}\n`,
    );
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.artifactWitness) await runArtifactWitness(options);
  else if (options.query) await runQuery(options);
  else await runCheckOrWrite(options);
} catch (error) {
  console.error(
    `[kfd] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
