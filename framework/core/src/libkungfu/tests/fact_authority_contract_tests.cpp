// SPDX-License-Identifier: Apache-2.0

#include "../src/runtime/storage/fact_authority.h"
#include "../src/runtime/storage/fact_kernel_internal.h"

#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>

namespace fact = kungfu::runtime::storage_service_api::fact_kernel_internal;

namespace {

constexpr const char *PROTOCOL = fact::PORTABLE_ROOT_PROTOCOL;

std::string root(char value) { return "sha256:" + std::string(64, value); }

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void expect_mismatch(const std::string &field, const std::function<void()> &operation) {
  try {
    operation();
  } catch (const fact::fact_authority_mismatch &error) {
    require(error.field() == field, "authority mismatch named the wrong field");
    return;
  }
  throw std::runtime_error("authority mismatch was accepted at " + field);
}

std::string record_root(const fact::fact_document &document) {
  return fact::metadata_root(fact::fact_document_domain(document), fact::fact_document_json(document), PROTOCOL);
}

std::string roots_root(const char *domain, const std::vector<std::string> &roots) {
  return fact::metadata_root(domain, fact::root_array(roots), PROTOCOL);
}

void test_every_hana_record_projection_is_checked() {
  const fact::fact_document object = fact::fact_object{"fact:" + std::string(32, '1'), "claim", root('a')};
  const auto &object_value = std::get<fact::fact_object>(object);
  fact::object_record_authority object_authority{object_value.object_id, object_value.object_type,
                                                 object_value.created_by_receipt_root, record_root(object)};
  fact::validate_fact_record_authority(object, object_authority, PROTOCOL);
  auto bad_object = object_authority;
  bad_object.object_type = "different";
  expect_mismatch("object_type", [&] { fact::validate_fact_record_authority(object, bad_object, PROTOCOL); });

  const fact::fact_document version =
      fact::fact_version{object_value.object_id, root('b'), root('c'), {root('d')}, {root('e')}, {root('f')}};
  const auto &version_value = std::get<fact::fact_version>(version);
  fact::version_record_authority version_authority{
      version_value.object_id,
      record_root(version),
      version_value.body_root,
      version_value.schema_root,
      roots_root("fact-version-parents/v1", version_value.parent_version_roots),
      roots_root("fact-declaration-roots/v1", version_value.declaration_roots),
      roots_root("fact-admission-roots/v1", version_value.admission_roots)};
  fact::validate_fact_record_authority(version, version_authority, PROTOCOL);
  auto bad_version = version_authority;
  bad_version.parent_versions_root = root('0');
  expect_mismatch("parent_versions_root",
                  [&] { fact::validate_fact_record_authority(version, bad_version, PROTOCOL); });

  const fact::fact_document relation =
      fact::fact_relation{"fact:" + std::string(32, '2'),
                          "supports",
                          {"object", object_value.object_id, std::nullopt},
                          {"external-identity-with-mapping-receipt", "external:one", root('1')},
                          root('2'),
                          {root('3')}};
  const auto &relation_value = std::get<fact::fact_relation>(relation);
  fact::relation_record_authority relation_authority{
      relation_value.relation_id,     relation_value.relation_type,
      relation_value.source.kind,     relation_value.source.id,
      relation_value.target.kind,     relation_value.target.id,
      relation_value.attributes_root, roots_root("fact-admission-roots/v1", relation_value.admission_roots),
      record_root(relation)};
  fact::validate_fact_record_authority(relation, relation_authority, PROTOCOL);
  auto bad_relation = relation_authority;
  bad_relation.target_id = "external:two";
  expect_mismatch("target_id", [&] { fact::validate_fact_record_authority(relation, bad_relation, PROTOCOL); });

  const fact::fact_document revocation = fact::fact_revocation{relation_authority.relation_root, root('4')};
  const auto &revocation_value = std::get<fact::fact_revocation>(revocation);
  fact::revocation_record_authority revocation_authority{revocation_value.relation_root, revocation_value.reason_root,
                                                         record_root(revocation)};
  fact::validate_fact_record_authority(revocation, revocation_authority, PROTOCOL);
  auto bad_revocation = revocation_authority;
  bad_revocation.reason_root = root('5');
  expect_mismatch("reason_root", [&] { fact::validate_fact_record_authority(revocation, bad_revocation, PROTOCOL); });

  const fact::fact_document cut = fact::fact_cut{{root('6')},
                                                 {{object_value.object_id, version_authority.version_root}},
                                                 {relation_authority.relation_root},
                                                 {root('7')},
                                                 {root('8')},
                                                 {{42, root('9'), "frame:42"}},
                                                 {root('a')},
                                                 {root('b')}};
  const auto &cut_value = std::get<fact::fact_cut>(cut);
  const auto cut_json = fact::fact_document_json(cut);
  fact::cut_record_authority cut_authority{
      record_root(cut),
      roots_root("fact-parent-cuts/v1", cut_value.parent_cut_roots),
      fact::metadata_root("fact-object-versions/v1", cut_json.at("objectVersions"), PROTOCOL),
      roots_root("fact-active-relations/v1", cut_value.active_relation_roots),
      roots_root("fact-declaration-roots/v1", cut_value.declaration_roots),
      roots_root("fact-admission-roots/v1", cut_value.admission_roots),
      fact::metadata_root("fact-episode-frontier/v1", cut_json.at("episodeFrontier"), PROTOCOL),
      roots_root("fact-omission-roots/v1", cut_value.omission_roots),
      roots_root("fact-conflict-roots/v1", cut_value.conflict_roots)};
  fact::validate_fact_record_authority(cut, cut_authority, PROTOCOL);
  auto bad_cut = cut_authority;
  bad_cut.episode_frontier_root = root('c');
  expect_mismatch("episode_frontier_root", [&] { fact::validate_fact_record_authority(cut, bad_cut, PROTOCOL); });

  const fact::fact_document transition = fact::fact_transition{
      "transition:one", "heads/main", cut_authority.cut_root, 7, root('d'), "advance", root('e'), {}, 8};
  auto transition_value = std::get<fact::fact_transition>(transition);
  transition_value.transition_root = record_root(transition);
  const fact::fact_document rooted_transition = transition_value;
  fact::transition_record_authority transition_authority{
      transition_value.transition_id,         transition_value.ref_name,       transition_value.expected_old_cut_root,
      transition_value.expected_old_revision, transition_value.new_cut_root,   transition_value.kind,
      transition_value.reason_root,           transition_value.transition_root};
  fact::validate_fact_record_authority(rooted_transition, transition_authority, PROTOCOL);
  auto bad_transition = transition_authority;
  ++bad_transition.expected_old_revision;
  expect_mismatch("expected_old_revision",
                  [&] { fact::validate_fact_record_authority(rooted_transition, bad_transition, PROTOCOL); });
}

void test_receipt_metadata_cannot_override_hana_authority() {
  const fact::fact_document object = fact::fact_object{"fact:" + std::string(32, '1'), "claim", root('a')};
  const auto object_root = record_root(object);
  const auto receipt_root = root('f');
  fact::operation_receipt receipt{
      "op:one",    "object-put",
      "accepted",  std::nullopt,
      root('1'),   object_root,
      {},          {},
      0,           0,
      true,        fact::object_put_result{std::get<fact::fact_object>(object).object_id, object_root},
      receipt_root};
  auto metadata = fact::operation_receipt_json(receipt);
  metadata.erase("requestRoot");
  metadata.erase("writeOccurred");
  metadata.erase("result");
  fact::operation_receipt_authority authority{
      receipt.operation_id,   receipt.operation,        receipt.status,         receipt.failure_code,
      receipt.request_root,   receipt.record_root,      receipt.prior_cut_root, receipt.current_cut_root,
      receipt.prior_revision, receipt.current_revision, receipt.write_occurred, receipt.receipt_root};
  const auto parsed = fact::parse_operation_receipt(metadata, object, authority);
  require(parsed.operation_id == authority.operation_id, "receipt authority was not preserved");

  auto bad_operation = authority;
  bad_operation.operation_id = "op:other";
  expect_mismatch("receipt.operation_id",
                  [&] { (void)fact::parse_operation_receipt(metadata, object, bad_operation); });

  auto bad_revision = authority;
  bad_revision.current_revision = 1;
  expect_mismatch("receipt.current_revision",
                  [&] { (void)fact::parse_operation_receipt(metadata, object, bad_revision); });
}

} // namespace

int main() {
  try {
    test_every_hana_record_projection_is_checked();
    std::cout << "ok - every Hana record projection is checked\n";
    test_receipt_metadata_cannot_override_hana_authority();
    std::cout << "ok - receipt metadata cannot override Hana authority\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "not ok - " << error.what() << '\n';
    return 1;
  }
}
