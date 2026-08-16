#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { devMergeBaseCandidates } from '../candidate-timeline-events.cjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const CONTRACT_PATH = 'docs/evolution/evolution-map.contract.json';
const ERA_ROOT = 'docs/evolution/eras';
const STAGE_ROOT = 'docs/evolution/stages';
const CANDIDATE_ROOT = 'docs/evolution/candidates';
const OUTPUTS = {
  map: 'docs/evolution/map.json',
  timeline: 'docs/evolution/timeline.md',
  authority: 'docs/evolution/current-authority.md',
  routes: 'docs/evolution/reader-routes.md',
  candidates: 'docs/evolution/candidates.md',
};

function candidateObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function candidateString(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} must be non-empty text`);
  return value.trim();
}

function candidateArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function emptyCandidateResolution() {
  return {
    kind: '',
    canonicalEra: '',
    initialStage: '',
    foldedIntoStage: '',
    mergedIntoCandidate: '',
  };
}

function emptyCandidateAuthorization() {
  return { kind: '', ref: '' };
}

function uniqueCandidateReferences(previous, additions) {
  const result = [];
  const seen = new Set();
  for (const item of [...previous, ...additions]) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) result.push(item);
    seen.add(key);
  }
  return result;
}

function candidateMarkdown(record) {
  return `# Era Candidate: ${record.title}\n\nThis is an immutable, non-authoritative Era Candidate revision. Canonical Era\nand Stage records remain the historical authority.\n\n\`\`\`json kungfu-evolution-era-candidate\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

export function planCandidate(inputValue, source) {
  const input = candidateObject(inputValue, 'input');
  const operation = candidateString(input.operation, 'input.operation');
  if (!['open', 'advance'].includes(operation))
    throw new Error('input.operation must be open or advance');
  const id = candidateString(input.id, 'input.id');
  const recordedAt = candidateString(input.recordedAt, 'input.recordedAt');
  const existing = source.candidates.filter((item) => item.id === id);
  const previous = existing
    .sort((left, right) => left.revision - right.revision)
    .at(-1);
  let record;
  if (operation === 'open') {
    if (previous) throw new Error(`candidate already exists: ${id}`);
    record = {
      schema: source.contract.candidateSchema,
      id,
      revision: 1,
      recordedAt,
      title: candidateString(input.title, 'input.title'),
      status: 'observed',
      currentEra: candidateString(input.currentEra, 'input.currentEra'),
      thesis: candidateString(input.thesis, 'input.thesis'),
      currentEraInsufficiency: candidateString(
        input.currentEraInsufficiency,
        'input.currentEraInsufficiency',
      ),
      compressionSignals: candidateArray(
        input.compressionSignals,
        'input.compressionSignals',
      ),
      downstreamStageHypotheses: candidateArray(
        input.downstreamStageHypotheses,
        'input.downstreamStageHypotheses',
      ),
      evidence: candidateArray(input.evidence, 'input.evidence'),
      counterEvidence: candidateArray(
        input.counterEvidence || [],
        'input.counterEvidence',
      ),
      confidence: candidateString(
        input.confidence || 'low',
        'input.confidence',
      ),
      previousRevisionRoot: '',
      transition: {
        fromStatus: '',
        reason: candidateString(input.reason, 'input.reason'),
      },
      resolution: emptyCandidateResolution(),
      authorization: emptyCandidateAuthorization(),
    };
  } else {
    if (!previous) throw new Error(`candidate does not exist: ${id}`);
    const { file: _previousFile, ...previousRecord } = previous;
    const expectedPreviousRoot = candidateString(
      input.expectedPreviousRoot,
      'input.expectedPreviousRoot',
    );
    const previousRoot = candidateRevisionRoot(previous);
    if (expectedPreviousRoot !== previousRoot)
      throw new Error(
        `stale candidate revision: expected ${previousRoot}, got ${expectedPreviousRoot}`,
      );
    record = {
      ...previousRecord,
      revision: previous.revision + 1,
      recordedAt,
      title: input.title
        ? candidateString(input.title, 'input.title')
        : previous.title,
      status: candidateString(input.status || previous.status, 'input.status'),
      thesis: input.thesis
        ? candidateString(input.thesis, 'input.thesis')
        : previous.thesis,
      currentEraInsufficiency: input.currentEraInsufficiency
        ? candidateString(
            input.currentEraInsufficiency,
            'input.currentEraInsufficiency',
          )
        : previous.currentEraInsufficiency,
      compressionSignals: input.compressionSignals
        ? candidateArray(input.compressionSignals, 'input.compressionSignals')
        : previous.compressionSignals,
      downstreamStageHypotheses: input.downstreamStageHypotheses
        ? candidateArray(
            input.downstreamStageHypotheses,
            'input.downstreamStageHypotheses',
          )
        : previous.downstreamStageHypotheses,
      evidence: uniqueCandidateReferences(
        previous.evidence,
        candidateArray(input.addEvidence || [], 'input.addEvidence'),
      ),
      counterEvidence: uniqueCandidateReferences(
        previous.counterEvidence,
        candidateArray(
          input.addCounterEvidence || [],
          'input.addCounterEvidence',
        ),
      ),
      confidence: input.confidence
        ? candidateString(input.confidence, 'input.confidence')
        : previous.confidence,
      previousRevisionRoot: previousRoot,
      transition: {
        fromStatus: previous.status,
        reason: candidateString(input.reason, 'input.reason'),
      },
      resolution: input.resolution
        ? candidateObject(input.resolution, 'input.resolution')
        : emptyCandidateResolution(),
      authorization: input.authorization
        ? candidateObject(input.authorization, 'input.authorization')
        : emptyCandidateAuthorization(),
    };
  }
  const revision = String(record.revision).padStart(4, '0');
  const file = `${CANDIDATE_ROOT}/${id}/${revision}-${recordedAt}.md`;
  const withFile = { ...record, file };
  buildEraCandidates(
    [...source.candidates, withFile],
    source.contract,
    source.root,
    source.map.eras,
    source.map.stages,
  );
  return {
    schema: 'kungfu.evolution-era-candidate-plan/v1',
    operation,
    candidateId: id,
    revision: record.revision,
    previousRevisionRoot: record.previousRevisionRoot,
    revisionRoot: candidateRevisionRoot(record),
    file,
    content: candidateMarkdown(record),
    sharedWrites: [],
  };
}

