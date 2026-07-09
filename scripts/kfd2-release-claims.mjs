// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDCHAIN_KFD2_DIR } from '@kungfu-tech/buildchain/buildchain-layout';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(
  ROOT,
  'framework',
  'release',
  'kfd-2',
  'kungfu-release-claims.registry.json',
);
const DEFAULT_OUTPUT_DIR = path.join(ROOT, BUILDCHAIN_KFD2_DIR);
const CLAIM_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CANONICAL_STATUSES = new Set([
  'declared',
  'audited',
  'enforced',
  'not-applicable',
]);
const ENUMERABILITY = new Set([
  'closed-world',
  'declared-open',
  'sampled',
  'manual',
]);

function usage() {
  return `Usage:
  node scripts/kfd2-release-claims.mjs --check [--json] [--channel <channel>] [--tag <tag>] [--source-sha <sha>]
  node scripts/kfd2-release-claims.mjs --write [--output-dir <dir>] [--json] [--channel <channel>] [--tag <tag>] [--source-sha <sha>]

Writes:
  <output-dir>/release-claims.json
  <output-dir>/claims/<claim-id>.json
  <output-dir>/buildchain-claim-args.txt
`;
}

function parseArgs(argv) {
  const options = {
    check: false,
    write: false,
    json: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    channel: '',
    tag: '',
    sourceSha: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === '--output-dir' || arg === '--out-dir') {
      i += 1;
      options.outputDir = path.resolve(ROOT, argv[i] || '');
    } else if (arg === '--channel') {
      i += 1;
      options.channel = argv[i] || '';
    } else if (arg === '--tag') {
      i += 1;
      options.tag = argv[i] || '';
    } else if (arg === '--source-sha') {
      i += 1;
      options.sourceSha = argv[i] || '';
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.check && !options.write) options.check = true;
  if (options.check && options.write) {
    throw new Error('choose either --check or --write, not both');
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function rel(file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== ROOT) {
    return resolved.split(path.sep).join('/');
  }
  return path.relative(ROOT, resolved).split(path.sep).join('/');
}

function resolveRepoPath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('expected a repository-relative path');
  }
  const resolved = path.resolve(ROOT, relativePath);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== ROOT) {
    throw new Error(`path escapes repository root: ${relativePath}`);
  }
  return resolved;
}

function filePointer(input) {
  const file = resolveRepoPath(input.path);
  if (!fs.existsSync(file)) {
    throw new Error(`missing evidence path: ${input.path}`);
  }
  const pointer = {
    kind: input.kind || 'file',
    path: rel(file),
    sha256: sha256File(file),
  };
  if (input.schemaId) pointer.schemaId = input.schemaId;
  if (input.digest) pointer.digest = input.digest;
  if (input.specifier) pointer.specifier = input.specifier;
  return pointer;
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

function sourceSha(options) {
  return options.sourceSha || gitValue(['rev-parse', 'HEAD']) || 'unknown';
}

function version() {
  return String(readJson(path.join(ROOT, 'lerna.json')).version || '');
}

function registrySha() {
  return sha256File(REGISTRY_PATH);
}

function validateRegistry(registry) {
  const errors = [];
  if (registry?.schema !== 'kungfu.kfd-2-release-claims.registry/v1') {
    errors.push(
      'registry schema must be kungfu.kfd-2-release-claims.registry/v1',
    );
  }
  if (registry?.kfd?.standard !== 'kfd-2') {
    errors.push('registry.kfd.standard must be kfd-2');
  }
  if (registry?.kfd?.contract !== 'kfd-2-release-claims') {
    errors.push('registry.kfd.contract must be kfd-2-release-claims');
  }
  if (!Array.isArray(registry?.claims) || registry.claims.length === 0) {
    errors.push('registry.claims must be a non-empty array');
  }
  const ids = new Set();
  for (const [index, claim] of (registry.claims || []).entries()) {
    const label = `claims[${index}]`;
    if (!CLAIM_ID_RE.test(String(claim.id || ''))) {
      errors.push(`${label}.id must match ${CLAIM_ID_RE}`);
    } else if (ids.has(claim.id)) {
      errors.push(`${label}.id duplicates ${claim.id}`);
    }
    ids.add(claim.id);
    if (!claim.statement) errors.push(`${label}.statement is required`);
    if (!claim.source?.path) errors.push(`${label}.source.path is required`);
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      errors.push(`${label}.evidence must be non-empty`);
    }
    if (!Array.isArray(claim.artifacts) || claim.artifacts.length === 0) {
      errors.push(`${label}.artifacts must be non-empty`);
    }
    if (!claim.auditBoundary?.scope)
      errors.push(`${label}.auditBoundary.scope is required`);
    if (!ENUMERABILITY.has(String(claim.auditBoundary?.enumerability || ''))) {
      errors.push(`${label}.auditBoundary.enumerability is invalid`);
    }
    if (!Array.isArray(claim.residualRisk)) {
      errors.push(`${label}.residualRisk must be an array, even when empty`);
    }
    for (const key of [
      'sourceOwner',
      'verificationOwner',
      'releaseDecisionOwner',
    ]) {
      if (!claim.responsibility?.[key])
        errors.push(`${label}.responsibility.${key} is required`);
    }
    if (!CANONICAL_STATUSES.has(String(claim.status || ''))) {
      errors.push(`${label}.status must be a KFD release claim status`);
    }
  }
  return errors;
}

