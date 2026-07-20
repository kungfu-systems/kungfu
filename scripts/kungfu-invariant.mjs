#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH =
  'framework/invariant/kungfu-invariant-system.contract.json';
const REGISTRY_PATH = 'framework/invariant/kungfu-invariant.registry.json';
const REGISTRY_SCHEMA_PATH =
  'framework/invariant/schema/invariant-registry-v1.schema.json';
const EVIDENCE_SCHEMA_PATH =
  'framework/invariant/schema/invariant-evidence-v1.schema.json';
const PASSPORT_SCHEMA_PATH =
  'framework/invariant/schema/invariant-passport-v1.schema.json';
const OBJECT_SCHEMA_PATH =
  'framework/invariant/schema/episode-object-receipt-v1.schema.json';
const SUCCESSOR_SCHEMA_PATH =
  'framework/invariant/schema/invariant-successor-v1.schema.json';
const EPISODE_INPUT_SCHEMA_PATH =
  'framework/core/tests/qualification/episode/schemas/episode-qualification-v1.schema.json';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERDICTS = ['verified', 'falsified', 'unqualified', 'not-applicable'];
const LEVELS = ['source', 'native', 'runtime', 'object', 'release'];

function readJson(relativeOrAbsolute) {
  const absolute = path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(ROOT, relativeOrAbsolute);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

export function digest(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : typeof value === 'string'
      ? Buffer.from(value)
      : Buffer.from(canonicalJson(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function semanticDocument(value, rootField) {
  const result = structuredClone(value);
  Reflect.deleteProperty(result, rootField);
  Reflect.deleteProperty(result, 'observedAt');
  if (result.checker) Reflect.deleteProperty(result.checker, 'durationMs');
  return result;
}

function rooted(value, rootField) {
  const result = structuredClone(value);
  result[rootField] = digest(semanticDocument(result, rootField));
  return result;
}

function domainDigest(prefix, domain, value) {
  const pythonStable = (item) => {
    if (Array.isArray(item)) return item.map(pythonStable);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, pythonStable(item[key])]),
      );
    return item;
  };
  return digest(
    Buffer.concat([
      Buffer.from(`${prefix}\0${domain}\0`),
      Buffer.from(JSON.stringify(pythonStable(value))),
    ]),
  );
}

function reportRoot(value, prefix) {
  const semantic = structuredClone(value);
  Reflect.deleteProperty(semantic, 'reportRoot');
  return domainDigest(prefix, 'report', semantic);
}

function markdownMetadata(filePath) {
  const source = fs.readFileSync(path.join(ROOT, filePath), 'utf8');
  const read = (key) =>
    source.match(new RegExp(`^${key}:\\s*([^\\n]+)$`, 'mu'))?.[1]?.trim() ||
    null;
  return {
    decisionStatus: read('decision_status'),
    implementationStatus: read('implementation_status'),
  };
}

function normalizeReleasePlatform(value) {
  if (value === 'windows-x64' || value === 'windows-x86_64') return 'win32-x64';
  if (value === 'linux-x86_64') return 'linux-x64';
  return value;
}

function artifactPlatform(name) {
  const match = name.match(
    /^kungfu-episodes-cli-(darwin-arm64|linux-x64|windows-x64)\.(?:tar\.gz|zip)$/u,
  );
  return match ? normalizeReleasePlatform(match[1]) : null;
}

export function discoverReleaseArtifacts(directory) {
  const artifacts = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (
        entry.isDirectory() &&
        !['.git', 'node_modules', '.venv'].includes(entry.name)
      )
        visit(absolute);
      else if (entry.isFile() && artifactPlatform(entry.name))
        artifacts.push({
          name: entry.name,
          digest: digest(fs.readFileSync(absolute)),
        });
    }
  };
  visit(directory);
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

