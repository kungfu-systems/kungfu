#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KFD4_QUALIFICATION_PATH,
  loadKfd4PerspectiveQualification,
} from '../framework/core/tests/qualification/kfd4-perspective.mjs';
import {
  BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
  BUILDCHAIN_KFD1_RELEASE_GATE_PATH,
  BUILDCHAIN_KFD1_VERIFY_RESULT_PATH,
  BUILDCHAIN_KFD2_DIR,
  BUILDCHAIN_KFD2_REGISTRY_PATH,
  BUILDCHAIN_KFD3_DIR,
  KFD3_DEFAULT_REGISTRY_PATH,
  checkColdBuildchainKfd,
  gitValue,
  loadBuildchainKfdRuntime,
  loadSealedKfdUpstreamAggregate,
  releaseCandidateKfdRoot,
  renderKfdJson,
  resolveGitBoundKfdEvidenceSourceSha,
} from '../framework/release/buildchain-kfd-runtime.mjs';
import { syncKfdAdopterRelease } from '../framework/release/kfd-adopter-release.mjs';
import { prepareGateMeasurementHistory } from './prepare-gate-measurement-history.mjs';
import {
  assertKfdEvidenceSourceBinding,
  findGitTreeEquivalentAncestor,
  resolveKfdProductGateCheckedAt,
  selectKfdEvidenceSourceSha,
} from './source-acceptance.mjs';
let runtime;
const KFD3_SURFACE_REGISTRY_CONTRACT =
  'kungfu-buildchain-kfd-3-surface-registry';
const __filename = fileURLToPath(import.meta.url);
const ROOT = releaseCandidateKfdRoot({
  defaultRoot: path.resolve(path.dirname(__filename), '..'),
  receiptPath: process.env.BUILDCHAIN_RELEASE_CANDIDATE_RECOVERY_RECEIPT_PATH,
});
const BUILDCHAIN_DIR = path.join(ROOT, '.buildchain');
const KFD1_WITNESS_PATH = path.join(
  ROOT,
  BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
);
const KFD1_RELEASE_GATE_PATH = path.join(
  ROOT,
  BUILDCHAIN_KFD1_RELEASE_GATE_PATH,
);
const KFD1_VERIFY_RESULT_PATH = path.join(
  ROOT,
  BUILDCHAIN_KFD1_VERIFY_RESULT_PATH,
);
const KFD2_OUTPUT_DIR = path.join(ROOT, BUILDCHAIN_KFD2_DIR);
const KFD3_OUTPUT_DIR = path.join(ROOT, BUILDCHAIN_KFD3_DIR);
const KFD3_REGISTRY_PATH = path.join(ROOT, KFD3_DEFAULT_REGISTRY_PATH);
const SDK_KFD3_CANONICAL_REGISTRY_PATH = path.join(
  ROOT,
  'developer',
  'sdk',
  'kfd',
  'kfd-3-surfaces.json',
);
const SDK_KFD_UPSTREAM_AGGREGATE_PATH = path.join(
  ROOT,
  'developer',
  'sdk',
  'kfd',
  'upstream-aggregate.json',
);
const SDK_KFD1_OUTPUT_DIR = path.join(ROOT, 'developer', 'sdk', 'kfd', 'kfd-1');
const SDK_KFD1_WITNESS_PATH = path.join(
  SDK_KFD1_OUTPUT_DIR,
  'contract-world.witness.json',
);
const SDK_KFD1_RELEASE_GATE_PATH = path.join(
  SDK_KFD1_OUTPUT_DIR,
  'release-gate.json',
);
const SDK_KFD1_VERIFY_RESULT_PATH = path.join(
  SDK_KFD1_OUTPUT_DIR,
  'verify-result.json',
);
const SDK_KFD2_OUTPUT_DIR = path.join(ROOT, 'developer', 'sdk', 'kfd', 'kfd-2');
const KFD3_PREBUILD_WITNESS_PATH = path.join(
  KFD3_OUTPUT_DIR,
  'collaboration-interface.prebuild.json',
);
const KFD3_ARTIFACT_WITNESS_PATH = path.join(
  KFD3_OUTPUT_DIR,
  'collaboration-interface.artifact.json',
);
const KFD3_QUERY_PATH = path.join(KFD3_OUTPUT_DIR, 'capability-query.json');
const buildchainPath = (...parts) => path.join(BUILDCHAIN_DIR, ...parts);
const KFD_SUPPORT_MATRIX_PATH = buildchainPath('kfd', 'support-matrix.json');
const KFD_PRODUCT_GATE_RUNTIME_DIR = buildchainPath(
  'runtime',
  'kfd-product-gates',
);
const KFD_PRODUCT_GATE_STANDARDS = ['kfd-4', 'kfd-5', 'kfd-7'];
const KFD_PRODUCT_GATE_PATHS = KFD_PRODUCT_GATE_STANDARDS.map((standard) =>
  path.join(KFD_PRODUCT_GATE_RUNTIME_DIR, standard, 'gate.json'),
);
const KFD_PRODUCT_GATE_INPUT_PATHS = KFD_PRODUCT_GATE_STANDARDS.map(
  (standard) => path.join(KFD_PRODUCT_GATE_RUNTIME_DIR, standard, 'input.json'),
);
const KFD_SUPPORT_PROJECTION_PATH = path.join(
  KFD_PRODUCT_GATE_RUNTIME_DIR,
  'kfd-support.json',
);
const SUMMARY_PATH = buildchainPath('kfd', 'buildchain-kfd-summary.json');
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
const SHIFU_AGENT_REGISTRY_PATH = path.join(
  ROOT,
  'crates/shifu/agent/kfd3_api.registry.json',
);
const XINFA_AGENT_REGISTRY_PATH = path.join(
  ROOT,
  'crates/xinfa/agent/kfd3_api.registry.json',
);
const SDK_CLI_PATH = path.join(ROOT, 'developer', 'sdk', 'src', 'sdk.js');
const PRODUCT_PACKAGE_PATH = path.join(ROOT, 'product', 'package.json');
const RUNTIME_CLI_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'cli',
  'commands',
  'runtime.py',
);
const RUNTIME_SERVICE_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'runtime_service.py',
);
const CONTRACT_REGISTRY_PATH = path.join(
  ROOT,
  'framework',
  'contract',
  'kungfu-contracts.registry.json',
);
const KFD2_REGISTRY_PATH = path.join(ROOT, BUILDCHAIN_KFD2_REGISTRY_PATH);
const CORE_PACKAGE_PATH = path.join(ROOT, 'framework', 'core', 'package.json');
const ARTIFACT_VERIFY_COMMAND =
  'node scripts/buildchain-kfd-evidence.mjs --write --json >/dev/null && node scripts/buildchain-kfd-evidence.mjs --artifact-witness --json';
