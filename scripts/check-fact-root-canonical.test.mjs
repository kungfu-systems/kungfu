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
const writerAuthority = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'framework/fact/kungfu-fact-writer-authority-v2.json'),
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
from kungfu.storage.fact_root_canonical import CanonicalEncodingError, _SCHEMA_FIELDS, _SCHEMA_OPTIONAL_FIELDS, canonical_bytes, canonical_root
corpus = json.load(sys.stdin)
result = []
for vector in corpus["accepted"] + corpus["rejected"]:
    try:
        result.append({"id": vector["id"], "accepted": True, "canonicalBytesHex": canonical_bytes(vector["value"]).hex(), "root": canonical_root(vector["value"])})
    except CanonicalEncodingError as error:
        result.append({"id": vector["id"], "accepted": False, "failureCode": error.code})
json.dump({"vectors": result, "schemaFields": {key: list(value) for key, value in _SCHEMA_FIELDS.items()}, "optionalFields": {key: sorted(value) for key, value in _SCHEMA_OPTIONAL_FIELDS.items()}}, sys.stdout, separators=(",", ":"))
`;
  const pythonPath = [
    path.join(ROOT, 'framework', 'core', 'src', 'python'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const candidates = [
    process.env.PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python',
  ].filter(
    (candidate, index, all) => candidate && all.indexOf(candidate) === index,
  );
  const diagnostics = [];
  let python;
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (probe.status === 0) {
      python = candidate;
      break;
    }
    diagnostics.push(
      `${candidate}: ${probe.error?.message || probe.stderr || `exit ${probe.status}`}`,
    );
  }
  assert.ok(
    python,
    `a Python 3 interpreter is required for the independent KFR2 projection (${diagnostics.join('; ')})`,
  );
  const result = spawnSync(python, ['-c', program], {
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: pythonPath },
    input: JSON.stringify(corpus),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

function parseCppMap(source, name, valuePattern, convert = (value) => value) {
  const match = source.match(new RegExp(`${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `${name} initializer is required`);
  const result = new Map();
  for (const entry of match[1].matchAll(/\{"([^"]+)",\s*\{([^}]*)\}\}/g)) {
    result.set(
      entry[1],
      [...entry[2].matchAll(valuePattern)].map((row) => convert(row[1])),
    );
  }
  return result;
}

function mapObject(map) {
  return Object.fromEntries([...map.entries()]);
}

