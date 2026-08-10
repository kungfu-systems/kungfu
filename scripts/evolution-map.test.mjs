// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  buildEraCandidates,
  buildEvolutionMap,
  candidateRevisionRoot,
  findHistoricalMutationViolations,
  findUnlinkedEvolutionMapMentions,
  parseEvolutionRecord,
  planCandidate,
  renderAuthority,
  renderCandidates,
  renderReaderRoutes,
  renderTimeline,
  writeCandidate,
} from './evolution-map/index.mjs';

const contract = {
  eraSchema: 'kungfu.evolution-era/v1',
  stageSchema: 'kungfu.evolution-stage/v1',
  candidateSchema: 'kungfu.evolution-era-candidate/v1',
  projectionSchema: 'kungfu.evolution-map-projection/v1',
  stageStatuses: ['open', 'settled'],
  candidateStatuses: [
    'observed',
    'accumulating',
    'review-ready',
    'promoted',
    'folded-back',
    'rejected',
  ],
  candidateConfidence: ['low', 'medium', 'high'],
  candidateEvidenceKinds: [
    'pull-request',
    'commit',
    'adr',
    'document',
    'assignment',
    'fact',
    'episode',
    'warrant',
    'contract',
    'qualification',
  ],
  evolutionImpacts: ['none', 'extends', 'opens', 'settles', 'supersedes'],
  evidenceKinds: ['pull-request', 'commit', 'adr', 'document'],
};

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true });
});

function candidateSource(root, candidates = []) {
  return {
    root,
    candidates,
    contract,
    map: {
      eras: [{ id: 'work-control-dogfood' }],
      stages: [{ id: 'native-work-control', era: 'work-control-dogfood' }],
    },
  };
}

function candidateOpenInput() {
  return {
    operation: 'open',
    id: 'market-governance',
    recordedAt: '2026-07-29',
    title: 'Market governance',
    currentEra: 'work-control-dogfood',
    thesis: 'Issue-driven maintenance may establish a new governance axis.',
    currentEraInsufficiency:
      'The current Era may not explain market intake and release stewardship together.',
    compressionSignals: ['Issue intake and delivery authority converge.'],
    downstreamStageHypotheses: [
      'Governed issue intake',
      'Autonomous alpha maintenance',
    ],
    evidence: [
      {
        kind: 'document',
        ref: 'package.json',
        label: 'Current source contract',
      },
    ],
    counterEvidence: [],
    confidence: 'low',
    reason: 'Capture the hypothesis before broadening authority.',
  };
}

function era(overrides = {}) {
  return {
    schema: contract.eraSchema,
    id: 'journal-substrate',
    sequence: 1,
    title: 'Journal substrate',
    period: { start: '2026-06-16', end: '2026-07-01' },
    buildsOn: [],
    thesis: 'A shared journal makes cross-runtime work observable.',
    file: 'docs/evolution/eras/journal-substrate.md',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    schema: contract.candidateSchema,
    id: 'agent-governance-axis',
    revision: 1,
    recordedAt: '2026-07-29',
    title: 'Agent governance axis',
    status: 'observed',
    currentEra: 'journal-substrate',
    thesis: 'Repeated governance work may require a new abstraction axis.',
    currentEraInsufficiency:
      'The current thesis may no longer explain more than one downstream compression.',
    compressionSignals: [
      'Multiple workflows converge on one authority boundary.',
    ],
    downstreamStageHypotheses: [
      'Governed issue intake',
      'Autonomous release stewardship',
    ],
    evidence: [
      {
        kind: 'commit',
        ref: '1599ab1cc50a2eeef0f7f4dfd54b8d2030f674b8',
        label: 'Exact source evidence',
      },
    ],
    counterEvidence: [],
    confidence: 'low',
    previousRevisionRoot: '',
    transition: {
      fromStatus: '',
      reason: 'Observe without granting authority.',
    },
    resolution: {
      kind: '',
      canonicalEra: '',
      initialStage: '',
      foldedIntoStage: '',
      mergedIntoCandidate: '',
    },
    authorization: { kind: '', ref: '' },
    file: 'docs/evolution/candidates/agent-governance-axis/0001-2026-07-29.md',
    ...overrides,
  };
}

