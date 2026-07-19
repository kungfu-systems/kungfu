// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const STORAGE = path.join(
  ROOT,
  'framework/core/src/libkungfu/src/runtime/storage',
);
const read = (file) => fs.readFileSync(path.join(STORAGE, file), 'utf8');

const owners = {
  facade: read('fact_kernel.cpp'),
  protocol: read('fact_protocol.cpp'),
  state: read('fact_state.cpp'),
  commit: read('fact_commit.cpp'),
  query: read('fact_query.cpp'),
  portability: read('fact_portability.cpp'),
};

test('the public Fact facade remains a bounded dispatcher', () => {
  assert.ok(owners.facade.split('\n').length <= 50);
  assert.match(owners.facade, /return execute_mutation/);
  assert.match(owners.facade, /resolve_action_route/);
  assert.match(owners.query, /ACTION_REGISTRY/);
  assert.doesNotMatch(owners.query, /"object-put"/);
  for (const forbidden of [
    'append_record_with_receipt',
    'fold_kernel(const',
    'metadata_preimage',
    'authority_bundle(',
    'writer_guard',
  ]) {
    assert.ok(!owners.facade.includes(forbidden));
  }
});

test('Root, Fold, writer, query, and portability each have one implementation owner', () => {
  const count = (pattern) =>
    Object.values(owners).filter((source) => pattern.test(source)).length;
  assert.equal(count(/std::string metadata_preimage\(/), 1);
  assert.equal(count(/kernel_state fold_kernel\(/), 1);
  assert.equal(count(/class writer_guard/), 1);
  assert.equal(count(/nlohmann::json query_kernel\(/), 1);
  assert.equal(count(/nlohmann::json authority_bundle\(/), 1);
});

test('portability enters the typed mutation executor, never the public dispatcher', () => {
  assert.match(owners.portability, /execute_mutation\(/);
  assert.match(owners.portability, /execute_mutation_batch\(/);
  assert.doesNotMatch(owners.portability, /run_fact_kernel_operation\(/);
  assert.doesNotMatch(owners.query, /writer_guard|make_writer|write_at\(/);
  assert.match(
    owners.commit,
    /execute_mutation_batch[\s\S]+writer_guard[\s\S]+destination-drift/,
  );
});

test('the machine parity matrix assigns every internal authority boundary', () => {
  const matrix = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'tests/fixtures/fact-kernel-characterization/parity-matrix.json',
      ),
      'utf8',
    ),
  );
  assert.deepEqual(Object.values(matrix.owners).sort(), [
    'fact_commit.cpp',
    'fact_portability.cpp',
    'fact_protocol.cpp',
    'fact_query.cpp',
    'fact_state.cpp',
  ]);
  assert.equal(
    matrix.invariants.find(
      ({ id }) => id === 'authority-import-bundle-wide-writer-fence',
    ).status,
    'proved',
  );
});

test('Core architecture compiles every internal Fact owner', () => {
  const targets = fs.readFileSync(
    path.join(ROOT, 'framework/core/architecture/TARGETS.cmake'),
    'utf8',
  );
  for (const file of [
    'fact_kernel.cpp',
    'fact_protocol.cpp',
    'fact_state.cpp',
    'fact_commit.cpp',
    'fact_query.cpp',
    'fact_portability.cpp',
  ]) {
    assert.match(targets, new RegExp(`src/runtime/storage/${file}`));
  }
});