export function loadCandidateSource(root = ROOT) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, CONTRACT_PATH), 'utf8'),
  );
  const map = JSON.parse(fs.readFileSync(path.join(root, OUTPUTS.map), 'utf8'));
  const candidates = readCandidateRecords(
    root,
    CANDIDATE_ROOT,
    contract.recordFences.candidate,
  );
  return { root, contract, map, candidates };
}

export function writeCandidate(root, plan) {
  const target = path.join(root, plan.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'wx');
    fs.writeFileSync(descriptor, plan.content, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    )
      throw new Error(`candidate revision already exists: ${plan.file}`);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return target;
}

function parseCandidateArgs(argv) {
  const args = { input: '', write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--input') args.input = argv[++index] || '';
    else if (arg === '--write') args.write = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.input) throw new Error('--input is required');
  return args;
}

function candidateMain(argv) {
  const args = parseCandidateArgs(argv);
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'));
  const source = loadCandidateSource(ROOT);
  const plan = planCandidate(input, source);
  const outputPath = args.write ? writeCandidate(ROOT, plan) : '';
  process.stdout.write(
    `${JSON.stringify(
      {
        ...plan,
        mode: args.write ? 'write' : 'dry-run',
        writeReceipt: args.write
          ? {
              schema: 'kungfu.evolution-era-candidate-write-receipt/v1',
              file: plan.file,
              outputPath,
              revisionRoot: plan.revisionRoot,
              previousRevisionRoot: plan.previousRevisionRoot,
            }
          : null,
        content: undefined,
      },
      null,
      2,
    )}\n`,
  );
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function identifier(value, label) {
  invariant(
    typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value),
    `${label} must be a lowercase kebab-case identifier`,
  );
}

function nonEmptyText(value, label) {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    `${label} must be non-empty text`,
  );
}