function canonicalClaim(claim) {
  const source = filePointer(claim.source);
  return {
    id: claim.id,
    statement: claim.statement,
    category: claim.category || 'kfd-2',
    source,
    evidence: claim.evidence.map((entry) => ({
      type: entry.type || 'file',
      pointer: filePointer({ ...entry, kind: entry.kind || 'file' }),
      description: entry.description || '',
    })),
    verification: {
      command:
        claim.verification?.command ||
        'node scripts/kfd2-release-claims.mjs --check',
      expectedResult: claim.verification?.expectedResult || 'pass',
    },
    auditBoundary: {
      scope: claim.auditBoundary.scope,
      enumerability: claim.auditBoundary.enumerability,
      exclusions: claim.auditBoundary.exclusions || [],
    },
    residualRisk: claim.residualRisk,
    responsibility: claim.responsibility,
    status: claim.status,
  };
}

function buildCanonicalReleaseClaims(registry, options) {
  const releaseVersion = version();
  return {
    schemaVersion: 1,
    contract: registry.kfd.contract,
    standard: registry.kfd.standard,
    product: registry.product,
    release: {
      version: releaseVersion,
      channel: options.channel || registry.releaseDefaults?.channel || 'local',
      tag:
        options.tag ||
        `${registry.releaseDefaults?.tagPrefix || 'v'}${releaseVersion}`,
      sourceSha: sourceSha(options),
    },
    claims: registry.claims.map((claim) => canonicalClaim(claim)),
    schemaEvolution: {
      interfaceVersion: registry.kfd.interfaceVersion || 1,
      compatibilityRule:
        'Compatible additions may keep schemaVersion 1; required-field or semantic changes require a new KFD-owned interface version.',
    },
  };
}

function buildBuildchainClaimProjection(claim) {
  const source = filePointer(claim.source);
  const evidence = claim.evidence.map((entry) => ({
    type: entry.type || 'file',
    pointer: filePointer({ ...entry, kind: entry.kind || 'file' }),
    description: entry.description || '',
  }));
  const artifactCoordinates = claim.artifacts.map((artifact) => {
    const pointer = filePointer({ kind: 'file', path: artifact.path });
    return {
      name: artifact.name || path.basename(artifact.path),
      path: pointer.path,
      sha256: pointer.sha256,
      expectedPackagePath: artifact.expectedPackagePath || '',
    };
  });
  return {
    id: claim.id,
    public: true,
    claim: claim.statement,
    sourceBindings: [
      {
        role: 'claim-source',
        kind: source.kind,
        path: source.path,
        sha256: source.sha256,
      },
    ],
    machineEvidence: evidence,
    hashes: {
      registrySha256: registrySha(),
      sourceSha256: source.sha256,
      evidenceSha256: evidence.map((entry) => ({
        path: entry.pointer.path,
        sha256: entry.pointer.sha256,
      })),
      artifactSha256: artifactCoordinates.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
      })),
    },
    artifacts: artifactCoordinates,
    verification: {
      result:
        claim.residualRisk.length === 0
          ? 'passed'
          : 'passed-with-residual-risk',
      command:
        claim.verification?.command ||
        'node scripts/kfd2-release-claims.mjs --check',
      expectedResult: claim.verification?.expectedResult || 'pass',
    },
    auditBoundary: {
      scope: claim.auditBoundary.scope,
      enumerability: claim.auditBoundary.enumerability,
      exclusions: claim.auditBoundary.exclusions || [],
    },
    responsibility: claim.responsibility,
    residualRisk: claim.residualRisk,
    canonicalStatus: claim.status,
  };
}

function validateCanonical(document) {
  const errors = [];
  if (document.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (document.contract !== 'kfd-2-release-claims') {
    errors.push('contract must be kfd-2-release-claims');
  }
  if (document.standard !== 'kfd-2') errors.push('standard must be kfd-2');
  if (!document.product?.name) errors.push('product.name is required');
  if (!document.release?.version) errors.push('release.version is required');
  if (!document.release?.channel) errors.push('release.channel is required');
  if (!Array.isArray(document.claims) || document.claims.length === 0) {
    errors.push('claims must be non-empty');
  }
  for (const [index, claim] of (document.claims || []).entries()) {
    const label = `claims[${index}]`;
    if (!CLAIM_ID_RE.test(claim.id)) errors.push(`${label}.id is invalid`);
    if (!claim.statement) errors.push(`${label}.statement is required`);
    if (!claim.source?.kind) errors.push(`${label}.source.kind is required`);
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      errors.push(`${label}.evidence must be non-empty`);
    }
    if (!claim.auditBoundary?.scope)
      errors.push(`${label}.auditBoundary.scope is required`);
    if (!claim.responsibility?.sourceOwner) {
      errors.push(`${label}.responsibility.sourceOwner is required`);
    }
    if (!CANONICAL_STATUSES.has(claim.status))
      errors.push(`${label}.status is invalid`);
  }
  return errors;
}

