// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const ROOT = process.cwd();
const contract = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'framework/work/action/action-canonical-json-v1.json'),
    'utf8',
  ),
);
const corpus = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/canonical-json/vectors.json'),
    'utf8',
  ),
);

test('canonical JSON contract names each distinct identity protocol', () => {
  assert.equal(
    corpus.contract,
    'framework/work/action/action-canonical-json-v1.json',
  );
  assert.deepEqual(
    contract.protocols.map((profile) => profile.id),
    Object.keys(corpus.profiles),
  );
  assert.match(contract.protocols[0].unicodeNormalization, /NFC and NFD/);
  assert.match(contract.protocols[1].purpose, /Python payload/);
  assert.match(contract.protocols[2].unicodeNormalization, /NFC required/);
  assert.ok(corpus.profiles['kungfu.action.canonical-json/v1'].rejected.length);
  assert.ok(
    corpus.profiles['kungfu.python-identity.canonical-json/v1'].rejected.length,
  );
  assert.ok(
    corpus.profiles['kungfu.workspace.canonical-json/v1'].rejected.length,
  );
});

test('Python replays every language-neutral canonical JSON vector', () => {
  const program = String.raw`
import json, sys
from kungfu.canonical_json import CanonicalJsonError, canonical_json_text
corpus = json.load(open(sys.argv[1], encoding="utf-8"))
rows = []
def value(vector):
    special = vector.get("specialFloat")
    if special == "nan":
        return float("nan")
    if special == "positive-infinity":
        return float("inf")
    return vector["value"]
for protocol, profile in corpus["profiles"].items():
    for vector in profile["accepted"]:
        rows.append({"id": vector["id"], "protocol": protocol, "accepted": True, "canonical": canonical_json_text(value(vector), protocol=protocol)})
    for vector in profile["rejected"]:
        try:
            canonical_json_text(value(vector), protocol=protocol)
            rows.append({"id": vector["id"], "protocol": protocol, "accepted": True})
        except CanonicalJsonError as error:
            rows.append({"id": vector["id"], "protocol": protocol, "accepted": False, "failureCode": error.code})
json.dump(rows, sys.stdout, separators=(",", ":"))
`;
  const result = spawnSync(
    'python3',
    [
      '-c',
      program,
      path.join(ROOT, 'tests/fixtures/canonical-json/vectors.json'),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PYTHONPATH: path.join(ROOT, 'framework/core/src/python'),
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const actual = JSON.parse(result.stdout);
  const expected = [];
  for (const [protocol, profile] of Object.entries(corpus.profiles)) {
    for (const vector of profile.accepted) {
      expected.push({
        id: vector.id,
        protocol,
        accepted: true,
        canonical: vector.canonical,
      });
    }
    for (const vector of profile.rejected) {
      expected.push({
        id: vector.id,
        protocol,
        accepted: false,
        failureCode: vector.failureCode,
      });
    }
  }
  assert.deepEqual(actual, expected);
});
