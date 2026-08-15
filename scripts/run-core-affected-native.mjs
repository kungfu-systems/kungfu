// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { observeNativeToolchain } from './affected-native-proof.mjs';
import telemetry from './candidate-timeline-events.cjs';
import { devMergeBaseCandidates } from './candidate-timeline-events.cjs';
import { parseDocument } from './readonly-source-toolchain.mjs';
import { writeShifuGateEvidence } from './shifu-gate-evidence.mjs';

const { measureCandidateStage } = telemetry;

const root = process.cwd();
const coreRoot = path.join(root, 'framework', 'core');
const architecturePath = path.join(coreRoot, 'architecture', 'layers.json');
const buildPath = path.join(
  coreRoot,
  'architecture',
  'build-capabilities.json',
);
const baselinePath = path.join(
  coreRoot,
  'architecture',
  'affected-native-baseline.json',
);
const nonNativeCoreRules = [
  { prefix: '.gyp/run-freeze.js', kind: 'core-packaging-source' },
  {
    prefix: 'src/libkungfu/check-view-boundary.mjs',
    kind: 'core-architecture-check',
    extensions: ['.mjs'],
  },
  {
    prefix: 'src/libyijinjing/check-deps.mjs',
    kind: 'core-architecture-check',
    extensions: ['.mjs'],
  },
  {
    prefix: 'slices/',
    kind: 'core-qualification-harness',
    extensions: ['.js', '.json', '.mjs'],
  },
  {
    prefix: 'src/libkungfu/tests/fixtures/',
    kind: 'core-test-fixture',
    extensions: ['.js', '.mjs', '.py'],
  },
  { prefix: 'src/python/', kind: 'core-python-source' },
  { prefix: 'tests/fixtures/', kind: 'core-test-fixture' },
  { prefix: 'tests/python/', kind: 'core-python-test' },
  {
    prefix: 'tests/qualification/',
    kind: 'core-qualification-harness',
    extensions: ['.js', '.json', '.mjs', '.py'],
  },
];
const sdkRootScriptKeys = [
  'build:core',
  'core:affected',
  'core:affected:configure',
  'layers:qualify:sdk',
  'pack:sdk',
  'sdk:layered:check',
  'sdk:layered:generate',
];
const affectedNativeWorkflow = '.github/workflows/affected-native-pr.yml';
const affectedNativeSdkTerminalStep =
  'Qualify installed four-language SDK wire contract';
const affectedNativePlanStep = 'Plan exact dev candidate qualification';
const sdkQualificationPaths = [
  '.github/workflows/affected-native-cache-promote.yml',
  affectedNativeWorkflow,
  'crates/Cargo.lock',
  'crates/Cargo.toml',
  'crates/kungfu-sdk/',
  'framework/core/.cmake/',
  'framework/core/.gyp/',
  'framework/core/CMakeLists.txt',
  'framework/core/architecture/build-capabilities.json',
  'framework/core/architecture/layered-api-encoding-boundary.contract.json',
  'framework/core/architecture/layers.json',
  'framework/core/architecture/sdk-build-plan.json',
  'framework/core/cmake/',
  'framework/core/conanfile.py',
  'framework/core/package.json',
  'framework/core/pyproject.toml',
  'framework/core/uv.lock',
  'framework/core/src/bindings/',
  'framework/core/src/libkungfu/include/',
  'framework/core/src/libkungfu/schemas/',
  'framework/core/src/libwasm/',
  'framework/core/src/libyijinjing/include/',
  'framework/core/stubs/',
  'framework/storage/',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'product/scripts/archive.mjs',
  'scripts/affected-native-proof.mjs',
  'scripts/candidate-timeline-events.cjs',
  'scripts/generate-layered-sdk.mjs',
  'scripts/platform-command.mjs',
  'scripts/run-core-affected-native.mjs',
  'scripts/run-layer-artifact-gate.mjs',
  'scripts/write-affected-native-cache-manifests.mjs',
  'shifu.gates.json',
  'tests/qualification/layers/process-metrics.mjs',
  'tests/qualification/layers/sdk/',
];
const shifuWorkspaceQualificationPaths = [
  { suffix: '.md' },
  { exact: '.xinfa/project.json' },
  { prefix: 'crates/' },
  { exact: 'scripts/qualify-xinfa-context-quality.mjs' },
  { prefix: 'scripts/shifu-documentation-' },
  { exact: 'scripts/check-shifu-workspace.mjs' },
  { prefix: 'scripts/shifu-gate-' },
  { exact: 'package.json' },
  { exact: 'shifu.gates.json' },
  { exact: '.github/workflows/affected-native-cache-promote.yml' },
  { exact: '.github/workflows/affected-native-pr.yml' },
  { exact: '.github/workflows/shifu-ci.yml' },
];
const kfdVerifierQualificationPaths = [
  { prefix: 'crates/xinfa/' },
  { exact: 'scripts/verify-kfd-owned-fixtures.mjs' },
  { exact: 'package.json' },
  { exact: 'pnpm-lock.yaml' },
  { exact: '.github/workflows/affected-native-cache-promote.yml' },
  { exact: '.github/workflows/affected-native-pr.yml' },
  { exact: '.github/workflows/kfd-verifier-drift.yml' },
];

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(ordered(value));
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value))
    .digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonAtRevision(revision, file) {
  const result = spawnSync('git', ['show', `${revision}:${file}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `cannot read ${file} at ${revision}`,
    );
  }
  return JSON.parse(result.stdout);
}

function readWorkflowAtRevision(revision, file) {
  const result = spawnSync('git', ['show', `${revision}:${file}`], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `cannot read ${file} at ${revision}`,
    );
  }
  const document = parseDocument(result.stdout);
  if (document.errors.length) throw document.errors[0];
  return document.toJS();
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function uniqueNamedStep(job, name, label) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const matches = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step?.name === name);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one '${name}' step`);
  }
  return matches[0];
}

function semanticNeeds(value, ignored, label) {
  const needs =
    value === undefined
      ? []
      : typeof value === 'string'
        ? [value]
        : Array.isArray(value) &&
            value.every((item) => typeof item === 'string')
          ? value
          : null;
  if (!needs)
    throw new Error(`${label} needs must be a string or string array`);
  return unique(needs.filter((item) => !ignored.includes(item)));
}

function semanticShardCondition(value) {
  if (typeof value !== 'string') {
    throw new Error('affected_native_shards job if must be a string');
  }
  const sourceGuard =
    /needs\.source_acceptance\.result\s*==\s*'success'\s*&&\s*/gu;
  const matches = value.match(sourceGuard) || [];
  if (matches.length > 1) {
    throw new Error(
      'affected_native_shards job has duplicate source acceptance guards',
    );
  }
  return value.replace(sourceGuard, '').replace(/\s+/gu, ' ').trim();
}