const STRICT_KFD3_MODE = 'strict-buildchain-managed-registry';
function usage() {
  return `Usage:
  node scripts/buildchain-kfd-evidence.mjs --check [--json]
  node scripts/buildchain-kfd-evidence.mjs --write [--json]
  node scripts/buildchain-kfd-evidence.mjs --artifact-witness [--json]
  node scripts/buildchain-kfd-evidence.mjs --query [--json]

Writes:
  .buildchain/kfd/kfd-3/surfaces.json
  developer/sdk/kfd/kfd-3-surfaces.json
  developer/sdk/kfd/upstream-aggregate.json
  .buildchain/kfd/kfd-1/contract-world.witness.json
  .buildchain/kfd/kfd-1/release-gate.json
  .buildchain/kfd/kfd-1/verify-result.json
  .buildchain/kfd/kfd-2/claims/<claim-id>.json
  .buildchain/kfd/kfd-2/release-claims.json
  developer/sdk/kfd/kfd-1/contract-world.witness.json
  developer/sdk/kfd/kfd-1/release-gate.json
  developer/sdk/kfd/kfd-1/verify-result.json
  developer/sdk/kfd/kfd-2/release-claims.json
  developer/sdk/kfd/kfd-2/claims/<claim-id>.json
  .buildchain/kfd/kfd-3/collaboration-interface.prebuild.json
  .buildchain/kfd/kfd-3/collaboration-interface.artifact.json
  .buildchain/kfd/kfd-3/capability-query.json
  .buildchain/kfd/buildchain-kfd-summary.json
  .buildchain/runtime/kfd-product-gates/kfd-{4,5,7}/gate.json
  .buildchain/runtime/kfd-product-gates/kfd-support.json
  .buildchain/runtime/kfd-adopter/{manifest,gate}.json
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
function productDisplayName() {
  const pkg = readJson(PRODUCT_PACKAGE_PATH);
  return String(pkg.kungfuProduct?.displayName || 'Kungfu');
}
function productIdentity() {
  return {
    id: 'kungfu',
    name: productDisplayName(),
    repository: 'kungfu-systems/kungfu',
  };
}
function renderJson(value) {
  return renderKfdJson(value);
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
function sha256RenderedJson(value) {
  return sha256Text(renderJson(value));
}
function packageResolver(baseFile) {
  return createRequire(baseFile);
}
function packageJson(packageName, baseFile) {
  const req = packageResolver(baseFile);
  const packageJsonPath = req.resolve(`${packageName}/package.json`);
  return {
    path: packageJsonPath,
    dir: path.dirname(packageJsonPath),
    value: readJson(packageJsonPath),
  };
}
function packageAsset(packageName, assetPath, baseFile) {
  const metadata = packageJson(packageName, baseFile);
  const req = packageResolver(baseFile);
  let assetFile = '';
  try {
    assetFile = req.resolve(`${packageName}/${assetPath}`);
  } catch {
    assetFile = path.join(metadata.dir, assetPath);
  }
  if (!fs.existsSync(assetFile)) return null;
  const raw = fs.readFileSync(assetFile, 'utf8');
  let parsed = null;
  if (assetFile.endsWith('.json')) {
    parsed = JSON.parse(raw);
  }
  return {
    path: assetPath,
    packagePath: path
      .relative(metadata.dir, assetFile)
      .split(path.sep)
      .join('/'),
    sha256: `sha256:${sha256File(assetFile)}`,
    contract: parsed && typeof parsed === 'object' ? parsed.contract || '' : '',
    parsed,
  };
}
function requireAsset(packageName, assetPath, baseFile) {
  const asset = packageAsset(packageName, assetPath, baseFile);
  if (!asset) {
    throw new Error(`${packageName}/${assetPath} is missing`);
  }
  return asset;
}
function assetSummary(asset) {
  return {
    path: asset.path,
    sha256: asset.sha256,
    contract: asset.contract || undefined,
  };
}
function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}
function buildOwnKfdFacts() {
  const contractRegistry = readOptionalJson(CONTRACT_REGISTRY_PATH);
  const kfd2Registry = readOptionalJson(KFD2_REGISTRY_PATH);
  const kfd4Schemas = packageAsset(
    '@kungfu-tech/kfd',
    'standards.json',
    SDK_CLI_PATH,
  )?.parsed?.standards?.['kfd-4'];
  const kfd4Qualification = loadKfd4PerspectiveQualification({ root: ROOT });
  return {
    kfd1: {
      status: 'supported',
      mode: 'contract-world',
      source: rel(CONTRACT_REGISTRY_PATH),
      sha256: fs.existsSync(CONTRACT_REGISTRY_PATH)
        ? `sha256:${sha256File(CONTRACT_REGISTRY_PATH)}`
        : '',
      contractCount: Array.isArray(contractRegistry?.contracts)
        ? contractRegistry.contracts.length
        : 0,
      witnessCommand: 'kungfu sdk contract witness --json',
      gateCommand: 'kungfu sdk kfd 1 gate --json',
      verifyCommand: 'kungfu sdk kfd 1 verify --json',
      releasePassportInput: '--kfd-1-witness-json',
      releaseGate: rel(SDK_KFD1_RELEASE_GATE_PATH),
      verifyResult: rel(SDK_KFD1_VERIFY_RESULT_PATH),
    },
    kfd2: {
      status: 'supported',
      mode: 'release-claims',
      source: rel(KFD2_REGISTRY_PATH),
      sha256: fs.existsSync(KFD2_REGISTRY_PATH)
        ? `sha256:${sha256File(KFD2_REGISTRY_PATH)}`
        : '',
      claimCount: Array.isArray(kfd2Registry?.claims)
        ? kfd2Registry.claims.length
        : 0,
      claimsCommand: 'kungfu sdk kfd 2 claims --json',
      releasePassportInput: '--kfd-2-claim-json',
      releaseClaims: `${rel(SDK_KFD2_OUTPUT_DIR)}/release-claims.json`,
      buildchainClaimArgs: `${rel(SDK_KFD2_OUTPUT_DIR)}/buildchain-claim-args.txt`,
    },
    kfd3: {
      status: 'supported',
      mode: STRICT_KFD3_MODE,
      source: KFD3_DEFAULT_REGISTRY_PATH,
      queryCommand: 'kungfu sdk kfd query --json',
    },
    kfd4: {
      status: 'candidate',
      mode: 'perspective-product-qualification',
      source: KFD4_QUALIFICATION_PATH,
      schemaCount: Object.keys(kfd4Schemas?.schemaPaths || {}).length,
      schemaCommand: 'kungfu sdk kfd 4 schema --json',
      qualificationCommand:
        'node framework/core/tests/qualification/kfd4-perspective.mjs',
      qualificationRoot: kfd4Qualification.report.qualificationRoot,
      releaseQualification: 'not-qualified',
      shippedSupport: false,
      residualRisk: [
        'Kungfu retains one bounded first-party KFD-4 qualification; independent adopter evidence and an explicit release decision are still required.',
        'A passed Buildchain gate does not independently qualify, activate, or ship KFD-4 support.',
      ],
    },
  };
}
function buildUpstreamKfdAggregate({ quiet = false } = {}) {
  const sealedAggregate = loadSealedKfdUpstreamAggregate({
    receiptPath: process.env.BUILDCHAIN_RELEASE_CANDIDATE_RECOVERY_RECEIPT_PATH,
    aggregatePath: SDK_KFD_UPSTREAM_AGGREGATE_PATH,
    displayPath: rel(SDK_KFD_UPSTREAM_AGGREGATE_PATH),
    quiet,
    readAggregate: readJson,
  });
  if (sealedAggregate) return sealedAggregate;
  const kfdPackage = packageJson('@kungfu-tech/kfd', SDK_CLI_PATH);
  const libnodePackage = packageJson('@kungfu-tech/libnode', CORE_PACKAGE_PATH);
  const buildchainPackage = packageJson(
    '@kungfu-tech/buildchain',
    SDK_CLI_PATH,
  );
  const kfdAssets = [
    requireAsset('@kungfu-tech/kfd', 'kfd.release.json', SDK_CLI_PATH),
    requireAsset(
      '@kungfu-tech/kfd',
      'buildchain/kfd-1/contract-world.witness.json',
      SDK_CLI_PATH,
    ),
    requireAsset(
      '@kungfu-tech/kfd',
      'buildchain/kfd-2/public-release-trust.claim.json',
      SDK_CLI_PATH,
    ),
    requireAsset(
      '@kungfu-tech/kfd',
      'buildchain/kfd-3/collaboration-interface.json',
      SDK_CLI_PATH,
    ),
    requireAsset('@kungfu-tech/kfd', 'standards.json', SDK_CLI_PATH),
  ];
  const libnodeRelease = requireAsset(
    '@kungfu-tech/libnode',
    'libnode.release.json',
    CORE_PACKAGE_PATH,
  );
  const buildchainAssets = [
    requireAsset(
      '@kungfu-tech/buildchain',
      'site/kfd-claims.json',
      SDK_CLI_PATH,
    ),
    requireAsset(
      '@kungfu-tech/buildchain',
      'site/node-api-registry.json',
      SDK_CLI_PATH,
    ),
    requireAsset(
      '@kungfu-tech/buildchain',
      'docs/kfd-support.md',
      SDK_CLI_PATH,
    ),
    requireAsset('@kungfu-tech/buildchain', 'kfd', SDK_CLI_PATH),
  ];
  const kfdCollaboration = kfdAssets.find((asset) =>
    asset.path.includes('collaboration-interface.json'),
  )?.parsed;
  const kfdRelease = kfdAssets.find(
    (asset) => asset.path === 'kfd.release.json',
  )?.parsed;
  return {
    schemaVersion: 1,
    contract: 'kungfu-upstream-kfd-aggregate',
    product: productIdentity(),
    source: {
      generator: 'scripts/buildchain-kfd-evidence.mjs',
      packageResolution: [
        'developer/sdk resolves @kungfu-tech/kfd and @kungfu-tech/buildchain',
        'framework/core resolves @kungfu-tech/libnode',
      ],
    },
    upstreams: [
      {
        id: 'kfd',
        role: 'standard-and-schema-provider',
        package: {
          name: kfdPackage.value.name,
          version: kfdPackage.value.version,
        },
        repository: 'kungfu-systems/kfd',
        kfd: {
          kfd1: 'exported-witness',
          kfd2: 'exported-claim',
          kfd3: 'exported-collaboration-interface',
          kfd4: 'schema-metadata',
        },
        releaseAnchor: kfdRelease || null,
        kfd3SurfaceCount: Array.isArray(kfdCollaboration?.surfaces)
          ? kfdCollaboration.surfaces.length
          : 0,
        assets: kfdAssets.map(assetSummary),
      },
      {
        id: 'libnode',
        role: 'embedded-node-runtime-provider',
        package: {
          name: libnodePackage.value.name,
          version: libnodePackage.value.version,
        },
        repository: 'kungfu-systems/libnode',
        kfd: {
          kfd1: 'release-anchor-facts',
          kfd2: 'release-passport-required',
          kfd3: 'package-runtime-surface',
          kfd4: 'not-declared',
        },
        releaseAnchor: libnodeRelease.parsed,
        assets: [assetSummary(libnodeRelease)],
        residualRisk: [
          'This libnode package version ships libnode.release.json as the package-level release anchor; full upstream trust should be read from its Buildchain release passport.',
        ],
      },
      {
        id: 'buildchain',
        role: 'release-passport-and-kfd-gate-provider',
        package: {
          name: buildchainPackage.value.name,
          version: buildchainPackage.value.version,
        },
        repository: 'kungfu-systems/buildchain',
        kfd: {
          kfd1: 'gate-provider',
          kfd2: 'claim-provider',
          kfd3: 'surface-query-provider',
          kfd4: 'schema-provider',
        },
        publicExports: [
          '@kungfu-tech/buildchain/kfd-gate',
          '@kungfu-tech/buildchain/kfd',
          '@kungfu-tech/buildchain/buildchain-kfd-claims',
          '@kungfu-tech/buildchain/release-passport',
        ],
        assets: buildchainAssets.map(assetSummary),
      },
    ],
    ownKfd: buildOwnKfdFacts(),
    summary: {
      upstreamCount: 3,
      kfdAwareUpstreams: ['kfd', 'libnode', 'buildchain'],
      packageVersions: {
        kfd: kfdPackage.value.version,
        libnode: libnodePackage.value.version,
        buildchain: buildchainPackage.value.version,
      },
    },
  };
}
function resolveKfdEvidenceSourceSha({ write }) {
  const committed = write
    ? ''
    : String(readJson(KFD3_PREBUILD_WITNESS_PATH).source?.sourceSha || '');
  return resolveGitBoundKfdEvidenceSourceSha({
    root: ROOT,
    write,
    committed,
    configured:
      process.env.BUILDCHAIN_SOURCE_SHA || process.env.KUNGFU_KFD_SOURCE_SHA,
    prepareHistory: prepareGateMeasurementHistory,
    assertBinding: assertKfdEvidenceSourceBinding,
    selectSourceSha: selectKfdEvidenceSourceSha,
    findTreeEquivalentAncestor: findGitTreeEquivalentAncestor,
  });
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
function fileSurface({
  id,
  name,
  kind,
  sourcePath,
  evidencePath,
  maturity,
  distribution,
  owner = 'kungfu',
}) {
  return {
    id,
    name,
    kind,
    participantProfile: 'agent-or-developer',
    state: 'declared',
    availability: 'shipped',
    visibility: 'public',
    participantFacing: true,
    public: true,
    sourcePath,
    evidencePath: evidencePath || sourcePath,
    artifactPath: evidencePath || sourcePath,
    maturity: maturity || 'stable',
    declaration: {
      owner,
      source: 'scripts/buildchain-kfd-evidence.mjs',
      sourcePath,
    },
    ...(distribution ? { distribution } : {}),
  };
}
function agentApiSurfaces() {
  return [
    [AGENT_REGISTRY_PATH, AGENT_COMMANDS_PATH, 'kungfu'],
    [SHIFU_AGENT_REGISTRY_PATH, SHIFU_AGENT_REGISTRY_PATH, 'shifu'],
    [XINFA_AGENT_REGISTRY_PATH, XINFA_AGENT_REGISTRY_PATH, 'xinfa'],
  ].flatMap(([registryPath, evidencePath, owner]) => {
    const registry = readJson(registryPath);
    const apis = Array.isArray(registry.apis) ? registry.apis : [];
    return apis.map((api) =>
      fileSurface({
        id: String(api.id),
        name: String(api.name || api.command || api.id),
        kind: String(api.surface || 'cli'),
        sourcePath: rel(registryPath),
        evidencePath: rel(evidencePath),
        maturity: String(api.maturity || 'stable'),
        owner,
      }),
    );
  });
}
function sdkAndProductSurfaces() {
  return [
    fileSurface({
      id: 'kungfu.kfd.query',
      name: 'kungfu kfd status|schema|1|2|4|query|check|witness|upstream|aggregate',
      kind: 'cli',
      sourcePath: 'framework/core/src/python/kungfu/cli/commands/kfd.py',
      evidencePath: 'developer/sdk/kfd/upstream-aggregate.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.kfd.query',
      name: 'kungfu sdk kfd status|schema|1|2|4|query|check|witness|upstream|aggregate',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk-kfd.js',
      evidencePath: 'developer/sdk/kfd/upstream-aggregate.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.contract.witness',
      name: 'kungfu sdk contract witness --json',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk-contract.js',
      evidencePath: 'framework/contract/kungfu-contracts.registry.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.contract.audit',
      name: 'kungfu sdk contract audit --json',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk-contract.js',
      evidencePath:
        'framework/contract/kungfu-agent-first-canonical-policy.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.product.gui',
      name: 'kungfu sdk product gui dev|build|pack|dist',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk-shared.js',
      evidencePath: 'developer/sdk/src/sdk-shared.js',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.product.tui',
      name: 'kungfu sdk product tui dev|build|bundle|dist',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk-shared.js',
      evidencePath: 'developer/sdk/src/sdk-shared.js',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.product.cli',
      name: 'kungfu sdk product cli dist',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk-shared.js',
      evidencePath: 'developer/sdk/src/sdk-shared.js',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.sdk.kfx.build',
      name: 'kungfu sdk kfx build|clean',
      kind: 'cli',
      sourcePath: 'developer/sdk/src/sdk-contract.js',
      evidencePath: 'framework/kfx/kungfu-kfx.contract.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.runtime.service',
      name: 'kungfu runtime status|start|stop|restart|service plan|install|uninstall|status',
      kind: 'cli',
      sourcePath: rel(RUNTIME_CLI_PATH),
      evidencePath: rel(RUNTIME_SERVICE_PATH),
      maturity: 'draft',
    }),
    fileSurface({
      id: 'kungfu.gui.runtime-tray',
      name: 'Kungfu GUI menu-bar/system-tray runtime residency controls',
      kind: 'gui',
      sourcePath: 'framework/gui/src/main/index.ts',
      evidencePath: 'docs/architecture/runtime-service.md',
      maturity: 'draft',
    }),
    fileSurface({
      id: 'kungfu.product.dev-run',
      name: './shifu product',
      kind: 'cli',
      sourcePath: 'product/scripts/product.mjs',
      evidencePath: 'product/package.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.product.release-build',
      name: './shifu dist',
      kind: 'cli',
      sourcePath: 'product/scripts/dist.mjs',
      evidencePath: 'product/package.json',
      maturity: 'stable',
      // Build-output facts for the shifu registrar: when one of these tasks
      // succeeds under shifu, the launcher stashes the host platform's
      // artifact user-globally for `shifu builds` / `shifu promote`
      // A repo onboards its artifacts here; crates/shifu/src/registrar.rs consumes it.
      distribution: {
        registrar: 'shifu',
        tasks: ['dist*', 'package'],
        releaseCompanions: 'standard',
        artifacts: [
          {
            kind: 'app',
            platform: 'macos',
            pathGlob: 'product/dist/desktop/mac*/*.app',
          },
          {
            kind: 'installer',
            platform: 'windows',
            pathGlob: 'product/dist/desktop/*.exe',
          },
          {
            kind: 'appimage',
            platform: 'linux',
            pathGlob: 'product/dist/desktop/*.AppImage',
          },
        ],
      },
    }),
    fileSurface({
      id: 'kungfu.product.cli-release-build',
      name: './shifu product cli dist',
      kind: 'cli',
      sourcePath: 'product/scripts/product.mjs',
      evidencePath: 'product/package.json',
      maturity: 'stable',
    }),
    fileSurface({
      id: 'kungfu.buildchain.kfd.evidence',
      name: './shifu kfd:buildchain',
      kind: 'cli',
      sourcePath: 'scripts/buildchain-kfd-evidence.mjs',
      evidencePath: KFD3_DEFAULT_REGISTRY_PATH,
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
function buildKfd3Registry(upstreamAggregate = buildUpstreamKfdAggregate()) {
  const surfaces = uniqueById([
    ...agentApiSurfaces(),
    ...sdkAndProductSurfaces(),
  ]);
  return {
    schemaVersion: 1,
    contract: KFD3_SURFACE_REGISTRY_CONTRACT,
    product: {
      ...productIdentity(),
      package: '@kungfu-tech/product-kungfu',
    },
    registryPath: KFD3_DEFAULT_REGISTRY_PATH,
    buildchain: {
      kfd3: {
        mode: STRICT_KFD3_MODE,
        sourceOfTruth: KFD3_DEFAULT_REGISTRY_PATH,
        generator: 'scripts/buildchain-kfd-evidence.mjs',
        inputs: [
          {
            path: rel(AGENT_REGISTRY_PATH),
            role: 'kungfu-agent-first-subregistry',
          },
          {
            path: rel(SHIFU_AGENT_REGISTRY_PATH),
            role: 'shifu-agent-subregistry',
          },
          {
            path: rel(XINFA_AGENT_REGISTRY_PATH),
            role: 'xinfa-agent-subregistry',
          },
          {
            path: rel(AGENT_COMMANDS_PATH),
            role: 'kungfu-agent-command-catalog',
          },
          {
            path: rel(SDK_CLI_PATH),
            role: 'kungfu-sdk-product-entrypoints',
          },
          {
            path: rel(RUNTIME_CLI_PATH),
            role: 'kungfu-runtime-service-entrypoints',
          },
          {
            path: rel(RUNTIME_SERVICE_PATH),
            role: 'kungfu-runtime-service-supervisor-runtime',
          },
          {
            path: 'framework/gui/src/main/index.ts',
            role: 'kungfu-gui-runtime-tray-surface',
          },
          {
            path: 'product/scripts/product.mjs',
            role: 'kungfu-product-dev-and-build-entrypoints',
          },
        ],
        projections: [
          'developer/sdk/kfd/kfd-3-surfaces.json',
          '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
          '.buildchain/kfd/kfd-3/collaboration-interface.artifact.json',
          '.buildchain/kfd/kfd-3/capability-query.json',
        ],
        checkCommand: './shifu kfd:buildchain:check',
      },
    },
    upstreamKfd: {
      aggregatePath: 'developer/sdk/kfd/upstream-aggregate.json',
      upstreamCount: upstreamAggregate.summary.upstreamCount,
      kfdAwareUpstreams: upstreamAggregate.summary.kfdAwareUpstreams,
      packageVersions: upstreamAggregate.summary.packageVersions,
      digest: `sha256:${sha256Json(upstreamAggregate)}`,
    },
    surfaces,
    policy: {
      sourceOfTruth: KFD3_DEFAULT_REGISTRY_PATH,
      detectedButUnregistered: 'product-specific-audit',
      declaredButMissing: 'fail',
      artifactPublicButUnclassified: 'fail',
      customSurfaceDetection: 'scripts/buildchain-kfd-evidence.mjs',
      upstreamSubregistriesMustProjectIntoDefaultRegistry: true,
    },
  };
}
function registryDescriptor(registry) {
  return {
    id: registry.product.id,
    path: KFD3_DEFAULT_REGISTRY_PATH,
    sha256: sha256File(KFD3_REGISTRY_PATH),
    digest: `sha256:${sha256Json(registry)}`,
  };
}
function missingSurfaceFields(surface) {
  return [
    'id',
    'kind',
    'name',
    'state',
    'sourcePath',
    'evidencePath',
    'artifactPath',
    'declaration',
  ].filter((field) => !surface[field]);
}

function buildStrictBuildchainAudit(registry) {
  const onDisk = readJson(KFD3_REGISTRY_PATH);
  const buildchainRegistry = runtime.kfd3.readSurfaceRegistry({
    cwd: ROOT,
    registryPath: KFD3_DEFAULT_REGISTRY_PATH,
  });
  const generatedIds = new Set(registry.surfaces.map((surface) => surface.id));
  const diskIds = new Set(
    (buildchainRegistry.surfaces || []).map((surface) => surface.id),
  );
  const agentIds = new Set(agentApiSurfaces().map((surface) => surface.id));
  const sdkProductIds = new Set(
    sdkAndProductSurfaces().map((surface) => surface.id),
  );
  const issues = [];

  if (onDisk.contract !== KFD3_SURFACE_REGISTRY_CONTRACT) {
    issues.push(`registry contract is ${onDisk.contract}`);
  }
  if (onDisk.registryPath !== KFD3_DEFAULT_REGISTRY_PATH) {
    issues.push(`registryPath is ${onDisk.registryPath}`);
  }
  if (onDisk.policy?.sourceOfTruth !== KFD3_DEFAULT_REGISTRY_PATH) {
    issues.push(`policy.sourceOfTruth must be ${KFD3_DEFAULT_REGISTRY_PATH}`);
  }
  if (onDisk.buildchain?.kfd3?.mode !== STRICT_KFD3_MODE) {
    issues.push(`buildchain.kfd3.mode must be ${STRICT_KFD3_MODE}`);
  }
  for (const id of generatedIds) {
    if (!diskIds.has(id))
      issues.push(`generated surface missing on disk: ${id}`);
  }
  for (const id of diskIds) {
    if (!generatedIds.has(id)) issues.push(`disk surface not generated: ${id}`);
  }
  for (const id of agentIds) {
    if (!diskIds.has(id))
      issues.push(`agent registry API not projected: ${id}`);
  }
  for (const id of sdkProductIds) {
    if (!diskIds.has(id)) {
      issues.push(`SDK/product surface not projected: ${id}`);
    }
  }
  for (const surface of buildchainRegistry.surfaces || []) {
    const missing = missingSurfaceFields(surface);
    if (missing.length) {
      issues.push(
        `surface ${surface.id || '<missing-id>'} missing ${missing.join(', ')}`,
      );
    }
  }

  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-3-strict-registry-audit',
    ok: issues.length === 0,
    mode: STRICT_KFD3_MODE,
    registryPath: KFD3_DEFAULT_REGISTRY_PATH,
    sourceOfTruth: onDisk.policy?.sourceOfTruth || '',
    contractName: onDisk.contract || '',
    summary: {
      surfaceCount: buildchainRegistry.surfaces.length,
      agentApiCount: agentIds.size,
      sdkProductSurfaceCount: sdkProductIds.size,
      issueCount: issues.length,
    },
    issues,
  };
}

function assertStrictBuildchainAudit(audit) {
  if (audit.ok) return;
  throw new Error(
    `Buildchain strict KFD-3 registry audit failed:\n${audit.issues.join('\n')}`,
  );
}

function buildCollaborationInterface(registry) {
  return {
    schemaVersion: 1,
    contract: KFD3_SURFACE_REGISTRY_CONTRACT,
    product: registry.product,
    upstreamKfd: registry.upstreamKfd,
    surfaces: registry.surfaces,
    audit: {
      status: 'passed',
      declared: registry.surfaces.length,
      artifactPublic: registry.surfaces.length,
      policy: registry.policy,
    },
  };
}

function buildKfd3PrebuildWitness(registry, sourceSha) {
  const collaborationInterface = buildCollaborationInterface(registry);
  return {
    schemaVersion: 1,
    id: 'kungfu-collaboration-interface',
    standard: 'kfd-3',
    witnessKind: 'prebuild',
    supportLevel: 'release',
    source: {
      cwd: '.',
      sourceSha,
      registryPath: KFD3_DEFAULT_REGISTRY_PATH,
      registryDigest: `sha256:${sha256Json(registry)}`,
    },
    sourceRegistry: registryDescriptor(registry),
    upstreamKfd: registry.upstreamKfd,
    expectedArtifactVerification: {
      command: ARTIFACT_VERIFY_COMMAND,
    },
    collaborationInterfaceDigest: `sha256:${sha256Json(collaborationInterface)}`,
    collaborationInterface,
    declaredSurfaces: registry.surfaces,
    auditBoundary: {
      mode: STRICT_KFD3_MODE,
      scope:
        'Kungfu participant-facing agent, SDK, kfx, product build/dev-run, and Buildchain KFD evidence surfaces declared in the Buildchain-managed KFD-3 registry.',
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
      path: 'product/release',
    },
    sourceRegistry: registryDescriptor(registry),
    upstreamKfd: registry.upstreamKfd,
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

function assertCurrentIfPresent(filePath, value, label) {
  if (fs.existsSync(filePath)) assertCurrent(filePath, value, label);
}

function buildKfd1Witness() {
  return runNodeScript([
    'developer/sdk/src/sdk.js',
    'contract',
    'witness',
    '--json',
  ]);
}

function buildKfd1ReleaseGate(kfd1Witness) {
  return runtime.kfd1.createReleaseGateEvidence({
    cwd: ROOT,
    artifacts: (kfd1Witness.surfaces || []).map((surface) => ({
      name: surface.artifactPath,
      sourcePath: path.resolve(ROOT, surface.sourcePath),
    })),
    witnesses: [kfd1Witness],
    verifiedAt: '1970-01-01T00:00:00.000Z',
  })?.passportSection;
}

function buildKfd1VerifyResult(kfd1Gate) {
  const issues = runtime.kfd1.validateReleaseGateEvidence(kfd1Gate);
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-1-verify-result',
    ok: issues.length === 0,
    issues,
  };
}

function buildKfd2Claims({ write, sourceSha, outputDir = KFD2_OUTPUT_DIR }) {
  const result = write
    ? runtime.kfd2.writeProductClaimOutputs({
        cwd: ROOT,
        outputDir: rel(outputDir),
        sourceSha,
      })
    : runtime.kfd2.checkProductClaimOutputs({
        cwd: ROOT,
        outputDir: rel(outputDir),
        sourceSha,
      });
  if (!result.ok) {
    throw new Error(
      `Buildchain KFD-2 product claims are stale:\n${(result.issues || [])
        .map((issue) => `- ${issue.path || issue.code}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return {
    ...result,
    releaseClaims: {
      ...result.releaseClaims,
      sha256: result.summary.releaseClaimsSha256,
      path: rel(path.join(outputDir, 'release-claims.json')),
    },
    buildchainProjection: {
      claimCount: result.summary.claimCount,
      claims: result.claims.map((claim) => ({
        ...claim,
        path: `${rel(outputDir)}/claims/${claim.id}.json`,
      })),
    },
  };
}

function writeKfd2PackagedOutputs(outputDir, sourceSha) {
  return buildKfd2Claims({ write: true, outputDir, sourceSha });
}

function assertCurrentKfd2Output(outputDir, label, sourceSha) {
  try {
    return buildKfd2Claims({ write: false, outputDir, sourceSha });
  } catch (error) {
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function buildQuery(registry) {
  const query = await runtime.kfd3.queryCapabilities({
    cwd: ROOT,
    product: 'kungfu',
    registryPath: KFD3_DEFAULT_REGISTRY_PATH,
  });
  if (query.status !== 'passed' || query.kfd?.kfd3 !== 'passed') {
    throw new Error(
      `Buildchain KFD-3 product-declared registry query failed: ${query.warning || 'no diagnostic supplied'}`,
    );
  }
  return query;
}

function gateRelativePath(...parts) {
  return path.posix.join(
    '.buildchain',
    'runtime',
    'kfd-product-gates',
    ...parts,
  );
}

function writeGateJson(workspace, relativePath, value) {
  const filePath = path.join(workspace, relativePath);
  writeJson(filePath, value);
  return {
    path: relativePath,
    sha256: `sha256:${sha256File(filePath)}`,
  };
}

function copyGateJson(workspace, sourcePath, relativePath) {
  return writeGateJson(workspace, relativePath, readJson(sourcePath));
}

function gateEvidence(workspace, id, kind, sourcePath, outputName = id) {
  return {
    id,
    kind,
    ...copyGateJson(
      workspace,
      sourcePath,
      gateRelativePath('evidence', `${outputName}.json`),
    ),
  };
}

function productGateEnvelope({
  standard,
  standardRevision,
  sourceSha,
  checkedAt,
  records,
  evidence,
  nonClaims,
}) {
  return {
    schemaVersion: 1,
    contract: runtime.productGates.KFD_PRODUCT_GATE_INPUT_CONTRACT,
    standard,
    standardRevision,
    source: {
      repository: 'kungfu-systems/kungfu',
      sha: sourceSha,
    },
    evidenceCut: {
      generatedAt: checkedAt,
      expiresAt: new Date(
        Date.parse(checkedAt) + 24 * 60 * 60 * 1000,
      ).toISOString(),
    },
    records,
    evidence,
    responsibility: {
      owner: 'kungfu-systems/kungfu',
      evidenceOwner: 'Kungfu maintainers',
      proofOwner: 'Buildchain',
    },
    nonClaims,
  };
}

function kfd4GateInput({ workspace, sourceSha, checkedAt, standards }) {
  const qualification = loadKfd4PerspectiveQualification({ root: ROOT });
  const report = qualification.report;
  const perspective = report.perspectives[0].perspective;
  const replay = report.contrastiveReplay.document;
  const records = [
    {
      role: 'observer-perspective',
      ...writeGateJson(
        workspace,
        gateRelativePath('kfd-4', 'observer-perspective.json'),
        perspective,
      ),
    },
    {
      role: 'perspective-replay',
      ...writeGateJson(
        workspace,
        gateRelativePath('kfd-4', 'perspective-replay.json'),
        replay,
      ),
    },
  ];
  const evidence = [
    {
      id: 'projection-fsck',
      kind: 'projection-fsck',
      ...writeGateJson(
        workspace,
        gateRelativePath('evidence', 'support-matrix.json'),
        {
          schema: 'kungfu.kfd-4-projection-set-fsck/v1',
          qualificationRoot: report.qualificationRoot,
          projections: report.perspectives.map((projection) => ({
            id: projection.perspective.id,
            observer: projection.perspective.observer.id,
            viewRoot: projection.viewRoot,
            fsck: projection.fsck,
          })),
        },
      ),
    },
    {
      id: 'kfd-4-negative',
      kind: 'negative-fixture',
      ...writeGateJson(
        workspace,
        gateRelativePath('evidence', 'kfd-4-negative.json'),
        {
          schema: 'kungfu.kfd-4-negative-qualification/v1',
          qualificationRoot: report.qualificationRoot,
          cases: report.negativeCases,
        },
      ),
    },
    gateEvidence(
      workspace,
      'kfd-4-product-qualification',
      'product-qualification',
      qualification.path,
      'kfd-4-product-qualification',
    ),
  ];
  return productGateEnvelope({
    standard: 'kfd-4',
    standardRevision: standards.standards['kfd-4'].revision,
    sourceSha,
    checkedAt,
    records,
    evidence,
    nonClaims: report.nonClaims,
  });
}

function kfd5GateInput({ workspace, sourceSha, checkedAt, standards }) {
  const discovery = requireAsset(
    '@kungfu-tech/kfd',
    'cases/live/software-work-perspective-settlement/cuts/0001-assignment.json',
    __filename,
  ).parsed;
  const repoPath = (relativePath) => path.join(ROOT, relativePath);
  const primitiveCatalogRelativePath =
    'framework/primitive/kungfu-primitive-catalog.contract.json';
  const primitiveCatalogPath = repoPath(primitiveCatalogRelativePath);
  const catalog = readJson(primitiveCatalogPath);
  const assignment = catalog.primitives?.find(({ id }) => id === 'assignment');
  if (
    catalog.schema !== 'kungfu.primitive-catalog/v2' ||
    assignment?.definition?.lifecycle?.state !== 'active' ||
    assignment?.admission?.summary?.state !== 'experimental' ||
    assignment?.admission?.vector?.qualification?.state !== 'incomplete' ||
    assignment?.admission?.vector?.artifactShipment?.state !== 'not-shipped'
  ) {
    throw new Error(
      'KFD-5 Assignment candidate must remain an active, experimental, incomplete, and not-shipped Primitive catalog entry',
    );
  }
  const dogfoodReportPath = repoPath(
    'docs/qualification/evidence/assignment-organization-rollout/7aae2c562a/report.json',
  );
  const dogfoodReport = readJson(dogfoodReportPath);
  const phaseGates = new Map(
    (dogfoodReport.phaseGates || []).map((entry) => [entry.id, entry]),
  );
  const failureMatrix = new Map(
    (dogfoodReport.failureMatrix || []).map((entry) => [entry.case, entry]),
  );
  if (
    dogfoodReport.schema !==
      'kungfu.assignment.organization-dogfood-report/v1' ||
    phaseGates.get('phase-1-single-repository-shadow-dogfood')?.verdict !==
      'pass' ||
    phaseGates.get('phase-2-home-parent-cross-workspace-closure')?.verdict !==
      'pass' ||
    failureMatrix.get('worktree-deletion')?.verdict !== 'pass' ||
    failureMatrix.get('tamper')?.verdict !== 'fail-closed-as-designed' ||
    dogfoodReport.rolloutDecision?.defaultOn !== true ||
    dogfoodReport.rolloutDecision?.stableReleaseAuthorized !== false ||
    dogfoodReport.verdict?.organizationDogfood !== 'qualified' ||
    dogfoodReport.verdict?.generalProductRelease !== 'not-qualified'
  ) {
    throw new Error(
      'KFD-5 Assignment product evidence must retain passed dogfood, cross-workspace closure, worktree-deletion, tamper, and non-release qualification boundaries',
    );
  }
  const assignmentTestPath = repoPath(
    'framework/core/tests/python/test_assignment_orchestration.py',
  );
  const records = [
    {
      role: 'primitive-discovery',
      ...writeGateJson(
        workspace,
        gateRelativePath('kfd-5', 'primitive-discovery.json'),
        discovery,
      ),
    },
  ];
  const evidence = [
    gateEvidence(
      workspace,
      'assignment-primitive-catalog-context',
      'candidate-context',
      primitiveCatalogPath,
    ),
    gateEvidence(
      workspace,
      'assignment-organization-dogfood',
      'product-dogfood',
      dogfoodReportPath,
    ),
    gateEvidence(
      workspace,
      'assignment-minimum-closure',
      'minimum-closure',
      repoPath(
        'framework/assignment-capture/fixtures/assignment-request-roundtrip-v1.json',
      ),
    ),
    gateEvidence(
      workspace,
      'assignment-native-lifecycle',
      'native-lifecycle',
      repoPath('framework/work-lifecycle/work-lifecycle-native.contract.json'),
    ),
    {
      id: 'assignment-orchestration-qualification',
      kind: 'product-qualification',
      ...writeGateJson(
        workspace,
        gateRelativePath(
          'evidence',
          'assignment-orchestration-qualification.json',
        ),
        {
          schema: 'kungfu.kfd-5-assignment-qualification-source/v1',
          source: {
            repository: 'kungfu-systems/kungfu',
            sha: sourceSha,
            path: rel(assignmentTestPath),
            sha256: `sha256:${sha256File(assignmentTestPath)}`,
          },
          covers: [
            'minimum-closure',
            'portable-seal',
            'worktree-deletion',
            'workspace-transfer',
            'tamper-fail-closed',
          ],
          nonClaims: [
            'This source binding is first-party product evidence, not an independent adopter result.',
            'A passed Buildchain gate does not activate or ship KFD-5 support.',
          ],
        },
      ),
    },
    {
      id: 'kfd-5-negative',
      kind: 'negative-fixture',
      ...writeGateJson(
        workspace,
        gateRelativePath('evidence', 'kfd-5-negative.json'),
        {
          schemaVersion: 3,
          contract: 'kfd-5-primitive-discovery',
          standard: 'kfd-5',
          candidate: {},
        },
      ),
    },
  ];
  return productGateEnvelope({
    standard: 'kfd-5',
    standardRevision: standards.standards['kfd-5'].revision,
    sourceSha,
    checkedAt,
    records,
    evidence,
    nonClaims: [
      'The upstream Assignment cut remains the KFD authority; Kungfu contributes bounded first-party adopter evidence only.',
      'This gate does not establish independent adoption, a universal primitive need, KFD-11 activation, or shipped KFD-5 support.',
      'The existing primitive catalog is not itself KFD-5 qualification evidence.',
    ],
  });
}

function kfd7GateInput({ workspace, sourceSha, checkedAt, standards }) {
  const baseProfile = requireAsset(
    '@kungfu-tech/kfd',
    'verifier/fixtures/kfd-7/valid-domain-profile.json',
    __filename,
  ).parsed;
  const actionContractPath = path.join(
    ROOT,
    'framework',
    'agent-work',
    'kungfu-kfd-7-action-contract.json',
  );
  const actionContract = readJson(actionContractPath);
  const categorySources = {
    'semantic-component-deletion-or-fusion': 'role-deletion-or-fusion.json',
    'invalid-transition': 'negative-invalid-transition.json',
    'export-import-rebuild': 'export-import-rebuild.json',
    'backend-migration': 'backend-migration.json',
    'concurrency-retry-compensation': 'concurrency-retry-compensation.json',
    'warrant-decay-revocation': 'warrant-decay-revocation.json',
    'atlas-staleness-loss': 'atlas-staleness-loss.json',
    'pursuit-continuity-settlement': 'pursuit-continuity-settlement.json',
    'episode-replay-contraction': 'episode-replay-contraction.json',
    'cold-start-continuation': 'cold-start-continuation.json',
    'session-round-trip-refinement': 'session-round-trip-refinement.json',
    'session-complexity-breakpoint': 'session-complexity-breakpoint.json',
    'context-insufficiency-counterexample':
      'context-insufficiency-counterexample.json',
  };
  const previousObligations = new Map(
    actionContract.evidenceObligations.map((entry) => [
      entry.category === 'role-deletion-or-fusion'
        ? 'semantic-component-deletion-or-fusion'
        : entry.category,
      entry,
    ]),
  );
  const evidence = Object.entries(categorySources).map(([category, fileName]) =>
    gateEvidence(
      workspace,
      category,
      'qualification-proof',
      path.join(ROOT, 'framework', 'agent-work', 'evidence', 'kfd-7', fileName),
      `kfd-7-${category}`,
    ),
  );
  evidence.push(
    gateEvidence(
      workspace,
      'independent-review',
      'independent-review',
      actionContractPath,
      'kfd-7-independent-review',
    ),
  );
  evidence.push(
    gateEvidence(
      workspace,
      'kfd-7-negative',
      'negative-fixture',
      path.join(
        ROOT,
        'framework',
        'agent-work',
        'evidence',
        'kfd-7',
        'negative-invalid-transition.json',
      ),
      'kfd-7-negative',
    ),
  );
  const profile = {
    ...baseProfile,
    evidenceObligations: Object.keys(categorySources).map((category) => ({
      category,
      status: 'passed',
      artifactRefs: [category],
      residualRisk:
        previousObligations.get(category)?.residualRisk ||
        'Evidence is bounded to the Kungfu Product Profile.',
    })),
    activation: {
      decision: 'activate',
      evidenceCut: `git:implementation@${sourceSha}+buildchain-product-gate@runtime`,
      independentReview: actionContract.activation.independentReview,
      productWitnesses: actionContract.activation.productWitnesses,
      residualRisk: actionContract.activation.residualRisk,
    },
    domainProfile: {
      id: actionContract.profile.id,
      version: actionContract.profile.version,
      product: actionContract.profile.product,
      implementation: `git+https://github.com/kungfu-systems/kungfu.git@${sourceSha}#framework/core/src/python/kungfu/agent/work_profile.py`,
      qualificationStatus: 'qualified',
    },
    nonClaims: [
      'This Product Profile does not define universal KFD-7 lifecycle vocabulary.',
      'The Buildchain gate does not replace independent product activation or release qualification.',
    ],
  };
  const records = [
    {
      role: 'domain-profile',
      ...writeGateJson(
        workspace,
        gateRelativePath('kfd-7', 'domain-profile.json'),
        profile,
      ),
    },
  ];
  return productGateEnvelope({
    standard: 'kfd-7',
    standardRevision: standards.standards['kfd-7'].revision,
    sourceSha,
    checkedAt,
    records,
    evidence,
    nonClaims: [
      'KFD-7 qualification is bounded to the Kungfu Product Profile and exact source cut.',
      'A passed Buildchain gate does not certify other Domain Profiles.',
    ],
  });
}