function parseCppSchemaRegistry(source) {
  const initializer = source.match(
    /PORTABLE_RECORD_SCHEMAS = \{([\s\S]*?)\n\};/,
  );
  assert.ok(initializer, 'PORTABLE_RECORD_SCHEMAS initializer is required');
  const starts = [...initializer[1].matchAll(/\{"([^"]+)",\s*\{/g)];
  const fields = new Map();
  const names = new Map();
  const optional = new Map();
  for (let index = 0; index < starts.length; ++index) {
    const entry = initializer[1].slice(
      starts[index].index,
      starts[index + 1]?.index,
    );
    const schema = starts[index][1];
    const rows = [
      ...entry.matchAll(/\{(\d+),\s*"([^"]+)"(?:,\s*(true|false))?\}/g),
    ];
    fields.set(
      schema,
      rows.map((row) => Number(row[1])),
    );
    names.set(schema, Object.fromEntries(rows.map((row) => [row[1], row[2]])));
    const optionalIds = rows
      .filter((row) => row[3] === 'true')
      .map((row) => Number(row[1]));
    if (optionalIds.length > 0) optional.set(schema, optionalIds);
  }
  return { fields, names, optional };
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
  const results = new Map(
    runIndependentPython().vectors.map((row) => [row.id, row]),
  );
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

test('the machine registry welds ordered C++ and Python schema projections', () => {
  const cpp = fs.readFileSync(
    path.join(
      ROOT,
      'framework/core/src/libkungfu/src/runtime/storage/fact_protocol.cpp',
    ),
    'utf8',
  );
  const registry = parseCppSchemaRegistry(cpp);
  const python = runIndependentPython();
  const contractFields = Object.fromEntries(
    protocol.schemas.map((schema) => [
      schema.id,
      schema.fields.map((field) => field.id),
    ]),
  );
  const contractOptional = Object.fromEntries(
    protocol.schemas
      .map((schema) => [
        schema.id,
        schema.fields
          .filter((field) => field.optional === true)
          .map((field) => field.id),
      ])
      .filter(([, fields]) => fields.length > 0),
  );

  const contractNames = Object.fromEntries(
    protocol.schemas.map((schema) => [
      schema.id,
      Object.fromEntries(
        schema.fields.map((field) => [
          String(field.id),
          field.name === 'mappingReceiptRoot'
            ? 'mapping_receipt_root'
            : field.name,
        ]),
      ),
    ]),
  );

  assert.deepEqual(mapObject(registry.fields), contractFields);
  assert.deepEqual(mapObject(registry.names), contractNames);
  assert.deepEqual(python.schemaFields, contractFields);
  assert.deepEqual(mapObject(registry.optional), contractOptional);
  assert.deepEqual(python.optionalFields, contractOptional);
  assert.doesNotMatch(cpp, /PORTABLE_RECORD_FIELDS\s*=/);
  assert.doesNotMatch(cpp, /PORTABLE_RECORD_FIELD_NAMES\s*=/);
  assert.doesNotMatch(cpp, /PORTABLE_OPTIONAL_RECORD_FIELDS\s*=/);
  assert.equal(protocol.schemaRegistry.requiredByDefault, true);
});

test('Fact mutation requests have an exact closed-field projection', () => {
  const actionsSource = fs.readFileSync(
    path.join(
      ROOT,
      'framework/core/src/libkungfu/src/runtime/storage/fact_actions.cpp',
    ),
    'utf8',
  );
  const commitSource = fs.readFileSync(
    path.join(
      ROOT,
      'framework/core/src/libkungfu/src/runtime/storage/fact_commit.cpp',
    ),
    'utf8',
  );
  const cppRequests = parseCppMap(
    actionsSource,
    'MUTATION_REQUEST_FIELDS',
    /"([^"]+)"/g,
  );
  const contractRequests = Object.fromEntries(
    protocol.operationRequests.actions.map((action) => [
      action.id,
      action.fields,
    ]),
  );
  assert.deepEqual(mapObject(cppRequests), contractRequests);
  assert.match(actionsSource, /validate_closed_fields\(input, schema->second/);
  assert.match(
    actionsSource,
    /validate_closed_fields\(member, \{"object_id", "version_root"\}/,
  );
  assert.match(
    actionsSource,
    /validate_closed_fields\(entry, \{"episode_id", "sealed_content_root", "accepted_manifest_frame_uid"\}/,
  );
  assert.match(
    commitSource,
    /const auto admitted_input = apply_default_durable_ref_cas_admission\(input\)/,
  );
  assert.match(
    commitSource,
    /parse_mutation_request\(admitted_input, requested_action\)/,
  );
  assert.match(
    commitSource,
    /handle_mutation\(runtime_dir, state, request, root_protocol\)/,
  );
  assert.match(commitSource, /append_record_with_receipt/);
  assert.match(protocol.operationRequests.policy, /closed mutation request/);
});

test('the C++ authority exposes KFR2 as writer and retains the exact legacy reader', () => {
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
  assert.match(
    source,
    /LEGACY_ROOT_PROTOCOL = "sha256-length-framed-fields-v1"/,
  );
  assert.match(source, /WRITER_ROOT_PROTOCOL = PORTABLE_ROOT_PROTOCOL/);
  assert.match(
    source,
    /action_registration\{"canonical-root", action_route::canonical_root\}/,
  );
  assert.match(source, /case action_route::canonical_root/);
  assert.match(source, /canonical_bytes_hex/);
  assert.match(source, /required-legacy-reader/);
  assert.match(source, /authoritative-writer/);
  assert.match(source, /mapping_receipt/);
  assert.match(source, /downgrade_write", "fail-closed/);
});

test('the writer authority passport welds migration, rollback and exact candidate gates', () => {
  assert.equal(writerAuthority.schema, 'kungfu.fact-writer-authority/v2');
  assert.equal(
    writerAuthority.writer.rootProtocol,
    'kungfu.fact-root.canonical/v2',
  );
  assert.equal(writerAuthority.writer.recordSchemaVersion, 2);
  assert.equal(writerAuthority.writer.default, true);
  assert.deepEqual(
    writerAuthority.readers.map((reader) => [
      reader.rootProtocol,
      reader.recordSchemaVersion,
    ]),
    [
      ['sha256-length-framed-fields-v1', 1],
      ['kungfu.fact-root.canonical/v2', 2],
    ],
  );
  assert.equal(writerAuthority.migration.inPlaceRewrite, false);
  assert.equal(writerAuthority.rollback.downgradeWrite, 'fail-closed');
  assert.deepEqual(writerAuthority.qualification.exactCandidatePlatforms, [
    'linux',
    'macos',
    'windows',
  ]);
  for (const relative of writerAuthority.qualification.corpora)
    assert.equal(fs.existsSync(path.join(ROOT, relative)), true, relative);
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
    'missing-required-record-field',
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
