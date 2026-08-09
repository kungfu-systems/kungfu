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
const YIJINJING = path.join(ROOT, 'framework/core/src/libyijinjing');

const owners = {
  typedDomain: read('fact_domain.cpp'),
  authority: read('fact_authority.cpp'),
  facade: read('fact_kernel.cpp'),
  protocol: read('fact_protocol.cpp'),
  state: read('fact_state.cpp'),
  actions: read('fact_actions.cpp'),
  commit: read('fact_commit.cpp'),
  durable: read('fact_durable_admission.cpp'),
  query: read('fact_query.cpp'),
  portability: read('fact_portability.cpp'),
};
const internalHeader = read('fact_kernel_internal.h');
const factLedger = fs.readFileSync(
  path.join(YIJINJING, 'src/storage/fact_ledger.cpp'),
  'utf8',
);
const queryHeader = fs.readFileSync(
  path.join(
    ROOT,
    'framework/core/src/libkungfu/include/kungfu/runtime/query/fact_query.h',
  ),
  'utf8',
);

test('the public Fact facade remains a bounded dispatcher', () => {
  assert.ok(owners.facade.trimEnd().split('\n').length <= 50);
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
  assert.equal(count(/advisory_file_lock acquire_writer_guard\(/), 1);
  assert.equal(count(/nlohmann::json query_kernel\(/), 1);
  assert.equal(count(/nlohmann::json authority_bundle\(/), 1);
});

test('typed action handlers cannot append and the coordinator has one append path', () => {
  for (const action of [
    'object_put',
    'version_put',
    'relation_add',
    'relation_revoke',
    'cut_put',
    'ref_cas',
  ]) {
    assert.equal(
      [
        ...owners.actions.matchAll(
          new RegExp(`mutation_outcome handle_${action}\\(`, 'g'),
        ),
      ].length,
      1,
      action,
    );
  }
  assert.match(owners.commit, /parse_mutation_request/);
  assert.match(owners.commit, /handle_mutation/);
  assert.equal(
    [...owners.commit.matchAll(/append_record_with_receipt\(/g)].length,
    2,
  );
  assert.doesNotMatch(
    owners.actions,
    /append_record_with_receipt|write_at\(|writer_guard/,
  );
  assert.doesNotMatch(
    owners.commit,
    /if \(action == "(?:object-put|version-put|relation-add|relation-revoke|cut-put)"/,
  );
});

test('failure categories and fold issue fields stay aligned across machine and human surfaces', () => {
  const categories = [
    'invalid-request',
    'invalid-action',
    'invalid-field',
    'invalid-identity',
    'stale-ref',
    'integrity-failure',
    'backend-failure',
  ];
  const issueFields = [
    'sequence',
    'frame_tag',
    'record_root',
    'failure_code',
    'message',
    'phase',
    'recovery',
  ];
  const integrity = fs.readFileSync(
    path.join(
      ROOT,
      'framework/core/src/python/kungfu/storage/fact_kernel_integrity.py',
    ),
    'utf8',
  );
  const qualification = fs.readFileSync(
    path.join(ROOT, 'docs/qualification/fact-storage-authority.md'),
    'utf8',
  );

  assert.match(owners.facade, /action_route::unknown/);
  assert.match(owners.facade, /"invalid-action"/);
  assert.match(
    owners.protocol,
    /\{"failure_category", failure_category_for\(code\)\}/,
  );
  for (const category of categories) {
    assert.match(owners.query, new RegExp(`"${category}"`));
    assert.match(qualification, new RegExp(`\\b${category}\\b`));
  }
  for (const field of issueFields) {
    assert.match(owners.state, new RegExp(`"${field}"`));
    assert.match(owners.query, new RegExp(`"${field}"`));
    assert.match(integrity, new RegExp(`"${field}"`));
    assert.match(qualification, new RegExp(`\\b${field}\\b`));
  }
  assert.match(owners.query, /"payloads_exposed", false/);
});

test('qualification faults, durable ids, and oversized operations have explicit phases', () => {
  assert.match(owners.protocol, /KUNGFU_FACT_QUALIFICATION_FAULTS/);
  assert.match(owners.durable, /require_qualification_fault_gate\(\)/);
  assert.match(owners.portability, /require_qualification_fault_gate\(\)/);
  assert.match(owners.query, /"request_controlled", false/);
  assert.match(owners.durable, /compute_content_hash_value\(operation_id\)/);
  assert.match(owners.durable, /"durable_request_id"/);
  assert.match(
    owners.durable,
    /if \(!payload\.contains\("durable_request_id"\)\)[\s\S]*legacy_durable_request_id\(operation_id\)/,
  );
  assert.match(
    owners.protocol,
    /code == "durable-evidence-corrupt"[\s\S]*"integrity-failure"/,
  );
  assert.match(
    owners.protocol,
    /code == "import-interrupted" \|\| code == "outcome-unknown"[\s\S]*"backend-failure"/,
  );
  assert.match(owners.durable, /prepare_durable_admission\(/);
  assert.match(owners.durable, /append_durable_admission\(/);
  assert.match(owners.portability, /preflight_authority_import\(/);
  assert.match(owners.portability, /authority_import_batch_options\(/);
  assert.match(owners.portability, /pending_authority_operations\(/);
  assert.match(owners.state, /fact_ledger_store\(runtime_dir\)\.replay\(\)/);
  assert.match(factLedger, /frame->data_length\(\) < sizeof\(Record\)/);
  assert.match(factLedger, /supported_schema\(record\.schema_version\)/);
  assert.equal([...factLedger.matchAll(/return decode_record</g)].length, 6);
});

test('portability enters the typed mutation executor, never the public dispatcher', () => {
  assert.match(owners.portability, /execute_mutation_with_protocol\(/);
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
    'fact_actions.cpp',
    'fact_authority.cpp',
    'fact_commit.cpp',
    'fact_domain.cpp',
    'fact_portability.cpp',
    'fact_protocol.cpp',
    'fact_query.cpp',
    'fact_state.cpp',
  ]);
  assert.equal(matrix.owners.typedDomain, 'fact_domain.cpp');
  assert.equal(matrix.owners.authorityValidation, 'fact_authority.cpp');
  assert.equal(matrix.owners.typedActions, 'fact_actions.cpp');
  assert.equal(matrix.owners.commitCoordinator, 'fact_commit.cpp');
  assert.equal(
    matrix.invariants.find(
      ({ id }) => id === 'authority-import-bundle-wide-writer-fence',
    ).status,
    'proved',
  );
});

test('portable decoding bounds untrusted collection counts before iteration', () => {
  assert.match(owners.protocol, /void validate_portable_count\(/);
  assert.equal(
    [...owners.protocol.matchAll(/validate_portable_count\(count,/g)].length,
    3,
  );
  for (const kind of ['array', 'set', 'map', 'record field'])
    assert.ok(owners.protocol.includes(`"${kind}"`), kind);
  assert.match(
    owners.protocol,
    /count > remaining_bytes \/ minimum_bytes_per_entry/,
  );
});

test('Core architecture compiles every internal Fact owner', () => {
  const targets = fs.readFileSync(
    path.join(ROOT, 'framework/core/architecture/TARGETS.cmake'),
    'utf8',
  );
  for (const file of [
    'fact_kernel.cpp',
    'fact_domain.cpp',
    'fact_authority.cpp',
    'fact_protocol.cpp',
    'fact_state.cpp',
    'fact_actions.cpp',
    'fact_commit.cpp',
    'fact_query.cpp',
    'fact_portability.cpp',
  ]) {
    assert.match(targets, new RegExp(`src/runtime/storage/${file}`));
  }
});

test('Hana POD authority cannot be overridden by content metadata', () => {
  assert.match(owners.authority, /void validate_fact_record_authority\(/);
  assert.match(owners.authority, /void validate_operation_receipt_authority\(/);
  assert.equal(
    [...owners.state.matchAll(/validate_fact_record_authority\(/g)].length,
    6,
  );
  assert.match(owners.state, /operation_receipt_authority\{/);
  assert.match(owners.state, /"authority-record-mismatch"/);
  assert.match(owners.typedDomain, /validate_operation_receipt_authority\(/);
});

test('stable Fact state and query proof contracts cannot regress to JSON bags', () => {
  for (const type of [
    'std::map<std::string, fact_object> objects',
    'std::map<std::string, fact_version> versions',
    'std::map<std::string, fact_relation> relations',
    'std::map<std::string, fact_cut> cuts',
    'std::map<std::string, fact_ref> refs',
    'std::map<std::string, fact_transition> transitions',
    'std::map<std::string, operation_receipt> receipts',
  ]) {
    assert.ok(internalHeader.includes(type), type);
  }
  assert.doesNotMatch(
    internalHeader,
    /std::map<std::string,\s*nlohmann::json>\s+(objects|versions|relations|revocations|cuts|refs|transitions|receipts)/,
  );
  assert.match(queryHeader, /using storage =[\s\S]+std::variant</);
  assert.match(queryHeader, /std::vector<dynamic_row> rows/);
  assert.match(queryHeader, /query_authority authority/);
  assert.match(queryHeader, /query_cut_proof cut/);
  assert.match(queryHeader, /std::vector<missing_input> missing_inputs/);
  assert.match(queryHeader, /std::vector<query_conflict> conflicts/);
  assert.doesNotMatch(queryHeader, /std::vector<nlohmann::json> rows/);
  assert.doesNotMatch(
    queryHeader,
    /nlohmann::json (authority|cut|policy_versions|time_basis|execution)/,
  );
  assert.doesNotMatch(queryHeader, /nlohmann::json arguments/);
});

test('one typed domain adapter owns stable Fact document JSON projection', () => {
  assert.match(owners.typedDomain, /fact_document parse_fact_document\(/);
  assert.match(owners.typedDomain, /nlohmann::json fact_document_json\(/);
  assert.match(
    owners.typedDomain,
    /operation_receipt parse_operation_receipt\(/,
  );
  for (const source of [
    owners.state,
    owners.actions,
    owners.commit,
    owners.query,
    owners.portability,
  ]) {
    assert.doesNotMatch(
      source,
      /document\.at\("(objectId|bodyRoot|relationId|parentCutRoots|transitionId)"\)/,
    );
  }
});

test('authority writers share only the advisory OS-lock mechanics', () => {
  const primitive = fs.readFileSync(
    path.join(YIJINJING, 'src/io/advisory_file_lock.cpp'),
    'utf8',
  );
  const domains = [
    owners.commit,
    read('backend_switch.cpp'),
    fs.readFileSync(
      path.join(YIJINJING, 'src/storage/episode_manifest.cpp'),
      'utf8',
    ),
    fs.readFileSync(path.join(YIJINJING, 'src/io/ownership.cpp'), 'utf8'),
  ];
  const qualification = fs.readFileSync(
    path.join(ROOT, 'docs/qualification/fact-storage-authority.md'),
    'utf8',
  );

  assert.match(primitive, /CreateFileW/);
  assert.match(primitive, /LockFileEx/);
  assert.match(primitive, /::flock/);
  for (const domain of domains) {
    assert.match(domain, /advisory_file_lock/);
    assert.doesNotMatch(
      domain,
      /CreateFile[AW]|LockFileEx|UnlockFileEx|::flock\s*\(/,
    );
  }
  for (const contract of [
    'fact_kernel_writer_busy',
    'manifest_writer_busy',
    'backend_switch_busy',
    'backend_authority_lock_failed',
    'generation/fence advancement',
    'offset `2^32`',
  ]) {
    assert.ok(qualification.includes(contract), contract);
  }
});
