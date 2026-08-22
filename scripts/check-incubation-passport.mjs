#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { githubMergeGroupCoordinates } from './source-acceptance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONTRACT_PATH = 'framework/incubation/incubation-passport.contract.json';
const CONTRACT_SCHEMA_PATH =
  'framework/incubation/schema/incubation-passport-contract-v1.schema.json';
const SHA256_ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}$/u;
const ADMISSION_FIXTURE_SCHEMA =
  'kungfu.incubation-passport.admission-fixture/v1';
const ADMISSION_RECEIPT_SCHEMA =
  'kungfu.incubation-passport.admission-receipt/v1';
const NATIVE_ADMISSION_SCHEMA =
  'kungfu.initiative-assignment.native-admission/v1';
const NATIVE_EVENT_SCHEMA =
  'kungfu.initiative-assignment.native-admission-event/v1';
const NATIVE_REPLAY_EVIDENCE_SCHEMA =
  'kungfu.initiative-assignment.native-replay-evidence/v1';
const NATIVE_SERVICE_CONTRACT_SCHEMA =
  'kungfu.initiative-assignment.native-service-contract/v1';
const HISTORY_EVIDENCE_SCHEMA =
  'kungfu.incubation-passport.historical-no-rewrite-evidence/v1';
const PLATFORM_EVIDENCE_SCHEMA =
  'kungfu.incubation-passport.platform-evidence/v1';
const REPLAY_PROOF_SCHEMA = 'kungfu.incubation-passport.native-replay-proof/v1';
const REPLAY_CAPTURE_PROVENANCE_SCHEMA =
  'kungfu.incubation-passport.native-replay-capture-provenance/v1';

function loadJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function utcDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date || '')) return null;
  const value = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(value)) return null;
  if (new Date(value).toISOString().slice(0, 10) !== date) return null;
  return Math.floor(value / 86_400_000);
}

function issue(key, detail) {
  return { key, detail };
}

function pathExists(root, relativePath) {
  return (
    typeof relativePath === 'string' &&
    fs.existsSync(path.join(root, relativePath))
  );
}

function checkoutFile(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath)
  )
    return null;
  const checkoutRoot = fs.realpathSync(root);
  const candidate = path.resolve(checkoutRoot, relativePath);
  if (!candidate.startsWith(`${checkoutRoot}${path.sep}`)) return null;
  if (
    fs.existsSync(candidate) &&
    !fs.realpathSync(candidate).startsWith(`${checkoutRoot}${path.sep}`)
  )
    return null;
  return candidate;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new Error(
        'canonical admission evidence only permits safe integers',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function protocolRoot(protocol, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(protocol)
    .update(Buffer.from([0]))
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function nativeServiceContractRoot() {
  const contract = {
    schema: NATIVE_SERVICE_CONTRACT_SCHEMA,
    abi: { interfaceId: 6, version: 1 },
    operations: ['contract', 'compute-root', 'admit', 'replay'],
    journal: {
      namespace: 'initiative-assignment',
      name: 'admission',
      owner: 'libkungfu/action-recorder',
    },
    admission: {
      recordIsReceipt: false,
      receiptRequiresRestartReplay: true,
    },
    receipt: {
      schema: ADMISSION_RECEIPT_SCHEMA,
      requiredBindings: [
        'assignment',
        'source-head',
        'source-tree',
        'root-protocol-contract',
        'service-contract',
        'vectors',
        'python-implementation',
        'native-implementation',
        'platform-evidence',
        'journal-replay',
        'historical-no-rewrite',
      ],
    },
    authorityBoundary:
      'Python remains the L3 rules/projection writer; this service owns only L5 native Root admission.',
  };
  return protocolRoot(NATIVE_SERVICE_CONTRACT_SCHEMA, contract);
}

function nativeReplayEvidenceRoot(evidence) {
  const journal = evidence?.journal;
  const genTime = journal?.genTimeDecimal;
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(genTime || '')) return null;
  try {
    const value = BigInt(genTime);
    if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) return null;
  } catch {
    return null;
  }
  const preimage =
    `{\"assignmentId\":${canonicalJson(evidence.assignmentId)}` +
    `,\"bindingRoot\":${canonicalJson(evidence.bindingRoot)}` +
    `,\"computedRoot\":${canonicalJson(evidence.computedRoot)}` +
    `,\"eventRoot\":${canonicalJson(evidence.eventRoot)}` +
    `,\"journal\":{\"dest\":${canonicalJson(journal.dest)}` +
    `,\"frameUid\":${canonicalJson(journal.frameUid)}` +
    `,\"genTime\":${genTime}` +
    `,\"name\":${canonicalJson(journal.name)}` +
    `,\"namespace\":${canonicalJson(journal.namespace)}` +
    `,\"source\":${canonicalJson(journal.source)}}` +
    `,\"matchedEventCount\":${canonicalJson(evidence.matchedEventCount)}` +
    `,\"schema\":${canonicalJson(evidence.schema)}}`;
  return `sha256:${crypto
    .createHash('sha256')
    .update(NATIVE_REPLAY_EVIDENCE_SCHEMA)
    .update(Buffer.from([0]))
    .update(preimage)
    .digest('hex')}`;
}

