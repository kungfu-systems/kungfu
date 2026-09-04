// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  evaluateDeprecationEnrollment,
  validateDiscoveryContract,
} from './deprecation-surface-discovery.mjs';

const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, 'deprecation-discovery.contract.json'),
    'utf8',
  ),
);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-deprecation-discovery-'),
  );
  roots.push(root);
  const contract = structuredClone(CONTRACT);
  for (const dialect of contract.dialects) {
    if (dialect.kind === 'text') dialect.roots = ['src'];
    if (dialect.kind === 'document') dialect.roots = ['docs'];
  }
  contract.structuredSources = [
    {
      dialect: 'cli-structured-compatibility',
      match: 'exact',
      path: 'structured/cli.json',
      pointer: '/aliases',
      mode: 'array-records',
    },
    {
      dialect: 'kfx-structured-compatibility',
      match: 'basename',
      roots: ['extensions'],
      basename: 'kungfu.kfx.json',
      pointer: '/deprecation',
      mode: 'optional-record',
    },
    {
      dialect: 'artifact-structured-compatibility',
      match: 'suffix',
      roots: ['artifacts'],
      suffix: '.artifact.json',
      pointer: '/deprecation',
      mode: 'optional-record',
    },
  ];
  contract.exclusions = [
    {
      classification: 'generated-code',
      match: 'prefix',
      path: 'src/api/capability/generated/',
      dialects: ['js-ts-jsdoc'],
      reason: 'Fixture generated source.',
    },
    {
      classification: 'historical-evidence',
      match: 'exact',
      path: 'docs/history.md',
      dialects: ['document-frontmatter'],
      reason: 'Fixture historical evidence.',
    },
  ];

  const sources = [
    [
      'src/api.h',
      '[[deprecated("kungfu-deprecation:test.surface#cpp")]] void old_api();\n',
      'cpp-deprecated-attribute',
      'cpp',
    ],
    [
      'src/api.py',
      'warnings.warn("kungfu-deprecation:test.surface#python", DeprecationWarning)\n',
      'python-deprecation-warning',
      'python',
    ],
    [
      'src/api.ts',
      '/**\\n * @deprecated kungfu-deprecation:test.surface#js-ts\\n */\\nexport const oldApi = 1;\\n'.replaceAll(
        '\\n',
        '\n',
      ),
      'js-ts-jsdoc',
      'js-ts',
    ],
    [
      'src/api.proto',
      'option deprecated = true; // kungfu-deprecation:test.surface#proto\n',
      'persisted-schema-protocol',
      'proto',
    ],
    [
      'src/api.fbs',
      'old_field:int (deprecated); // kungfu-deprecation:test.surface#flatbuffers\n',
      'persisted-schema-protocol',
      'flatbuffers',
    ],
    [
      'docs/live.md',
      '---\ndocument_status: deprecated\ndeprecation_entry: test.surface\ndeprecation_marker: document\n---\n',
      'document-frontmatter',
      'document',
    ],
    [
      'structured/cli.json',
      JSON.stringify({
        aliases: [
          {
            deprecationEntry: 'test.surface',
            deprecationMarker: 'cli',
          },
        ],
      }),
      'cli-structured-compatibility',
      'cli',
    ],
    [
      'extensions/demo/kungfu.kfx.json',
      JSON.stringify({
        deprecation: {
          deprecationEntry: 'test.surface',
          deprecationMarker: 'kfx',
        },
      }),
      'kfx-structured-compatibility',
      'kfx',
    ],
    [
      'artifacts/release.artifact.json',
      JSON.stringify({
        deprecation: {
          deprecationEntry: 'test.surface',
          deprecationMarker: 'artifact',
        },
      }),
      'artifact-structured-compatibility',
      'artifact',
    ],
  ];
  for (const [relative, value] of sources) write(root, relative, value);
  write(
    root,
    'src/api/capability/generated/reflection.ts',
    '/**\\n * @deprecated generated vocabulary\\n */\\n'.replaceAll(
      '\\n',
      '\n',
    ),
  );
  write(root, 'docs/history.md', '---\ndocument_status: deprecated\n---\n');
  const registry = {
    entries: [
      {
        id: 'test.surface',
        lifecycle: 'deprecated',
        surface: {
          markers: sources.map(([relative, , dialect, id]) => ({
            id,
            dialect,
            path: relative,
          })),
        },
      },
      {
        id: 'test.settled',
        lifecycle: 'settled',
        surface: { markers: [] },
      },
    ],
  };
  return { root, contract, registry };
}

