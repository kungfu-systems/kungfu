#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRuleset,
  validateContract as validateAlphaRulesetContract,
} from '../../scripts/alpha-ruleset.mjs';
import {
  activeProjection,
  readAuthority,
} from '../version-line/version-line-authority.mjs';
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const FILE = path.join(ROOT, 'framework/release/publication-surfaces.json');
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
export const digest = (v) =>
  `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex')}`;
const fd = (p) =>
  `sha256:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
const omit = (o, k) =>
  Object.fromEntries(Object.entries(o).filter(([n]) => n !== k));
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const need = (v, n) => {
  if (!String(v || '').trim()) throw new Error(`${n} is required`);
  return v;
};
const uniq = (v, n) => {
  if (new Set(v).size !== v.length) throw new Error(`${n} duplicates`);
  return v;
};
const workflows = (root = ROOT) =>
  fs
    .readdirSync(path.join(root, '.github/workflows'))
    .filter((n) => /\.ya?ml$/.test(n))
    .map((n) => `.github/workflows/${n}`)
    .sort();
const workflowJob = (source, id) => {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${id}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};
export function validatePromotionWorkflowAuthority(
  promotionWorkflow,
  recoveryRuntimeSha,
) {
  if (!/^[0-9a-f]{40}$/u.test(recoveryRuntimeSha))
    throw new Error('Alpha recovery publication runtime is invalid');
  const promote = workflowJob(promotionWorkflow, 'promote');
  const recover = workflowJob(promotionWorkflow, 'recover');
  if (
    !promote.includes(
      'uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v3',
    ) ||
    !promote.includes("&& 'v3-alpha' || 'v3'") ||
    /kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@[0-9a-f]{40}/u.test(
      promote,
    ) ||
    !recover.includes(
      'uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@v3-alpha',
    ) ||
    /kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@[0-9a-f]{40}/u.test(
      recover,
    ) ||
    !/^\s+buildchain-channel: auto\s*$/mu.test(recover) ||
    !/^\s+buildchain-ref: \$\{\{ inputs\.resume-buildchain-runtime-sha \}\}\s*$/mu.test(
      recover,
    ) ||
    promotionWorkflow.includes('kungfu-trader/workflows@v1')
  )
    throw new Error(
      '.github/workflows/release-new-version.yml authority drift',
    );
  return true;
}
export function validateBuildWorkflowAuthority(
  buildWorkflow,
  buildchainContract,
) {
  const workflowShellRef = buildchainContract.build_channel_ref;
  const workflowShellMajor = buildchainContract.build_major;
  const workflowShellSha = buildchainContract.build_workflow_shell_resolved_sha;
  const runtimeSha = buildchainContract.build_runtime_resolved_sha;
  if (
    workflowShellRef !== 'v3-alpha' ||
    workflowShellMajor !== 'v3' ||
    workflowShellRef !== `${workflowShellMajor}-alpha` ||
    buildchainContract.workflow_shell_ref !== workflowShellRef
  )
    throw new Error('Build workflow shell channel or major is invalid');
  if (
    !/^[0-9a-f]{40}$/u.test(workflowShellSha) ||
    !/^[0-9a-f]{40}$/u.test(runtimeSha) ||
    workflowShellSha !== runtimeSha
  )
    throw new Error('Build workflow shell or runtime revision is invalid');
  const buildShellCalls = [
    ...buildWorkflow.matchAll(
      /^\s+uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/\.build\.yml@(\S+)\s*$/gmu,
    ),
  ];
  const buildchainRefLines =
    buildWorkflow.match(/^\s+buildchain-ref:\s*.+$/gmu) || [];
  const expectedChannelLines =
    buildWorkflow.match(/^\s+buildchain-contract-expected-channel:\s*.+$/gmu) ||
    [];
  const expectedMajorLines =
    buildWorkflow.match(/^\s+buildchain-contract-expected-major:\s*.+$/gmu) ||
    [];
  if (
    buildShellCalls.length !== 1 ||
    buildShellCalls[0][1] !== workflowShellSha ||
    buildchainRefLines.length !== 1 ||
    buildchainRefLines[0].trim() !== `buildchain-ref: ${runtimeSha}` ||
    expectedChannelLines.length !== 1 ||
    expectedChannelLines[0].trim() !==
      'buildchain-contract-expected-channel: alpha' ||
    expectedMajorLines.length !== 1 ||
    expectedMajorLines[0].trim() !== 'buildchain-contract-expected-major: v3' ||
    buildWorkflow.includes('inputs.buildchain-ref') ||
    buildWorkflow.includes('kungfu-trader/workflows@v1')
  )
    throw new Error('.github/workflows/build.yml authority drift');
  return true;
}
export function discoverBuildchainReleaseWorkflows(r, paths) {
  const p = new RegExp(r.repositories.buildchain.workflowDiscoveryPattern);
  return paths
    .filter(
      (x) =>
        x.startsWith('.github/workflows/') &&
        /\.ya?ml$/.test(x) &&
        p.test(path.posix.basename(x)),
    )
    .sort();
}
export function validateExternalWorkflowInventory(r, paths) {
  const a = discoverBuildchainReleaseWorkflows(r, paths);
  const e = [...r.repositories.buildchain.workflowInventory].sort();
  const as = new Set(a);
  const es = new Set(e);
  return {
    qualifying: JSON.stringify(a) === JSON.stringify(e),
    unregistered: a.filter((x) => !es.has(x)),
    stale: e.filter((x) => !as.has(x)),
  };
}

function validatePublicationIdentity(r, root) {
  const authority = readAuthority(
    path.join(root, 'framework/version-line/version-line-authority.json'),
  );
  const { line: activeLine } = activeProjection(authority);
  if (
    r.schema !== 'kungfu.release-publication-control-plane/v1' ||
    r.status !== 'active'
  )
    throw new Error('registry inactive');
  if (r.versionLineAuthorityRoot !== authority.authorityRoot)
    throw new Error('publication version-line authority drift');
  const protocol = r.protocol;
  if (
    protocol.schema !== 'kungfu.release-publication-protocol/v1' ||
    protocol.authority !== 'adapter-only' ||
    protocol.protocolRoot !== digest(omit(protocol, 'protocolRoot'))
  )
    throw new Error('protocol root mismatch');
  const invariantIds = uniq(
    protocol.invariants.map((item) => need(item.id, 'invariant id')),
    'invariants',
  );
  if (invariantIds.length !== 9) throw new Error('protocol incomplete');
  for (const invariant of protocol.invariants)
    need(invariant.requirement, invariant.id);
  return { activeLine, invariantIds };
}

function validateKungfuWorkflowInventory(r, root) {
  const declared = uniq(
    r.repositories.kungfu.workflowInventory.map((item) => item.path),
    'workflow inventory',
  ).sort();
  const workflowInventory = new Map(
    r.repositories.kungfu.workflowInventory.map((item) => [item.path, item]),
  );
  if (JSON.stringify(declared) !== JSON.stringify(workflows(root)))
    throw new Error('Kungfu workflow inventory drift');
  const surfaceIds = new Set(r.surfaces.map((item) => item.id));
  for (const workflow of r.repositories.kungfu.workflowInventory) {
    need(workflow.owner, `${workflow.path}.owner`);
    if (workflow.sourceRoot !== fd(path.join(root, workflow.path)))
      throw new Error(`${workflow.path} source root drift`);
    if (
      workflow.classification !== 'non-publication' &&
      !workflow.surfaceIds.length
    )
      throw new Error(`${workflow.path} eligible but unbound`);
    for (const id of workflow.surfaceIds)
      if (!surfaceIds.has(id))
        throw new Error(`${workflow.path} unknown surface`);
  }
  return { declared, workflowInventory };
}

function validatePublicationSurface(surface, invariantIds, inventory) {
  for (const field of [
    'id',
    'class',
    'owner',
    'artifactSource',
    'credentialIsland',
    'readback',
    'rollback',
    'telemetry',
    'lifecycle',
    'protocolMode',
  ])
    need(surface[field], `${surface.id}.${field}`);
  for (const workflow of surface.workflowBindings || []) {
    if (!inventory.declared.includes(workflow))
      throw new Error(`${surface.id} unknown workflow`);
    if (
      !inventory.workflowInventory
        .get(workflow)
        ?.surfaceIds.includes(surface.id)
    )
      throw new Error(`${surface.id} workflow binding is not surface-bound`);
  }
  if (surface.protocolMode === 'conformant') {
    if (
      JSON.stringify(Object.keys(surface.bindings || {}).sort()) !==
      JSON.stringify([...invariantIds].sort())
    )
      throw new Error(`${surface.id} does not bind every invariant`);
    return;
  }
  const isolation = surface.isolation || {};
  for (const field of [
    'rationale',
    'owner',
    'risk',
    'reviewDate',
    'sunsetCondition',
  ])
    need(isolation[field], `${surface.id}.isolation.${field}`);
  if (
    !isolation.missingInvariants?.length ||
    JSON.stringify(
      [...isolation.preservedInvariants, ...isolation.missingInvariants].sort(),
    ) !== JSON.stringify([...invariantIds].sort())
  )
    throw new Error(`${surface.id} isolation must partition every invariant`);
}

function validateRulesetContracts(r, root, activeLine) {
  const channels = new Set();
  for (const contract of r.rulesetContracts) {
    channels.add(contract.channel);
    if (contract.requiredBeforePublication !== true)
      throw new Error(`${contract.id} optional ruleset`);
    if (contract.adapterContractPath) {
      const adapter = read(path.join(root, contract.adapterContractPath));
      validateAlphaRulesetContract(adapter);
      if (`refs/heads/${adapter.targetRef}` !== contract.target)
        throw new Error(`${contract.id} adapter drift`);
    } else if (
      contract.contractRoot !== digest(omit(contract, 'contractRoot')) ||
      contract.ruleset.bypass_actors.length
    )
      throw new Error(`${contract.id} ruleset drift`);
  }
  const expectedTargets = {
    alpha: `refs/heads/${activeLine.branches.alpha}`,
    stable: `refs/heads/${activeLine.branches.stable}`,
    major: `refs/heads/${activeLine.branches.majorPublicationGate}`,
  };
  for (const contract of r.rulesetContracts)
    if (
      contract.id !== `${contract.channel}-current` ||
      contract.target !== expectedTargets[contract.channel]
    )
      throw new Error(`${contract.channel} ruleset version-line drift`);
  for (const channel of ['alpha', 'stable', 'major'])
    if (!channels.has(channel)) throw new Error(`missing ${channel} ruleset`);
}

function validateStableLedgerBindings(r, activeLine) {
  const stableSurface = r.surfaces.find(({ id }) => id === 'product-stable');
  for (const value of [
    stableSurface?.bindings?.['exact-source-admission'],
    stableSurface?.bindings?.['durable-history'],
  ])
    if (!String(value || '').includes(activeLine.candidateLedger))
      throw new Error('stable candidate ledger version-line drift');
}

function validateBuildchainInventory(r, root) {
  const buildchain = r.repositories.buildchain;
  if (
    !/^[0-9a-f]{40}$/.test(buildchain.sourceRevision) ||
    buildchain.workflowInventoryRoot !==
      digest([...buildchain.workflowInventory].sort())
  )
    throw new Error('Buildchain inventory drift');
  const stable = read(
    path.join(root, buildchain.stableContractLock),
  ).buildchain;
  const runtime = read(
    path.join(root, buildchain.runtimeContractLock),
  ).buildchain;
  if (
    stable.ref !== 'v3' ||
    stable.compatibilityPolicy !== 'major-compatible' ||
    runtime.ref !== 'v3-alpha' ||
    runtime.resolvedSha !== buildchain.sourceRevision
  )
    throw new Error('Buildchain contract drift');
  const stableSurfaceIds = new Set(stable.surfaces.map((item) => item.id));
  const runtimeSurfaceIds = new Set(runtime.surfaces.map((item) => item.id));
  for (const capability of r.buildchainCapabilities.required) {
    const bindings = r.buildchainCapabilities.bindings[capability] || [];
    if (
      !bindings.some((item) => stableSurfaceIds.has(item)) ||
      !bindings.some((item) => runtimeSurfaceIds.has(item))
    )
      throw new Error(`Buildchain capability ${capability} unbound`);
  }
}

function validatePublicationWorkflows(r, root) {
  const buildWorkflow = fs.readFileSync(
    path.join(root, '.github/workflows/build.yml'),
    'utf8',
  );
  const promotionRehearsal = read(
    path.join(root, 'docs/release-promotion-rehearsal.contract.json'),
  );
  validateBuildWorkflowAuthority(buildWorkflow, promotionRehearsal.buildchain);
  const promotionWorkflow = fs.readFileSync(
    path.join(root, '.github/workflows/release-new-version.yml'),
    'utf8',
  );
  const releaseAdmission = read(
    path.join(root, 'docs/qualification/gates/release-admission-policy.json'),
  );
  validatePromotionWorkflowAuthority(
    promotionWorkflow,
    releaseAdmission.buildchain.runtimes.alpha.publicationRuntimeSha,
  );
}

export function validateRegistry(r, { root = ROOT } = {}) {
  const { activeLine, invariantIds } = validatePublicationIdentity(r, root);
  const inventory = validateKungfuWorkflowInventory(r, root);
  for (const surface of r.surfaces)
    validatePublicationSurface(surface, invariantIds, inventory);
  validateRulesetContracts(r, root, activeLine);
  validateStableLedgerBindings(r, activeLine);
  validateBuildchainInventory(r, root);
  validatePublicationWorkflows(r, root);
  if (r.registryRoot !== digest(omit(r, 'registryRoot')))
    throw new Error('registry root mismatch');
  return r;
}
function rulesetSpec(contract, root = ROOT) {
  if (!contract.adapterContractPath) return contract.ruleset;
  const adapter = read(path.join(root, contract.adapterContractPath));
  validateAlphaRulesetContract(adapter);
  return adapter.ruleset;
}

export function compareRulesetContract(
  contract,
  liveRulesets,
  { root = ROOT } = {},
) {
  const matching = (liveRulesets || []).filter((ruleset) => {
    const refName = ruleset?.conditions?.ref_name || {};
    return (
      ruleset.target === 'branch' &&
      refName.include?.length === 1 &&
      refName.include[0] === contract.target &&
      (refName.exclude || []).length === 0
    );
  });
  const expected = normalizeRuleset(rulesetSpec(contract, root));
  if (matching.length === 0)
    return { status: 'missing', qualifying: false, expected, observed: null };
  if (matching.length > 1)
    return {
      status: 'ambiguous',
      qualifying: false,
      expected,
      observed: matching.map(normalizeRuleset),
    };
  const observed = normalizeRuleset(matching[0]);
  const qualifying =
    JSON.stringify(canonical(expected)) === JSON.stringify(canonical(observed));
  return {
    status: qualifying ? 'matching' : 'drifted',
    qualifying,
    expected,
    observed,
  };
}

function githubRead(route) {
  const result = childProcess.spawnSync(
    'gh',
    [
      'api',
      route,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0)
    throw new Error(`GitHub read failed closed for ${route}`);
  return JSON.parse(String(result.stdout || 'null'));
}

export function inspectLive(r, { root = ROOT, github = githubRead } = {}) {
  validateRegistry(r, { root });
  const repository = r.repositories.kungfu.repository;
  const listed = github(
    `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
  );
  if (!Array.isArray(listed))
    throw new Error('GitHub ruleset listing is not an array');
  const detailed = listed.map((entry) =>
    github(`repos/${repository}/rulesets/${entry.id}`),
  );
  const rulesets = r.rulesetContracts.map((contract) => ({
    id: contract.id,
    channel: contract.channel,
    target: contract.target,
    ...compareRulesetContract(contract, detailed, { root }),
  }));
  const buildchain = r.repositories.buildchain;
  const tree = github(
    `repos/${buildchain.repository}/git/trees/${buildchain.sourceRevision}?recursive=1`,
  );
  if (tree?.truncated === true || !Array.isArray(tree?.tree))
    throw new Error('Buildchain tree read failed closed');
  const inventory = validateExternalWorkflowInventory(
    r,
    tree.tree.map((entry) => entry.path),
  );
  const base = status(r);
  const liveSurfaces = base.surfaces.map((surface) => {
    const registered = r.surfaces.find(
      (candidate) => candidate.id === surface.id,
    );
    const requiredChannel =
      registered.channel ||
      (surface.id === 'product-binaries' ? 'alpha' : null);
    const rule = rulesets.find(
      (candidate) => candidate.channel === requiredChannel,
    );
    return {
      ...surface,
      rulesetStatus: rule?.status || 'isolated',
      publicationReady:
        surface.publicationReady &&
        rule?.qualifying === true &&
        inventory.qualifying,
    };
  });
  return {
    schema: 'kungfu.release-publication-live-status/v1',
    registryRoot: r.registryRoot,
    protocolRoot: r.protocol.protocolRoot,
    qualifying:
      inventory.qualifying &&
      liveSurfaces
        .filter((surface) => surface.protocolMode === 'conformant')
        .every((surface) => surface.publicationReady),
    buildchain: {
      repository: buildchain.repository,
      sourceRevision: buildchain.sourceRevision,
      ...inventory,
    },
    rulesets,
    surfaces: liveSurfaces,
  };
}

