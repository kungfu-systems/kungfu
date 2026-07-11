#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
  BUILDCHAIN_KFD1_RELEASE_GATE_PATH,
  BUILDCHAIN_KFD1_VERIFY_RESULT_PATH,
  BUILDCHAIN_KFD2_DIR,
  BUILDCHAIN_KFD2_REGISTRY_PATH,
  BUILDCHAIN_KFD3_DIR,
  BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH as KFD3_DEFAULT_REGISTRY_PATH,
} from '@kungfu-tech/buildchain/buildchain-layout';
import { kfd1, kfd2, kfd3 } from '@kungfu-tech/buildchain/kfd';

const KFD3_SURFACE_REGISTRY_CONTRACT =
  'kungfu-buildchain-kfd-3-surface-registry';
const {
  queryCapabilities: queryKfd3Capabilities,
  readSurfaceRegistry: readKfd3SurfaceRegistry,
} = kfd3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
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
const SDK_CLI_PATH = path.join(ROOT, 'developer', 'sdk', 'src', 'sdk.js');
const PRODUCT_PACKAGE_PATH = path.join(ROOT, 'product', 'package.json');
const MASTER_CLI_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'cli',
  'commands',
  'master.py',
);
const MASTER_SERVICE_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'master_service.py',
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
  'node scripts/buildchain-kfd-evidence.mjs --artifact-witness --json';
const STRICT_KFD3_MODE = 'strict-buildchain-managed-registry';
const KFD_EVIDENCE_SOURCE_SHA =
  process.env.KUNGFU_KFD_SOURCE_SHA || 'local-dev-snapshot';

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
      status: 'schema-only',
      mode: 'schema-only',
      source: '@kungfu-tech/kfd/standards.json',
      schemaCount: Object.keys(kfd4Schemas?.schemaPaths || {}).length,
      schemaCommand: 'kungfu sdk kfd 4 schema --json',
      residualRisk: [
        'Buildchain 2.10.8 exposes KFD-4 as schema-only; no release verification protocol is claimed.',
      ],
    },
  };
}