export function evaluateExitMigrationReleaseClaims(options = {}) {
  const contract = options.contract || readJson(CONTRACT_PATH);
  const policy = contract.releaseGate.exitMigrationClaims;
  const clean =
    options.cleanRuntime || readJson(policy.evidence.cleanRuntime.path);
  const provider =
    options.providerMigration ||
    readJson(policy.evidence.providerMigration.path);
  const exitContract =
    options.exitContract || readJson(policy.exitContract.path);
  const adr = options.adr || markdownMetadata(policy.acceptedAdr.path);
  const releaseArtifacts = options.releaseArtifacts || [];
  const profile = options.releaseProfile || policy.profile;
  const availableProviders = new Set(
    options.availableProviders ||
      Object.entries(provider.capabilities?.providers || {})
        .filter(([, item]) => item.available)
        .map(([name]) => name),
  );
  const targetPlatforms = [
    ...new Set(options.targetPlatforms || policy.requiredPlatforms),
  ].sort();
  const diagnostics = [];
  const check = (condition, code, message) => {
    if (!condition) diagnostics.push(diagnostic(code, message));
  };
  const freshReports = [
    {
      id: 'clean-runtime',
      path: policy.evidence.cleanRuntime.path,
      schema: clean.schema,
      sourceRevision: policy.evidence.cleanRuntime.sourceRevision,
      expectedRoot: policy.evidence.cleanRuntime.reportRoot,
      observedRoot: reportRoot(clean, 'kungfu.exit-clean-runtime/v1'),
      declaredRoot: clean.reportRoot,
    },
    {
      id: 'provider-migration',
      path: policy.evidence.providerMigration.path,
      schema: provider.schema,
      sourceRevision: policy.evidence.providerMigration.sourceRevision,
      expectedRoot: policy.evidence.providerMigration.reportRoot,
      observedRoot: reportRoot(
        provider,
        'kungfu.provider-migration-product/v1',
      ),
      declaredRoot: provider.reportRoot,
    },
  ];
  for (const report of freshReports) {
    const declared =
      policy.evidence[
        report.id === 'clean-runtime' ? 'cleanRuntime' : 'providerMigration'
      ];
    check(
      report.schema === declared.schema,
      'release-evidence-schema-mismatch',
      `${report.id} evidence schema is not the declared schema.`,
    );
    check(
      report.expectedRoot === report.declaredRoot &&
        report.expectedRoot === report.observedRoot,
      'release-evidence-stale-or-tampered',
      `${report.id} evidence root is missing, stale, or tampered.`,
    );
    check(
      report.path.includes(report.sourceRevision),
      'release-evidence-source-unbound',
      `${report.id} evidence path is not bound to its source revision.`,
    );
  }
  check(
    canonicalJson(adr) ===
      canonicalJson({
        decisionStatus: policy.acceptedAdr.decisionStatus,
        implementationStatus: policy.acceptedAdr.implementationStatus,
      }),
    'release-adr-status-drift',
    'ADR decision or implementation status drifted from the release policy.',
  );
  check(
    canonicalJson(exitContract.status) ===
      canonicalJson(policy.exitContract.status),
    'release-exit-contract-status-drift',
    'Exit Bundle contract status drifted from the release policy.',
  );
  check(
    clean.status === 'qualified' &&
      clean.packages?.full?.verdict === 'verified',
    'release-full-bundle-unqualified',
    'The retained full Exit Bundle evidence is not qualified.',
  );
  check(
    clean.packages?.thin?.verdict === 'degraded',
    'release-thin-downgrade-missing',
    'Thin Exit Bundle evidence no longer declares a degraded verdict.',
  );
  check(
    provider.verdict === 'qualified' &&
      provider.rollback?.ok === true &&
      provider.noRocksCandidate?.targetBindingPublished === false,
    'release-provider-migration-unqualified',
    'Provider migration, rollback, or provider-unavailable fencing is unqualified.',
  );
  check(
    clean.artifact?.digest === provider.artifact?.digest,
    'release-artifact-evidence-mixed',
    'Exit and provider reports do not bind the same installed artifact.',
  );
  const expectedArtifactDigest = clean.artifact?.digest || null;
  const qualifiedPlatforms = [
    ...new Set(
      (clean.releaseMatrix || [])
        .filter((item) => item.verdict === 'qualified')
        .map((item) => normalizeReleasePlatform(item.platform))
        .filter((platform) =>
          (provider.qualifiedPlatforms || [])
            .map(normalizeReleasePlatform)
            .includes(platform),
        ),
    ),
  ].sort();
  if (targetPlatforms.length === 0)
    diagnostics.push(
      diagnostic(
        'release-artifact-missing',
        'No exact release artifact was supplied for claim verification.',
      ),
    );
  for (const platform of targetPlatforms) {
    const artifacts = releaseArtifacts.filter(
      (item) => artifactPlatform(item.name) === platform,
    );
    if (artifacts.length === 0)
      diagnostics.push(
        diagnostic(
          'release-artifact-missing',
          `${platform} has no candidate artifact.`,
        ),
      );
    else
      check(
        artifacts.some((item) => item.digest === expectedArtifactDigest),
        'release-artifact-stale-or-tampered',
        `${platform} has no artifact matching the retained installed-product witness.`,
      );
    check(
      qualifiedPlatforms.includes(platform),
      'release-platform-unqualified',
      `${platform} lacks exact clean-runtime and provider-migration qualification.`,
    );
  }
  check(
    profile === policy.profile,
    'release-profile-unqualified',
    `${profile} is not the release-qualified Exit Bundle profile.`,
  );
  for (const providerName of policy.requiredProviders)
    check(
      availableProviders.has(providerName),
      'release-provider-unavailable',
      `Required provider ${providerName} is unavailable.`,
    );
  const verdict = diagnostics.length ? 'unqualified' : 'verified';
  const downgradeConditions = new Set(
    diagnostics.map((item) => {
      if (item.code === 'release-profile-unqualified') return 'profile-is-thin';
      if (item.code === 'release-provider-unavailable')
        return 'provider-unavailable';
      if (
        [
          'release-artifact-missing',
          'release-artifact-stale-or-tampered',
          'release-platform-unqualified',
        ].includes(item.code)
      )
        return 'platform-not-qualified';
      return 'evidence-not-current';
    }),
  );
  const nextActions = policy.downgrade
    .filter((item) => downgradeConditions.has(item.condition))
    .map((item) => item.nextAction);
  return rooted(
    {
      schema: 'kungfu.exit-migration-release-claims/v1',
      id: policy.id,
      verdict,
      policyRoot: digest(policy),
      artifact: {
        expectedDigest: expectedArtifactDigest,
        observed: releaseArtifacts,
      },
      freshness: {
        mode: 'source-revision-and-content-root',
        current: !diagnostics.some((item) =>
          [
            'release-evidence-schema-mismatch',
            'release-evidence-stale-or-tampered',
            'release-evidence-source-unbound',
            'release-adr-status-drift',
            'release-exit-contract-status-drift',
          ].includes(item.code),
        ),
        reports: freshReports,
      },
      applicability: {
        profile,
        requiredProfile: policy.profile,
        targetPlatforms,
        qualifiedPlatforms,
        requiredPlatforms: policy.requiredPlatforms,
        availableProviders: [...availableProviders].sort(),
        requiredProviders: policy.requiredProviders,
      },
      sourceWitnesses: {
        exitContractRoot: digest(exitContract),
        installedPackageRoot: clean.packages?.full?.packageRoot || null,
        installedVerifierRoot: clean.packages?.full?.verifierRoot || null,
        cleanRuntimeReportRoot: clean.reportRoot,
        providerMigrationReportRoot: provider.reportRoot,
      },
      downgrade: policy.downgrade,
      nextActions,
      residualRisk: [
        ...(clean.knownLimits || []),
        ...(provider.nonClaims || []),
        ...(provider.resume?.residual_risks || []),
      ],
      diagnostics,
    },
    'claimRoot',
  );
}