export function affectedNativeWorkflowSdkProjection(document) {
  const workflow = requiredObject(document, 'affected-native workflow');
  const jobs = requiredObject(workflow.jobs, 'affected-native workflow jobs');
  const candidate = requiredObject(
    jobs.candidate_preflight,
    'candidate_preflight job',
  );
  const shard = requiredObject(
    jobs.affected_native_shards,
    'affected_native_shards job',
  );
  if (!Array.isArray(shard.steps)) {
    throw new Error('affected_native_shards steps must be an array');
  }
  const terminal = uniqueNamedStep(
    shard,
    affectedNativeSdkTerminalStep,
    'affected_native_shards job',
  );
  const candidatePlan = uniqueNamedStep(
    candidate,
    affectedNativePlanStep,
    'candidate_preflight job',
  );
  const { steps: _candidateSteps, ...candidateJob } = candidate;
  const { steps: _shardSteps, ...shardJob } = shard;
  shardJob.needs = semanticNeeds(
    shard.needs,
    ['source_acceptance'],
    'affected_native_shards job',
  );
  shardJob.if = semanticShardCondition(shard.if);
  return {
    workflow: {
      permissions: workflow.permissions || null,
      env: workflow.env || null,
      defaults: workflow.defaults || null,
    },
    candidatePreflight: {
      job: candidateJob,
      plan: candidatePlan.step,
    },
    affectedNativeShards: {
      job: shardJob,
      stepsThroughSdkQualification: shard.steps.slice(0, terminal.index + 1),
    },
  };
}

export function rootPackageSdkProjection(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('root package document must be an object');
  }
  const scripts = document.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    throw new Error('root package scripts must be an object');
  }
  return {
    packageManager: document.packageManager || null,
    engines: document.engines || null,
    dependencies: document.dependencies || null,
    devDependencies: document.devDependencies || null,
    optionalDependencies: document.optionalDependencies || null,
    peerDependencies: document.peerDependencies || null,
    pnpm: document.pnpm || null,
    overrides: document.overrides || null,
    resolutions: document.resolutions || null,
    scripts: Object.fromEntries(
      sdkRootScriptKeys.map((key) => [key, scripts[key] || null]),
    ),
  };
}

function matchesPathRule(file, rule) {
  return file === rule || (rule.endsWith('/') && file.startsWith(rule));
}

function matchesQualificationPathRule(file, rule) {
  return (
    file === rule.exact ||
    (rule.prefix && file.startsWith(rule.prefix)) ||
    (rule.suffix && file.endsWith(rule.suffix))
  );
}

function qualificationImpact(changedFiles, rules, kind) {
  const reasons = unique(changedFiles)
    .filter((file) =>
      rules.some((rule) => matchesQualificationPathRule(file, rule)),
    )
    .map((file) => ({ path: file, kind }));
  return { required: reasons.length > 0, reasons };
}

export function devQueueQualificationImpact(changedFiles) {
  return {
    shifuWorkspace: qualificationImpact(
      changedFiles,
      shifuWorkspaceQualificationPaths,
      'shifu-workspace-input',
    ),
    kfdVerifier: qualificationImpact(
      changedFiles,
      kfdVerifierQualificationPaths,
      'kfd-verifier-input',
    ),
  };
}

export function sdkQualificationImpact(
  changedFiles,
  base,
  head,
  {
    packageAtRevision = readJsonAtRevision,
    workflowAtRevision = readWorkflowAtRevision,
  } = {},
) {
  let required = false;
  const reasons = [];
  for (const file of unique(changedFiles)) {
    if (file === 'package.json') {
      try {
        const before = rootPackageSdkProjection(packageAtRevision(base, file));
        const after = rootPackageSdkProjection(packageAtRevision(head, file));
        const changed = stableJson(before) !== stableJson(after);
        required ||= changed;
        reasons.push({
          path: file,
          kind: changed
            ? 'root-package-sdk-projection'
            : 'root-package-sdk-neutral',
        });
      } catch {
        required = true;
        reasons.push({
          path: file,
          kind: 'root-package-sdk-impact-unknown',
        });
      }
      continue;
    }
    if (file === affectedNativeWorkflow) {
      try {
        const before = affectedNativeWorkflowSdkProjection(
          workflowAtRevision(base, file),
        );
        const after = affectedNativeWorkflowSdkProjection(
          workflowAtRevision(head, file),
        );
        const changed = stableJson(before) !== stableJson(after);
        required ||= changed;
        reasons.push({
          path: file,
          kind: changed
            ? 'affected-native-workflow-sdk-projection'
            : 'affected-native-workflow-sdk-neutral',
        });
      } catch {
        required = true;
        reasons.push({
          path: file,
          kind: 'affected-native-workflow-sdk-impact-unknown',
        });
      }
      continue;
    }
    if (sdkQualificationPaths.some((rule) => matchesPathRule(file, rule))) {
      required = true;
      reasons.push({ path: file, kind: 'sdk-authority-or-input' });
    }
  }
  return { required, reasons };
}

function unique(items) {
  return [...new Set(items)].sort();
}

function owns(rule, file) {
  const included =
    (rule.include_files || []).includes(file) ||
    (rule.include_prefixes || []).some((prefix) => file.startsWith(prefix));
  return (
    included &&
    !(rule.exclude_files || []).includes(file) &&
    !(rule.exclude_prefixes || []).some((prefix) => file.startsWith(prefix))
  );
}

function isTracked(authority, relative) {
  return (authority.tracked_roots || []).some((root) =>
    relative.startsWith(root),
  );
}

function nonNativeCoreRule(relative) {
  return (
    nonNativeCoreRules.find(
      (rule) =>
        relative.startsWith(rule.prefix) &&
        (!rule.extensions || rule.extensions.includes(path.extname(relative))),
    ) || null
  );
}

function targetEvidence(authority) {
  return new Set(
    authority.target_evidence.flatMap((record) => record.targets || []),
  );
}

