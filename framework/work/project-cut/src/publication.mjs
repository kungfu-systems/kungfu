// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyGitEpisodeEvidence } from '../../episode-provider/src/git-workspace-episode-provider.mjs';
import {
  canonicalJson,
  parseRootJson,
  semanticRoot,
  sha256Bytes,
  verifyProjectCut,
  verifyProjectCutReceipt,
} from './project-cut.mjs';

export const PUBLICATION_REQUEST_SCHEMA =
  'kungfu.settlement-publication.request/v1';
export const PUBLICATION_BATCH_INPUT_SCHEMA =
  'kungfu.settlement-publication.batch-input/v1';
export const PUBLICATION_MANIFEST_SCHEMA =
  'kungfu.settlement-publication.manifest/v1';
export const PUBLICATION_PLAN_SCHEMA = 'kungfu.settlement-publication.plan/v1';
export const PUBLICATION_STATE_SCHEMA =
  'kungfu.settlement-publication.state/v1';
export const PUBLICATION_STATUS_SCHEMA =
  'kungfu.settlement-publication.status/v1';
export const PUBLICATION_TRIGGER_SCHEMA =
  'kungfu.settlement-publication.trigger/v1';
export const PUBLICATION_NO_RECURSION_SCHEMA =
  'kungfu.settlement-publication.no-recursion/v1';
export const PUBLICATION_OBSERVATION_SCHEMA =
  'kungfu.settlement-publication.pull-request-observation/v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/u;
const INVALID_REF_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const GENERATED_BY = 'kungfu-settlement-publication/v1';
const GENERATED_LABEL = 'kungfu-machine-ledger';
const SOURCE_PREFIX = 'machine-ledger/settlement/';
const TRACKED_ROOT = '.kungfu/ledger-publications/sha256';
const RUNTIME_ROOT = '.kungfu/runtime/settlement-publications/sha256';
const MAX_EPISODES = 256;
const MAX_PROJECT_CUTS = 256;
const MAX_TRACKED_FILES = 1024;
const MAX_TRACKED_BYTES = 16 * 1024 * 1024;
const DEFAULT_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const require = createRequire(import.meta.url);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRepositoryJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function loadAjv2020() {
  try {
    return require('ajv/dist/2020.js').default;
  } catch {
    return null;
  }
}

export function computeSettlementPublicationContractRoots(
  root = DEFAULT_REPOSITORY_ROOT,
) {
  const contract = readRepositoryJson(
    root,
    'framework/work/project-cut/publication.contract.json',
  );
  const files = contract.schemaBundle.files.map((relative) => ({
    path: relative,
    root: semanticRoot(
      readRepositoryJson(
        root,
        path.join('framework/work/project-cut', relative),
      ),
    ),
  }));
  const schemaRoot = semanticRoot({
    schema: 'kungfu.settlement-publication.schema-bundle/v1',
    files,
  });
  const { contractRoot: _contractRoot, ...preimage } = contract;
  return { contract, files, schemaRoot, contractRoot: semanticRoot(preimage) };
}

export function checkSettlementPublicationContract(
  root = DEFAULT_REPOSITORY_ROOT,
) {
  const roots = computeSettlementPublicationContractRoots(root);
  if (roots.contract.schemaBundle.schemaRoot !== roots.schemaRoot)
    throw failure(
      'publication-schema-root-mismatch',
      `expected ${roots.contract.schemaBundle.schemaRoot}, got ${roots.schemaRoot}`,
    );
  if (roots.contract.contractRoot !== roots.contractRoot)
    throw failure(
      'publication-contract-root-mismatch',
      `expected ${roots.contract.contractRoot}, got ${roots.contractRoot}`,
    );
  if (
    roots.contract.protection.directTargetPush !== false ||
    roots.contract.protection.oneOpenPullRequestPerBatch !== true ||
    roots.contract.noRecursion.publicationRootSuppressesSuccessor !== true ||
    roots.contract.liveness.runtimeContinuationBlockedByPublication !== false
  )
    throw failure(
      'publication-authority-boundary-drift',
      'settlement publication authority boundary drifted',
    );
  const Ajv2020 = loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const relative of roots.contract.schemaBundle.files)
      ajv.addSchema(
        readRepositoryJson(
          root,
          path.join('framework/work/project-cut', relative),
        ),
      );
  }
  return {
    ok: true,
    schemaRoot: roots.schemaRoot,
    contractRoot: roots.contractRoot,
    schemaFiles: roots.files.length,
    schemaValidation: Ajv2020 ? 'compiled' : 'skipped',
  };
}

