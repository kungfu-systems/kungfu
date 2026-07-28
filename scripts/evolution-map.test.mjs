// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildEvolutionMap,
  findUnlinkedEvolutionMapMentions,
  parseEvolutionRecord,
  renderAuthority,
  renderReaderRoutes,
  renderTimeline,
} from './evolution-map/index.mjs';

const contract = {
  eraSchema: 'kungfu.evolution-era/v1',
  stageSchema: 'kungfu.evolution-stage/v1',
  projectionSchema: 'kungfu.evolution-map-projection/v1',
  stageStatuses: ['open', 'settled'],
  evolutionImpacts: ['none', 'extends', 'opens', 'settles', 'supersedes'],
  evidenceKinds: ['pull-request', 'commit', 'adr', 'document'],
};

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
  const projection = buildEvolutionMap([era()], [stage()], contract);
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
