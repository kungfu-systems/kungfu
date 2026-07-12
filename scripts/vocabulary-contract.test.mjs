// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  validateVocabularyContract,
  writeValeProjection,
} from './vocabulary-contract.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-vocabulary-contract-'),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'vocabulary.md'),
    '# Vocabulary\n\n## Flagship object\n\n### Episode\n\n## Operations\n\n### Rewind\n\n## Domain profiles\n',
  );
  fs.writeFileSync(path.join(root, 'README.md'), '# Home\n');
  return root;
}

function registry() {
  return {
    schemaVersion: 1,
    canonicalReference: 'docs/vocabulary.md',
    layers: [
      {
        id: 'flagship',
        heading: 'Flagship object',
        terms: [{ name: 'Episode', caseForms: ['Episode', 'Episodes'] }],
      },
      {
        id: 'operations',
        heading: 'Operations',
        terms: [{ name: 'Rewind' }],
      },
    ],
    domainProfiles: [],
    prosePolicy: {
      roots: ['README.md', 'docs'],
      retiredPhrases: [
        {
          id: 'old-positioning',
          text: 'old positioning',
          level: 'error',
          promotion: {
            status: 'required',
            negativeFixture: true,
            baselineFindings: 0,
          },
          message: 'Use the Episode-centered positioning.',
        },
      ],
      preferredTerms: [
        {
          id: 'trustreport-spelling',
          pattern: '\\b[Tt]rust[ -][Rr]eport\\b',
          replacement: 'TrustReport',
          level: 'warning',
          promotion: {
            status: 'advisory',
            negativeFixture: false,
            baselineFindings: 0,
          },
        },
      ],
      claimGuards: [
        {
          id: 'absolute-crash-safe',
          pattern: '(?i)\\bKungfu is crash-safe\\b',
          level: 'warning',
          promotion: {
            status: 'advisory',
            negativeFixture: false,
            baselineFindings: 0,
          },
          message: 'Name the qualified profile.',
        },
      ],
    },
  };
}

test('accepts a registry aligned with the public vocabulary reference', () => {
  const root = fixture();
  assert.deepEqual(
    validateVocabularyContract({ root, registry: registry() }),
    [],
  );
});

test('rejects canonical heading drift', () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, 'docs', 'vocabulary.md'),
    '# Vocabulary\n\n## Flagship object\n\n### Run\n\n## Operations\n\n### Rewind\n\n## Domain profiles\n',
  );
  const findings = validateVocabularyContract({ root, registry: registry() });
  assert.ok(
    findings.some((finding) => finding.code === 'vocabulary-reference-drift'),
  );
});

test('rejects duplicate canonical terms and missing governed roots', () => {
  const root = fixture();
  const value = registry();
  value.layers[1].terms.push({ name: 'Episode' });
  value.prosePolicy.roots.push('missing-docs');
  value.prosePolicy.roots.push('../outside');
  const findings = validateVocabularyContract({ root, registry: value });
  assert.ok(
    findings.some((finding) => finding.code === 'vocabulary-duplicate'),
  );
  assert.ok(findings.some((finding) => finding.code === 'prose-policy-root'));
});

test('projects canonical terms and prose rules into disposable Vale styles', () => {
  const root = fixture();
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-vale-projection-'),
  );
  roots.push(destination);
  const projection = writeValeProjection(destination, {
    root,
    registry: registry(),
    minAlertLevel: 'error',
  });
  assert.equal(projection.files.length, 2);
  assert.match(
    fs.readFileSync(projection.config, 'utf8'),
    /MinAlertLevel = error/,
  );
  assert.equal(
    fs.readFileSync(
      path.join(
        destination,
        'styles',
        'config',
        'vocabularies',
        'Kungfu',
        'accept.txt',
      ),
      'utf8',
    ),
    'Episode\nEpisodes\n',
  );
  assert.match(
    fs.readFileSync(
      path.join(destination, 'styles', 'Kungfu', 'RetiredPhrase1.yml'),
      'utf8',
    ),
    /old positioning/,
  );
  assert.match(
    fs.readFileSync(
      path.join(destination, 'styles', 'Kungfu', 'ClaimGuard1.yml'),
      'utf8',
    ),
    /crash-safe/,
  );
});