function stage(overrides = {}) {
  return {
    schema: contract.stageSchema,
    id: 'polyglot-journal',
    era: 'journal-substrate',
    sequence: 1,
    title: 'Polyglot journal',
    status: 'settled',
    evolutionImpact: 'settles',
    period: { start: '2026-06-16', end: '2026-06-17' },
    buildsOn: [],
    pressure: 'Three runtimes needed one execution history.',
    priorLimitation: 'History was runtime-local.',
    localCapability: 'C++, Python, and Node share one journal.',
    compression: 'The journal became the common execution substrate.',
    authorityTransitions: [
      {
        subject: 'execution-history',
        before: 'runtime-local logs',
        after: 'yijinjing append-only journal',
        authorityRefs: ['package.json'],
      },
    ],
    retiredSurfaces: [],
    unlockedCapabilities: ['cross-runtime causal capture'],
    downstreamConsumers: ['Rewind'],
    evidence: [
      {
        kind: 'commit',
        ref: '1599ab1cc50a2eeef0f7f4dfd54b8d2030f674b8',
        label: 'Node joins the shared journal',
      },
    ],
    readerRoute: {
      intent: 'Understand the substrate',
      start: 'package.json',
      deepen: ['docs/README.md'],
    },
    amends: [],
    supersedes: [],
    file: 'docs/evolution/stages/polyglot-journal.md',
    ...overrides,
  };
}

test('parses exactly one typed record fence', () => {
  const value = parseEvolutionRecord(
    '# Era\n\n```json kungfu-evolution-era\n{"id":"journal-substrate"}\n```\n',
    'kungfu-evolution-era',
  );
  assert.equal(value.id, 'journal-substrate');
  assert.throws(
    () => parseEvolutionRecord('# missing', 'kungfu-evolution-era'),
    /exactly one/,
  );
});

test('builds deterministic timeline, authority, and route projections', () => {
  const projection = buildEvolutionMap(
    [era()],
    [stage()],
    contract,
    undefined,
    [candidate()],
  );
  assert.equal(projection.summary.eras, 1);
  assert.equal(projection.summary.stages, 1);
  assert.deepEqual(projection.currentAuthority, [
    {
      subject: 'execution-history',
      authority: 'yijinjing append-only journal',
      sinceStage: 'polyglot-journal',
      authorityRefs: ['package.json'],
    },
  ]);
  assert.match(renderTimeline(projection), /Polyglot journal/);
  assert.match(renderAuthority(projection), /yijinjing append-only journal/);
  assert.match(renderReaderRoutes(projection), /Understand the substrate/);
  assert.match(renderCandidates(projection), /Agent governance axis/);
  assert.equal(projection.summary.eras, 1);
  assert.equal(projection.summary.eraCandidates, 1);
  assert.equal(projection.currentAuthority.length, 1);
  assert.deepEqual(projection.eraCandidates[0].nextActions, [
    'append-evidence',
    'fold-back',
    'reject',
  ]);
});

test('a settled Stage may retire reader targets only through a later amendment', () => {
  const historical = stage({
    readerRoute: {
      intent: 'Understand the historical integration',
      start: 'missing-project-document.md',
      deepen: ['missing-project-route.md'],
    },
  });
  assert.throws(
    () => buildEvolutionMap([era()], [historical], contract),
    /without an explicit amendment/,
  );
  const amendment = stage({
    id: 'native-work-amendment',
    sequence: 2,
    buildsOn: [historical.id],
    amends: [historical.id],
    status: 'open',
    evolutionImpact: 'extends',
    readerRoute: {
      intent: 'Understand native work authority',
      start: 'package.json',
      deepen: ['docs/README.md'],
    },
    authorityTransitions: [
      {
        subject: 'execution-history',
        before: 'yijinjing append-only journal',
        after: 'native work authority',
        authorityRefs: ['package.json'],
      },
    ],
    file: 'docs/evolution/stages/native-work-amendment.md',
  });
  const projection = buildEvolutionMap(
    [era()],
    [historical, amendment],
    contract,
  );
  const routes = renderReaderRoutes(projection);
  assert.doesNotMatch(routes, /missing-project/);
  assert.match(routes, /docs\/README\.md/);
});