function textArray(value, label, { allowEmpty = false } = {}) {
  invariant(Array.isArray(value), `${label} must be an array`);
  invariant(allowEmpty || value.length > 0, `${label} must not be empty`);
  for (const [index, item] of value.entries())
    nonEmptyText(item, `${label}[${index}]`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function digest(value) {
  return `sha256:${createHash('sha256')
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest('hex')}`;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(allowed),
    `${label} fields must be exactly: ${allowed.join(', ')}`,
  );
}

export function parseEvolutionRecord(text, kind, file = '<memory>') {
  const fence = '```';
  const pattern = new RegExp(
    `${fence}json ${kind}\\n([\\s\\S]*?)\\n${fence}`,
    'g',
  );
  const matches = [...text.matchAll(pattern)];
  invariant(
    matches.length === 1,
    `${file} must contain exactly one ${kind} fence`,
  );
  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(
      `${file} contains invalid ${kind} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function period(value, label) {
  invariant(value && typeof value === 'object', `${label} must be an object`);
  invariant(
    /^\d{4}-\d{2}-\d{2}$/.test(value.start),
    `${label}.start must be YYYY-MM-DD`,
  );
  invariant(
    value.end === 'ongoing' || /^\d{4}-\d{2}-\d{2}$/.test(value.end),
    `${label}.end must be YYYY-MM-DD or ongoing`,
  );
  if (value.end !== 'ongoing')
    invariant(value.start <= value.end, `${label} must not run backwards`);
}

function validateReference(
  ref,
  label,
  contract,
  root,
  evidenceKinds = contract.evidenceKinds,
  requireLocalTarget = true,
) {
  invariant(ref && typeof ref === 'object', `${label} must be an object`);
  invariant(evidenceKinds.includes(ref.kind), `${label}.kind is not supported`);
  nonEmptyText(ref.ref, `${label}.ref`);
  nonEmptyText(ref.label, `${label}.label`);
  if (ref.kind === 'pull-request')
    invariant(
      /^https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/\d+$/.test(
        ref.ref,
      ),
      `${label}.ref must be a canonical Kungfu pull request URL`,
    );
  if (ref.kind === 'commit')
    invariant(
      /^[0-9a-f]{40}$/.test(ref.ref),
      `${label}.ref must be a full commit SHA`,
    );
  if (['adr', 'document', 'contract', 'qualification'].includes(ref.kind)) {
    invariant(
      !path.isAbsolute(ref.ref) && !ref.ref.includes('..'),
      `${label}.ref must be repository-relative`,
    );
    if (requireLocalTarget)
      invariant(
        fs.existsSync(path.join(root, ref.ref)),
        `${label}.ref does not exist: ${ref.ref}`,
      );
  }
  if (['assignment', 'fact', 'episode', 'warrant'].includes(ref.kind))
    invariant(
      /^sha256:[0-9a-f]{64}$/.test(ref.ref),
      `${label}.ref must be a sha256 content root`,
    );
}

function validateEra(era, file, contract) {
  invariant(
    era.schema === contract.eraSchema,
    `${file} has the wrong era schema`,
  );
  identifier(era.id, `${file}.id`);
  invariant(
    Number.isInteger(era.sequence) && era.sequence > 0,
    `${file}.sequence must be positive`,
  );
  nonEmptyText(era.title, `${file}.title`);
  period(era.period, `${file}.period`);
  textArray(era.buildsOn, `${file}.buildsOn`, { allowEmpty: true });
  nonEmptyText(era.thesis, `${file}.thesis`);
}

function validateStage(stage, file, contract, root) {
  invariant(
    stage.schema === contract.stageSchema,
    `${file} has the wrong stage schema`,
  );
  identifier(stage.id, `${file}.id`);
  identifier(stage.era, `${file}.era`);
  invariant(
    Number.isInteger(stage.sequence) && stage.sequence > 0,
    `${file}.sequence must be positive`,
  );
  invariant(
    contract.stageStatuses.includes(stage.status),
    `${file}.status is not supported`,
  );
  invariant(
    contract.evolutionImpacts.includes(stage.evolutionImpact),
    `${file}.evolutionImpact is not supported`,
  );
  period(stage.period, `${file}.period`);
  for (const field of [
    'title',
    'pressure',
    'priorLimitation',
    'localCapability',
    'compression',
  ])
    nonEmptyText(stage[field], `${file}.${field}`);
  for (const field of [
    'buildsOn',
    'retiredSurfaces',
    'unlockedCapabilities',
    'downstreamConsumers',
    'amends',
    'supersedes',
  ])
    textArray(stage[field], `${file}.${field}`, {
      allowEmpty: [
        'buildsOn',
        'retiredSurfaces',
        'amends',
        'supersedes',
      ].includes(field),
    });
  invariant(
    Array.isArray(stage.authorityTransitions) &&
      stage.authorityTransitions.length > 0,
    `${file}.authorityTransitions must not be empty`,
  );
  const subjects = new Set();
  for (const [index, transition] of stage.authorityTransitions.entries()) {
    const label = `${file}.authorityTransitions[${index}]`;
    identifier(transition.subject, `${label}.subject`);
    invariant(
      !subjects.has(transition.subject),
      `${file} repeats authority subject ${transition.subject}`,
    );
    subjects.add(transition.subject);
    nonEmptyText(transition.before, `${label}.before`);
    nonEmptyText(transition.after, `${label}.after`);
    textArray(transition.authorityRefs, `${label}.authorityRefs`);
  }
  invariant(
    Array.isArray(stage.evidence) && stage.evidence.length > 0,
    `${file}.evidence must not be empty`,
  );
  stage.evidence.forEach((ref, index) =>
    validateReference(
      ref,
      `${file}.evidence[${index}]`,
      contract,
      root,
      contract.evidenceKinds,
      false,
    ),
  );
  invariant(
    stage.readerRoute && typeof stage.readerRoute === 'object',
    `${file}.readerRoute must be an object`,
  );
  nonEmptyText(stage.readerRoute.intent, `${file}.readerRoute.intent`);
  nonEmptyText(stage.readerRoute.start, `${file}.readerRoute.start`);
  textArray(stage.readerRoute.deepen, `${file}.readerRoute.deepen`);
}

function readerRouteMissingRefs(stage, root) {
  return [stage.readerRoute.start, ...stage.readerRoute.deepen].filter(
    (ref) => !fs.existsSync(path.join(root, ref)),
  );
}

function authorityMissingRefs(stage, root) {
  return stage.authorityTransitions
    .flatMap((transition) => transition.authorityRefs)
    .filter((ref) => !fs.existsSync(path.join(root, ref)));
}

function evidenceMissingRefs(stage, root) {
  return stage.evidence
    .filter((ref) =>
      ['adr', 'document', 'contract', 'qualification'].includes(ref.kind),
    )
    .map((ref) => ref.ref)
    .filter((ref) => !fs.existsSync(path.join(root, ref)));
}

function effectiveReaderRoute(stage, stages) {
  let effective = stage;
  for (const candidate of stages)
    if (candidate.amends.includes(effective.id)) effective = candidate;
  return effective.readerRoute;
}

const CANDIDATE_FIELDS = [
  'schema',
  'id',
  'revision',
  'recordedAt',
  'title',
  'status',
  'currentEra',
  'thesis',
  'currentEraInsufficiency',
  'compressionSignals',
  'downstreamStageHypotheses',
  'evidence',
  'counterEvidence',
  'confidence',
  'previousRevisionRoot',
  'transition',
  'resolution',
  'authorization',
];

const CANDIDATE_TRANSITIONS = {
  observed: new Set([
    'observed',
    'accumulating',
    'review-ready',
    'folded-back',
    'rejected',
  ]),
  accumulating: new Set([
    'accumulating',
    'review-ready',
    'folded-back',
    'rejected',
  ]),
  'review-ready': new Set([
    'review-ready',
    'accumulating',
    'promoted',
    'folded-back',
    'rejected',
  ]),
};

function referenceKey(value) {
  return JSON.stringify(canonical(value));
}

function includesEveryReference(next, prior) {
  const values = new Set(next.map(referenceKey));
  return prior.every((item) => values.has(referenceKey(item)));
}

function distinctEvidenceIdentities(values) {
  return new Set(values.map((item) => `${item.kind}:${item.ref}`)).size;
}

function candidateNextActions(status) {
  if (status === 'observed') return ['append-evidence', 'fold-back', 'reject'];
  if (status === 'accumulating')
    return ['append-evidence', 'mark-review-ready', 'fold-back', 'reject'];
  if (status === 'review-ready')
    return [
      'append-counter-evidence',
      'return-to-accumulating',
      'promote-with-authority',
      'fold-back',
      'reject',
    ];
  return [];
}

export function candidateRevisionRoot(candidate) {
  const { file: _file, ...record } = candidate;
  return digest(record);
}

function validateCandidate(candidate, file, contract, root) {
  invariant(
    candidate && typeof candidate === 'object',
    `${file} must be an object`,
  );
  const { file: _file, ...record } = candidate;
  exactKeys(record, CANDIDATE_FIELDS, file);
  invariant(
    candidate.schema === contract.candidateSchema,
    `${file} has the wrong candidate schema`,
  );
  identifier(candidate.id, `${file}.id`);
  invariant(
    Number.isInteger(candidate.revision) && candidate.revision > 0,
    `${file}.revision must be positive`,
  );
  invariant(
    /^\d{4}-\d{2}-\d{2}$/.test(candidate.recordedAt),
    `${file}.recordedAt must be YYYY-MM-DD`,
  );
  const expectedFile = `${CANDIDATE_ROOT}/${candidate.id}/${String(candidate.revision).padStart(4, '0')}-${candidate.recordedAt}.md`;
  invariant(
    file === expectedFile,
    `${file} must match candidate identity path ${expectedFile}`,
  );
  for (const field of ['title', 'thesis', 'currentEraInsufficiency'])
    nonEmptyText(candidate[field], `${file}.${field}`);
  identifier(candidate.currentEra, `${file}.currentEra`);
  invariant(
    contract.candidateStatuses.includes(candidate.status),
    `${file}.status is not supported`,
  );
  invariant(
    contract.candidateConfidence.includes(candidate.confidence),
    `${file}.confidence is not supported`,
  );
  textArray(candidate.compressionSignals, `${file}.compressionSignals`);
  textArray(
    candidate.downstreamStageHypotheses,
    `${file}.downstreamStageHypotheses`,
  );
  invariant(
    candidate.downstreamStageHypotheses.length >= 2,
    `${file}.downstreamStageHypotheses must describe at least two possible Stages`,
  );
  invariant(
    Array.isArray(candidate.evidence) && candidate.evidence.length > 0,
    `${file}.evidence must not be empty`,
  );
  candidate.evidence.forEach((ref, index) =>
    validateReference(
      ref,
      `${file}.evidence[${index}]`,
      contract,
      root,
      contract.candidateEvidenceKinds,
    ),
  );
  invariant(
    distinctEvidenceIdentities(candidate.evidence) ===
      candidate.evidence.length,
    `${file}.evidence must not repeat a kind/ref identity`,
  );
  invariant(
    Array.isArray(candidate.counterEvidence),
    `${file}.counterEvidence must be an array`,
  );
  candidate.counterEvidence.forEach((ref, index) =>
    validateReference(
      ref,
      `${file}.counterEvidence[${index}]`,
      contract,
      root,
      contract.candidateEvidenceKinds,
    ),
  );
  invariant(
    distinctEvidenceIdentities(candidate.counterEvidence) ===
      candidate.counterEvidence.length,
    `${file}.counterEvidence must not repeat a kind/ref identity`,
  );
  invariant(
    typeof candidate.previousRevisionRoot === 'string',
    `${file}.previousRevisionRoot must be a string`,
  );
  invariant(
    candidate.transition && typeof candidate.transition === 'object',
    `${file}.transition must be an object`,
  );
  exactKeys(
    candidate.transition,
    ['fromStatus', 'reason'],
    `${file}.transition`,
  );
  invariant(
    typeof candidate.transition.fromStatus === 'string',
    `${file}.transition.fromStatus must be a string`,
  );
  nonEmptyText(candidate.transition.reason, `${file}.transition.reason`);
  invariant(
    candidate.resolution && typeof candidate.resolution === 'object',
    `${file}.resolution must be an object`,
  );
  exactKeys(
    candidate.resolution,
    [
      'kind',
      'canonicalEra',
      'initialStage',
      'foldedIntoStage',
      'mergedIntoCandidate',
    ],
    `${file}.resolution`,
  );
  for (const field of [
    'kind',
    'canonicalEra',
    'initialStage',
    'foldedIntoStage',
    'mergedIntoCandidate',
  ])
    invariant(
      typeof candidate.resolution[field] === 'string',
      `${file}.resolution.${field} must be a string`,
    );
  invariant(
    candidate.authorization && typeof candidate.authorization === 'object',
    `${file}.authorization must be an object`,
  );
  exactKeys(candidate.authorization, ['kind', 'ref'], `${file}.authorization`);
  invariant(
    typeof candidate.authorization.kind === 'string' &&
      typeof candidate.authorization.ref === 'string',
    `${file}.authorization fields must be strings`,
  );
}

export function buildEraCandidates(
  candidatesInput,
  contract,
  root = ROOT,
  eras = [],
  stages = [],
) {
  const records = candidatesInput
    .map((item) => ({ ...item }))
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        left.revision - right.revision ||
        left.file.localeCompare(right.file),
    );
  const eraIds = new Set(eras.map((item) => item.id));
  const stageById = new Map(stages.map((item) => [item.id, item]));
  const byId = new Map();
  for (const record of records) {
    validateCandidate(record, record.file, contract, root);
    invariant(
      eraIds.has(record.currentEra),
      `${record.file}.currentEra is not a canonical Era: ${record.currentEra}`,
    );
    const revisions = byId.get(record.id) || [];
    const previous = revisions.at(-1);
    invariant(
      record.revision === revisions.length + 1,
      `${record.id} revisions must start at 1 and remain contiguous`,
    );
    if (!previous) {
      invariant(
        record.previousRevisionRoot === '',
        `${record.file}.previousRevisionRoot must be empty for revision 1`,
      );
      invariant(
        record.transition.fromStatus === '',
        `${record.file}.transition.fromStatus must be empty for revision 1`,
      );
      invariant(
        record.status === 'observed',
        `${record.file} revision 1 must start observed`,
      );
    } else {
      invariant(
        record.currentEra === previous.currentEra,
        `${record.file}.currentEra cannot change across revisions`,
      );
      invariant(
        record.previousRevisionRoot === candidateRevisionRoot(previous),
        `${record.file}.previousRevisionRoot does not match revision ${previous.revision}`,
      );
      invariant(
        record.transition.fromStatus === previous.status,
        `${record.file}.transition.fromStatus must equal ${previous.status}`,
      );
      invariant(
        !['promoted', 'folded-back', 'rejected'].includes(previous.status),
        `${record.id} cannot append after terminal status ${previous.status}`,
      );
      invariant(
        CANDIDATE_TRANSITIONS[previous.status]?.has(record.status),
        `${record.id} cannot transition from ${previous.status} to ${record.status}`,
      );
      invariant(
        includesEveryReference(record.evidence, previous.evidence),
        `${record.file}.evidence cannot remove earlier evidence`,
      );
      invariant(
        includesEveryReference(
          record.counterEvidence,
          previous.counterEvidence,
        ),
        `${record.file}.counterEvidence cannot remove earlier counter-evidence`,
      );
    }
    revisions.push(record);
    byId.set(record.id, revisions);
  }
  const candidateIds = new Set(byId.keys());
  for (const revisions of byId.values()) {
    const latest = revisions.at(-1);
    const resolution = latest.resolution;
    const authorization = latest.authorization;
    if (!['promoted', 'folded-back', 'rejected'].includes(latest.status)) {
      invariant(
        Object.values(resolution).every((value) => value === ''),
        `${latest.file} cannot resolve a non-terminal candidate`,
      );
      invariant(
        authorization.kind === '' && authorization.ref === '',
        `${latest.file} cannot authorize a non-terminal candidate`,
      );
    }
    if (latest.status === 'review-ready')
      invariant(
        latest.evidence.length >= 2,
        `${latest.file} review-ready status requires at least two evidence references`,
      );
    if (latest.status === 'promoted') {
      invariant(
        resolution.kind === 'promoted',
        `${latest.file} promoted status requires resolution.kind=promoted`,
      );
      invariant(
        eraIds.has(resolution.canonicalEra),
        `${latest.file} promoted canonicalEra must exist`,
      );
      invariant(
        stageById.has(resolution.initialStage),
        `${latest.file} promoted initialStage must exist`,
      );
      invariant(
        stageById.get(resolution.initialStage).era === resolution.canonicalEra,
        `${latest.file} initialStage must belong to canonicalEra`,
      );
      invariant(
        ['maintainer', 'warrant'].includes(authorization.kind) &&
          authorization.ref,
        `${latest.file} promotion requires maintainer or Warrant authorization`,
      );
      if (authorization.kind === 'maintainer')
        invariant(
          /^https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/\d+$/.test(
            authorization.ref,
          ),
          `${latest.file} maintainer authorization must be a canonical Kungfu pull request URL`,
        );
      if (authorization.kind === 'warrant')
        invariant(
          /^sha256:[0-9a-f]{64}$/.test(authorization.ref),
          `${latest.file} Warrant authorization must be a sha256 content root`,
        );
    }
    if (latest.status === 'folded-back') {
      invariant(
        resolution.kind === 'folded-into-stage' ||
          resolution.kind === 'merged-duplicate',
        `${latest.file} folded-back status requires a fold or duplicate resolution`,
      );
      if (resolution.kind === 'folded-into-stage')
        invariant(
          stageById.has(resolution.foldedIntoStage),
          `${latest.file} foldedIntoStage must exist`,
        );
      if (resolution.kind === 'merged-duplicate')
        invariant(
          resolution.mergedIntoCandidate !== latest.id &&
            candidateIds.has(resolution.mergedIntoCandidate),
          `${latest.file} mergedIntoCandidate must identify another candidate`,
        );
    }
    if (latest.status === 'rejected')
      invariant(
        resolution.kind === 'rejected',
        `${latest.file} rejected status requires resolution.kind=rejected`,
      );
  }
  return [...byId.entries()].map(([id, revisions]) => ({
    id,
    latest: revisions.at(-1),
    nextActions: candidateNextActions(revisions.at(-1).status),
    revisionRoots: revisions.map(candidateRevisionRoot),
    revisions: revisions.map((record) => ({
      revision: record.revision,
      status: record.status,
      recordedAt: record.recordedAt,
      file: record.file,
      revisionRoot: candidateRevisionRoot(record),
    })),
  }));
}

export function buildEvolutionMap(
  erasInput,
  stagesInput,
  contract,
  root = ROOT,
  candidatesInput = [],
) {
  const eras = erasInput
    .map((item) => ({ ...item }))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  const stages = stagesInput
    .map((item) => ({ ...item }))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  const eraIds = new Set();
  let previousEraSequence = 0;
  for (const era of eras) {
    validateEra(era, era.file, contract);
    invariant(!eraIds.has(era.id), `duplicate era id: ${era.id}`);
    invariant(
      era.sequence > previousEraSequence,
      `era sequence must be strictly increasing at ${era.id}`,
    );
    for (const predecessor of era.buildsOn)
      invariant(
        eraIds.has(predecessor),
        `${era.id} has dangling or forward buildsOn: ${predecessor}`,
      );
    eraIds.add(era.id);
    previousEraSequence = era.sequence;
  }
  invariant(
    eras.length > 0,
    'the evolution corpus must contain at least one era',
  );

  const stageIds = new Set();
  const authority = new Map();
  let previousStageSequence = 0;
  for (const stage of stages) {
    validateStage(stage, stage.file, contract, root);
    invariant(!stageIds.has(stage.id), `duplicate stage id: ${stage.id}`);
    invariant(
      eraIds.has(stage.era),
      `${stage.id} references unknown era: ${stage.era}`,
    );
    invariant(
      stage.sequence > previousStageSequence,
      `stage sequence must be strictly increasing at ${stage.id}`,
    );
    invariant(
      stageIds.size === 0 || stage.buildsOn.length > 0,
      `${stage.id} must build on at least one earlier Stage`,
    );
    for (const relation of ['buildsOn', 'amends', 'supersedes'])
      for (const predecessor of stage[relation])
        invariant(
          stageIds.has(predecessor),
          `${stage.id} has dangling or forward ${relation}: ${predecessor}`,
        );
    for (const transition of stage.authorityTransitions) {
      const prior = authority.get(transition.subject);
      if (prior)
        invariant(
          prior.authority === transition.before,
          `${stage.id} authority transition for ${transition.subject} expected before=${prior.authority}, got ${transition.before}`,
        );
      authority.set(transition.subject, {
        subject: transition.subject,
        authority: transition.after,
        sinceStage: stage.id,
        authorityRefs: transition.authorityRefs,
      });
    }
    stageIds.add(stage.id);
    previousStageSequence = stage.sequence;
  }
  invariant(
    stages.length > 0,
    'the evolution corpus must contain at least one stage',
  );
  const amendedStageIds = new Set(stages.flatMap((stage) => stage.amends));
  for (const stage of stages) {
    const missingRefs = [
      ...authorityMissingRefs(stage, root),
      ...evidenceMissingRefs(stage, root),
      ...readerRouteMissingRefs(stage, root),
    ];
    invariant(
      missingRefs.length === 0 || amendedStageIds.has(stage.id),
      `${stage.file} historical ref does not exist without an explicit amendment: ${missingRefs.join(', ')}`,
    );
  }

  const currentAuthority = [...authority.values()].sort((left, right) =>
    left.subject.localeCompare(right.subject),
  );
  const eraCandidates = buildEraCandidates(
    candidatesInput,
    contract,
    root,
    eras,
    stages,
  );
  const source = { eras, stages, eraCandidates };
  return {
    schema: contract.projectionSchema,
    generatedFrom: {
      authority:
        'append-only canonical Era and Stage records plus non-authoritative Era Candidate revisions under docs/evolution',
      semanticGraphAuthority:
        'Xinfa Atlas; this projection never creates current runtime authority',
      sourceRoot: digest(source),
    },
    summary: {
      eras: eras.length,
      stages: stages.length,
      evidence: stages.reduce(
        (total, stage) => total + stage.evidence.length,
        0,
      ),
      authoritySubjects: currentAuthority.length,
      eraCandidates: eraCandidates.length,
      unresolvedEraCandidates: eraCandidates.filter(
        (item) =>
          !['promoted', 'folded-back', 'rejected'].includes(item.latest.status),
      ).length,
    },
    eras,
    stages,
    eraCandidates,
    currentAuthority,
  };
}

function markdownLink(from, target, label = target) {
  return `[${label}](${path.posix.relative(path.posix.dirname(from), target)})`;
}

export function renderTimeline(projection) {
  const lines = [
    '# Kungfu Evolution Timeline',
    '',
    'This page is generated from the append-only Era and Stage corpus. It is a',
    'longitudinal learning path, not a replacement for current architecture, runtime,',
    'or qualification authority.',
    '',
    `Coverage: **${projection.summary.eras} eras**, **${projection.summary.stages} stages**, and **${projection.summary.evidence} evidence references**.`,
    '',
  ];
  for (const era of projection.eras) {
    lines.push(
      `## Era ${era.sequence}: ${era.title}`,
      '',
      `Era record: ${markdownLink(OUTPUTS.timeline, era.file, era.id)}`,
      '',
      era.thesis,
      '',
    );
    for (const stage of projection.stages.filter(
      (item) => item.era === era.id,
    )) {
      lines.push(
        `### ${stage.sequence}. ${stage.title}`,
        '',
        `**Period:** ${stage.period.start} to ${stage.period.end} · **Recorded status:** ${stage.status}`,
        '',
        `**Pressure:** ${stage.pressure}`,
        '',
        `**Compression:** ${stage.compression}`,
        '',
        `${markdownLink(OUTPUTS.timeline, stage.file, 'Open the immutable Stage record')} for the full capability, authority transition, downstream consumers, and evidence.`,
        '',
      );
    }
  }
  lines.push(
    '## Maintenance',
    '',
    'Add a successor or amendment record; do not edit a Stage that already exists on',
    'the protected base. Regenerate with `./shifu evolution:map`. The documentation',
    'and source gates reject stale projections and settled-history mutation.',
    '',
  );
  return lines.join('\n');
}

