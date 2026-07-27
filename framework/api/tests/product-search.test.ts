// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ProductSearchDocument,
  SYSTEM_HELP_DOCUMENTS,
  cliHelpSearchDocuments,
  loadCliHelpSearchDocuments,
  parseCliHelpProjection,
  searchProductDocuments,
} from '../src/capability/product-search.ts';

const projection = {
  schema: 'kungfu.cli-help-projection/v1' as const,
  sections: [
    {
      id: 'start-here',
      title: 'START HERE',
      summary: 'Open the product and inspect readiness.',
    },
  ],
  commands: [
    {
      id: 'kungfu.agent',
      name: 'agent',
      path: 'kungfu agent',
      summary: 'Agent-facing local discovery entrypoint.',
      section: 'start-here',
      priority: 2,
      availability: { state: 'available' },
    },
  ],
};

test('parses the governed CLI help projection and rejects another schema', () => {
  assert.deepEqual(
    parseCliHelpProjection(JSON.stringify(projection)),
    projection,
  );
  assert.throws(
    () =>
      parseCliHelpProjection('{"schema":"other","sections":[],"commands":[]}'),
    /invalid help projection/,
  );
});

test('projects help sections and commands without inventing execution authority', () => {
  const documents = cliHelpSearchDocuments(projection);
  assert.deepEqual(
    documents.map((row) => [row.kind, row.title, row.action.kind]),
    [
      ['help', 'START HERE', 'show-help'],
      ['command', 'kungfu agent', 'describe-command'],
    ],
  );
});

test('loads CLI help through the injected read-only process boundary', async () => {
  const calls: unknown[] = [];
  const documents = await loadCliHelpSearchDocuments({
    bin: '/opt/kungfu',
    env: { KF_HOME: '/tmp/home' },
    execFile: async (...args) => {
      calls.push(args);
      return JSON.stringify(projection);
    },
  });
  assert.equal(documents[1]?.title, 'kungfu agent');
  assert.deepEqual(calls[0], [
    '/opt/kungfu',
    ['--help-json'],
    {
      encoding: 'utf8',
      env: { KF_HOME: '/tmp/home' },
      maxBuffer: 4 * 1024 * 1024,
    },
  ]);
});

test('searches help, commands, Work, and views with deterministic ranking', () => {
  const work: ProductSearchDocument = {
    id: 'work.assignment-7',
    kind: 'work',
    title: 'Improve terminal search',
    summary: 'Assignment stage is executing.',
    keywords: ['assignment-7'],
    action: { kind: 'open-work', workId: 'assignment-7' },
  };
  const view: ProductSearchDocument = {
    id: 'view.work-dashboard',
    kind: 'view',
    title: 'Work Dashboard',
    summary: 'Open the Work view.',
    action: { kind: 'open-view', viewId: 'work-dashboard' },
  };
  const documents = [
    ...SYSTEM_HELP_DOCUMENTS,
    ...cliHelpSearchDocuments(projection),
    work,
    view,
  ];
  assert.equal(
    searchProductDocuments(documents, 'terminal search')[0]?.id,
    work.id,
  );
  assert.equal(
    searchProductDocuments(documents, 'agent discovery')[0]?.title,
    'kungfu agent',
  );
  assert.equal(
    searchProductDocuments(documents, 'keyboard shortcut')[0]?.id,
    'help.keyboard',
  );
  assert.deepEqual(
    searchProductDocuments([work, work], 'improve').map((row) => row.id),
    [work.id],
  );
});