function validateAuthority(authority, buildAuthority) {
  const problems = [];
  const components = new Map(
    authority.components.map((component) => [component.id, component]),
  );
  const evidence = targetEvidence(authority);
  const internalTargets = new Set(
    authority.internal_targets.map((target) => target.id),
  );
  for (const component of authority.components) {
    for (const dependency of component.dependencies || []) {
      if (!components.has(dependency)) {
        problems.push(`${component.id}: unknown dependency ${dependency}`);
      }
    }
    for (const target of component.current_targets || []) {
      if (!evidence.has(target)) {
        problems.push(
          `${component.id}: target lacks CMake evidence: ${target}`,
        );
      }
    }
    for (const test of component.contract_tests || []) {
      if (!evidence.has(test)) {
        problems.push(
          `${component.id}: contract test lacks CMake evidence: ${test}`,
        );
      }
    }
  }
  for (const target of authority.internal_targets) {
    if (!components.has(target.component)) {
      problems.push(`${target.id}: unknown component ${target.component}`);
    }
    if (!evidence.has(target.id)) {
      problems.push(`${target.id}: internal target lacks CMake evidence`);
    }
    for (const dependency of target.dependencies || []) {
      if (!internalTargets.has(dependency)) {
        problems.push(`${target.id}: unknown target dependency ${dependency}`);
      }
    }
  }
  const architectureComponents = new Set(
    authority.components.map(({ id }) => id),
  );
  const projected = new Set(
    buildAuthority.components.flatMap(
      (component) => component.architecture_components || [],
    ),
  );
  for (const component of architectureComponents) {
    if (
      component !== 'core-native-qualification' &&
      !projected.has(component)
    ) {
      problems.push(`${component}: absent from build capability projection`);
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

function componentOwner(authority, file) {
  const owners = authority.components.filter((component) =>
    owns(component, file),
  );
  if (owners.length !== 1) {
    throw new Error(
      `${file}: expected exactly one architecture component, found ${owners.map(({ id }) => id).join(', ') || 'none'}`,
    );
  }
  return owners[0];
}

function reverseClosure(authority, direct) {
  const result = new Set(direct);
  let changed = true;
  while (changed) {
    changed = false;
    for (const component of authority.components) {
      if (
        !result.has(component.id) &&
        (component.dependencies || []).some((dependency) =>
          result.has(dependency),
        )
      ) {
        result.add(component.id);
        changed = true;
      }
    }
  }
  return result;
}

function publicRule(authority, file) {
  const matches = (authority.public_contracts?.header_rules || []).filter(
    (rule) => owns(rule, file),
  );
  if (matches.length > 1) {
    throw new Error(`${file}: ambiguous public contract impact`);
  }
  return matches[0] || null;
}

function selectProfile(buildAuthority, components, forceFull) {
  if (forceFull) return 'full';
  const required = new Set(
    [...components].filter(
      (component) => component !== 'core-native-qualification',
    ),
  );
  const supported = buildAuthority.profiles.filter(
    (profile) => profile.status === 'supported',
  );
  const candidates = supported.filter((profile) => {
    const projected = new Set(
      buildAuthority.components
        .filter((component) => profile.components.includes(component.id))
        .flatMap((component) => component.architecture_components || []),
    );
    return [...required].every((component) => projected.has(component));
  });
  candidates.sort(
    (left, right) =>
      left.components.length +
        left.providers.length +
        left.bindings.length -
        (right.components.length +
          right.providers.length +
          right.bindings.length) || left.id.localeCompare(right.id),
  );
  if (!candidates.length) {
    throw new Error(
      `no supported Core profile covers ${[...required].join(', ')}`,
    );
  }
  return candidates[0].id;
}

export function planFromChanged(
  changedFiles,
  authority,
  buildAuthority,
  base,
  head,
  options = {},
) {
  validateAuthority(authority, buildAuthority);
  const direct = new Set();
  const broad = new Set();
  const reasons = [];
  const publicRules = new Set();
  let global = false;
  let forceFull = false;
  const globalPaths = [
    '.github/actions/qualified-core-candidate-build/',
    'framework/agent-session/src/runtime-port.mjs',
    'framework/agent-session/tests/runtime-port.native-peer.mjs',
    'framework/agent-session/tests/runtime-port.native.test.mjs',
    'framework/core/architecture/',
    'framework/core/CMakeLists.txt',
    'framework/core/conanfile.py',
    // TOML edits can change the native toolchain, so expand them globally.
    'framework/core/pyproject.toml',
    // The exact resolution needs the same global qualification.
    'framework/core/uv.lock',
    'framework/core/package.json',
    'framework/core/tests/',
    'scripts/write-affected-native-cache-manifests.mjs',
    'scripts/run-core-affected-native.mjs',
    'scripts/affected-native-proof.mjs',
    '.github/workflows/affected-native-cache-promote.yml',
    '.github/workflows/affected-native-pr.yml',
    'framework/release/qualified-assignment-core-artifact.mjs',
    'framework/assignment-capture/qualified-assignment-core-consumer.mjs',
    'product/scripts/verify-cli-surface-qualification.mjs',
    'scripts/check-shifu-cache-contract.mjs',
    'docs/shifu/artifact-contract.json',
    'docs/shifu/cache-contract.json',
    'docs/shifu/schema/qualified-assignment-core-artifact-v1.schema.json',
    'docs/shifu/schema/qualified-assignment-core-qualification-v1.schema.json',
    'shifu.gates.json',
    'docs/qualification/gates/',
    'package.json',
  ];

  for (const file of changedFiles) {
    if (
      globalPaths.some(
        (candidate) => file === candidate || file.startsWith(candidate),
      )
    ) {
      global = true;
      if (file.startsWith('framework/core/tests/')) forceFull = true;
      reasons.push({ path: file, kind: 'architecture-or-gate-authority' });
      continue;
    }
    if (!file.startsWith('framework/core/')) {
      reasons.push({ path: file, kind: 'outside-core' });
      continue;
    }
    const relative = file.slice('framework/core/'.length);
    if (/\.(md|txt)$/.test(relative)) {
      reasons.push({ path: file, kind: 'core-documentation-only' });
      continue;
    }
    const nonNativeRule = nonNativeCoreRule(relative);
    if (nonNativeRule) {
      reasons.push({ path: file, kind: nonNativeRule.kind });
      continue;
    }
    if (/\/CMakeLists\.txt$/.test(relative)) {
      global = true;
      reasons.push({ path: file, kind: 'composition-or-build-definition' });
      continue;
    }
    if (
      (relative.startsWith('.cmake/') && relative.endsWith('.cmake')) ||
      (relative.startsWith('cmake/') &&
        (relative.endsWith('.cmake') || relative.endsWith('.cmake.in'))) ||
      (relative.startsWith('.gyp/') && relative.endsWith('.js')) ||
      (relative.startsWith('lib/') && /\.(?:js|d\.ts)$/.test(relative))
    ) {
      global = true;
      forceFull = true;
      reasons.push({ path: file, kind: 'composition-or-build-definition' });
      continue;
    }
    if (
      relative.startsWith('src/libkungfu/schemas/') &&
      (relative.endsWith('.fbs') ||
        relative.endsWith('.bfbs') ||
        relative.endsWith('.h.in'))
    ) {
      const owner = 'libkungfu-contracts';
      direct.add(owner);
      for (const component of reverseClosure(authority, [owner]))
        broad.add(component);
      reasons.push({
        path: file,
        kind: 'schema-layout-propagation',
        component: owner,
      });
      continue;
    }
    const extension = path.extname(relative);
    if (relative.startsWith('stubs/') && extension === '.pyi') {
      global = true;
      forceFull = true;
      reasons.push({
        path: file,
        kind: 'generated-native-binding-contract',
      });
      continue;
    }
    if (
      relative.startsWith('src/python/') ||
      relative.startsWith('tests/python/')
    ) {
      reasons.push({ path: file, kind: 'python-surface' });
      continue;
    }
    if (relative.startsWith('tests/') && /\.(?:c|m)?js$/.test(relative)) {
      reasons.push({ path: file, kind: 'core-javascript-test' });
      continue;
    }
    if (!(authority.extensions || []).includes(extension)) {
      throw new Error(`${file}: unclassified Core file impact`);
    }
    // The authority governs exactly what tracked_roots declares. Native sources
    // outside those roots have no owning component by construction, so demanding
    // one fails closed on files the authority deliberately does not track — the
    // capability slices, for instance, which are standalone probes built only
    // under KUNGFU_WITH_SLICES and linked into no product target. Sources inside
    // the roots that no component claims still fail below, so this widens the
    // authority's edge rather than its interior.
    if (!isTracked(authority, relative)) {
      reasons.push({ path: file, kind: 'outside-architecture-authority' });
      continue;
    }
    const owner = componentOwner(authority, relative);
    direct.add(owner.id);
    if (owner.id === 'core-native-qualification') forceFull = true;
    const rule = publicRule(authority, relative);
    const header = ['.h', '.hh', '.hpp', '.hxx'].includes(extension);
    if (rule) publicRules.add(rule.id);
    if (header || rule) {
      for (const component of reverseClosure(authority, [owner.id]))
        broad.add(component);
      reasons.push({
        path: file,
        kind: rule ? 'public-contract-propagation' : 'header-propagation',
        component: owner.id,
        publicContract: rule?.id || null,
      });
    } else {
      reasons.push({ path: file, kind: 'implementation', component: owner.id });
    }
    if (
      relative.startsWith('src/bindings/') ||
      relative.startsWith('src/libwasm/')
    ) {
      forceFull = true;
    }
  }

  if (global) {
    for (const component of authority.components) broad.add(component.id);
  }
  const closure = new Set([...direct, ...broad]);
  const internalByComponent = new Map();
  for (const target of authority.internal_targets) {
    if (target.kind === 'INTERFACE') continue;
    const list = internalByComponent.get(target.component) || [];
    list.push(target.id);
    internalByComponent.set(target.component, list);
  }
  const targets = [];
  const tests = [];
  const componentById = new Map(
    authority.components.map((component) => [component.id, component]),
  );
  for (const componentId of closure) {
    const component = componentById.get(componentId);
    targets.push(...(internalByComponent.get(componentId) || []));
    if (['yijinjing-schema', 'yijinjing-kernel'].includes(componentId)) {
      targets.push('yijinjing');
    }
    tests.push(...(component?.contract_tests || []));
  }
  for (const ruleId of publicRules) {
    targets.push(
      `kungfu_public_headers_${ruleId.replace(/[^A-Za-z0-9]+/g, '_')}`,
    );
  }
  if (global) {
    targets.push('kungfu', 'yijinjing');
  }
  targets.push(...tests);
  const profile = closure.size
    ? selectProfile(buildAuthority, closure, forceFull)
    : null;
  const sdkImpact = sdkQualificationImpact(changedFiles, base, head, options);
  const devQueueImpact = devQueueQualificationImpact(changedFiles);
  const plan = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base,
    head,
    authority: {
      layers: digest(fs.readFileSync(architecturePath, 'utf8')),
      buildCapabilities: digest(fs.readFileSync(buildPath, 'utf8')),
    },
    changedPaths: unique(changedFiles),
    directComponents: unique(direct),
    closureComponents: unique(closure),
    targets: unique(targets),
    tests: unique(tests),
    profile,
    platformTier: closure.size ? 'github-hosted-linux-native-pr' : 'none',
    sdkQualification: {
      required: sdkImpact.required,
      reasons: sdkImpact.reasons,
    },
    devQueueQualification: devQueueImpact,
    reviewRoutes: unique(closure).map((componentId) => ({
      component: componentId,
      ownerRole: componentById.get(componentId)?.owner,
      backupRole: authority.review_policy.architecture_reviewer_role,
      fallbackAccount: authority.review_policy.fallback_account,
    })),
    reasons: reasons.sort((left, right) => left.path.localeCompare(right.path)),
  };
  return { ...plan, planDigest: digest(plan) };
}

export function planAffectedPaths(changedFiles, base, head) {
  return planFromChanged(
    changedFiles,
    readJson(architecturePath),
    readJson(buildPath),
    base,
    head,
  );
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export function changedPathsBetween(base, head, runGit = git) {
  return runGit(
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACDMRTUXB',
    `${base}...${head}`,
  )
    .split('\n')
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    base: process.env.GITHUB_BASE_SHA || devMergeBaseCandidates()[0],
    head: process.env.GITHUB_HEAD_SHA || 'HEAD',
    changedFiles: [],
    json: false,
    execute: false,
    selfTest: false,
    receipt: '',
    verifyReceipt: '',
    planOut: '',
    planInput: process.env.KUNGFU_AFFECTED_NATIVE_PLAN || '',
    partitionCount: Number(
      process.env.KUNGFU_AFFECTED_NATIVE_PARTITION_COUNT || 1,
    ),
    partitionIndex: Number(
      process.env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX || 0,
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--base') options.base = argv[++index];
    else if (arg === '--head') options.head = argv[++index];
    else if (arg === '--changed-file') options.changedFiles.push(argv[++index]);
    else if (arg === '--receipt') options.receipt = argv[++index];
    else if (arg === '--verify-receipt') options.verifyReceipt = argv[++index];
    else if (arg === '--plan-out') options.planOut = argv[++index];
    else if (arg === '--plan-input') options.planInput = argv[++index];
    else if (arg === '--partition-count')
      options.partitionCount = Number(argv[++index]);
    else if (arg === '--partition-index')
      options.partitionIndex = Number(argv[++index]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function partitionAffectedNativePlan(plan, count = 1, index = 0) {
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new Error(
      'affected-native partition count must be an integer from 1 to 8',
    );
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      'affected-native partition index is outside the partition set',
    );
  }
  const lanes = Array.from({ length: count }, (_, laneIndex) => {
    const targets = plan.targets.filter(
      (_target, targetIndex) => targetIndex % count === laneIndex,
    );
    const targetSet = new Set(targets);
    return {
      index: laneIndex,
      targets,
      tests: plan.tests.filter((test) => targetSet.has(test)),
    };
  });
  const coverage = {
    planDigest: plan.planDigest,
    count,
    lanes,
  };
  const selected = lanes[index];
  return {
    schema: 'kungfu.core-affected-native-partition/v1',
    index,
    count,
    targets: selected.targets,
    tests: selected.tests,
    partitionDigest: digest({
      planDigest: plan.planDigest,
      index,
      count,
      targets: selected.targets,
      tests: selected.tests,
    }),
    coverageDigest: digest(coverage),
  };
}

export function verifyAffectedNativePlan(plan) {
  if (plan.schema !== 'kungfu.core-affected-native-plan/v1') {
    throw new Error('unsupported affected-native plan schema');
  }
  const { planDigest, ...planWithoutDigest } = plan;
  if (planDigest !== digest(planWithoutDigest)) {
    throw new Error('affected-native plan digest drift');
  }
  const currentHead = git('rev-parse', 'HEAD');
  if (plan.head !== currentHead) {
    throw new Error(
      `affected-native plan source drift: expected ${plan.head}, got ${currentHead}`,
    );
  }
  const currentAuthority = {
    layers: digest(fs.readFileSync(architecturePath, 'utf8')),
    buildCapabilities: digest(fs.readFileSync(buildPath, 'utf8')),
  };
  if (stableJson(plan.authority) !== stableJson(currentAuthority)) {
    throw new Error('affected-native plan authority drift');
  }
  return plan;
}

function writePlan(plan, output) {
  const absolute = path.resolve(root, output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(plan, null, 2)}\n`);
  return absolute;
}

async function loadBuildchainToolkit() {
  const [diagnostics, logging] = await Promise.all([
    import('@kungfu-tech/buildchain-alpha/diagnostics'),
    import('@kungfu-tech/buildchain-alpha/logging'),
  ]);
  return { ...diagnostics, ...logging };
}

async function runStep(
  id,
  command,
  args,
  cwd,
  env,
  logRoot,
  logger,
  toolkit,
  { phase, sampleProcess = false, requestedParallelism = 0 } = {},
) {
  const started = Date.now();
  fs.mkdirSync(logRoot, { recursive: true });
  const log = path.join(logRoot, `${id}.log`);
  const details = {
    phase,
    attributes: {
      stepId: id,
      requestedParallelism,
    },
  };
  return measureCandidateStage(
    `affected-native-${id}`,
    `native-${phase}`,
    () =>
      logger.span(`affected-native.${id}`, details, async () => {
        const child = spawn(command, args, {
          cwd,
          env,
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        const logStream = fs.createWriteStream(log, { flags: 'w' });
        child.stdout.on('data', (chunk) => {
          logStream.write(chunk);
          process.stdout.write(chunk);
        });
        child.stderr.on('data', (chunk) => {
          logStream.write(chunk);
          process.stderr.write(chunk);
        });
        const sampler = sampleProcess
          ? toolkit.startProcessSampler({
              rootPid: child.pid,
              intervalMs: 15000,
              label: id,
              command,
              args,
              env,
              requestedParallelism,
              cwd,
            })
          : null;
        const result = await new Promise((resolve) => {
          child.once('error', (error) =>
            resolve({ exitCode: 1, signal: null, error }),
          );
          child.once('close', (exitCode, signal) =>
            resolve({ exitCode, signal }),
          );
        });
        await new Promise((resolve) => logStream.end(resolve));
        const processSummary = sampler
          ? toolkit.summarizeProcessSamples({
              command,
              args,
              env,
              requestedParallelism,
              samples: sampler.stop(),
            })
          : null;
        const step = {
          id,
          command: [command, ...args],
          durationMs: Date.now() - started,
          exitCode: result.exitCode ?? 1,
          signal: result.signal || null,
          log: path.relative(root, log).split(path.sep).join('/'),
          ...(processSummary ? { process: processSummary } : {}),
        };
        if (step.exitCode !== 0) {
          throw Object.assign(
            result.error ||
              new Error(`${id} failed with exit ${step.exitCode}`),
            { step },
          );
        }
        return step;
      }),
    { gateId: 'source.changed-scope' },
  );
}

async function execute(plan, receiptPath, partitionCount, partitionIndex) {
  const baseline = readJson(baselinePath);
  const executionPartition = partitionAffectedNativePlan(
    plan,
    partitionCount,
    partitionIndex,
  );
  const receiptFile =
    receiptPath ||
    path.join(
      'product',
      'qualification',
      'affected-native',
      plan.head.slice(0, 12),
      ...(executionPartition.count > 1
        ? [
            `partition-${executionPartition.index}-of-${executionPartition.count}`,
          ]
        : []),
      'receipt.json',
    );
  const absoluteReceipt = path.resolve(root, receiptFile);
  const diagnosticsPath = path.join(
    path.dirname(absoluteReceipt),
    'diagnostics.json',
  );
  const eventsPath = path.join(path.dirname(absoluteReceipt), 'events.jsonl');
  const logRoot = path.join(path.dirname(absoluteReceipt), 'logs');
  const toolkit = plan.targets.length ? await loadBuildchainToolkit() : null;
  const logger = toolkit
    ? toolkit.createBuildchainLogger({
        cwd: root,
        path: eventsPath,
        console: false,
        strict: true,
        source: 'user',
        component: 'affected-native',
        attributes: {
          gateId: 'source.changed-scope',
          planDigest: plan.planDigest,
          sourceSha: plan.head,
          partitionDigest: executionPartition.partitionDigest,
        },
      })
    : null;
  const steps = [];
  const env = {
    ...process.env,
    KUNGFU_BUILDCHAIN_SOURCE_BUILD: '1',
    KUNGFU_BUILD_PROFILE: plan.profile || 'journal',
    KUNGFU_BUILD_SKIP_KUNGFU_NODE: 'on',
    KUNGFU_BUILD_SKIP_PYKUNGFU: 'on',
  };
  const started = Date.now();
  let status = 'passed';
  let failure = null;
  const requestedParallelism = Math.min(
    os.availableParallelism(),
    baseline.maxParallelism,
  );
  logger?.mark('affected-native.plan.admitted', {
    phase: 'plan',
    attributes: {
      profile: plan.profile || 'none',
      targetCount: executionPartition.targets.length,
      testCount: executionPartition.tests.length,
      partitionIndex: executionPartition.index,
      partitionCount: executionPartition.count,
    },
  });
  try {
    if (executionPartition.targets.length) {
      steps.push(
        await runStep(
          'conan-install',
          path.join(root, 'shifu'),
          ['core:affected:configure'],
          root,
          env,
          logRoot,
          logger,
          toolkit,
          { phase: 'install' },
        ),
      );
      const buildRoot = path.join(coreRoot, 'build', 'affected-native');
      steps.push(
        await runStep(
          'cmake-configure',
          'cmake',
          [
            '-S',
            coreRoot,
            '-B',
            buildRoot,
            '-G',
            'Ninja',
            `-DCMAKE_TOOLCHAIN_FILE=${path.join(coreRoot, 'build', 'conan_toolchain.cmake')}`,
            '-DCMAKE_BUILD_TYPE=Release',
            '-DCMAKE_CXX_SCAN_FOR_MODULES=OFF',
            `-DKUNGFU_BUILD_PROFILE=${plan.profile}`,
          ],
          root,
          env,
          logRoot,
          logger,
          toolkit,
          { phase: 'configure' },
        ),
      );
      steps.push(
        await runStep(
          'cmake-build',
          'cmake',
          [
            '--build',
            buildRoot,
            '--target',
            ...executionPartition.targets,
            '--parallel',
            String(requestedParallelism),
          ],
          root,
          env,
          logRoot,
          logger,
          toolkit,
          {
            phase: 'build',
            sampleProcess: true,
            requestedParallelism,
          },
        ),
      );
      if (executionPartition.tests.length) {
        const expression = `^(${executionPartition.tests.map((test) => test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
        steps.push(
          await runStep(
            'ctest',
            'ctest',
            ['--test-dir', buildRoot, '-R', expression, '--output-on-failure'],
            root,
            env,
            logRoot,
            logger,
            toolkit,
            { phase: 'test' },
          ),
        );
      }
    }
  } catch (error) {
    status = 'failed';
    if (error.step) steps.push(error.step);
    failure = error.message;
  }
  logger?.mark('affected-native.complete', {
    phase: 'receipt',
    attributes: {
      status,
      durationMs: Date.now() - started,
    },
  });
  const lifecycleObservability = toolkit
    ? toolkit.summarizeLifecycleObservability({ logPath: eventsPath })
    : null;
  const processSummary =
    steps.find(({ id }) => id === 'cmake-build')?.process || null;
  let diagnosticsReceipt = null;
  if (toolkit) {
    const diagnostics = toolkit.createDiagnosticsArtifact({
      cwd: root,
      logPath: eventsPath,
      lifecycleObservability,
      processSummary: processSummary || undefined,
      links: {
        receipt: path.relative(root, absoluteReceipt).split(path.sep).join('/'),
        events: path.relative(root, eventsPath).split(path.sep).join('/'),
      },
    });
    diagnostics.consumer = {
      contract: 'kungfu.affected-native-diagnostics/v1',
      gateId: 'source.changed-scope',
      source: { base: plan.base, head: plan.head },
      planDigest: plan.planDigest,
      profile: plan.profile,
      executionPartition,
      status,
    };
    toolkit.writeDiagnosticsArtifact(diagnosticsPath, diagnostics);
    diagnosticsReceipt = {
      contract: diagnostics.contract,
      consumerContract: diagnostics.consumer.contract,
      file: path.relative(root, diagnosticsPath).split(path.sep).join('/'),
      digest: digest(fs.readFileSync(diagnosticsPath, 'utf8')),
      events: path.relative(root, eventsPath).split(path.sep).join('/'),
      lifecycleObservability,
      process: processSummary,
    };
  }
  const toolchain = observeNativeToolchain();
  const receipt = {
    schema: 'kungfu.core-affected-native-receipt/v1',
    status,
    source: { base: plan.base, head: plan.head },
    plan,
    planDigest: plan.planDigest,
    executionPartition,
    platform: `${process.platform}-${process.arch}`,
    toolchain,
    cache: {
      identity: digest({
        head: plan.head,
        profile: plan.profile,
        toolchain,
        authority: plan.authority,
      }),
      profileDigest: process.env.SHIFU_CACHE_PROFILE_DIGEST || null,
      hit: null,
      reason:
        'The current build tools do not expose trustworthy per-target cache hit facts.',
    },
    durationMs: Date.now() - started,
    budgetMs: baseline.requiredBudgetSeconds * 1000,
    steps,
    diagnostics: diagnosticsReceipt,
    failure,
  };
  fs.mkdirSync(path.dirname(absoluteReceipt), { recursive: true });
  fs.writeFileSync(absoluteReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  writeShifuGateEvidence({
    schema: 'kungfu.core-affected-native-receipt/v1',
    pointers: [{ id: 'core-affected-native-receipt', file: absoluteReceipt }],
    root,
  });
  console.log(
    `[core-affected] receipt=${path.relative(root, absoluteReceipt)}`,
  );
  if (status !== 'passed') process.exitCode = 1;
  return receipt;
}

export function verifyAffectedNativeReceipt(receipt) {
  if (receipt.schema !== 'kungfu.core-affected-native-receipt/v1') {
    throw new Error('unsupported affected-native receipt schema');
  }
  const { planDigest, ...planWithoutDigest } = receipt.plan;
  if (
    planDigest !== digest(planWithoutDigest) ||
    receipt.planDigest !== planDigest
  ) {
    throw new Error('affected-native receipt plan digest drift');
  }
  if (!['passed', 'failed'].includes(receipt.status)) {
    throw new Error('affected-native receipt status is invalid');
  }
  if (receipt.executionPartition) {
    const expected = partitionAffectedNativePlan(
      receipt.plan,
      receipt.executionPartition.count,
      receipt.executionPartition.index,
    );
    if (stableJson(receipt.executionPartition) !== stableJson(expected)) {
      throw new Error('affected-native receipt partition drift');
    }
  }
  return true;
}

function selfTest(authority, buildAuthority) {
  let passed = 0;
  const expect = (name, action, pattern = null) => {
    try {
      action();
      if (pattern) throw new Error(`${name}: expected failure`);
      console.log(`  ok: ${name}`);
      passed += 1;
    } catch (error) {
      if (!pattern || !pattern.test(error.message)) throw error;
      console.log(`  ok: ${name}`);
      passed += 1;
    }
  };
  const implementation = [
    'framework/core/src/libkungfu/src/runtime/storage/query_render.cpp',
  ];
  const first = planFromChanged(
    implementation,
    authority,
    buildAuthority,
    'base',
    'head',
  );
  const second = planFromChanged(
    implementation,
    authority,
    buildAuthority,
    'base',
    'head',
  );
  expect('deterministic implementation plan', () => {
    if (stableJson(first) !== stableJson(second)) throw new Error('plan drift');
    if (!first.directComponents.includes('runtime-storage-services'))
      throw new Error('owner missing');
    if (first.sdkQualification.required)
      throw new Error('internal implementation scheduled SDK qualification');
  });
  expect(
    'unrelated root package task does not schedule SDK qualification',
    () => {
      const before = {
        scripts: Object.fromEntries(sdkRootScriptKeys.map((key) => [key, key])),
        packageManager: 'pnpm@10',
        devDependencies: { cmake: '1' },
      };
      const after = structuredClone(before);
      after.scripts['test:gate-latency'] = 'node test.mjs';
      const plan = planFromChanged(
        ['package.json'],
        authority,
        buildAuthority,
        'base',
        'head',
        {
          packageAtRevision: (revision) =>
            revision === 'base' ? before : after,
        },
      );
      if (plan.sdkQualification.required)
        throw new Error('unrelated root task scheduled SDK qualification');
    },
  );
  expect('SDK root package task change schedules qualification', () => {
    const before = {
      scripts: Object.fromEntries(sdkRootScriptKeys.map((key) => [key, key])),
    };
    const after = structuredClone(before);
    after.scripts['pack:sdk'] = 'changed';
    const plan = planFromChanged(
      ['package.json'],
      authority,
      buildAuthority,
      'base',
      'head',
      {
        packageAtRevision: (revision) => (revision === 'base' ? before : after),
      },
    );
    if (!plan.sdkQualification.required)
      throw new Error('SDK root task did not schedule qualification');
  });
  expect('unknown root package impact fails closed', () => {
    const plan = planFromChanged(
      ['package.json'],
      authority,
      buildAuthority,
      'base',
      'head',
      { packageAtRevision: () => null },
    );
    if (!plan.sdkQualification.required)
      throw new Error('unknown package impact skipped SDK qualification');
  });
  expect('public ABI and gate authority schedule SDK qualification', () => {
    for (const file of [
      'framework/core/src/libkungfu/include/kungfu/api.h',
      'framework/core/architecture/sdk-build-plan.json',
      '.github/workflows/affected-native-pr.yml',
      'tests/qualification/layers/sdk/run.mjs',
    ]) {
      const plan = planFromChanged(
        [file],
        authority,
        buildAuthority,
        'base',
        'head',
      );
      if (!plan.sdkQualification.required) {
        throw new Error(`${file} skipped SDK qualification`);
      }
    }
  });
  expect('Core uv lock changes expand native and SDK qualification', () => {
    const plan = planFromChanged(
      ['framework/core/uv.lock'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('Core uv lock native closure incomplete');
    if (!plan.profile)
      throw new Error('Core uv lock did not select a native profile');
    if (!plan.sdkQualification.required)
      throw new Error('Core uv lock skipped SDK qualification');
  });
  expect('partition set is deterministic, disjoint, and complete', () => {
    const partitions = [0, 1].map((index) =>
      partitionAffectedNativePlan(first, 2, index),
    );
    if (partitions[0].coverageDigest !== partitions[1].coverageDigest) {
      throw new Error('partition coverage digest drift');
    }
    const targets = partitions.flatMap(({ targets }) => targets);
    const tests = partitions.flatMap(({ tests }) => tests);
    if (
      stableJson(unique(targets)) !== stableJson(first.targets) ||
      targets.length !== new Set(targets).size
    ) {
      throw new Error('partition target coverage is incomplete or overlapping');
    }
    if (
      stableJson(unique(tests)) !== stableJson(first.tests) ||
      tests.length !== new Set(tests).size
    ) {
      throw new Error('partition test coverage is incomplete or overlapping');
    }
  });
  expect('native contract JSON fixture selects qualification tests', () => {
    const plan = planFromChanged(
      [
        'framework/core/src/libkungfu/tests/fixtures/native_kfx_contract/buildchain-envelope.json',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (!plan.directComponents.includes('core-native-qualification'))
      throw new Error('qualification owner missing');
    if (!plan.tests.includes('kungfu_native_kfx_contract_tests'))
      throw new Error('native KFX contract test missing');
    if (plan.profile !== buildAuthority.default_profile)
      throw new Error('native qualification did not select full profile');
  });
  expect('cross-language native fixture payload is classified', () => {
    const fixture =
      'framework/core/src/libkungfu/tests/fixtures/native_kfx_registry/semantic/contributor/view.js';
    const plan = planFromChanged(
      [fixture],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    const reason = plan.reasons.find((item) => item.path === fixture);
    if (reason?.kind !== 'core-test-fixture') {
      throw new Error('cross-language native fixture was not classified');
    }
  });
  expect('native schema artifacts propagate through contract owners', () => {
    for (const relative of [
      'framework/core/src/libkungfu/schemas/work_events.bfbs',
      'framework/core/src/libkungfu/schemas/work_event_schema.h.in',
    ]) {
      const plan = planFromChanged(
        [relative],
        authority,
        buildAuthority,
        'base',
        'head',
      );
      if (!plan.directComponents.includes('libkungfu-contracts'))
        throw new Error(`schema artifact contract owner missing: ${relative}`);
      if (
        !plan.reasons.some(
          (reason) => reason.kind === 'schema-layout-propagation',
        )
      )
        throw new Error(
          `schema artifact propagation reason missing: ${relative}`,
        );
    }
  });
  expect('cross-language Core qualification expands globally', () => {
    const plan = planFromChanged(
      ['framework/core/tests/python/test_native_kfx_contract.py'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('cross-language qualification closure incomplete');
    if (plan.profile !== buildAuthority.default_profile)
      throw new Error(
        'cross-language qualification did not select full profile',
      );
  });
  expect(
    'outside-Core change emits a required-check-safe tier-none plan',
    () => {
      const plan = planFromChanged(
        ['docs/MAP.md'],
        authority,
        buildAuthority,
        'base',
        'head',
      );
      if (
        plan.platformTier !== 'none' ||
        plan.profile !== null ||
        plan.targets.length ||
        plan.tests.length
      ) {
        throw new Error('outside-Core plan scheduled native work');
      }
    },
  );
  expect('Python source changes do not invent native work', () => {
    const plan = planFromChanged(
      [
        'framework/core/src/python/kungfu/workspace.py',
        'framework/core/src/python/kungfu/agent/commands.json',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'none' ||
      plan.profile !== null ||
      plan.targets.length ||
      plan.tests.length
    ) {
      throw new Error('Python surface scheduled native work');
    }
    const kinds = new Set(plan.reasons.map(({ kind }) => kind));
    if (kinds.size !== 1 || !kinds.has('core-python-source')) {
      throw new Error('Python source classification drifted');
    }
  });
  expect('runtime packaging changes do not invent native work', () => {
    const plan = planFromChanged(
      ['framework/core/.gyp/run-freeze.js'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'none' ||
      plan.profile !== null ||
      plan.targets.length ||
      plan.tests.length
    ) {
      throw new Error('runtime packaging scheduled native work');
    }
    if (!plan.reasons.some(({ kind }) => kind === 'core-packaging-source')) {
      throw new Error('runtime packaging classification missing');
    }
  });
  expect('Core architecture checks do not invent native work', () => {
    const plan = planFromChanged(
      [
        'framework/core/src/libkungfu/check-view-boundary.mjs',
        'framework/core/src/libyijinjing/check-deps.mjs',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'none' ||
      plan.profile !== null ||
      plan.targets.length ||
      plan.tests.length
    ) {
      throw new Error('Core architecture check scheduled native work');
    }
    if (!plan.reasons.some(({ kind }) => kind === 'core-architecture-check')) {
      throw new Error('Core architecture check classification missing');
    }
  });
  expect('generated native binding stubs force full native coverage', () => {
    const plan = planFromChanged(
      ['framework/core/stubs/pykungfu/runtime.pyi'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.profile !== 'full') throw new Error('full profile not selected');
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('native binding contract closure incomplete');
    if (
      !plan.reasons.some(
        ({ kind }) => kind === 'generated-native-binding-contract',
      )
    ) {
      throw new Error('native binding contract classification missing');
    }
  });
  // Guards the interior of the authority: src/libkungfu/src/ is a tracked root,
  // so an unowned source under it must still fail closed. The tracked_roots
  // exemption below widens the authority's edge, never its interior.
  expect(
    'unclassified source fails closed',
    () =>
      planFromChanged(
        ['framework/core/src/libkungfu/src/runtime/unknown.cpp'],
        authority,
        buildAuthority,
        'base',
        'head',
      ),
    /exactly one architecture component/,
  );
  expect('native source outside tracked_roots is outside the authority', () => {
    const plan = planFromChanged(
      ['framework/core/slices/embedding/main.cpp'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      !plan.reasons.some(
        ({ kind }) => kind === 'outside-architecture-authority',
      )
    ) {
      throw new Error('untracked native source was not classified');
    }
    if (plan.directComponents.length !== 0)
      throw new Error('untracked native source claimed a component');
  });
  expect('Core test fixtures and qualification harness expand globally', () => {
    const plan = planFromChanged(
      [
        'framework/core/tests/fixtures/peer_lifecycle_probe.py',
        'framework/core/tests/qualification/live-peer-continuity/run.mjs',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'github-hosted-linux-native-pr' ||
      plan.profile !== buildAuthority.default_profile ||
      plan.closureComponents.length !== authority.components.length
    ) {
      throw new Error('Core test surface did not expand globally');
    }
  });
  expect('Core slice qualification harness remains non-native', () => {
    const plan = planFromChanged(
      ['framework/core/slices/embedding/run.mjs'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'none' ||
      plan.profile !== null ||
      plan.targets.length ||
      plan.tests.length ||
      !plan.reasons.some(({ kind }) => kind === 'core-qualification-harness')
    ) {
      throw new Error('Core slice harness scheduled native work');
    }
  });
  expect('unknown qualification source expands globally', () => {
    const plan = planFromChanged(
      ['framework/core/tests/qualification/example/driver.cpp'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.profile !== buildAuthority.default_profile ||
      plan.closureComponents.length !== authority.components.length
    ) {
      throw new Error('unknown qualification source did not expand globally');
    }
  });
  expect('authority dependency change expands globally', () => {
    for (const file of [
      'framework/core/architecture/layers.json',
      'framework/release/qualified-assignment-core-artifact.mjs',
      'framework/assignment-capture/qualified-assignment-core-consumer.mjs',
      'scripts/check-shifu-cache-contract.mjs',
      'docs/shifu/artifact-contract.json',
      'docs/shifu/cache-contract.json',
      'docs/shifu/schema/qualified-assignment-core-artifact-v1.schema.json',
      'docs/shifu/schema/qualified-assignment-core-qualification-v1.schema.json',
    ]) {
      const plan = planFromChanged(
        [file],
        authority,
        buildAuthority,
        'base',
        'head',
      );
      if (plan.closureComponents.length !== authority.components.length)
        throw new Error(`${file}: closure incomplete`);
      if (!plan.profile) throw new Error(`${file}: native profile missing`);
    }
  });
  expect('Core native build support changes expand globally', () => {
    const plan = planFromChanged(
      [
        'framework/core/.cmake/libwasm-cargo-cache.cmake',
        'framework/core/cmake/KungfuConfig.cmake.in',
        'framework/core/.gyp/run-link-node.js',
        'framework/core/lib/executable.js',
        'framework/core/lib/kungfu.d.ts',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.closureComponents.length !== authority.components.length ||
      plan.profile !== 'full' ||
      !plan.reasons.some(
        ({ kind }) => kind === 'composition-or-build-definition',
      )
    ) {
      throw new Error('Core build support did not schedule full native work');
    }
  });
  expect('core build definition change expands globally', () => {
    const plan = planFromChanged(
      ['framework/core/pyproject.toml'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('pyproject.toml did not expand to the full closure');
    if (
      !plan.reasons.some(
        ({ kind }) => kind === 'architecture-or-gate-authority',
      )
    )
      throw new Error('pyproject.toml not classified as a build authority');
  });
  expect('public header propagates to consumers', () => {
    const plan = planFromChanged(
      ['framework/core/src/libkungfu/include/kungfu/api.h'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length <= plan.directComponents.length)
      throw new Error('no propagation');
    if (!plan.tests.includes('kungfu_api_contract_tests'))
      throw new Error('standard ABI test missing');
    if (plan.targets.includes('kungfu_contracts'))
      throw new Error('INTERFACE target scheduled as a build goal');
  });
  expect(
    'target deletion fails closed',
    () => {
      const changed = structuredClone(authority);
      changed.target_evidence = changed.target_evidence.map((record) => ({
        ...record,
        targets: record.targets.filter(
          (target) => target !== 'kungfu_storage_services',
        ),
      }));
      validateAuthority(changed, buildAuthority);
    },
    /lacks CMake evidence/,
  );
  expect(
    'test mapping loss fails closed',
    () => {
      const changed = structuredClone(authority);
      changed.components[0].contract_tests.push('missing_native_contract_test');
      validateAuthority(changed, buildAuthority);
    },
    /contract test lacks CMake evidence/,
  );
  expect(
    'receipt drift fails closed',
    () => {
      const receipt = {
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'passed',
        plan: { ...first, planDigest: `sha256:${'0'.repeat(64)}` },
        planDigest: first.planDigest,
      };
      verifyAffectedNativeReceipt(receipt);
    },
    /plan digest drift/,
  );
  expect(
    'receipt partition drift fails closed',
    () => {
      const executionPartition = partitionAffectedNativePlan(first, 2, 0);
      verifyAffectedNativeReceipt({
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'passed',
        plan: first,
        planDigest: first.planDigest,
        executionPartition: {
          ...executionPartition,
          targets: [...executionPartition.targets, 'foreign-target'],
        },
      });
    },
    /partition drift/,
  );
  const sourceBoundPlan = planFromChanged(
    ['docs/README.md'],
    authority,
    buildAuthority,
    git('rev-parse', 'HEAD'),
    git('rev-parse', 'HEAD'),
  );
  expect('source-bound plan verifies before execution', () => {
    verifyAffectedNativePlan(sourceBoundPlan);
  });
  expect(
    'source-bound plan digest drift fails closed',
    () => verifyAffectedNativePlan({ ...sourceBoundPlan, profile: 'full' }),
    /plan digest drift/,
  );
  console.log(`[core-affected] ${passed} negative/determinism fixtures passed`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const authority = readJson(architecturePath);
  const buildAuthority = readJson(buildPath);
  if (options.selfTest) return selfTest(authority, buildAuthority);
  if (options.verifyReceipt) {
    verifyAffectedNativeReceipt(
      readJson(path.resolve(root, options.verifyReceipt)),
    );
    console.log('[core-affected] receipt verified');
    return;
  }
  const plan = options.planInput
    ? verifyAffectedNativePlan(readJson(path.resolve(root, options.planInput)))
    : (() => {
        const base = git('rev-parse', options.base);
        const head = git('rev-parse', options.head);
        const changedFiles = options.changedFiles.length
          ? options.changedFiles
          : changedPathsBetween(base, head);
        return planFromChanged(
          changedFiles,
          authority,
          buildAuthority,
          base,
          head,
        );
      })();
  if (options.planOut) writePlan(plan, options.planOut);
  if (options.json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(
      `[core-affected] ${plan.base.slice(0, 12)}..${plan.head.slice(0, 12)}`,
    );
    console.log(
      `[core-affected] profile=${plan.profile || 'none'} tier=${plan.platformTier}`,
    );
    console.log(
      `[core-affected] components=${plan.closureComponents.join(', ') || 'none'}`,
    );
    console.log(`[core-affected] targets=${plan.targets.join(', ') || 'none'}`);
    console.log(`[core-affected] tests=${plan.tests.join(', ') || 'none'}`);
  }
  if (options.execute) {
    await execute(
      plan,
      options.receipt,
      options.partitionCount,
      options.partitionIndex,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(`[core-affected] ${error.message}`);
    process.exitCode = 1;
  }
}