export function renderAuthority(projection) {
  const lines = [
    '# Current Authority Through the Evolution Lens',
    '',
    'This generated table folds declared authority transitions across the historical',
    'Stage corpus. It tells a reader where to continue; every referenced current',
    'contract remains authoritative over this navigation projection.',
    '',
    '| Subject | Current authority | Since | Exact current references |',
    '|---|---|---|---|',
  ];
  for (const item of projection.currentAuthority) {
    const stage = projection.stages.find(
      (candidate) => candidate.id === item.sinceStage,
    );
    const refs = item.authorityRefs
      .map((ref) => markdownLink(OUTPUTS.authority, ref, ref))
      .join('<br>');
    lines.push(
      `| ${item.subject} | ${item.authority} | ${markdownLink(OUTPUTS.authority, stage.file, stage.title)} | ${refs} |`,
    );
  }
  lines.push(
    '',
    `Machine projection: ${markdownLink(OUTPUTS.authority, OUTPUTS.map, 'map.json')}.`,
    '',
  );
  return lines.join('\n');
}

export function renderReaderRoutes(projection) {
  const lines = [
    '# Evolution Reader Routes',
    '',
    'Start with the timeline when repository breadth is the problem. Then choose the',
    'closest historical pressure below and cross into the exact current authority.',
    'Agents should request the paired `kungfu-evolution-map-agent` Xinfa route.',
    '',
  ];
  for (const stage of projection.stages) {
    const readerRoute = effectiveReaderRoute(stage, projection.stages);
    lines.push(
      `## ${readerRoute.intent}`,
      '',
      `Historical context: ${markdownLink(OUTPUTS.routes, stage.file, stage.title)}.`,
      '',
      `Start current reading at ${markdownLink(OUTPUTS.routes, readerRoute.start)}.`,
      '',
      `Deepen through ${readerRoute.deepen.map((ref) => markdownLink(OUTPUTS.routes, ref)).join(', ')}.`,
      '',
    );
  }
  return lines.join('\n');
}