test('discovers and exactly enrolls every supported live dialect', () => {
  const result = evaluateDeprecationEnrollment(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.inventory.readOnly, true);
  assert.equal(result.inventory.scope, 'full');
  assert.equal(result.inventory.live.length, 9);
  assert.deepEqual(
    new Set(result.inventory.live.map((marker) => marker.dialect)),
    new Set(CONTRACT.dialects.map((dialect) => dialect.id)),
  );
  assert.equal(result.inventory.classifications.generatedCode.length, 1);
  assert.equal(result.inventory.classifications.historicalEvidence.length, 1);
  assert.deepEqual(result.inventory.settled, [
    {
      entryId: 'test.settled',
      lifecycle: 'settled',
      surfaceClass: undefined,
    },
  ]);
});

test('changed scope fails a new marker even when the registry is untouched', () => {
  const values = fixture();
  write(
    values.root,
    'src/new.py',
    'warnings.warn("new compatibility path", DeprecationWarning)\n',
  );
  const result = evaluateDeprecationEnrollment({
    ...values,
    changedFiles: ['src/new.py'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.inventory.scope, 'changed');
  assert.ok(
    result.findings.some(
      (finding) => finding.code === 'deprecation-orphan-marker',
    ),
  );
  assert.ok(
    !result.findings.some(
      (finding) => finding.code === 'deprecation-missing-surface',
    ),
  );
});

test('full scope rejects duplicate bindings and renamed or missing surfaces', () => {
  const duplicate = fixture();
  write(
    duplicate.root,
    'src/duplicate.h',
    '[[deprecated("kungfu-deprecation:test.surface#cpp")]] void duplicate();\n',
  );
  const duplicated = evaluateDeprecationEnrollment(duplicate);
  assert.equal(duplicated.ok, false);
  assert.ok(
    duplicated.findings.some(
      (finding) => finding.code === 'deprecation-duplicate-marker',
    ),
  );

  const missing = fixture();
  fs.renameSync(
    path.join(missing.root, 'src/api.h'),
    path.join(missing.root, 'src/renamed.h'),
  );
  const renamed = evaluateDeprecationEnrollment(missing);
  assert.equal(renamed.ok, false);
  assert.ok(
    renamed.findings.some(
      (finding) => finding.code === 'deprecation-missing-surface',
    ),
  );
});

test('unknown dialects and broad exclusions fail closed', () => {
  const unknown = structuredClone(CONTRACT);
  unknown.dialects.push({
    id: 'unreviewed-language-marker',
    kind: 'text',
    roots: ['src'],
    extensions: ['.unknown'],
  });
  assert.ok(
    validateDiscoveryContract(unknown).findings.some((finding) =>
      finding.message.includes('unknown detector dialect'),
    ),
  );

  const broad = structuredClone(CONTRACT);
  broad.exclusions.push({
    classification: 'generated-code',
    match: 'prefix',
    path: 'framework/',
    dialects: ['js-ts-jsdoc'],
    reason: 'Too broad.',
  });
  assert.ok(
    validateDiscoveryContract(broad).findings.some((finding) =>
      finding.message.includes('narrow generated subtree'),
    ),
  );
});

test('structured markers without exact entry and marker fields are orphans', () => {
  const values = fixture();
  write(
    values.root,
    'artifacts/unbound.artifact.json',
    JSON.stringify({ deprecation: { reason: 'compatibility' } }),
  );
  const result = evaluateDeprecationEnrollment(values);
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === 'deprecation-orphan-marker' &&
        finding.message.includes('unbound.artifact.json'),
    ),
  );
});