async function buildProductGates({ write, sourceSha, checkedAt }) {
  const workspace = write
    ? ROOT
    : fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-kfd-product-gates-'));
  try {
    const standards = requireAsset(
      '@kungfu-tech/kfd',
      'standards.json',
      __filename,
    ).parsed;
    const inputs = [
      kfd4GateInput({ workspace, sourceSha, checkedAt, standards }),
      kfd5GateInput({ workspace, sourceSha, checkedAt, standards }),
      kfd7GateInput({ workspace, sourceSha, checkedAt, standards }),
    ];
    const gates = [];
    for (const input of inputs) {
      const gate = await runtime.productGates.evaluateKfdProductGate({
        cwd: workspace,
        input,
        expectedSourceSha: sourceSha,
        checkedAt,
      });
      const validation = runtime.productGates.validateKfdProductGateResult(
        gate,
        {
          expectedSourceSha: sourceSha,
          checkedAt,
        },
      );
      if (!validation.valid) {
        throw new Error(
          `${input.standard} product-gate result is invalid: ${JSON.stringify(validation.issues)}`,
        );
      }
      if (gate.status !== 'passed') {
        throw new Error(
          `${input.standard} product gate must pass for the checked-in exact-source evidence cut: ${JSON.stringify(gate.issues)}`,
        );
      }
      gates.push(gate);
      if (write) {
        writeJson(
          path.join(KFD_PRODUCT_GATE_RUNTIME_DIR, input.standard, 'input.json'),
          input,
        );
        writeJson(
          path.join(KFD_PRODUCT_GATE_RUNTIME_DIR, input.standard, 'gate.json'),
          gate,
        );
      }
    }
    const matrix = readJson(KFD_SUPPORT_MATRIX_PATH);
    const projection = runtime.productGates.createKfdSupportProjection({
      matrix,
      matrixRoot: `sha256:${sha256File(KFD_SUPPORT_MATRIX_PATH)}`,
      gateResults: gates,
      expectedSourceSha: sourceSha,
      checkedAt,
    });
    const projectionValidation =
      runtime.productGates.validateKfdSupportProjection(projection, {
        expectedSourceSha: sourceSha,
        checkedAt,
      });
    if (!projectionValidation.valid) {
      throw new Error(
        `KFD support projection is invalid: ${JSON.stringify(projectionValidation.issues)}`,
      );
    }
    if (write) writeJson(KFD_SUPPORT_PROJECTION_PATH, projection);
    return {
      sourceSha,
      checkedAt,
      inputs,
      gates,
      projection,
    };
  } finally {
    if (!write) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function buildSummary({
  registry,
  upstreamAggregate,
  kfd1Witness,
  kfd1Gate,
  kfd1VerifyResult,
  kfd2Summary,
  productGates,
  prebuildWitness,
  strictAudit,
}) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-evidence-summary',
    product: registry.product,
    buildchain: {
      minimumVersion: '3.0.0',
      releasePassportInputs: {
        kfd1WitnessJsons: [rel(KFD1_WITNESS_PATH)],
        kfd1ReleaseGate: rel(KFD1_RELEASE_GATE_PATH),
        kfd2ClaimJsons: (kfd2Summary.buildchainProjection?.claims || []).map(
          (claim) =>
            claim.path
              ? rel(claim.path)
              : `${rel(KFD2_OUTPUT_DIR)}/claims/${claim.id}.json`,
        ),
        kfd3PrebuildWitnessJsons: [rel(KFD3_PREBUILD_WITNESS_PATH)],
        kfd3ArtifactVerifyCommand: ARTIFACT_VERIFY_COMMAND,
        kfdAdopterManifestJson: '.buildchain/runtime/kfd-adopter/manifest.json',
        kfdProductGateJsons: KFD_PRODUCT_GATE_PATHS.map(rel),
      },
    },
    kfd1: {
      witness: rel(KFD1_WITNESS_PATH),
      packagedWitness: rel(SDK_KFD1_WITNESS_PATH),
      releaseGate: rel(KFD1_RELEASE_GATE_PATH),
      packagedReleaseGate: rel(SDK_KFD1_RELEASE_GATE_PATH),
      verifyResult: rel(KFD1_VERIFY_RESULT_PATH),
      packagedVerifyResult: rel(SDK_KFD1_VERIFY_RESULT_PATH),
      id: kfd1Witness.id,
      standard: kfd1Witness.standard,
      status: kfd1Gate.status,
      verifyOk: kfd1VerifyResult.ok,
      releaseGateSha256: `sha256:${sha256RenderedJson(kfd1Gate)}`,
      surfaces: Array.isArray(kfd1Witness.surfaces)
        ? kfd1Witness.surfaces.length
        : 0,
    },
    kfd2: {
      outputDir: rel(KFD2_OUTPUT_DIR),
      packagedOutputDir: rel(SDK_KFD2_OUTPUT_DIR),
      releaseClaims: `${rel(KFD2_OUTPUT_DIR)}/release-claims.json`,
      packagedReleaseClaims: `${rel(SDK_KFD2_OUTPUT_DIR)}/release-claims.json`,
      claimCount: kfd2Summary.buildchainProjection?.claimCount || 0,
      releaseClaimsSha256: `sha256:${kfd2Summary.releaseClaims?.sha256 || ''}`,
    },
    kfd3: {
      registry: KFD3_DEFAULT_REGISTRY_PATH,
      registryMode: strictAudit.mode,
      strictRegistryAudit: {
        ok: strictAudit.ok,
        issueCount: strictAudit.summary.issueCount,
        sourceOfTruth: strictAudit.sourceOfTruth,
      },
      upstreamAggregate: 'developer/sdk/kfd/upstream-aggregate.json',
      upstreamCount: upstreamAggregate.summary.upstreamCount,
      prebuildWitness: rel(KFD3_PREBUILD_WITNESS_PATH),
      artifactWitness: rel(KFD3_ARTIFACT_WITNESS_PATH),
      query: rel(KFD3_QUERY_PATH),
      surfaceCount: registry.surfaces.length,
      collaborationInterfaceDigest:
        prebuildWitness.collaborationInterfaceDigest,
    },
    productGates: {
      sourceSha: productGates.sourceSha,
      projection: rel(KFD_SUPPORT_PROJECTION_PATH),
      projectionRoot: productGates.projection.projectionRoot,
      status: productGates.projection.status,
      gates: productGates.gates.map((gate) => ({
        standard: gate.standard,
        status: gate.status,
        gateRoot: gate.gateRoot,
        issueCount: gate.issues.length,
        qualifying: gate.qualifying,
        selfCertified: gate.selfCertified,
      })),
    },
  };
}