test('keeps candidate revisions outside canonical Era sequence and authority', () => {
  assert.throws(
    () =>
      buildEraCandidates(
        [candidate({ eraSequence: 2 })],
        contract,
        undefined,
        [era()],
        [stage()],
      ),
    /fields must be exactly/,
  );
  const projection = buildEvolutionMap(
    [era()],
    [stage()],
    contract,
    undefined,
    [candidate()],
  );
  assert.equal(projection.eras.length, 1);
  assert.equal(projection.stages.length, 1);
  assert.equal(projection.currentAuthority[0].sinceStage, 'polyglot-journal');
});

test('requires a contiguous content-addressed candidate lifecycle', () => {
  const first = candidate();
  const second = candidate({
    revision: 2,
    status: 'review-ready',
    previousRevisionRoot: candidateRevisionRoot(first),
    transition: {
      fromStatus: 'observed',
      reason: 'Independent evidence now supports review.',
    },
    evidence: [
      ...first.evidence,
      {
        kind: 'document',
        ref: 'package.json',
        label: 'Current contract evidence',
      },
    ],
    file: 'docs/evolution/candidates/agent-governance-axis/0002-2026-07-29.md',
  });
  assert.equal(
    buildEraCandidates(
      [first, second],
      contract,
      undefined,
      [era()],
      [stage()],
    )[0].latest.status,
    'review-ready',
  );
  assert.throws(
    () =>
      buildEraCandidates(
        [
          first,
          { ...second, previousRevisionRoot: `sha256:${'0'.repeat(64)}` },
        ],
        contract,
        undefined,
        [era()],
        [stage()],
      ),
    /previousRevisionRoot does not match/,
  );
  assert.throws(
    () =>
      buildEraCandidates(
        [first, { ...second, status: 'promoted' }],
        contract,
        undefined,
        [era()],
        [stage()],
      ),
    /cannot transition from observed to promoted/,
  );
  assert.throws(
    () =>
      buildEraCandidates(
        [
          candidate({
            file: 'docs/evolution/candidates/wrong/0001-2026-07-29.md',
          }),
        ],
        contract,
        undefined,
        [era()],
        [stage()],
      ),
    /must match candidate identity path/,
  );
  assert.throws(
    () =>
      buildEraCandidates(
        [
          candidate({
            evidence: [
              ...first.evidence,
              { ...first.evidence[0], label: 'Same source, new label' },
            ],
          }),
        ],
        contract,
        undefined,
        [era()],
        [stage()],
      ),
    /must not repeat a kind\/ref identity/,
  );
});

test('requires explicit authority and canonical links for promotion', () => {
  const first = candidate();
  const ready = candidate({
    revision: 2,
    status: 'review-ready',
    previousRevisionRoot: candidateRevisionRoot(first),
    transition: {
      fromStatus: 'observed',
      reason: 'Ready for maintainer review.',
    },
    evidence: [
      ...first.evidence,
      {
        kind: 'document',
        ref: 'package.json',
        label: 'Second exact reference',
      },
    ],
    file: 'docs/evolution/candidates/agent-governance-axis/0002-2026-07-29.md',
  });
  const promoted = candidate({
    ...ready,
    revision: 3,
    status: 'promoted',
    previousRevisionRoot: candidateRevisionRoot(ready),
    transition: {
      fromStatus: 'review-ready',
      reason: 'Promote by explicit decision.',
    },
    resolution: {
      kind: 'promoted',
      canonicalEra: 'journal-substrate',
      initialStage: 'polyglot-journal',
      foldedIntoStage: '',
      mergedIntoCandidate: '',
    },
    authorization: { kind: 'warrant', ref: `sha256:${'1'.repeat(64)}` },
    file: 'docs/evolution/candidates/agent-governance-axis/0003-2026-07-29.md',
  });
  assert.equal(
    buildEraCandidates(
      [first, ready, promoted],
      contract,
      undefined,
      [era()],
      [stage()],
    )[0].latest.status,
    'promoted',
  );
  assert.throws(
    () =>
      buildEraCandidates(
        [first, ready, { ...promoted, authorization: { kind: '', ref: '' } }],
        contract,
        undefined,
        [era()],
        [stage()],
      ),
    /promotion requires maintainer or Warrant authorization/,
  );
});