function validateProjection(claim) {
  const missing = [];
  if (!Array.isArray(claim.sourceBindings) || claim.sourceBindings.length === 0)
    missing.push('declared-sources');
  if (
    !Array.isArray(claim.machineEvidence) ||
    claim.machineEvidence.length === 0
  )
    missing.push('machine-readable-evidence');
  if (!claim.hashes || Object.keys(claim.hashes).length === 0)
    missing.push('hashes');
  if (!Array.isArray(claim.artifacts) || claim.artifacts.length === 0)
    missing.push('artifact-coordinates');
  if (!claim.verification?.result) missing.push('verification-result');
  if (!claim.auditBoundary || Object.keys(claim.auditBoundary).length === 0)
    missing.push('audit-boundary');
  if (!claim.responsibility?.sourceOwner) missing.push('responsibility-state');
  if (!Array.isArray(claim.residualRisk)) missing.push('residual-risk');
  return missing;
}

function buildAll(options) {
  const registry = readJson(REGISTRY_PATH);
  const registryErrors = validateRegistry(registry);
  if (registryErrors.length) {
    throw new Error(
      `registry invalid:\n${registryErrors.map((e) => `- ${e}`).join('\n')}`,
    );
  }
  const canonical = buildCanonicalReleaseClaims(registry, options);
  const canonicalErrors = validateCanonical(canonical);
  if (canonicalErrors.length) {
    throw new Error(
      `canonical release claims invalid:\n${canonicalErrors.map((e) => `- ${e}`).join('\n')}`,
    );
  }
  const buildchainClaims = registry.claims.map((claim) =>
    buildBuildchainClaimProjection(claim),
  );
  const projectionErrors = [];
  for (const claim of buildchainClaims) {
    const missing = validateProjection(claim);
    if (missing.length > 0) {
      projectionErrors.push(`${claim.id}: missing ${missing.join(', ')}`);
    }
  }
  if (projectionErrors.length) {
    throw new Error(
      `Buildchain projection invalid:\n${projectionErrors.map((e) => `- ${e}`).join('\n')}`,
    );
  }
  return { registry, canonical, buildchainClaims };
}

function writeOutput(outputDir, canonical, buildchainClaims) {
  const claimsDir = path.join(outputDir, 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  const canonicalPath = path.join(outputDir, 'release-claims.json');
  fs.writeFileSync(canonicalPath, renderJson(canonical));
  const claimPaths = [];
  for (const claim of buildchainClaims) {
    const claimPath = path.join(claimsDir, `${claim.id}.json`);
    fs.writeFileSync(claimPath, renderJson(claim));
    claimPaths.push(claimPath);
  }
  const argText = claimPaths
    .map((claimPath) => `--kfd-2-claim-json ${rel(claimPath)}`)
    .join('\n');
  fs.writeFileSync(
    path.join(outputDir, 'buildchain-claim-args.txt'),
    `${argText}\n`,
  );
  return { canonicalPath, claimPaths };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { canonical, buildchainClaims } = buildAll(options);
  const summary = {
    ok: true,
    registry: rel(REGISTRY_PATH),
    registrySha256: registrySha(),
    releaseClaims: {
      contract: canonical.contract,
      standard: canonical.standard,
      version: canonical.release.version,
      channel: canonical.release.channel,
      tag: canonical.release.tag,
      sourceSha: canonical.release.sourceSha,
      claimCount: canonical.claims.length,
      sha256: sha256Buffer(Buffer.from(renderJson(canonical))),
    },
    buildchainProjection: {
      claimInput: '--kfd-2-claim-json',
      claimCount: buildchainClaims.length,
      claims: buildchainClaims.map((claim) => ({
        id: claim.id,
        status: claim.residualRisk.length === 0 ? 'passed' : 'downgraded',
        residualRisk: claim.residualRisk.length,
      })),
    },
  };
  if (options.write) {
    const written = writeOutput(options.outputDir, canonical, buildchainClaims);
    summary.outputDir = rel(options.outputDir);
    summary.releaseClaims.path = rel(written.canonicalPath);
    summary.buildchainProjection.claims = written.claimPaths.map(
      (claimPath, index) => ({
        ...summary.buildchainProjection.claims[index],
        path: rel(claimPath),
      }),
    );
  }
  if (options.json) {
    process.stdout.write(renderJson(summary));
  } else if (options.write) {
    console.log(
      `[kfd2] wrote ${summary.releaseClaims.path} and ${buildchainClaims.length} Buildchain claim projection(s)`,
    );
  } else {
    console.log(
      `[kfd2] ok: ${canonical.claims.length} claim(s), registry sha256:${summary.registrySha256}`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[kfd2] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