async function runArtifactWitness(options) {
  const upstreamAggregate = buildUpstreamKfdAggregate({ quiet: options.json });
  const registry = buildKfd3Registry(upstreamAggregate);
  assertCurrent(KFD3_REGISTRY_PATH, registry, 'Buildchain KFD-3 registry');
  assertStrictBuildchainAudit(buildStrictBuildchainAudit(registry));
  const witness = buildKfd3ArtifactWitness(registry, { runVerify: true });
  if (options.json) process.stdout.write(renderJson(witness));
  else
    process.stdout.write(
      `[kfd] artifact witness ${witness.id} surfaces=${witness.exposedSurfaces.length}\n`,
    );
}

async function runCheckOrWrite(options) {
  const upstreamAggregate = buildUpstreamKfdAggregate({ quiet: options.json });
  const registry = buildKfd3Registry(upstreamAggregate);
  const kfd1Witness = buildKfd1Witness();
  const kfd1Gate = buildKfd1ReleaseGate(kfd1Witness);
  const kfd1VerifyResult = buildKfd1VerifyResult(kfd1Gate);
  if (!kfd1VerifyResult.ok) {
    throw new Error(
      `KFD-1 release gate verification failed:\n${kfd1VerifyResult.issues
        .map((issue) => `- ${issue.code || 'kfd-1'}: ${issue.message || issue}`)
        .join('\n')}`,
    );
  }
  const sourceSha = resolveKfdEvidenceSourceSha({ write: options.write });
  const kfd2Summary = options.write
    ? writeKfd2PackagedOutputs(KFD2_OUTPUT_DIR, sourceSha)
    : assertCurrentKfd2Output(
        KFD2_OUTPUT_DIR,
        'Buildchain KFD-2 output',
        sourceSha,
      );
  if (options.write) {
    writeIfChanged(KFD3_REGISTRY_PATH, registry);
    writeIfChanged(SDK_KFD3_CANONICAL_REGISTRY_PATH, registry);
    writeIfChanged(SDK_KFD_UPSTREAM_AGGREGATE_PATH, upstreamAggregate);
    writeJson(SDK_KFD1_WITNESS_PATH, kfd1Witness);
    writeJson(SDK_KFD1_RELEASE_GATE_PATH, kfd1Gate);
    writeJson(SDK_KFD1_VERIFY_RESULT_PATH, kfd1VerifyResult);
    writeKfd2PackagedOutputs(SDK_KFD2_OUTPUT_DIR, sourceSha);
  } else {
    assertCurrent(KFD3_REGISTRY_PATH, registry, 'Buildchain KFD-3 registry');
    assertCurrent(
      SDK_KFD3_CANONICAL_REGISTRY_PATH,
      registry,
      'SDK packaged canonical KFD-3 registry',
    );
    assertCurrent(
      SDK_KFD_UPSTREAM_AGGREGATE_PATH,
      upstreamAggregate,
      'SDK packaged upstream KFD aggregate',
    );
    assertCurrent(KFD1_WITNESS_PATH, kfd1Witness, 'Buildchain KFD-1 witness');
    assertCurrent(
      KFD1_RELEASE_GATE_PATH,
      kfd1Gate,
      'Buildchain KFD-1 release gate',
    );
    assertCurrent(
      KFD1_VERIFY_RESULT_PATH,
      kfd1VerifyResult,
      'Buildchain KFD-1 verify result',
    );
    assertCurrent(
      SDK_KFD1_WITNESS_PATH,
      kfd1Witness,
      'SDK packaged KFD-1 witness',
    );
    assertCurrent(
      SDK_KFD1_RELEASE_GATE_PATH,
      kfd1Gate,
      'SDK packaged KFD-1 release gate',
    );
    assertCurrent(
      SDK_KFD1_VERIFY_RESULT_PATH,
      kfd1VerifyResult,
      'SDK packaged KFD-1 verify result',
    );
    assertCurrentKfd2Output(
      SDK_KFD2_OUTPUT_DIR,
      'SDK packaged KFD-2 output',
      sourceSha,
    );
  }
  const strictAudit = buildStrictBuildchainAudit(registry);
  assertStrictBuildchainAudit(strictAudit);
  const checkedAt = resolveKfdProductGateCheckedAt({
    write: options.write,
    now: () => new Date().toISOString(),
    retainedGateResults: KFD_PRODUCT_GATE_PATHS.map(readOptionalJson),
    sourceSha,
    commitTimestamp: (commit) =>
      gitValue(ROOT, ['show', '-s', '--format=%cI', commit]),
  });
  const prebuildWitness = buildKfd3PrebuildWitness(registry, sourceSha);
  const artifactWitness = buildKfd3ArtifactWitness(registry, {
    runVerify: true,
  });
  const query = await buildQuery(registry);
  const productGates = await buildProductGates({
    write: options.write,
    sourceSha,
    checkedAt,
  });
  syncKfdAdopterRelease(
    ROOT,
    runtime,
    sourceSha,
    checkedAt,
    productGates,
    options.write,
  );
  const summary = buildSummary({
    registry,
    upstreamAggregate,
    kfd1Witness,
    kfd1Gate,
    kfd1VerifyResult,
    kfd2Summary,
    productGates,
    prebuildWitness,
    strictAudit,
  });

  if (options.write) {
    writeJson(KFD1_WITNESS_PATH, kfd1Witness);
    writeJson(KFD1_RELEASE_GATE_PATH, kfd1Gate);
    writeJson(KFD1_VERIFY_RESULT_PATH, kfd1VerifyResult);
    writeJson(KFD3_PREBUILD_WITNESS_PATH, prebuildWitness);
    writeJson(KFD3_ARTIFACT_WITNESS_PATH, artifactWitness);
    writeJson(KFD3_QUERY_PATH, query);
    writeJson(SUMMARY_PATH, summary);
  } else {
    assertCurrent(
      KFD3_PREBUILD_WITNESS_PATH,
      prebuildWitness,
      'Buildchain KFD-3 prebuild witness',
    );
    assertCurrent(
      KFD3_ARTIFACT_WITNESS_PATH,
      artifactWitness,
      'Buildchain KFD-3 artifact witness',
    );
    assertCurrent(KFD3_QUERY_PATH, query, 'Buildchain KFD-3 capability query');
    for (let index = 0; index < productGates.gates.length; index += 1) {
      assertCurrentIfPresent(
        KFD_PRODUCT_GATE_INPUT_PATHS[index],
        productGates.inputs[index],
        `${KFD_PRODUCT_GATE_STANDARDS[index]} product-gate input`,
      );
      assertCurrentIfPresent(
        KFD_PRODUCT_GATE_PATHS[index],
        productGates.gates[index],
        `${KFD_PRODUCT_GATE_STANDARDS[index]} product gate`,
      );
    }
    assertCurrentIfPresent(
      KFD_SUPPORT_PROJECTION_PATH,
      productGates.projection,
      'Buildchain KFD support projection',
    );
    assertCurrentIfPresent(
      SUMMARY_PATH,
      summary,
      'Buildchain KFD evidence summary',
    );
  }

  const output = {
    ok: true,
    mode: options.write ? 'write' : 'check',
    registry: {
      path: KFD3_DEFAULT_REGISTRY_PATH,
      packagedPath: 'developer/sdk/kfd/kfd-3-surfaces.json',
      mode: strictAudit.mode,
      sourceOfTruth: strictAudit.sourceOfTruth,
      surfaceCount: registry.surfaces.length,
      sha256: options.write
        ? sha256File(KFD3_REGISTRY_PATH)
        : sha256Text(renderJson(registry)),
      strictAudit,
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
  const upstreamAggregate = buildUpstreamKfdAggregate({ quiet: options.json });
  const registry = buildKfd3Registry(upstreamAggregate);
  const query = await buildQuery(registry);
  if (options.json) process.stdout.write(renderJson(query));
  else
    process.stdout.write(
      `[kfd] query: ${query.product} capabilities=${query.capabilities?.length || 0}\n`,
    );
}

try {
  const options = parseArgs(process.argv.slice(2));
  runtime = await loadBuildchainKfdRuntime();
  if (!runtime && options.check)
    process.stdout.write(renderJson(checkColdBuildchainKfd(ROOT)));
  else if (!runtime)
    throw new Error(
      'Buildchain KFD runtime is required for write, query, and artifact-witness modes',
    );
  else if (options.artifactWitness) await runArtifactWitness(options);
  else if (options.query) await runQuery(options);
  else await runCheckOrWrite(options);
} catch (error) {
  console.error(
    `[kfd] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