function buildUpstreamKfdAggregate() {
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

function fileSurface({
  id,
  name,
  kind,
  sourcePath,
  evidencePath,
  maturity,
  distribution,
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
      owner: 'kungfu',
      source: 'scripts/buildchain-kfd-evidence.mjs',
      sourcePath,
    },
    ...(distribution ? { distribution } : {}),
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
      sourcePath: 'developer/sdk/src/sdk.js',
      evidencePath: 'developer/sdk/kfd/upstream-aggregate.json',
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
      id: 'kungfu.sdk.product.cli',
      name: 'kungfu sdk product cli dist',
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
      id: 'kungfu.master.service',
      name: 'kungfu master status|start|stop|restart|service plan|install|uninstall|status',
      kind: 'cli',
      sourcePath: rel(MASTER_CLI_PATH),
      evidencePath: rel(MASTER_SERVICE_PATH),
      maturity: 'draft',
    }),
    fileSurface({
      id: 'kungfu.gui.master-tray',
      name: 'Kungfu GUI menu-bar/system-tray master residency controls',
      kind: 'gui',
      sourcePath: 'framework/gui/src/main/index.ts',
      evidencePath: 'docs/master-service.md',
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
      // (crates/shifu/src/registrar.rs). Declaration, not script — a repo
      // onboards its artifacts by stating them here.
      distribution: {
        registrar: 'shifu',
        tasks: ['dist', 'package'],
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
            path: rel(AGENT_COMMANDS_PATH),
            role: 'kungfu-agent-command-catalog',
          },
          {
            path: rel(SDK_CLI_PATH),
            role: 'kungfu-sdk-product-entrypoints',
          },
          {
            path: rel(MASTER_CLI_PATH),
            role: 'kungfu-master-service-entrypoints',
          },
          {
            path: rel(MASTER_SERVICE_PATH),
            role: 'kungfu-master-service-supervisor-runtime',
          },
          {
            path: 'framework/gui/src/main/index.ts',
            role: 'kungfu-gui-master-tray-surface',
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
  const buildchainRegistry = readKfd3SurfaceRegistry({
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

function buildKfd1Witness() {
  return runNodeScript([
    'developer/sdk/src/sdk.js',
    'contract',
    'witness',
    '--json',
  ]);
}

function buildKfd1ReleaseGate(kfd1Witness) {
  return kfd1.createReleaseGateEvidence({
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
  const issues = kfd1.validateReleaseGateEvidence(kfd1Gate);
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-1-verify-result',
    ok: issues.length === 0,
    issues,
  };
}

function buildKfd2Claims({ write, outputDir = KFD2_OUTPUT_DIR }) {
  const result = write
    ? kfd2.writeProductClaimOutputs({
        cwd: ROOT,
        outputDir: rel(outputDir),
        sourceSha: KFD_EVIDENCE_SOURCE_SHA,
      })
    : kfd2.checkProductClaimOutputs({
        cwd: ROOT,
        outputDir: rel(outputDir),
        sourceSha: KFD_EVIDENCE_SOURCE_SHA,
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

function writeKfd2PackagedOutputs(outputDir) {
  return buildKfd2Claims({ write: true, outputDir });
}

function assertCurrentKfd2Output(outputDir, label) {
  try {
    return buildKfd2Claims({ write: false, outputDir });
  } catch (error) {
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function registryCapabilityQuery(registry, { warning = '' } = {}) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-3-capability-query',
    product: productDisplayName(),
    source: {
      type: 'kungfu-buildchain-kfd3-registry',
      path: KFD3_DEFAULT_REGISTRY_PATH,
      note: 'Kungfu declares agent/SDK/product surfaces in the Buildchain-managed KFD-3 registry; Buildchain 2.10 standard detectors are intentionally conservative for product-specific surfaces.',
    },
    status: 'declared',
    warning,
    capabilities: registry.surfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      name: surface.name,
      state: surface.state || surface.availability || 'declared',
      detected: true,
      enforced:
        surface.state === 'enforced' || surface.enforcement === 'enforced',
      sourcePath: surface.sourcePath,
      artifactPath: surface.artifactPath || surface.evidencePath,
      kfd1Basis: {
        registryPath: KFD3_DEFAULT_REGISTRY_PATH,
        sourcePath: surface.sourcePath,
        artifactPath: surface.artifactPath || surface.evidencePath,
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
      registryPath: KFD3_DEFAULT_REGISTRY_PATH,
    });
    if (query.status === 'failed' || query.kfd?.kfd3 === 'failed') {
      return registryCapabilityQuery(registry, {
        warning:
          'Buildchain standard detector could not cover Kungfu product-specific declared surfaces; using the Buildchain-managed registry projection.',
      });
    }
    return query;
  } catch (error) {
    return registryCapabilityQuery(registry, {
      warning: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildSummary({
  registry,
  upstreamAggregate,
  kfd1Witness,
  kfd1Gate,
  kfd1VerifyResult,
  kfd2Summary,
  prebuildWitness,
  strictAudit,
}) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-evidence-summary',
    product: registry.product,
    buildchain: {
      minimumVersion: '2.10.8',
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
    kfd4: {
      status: 'schema-only',
      source: '@kungfu-tech/kfd/standards.json',
      schemaCommand: 'kungfu sdk kfd 4 schema --json',
      residualRisk:
        'Buildchain 2.10.8 exposes KFD-4 as schema-only; no release verification protocol is claimed.',
    },
  };
}

async function runArtifactWitness(options) {
  const upstreamAggregate = buildUpstreamKfdAggregate();
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
  const upstreamAggregate = buildUpstreamKfdAggregate();
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
  const kfd2Summary = options.write
    ? writeKfd2PackagedOutputs(KFD2_OUTPUT_DIR)
    : assertCurrentKfd2Output(KFD2_OUTPUT_DIR, 'Buildchain KFD-2 output');
  if (options.write) {
    writeIfChanged(KFD3_REGISTRY_PATH, registry);
    writeIfChanged(SDK_KFD3_CANONICAL_REGISTRY_PATH, registry);
    writeIfChanged(SDK_KFD_UPSTREAM_AGGREGATE_PATH, upstreamAggregate);
    writeJson(SDK_KFD1_WITNESS_PATH, kfd1Witness);
    writeJson(SDK_KFD1_RELEASE_GATE_PATH, kfd1Gate);
    writeJson(SDK_KFD1_VERIFY_RESULT_PATH, kfd1VerifyResult);
    writeKfd2PackagedOutputs(SDK_KFD2_OUTPUT_DIR);
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
    assertCurrentKfd2Output(SDK_KFD2_OUTPUT_DIR, 'SDK packaged KFD-2 output');
  }
  const strictAudit = buildStrictBuildchainAudit(registry);
  assertStrictBuildchainAudit(strictAudit);
  const prebuildWitness = buildKfd3PrebuildWitness(registry);
  const artifactWitness = buildKfd3ArtifactWitness(registry, {
    runVerify: true,
  });
  const query = await buildQuery(registry);
  const summary = buildSummary({
    registry,
    upstreamAggregate,
    kfd1Witness,
    kfd1Gate,
    kfd1VerifyResult,
    kfd2Summary,
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
  const upstreamAggregate = buildUpstreamKfdAggregate();
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
  if (options.artifactWitness) await runArtifactWitness(options);
  else if (options.query) await runQuery(options);
  else await runCheckOrWrite(options);
} catch (error) {
  console.error(
    `[kfd] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