function decodePointerToken(token) {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function resolvePointer(value, pointer = '') {
  if (pointer === '') return value;
  if (!pointer.startsWith('/'))
    throw new Error(`invalid JSON pointer '${pointer}'`);
  return pointer
    .slice(1)
    .split('/')
    .map(decodePointerToken)
    .reduce((current, token) => {
      if (
        current === null ||
        typeof current !== 'object' ||
        !(token in current)
      ) {
        throw new Error(
          `JSON pointer '${pointer}' does not resolve at '${token}'`,
        );
      }
      return current[token];
    }, value);
}

function pointerValue(binding) {
  return resolvePointer(readJson(binding.path), binding.pointer || '');
}

function pointerRoot(binding) {
  return digest(pointerValue(binding));
}

function contractRoot() {
  return digest(readJson(CONTRACT_PATH));
}

function registryRoot(registry = readJson(REGISTRY_PATH)) {
  return digest(registry);
}

function modelBinding(invariant) {
  if (!invariant.model) return null;
  return invariant.model;
}

function refinementBinding(invariant) {
  if (!invariant.refinement) return null;
  const model = modelBinding(invariant);
  return {
    path: model?.path || invariant.source.path,
    pointer: invariant.refinement.pointer,
    root: invariant.refinement.root,
  };
}

function ajv() {
  return new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
}

function validationErrors(validate) {
  return (validate.errors || []).map(
    (item) => `${item.instancePath || '/'} ${item.message || 'invalid'}`,
  );
}

export function validateRegistry(registry = readJson(REGISTRY_PATH)) {
  const validate = ajv().compile(readJson(REGISTRY_SCHEMA_PATH));
  const issues = validate(registry) ? [] : validationErrors(validate);
  const checkerIds = new Set();
  for (const checker of registry.checkers || []) {
    if (checkerIds.has(checker.id))
      issues.push(`duplicate checker id ${checker.id}`);
    checkerIds.add(checker.id);
  }
  const invariantIds = new Set();
  for (const invariant of registry.invariants || []) {
    if (invariantIds.has(invariant.id))
      issues.push(`duplicate invariant id ${invariant.id}`);
    invariantIds.add(invariant.id);
    if (!invariant.id.startsWith(`${invariant.domain}.`)) {
      issues.push(`${invariant.id} does not match domain ${invariant.domain}`);
    }
    for (const checkerId of invariant.checkerIds || []) {
      if (!checkerIds.has(checkerId))
        issues.push(`${invariant.id} references unknown checker ${checkerId}`);
    }
    for (const level of invariant.release?.levels || []) {
      if (
        !(invariant.checkerIds || []).some(
          (id) =>
            registry.checkers.find((checker) => checker.id === id)?.level ===
            level,
        )
      ) {
        issues.push(`${invariant.id} release level ${level} has no checker`);
      }
    }
    if (['constitutional', 'protocol'].includes(invariant.stability)) {
      if (!invariant.model || !invariant.refinement)
        issues.push(`${invariant.id} requires model and refinement`);
    }
  }
  if (!registry.invariants.some((item) => item.domain === 'fact'))
    issues.push('registry has no Fact invariant');
  if (!registry.invariants.some((item) => item.domain === 'episode'))
    issues.push('registry has no Episode invariant');
  return issues;
}

export function synchronizeRegistryRoots(registry = readJson(REGISTRY_PATH)) {
  const next = structuredClone(registry);
  next.contractRoot = contractRoot();
  for (const invariant of next.invariants) {
    invariant.source.root = pointerRoot(invariant.source);
    if (invariant.model) invariant.model.root = pointerRoot(invariant.model);
    if (invariant.refinement) {
      invariant.refinement.root = pointerRoot(refinementBinding(invariant));
    }
  }
  return next;
}

function synchronizePackagedArtifacts(write = false) {
  const centralPath = 'framework/contract/kungfu-contracts.registry.json';
  const central = readJson(centralPath);
  const entry = central.contracts.find(
    (item) => item.surface === 'invariant-system',
  );
  if (!entry)
    throw new Error('central contract registry is missing invariant-system');
  const invariantContract = readJson(CONTRACT_PATH);
  entry.contractSchemaRoot = digest(invariantContract.contractSchema);
  const copies = [
    { source: entry.source, artifact: entry.artifact },
    ...(entry.extraArtifacts || []),
    { source: centralPath, artifact: 'config/kungfu-contracts.registry.json' },
  ];
  const changes = [];
  const centralRendered = `${JSON.stringify(central, null, 2)}\n`;
  if (fs.readFileSync(path.join(ROOT, centralPath), 'utf8') !== centralRendered)
    changes.push(centralPath);
  for (const copy of copies) {
    const sourceBytes =
      copy.source === centralPath
        ? Buffer.from(centralRendered)
        : fs.readFileSync(path.join(ROOT, copy.source));
    const artifactPath = path.join(ROOT, copy.artifact);
    if (
      !fs.existsSync(artifactPath) ||
      !sourceBytes.equals(fs.readFileSync(artifactPath))
    )
      changes.push(copy.artifact);
  }
  if (write) {
    fs.writeFileSync(path.join(ROOT, centralPath), centralRendered);
    for (const copy of copies) {
      const sourceBytes =
        copy.source === centralPath
          ? Buffer.from(centralRendered)
          : fs.readFileSync(path.join(ROOT, copy.source));
      const artifactPath = path.join(ROOT, copy.artifact);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, sourceBytes);
    }
    const policy = spawnSync(
      'node',
      ['developer/sdk/src/sdk.js', 'contract', 'policy', '--write', '--json'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (policy.status !== 0)
      throw new Error(
        `contract policy generation failed: ${(policy.stderr || policy.stdout || '').trim()}`,
      );
    const policySource = path.join(
      ROOT,
      'framework/contract/kungfu-agent-first-canonical-policy.json',
    );
    const policyArtifact = path.join(
      ROOT,
      'config/kungfu-agent-first-canonical-policy.json',
    );
    fs.mkdirSync(path.dirname(policyArtifact), { recursive: true });
    fs.copyFileSync(policySource, policyArtifact);
  }
  return { changes: [...new Set(changes)].sort(), written: write };
}

function rootDrift(registry) {
  const expected = synchronizeRegistryRoots(registry);
  const issues = [];
  if (registry.contractRoot !== expected.contractRoot)
    issues.push('contract-root-drift');
  for (let index = 0; index < registry.invariants.length; index += 1) {
    const current = registry.invariants[index];
    const wanted = expected.invariants[index];
    if (current.source.root !== wanted.source.root)
      issues.push(`${current.id}:source-root-drift`);
    if (current.model?.root !== wanted.model?.root)
      issues.push(`${current.id}:model-root-drift`);
    if (current.refinement?.root !== wanted.refinement?.root)
      issues.push(`${current.id}:refinement-root-drift`);
  }
  return issues;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  return result.stdout.trim();
}

function sourceIdentity() {
  return {
    revision: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    dirty:
      git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
  };
}

export function sourceIdentityFromEvidence(
  evidence = [],
  fallback = sourceIdentity,
) {
  if (evidence.length === 0) return fallback();
  const first = evidence[0]?.source || {};
  const coordinates = new Set(
    evidence.map(
      (item) => `${item.source?.revision || ''}:${item.source?.tree || ''}`,
    ),
  );
  return {
    revision: String(first.revision || ''),
    tree: String(first.tree || ''),
    dirty:
      evidence.some((item) => item.source?.dirty !== false) ||
      coordinates.size !== 1,
  };
}

export function platformId(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return `${platform}-${arch}`;
}

function checkerRoot(checker) {
  const implementationPath = path.join(ROOT, checker.implementation);
  const implementationRoot = fs.existsSync(implementationPath)
    ? digest(fs.readFileSync(implementationPath))
    : digest('missing');
  return digest({ definition: checker, implementationRoot });
}

function diagnostic(code, message) {
  return { code, message };
}

export function createEvidenceEnvelope({
  invariant,
  checker,
  verdict,
  source,
  profile,
  stdout = '',
  stderr = '',
  exitCode = null,
  durationMs = 0,
  diagnostics = [],
  observedAt = new Date().toISOString(),
  currentPlatformId = platformId(),
}) {
  const evidence = {
    schema: 'kungfu.invariant-evidence/v1',
    invariant: {
      id: invariant.id,
      domain: invariant.domain,
      stability: invariant.stability,
      maturity: invariant.maturity,
      scope: invariant.scope,
      quantification: invariant.quantification,
    },
    verdict,
    source: {
      ...source,
      contractRoot: contractRoot(),
      registryRoot: registryRoot(),
      path: invariant.source.path,
      pointer: invariant.source.pointer || '',
      subjectRoot: pointerRoot(invariant.source),
    },
    checker: {
      id: checker.id,
      level: checker.level,
      kind: checker.kind,
      root: checkerRoot(checker),
      exitCode,
      durationMs,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      platformId: currentPlatformId,
      profile,
      node: process.version,
    },
    witness: {
      stdoutRoot: digest(stdout),
      stderrRoot: digest(stderr),
      subjectRoot: pointerRoot(invariant.source),
    },
    diagnostics,
    residualRisk: invariant.residualRisk,
    observedAt,
    evidenceRoot: 'sha256:'.padEnd(71, '0'),
  };
  return rooted(evidence, 'evidenceRoot');
}

function unavailableFailure(stderr) {
  return /(?:not found|enoent|native binding not found|run '.\/shifu build|unavailable|cannot find|missing dependency)/iu.test(
    stderr,
  );
}

export function commandFailureDiagnostic(checkerId, result, limit = 8_000) {
  const excerpt = (value) =>
    String(value || '')
      .trim()
      .slice(-limit);
  const stdout = excerpt(result.stdout);
  const stderr = excerpt(result.stderr);
  return [
    `[invariant-checker:${checkerId}] exit=${result.code ?? 'none'} signal=${result.signal || 'none'} timedOut=${result.timedOut === true}`,
    stdout ? `[invariant-checker:${checkerId}:stdout]\n${stdout}` : '',
    stderr ? `[invariant-checker:${checkerId}:stderr]\n${stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function resolveCheckerCommand(command, platform = process.platform) {
  if (platform === 'win32' && command === './shifu') return '.\\shifu.cmd';
  return command;
}

export function timeoutTerminationPlan(pid, platform = process.platform) {
  if (platform !== 'win32') return null;
  return {
    command: 'taskkill',
    args: ['/PID', String(pid), '/T', '/F'],
  };
}

function runCommand(checker) {
  return new Promise((resolve) => {
    const started = Date.now();
    const [command, ...args] = checker.command;
    const child = spawn(resolveCheckerCommand(command), args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      stderr = append(stderr, `\n${error}`);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const plan = timeoutTerminationPlan(child.pid);
      if (plan) {
        const terminated = spawnSync(plan.command, plan.args, {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
        });
        if (terminated.status !== 0)
          stderr = append(
            stderr,
            `\n[checker-timeout-termination] ${(terminated.stderr || terminated.stdout || terminated.error || 'taskkill failed').toString().trim()}`,
          );
      }
      child.kill('SIGKILL');
    }, checker.timeoutSeconds * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      };
      if (timedOut || code !== 0)
        process.stderr.write(
          `${commandFailureDiagnostic(checker.id, result)}\n`,
        );
      resolve(result);
    });
  });
}

function sourceBindingResult(invariant, registryIssues, driftIssues) {
  const relevantDrift = driftIssues.filter(
    (item) =>
      item === 'contract-root-drift' || item.startsWith(`${invariant.id}:`),
  );
  const issues = [...registryIssues, ...relevantDrift];
  if (issues.length === 0)
    return {
      verdict: 'verified',
      diagnostics: [],
      stdout: canonicalJson(pointerValue(invariant.source)),
      stderr: '',
      exitCode: 0,
      durationMs: 0,
    };
  return {
    verdict: 'falsified',
    diagnostics: issues.map((issue) =>
      diagnostic('source-binding-drift', issue),
    ),
    stdout: '',
    stderr: issues.join('\n'),
    exitCode: 1,
    durationMs: 0,
  };
}

function selectedInvariants(registry, options) {
  const ids = new Set(options.ids);
  const domains = new Set(options.domains);
  return registry.invariants.filter(
    (item) =>
      (ids.size === 0 || ids.has(item.id)) &&
      (domains.size === 0 || domains.has(item.domain)),
  );
}

export async function verifyInvariants(options = {}) {
  const settings = {
    ids: [],
    domains: [],
    levels: ['source'],
    profile: 'default',
    currentPlatformId: platformId(),
    observedAt: new Date().toISOString(),
    ...options,
  };
  const registry = readJson(REGISTRY_PATH);
  const registryIssues = validateRegistry(registry);
  const driftIssues = rootDrift(registry);
  const source = sourceIdentity();
  const invariants = selectedInvariants(registry, settings);
  const levels = new Set(settings.levels);
  const shared = new Map();
  const evidence = [];
  for (const invariant of invariants) {
    for (const checkerId of invariant.checkerIds) {
      const checker = registry.checkers.find(
        (candidate) => candidate.id === checkerId,
      );
      if (!levels.has(checker.level)) continue;
      if (!checker.platforms.includes(settings.currentPlatformId)) {
        evidence.push(
          createEvidenceEnvelope({
            invariant,
            checker,
            verdict: 'not-applicable',
            source,
            profile: settings.profile,
            diagnostics: [
              diagnostic(
                'platform-not-applicable',
                `${settings.currentPlatformId} is excluded by ${checker.id}`,
              ),
            ],
            observedAt: settings.observedAt,
            currentPlatformId: settings.currentPlatformId,
          }),
        );
        continue;
      }
      let result;
      if (checker.id === 'source-binding')
        result = sourceBindingResult(invariant, registryIssues, driftIssues);
      else {
        if (!shared.has(checker.id))
          shared.set(checker.id, await runCommand(checker));
        const commandResult = shared.get(checker.id);
        const unavailable = unavailableFailure(
          `${commandResult.stderr}\n${commandResult.stdout}`,
        );
        const verdict =
          commandResult.timedOut || commandResult.code == null || unavailable
            ? 'unqualified'
            : commandResult.code === 0
              ? 'verified'
              : 'falsified';
        const code = commandResult.timedOut
          ? 'checker-timeout'
          : unavailable
            ? 'checker-unavailable'
            : commandResult.code === 0
              ? 'checker-completed'
              : 'falsifier-hit';
        result = {
          verdict,
          diagnostics:
            commandResult.code === 0
              ? []
              : [
                  diagnostic(
                    code,
                    `${checker.id} exited ${commandResult.code ?? 'without status'}${commandResult.signal ? ` (${commandResult.signal})` : ''}`,
                  ),
                ],
          stdout: commandResult.stdout,
          stderr: commandResult.stderr,
          exitCode: commandResult.code,
          durationMs: commandResult.durationMs,
        };
      }
      evidence.push(
        createEvidenceEnvelope({
          invariant,
          checker,
          source,
          profile: settings.profile,
          observedAt: settings.observedAt,
          currentPlatformId: settings.currentPlatformId,
          ...result,
        }),
      );
    }
  }
  return {
    schema: 'kungfu.invariant-run/v1',
    contractRoot: contractRoot(),
    registryRoot: registryRoot(registry),
    source,
    selection: {
      ids: settings.ids,
      domains: settings.domains,
      levels: settings.levels,
      profile: settings.profile,
      platformId: settings.currentPlatformId,
    },
    evidence,
    summary: summarize(evidence),
  };
}

function summarize(evidence) {
  const counts = Object.fromEntries(
    VERDICTS.map((verdict) => [
      verdict,
      evidence.filter((item) => item.verdict === verdict).length,
    ]),
  );
  const verdict =
    counts.falsified > 0
      ? 'falsified'
      : counts.unqualified > 0 || evidence.length === 0
        ? 'unqualified'
        : 'verified';
  return { verdict, total: evidence.length, counts };
}

function coverageKey(invariantId, level, platform) {
  return `${invariantId}@${level}@${platform}`;
}

export function createPassport(evidence, options = {}) {
  const registry = options.registry || readJson(REGISTRY_PATH);
  const source = options.source || sourceIdentity();
  const releaseClaims = evaluateExitMigrationReleaseClaims({
    releaseArtifacts: options.releaseArtifacts,
    releaseProfile: options.releaseProfile,
    targetPlatforms: options.targetPlatforms,
    availableProviders: options.availableProviders,
    cleanRuntime: options.cleanRuntime,
    providerMigration: options.providerMigration,
    exitContract: options.exitContract,
    adr: options.adr,
    contract: options.contract,
  });
  const required = [];
  for (const invariant of registry.invariants.filter(
    (item) => item.release.required,
  )) {
    for (const level of invariant.release.levels) {
      for (const platform of invariant.release.platforms)
        required.push(coverageKey(invariant.id, level, platform));
    }
  }
  const evidenceByKey = new Map();
  for (const item of evidence)
    evidenceByKey.set(
      coverageKey(
        item.invariant.id,
        item.checker.level,
        item.environment.platformId,
      ),
      item,
    );
  const invalidEvidence = new Map();
  for (const item of evidence) {
    const key = coverageKey(
      item.invariant.id,
      item.checker.level,
      item.environment.platformId,
    );
    const issues = verifyEvidence(item, registry);
    if (
      item.source.revision !== source.revision ||
      item.source.tree !== source.tree
    )
      issues.push('source-revision-mismatch');
    if (issues.length) invalidEvidence.set(key, issues);
  }
  const missing = required.filter((key) => !evidenceByKey.has(key));
  const falsified = required.filter(
    (key) => evidenceByKey.get(key)?.verdict === 'falsified',
  );
  const unqualified = required.filter((key) => {
    const verdict = evidenceByKey.get(key)?.verdict;
    return (
      verdict === 'unqualified' ||
      verdict === 'not-applicable' ||
      invalidEvidence.has(key)
    );
  });
  const verified = required.filter(
    (key) => evidenceByKey.get(key)?.verdict === 'verified',
  );
  const dirty = Boolean(source.dirty);
  const invariantVerdict =
    falsified.length > 0
      ? 'falsified'
      : missing.length > 0 || unqualified.length > 0 || dirty
        ? 'unqualified'
        : 'verified';
  const verdict =
    invariantVerdict === 'falsified' || releaseClaims.verdict === 'falsified'
      ? 'falsified'
      : invariantVerdict === 'unqualified' ||
          releaseClaims.verdict === 'unqualified'
        ? 'unqualified'
        : 'verified';
  const diagnostics = [];
  if (dirty)
    diagnostics.push(
      diagnostic(
        'dirty-source',
        'Release invariant passports require a clean exact source revision.',
      ),
    );
  if (missing.length)
    diagnostics.push(
      diagnostic(
        'coverage-missing',
        `${missing.length} required invariant coordinates are absent.`,
      ),
    );
  if (unqualified.length)
    diagnostics.push(
      diagnostic(
        'coverage-unqualified',
        `${unqualified.length} required invariant coordinates are not verified.`,
      ),
    );
  if (falsified.length)
    diagnostics.push(
      diagnostic(
        'coverage-falsified',
        `${falsified.length} required invariant coordinates are falsified.`,
      ),
    );
  for (const [key, issues] of invalidEvidence)
    diagnostics.push(
      diagnostic('evidence-invalid', `${key}: ${issues.join(', ')}`),
    );
  const passport = {
    schema: 'kungfu.invariant-passport/v1',
    product: 'Kungfu',
    canonicalization: 'stable-json-sha256-v1',
    verifier: {
      name: 'kungfu-invariant-system',
      version: 1,
      contractRoot: contractRoot(),
    },
    source: { repository: 'kungfu-systems/kungfu', ...source },
    contractRoot: contractRoot(),
    registryRoot: registryRoot(registry),
    verdict,
    claims: registry.invariants.map((item) => ({
      id: item.id,
      stability: item.stability,
      maturity: item.maturity,
      sourceRoot: item.source.root,
      modelRoot: item.model?.root || null,
      refinementRoot: item.refinement?.root || null,
    })),
    coverage: {
      complete: verdict === 'verified',
      required: required.length,
      verified: verified.length,
      missing,
      falsified,
      unqualified,
      platforms: [
        ...new Set(evidence.map((item) => item.environment.platformId)),
      ].sort(),
    },
    evidence: evidence
      .map((item) => ({
        invariantId: item.invariant.id,
        level: item.checker.level,
        platformId: item.environment.platformId,
        verdict: item.verdict,
        root: item.evidenceRoot,
      }))
      .sort((left, right) =>
        coverageKey(
          left.invariantId,
          left.level,
          left.platformId,
        ).localeCompare(
          coverageKey(right.invariantId, right.level, right.platformId),
        ),
      ),
    releaseClaims,
    residualRisk: [
      ...new Set(registry.invariants.flatMap((item) => item.residualRisk)),
      ...releaseClaims.residualRisk,
    ].sort(),
    diagnostics,
    observedAt: options.observedAt || new Date().toISOString(),
    passportRoot: 'sha256:'.padEnd(71, '0'),
  };
  return rooted(passport, 'passportRoot');
}

export function verifyEvidence(value, registry = readJson(REGISTRY_PATH)) {
  const validate = ajv().compile(readJson(EVIDENCE_SCHEMA_PATH));
  const issues = validate(value) ? [] : validationErrors(validate);
  if (value.evidenceRoot !== digest(semanticDocument(value, 'evidenceRoot')))
    issues.push('evidence-root-mismatch');
  const invariant = registry.invariants.find(
    (item) => item.id === value.invariant?.id,
  );
  const checker = registry.checkers.find(
    (item) => item.id === value.checker?.id,
  );
  if (!invariant) issues.push('unknown-invariant');
  if (!checker) issues.push('unknown-checker');
  if (invariant && value.source?.subjectRoot !== pointerRoot(invariant.source))
    issues.push('stale-source');
  if (checker && value.checker?.root !== checkerRoot(checker))
    issues.push('stale-checker');
  if (value.source?.contractRoot !== contractRoot())
    issues.push('stale-contract');
  if (value.source?.registryRoot !== registryRoot(registry))
    issues.push('stale-registry');
  return issues;
}

export function verifyPassport(
  value,
  evidenceValues = [],
  registry = readJson(REGISTRY_PATH),
  options = {},
) {
  const validate = ajv().compile(readJson(PASSPORT_SCHEMA_PATH));
  const issues = validate(value) ? [] : validationErrors(validate);
  if (value.passportRoot !== digest(semanticDocument(value, 'passportRoot')))
    issues.push('passport-root-mismatch');
  if (value.contractRoot !== contractRoot()) issues.push('stale-contract');
  if (value.registryRoot !== registryRoot(registry))
    issues.push('stale-registry');
  if (value.source?.dirty) issues.push('dirty-source');
  if (
    options.checkRevision !== false &&
    value.source?.revision !== sourceIdentity().revision
  )
    issues.push('stale-source-revision');
  const roots = new Set(evidenceValues.map((item) => item.evidenceRoot));
  for (const entry of value.evidence || [])
    if (evidenceValues.length > 0 && !roots.has(entry.root))
      issues.push(`evidence-root-unbound:${entry.root}`);
  for (const evidence of evidenceValues)
    issues.push(
      ...verifyEvidence(evidence, registry).map(
        (issue) => `${evidence.invariant?.id}:${issue}`,
      ),
    );
  const recomputed = createPassport(evidenceValues, {
    registry,
    source: value.source,
    observedAt: value.observedAt,
    releaseArtifacts: options.releaseArtifacts,
    releaseProfile: options.releaseProfile,
    targetPlatforms: options.targetPlatforms,
    availableProviders: options.availableProviders,
  });
  if (
    evidenceValues.length > 0 &&
    canonicalJson({ ...recomputed, observedAt: value.observedAt }) !==
      canonicalJson(value)
  )
    issues.push('passport-coverage-mismatch');
  if (value.verdict !== 'verified') issues.push(`passport-${value.verdict}`);
  if (!value.coverage?.complete) issues.push('coverage-incomplete');
  if (value.releaseClaims?.verdict !== 'verified')
    issues.push(`release-claims-${value.releaseClaims?.verdict || 'missing'}`);
  return [...new Set(issues)];
}

export function qualifyEpisodeObject(subject, options = {}) {
  const validate = ajv().compile(readJson(EPISODE_INPUT_SCHEMA_PATH));
  const schemaIssues = validate(subject) ? [] : validationErrors(validate);
  const contract = readJson(
    'framework/episode/kungfu-episode-invariants.contract.json',
  );
  const checker = readJson(EPISODE_INPUT_SCHEMA_PATH);
  const evidenceStates = Object.values(subject.evidence || {}).map(
    (item) => item?.state,
  );
  const terminal = contract.objectQualification.qualifiedLifecycle.includes(
    subject.lifecycle,
  );
  let verdict = 'verified';
  if (
    schemaIssues.length ||
    subject.status === 'failed' ||
    evidenceStates.includes('failed')
  )
    verdict = 'falsified';
  else if (
    !terminal ||
    subject.status !== 'ok' ||
    evidenceStates.some((state) =>
      ['not_checked', 'missing', 'degraded'].includes(state),
    )
  )
    verdict = 'unqualified';
  const blockers = [
    ...schemaIssues.map((message) => ({
      code: 'input-schema-invalid',
      message,
    })),
    ...(subject.issues || []).map((issue) => ({
      code: issue.code,
      evidence: issue.evidence,
      severity: issue.severity,
    })),
    ...(subject.contractions || []).map((item) => ({
      code: 'capability-contracted',
      capability: item.capability,
      blockedBy: item.blocked_by,
    })),
  ];
  if (!terminal)
    blockers.push({ code: 'episode-not-sealed', lifecycle: subject.lifecycle });
  const receipt = {
    schema: 'kungfu.episode-object-qualification-receipt/v1',
    receiptKind: 'object-qualification',
    episodeId: subject.episode_id,
    lifecycle: subject.lifecycle,
    verdict,
    subjectRoot: digest(subject),
    contractRoot: digest(contract),
    checkerRoot: digest(checker),
    evidence: subject.evidence || {},
    qualifiedCapabilities: subject.safe_capabilities || [],
    blockers,
    residualRisk:
      verdict === 'verified'
        ? [
            'External side effects and unavailable off-object dependencies are outside this receipt unless explicitly represented by the input evidence.',
          ]
        : [
            'The object is not safe for every capability; inspect blockers and contractions.',
          ],
    observedAt: options.observedAt || new Date().toISOString(),
    receiptRoot: 'sha256:'.padEnd(71, '0'),
  };
  return rooted(receipt, 'receiptRoot');
}

export function verifyEpisodeObjectReceipt(receipt, subject) {
  const validate = ajv().compile(readJson(OBJECT_SCHEMA_PATH));
  const issues = validate(receipt) ? [] : validationErrors(validate);
  if (receipt.receiptRoot !== digest(semanticDocument(receipt, 'receiptRoot')))
    issues.push('receipt-root-mismatch');
  if (receipt.subjectRoot !== digest(subject)) issues.push('stale-subject');
  if (
    receipt.contractRoot !==
    digest(
      readJson('framework/episode/kungfu-episode-invariants.contract.json'),
    )
  )
    issues.push('stale-contract');
  if (receipt.checkerRoot !== digest(readJson(EPISODE_INPUT_SCHEMA_PATH)))
    issues.push('stale-checker');
  const recomputed = qualifyEpisodeObject(subject, {
    observedAt: receipt.observedAt,
  });
  if (canonicalJson(recomputed) !== canonicalJson(receipt))
    issues.push('receipt-semantic-mismatch');
  return [...new Set(issues)];
}

function loadSuccessors(directory) {
  if (!directory) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(path.join(directory, name)));
}

export function checkEvolution(baseline, current, successors = []) {
  const validate = ajv().compile(readJson(SUCCESSOR_SCHEMA_PATH));
  const issues = [];
  for (const successor of successors)
    if (!validate(successor))
      issues.push(
        ...validationErrors(validate).map((item) => `successor:${item}`),
      );
  const currentById = new Map(
    current.invariants.map((item) => [item.id, item]),
  );
  for (const previous of baseline.invariants) {
    const next = currentById.get(previous.id);
    if (!next) {
      issues.push(`${previous.id}:removed-without-successor`);
      continue;
    }
    if (previous.source.root === next.source.root) continue;
    const successor = successors.find(
      (item) =>
        item.predecessorId === previous.id &&
        item.predecessorSourceRoot === previous.source.root &&
        item.successorId === next.id &&
        item.successorSourceRoot === next.source.root,
    );
    if (!successor) {
      issues.push(`${previous.id}:semantic-change-without-successor`);
      continue;
    }
    if (
      ['constitutional', 'protocol'].includes(previous.stability) &&
      (!successor.abstractModelImpact || !successor.refinementImpact)
    )
      issues.push(`${previous.id}:strong-successor-impact-missing`);
  }
  return issues;
}

function parseArgs(argv) {
  const options = {
    ids: [],
    domains: [],
    levels: [],
    evidence: [],
    releaseArtifacts: [],
    releaseProviders: [],
    releaseTargetPlatforms: [],
  };
  const values = argv.filter((arg) => arg !== '--');
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      index += 1;
      if (index >= values.length) throw new Error(`${arg} requires a value`);
      return values[index];
    };
    if (arg === '--list') options.list = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--sync-roots') options.syncRoots = true;
    else if (arg === '--sync-artifacts') options.syncArtifacts = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--id')
      options.ids.push(...next().split(',').filter(Boolean));
    else if (arg === '--domain')
      options.domains.push(...next().split(',').filter(Boolean));
    else if (arg === '--level')
      options.levels.push(...next().split(',').filter(Boolean));
    else if (arg === '--profile') options.profile = next();
    else if (arg === '--evidence-dir')
      options.evidenceDir = path.resolve(next());
    else if (arg === '--run-report') options.runReport = path.resolve(next());
    else if (arg === '--collect-evidence')
      options.collectEvidence = path.resolve(next());
    else if (arg === '--evidence') options.evidence.push(path.resolve(next()));
    else if (arg === '--release-artifact')
      options.releaseArtifacts.push(path.resolve(next()));
    else if (arg === '--release-profile') options.releaseProfile = next();
    else if (arg === '--release-provider')
      options.releaseProviders.push(...next().split(',').filter(Boolean));
    else if (arg === '--release-target-platform')
      options.releaseTargetPlatforms.push(
        ...next().split(',').map(normalizeReleasePlatform).filter(Boolean),
      );
    else if (arg === '--passport') options.passport = path.resolve(next());
    else if (arg === '--verify-passport')
      options.verifyPassport = path.resolve(next());
    else if (arg === '--qualify-episode')
      options.qualifyEpisode = path.resolve(next());
    else if (arg === '--receipt') options.receipt = path.resolve(next());
    else if (arg === '--verify-receipt')
      options.verifyReceipt = path.resolve(next());
    else if (arg === '--subject') options.subject = path.resolve(next());
    else if (arg === '--baseline') options.baseline = path.resolve(next());
    else if (arg === '--successors') options.successors = path.resolve(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument '${arg}'`);
  }
  return options;
}

function usage() {
  return 'Kungfu Invariant Verification System\n\nUsage:\n  ./shifu invariant:verify -- --list [--json]\n  ./shifu invariant:verify -- [--domain fact|episode] [--id ID] [--level source,native,runtime] [--evidence-dir DIR] [--run-report FILE] [--passport FILE] [--json]\n  ./shifu invariant:verify -- --collect-evidence DIR --passport FILE [--release-artifact FILE...] [--release-profile full|thin] [--json]\n  ./shifu invariant:verify -- --qualify-episode QUALIFICATION.json --receipt RECEIPT.json [--json]\n  ./shifu invariant:verify -- --verify-receipt RECEIPT.json --subject QUALIFICATION.json [--json]\n  ./shifu invariant:verify -- --verify-passport PASSPORT.json --evidence EVIDENCE.json... [--release-artifact FILE...] [--json]\n  ./shifu invariant:verify -- --baseline REGISTRY.json --successors DIR [--json]\n  ./shifu invariant:verify -- --sync-roots|--sync-artifacts [--write] [--json]\n\nExit codes: 0 verified, 1 falsified, 2 unqualified/invalid evidence, 3 usage or runner failure.';
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function collectEvidence(directory) {
  const evidence = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = readJson(absolute);
          if (value.schema === 'kungfu.invariant-evidence/v1')
            evidence.push(value);
        } catch {
          // Unrelated release evidence is outside this collector.
        }
      }
    }
  };
  visit(directory);
  return evidence;
}