function nativeGenTimeIso(genTime) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(genTime || '')) return null;
  try {
    const value = BigInt(genTime);
    if (value > 2n ** 63n - 1n) return null;
    const seconds = value / 1_000_000_000n;
    const nanoseconds = value % 1_000_000_000n;
    const date = new Date(Number(seconds) * 1000);
    if (Number.isNaN(date.valueOf())) return null;
    return `${date.toISOString().slice(0, -5)}.${nanoseconds
      .toString()
      .padStart(9, '0')}Z`;
  } catch {
    return null;
  }
}

function bytesRoot(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function rootedDocumentRoot(value, field = 'root') {
  const body = { ...value };
  delete body[field];
  return protocolRoot(value.schema, body);
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

// Admission receipts intentionally outlive short delivery bursts. Keep the
// shallow merge-group checkout bounded, but retain enough protected history
// for a receipt to survive more than 64 first-parent deliveries.
const MERGE_GROUP_PROTECTED_HISTORY_DEPTH = 128;

export function protectedSourceRetained({
  root = ROOT,
  sourceSha,
  headSha = 'HEAD',
  env = process.env,
  readFile = fs.readFileSync,
  gitIsAncestor = (ancestor, descendant) =>
    git(root, ['merge-base', '--is-ancestor', ancestor, descendant]).status ===
    0,
  gitRead = (args) => {
    const result = git(root, args);
    return result.status === 0 ? result.stdout.trim() : '';
  },
  hydrateMergeGroupBase = (baseSha) =>
    git(root, [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--filter=blob:none',
      `--depth=${MERGE_GROUP_PROTECTED_HISTORY_DEPTH}`,
      'origin',
      baseSha,
    ]).status === 0,
} = {}) {
  if (!GIT_OBJECT_PATTERN.test(sourceSha || '')) return false;
  if (gitIsAncestor(sourceSha, headSha)) return true;

  // The reusable source job intentionally uses a depth-one checkout. Git then
  // reports false for ancestry that the protected merge-group base actually
  // retains. Only an authenticated event for this exact checkout may recover
  // that proof, and the bounded fetch remains fail closed if the source falls
  // outside the retained protected history.
  const mergeGroup = githubMergeGroupCoordinates(env, readFile);
  if (!mergeGroup || gitRead(['rev-parse', headSha]) !== mergeGroup.headSha)
    return false;
  if (!hydrateMergeGroupBase(mergeGroup.baseSha)) return false;
  return gitIsAncestor(sourceSha, mergeGroup.baseSha);
}

export function validateAdmissionFixture({ root = ROOT, passport, fixture }) {
  const errors = [];
  const invalid = (message) => errors.push(message);
  const requireExact = (value, fields, label) => {
    if (!exactKeys(value, fields)) invalid(`${label} has an invalid field set`);
  };
  const requireRoot = (value, label) => {
    if (!SHA256_ROOT_PATTERN.test(value || ''))
      invalid(`${label} is not a canonical sha256 Root`);
  };
  const requireFileRoot = (material, label) => {
    const file = checkoutFile(root, material?.path);
    if (!file || !fs.existsSync(file)) {
      invalid(`${label} path is missing or escapes the checkout`);
      return;
    }
    const actual = bytesRoot(fs.readFileSync(file));
    if (material.root !== actual) invalid(`${label} byte Root drifted`);
  };

  requireExact(
    fixture,
    ['schema', 'passportId', 'protectedSource', 'materials', 'receipt'],
    'admission fixture',
  );
  if (fixture?.schema !== ADMISSION_FIXTURE_SCHEMA)
    invalid('admission fixture schema is invalid');
  if (fixture?.passportId !== passport.id)
    invalid('admission fixture passport id does not match');

  const protectedSource = fixture?.protectedSource;
  requireExact(
    protectedSource,
    ['repository', 'branch', 'head', 'tree', 'pullRequest', 'mergedAt'],
    'protected source',
  );
  if (!GIT_OBJECT_PATTERN.test(protectedSource?.head || ''))
    invalid('protected source head is not an exact Git object id');
  if (!GIT_OBJECT_PATTERN.test(protectedSource?.tree || ''))
    invalid('protected source tree is not an exact Git object id');
  if (
    !Number.isSafeInteger(protectedSource?.pullRequest) ||
    protectedSource.pullRequest <= 0
  )
    invalid('protected source pull request is invalid');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(
      protectedSource?.mergedAt || '',
    )
  )
    invalid('protected source merge time is invalid');

  if (GIT_OBJECT_PATTERN.test(protectedSource?.head || '')) {
    const tree = git(root, [
      'rev-parse',
      '--verify',
      `${protectedSource.head}^{tree}`,
    ]);
    if (tree.status !== 0) invalid('protected source head is unavailable');
    else if (tree.stdout.trim() !== protectedSource.tree)
      invalid('protected source tree does not match its head');
    if (!protectedSourceRetained({ root, sourceSha: protectedSource.head }))
      invalid('protected source head is not retained by the candidate');
  }

  const materials = fixture?.materials;
  requireExact(
    materials,
    [
      'contract',
      'vectors',
      'implementations',
      'serviceContractRoot',
      'history',
      'platform',
      'replay',
    ],
    'admission materials',
  );
  requireExact(materials?.contract, ['path', 'root'], 'contract material');
  requireExact(
    materials?.vectors,
    ['path', 'root', 'acceptedId'],
    'vector material',
  );
  requireFileRoot(materials?.contract, 'contract material');
  requireFileRoot(materials?.vectors, 'vector material');
  requireRoot(materials?.serviceContractRoot, 'service contract Root');
  if (materials?.serviceContractRoot !== nativeServiceContractRoot())
    invalid('native service contract Root is invalid');

  const implementations = materials?.implementations;
  if (!Array.isArray(implementations) || implementations.length !== 2) {
    invalid('admission fixture requires exactly two implementation materials');
  } else {
    for (const entry of implementations) {
      requireExact(
        entry,
        ['language', 'path', 'root'],
        'implementation material',
      );
      requireFileRoot(entry, `${entry.language || 'unknown'} implementation`);
    }
    const fixtureBindings = implementations
      .map((entry) => `${entry.language}\0${entry.path}`)
      .sort();
    const passportBindings = (passport.identityProtocol?.implementations || [])
      .map((entry) => `${entry.language}\0${entry.path}`)
      .sort();
    if (fixtureBindings.join('\n') !== passportBindings.join('\n'))
      invalid('implementation materials do not match the passport');
  }
  if (
    materials?.vectors?.path !== passport.identityProtocol?.vectors?.[0] ||
    passport.identityProtocol?.vectors?.length !== 1
  )
    invalid('vector material does not match the passport');

  const history = materials?.history;
  requireExact(history, ['schema', 'fixture', 'root'], 'history material');
  if (history?.schema !== HISTORY_EVIDENCE_SCHEMA)
    invalid('history evidence schema is invalid');
  requireExact(
    history?.fixture,
    ['path', 'bytesRoot', 'semanticRoot'],
    'history fixture',
  );
  requireRoot(history?.fixture?.bytesRoot, 'history byte Root');
  requireRoot(history?.fixture?.semanticRoot, 'history semantic Root');
  const historyFile = checkoutFile(root, history?.fixture?.path);
  if (!historyFile || !fs.existsSync(historyFile)) {
    invalid('history fixture path is missing or escapes the checkout');
  } else {
    const historyBytes = fs.readFileSync(historyFile);
    if (bytesRoot(historyBytes) !== history.fixture.bytesRoot)
      invalid('history fixture bytes were rewritten');
    try {
      const retained = JSON.parse(historyBytes.toString('utf8'));
      if (retained.stateRoot !== history.fixture.semanticRoot)
        invalid('history fixture semantic Root drifted');
    } catch {
      invalid('history fixture is not valid JSON');
    }
  }
  if (history?.root !== rootedDocumentRoot(history || {}))
    invalid('history no-rewrite Root is invalid');

  const platform = materials?.platform;
  requireExact(
    platform,
    ['schema', 'repository', 'source', 'mergeGroup', 'delivery', 'root'],
    'platform evidence',
  );
  if (platform?.schema !== PLATFORM_EVIDENCE_SCHEMA)
    invalid('platform evidence schema is invalid');
  requireExact(platform?.source, ['head', 'tree'], 'platform source');
  requireExact(
    platform?.mergeGroup,
    ['workflowRun', 'shardJobs', 'aggregateJob', 'conclusion'],
    'merge-group evidence',
  );
  requireExact(
    platform?.delivery,
    [
      'pullRequest',
      'mergedAt',
      'integrationProofRoot',
      'closeReceiptRoot',
      'finalStateRoot',
    ],
    'delivery evidence',
  );
  for (const field of [
    'integrationProofRoot',
    'closeReceiptRoot',
    'finalStateRoot',
  ])
    requireRoot(platform?.delivery?.[field], `delivery ${field}`);
  if (platform?.mergeGroup?.conclusion !== 'success')
    invalid('merge-group evidence is not successful');
  if (
    !Number.isSafeInteger(platform?.mergeGroup?.workflowRun) ||
    !Array.isArray(platform?.mergeGroup?.shardJobs) ||
    platform.mergeGroup.shardJobs.length !== 2 ||
    platform.mergeGroup.shardJobs.some(
      (job) => !Number.isSafeInteger(job) || job <= 0,
    ) ||
    !Number.isSafeInteger(platform?.mergeGroup?.aggregateJob) ||
    platform.mergeGroup.aggregateJob <= 0
  )
    invalid('merge-group coordinates are invalid');
  if (
    platform?.repository !== protectedSource?.repository ||
    canonicalJson(platform?.source) !==
      canonicalJson({
        head: protectedSource?.head,
        tree: protectedSource?.tree,
      }) ||
    platform?.delivery?.pullRequest !== protectedSource?.pullRequest ||
    platform?.delivery?.mergedAt !== protectedSource?.mergedAt
  )
    invalid('platform evidence is detached from the protected source');
  if (platform?.root !== rootedDocumentRoot(platform || {}))
    invalid('platform evidence Root is invalid');

  const replay = materials?.replay;
  requireExact(
    replay,
    ['schema', 'provenance', 'recorded', 'evidence', 'assertions', 'root'],
    'replay evidence',
  );
  if (replay?.schema !== REPLAY_PROOF_SCHEMA)
    invalid('replay proof schema is invalid');
  const replayProvenance = replay?.provenance;
  requireExact(
    replayProvenance,
    [
      'schema',
      'captureKind',
      'captureMethod',
      'journalGeneratedAt',
      'environment',
      'source',
      'ciExecution',
    ],
    'native replay capture provenance',
  );
  requireExact(
    replayProvenance?.environment,
    ['operatingSystem', 'architecture'],
    'native replay capture environment',
  );
  requireExact(
    replayProvenance?.source,
    ['head', 'tree'],
    'native replay capture source',
  );
  if (
    replayProvenance?.schema !== REPLAY_CAPTURE_PROVENANCE_SCHEMA ||
    replayProvenance?.captureKind !== 'local-exact-source' ||
    replayProvenance?.captureMethod !== 'public-c-abi-one-shot-harness' ||
    replayProvenance?.environment?.operatingSystem !== 'darwin' ||
    replayProvenance?.environment?.architecture !== 'arm64'
  )
    invalid('native replay capture provenance is invalid');
  if (replayProvenance?.ciExecution !== null)
    invalid('local replay capture cannot claim CI execution coordinates');
  if (
    canonicalJson(replayProvenance?.source) !==
    canonicalJson({
      head: protectedSource?.head,
      tree: protectedSource?.tree,
    })
  )
    invalid('native replay capture is detached from the protected source');
  const recorded = replay?.recorded;
  requireExact(
    recorded,
    [
      'assignmentId',
      'bindingRoot',
      'computedRoot',
      'eventRoot',
      'journal',
      'receiptIssued',
      'schema',
      'status',
    ],
    'native admission record',
  );
  requireExact(
    recorded?.journal,
    ['frameUid', 'name', 'namespace'],
    'native admission journal record',
  );
  for (const [label, value] of [
    ['recorded binding Root', recorded?.bindingRoot],
    ['recorded computed Root', recorded?.computedRoot],
    ['recorded event Root', recorded?.eventRoot],
  ])
    requireRoot(value, label);
  if (
    recorded?.schema !==
      'kungfu.initiative-assignment.native-admission-record/v1' ||
    recorded?.status !== 'recorded-awaiting-restart-replay' ||
    recorded?.receiptIssued !== false
  )
    invalid('native admission record claimed a receipt before replay');

  const replayEvidence = replay?.evidence;
  requireExact(
    replayEvidence,
    [
      'assignmentId',
      'bindingRoot',
      'computedRoot',
      'eventRoot',
      'journal',
      'matchedEventCount',
      'replayEvidenceRoot',
      'schema',
    ],
    'native replay evidence',
  );
  requireExact(
    replayEvidence?.journal,
    ['dest', 'frameUid', 'genTimeDecimal', 'name', 'namespace', 'source'],
    'native replay journal evidence',
  );
  for (const [label, value] of [
    ['replay binding Root', replayEvidence?.bindingRoot],
    ['replay computed Root', replayEvidence?.computedRoot],
    ['replay event Root', replayEvidence?.eventRoot],
    ['native replay evidence Root', replayEvidence?.replayEvidenceRoot],
  ])
    requireRoot(value, label);
  if (
    replayEvidence?.schema !== NATIVE_REPLAY_EVIDENCE_SCHEMA ||
    replayEvidence?.matchedEventCount !== 1 ||
    replayEvidence?.replayEvidenceRoot !==
      nativeReplayEvidenceRoot(replayEvidence)
  )
    invalid('native replay evidence Root is invalid');
  if (
    replayProvenance?.journalGeneratedAt !==
    nativeGenTimeIso(replayEvidence?.journal?.genTimeDecimal)
  )
    invalid('native replay provenance time does not match journal genTime');
  if (
    recorded?.journal?.frameUid !== replayEvidence?.journal?.frameUid ||
    recorded?.journal?.name !== replayEvidence?.journal?.name ||
    recorded?.journal?.namespace !== replayEvidence?.journal?.namespace
  )
    invalid('native replay evidence is detached from the recorded frame');
  if (!Array.isArray(replay?.assertions) || replay.assertions.length < 3)
    invalid('replay evidence assertions are incomplete');
  if (replay?.root !== rootedDocumentRoot(replay || {}))
    invalid('replay evidence Root is invalid');

  const receipt = fixture?.receipt;
  requireExact(
    receipt,
    [
      'assignmentId',
      'historicalNoRewriteRoot',
      'implementations',
      'journal',
      'platformEvidenceRoot',
      'rootProtocol',
      'schema',
      'serviceContractRoot',
      'source',
      'receiptRoot',
    ],
    'admission receipt',
  );
  requireExact(
    receipt?.implementations,
    ['languages', 'nativeRoot', 'pythonRoot'],
    'receipt implementations',
  );
  requireExact(
    receipt?.journal,
    ['bindingRoot', 'eventRoot', 'replayEvidenceRoot'],
    'receipt journal',
  );
  requireExact(
    receipt?.rootProtocol,
    ['contractRoot', 'root', 'vectorRoot'],
    'receipt Root protocol',
  );
  requireExact(receipt?.source, ['head', 'tree'], 'receipt source');
  if (receipt?.schema !== ADMISSION_RECEIPT_SCHEMA)
    invalid('admission receipt schema is invalid');
  for (const [label, value] of [
    ['receipt Root', receipt?.receiptRoot],
    ['receipt historical Root', receipt?.historicalNoRewriteRoot],
    [
      'receipt native implementation Root',
      receipt?.implementations?.nativeRoot,
    ],
    [
      'receipt Python implementation Root',
      receipt?.implementations?.pythonRoot,
    ],
    ['receipt binding Root', receipt?.journal?.bindingRoot],
    ['receipt event Root', receipt?.journal?.eventRoot],
    ['receipt replay Root', receipt?.journal?.replayEvidenceRoot],
    ['receipt platform Root', receipt?.platformEvidenceRoot],
    ['receipt contract Root', receipt?.rootProtocol?.contractRoot],
    ['receipt identity Root', receipt?.rootProtocol?.root],
    ['receipt vector Root', receipt?.rootProtocol?.vectorRoot],
    ['receipt service contract Root', receipt?.serviceContractRoot],
  ])
    requireRoot(value, label);

  if (receipt?.assignmentId !== passport.destinedAuthority?.admissionAssignment)
    invalid('receipt Assignment does not match the passport authority');
  if (
    canonicalJson(receipt?.source) !==
    canonicalJson({ head: protectedSource?.head, tree: protectedSource?.tree })
  )
    invalid('receipt source is detached from the protected source');
  const byLanguage = new Map(
    (implementations || []).map((entry) => [entry.language, entry.root]),
  );
  if (
    canonicalJson(receipt?.implementations?.languages) !==
      canonicalJson(['c++', 'python']) ||
    receipt?.implementations?.nativeRoot !== byLanguage.get('c++') ||
    receipt?.implementations?.pythonRoot !== byLanguage.get('python')
  )
    invalid('receipt implementation bindings are invalid');
  if (
    receipt?.historicalNoRewriteRoot !== history?.root ||
    receipt?.platformEvidenceRoot !== platform?.root ||
    receipt?.journal?.replayEvidenceRoot !==
      replayEvidence?.replayEvidenceRoot ||
    receipt?.rootProtocol?.contractRoot !== materials?.contract?.root ||
    receipt?.rootProtocol?.vectorRoot !== materials?.vectors?.root ||
    receipt?.serviceContractRoot !== materials?.serviceContractRoot
  )
    invalid('receipt material Roots do not match the admission fixture');

  const vectorFile = checkoutFile(root, materials?.vectors?.path);
  if (vectorFile && fs.existsSync(vectorFile)) {
    try {
      const vectors = JSON.parse(fs.readFileSync(vectorFile, 'utf8'));
      const vector = (vectors.accepted || []).find(
        (entry) => entry.id === materials.vectors.acceptedId,
      );
      if (!vector) invalid('admission vector id is absent');
      else {
        if (receipt?.rootProtocol?.root !== vector.expected?.root)
          invalid('receipt identity Root does not match its vector');
        const admission = {
          schema: NATIVE_ADMISSION_SCHEMA,
          assignmentId: receipt?.assignmentId,
          rootInput: vector.input,
          expectedRoot: vector.expected?.root,
          serviceContractRoot: receipt?.serviceContractRoot,
          source: receipt?.source,
          evidence: {
            rootProtocolContractRoot: materials?.contract?.root,
            vectorRoot: materials?.vectors?.root,
            pythonImplementationRoot: byLanguage.get('python'),
            nativeImplementationRoot: byLanguage.get('c++'),
            platformEvidenceRoot: platform?.root,
            historicalNoRewriteRoot: history?.root,
          },
        };
        const bindingRoot = protocolRoot(NATIVE_ADMISSION_SCHEMA, admission);
        const event = {
          admission,
          assignmentId: receipt?.assignmentId,
          bindingRoot,
          computedRoot: vector.expected?.root,
          schema: NATIVE_EVENT_SCHEMA,
        };
        if (
          receipt?.journal?.bindingRoot !== bindingRoot ||
          receipt?.journal?.eventRoot !==
            protocolRoot(NATIVE_EVENT_SCHEMA, event) ||
          recorded?.assignmentId !== receipt?.assignmentId ||
          recorded?.bindingRoot !== bindingRoot ||
          recorded?.computedRoot !== vector.expected?.root ||
          recorded?.eventRoot !== protocolRoot(NATIVE_EVENT_SCHEMA, event) ||
          replayEvidence?.assignmentId !== receipt?.assignmentId ||
          replayEvidence?.bindingRoot !== bindingRoot ||
          replayEvidence?.computedRoot !== vector.expected?.root ||
          replayEvidence?.eventRoot !== protocolRoot(NATIVE_EVENT_SCHEMA, event)
        )
          invalid('native admission or event binding Root is invalid');
      }
    } catch {
      invalid('admission vector corpus is invalid JSON');
    }
  }

  if (receipt?.receiptRoot !== rootedDocumentRoot(receipt || {}, 'receiptRoot'))
    invalid('admission receipt Root is invalid');
  return errors;
}

function registeredSchemaPaths(authority) {
  const paths = new Set();
  for (const entry of authority.authorities || []) {
    if (entry.owner !== 'flatbuffers') continue;
    if (entry.declaration) paths.add(entry.declaration);
    if (entry.derived_schema) paths.add(entry.derived_schema);
  }
  return paths;
}

function authorityIdentities(authority) {
  return new Map(
    (authority.authorities || []).map((entry) => [entry.identity, entry.owner]),
  );
}

export function trackedSchemas(root = ROOT) {
  const result = spawnSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.fbs', '*.bfbs'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return result.stdout
    .split('\0')
    .filter(
      (schemaPath) => schemaPath && fs.existsSync(path.join(root, schemaPath)),
    )
    .sort();
}

export function collectIssues({
  root = ROOT,
  registry,
  authority,
  schemas,
  today = utcDate(),
}) {
  const issues = [];
  const registered = registeredSchemaPaths(authority);
  const identities = authorityIdentities(authority);

  for (const schemaPath of [...schemas].sort()) {
    if (!registered.has(schemaPath)) {
      issues.push(
        issue(
          `unregistered-schema:${schemaPath}`,
          `${schemaPath} has no FlatBuffers schema-authority entry`,
        ),
      );
    }
  }

  const passportIds = new Set();
  for (const passport of registry.passports || []) {
    if (passportIds.has(passport.id)) {
      issues.push(
        issue(
          `duplicate-passport:${passport.id}`,
          `${passport.id} appears more than once`,
        ),
      );
    }
    passportIds.add(passport.id);

    const referencedPaths = [
      passport.anchor?.authorityRef,
      ...(passport.incubation?.implementationPaths || []),
      ...(passport.identityProtocol?.implementations || []).map(
        (entry) => entry.path,
      ),
      ...(passport.identityProtocol?.vectors || []),
      passport.identityProtocol?.admissionReceipt,
    ];
    for (const referencedPath of new Set(referencedPaths)) {
      if (referencedPath && !pathExists(root, referencedPath)) {
        issues.push(
          issue(
            `missing-passport-path:${passport.id}:${referencedPath}`,
            `${passport.id} references missing path ${referencedPath}`,
          ),
        );
      }
    }

    const ownership = passport.schemaOwnership || {};
    if (ownership.class === 'flatbuffers' || ownership.class === 'hana') {
      if (identities.get(ownership.identity) !== ownership.class) {
        issues.push(
          issue(
            `schema-owner-mismatch:${passport.id}`,
            `${passport.id} does not resolve ${ownership.identity} to ${ownership.class} in schema-authority.json`,
          ),
        );
      }
    } else if (ownership.class === 'profile-contract-world') {
      if (!pathExists(root, ownership.registryRef)) {
        issues.push(
          issue(
            `schema-owner-mismatch:${passport.id}`,
            `${passport.id} contract world does not exist`,
          ),
        );
      } else {
        const world = fs.readFileSync(
          path.join(root, ownership.registryRef),
          'utf8',
        );
        if (!world.includes(`\"${ownership.identity}\"`)) {
          issues.push(
            issue(
              `schema-owner-mismatch:${passport.id}`,
              `${passport.id} identity ${ownership.identity} is absent from its contract world`,
            ),
          );
        }
      }
    }

    if (passport.anchor?.type === 'runtime') {
      if (passport.persistence?.policy !== 'native-journal-only') {
        issues.push(
          issue(
            `runtime-persistence-policy:${passport.id}`,
            `${passport.id} runtime persistence must be native-journal-only`,
          ),
        );
      }
      if (
        passport.incubation?.state === 'incubating' &&
        passport.incubation?.deadline &&
        passport.incubation.deadline < today
      ) {
        issues.push(
          issue(
            `overdue-runtime-incubation:${passport.id}`,
            `${passport.id} deadline ${passport.incubation.deadline} is before ${today}`,
          ),
        );
      }
    }

    if (passport.identityProtocol?.mintsRoots) {
      const languages = new Set(
        (passport.identityProtocol.implementations || []).map(
          (entry) => entry.language,
        ),
      );
      const vectors = passport.identityProtocol.vectors || [];
      const complete =
        languages.size >= 2 &&
        vectors.length > 0 &&
        vectors.every((vectorPath) => pathExists(root, vectorPath));
      if (!complete) {
        issues.push(
          issue(
            `identity-protocol-conformance-missing:${passport.id}`,
            `${passport.id} requires two implementation languages and existing golden vectors`,
          ),
        );
      }
      if (
        passport.incubation?.state === 'admitted' &&
        passport.destinedAuthority?.admissionAssignment !== null
      ) {
        if (passport.incubation.deadline !== null) {
          issues.push(
            issue(
              `admitted-passport-deadline:${passport.id}`,
              `${passport.id} admitted state requires deadline null`,
            ),
          );
        }
        const receiptPath = passport.identityProtocol.admissionReceipt;
        if (!receiptPath || !pathExists(root, receiptPath)) {
          issues.push(
            issue(
              `admission-receipt-invalid:${passport.id}`,
              `${passport.id} admitted state requires an admission receipt fixture`,
            ),
          );
        } else {
          try {
            const fixtureErrors = validateAdmissionFixture({
              root,
              passport,
              fixture: loadJson(root, receiptPath),
            });
            if (fixtureErrors.length > 0) {
              issues.push(
                issue(
                  `admission-receipt-invalid:${passport.id}`,
                  fixtureErrors.join('; '),
                ),
              );
            }
          } catch (error) {
            issues.push(
              issue(
                `admission-receipt-invalid:${passport.id}`,
                `${passport.id} receipt could not be read: ${error.message}`,
              ),
            );
          }
        }
      }
    }
  }

  return issues.sort((left, right) => left.key.localeCompare(right.key));
}

export function compareBaseline(
  issues,
  baseline,
  today = utcDate(),
  expiryLeadDays = 30,
) {
  const currentByKey = new Map(issues.map((entry) => [entry.key, entry]));
  const baselineByKey = new Map();
  const malformedBaseline = [];
  const todayDay = utcDay(today);
  for (const entry of baseline.issues || []) {
    if (
      !entry.key ||
      !entry.owner ||
      !entry.rationale ||
      !entry.expiresOn ||
      !entry.removalCondition ||
      utcDay(entry.expiresOn) === null
    ) {
      malformedBaseline.push(entry.key || '<missing-key>');
      continue;
    }
    if (baselineByKey.has(entry.key)) malformedBaseline.push(entry.key);
    baselineByKey.set(entry.key, entry);
  }

  const expiringBaseline = [...baselineByKey.values()].filter((entry) => {
    const expiryDay = utcDay(entry.expiresOn);
    return (
      todayDay !== null &&
      expiryDay !== null &&
      expiryDay >= todayDay &&
      expiryDay - todayDay <= expiryLeadDays
    );
  });

  return {
    newIssues: issues.filter((entry) => !baselineByKey.has(entry.key)),
    staleBaseline: [...baselineByKey.values()].filter(
      (entry) => !currentByKey.has(entry.key),
    ),
    expiredBaseline: [...baselineByKey.values()].filter(
      (entry) => entry.expiresOn < today,
    ),
    expiringBaseline,
    malformedBaseline,
  };
}

function validationErrors(validate) {
  return (validate.errors || []).map(
    (entry) => `${entry.instancePath || '/'} ${entry.message || 'is invalid'}`,
  );
}

async function loadAjv2020() {
  try {
    return (await import('ajv/dist/2020.js')).default;
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

export async function validateRepository(root = ROOT, today = utcDate()) {
  const contract = loadJson(root, CONTRACT_PATH);
  const contractSchema = loadJson(root, CONTRACT_SCHEMA_PATH);
  const registry = loadJson(root, contract.registry);
  const registrySchema = loadJson(root, contract.registrySchema);
  const baseline = loadJson(root, contract.baseline);
  const authority = loadJson(root, contract.schemaAuthority);

  const structuralErrors = [];
  if (utcDay(today) === null) {
    structuralErrors.push(
      `today must be a real UTC date, got ${today || '<missing>'}`,
    );
  }
  const Ajv2020 = await loadAjv2020();
  let schemaValidation = 'skipped';
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/);
    const validateContract = ajv.compile(contractSchema);
    const validateRegistry = ajv.compile(registrySchema);
    if (!validateContract(contract)) {
      structuralErrors.push(
        ...validationErrors(validateContract).map(
          (entry) => `contract ${entry}`,
        ),
      );
    }
    if (!validateRegistry(registry)) {
      structuralErrors.push(
        ...validationErrors(validateRegistry).map(
          (entry) => `registry ${entry}`,
        ),
      );
    }
    schemaValidation = 'passed';
  } else {
    console.warn(
      '[incubation-passport] ajv not installed; semantic governance and exact ' +
        'baseline checks still ran. Run `./shifu sync` to enable JSON Schema ' +
        'conformance locally; CI enforces it.',
    );
  }
  if (registry.contract !== CONTRACT_PATH) {
    structuralErrors.push(`registry contract must point to ${CONTRACT_PATH}`);
  }

  const issues = collectIssues({
    root,
    registry,
    authority,
    schemas: trackedSchemas(root),
    today,
  });
  const expiryLeadDays = contract.baselinePolicy.expiryLeadDays;
  const comparison = compareBaseline(issues, baseline, today, expiryLeadDays);
  const ok =
    structuralErrors.length === 0 &&
    comparison.newIssues.length === 0 &&
    comparison.staleBaseline.length === 0 &&
    comparison.expiredBaseline.length === 0 &&
    comparison.expiringBaseline.length === 0 &&
    comparison.malformedBaseline.length === 0;
  return {
    schema: 'kungfu.incubation-passport.check/v1',
    ok,
    today,
    expiryLeadDays,
    currentIssueCount: issues.length,
    acceptedIssueCount: issues.length - comparison.newIssues.length,
    schemaValidation,
    structuralErrors,
    ...comparison,
  };
}

function renderFailure(result) {
  const lines = ['[incubation-passport] governance violations:'];
  for (const entry of result.structuralErrors)
    lines.push(`  structural: ${entry}`);
  for (const entry of result.newIssues)
    lines.push(`  new: ${entry.key} (${entry.detail})`);
  for (const entry of result.staleBaseline)
    lines.push(`  stale-baseline: ${entry.key}`);
  for (const entry of result.expiredBaseline)
    lines.push(`  expired-baseline: ${entry.key} (${entry.expiresOn})`);
  for (const entry of result.expiringBaseline)
    lines.push(
      `  near-expiry-baseline: ${entry.key} (${entry.expiresOn}; ` +
        `owner=${entry.owner}; continuation=${entry.removalCondition})`,
    );
  for (const entry of result.malformedBaseline)
    lines.push(`  malformed-baseline: ${entry}`);
  return lines.join('\n');
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  const json = process.argv.includes('--json');
  const todayIndex = process.argv.indexOf('--today');
  const today = todayIndex >= 0 ? process.argv[todayIndex + 1] : utcDate();
  if (utcDay(today) === null) {
    console.error(
      '[incubation-passport] --today requires a real YYYY-MM-DD UTC date',
    );
    process.exit(2);
  }
  const result = await validateRepository(ROOT, today);
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok)
    console.log(
      `[incubation-passport] PASS (${result.acceptedIssueCount} exact baseline issues remain visible)`,
    );
  else console.error(renderFailure(result));
  process.exit(result.ok ? 0 : 1);
}
