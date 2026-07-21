// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  XINFA_ROOT,
  canonicalJson,
  validateSchemaSet,
} from './check-schema-set.mjs';

function manifest() {
  return JSON.parse(
    fs.readFileSync(
      path.join(XINFA_ROOT, 'schema-set-manifest-v1.json'),
      'utf8',
    ),
  );
}

test('canonical JSON sorts every object by UTF-8 bytes', () => {
  assert.equal(
    canonicalJson({ z: 0, ä: 1, a: { y: 2, b: 3 } }),
    '{"a":{"b":3,"y":2},"z":0,"ä":1}',
  );
});

test('published schema-set manifest closes every schema and the Atlas golden', () => {
  assert.deepEqual(validateSchemaSet(), []);
});

test('schema byte drift fails without rewriting the manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xinfa-schema-set-'));
  try {
    fs.cpSync(XINFA_ROOT, root, { recursive: true });
    fs.appendFileSync(path.join(root, manifest().members[0].path), '\n');
    assert.ok(
      validateSchemaSet(root).some((finding) =>
        finding.includes('byte digest drifted'),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unlisted schema and a changed Atlas root both fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xinfa-schema-set-'));
  try {
    fs.cpSync(XINFA_ROOT, root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'schema', 'unlisted-v1.schema.json'),
      '{"$id":"https://xinfa.dev/schema/unlisted-v1.schema.json"}\n',
    );
    const value = manifest();
    value.rootSets[0].root = `sha256:${'0'.repeat(64)}`;
    const findings = validateSchemaSet(root, value);
    assert.ok(
      findings.includes(
        'members must list every schema path in UTF-8 byte order',
      ),
    );
    assert.ok(findings.includes('xinfa.atlas-schema-set/v1: root drifted'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