test('rejects editing or deleting protected candidate revisions', () => {
  assert.deepEqual(
    findHistoricalMutationViolations(
      [
        'M\tdocs/evolution/candidates/agent-governance-axis/0001-2026-07-29.md',
        'D\tdocs/evolution/stages/01-polyglot-journal.md',
        'A\tdocs/evolution/candidates/agent-governance-axis/0002-2026-07-30.md',
      ],
      () => true,
    ),
    [
      'docs/evolution/candidates/agent-governance-axis/0001-2026-07-29.md is immutable candidate history; append a new candidate revision instead of editing it',
      'docs/evolution/stages/01-polyglot-journal.md is settled history; add an amendment or successor Stage instead of deleting it',
    ],
  );
});

test('rejects dangling dependencies and discontinuous authority transitions', () => {
  assert.throws(
    () =>
      buildEvolutionMap([era()], [stage({ buildsOn: ['missing'] })], contract),
    /dangling or forward buildsOn/,
  );
  const second = stage({
    id: 'fact-ledger',
    sequence: 2,
    buildsOn: ['polyglot-journal'],
    authorityTransitions: [
      {
        subject: 'execution-history',
        before: 'a different authority',
        after: 'fact ledger',
        authorityRefs: ['package.json'],
      },
    ],
  });
  assert.throws(
    () => buildEvolutionMap([era()], [stage(), second], contract),
    /expected before=yijinjing append-only journal/,
  );
});

test('rejects duplicate identities and forward era dependencies', () => {
  assert.throws(
    () => buildEvolutionMap([era(), era()], [stage()], contract),
    /duplicate era id/,
  );
  assert.throws(
    () =>
      buildEvolutionMap(
        [era({ buildsOn: ['future-era'] })],
        [stage()],
        contract,
      ),
    /dangling or forward buildsOn/,
  );
});

test('requires authored Evolution Map mentions to be navigable', () => {
  assert.deepEqual(
    findUnlinkedEvolutionMapMentions([
      {
        file: 'README.md',
        text: '[Evolution Map](docs/evolution/README.md)\n',
      },
      {
        file: 'docs/evolution/README.md',
        text: '# Kungfu Evolution Map\n\nThe Evolution Map is this page.\n',
      },
      {
        file: 'docs/adr/example.md',
        text: '# ADR: Evolution Map\n\n```sh\nextend evolution map\n```\n',
      },
    ]),
    [],
  );
  assert.deepEqual(
    findUnlinkedEvolutionMapMentions([
      { file: 'CONTRIBUTING.md', text: 'Read the Evolution Map first.\n' },
    ]),
    ['CONTRIBUTING.md:1'],
  );
});

test('plans an immutable opening candidate revision without writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-era-candidate-'));
  temporaryRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  const plan = planCandidate(candidateOpenInput(), candidateSource(root));
  assert.equal(plan.revision, 1);
  assert.equal(plan.sharedWrites.length, 0);
  assert.equal(fs.existsSync(path.join(root, plan.file)), false);
  assert.match(plan.content, /kungfu-evolution-era-candidate/);
});

test('writes candidate revisions exclusively and rejects stale advancement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-era-candidate-'));
  temporaryRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  const firstPlan = planCandidate(candidateOpenInput(), candidateSource(root));
  writeCandidate(root, firstPlan);
  assert.throws(() => writeCandidate(root, firstPlan), /already exists/);
  const first = JSON.parse(
    firstPlan.content.match(
      /```json kungfu-evolution-era-candidate\n([\s\S]*?)\n```/,
    )[1],
  );
  first.file = firstPlan.file;
  assert.throws(
    () =>
      planCandidate(
        {
          operation: 'advance',
          id: first.id,
          recordedAt: '2026-07-30',
          expectedPreviousRoot: `sha256:${'0'.repeat(64)}`,
          status: 'accumulating',
          reason: 'Add evidence.',
        },
        candidateSource(root, [first]),
      ),
    /stale candidate revision/,
  );
});