export function renderCandidates(projection) {
  const lines = [
    '# Era Candidate Ledger',
    '',
    'This generated ledger holds hypotheses that the current Era thesis may no longer',
    'compress the work. Candidates are evidence packets, not canonical Eras: they do',
    'not allocate an Era sequence, change current authority, or settle history.',
    '',
    `Open candidates: **${projection.summary.unresolvedEraCandidates}** · Total retained candidates: **${projection.summary.eraCandidates}**.`,
    '',
  ];
  if (projection.eraCandidates.length === 0) {
    lines.push('No Era Candidate has been recorded.', '');
  }
  for (const candidate of projection.eraCandidates) {
    const latest = candidate.latest;
    lines.push(
      `## ${latest.title}`,
      '',
      `**Candidate:** \`${candidate.id}\` · **Status:** ${latest.status} · **Confidence:** ${latest.confidence} · **Revision:** ${latest.revision}`,
      '',
      `**Thesis:** ${latest.thesis}`,
      '',
      `**Why the current Era may be insufficient:** ${latest.currentEraInsufficiency}`,
      '',
      `Latest immutable revision: ${markdownLink(OUTPUTS.candidates, latest.file, candidateRevisionRoot(latest))}.`,
      '',
      `**Next actions:** ${candidate.nextActions.length > 0 ? candidate.nextActions.map((action) => `\`${action}\``).join(', ') : 'none; terminal history is retained'}.`,
      '',
    );
  }
  lines.push(
    '## Next action',
    '',
    'Agents should do nothing when ordinary Stage extension explains the change. When',
    'the candidate threshold is met, prepare a dry-run with `./shifu evolution:candidate`;',
    'only append with `--write` after reviewing the exact file and predecessor root.',
    'Promotion requires an explicit maintainer decision or appropriately scoped Warrant.',
    '',
  );
  return lines.join('\n');
}

export function readRecords(root, relativeRoot, fence) {
  const directory = path.join(root, relativeRoot);
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const relative = path.posix.join(relativeRoot, file);
      return {
        ...parseEvolutionRecord(
          fs.readFileSync(path.join(root, relative), 'utf8'),
          fence,
          relative,
        ),
        file: relative,
      };
    });
}

export function readCandidateRecords(root, relativeRoot, fence) {
  const directory = path.join(root, relativeRoot);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const relative = path.posix.join(
        relativeRoot,
        file.split(path.sep).join('/'),
      );
      return {
        ...parseEvolutionRecord(
          fs.readFileSync(path.join(root, relative), 'utf8'),
          fence,
          relative,
        ),
        file: relative,
      };
    });
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  return result.status === 0 ? result.stdout.trim() : '';
}

function checkHistoricalIntegrity() {
  const base =
    process.env.KUNGFU_EVOLUTION_BASE ||
    devMergeBaseCandidates()
      .map((ref) =>
        runGit(['merge-base', ref, 'HEAD'], {
          allowFailure: true,
        }),
      )
      .find(Boolean);
  invariant(base, 'cannot resolve the evolution history merge base');
  const changed = runGit([
    'diff',
    '--name-status',
    base,
    '--',
    ERA_ROOT,
    STAGE_ROOT,
    CANDIDATE_ROOT,
  ]);
  const violations = findHistoricalMutationViolations(
    changed.split('\n').filter(Boolean),
    (file) =>
      spawnSync('git', ['cat-file', '-e', `${base}:${file}`], {
        cwd: ROOT,
        stdio: 'ignore',
      }).status === 0,
  );
  invariant(violations.length === 0, violations.join('; '));
}

export function findHistoricalMutationViolations(lines, existedAtBase) {
  const violations = [];
  for (const line of lines) {
    const [status, file] = line.split('\t');
    if (!['M', 'D'].includes(status)) continue;
    if (!existedAtBase(file)) continue;
    const action = status === 'D' ? 'deleting' : 'editing';
    violations.push(
      file.startsWith(`${CANDIDATE_ROOT}/`)
        ? `${file} is immutable candidate history; append a new candidate revision instead of ${action} it`
        : `${file} is settled history; add an amendment or successor Stage instead of ${action} it`,
    );
  }
  return violations;
}

function checkPullRequestTemplate(contract) {
  const template = fs.readFileSync(
    path.join(ROOT, '.github/pull_request_template.md'),
    'utf8',
  );
  const marker = `Evolution impact: <!-- ${contract.evolutionImpacts.join(' | ')} -->`;
  invariant(
    template.includes(marker),
    `.github/pull_request_template.md must contain: ${marker}`,
  );
}

export function findUnlinkedEvolutionMapMentions(entries) {
  const violations = [];
  for (const { file, text } of entries) {
    if (file === 'docs/evolution/README.md') continue;
    let fenced = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced || !/\bevolution map\b/i.test(line)) continue;
      if (
        file.startsWith('docs/adr/') &&
        /^#\s+.*\bevolution map\b/i.test(line)
      )
        continue;
      if (/\[[^\]]*\bevolution map\b[^\]]*\]\([^)]+\)/i.test(line)) continue;
      violations.push(`${file}:${index + 1}`);
    }
  }
  return violations;
}

function checkEvolutionMapNavigation() {
  const markdownFiles = runGit(['ls-files', '--', '*.md'])
    .split('\n')
    .filter(Boolean);
  const violations = findUnlinkedEvolutionMapMentions(
    markdownFiles.map((file) => ({
      file,
      text: fs.readFileSync(path.join(ROOT, file), 'utf8'),
    })),
  );
  invariant(
    violations.length === 0,
    `Evolution Map mentions must link to a navigation target: ${violations.join(', ')}`,
  );
}

function outputs() {
  const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, CONTRACT_PATH), 'utf8'),
  );
  const eras = readRecords(ROOT, ERA_ROOT, contract.recordFences.era);
  const stages = readRecords(ROOT, STAGE_ROOT, contract.recordFences.stage);
  const candidates = readCandidateRecords(
    ROOT,
    CANDIDATE_ROOT,
    contract.recordFences.candidate,
  );
  const projection = buildEvolutionMap(
    eras,
    stages,
    contract,
    ROOT,
    candidates,
  );
  checkHistoricalIntegrity();
  checkPullRequestTemplate(contract);
  checkEvolutionMapNavigation();
  return new Map([
    [OUTPUTS.map, `${JSON.stringify(projection, null, 2)}\n`],
    [OUTPUTS.timeline, renderTimeline(projection)],
    [OUTPUTS.authority, renderAuthority(projection)],
    [OUTPUTS.routes, renderReaderRoutes(projection)],
    [OUTPUTS.candidates, renderCandidates(projection)],
  ]);
}

function main(argv) {
  if (argv[0] === '--candidate') {
    candidateMain(argv.slice(1));
    return;
  }
  const check = argv.includes('--check');
  const write = argv.includes('--write') || !check;
  if (argv.some((arg) => !['--check', '--write'].includes(arg)))
    throw new Error(`unknown argument: ${argv.join(' ')}`);
  for (const [relative, content] of outputs()) {
    const target = path.join(ROOT, relative);
    if (check) {
      const actual = fs.existsSync(target)
        ? fs.readFileSync(target, 'utf8')
        : '';
      invariant(
        actual === content,
        `${relative} is stale; run ./shifu evolution:map`,
      );
    }
    if (write) fs.writeFileSync(target, content);
  }
  process.stdout.write(
    `[evolution-map] ${check ? 'current' : 'generated'} ${Object.values(OUTPUTS).join(', ')}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[evolution-map] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