function exactFields(value, allowed, required, label) {
  if (!isObject(value))
    throw failure('invalid-type', `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw failure('unknown-field', `${label}.${key} is not admitted`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw failure('missing-field', `${label}.${key} is required`);
  }
}

function requireRoot(value, label) {
  if (!ROOT.test(String(value ?? '')))
    throw failure('missing-root', `${label} must be a lowercase SHA-256 root`);
  return String(value);
}

function requireSafeId(value, label) {
  if (!SAFE_ID.test(String(value ?? '')))
    throw failure('invalid-value', `${label} is not a safe identifier`);
  return String(value);
}

function requireRef(value, label) {
  const text = String(value ?? '');
  const components = text.split('/');
  if (
    !text ||
    text === '@' ||
    text.startsWith('/') ||
    text.endsWith('/') ||
    text.endsWith('.') ||
    text.includes('..') ||
    text.includes('//') ||
    text.includes('@{') ||
    components.some(
      (component) =>
        !component || component.startsWith('.') || component.endsWith('.lock'),
    ) ||
    [...text].some((character) => {
      const code = character.codePointAt(0);
      return (
        code === undefined ||
        code <= 0x20 ||
        code === 0x7f ||
        INVALID_REF_CHARACTERS.has(character)
      );
    })
  )
    throw failure('invalid-ref', `${label} is not a safe Git ref`);
  return text;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sortedUniqueRoots(values, label, maximum) {
  if (!Array.isArray(values) || values.length === 0)
    throw failure('missing-field', `${label} must be a non-empty array`);
  if (values.length > maximum)
    throw failure('batch-bound-exceeded', `${label} exceeds the hard bound`, {
      maximum,
      actual: values.length,
    });
  const roots = values.map((value, index) =>
    requireRoot(value, `${label}[${index}]`),
  );
  const sorted = [...roots].sort(utf8Compare);
  if (new Set(sorted).size !== sorted.length)
    throw failure('duplicate-entry', `${label} contains duplicate roots`);
  return sorted;
}

function git(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf8')
      : String(error.stderr ?? '');
    throw failure(
      options.code ?? 'git-command-failed',
      stderr.trim() || `git ${args[0]} failed`,
      { args },
    );
  }
}

function repositoryRoot(rootInput) {
  return git(path.resolve(rootInput), ['rev-parse', '--show-toplevel']).trim();
}

function trackedBytes(root, commit, relative) {
  try {
    return git(root, ['cat-file', 'blob', `${commit}:${relative}`], {
      encoding: 'buffer',
      code: 'tracked-material-missing',
    });
  } catch (error) {
    if (error.code === 'tracked-material-missing')
      throw failure(
        'tracked-material-missing',
        `required tracked material is missing: ${relative}`,
        { commit, path: relative },
      );
    throw error;
  }
}

function rootParts(root) {
  const value = requireRoot(root, 'root');
  const hex = value.slice(7);
  return { hex, prefix: hex.slice(0, 2) };
}

function episodePaths(root) {
  const { hex, prefix } = rootParts(root);
  const base = `.kungfu/episodes/sealed/sha256/${prefix}/${hex}`;
  return {
    claims: `${base}/claims.jsonl`,
    manifest: `${base}/manifest.json`,
    qualification: `${base}/qualification.json`,
  };
}

function cutPaths(root) {
  const { hex, prefix } = rootParts(root);
  const base = `.kungfu/project-cuts/sha256/${prefix}/${hex}`;
  return {
    manifest: `${base}/manifest.json`,
    receipt: `${base}/receipt.json`,
  };
}

function publicationPaths(rootInput, batchRoot) {
  const root = path.resolve(rootInput);
  const { hex, prefix } = rootParts(batchRoot);
  const trackedRelative = `${TRACKED_ROOT}/${prefix}/${hex}/manifest.json`;
  const runtimeRelative = `${RUNTIME_ROOT}/${prefix}/${hex}`;
  return {
    trackedRelative,
    trackedManifest: path.join(root, trackedRelative),
    runtimeDirectory: path.join(root, runtimeRelative),
    runtimeState: path.join(root, runtimeRelative, 'state.json'),
    runtimeLease: path.join(root, runtimeRelative, 'lease.lock'),
  };
}

function fileEvidence(relative, bytes, kind, root) {
  return {
    path: relative,
    digest: sha256Bytes(bytes),
    bytes: bytes.length,
    kind,
    root,
  };
}

function inspectEpisode(root, commit, episodeRoot) {
  const paths = episodePaths(episodeRoot);
  const manifestBytes = trackedBytes(root, commit, paths.manifest);
  const claims = trackedBytes(root, commit, paths.claims);
  const qualificationBytes = trackedBytes(root, commit, paths.qualification);
  let manifest;
  let qualification;
  try {
    manifest = parseRootJson(manifestBytes);
    qualification = parseRootJson(qualificationBytes);
  } catch (error) {
    throw failure(
      error.code ?? 'episode-material-invalid',
      `Episode ${episodeRoot} is not canonical JSON`,
    );
  }
  const report = verifyGitEpisodeEvidence({
    manifest,
    manifestText: manifestBytes.toString('utf8'),
    claims,
    qualification,
    qualificationText: qualificationBytes.toString('utf8'),
    semanticRootValue: episodeRoot,
  });
  if (!report.ok)
    throw failure(
      'episode-not-publishable',
      `Episode ${episodeRoot} is not verified and sealed`,
      { issues: report.issues },
    );
  return {
    semanticRoot: episodeRoot,
    providerRoot: manifest.providerRoot,
    qualificationRoot: manifest.qualificationRoot,
    files: [
      fileEvidence(paths.claims, claims, 'episode-claims', episodeRoot),
      fileEvidence(
        paths.manifest,
        manifestBytes,
        'episode-manifest',
        episodeRoot,
      ),
      fileEvidence(
        paths.qualification,
        qualificationBytes,
        'episode-qualification',
        episodeRoot,
      ),
    ].sort((left, right) => utf8Compare(left.path, right.path)),
  };
}

function inspectProjectCut(root, commit, cutRoot) {
  const paths = cutPaths(cutRoot);
  const manifestBytes = trackedBytes(root, commit, paths.manifest);
  const receiptBytes = trackedBytes(root, commit, paths.receipt);
  let cut;
  let receipt;
  try {
    cut = parseRootJson(manifestBytes);
    receipt = parseRootJson(receiptBytes);
  } catch (error) {
    throw failure(
      error.code ?? 'project-cut-material-invalid',
      `Project Cut ${cutRoot} is not canonical JSON`,
    );
  }
  const cutReport = verifyProjectCut(cut);
  const receiptReport = verifyProjectCutReceipt(receipt, cut, manifestBytes);
  if (
    cut.cutRoot !== cutRoot ||
    !cutReport.valid ||
    !receiptReport.valid ||
    receipt.verdict !== 'valid'
  )
    throw failure(
      'project-cut-not-publishable',
      `Project Cut ${cutRoot} is not settled and verified`,
      {
        cutDiagnostics: cutReport.diagnostics,
        receiptDiagnostics: receiptReport.diagnostics,
      },
    );
  return {
    cutRoot,
    receiptRoot: receipt.receiptRoot,
    sourceRoot: cut.sourceProjection.root,
    atlasRoot: cut.atlas.root,
    episodeRoots: (cut.episodeDelta?.nativeRoots ?? [])
      .map((entry) => entry?.root)
      .filter((entry) => ROOT.test(String(entry)))
      .sort(utf8Compare),
    files: [
      fileEvidence(
        paths.manifest,
        manifestBytes,
        'project-cut-manifest',
        cutRoot,
      ),
      fileEvidence(paths.receipt, receiptBytes, 'project-cut-receipt', cutRoot),
    ].sort((left, right) => utf8Compare(left.path, right.path)),
  };
}

export function classifySettlementPublicationTrigger(trigger) {
  exactFields(
    trigger,
    [
      'schema',
      'source',
      'eventKind',
      'headBranch',
      'labels',
      'generatedBy',
      'publicationRoot',
    ],
    [
      'schema',
      'source',
      'eventKind',
      'headBranch',
      'labels',
      'generatedBy',
      'publicationRoot',
    ],
    'trigger',
  );
  if (trigger.schema !== PUBLICATION_TRIGGER_SCHEMA)
    throw failure('unknown-version', 'unsupported publication trigger');
  const labels = Array.isArray(trigger.labels)
    ? trigger.labels.map(String).sort(utf8Compare)
    : [];
  const reasons = [];
  if (trigger.generatedBy === GENERATED_BY) reasons.push('generated-by-self');
  if (labels.includes(GENERATED_LABEL)) reasons.push('generated-ledger-label');
  if (String(trigger.headBranch ?? '').startsWith(SOURCE_PREFIX))
    reasons.push('generated-ledger-branch');
  if (trigger.publicationRoot !== null) {
    requireRoot(trigger.publicationRoot, 'trigger.publicationRoot');
    reasons.push('publication-root-present');
  }
  return {
    schema: PUBLICATION_NO_RECURSION_SCHEMA,
    version: 1,
    allowed: reasons.length === 0,
    reasons,
    generatedBy: GENERATED_BY,
    generatedLabel: GENERATED_LABEL,
    sourceBranchPrefix: SOURCE_PREFIX,
  };
}

function validateRequest(request) {
  exactFields(
    request,
    ['schema', 'batch', 'repository', 'episodes', 'projectCuts', 'trigger'],
    ['schema', 'batch', 'repository', 'episodes', 'projectCuts', 'trigger'],
    'request',
  );
  if (request.schema !== PUBLICATION_REQUEST_SCHEMA)
    throw failure('unknown-version', `expected ${PUBLICATION_REQUEST_SCHEMA}`);
  exactFields(request.batch, ['kind', 'id'], ['kind', 'id'], 'request.batch');
  if (!['wave', 'batch'].includes(request.batch.kind))
    throw failure('invalid-value', 'request.batch.kind must be wave or batch');
  const batch = {
    kind: request.batch.kind,
    id: requireSafeId(request.batch.id, 'request.batch.id'),
  };
  exactFields(
    request.repository,
    ['id', 'targetBranch'],
    ['id', 'targetBranch'],
    'request.repository',
  );
  if (!REPOSITORY.test(String(request.repository.id ?? '')))
    throw failure(
      'invalid-value',
      'request.repository.id must be owner/repository',
    );
  const repository = {
    id: String(request.repository.id),
    targetBranch: requireRef(
      request.repository.targetBranch,
      'request.repository.targetBranch',
    ),
  };
  const episodes = sortedUniqueRoots(
    request.episodes,
    'request.episodes',
    MAX_EPISODES,
  );
  const projectCuts = sortedUniqueRoots(
    request.projectCuts,
    'request.projectCuts',
    MAX_PROJECT_CUTS,
  );
  const noRecursion = classifySettlementPublicationTrigger(request.trigger);
  if (!noRecursion.allowed)
    throw failure(
      'recursive-publication',
      'generated ledger activity cannot open a successor publication',
      { reasons: noRecursion.reasons },
    );
  return { batch, repository, episodes, projectCuts, noRecursion };
}

function planIdentity(plan) {
  return {
    schema: PUBLICATION_PLAN_SCHEMA,
    batchRoot: plan.batchRoot,
    manifestRoot: plan.manifestRoot,
    manifestPath: plan.manifestPath,
    repository: plan.repository,
    sourceBranch: plan.sourceBranch,
    pullRequest: plan.pullRequest,
    runtimeContinuationBlocked: false,
  };
}

export function planSettlementPublication(
  rootInput,
  request,
  { commit = 'HEAD' } = {},
) {
  const root = repositoryRoot(rootInput);
  const sourceCommit = git(root, [
    'rev-parse',
    '--verify',
    `${commit}^{commit}`,
  ]).trim();
  const normalized = validateRequest(request);
  const episodes = normalized.episodes.map((episodeRoot) =>
    inspectEpisode(root, sourceCommit, episodeRoot),
  );
  const projectCuts = normalized.projectCuts.map((cutRoot) =>
    inspectProjectCut(root, sourceCommit, cutRoot),
  );
  const selectedEpisodeProviderRoots = new Set(
    episodes.map((episode) => episode.providerRoot),
  );
  const missingEpisodeRoots = projectCuts
    .flatMap((cut) => cut.episodeRoots)
    .filter((episodeRoot) => !selectedEpisodeProviderRoots.has(episodeRoot))
    .sort(utf8Compare);
  if (missingEpisodeRoots.length > 0)
    throw failure(
      'cut-episode-selection-incomplete',
      'every Episode referenced by a selected Project Cut must be published',
      { missingEpisodeRoots: [...new Set(missingEpisodeRoots)] },
    );
  const files = [...episodes, ...projectCuts]
    .flatMap((entry) => entry.files)
    .sort((left, right) => utf8Compare(left.path, right.path));
  const totalBytes = files.reduce((total, entry) => total + entry.bytes, 0);
  if (files.length > MAX_TRACKED_FILES || totalBytes > MAX_TRACKED_BYTES)
    throw failure(
      'batch-bound-exceeded',
      'publication material exceeds the hard batch bound',
      {
        maximumFiles: MAX_TRACKED_FILES,
        actualFiles: files.length,
        maximumBytes: MAX_TRACKED_BYTES,
        actualBytes: totalBytes,
      },
    );
  const batchInput = {
    schema: PUBLICATION_BATCH_INPUT_SCHEMA,
    batch: normalized.batch,
    repository: normalized.repository,
    episodes: episodes.map(
      ({ semanticRoot, providerRoot, qualificationRoot }) => ({
        semanticRoot,
        providerRoot,
        qualificationRoot,
      }),
    ),
    projectCuts: projectCuts.map(
      ({ cutRoot, receiptRoot, sourceRoot, atlasRoot, episodeRoots }) => ({
        cutRoot,
        receiptRoot,
        sourceRoot,
        atlasRoot,
        episodeRoots,
      }),
    ),
  };
  const batchRoot = semanticRoot(batchInput);
  const sourceBranch = `${SOURCE_PREFIX}${batchRoot.slice(7)}`;
  if (sourceBranch === normalized.repository.targetBranch)
    throw failure(
      'protected-target-refused',
      'publication source branch must differ from protected target',
    );
  const marker = `Kungfu-Settlement-Batch: ${batchRoot}`;
  const manifestPreimage = {
    schema: PUBLICATION_MANIFEST_SCHEMA,
    authority: 'projection-of-kungfu-native-settlement',
    generatedBy: GENERATED_BY,
    noRecursion: normalized.noRecursion,
    batchInput,
    batchRoot,
    repository: normalized.repository,
    sourceBranch,
    sourceCommit,
    selection: { episodes, projectCuts },
    files,
    bounds: {
      episodeCount: episodes.length,
      projectCutCount: projectCuts.length,
      trackedFileCount: files.length,
      trackedBytes: totalBytes,
      maximumEpisodes: MAX_EPISODES,
      maximumProjectCuts: MAX_PROJECT_CUTS,
      maximumTrackedFiles: MAX_TRACKED_FILES,
      maximumTrackedBytes: MAX_TRACKED_BYTES,
    },
    runtimeContinuation: {
      authority: 'kungfu-work-control',
      blockedByPublication: false,
      publicationIsAuthority: false,
    },
  };
  const manifestRoot = semanticRoot(manifestPreimage);
  const manifest = { ...manifestPreimage, manifestRoot };
  const paths = publicationPaths(root, batchRoot);
  const pullRequest = {
    marker,
    title: `chore(ledger): publish ${normalized.batch.kind} ${normalized.batch.id}`,
    body: [
      marker,
      `Kungfu-Settlement-Manifest: ${manifestRoot}`,
      `Kungfu-Generated-By: ${GENERATED_BY}`,
      '',
      'This protected projection does not decide Work Control completion or block runtime continuation.',
    ].join('\n'),
    label: GENERATED_LABEL,
    head: sourceBranch,
    base: normalized.repository.targetBranch,
  };
  const provisional = {
    schema: PUBLICATION_PLAN_SCHEMA,
    batchRoot,
    manifestRoot,
    manifestPath: paths.trackedRelative,
    repository: normalized.repository,
    sourceBranch,
    sourceCommit,
    pullRequest,
    manifest,
    runtimeContinuationBlocked: false,
  };
  return { ...provisional, planRoot: semanticRoot(planIdentity(provisional)) };
}

function verifyPlan(plan) {
  if (plan?.schema !== PUBLICATION_PLAN_SCHEMA)
    throw failure('plan-invalid', 'unsupported publication plan');
  requireRoot(plan.batchRoot, 'plan.batchRoot');
  requireRoot(plan.manifestRoot, 'plan.manifestRoot');
  requireRoot(plan.planRoot, 'plan.planRoot');
  if (semanticRoot(planIdentity(plan)) !== plan.planRoot)
    throw failure('plan-root-mismatch', 'publication plan root mismatch');
  const { manifestRoot, ...manifestPreimage } = plan.manifest;
  if (
    manifestRoot !== plan.manifestRoot ||
    semanticRoot(manifestPreimage) !== manifestRoot
  )
    throw failure(
      'manifest-root-mismatch',
      'publication manifest root mismatch',
    );
  if (
    semanticRoot(plan.manifest.batchInput) !== plan.batchRoot ||
    plan.sourceBranch !== `${SOURCE_PREFIX}${plan.batchRoot.slice(7)}` ||
    plan.pullRequest.head !== plan.sourceBranch ||
    plan.pullRequest.base !== plan.repository.targetBranch ||
    plan.pullRequest.marker !== `Kungfu-Settlement-Batch: ${plan.batchRoot}`
  )
    throw failure('batch-root-mismatch', 'publication batch identity drifted');
  if (plan.sourceBranch === plan.repository.targetBranch)
    throw failure(
      'protected-target-refused',
      'publication source branch must differ from protected target',
    );
  return plan;
}

function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, {
    encoding: 'utf8',
    mode,
  });
  fs.renameSync(temporary, file);
}

export function materializeSettlementPublication(
  rootInput,
  planInput,
  { execute = false, stage = false } = {},
) {
  if (stage && !execute)
    throw failure('stage-requires-execute', '--stage requires execute');
  const root = repositoryRoot(rootInput);
  const plan = verifyPlan(planInput);
  const paths = publicationPaths(root, plan.batchRoot);
  const bytes = `${canonicalJson(plan.manifest)}\n`;
  let status = 'planned';
  if (execute) {
    if (fs.existsSync(paths.trackedManifest)) {
      if (fs.readFileSync(paths.trackedManifest, 'utf8') !== bytes)
        throw failure(
          'immutable-collision',
          'content-addressed publication manifest differs',
          { path: paths.trackedRelative },
        );
      status = 'reused';
    } else {
      fs.mkdirSync(path.dirname(paths.trackedManifest), { recursive: true });
      fs.writeFileSync(paths.trackedManifest, bytes, {
        encoding: 'utf8',
        mode: 0o644,
        flag: 'wx',
      });
      status = 'created';
    }
    if (stage)
      git(root, ['add', '--', paths.trackedRelative], {
        code: 'git-stage-failed',
      });
  }
  return {
    schema: 'kungfu.settlement-publication.materialization/v1',
    ok: true,
    executed: execute,
    staged: stage,
    status,
    batchRoot: plan.batchRoot,
    manifestRoot: plan.manifestRoot,
    manifestPath: paths.trackedRelative,
    sourceBranch: plan.sourceBranch,
    targetBranch: plan.repository.targetBranch,
  };
}

function initialState(plan, now) {
  const state = {
    schema: PUBLICATION_STATE_SCHEMA,
    batchRoot: plan.batchRoot,
    manifestRoot: plan.manifestRoot,
    planRoot: plan.planRoot,
    repository: plan.repository,
    sourceBranch: plan.sourceBranch,
    projectCutCount: plan.manifest.selection.projectCuts.length,
    phase: 'planned',
    retryCount: 0,
    firstObservedAt: now,
    lastAttemptAt: null,
    sourceHead: null,
    pullRequest: null,
    latestFailureRoot: null,
    runtimeContinuationBlocked: false,
  };
  return { ...state, stateRoot: semanticRoot(state) };
}

function readState(file, plan) {
  if (!fs.existsSync(file)) return null;
  const state = parseRootJson(fs.readFileSync(file));
  const { stateRoot, ...preimage } = state;
  if (
    state?.schema !== PUBLICATION_STATE_SCHEMA ||
    state.batchRoot !== plan.batchRoot ||
    state.planRoot !== plan.planRoot ||
    semanticRoot(preimage) !== stateRoot
  )
    throw failure(
      'publication-state-invalid',
      'publication state root mismatch',
    );
  return state;
}

function writeState(file, stateInput) {
  const { stateRoot: _previous, ...preimage } = stateInput;
  const state = { ...preimage, stateRoot: semanticRoot(preimage) };
  writeJsonAtomic(file, state);
  return state;
}

function acquireLease(file, batchRoot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(
      file,
      `${canonicalJson({
        schema: 'kungfu.settlement-publication.lease/v1',
        batchRoot,
      })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw failure(
        'publication-busy',
        'another observer is advancing this exact batch',
      );
    throw error;
  }
}

function validatePullRequest(value, plan) {
  if (!isObject(value))
    throw failure(
      'pull-request-invalid',
      'pull request coordinates are missing',
    );
  if (
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    value.head !== plan.sourceBranch ||
    value.base !== plan.repository.targetBranch ||
    !['open', 'merged', 'closed'].includes(value.state)
  )
    throw failure(
      'pull-request-mismatch',
      'pull request coordinates do not match the batch',
    );
  const mergeCommit =
    value.mergeCommit === null ? null : String(value.mergeCommit ?? '');
  if (
    (mergeCommit !== null && !COMMIT.test(mergeCommit)) ||
    (value.state === 'merged' && mergeCommit === null)
  )
    throw failure(
      'pull-request-mismatch',
      'pull request merge commit does not match its state',
    );
  return {
    number: value.number,
    url: String(value.url ?? ''),
    head: value.head,
    base: value.base,
    state: value.state,
    mergeCommit,
  };
}

function failureRoot(plan, attempt, error) {
  return semanticRoot({
    schema: 'kungfu.settlement-publication.failure/v1',
    batchRoot: plan.batchRoot,
    attempt,
    code: String(error.code ?? 'publication-failed'),
    message: String(error.message),
  });
}

export function advanceSettlementPublication(
  rootInput,
  planInput,
  adapter,
  { now = new Date().toISOString(), fault = null } = {},
) {
  const root = repositoryRoot(rootInput);
  const plan = verifyPlan(planInput);
  const paths = publicationPaths(root, plan.batchRoot);
  try {
    acquireLease(paths.runtimeLease, plan.batchRoot);
  } catch (error) {
    return {
      schema: PUBLICATION_STATUS_SCHEMA,
      ok: false,
      code: error.code ?? 'publication-busy',
      batchRoot: plan.batchRoot,
      runtimeContinuationBlocked: false,
    };
  }
  let state = readState(paths.runtimeState, plan) ?? initialState(plan, now);
  const attempt = state.retryCount + 1;
  state = writeState(paths.runtimeState, {
    ...state,
    retryCount: attempt,
    lastAttemptAt: now,
  });
  try {
    if (
      typeof adapter?.findPullRequest !== 'function' ||
      typeof adapter?.publishSource !== 'function' ||
      typeof adapter?.openPullRequest !== 'function'
    )
      throw failure(
        'publication-adapter-invalid',
        'publication adapter is incomplete',
      );
    const existing = adapter.findPullRequest({
      repository: plan.repository.id,
      head: plan.sourceBranch,
      base: plan.repository.targetBranch,
      marker: plan.pullRequest.marker,
    });
    if (existing) {
      const pullRequest = validatePullRequest(existing, plan);
      state = writeState(paths.runtimeState, {
        ...state,
        phase: pullRequest.state === 'merged' ? 'merged' : 'pull-request-open',
        pullRequest,
        latestFailureRoot: null,
      });
      return settlementPublicationStatus(state, { now });
    }
    if (!state.sourceHead) {
      const published = adapter.publishSource({
        repository: plan.repository.id,
        base: plan.repository.targetBranch,
        head: plan.sourceBranch,
        manifestPath: plan.manifestPath,
        manifestRoot: plan.manifestRoot,
        batchRoot: plan.batchRoot,
        directTargetPush: false,
      });
      if (
        !isObject(published) ||
        !/^[0-9a-f]{40,64}$/u.test(String(published.headSha ?? '')) ||
        published.branch !== plan.sourceBranch
      )
        throw failure(
          'source-publication-mismatch',
          'source publication returned mismatched coordinates',
        );
      state = writeState(paths.runtimeState, {
        ...state,
        phase: 'source-published',
        sourceHead: published.headSha,
        latestFailureRoot: null,
      });
    }
    if (fault === 'after-source')
      throw failure(
        'injected-publication-failure',
        'fault injected after source publication',
      );
    const opened = validatePullRequest(
      adapter.openPullRequest({
        repository: plan.repository.id,
        head: plan.sourceBranch,
        base: plan.repository.targetBranch,
        title: plan.pullRequest.title,
        body: plan.pullRequest.body,
        label: plan.pullRequest.label,
        marker: plan.pullRequest.marker,
      }),
      plan,
    );
    state = writeState(paths.runtimeState, {
      ...state,
      phase: opened.state === 'merged' ? 'merged' : 'pull-request-open',
      pullRequest: opened,
      latestFailureRoot: null,
    });
    return settlementPublicationStatus(state, { now });
  } catch (error) {
    state = writeState(paths.runtimeState, {
      ...state,
      latestFailureRoot: failureRoot(plan, attempt, error),
    });
    return {
      ...settlementPublicationStatus(state, { now }),
      ok: false,
      code: error.code ?? 'publication-failed',
      error: String(error.message),
    };
  } finally {
    fs.rmSync(paths.runtimeLease, { force: true });
  }
}

export function reconcileSettlementPublication(
  rootInput,
  planInput,
  observation,
  { now = new Date().toISOString() } = {},
) {
  const root = repositoryRoot(rootInput);
  const plan = verifyPlan(planInput);
  exactFields(
    observation,
    [
      'schema',
      'batchRoot',
      'number',
      'url',
      'head',
      'base',
      'state',
      'mergeCommit',
    ],
    [
      'schema',
      'batchRoot',
      'number',
      'url',
      'head',
      'base',
      'state',
      'mergeCommit',
    ],
    'observation',
  );
  if (
    observation.schema !== PUBLICATION_OBSERVATION_SCHEMA ||
    observation.batchRoot !== plan.batchRoot
  )
    throw failure(
      'publication-observation-mismatch',
      'observation does not bind this batch',
    );
  const paths = publicationPaths(root, plan.batchRoot);
  acquireLease(paths.runtimeLease, plan.batchRoot);
  try {
    const state =
      readState(paths.runtimeState, plan) ?? initialState(plan, now);
    const pullRequest = validatePullRequest(observation, plan);
    const updated = writeState(paths.runtimeState, {
      ...state,
      phase: pullRequest.state === 'merged' ? 'merged' : 'pull-request-open',
      pullRequest,
      latestFailureRoot: null,
      lastAttemptAt: now,
    });
    return settlementPublicationStatus(updated, { now });
  } finally {
    fs.rmSync(paths.runtimeLease, { force: true });
  }
}

export function inspectSettlementPublication(
  rootInput,
  planInput,
  { now = new Date().toISOString() } = {},
) {
  const root = repositoryRoot(rootInput);
  const plan = verifyPlan(planInput);
  const paths = publicationPaths(root, plan.batchRoot);
  const state = readState(paths.runtimeState, plan) ?? initialState(plan, now);
  return settlementPublicationStatus(state, { now });
}

export function settlementPublicationStatus(
  state,
  { now = new Date().toISOString() } = {},
) {
  const first = Date.parse(state.firstObservedAt);
  const observed = Date.parse(now);
  const merged = state.phase === 'merged';
  const cutCount =
    state?.pullRequest?.state === 'merged'
      ? 0
      : Number(state.projectCutCount ?? 0);
  return {
    schema: PUBLICATION_STATUS_SCHEMA,
    ok: state.latestFailureRoot === null,
    phase: state.phase,
    batchRoot: state.batchRoot,
    manifestRoot: state.manifestRoot,
    branch: state.sourceBranch,
    targetBranch: state.repository.targetBranch,
    pullRequest: state.pullRequest,
    retryCount: state.retryCount,
    publicationLagSeconds:
      Number.isFinite(first) && Number.isFinite(observed)
        ? Math.max(0, Math.floor((observed - first) / 1000))
        : null,
    unpublishedCutCount: merged ? 0 : cutCount,
    latestFailureRoot: state.latestFailureRoot,
    runtimeContinuationBlocked: false,
    completionAuthority: 'kungfu-work-control',
  };
}

function verifyPublicationManifest(root, commit, manifest) {
  const diagnostics = [];
  if (manifest?.schema !== PUBLICATION_MANIFEST_SCHEMA)
    diagnostics.push({ code: 'manifest-schema-unknown' });
  const { manifestRoot, ...preimage } = manifest ?? {};
  if (
    !ROOT.test(String(manifestRoot ?? '')) ||
    semanticRoot(preimage) !== manifestRoot
  )
    diagnostics.push({ code: 'manifest-root-mismatch' });
  if (
    !isObject(manifest?.batchInput) ||
    semanticRoot(manifest.batchInput) !== manifest.batchRoot
  )
    diagnostics.push({ code: 'batch-root-mismatch' });
  if (
    manifest?.generatedBy !== GENERATED_BY ||
    manifest?.sourceBranch !==
      `${SOURCE_PREFIX}${String(manifest?.batchRoot ?? '').slice(7)}` ||
    manifest?.runtimeContinuation?.blockedByPublication !== false ||
    manifest?.runtimeContinuation?.publicationIsAuthority !== false
  )
    diagnostics.push({ code: 'authority-boundary-mismatch' });
  const inspectedEpisodes = [];
  const inspectedProjectCuts = [];
  for (const episode of manifest?.selection?.episodes ?? []) {
    try {
      inspectedEpisodes.push(
        inspectEpisode(root, commit, episode.semanticRoot),
      );
    } catch (error) {
      diagnostics.push({
        code: error.code ?? 'episode-not-publishable',
        root: episode.semanticRoot,
      });
    }
  }
  for (const cut of manifest?.selection?.projectCuts ?? []) {
    try {
      inspectedProjectCuts.push(inspectProjectCut(root, commit, cut.cutRoot));
    } catch (error) {
      diagnostics.push({
        code: error.code ?? 'project-cut-not-publishable',
        root: cut.cutRoot,
      });
    }
  }
  const expectedEpisodes = inspectedEpisodes.map(
    ({ semanticRoot, providerRoot, qualificationRoot }) => ({
      semanticRoot,
      providerRoot,
      qualificationRoot,
    }),
  );
  const expectedProjectCuts = inspectedProjectCuts.map(
    ({ cutRoot, receiptRoot, sourceRoot, atlasRoot, episodeRoots }) => ({
      cutRoot,
      receiptRoot,
      sourceRoot,
      atlasRoot,
      episodeRoots,
    }),
  );
  const expectedFiles = [...inspectedEpisodes, ...inspectedProjectCuts]
    .flatMap((entry) => entry.files)
    .sort((left, right) => utf8Compare(left.path, right.path));
  const expectedBytes = expectedFiles.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  if (
    canonicalJson(manifest?.batchInput?.episodes ?? null) !==
      canonicalJson(expectedEpisodes) ||
    canonicalJson(manifest?.batchInput?.projectCuts ?? null) !==
      canonicalJson(expectedProjectCuts) ||
    canonicalJson(manifest?.batchInput?.repository ?? null) !==
      canonicalJson(manifest?.repository ?? null) ||
    canonicalJson(manifest?.selection?.episodes ?? null) !==
      canonicalJson(inspectedEpisodes) ||
    canonicalJson(manifest?.selection?.projectCuts ?? null) !==
      canonicalJson(inspectedProjectCuts) ||
    canonicalJson(manifest?.files ?? null) !== canonicalJson(expectedFiles)
  )
    diagnostics.push({ code: 'manifest-selection-mismatch' });
  const expectedBounds = {
    episodeCount: inspectedEpisodes.length,
    projectCutCount: inspectedProjectCuts.length,
    trackedFileCount: expectedFiles.length,
    trackedBytes: expectedBytes,
    maximumEpisodes: MAX_EPISODES,
    maximumProjectCuts: MAX_PROJECT_CUTS,
    maximumTrackedFiles: MAX_TRACKED_FILES,
    maximumTrackedBytes: MAX_TRACKED_BYTES,
  };
  if (
    canonicalJson(manifest?.bounds ?? null) !== canonicalJson(expectedBounds) ||
    expectedFiles.length > MAX_TRACKED_FILES ||
    expectedBytes > MAX_TRACKED_BYTES
  )
    diagnostics.push({ code: 'manifest-bounds-mismatch' });
  for (const entry of manifest?.files ?? []) {
    try {
      const bytes = trackedBytes(root, commit, entry.path);
      if (bytes.length !== entry.bytes || sha256Bytes(bytes) !== entry.digest)
        diagnostics.push({
          code: 'tracked-material-mismatch',
          path: entry.path,
        });
    } catch (error) {
      diagnostics.push({
        code: error.code ?? 'tracked-material-missing',
        path: entry.path,
      });
    }
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    batchRoot: manifest?.batchRoot ?? null,
    manifestRoot: manifestRoot ?? null,
  };
}

export function verifySettlementPublication(
  rootInput,
  batchRoot,
  { commit = 'HEAD' } = {},
) {
  const root = repositoryRoot(rootInput);
  const resolved = git(root, [
    'rev-parse',
    '--verify',
    `${commit}^{commit}`,
  ]).trim();
  const paths = publicationPaths(root, batchRoot);
  let manifest;
  try {
    manifest = parseRootJson(
      trackedBytes(root, resolved, paths.trackedRelative),
    );
  } catch (error) {
    return {
      schema: 'kungfu.settlement-publication.verification/v1',
      ok: false,
      batchRoot,
      commit: resolved,
      diagnostics: [{ code: error.code ?? 'publication-manifest-missing' }],
    };
  }
  const report = verifyPublicationManifest(root, resolved, manifest);
  return {
    schema: 'kungfu.settlement-publication.verification/v1',
    ...report,
    commit: resolved,
    manifestPath: paths.trackedRelative,
    runtimeRequired: false,
    authority: 'qualified-git-shadow',
  };
}

export const SETTLEMENT_PUBLICATION_BOUNDS = Object.freeze({
  maximumEpisodes: MAX_EPISODES,
  maximumProjectCuts: MAX_PROJECT_CUTS,
  maximumTrackedFiles: MAX_TRACKED_FILES,
  maximumTrackedBytes: MAX_TRACKED_BYTES,
});