function releaseContext(options, discoveryRoot = ROOT) {
  const releaseArtifacts = options.releaseArtifacts.length
    ? options.releaseArtifacts.map((filePath) => ({
        name: path.basename(filePath),
        digest: digest(fs.readFileSync(filePath)),
      }))
    : discoverReleaseArtifacts(discoveryRoot);
  return {
    releaseArtifacts,
    releaseProfile: options.releaseProfile,
    targetPlatforms: options.releaseTargetPlatforms.length
      ? options.releaseTargetPlatforms
      : undefined,
    availableProviders: options.releaseProviders.length
      ? options.releaseProviders
      : undefined,
  };
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (value.schema === 'kungfu.invariant-run/v1') {
    for (const item of value.evidence)
      process.stdout.write(
        `${item.verdict.padEnd(14)} ${item.invariant.id} [${item.checker.level}/${item.environment.platformId}]\n`,
      );
    process.stdout.write(
      `verdict=${value.summary.verdict} verified=${value.summary.counts.verified} falsified=${value.summary.counts.falsified} unqualified=${value.summary.counts.unqualified} not-applicable=${value.summary.counts['not-applicable']}\n`,
    );
  } else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function exitFor(verdict) {
  return verdict === 'verified' ? 0 : verdict === 'falsified' ? 1 : 2;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exit(3);
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.syncRoots) {
    const current = readJson(REGISTRY_PATH);
    const next = synchronizeRegistryRoots(current);
    const changed = canonicalJson(current) !== canonicalJson(next);
    if (options.write && changed)
      writeJson(path.join(ROOT, REGISTRY_PATH), next);
    const result = {
      schema: 'kungfu.invariant-root-sync/v1',
      changed,
      written: Boolean(options.write && changed),
      issues: options.write ? validateRegistry(next) : rootDrift(current),
    };
    print(result, options.json);
    if (result.issues.length) process.exit(2);
    return;
  }
  if (options.syncArtifacts) {
    const result = {
      schema: 'kungfu.invariant-artifact-sync/v1',
      ...synchronizePackagedArtifacts(Boolean(options.write)),
    };
    print(result, options.json);
    if (!options.write && result.changes.length) process.exit(2);
    return;
  }
  const registry = readJson(REGISTRY_PATH);
  if (options.list) {
    const result = {
      schema: 'kungfu.invariant-discovery/v1',
      contract: CONTRACT_PATH,
      registry: REGISTRY_PATH,
      publicEntry: './shifu invariant:verify',
      invariants: registry.invariants.map((item) => ({
        id: item.id,
        domain: item.domain,
        label: item.label,
        owner: item.owner,
        source: item.source,
        stability: item.stability,
        maturity: item.maturity,
        checkers: item.checkerIds,
        release: item.release,
        residualRisk: item.residualRisk,
      })),
    };
    print(result, options.json);
    return;
  }
  if (options.qualifyEpisode) {
    if (!options.receipt)
      throw new Error('--qualify-episode requires --receipt');
    const receipt = qualifyEpisodeObject(readJson(options.qualifyEpisode));
    writeJson(options.receipt, receipt);
    print(receipt, options.json);
    process.exit(exitFor(receipt.verdict));
  }
  if (options.verifyReceipt) {
    if (!options.subject)
      throw new Error('--verify-receipt requires --subject');
    const issues = verifyEpisodeObjectReceipt(
      readJson(options.verifyReceipt),
      readJson(options.subject),
    );
    const result = {
      schema: 'kungfu.episode-object-receipt-verification/v1',
      verdict: issues.length ? 'unqualified' : 'verified',
      issues,
    };
    print(result, options.json);
    process.exit(exitFor(result.verdict));
  }
  if (options.verifyPassport) {
    const evidence = options.evidence.map(readJson);
    const issues = verifyPassport(
      readJson(options.verifyPassport),
      evidence,
      registry,
      releaseContext(options),
    );
    const result = {
      schema: 'kungfu.invariant-passport-verification/v1',
      verdict: issues.length ? 'unqualified' : 'verified',
      issues,
    };
    print(result, options.json);
    process.exit(exitFor(result.verdict));
  }
  if (options.collectEvidence) {
    if (!options.passport)
      throw new Error('--collect-evidence requires --passport');
    const evidence = collectEvidence(options.collectEvidence);
    const passport = createPassport(evidence, {
      source: sourceIdentityFromEvidence(evidence),
      ...releaseContext(options, options.collectEvidence),
    });
    writeJson(options.passport, passport);
    print(passport, options.json);
    process.exit(exitFor(passport.verdict));
  }
  if (options.baseline) {
    const issues = checkEvolution(
      readJson(options.baseline),
      registry,
      loadSuccessors(options.successors),
    );
    const result = {
      schema: 'kungfu.invariant-evolution-check/v1',
      verdict: issues.length ? 'falsified' : 'verified',
      issues,
    };
    print(result, options.json);
    process.exit(exitFor(result.verdict));
  }
  if (options.levels.some((level) => !LEVELS.includes(level)))
    throw new Error(`unknown level in ${options.levels.join(',')}`);
  const run = await verifyInvariants({
    ids: options.ids,
    domains: options.domains,
    levels: options.levels.length ? options.levels : ['source'],
    profile: options.profile || 'default',
  });
  if (options.evidenceDir)
    for (const item of run.evidence)
      writeJson(
        path.join(
          options.evidenceDir,
          `${item.invariant.id}.${item.checker.level}.${item.environment.platformId}.json`,
        ),
        item,
      );
  if (options.runReport) writeJson(options.runReport, run);
  if (options.passport)
    writeJson(
      options.passport,
      createPassport(run.evidence, releaseContext(options)),
    );
  print(run, options.json);
  process.exit(exitFor(run.summary.verdict));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `invariant verification: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(3);
  });
}

export { CONTRACT_PATH, REGISTRY_PATH, ROOT_PATTERN, VERDICTS, LEVELS };
