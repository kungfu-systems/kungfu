// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const ROOT = process.cwd();
const protocol = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'framework/fact/kungfu-fact-root-canonical-v2.json'),
    'utf8',
  ),
);
const corpus = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/fact-root-canonical/vectors.json'),
    'utf8',
  ),
);

function runIndependentPython() {
  const program = String.raw`
import json, sys
from kungfu.storage.fact_root_canonical import CanonicalEncodingError, canonical_bytes, canonical_root
corpus = json.load(sys.stdin)
result = []
for vector in corpus["accepted"] + corpus["rejected"]:
    try:
        result.append({"id": vector["id"], "accepted": True, "canonicalBytesHex": canonical_bytes(vector["value"]).hex(), "root": canonical_root(vector["value"])})
    except CanonicalEncodingError as error:
        result.append({"id": vector["id"], "accepted": False, "failureCode": error.code})
json.dump(result, sys.stdout, separators=(",", ":"))
`;
  const pythonPath = [
    path.join(ROOT, 'framework', 'core', 'src', 'python'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const result = spawnSync(
    'uv',
    ['run', '--project', 'framework/core', '--frozen', 'python', '-c', program],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: pythonPath },
      input: JSON.stringify(corpus),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('KFR2 freezes a library-independent closed typed protocol', () => {
  assert.equal(protocol.protocol.id, corpus.protocol);
  assert.equal(protocol.protocol.magicHex, '4b465232');
  assert.equal(protocol.protocol.libraryIndependent, true);
  assert.equal(protocol.protocol.storageIndependent, true);
  assert.equal(
    protocol.valueSemantics.unknownFields,
    'rejected before root generation',
  );
  assert.match(protocol.protocol.normalization, /NFC and NFD are distinct/);
  assert.equal(protocol.migration.legacyRead, 'required');
  assert.equal(protocol.migration.legacyRewrite, 'forbidden');
  assert.deepEqual(protocol.conformance.implementations, [
    'libkungfu-cpp',
    'independent-python',
  ]);
  const schemas = new Map(
    protocol.schemas.map((schema) => [schema.id, schema]),
  );
  assert.equal(schemas.size, protocol.schemas.length);
  for (const schema of protocol.schemas) {
    const fieldIds = schema.fields.map((field) => field.id);
    assert.deepEqual(
      fieldIds,
      [...fieldIds].sort((left, right) => left - right),
    );
    assert.equal(new Set(fieldIds).size, fieldIds.length);
  }
});

test('the independent Python implementation reproduces every byte and rejection', () => {
  const results = new Map(runIndependentPython().map((row) => [row.id, row]));
  assert.equal(results.size, corpus.accepted.length + corpus.rejected.length);
  for (const vector of corpus.accepted) {
    const result = results.get(vector.id);
    assert.equal(result?.accepted, true, vector.id);
    assert.equal(
      result?.canonicalBytesHex,
      vector.canonicalBytesHex,
      vector.id,
    );
    assert.equal(result?.root, vector.root, vector.id);
  }
  for (const vector of corpus.rejected) {
    const result = results.get(vector.id);
    assert.equal(result?.accepted, false, vector.id);
    assert.equal(result?.failureCode, vector.failureCode, vector.id);
  }
});

test('the C++ authority exposes KFR2 without redefining the legacy writer protocol', () => {
  const source = [
    'fact_kernel_internal.h',
    'fact_protocol.cpp',
    'fact_query.cpp',
    'fact_kernel.cpp',
  ]
    .map((file) =>
      fs.readFileSync(
        path.join(
          ROOT,
          'framework/core/src/libkungfu/src/runtime/storage',
          file,
        ),
        'utf8',
      ),
    )
    .join('\n');
  assert.match(
    source,
    /PORTABLE_ROOT_PROTOCOL = "kungfu\.fact-root\.canonical\/v2"/,
  );
  assert.match(source, /ROOT_PROTOCOL = "sha256-length-framed-fields-v1"/);
  assert.match(
    source,
    /action_registration\{"canonical-root", action_route::canonical_root\}/,
  );
  assert.match(source, /case action_route::canonical_root/);
  assert.match(source, /canonical_bytes_hex/);
  assert.match(source, /legacy-reader-internal-only/);
  assert.match(source, /writer_default", true/);
  assert.match(source, /writer_default", false/);
});

test('the corpus carries the adversarial cross-language boundary cases', () => {
  const ids = new Set(
    [...corpus.accepted, ...corpus.rejected].map((vector) => vector.id),
  );
  for (const id of [
    'uint64-over-js-safe-integer',
    'positive-zero',
    'negative-zero',
    'nan',
    'positive-infinity',
    'unicode-composed',
    'unicode-decomposed',
    'lone-surrogate-utf8',
    'unknown-record-field',
    'duplicate-set-item',
    'duplicate-map-key',
    'mapping-receipt-keeps-both-roots',
  ])
    assert.equal(ids.has(id), true, id);
  assert.notEqual(
    corpus.accepted.find((row) => row.id === 'positive-zero').root,
    corpus.accepted.find((row) => row.id === 'negative-zero').root,
  );
  assert.notEqual(
    corpus.accepted.find((row) => row.id === 'unicode-composed').root,
    corpus.accepted.find((row) => row.id === 'unicode-decomposed').root,
  );
});