export function status(r) {
  validateRegistry(r);
  return {
    schema: 'kungfu.release-publication-status/v1',
    registryRoot: r.registryRoot,
    protocolRoot: r.protocol.protocolRoot,
    sourceAcceptance: 'passed',
    buildchain: r.repositories.buildchain,
    surfaces: r.surfaces.map((s) => ({
      id: s.id,
      lifecycle: s.lifecycle,
      protocolMode: s.protocolMode,
      publicationReady:
        s.protocolMode === 'conformant' && s.lifecycle === 'active',
      nextAction:
        s.protocolMode === 'conformant'
          ? 'Run bound live gates.'
          : s.isolation.sunsetCondition,
    })),
  };
}
export function admit(r, id, operation = 'publication') {
  validateRegistry(r);
  const s = r.surfaces.find((x) => x.id === id);
  if (!s) throw new Error(`unknown surface ${id}`);
  if (operation === 'rehearsal')
    return {
      schema: 'kungfu.release-publication-admission/v1',
      surfaceId: id,
      operation,
      qualifying: true,
      publishing: false,
      nextAction:
        s.protocolMode === 'conformant'
          ? 'Inspect live evidence.'
          : s.isolation.sunsetCondition,
    };
  const qualifying =
    s.protocolMode === 'conformant' && s.lifecycle === 'active';
  return {
    schema: 'kungfu.release-publication-admission/v1',
    surfaceId: id,
    operation,
    qualifying,
    publishing: false,
    reason: qualifying
      ? 'Source admitted; live gates remain mandatory.'
      : 'Isolated surface is not common-protocol admitted.',
    nextAction: qualifying
      ? 'Continue only in a separately authorized protected controller.'
      : s.isolation.sunsetCondition,
  };
}
export function roots(r, root = ROOT) {
  const v = structuredClone(r);
  v.protocol.protocolRoot = digest(omit(v.protocol, 'protocolRoot'));
  for (const c of v.rulesetContracts)
    if (c.ruleset) c.contractRoot = digest(omit(c, 'contractRoot'));
  for (const w of v.repositories.kungfu.workflowInventory)
    w.sourceRoot = fd(path.join(root, w.path));
  v.repositories.buildchain.workflowInventoryRoot = digest(
    [...v.repositories.buildchain.workflowInventory].sort(),
  );
  v.registryRoot = digest(omit(v, 'registryRoot'));
  return v;
}
function parse(a) {
  const [command = 'status', ...rest] = a;
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (f === '--') continue;
    if (!f.startsWith('--')) throw new Error(`invalid ${f}`);
    const key = f.slice(2);
    if (key === 'live') {
      o[key] = true;
      continue;
    }
    if (i + 1 >= rest.length || rest[i + 1].startsWith('--'))
      throw new Error(`${f} requires a value`);
    o[key] = rest[++i];
  }
  return { command, o };
}
function main() {
  const { command, o } = parse(process.argv.slice(2));
  const file = path.resolve(o.registry || FILE);
  const r = read(file);
  if (command === 'write-roots') {
    const v = roots(r);
    fs.writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
    console.log(
      JSON.stringify(
        { registryRoot: v.registryRoot, protocolRoot: v.protocol.protocolRoot },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'check') {
    validateRegistry(r);
    console.log(
      JSON.stringify(
        {
          schema: 'kungfu.release-publication-check/v1',
          qualifying: true,
          registryRoot: r.registryRoot,
          workflowCount: r.repositories.kungfu.workflowInventory.length,
          surfaceCount: r.surfaces.length,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(o.live ? inspectLive(r) : status(r), null, 2));
    return;
  }
  if (command === 'admit' || command === 'rehearse') {
    const x = admit(
      r,
      need(o.surface, '--surface'),
      command === 'rehearse' ? 'rehearsal' : o.operation || 'publication',
    );
    console.log(JSON.stringify(x, null, 2));
    if (!x.qualifying) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command ${command}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  try {
    main();
  } catch (e) {
    console.error(`[release-publication] ${e.message}`);
    process.exit(1);
  }
