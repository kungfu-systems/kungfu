// SPDX-License-Identifier: Apache-2.0

#include "fact_authority.h"
#include "fact_kernel_internal.h"

#include <type_traits>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace {

template <typename T> void require_authority_equal(const T &actual, const T &expected, const char *field) {
  if (actual != expected) {
    throw fact_authority_mismatch(field);
  }
}

void require_document_root(const fact_document &document, const std::string &root, const std::string &root_protocol) {
  require_authority_equal(metadata_root(fact_document_domain(document), fact_document_json(document), root_protocol),
                          root, "record_root");
}

std::string roots_root(const char *domain, const std::vector<std::string> &roots, const std::string &root_protocol) {
  return metadata_root(domain, root_array(roots), root_protocol);
}

} // namespace

void validate_fact_record_authority(const fact_document &document, const fact_record_authority &authority,
                                    const std::string &root_protocol) {
  std::visit(
      [&](const auto &record) {
        using record_type = std::decay_t<decltype(record)>;
        if constexpr (std::is_same_v<record_type, object_record_authority>) {
          const auto *value = std::get_if<fact_object>(&document);
          if (value == nullptr)
            throw fact_authority_mismatch("record_type");
          require_authority_equal(value->object_id, record.object_id, "object_id");
          require_authority_equal(value->object_type, record.object_type, "object_type");
          require_authority_equal(value->created_by_receipt_root, record.created_by_receipt_root,
                                  "created_by_receipt_root");
          require_document_root(document, record.object_root, root_protocol);
        } else if constexpr (std::is_same_v<record_type, version_record_authority>) {
          const auto *value = std::get_if<fact_version>(&document);
          if (value == nullptr)
            throw fact_authority_mismatch("record_type");
          require_authority_equal(value->object_id, record.object_id, "object_id");
          require_authority_equal(value->body_root, record.body_root, "body_root");
          require_authority_equal(value->schema_root, record.schema_root, "schema_root");
          require_authority_equal(roots_root("fact-version-parents/v1", value->parent_version_roots, root_protocol),
                                  record.parent_versions_root, "parent_versions_root");
          require_authority_equal(roots_root("fact-declaration-roots/v1", value->declaration_roots, root_protocol),
                                  record.declaration_roots_root, "declaration_roots_root");
          require_authority_equal(roots_root("fact-admission-roots/v1", value->admission_roots, root_protocol),
                                  record.admission_roots_root, "admission_roots_root");
          require_document_root(document, record.version_root, root_protocol);
        } else if constexpr (std::is_same_v<record_type, relation_record_authority>) {
          const auto *value = std::get_if<fact_relation>(&document);
          if (value == nullptr)
            throw fact_authority_mismatch("record_type");
          require_authority_equal(value->relation_id, record.relation_id, "relation_id");
          require_authority_equal(value->relation_type, record.relation_type, "relation_type");
          require_authority_equal(value->source.kind, record.source_kind, "source_kind");
          require_authority_equal(value->source.id, record.source_id, "source_id");
          require_authority_equal(value->target.kind, record.target_kind, "target_kind");
          require_authority_equal(value->target.id, record.target_id, "target_id");
          require_authority_equal(value->attributes_root, record.attributes_root, "attributes_root");
          require_authority_equal(roots_root("fact-admission-roots/v1", value->admission_roots, root_protocol),
                                  record.admission_roots_root, "admission_roots_root");
          require_document_root(document, record.relation_root, root_protocol);
        } else if constexpr (std::is_same_v<record_type, revocation_record_authority>) {
          const auto *value = std::get_if<fact_revocation>(&document);
          if (value == nullptr)
            throw fact_authority_mismatch("record_type");
          require_authority_equal(value->relation_root, record.relation_root, "relation_root");
          require_authority_equal(value->reason_root, record.reason_root, "reason_root");
          require_document_root(document, record.revoke_root, root_protocol);
        } else if constexpr (std::is_same_v<record_type, cut_record_authority>) {
          const auto *value = std::get_if<fact_cut>(&document);
          if (value == nullptr)
            throw fact_authority_mismatch("record_type");
          const auto projected = fact_document_json(document);
          require_authority_equal(roots_root("fact-parent-cuts/v1", value->parent_cut_roots, root_protocol),
                                  record.parent_cuts_root, "parent_cuts_root");
          require_authority_equal(
              metadata_root("fact-object-versions/v1", projected.at("objectVersions"), root_protocol),
              record.object_versions_root, "object_versions_root");
          require_authority_equal(roots_root("fact-active-relations/v1", value->active_relation_roots, root_protocol),
                                  record.active_relations_root, "active_relations_root");
          require_authority_equal(roots_root("fact-declaration-roots/v1", value->declaration_roots, root_protocol),
                                  record.declaration_roots_root, "declaration_roots_root");
          require_authority_equal(roots_root("fact-admission-roots/v1", value->admission_roots, root_protocol),
                                  record.admission_roots_root, "admission_roots_root");
          require_authority_equal(
              metadata_root("fact-episode-frontier/v1", projected.at("episodeFrontier"), root_protocol),
              record.episode_frontier_root, "episode_frontier_root");
          require_authority_equal(roots_root("fact-omission-roots/v1", value->omission_roots, root_protocol),
                                  record.omission_roots_root, "omission_roots_root");
          require_authority_equal(roots_root("fact-conflict-roots/v1", value->conflict_roots, root_protocol),
                                  record.conflict_roots_root, "conflict_roots_root");
          require_document_root(document, record.cut_root, root_protocol);
        } else {
          const auto *value = std::get_if<fact_transition>(&document);
          if (value == nullptr)
            throw fact_authority_mismatch("record_type");
          require_authority_equal(value->transition_id, record.transition_id, "transition_id");
          require_authority_equal(value->ref_name, record.ref_name, "ref_name");
          require_authority_equal(value->expected_old_cut_root, record.expected_old_cut_root, "expected_old_cut_root");
          require_authority_equal(value->expected_old_revision, record.expected_old_revision, "expected_old_revision");
          require_authority_equal(value->new_cut_root, record.new_cut_root, "new_cut_root");
          require_authority_equal(value->kind, record.kind, "transition_kind");
          require_authority_equal(value->reason_root, record.reason_root, "reason_root");
          require_authority_equal(value->transition_root, record.transition_root, "transition_root");
          require_authority_equal(value->revision, record.expected_old_revision + 1, "revision");
          require_document_root(document, record.transition_root, root_protocol);
        }
      },
      authority);
}

void validate_operation_receipt_authority(const operation_receipt &receipt,
                                          const operation_receipt_authority &authority) {
  require_authority_equal(receipt.operation_id, authority.operation_id, "receipt.operation_id");
  require_authority_equal(receipt.operation, authority.operation, "receipt.operation");
  require_authority_equal(receipt.status, authority.status, "receipt.status");
  require_authority_equal(receipt.failure_code, authority.failure_code, "receipt.failure_code");
  require_authority_equal(receipt.request_root, authority.request_root, "receipt.request_root");
  require_authority_equal(receipt.record_root, authority.record_root, "receipt.record_root");
  require_authority_equal(receipt.prior_cut_root, authority.prior_cut_root, "receipt.prior_cut_root");
  require_authority_equal(receipt.current_cut_root, authority.current_cut_root, "receipt.current_cut_root");
  require_authority_equal(receipt.prior_revision, authority.prior_revision, "receipt.prior_revision");
  require_authority_equal(receipt.current_revision, authority.current_revision, "receipt.current_revision");
  require_authority_equal(receipt.write_occurred, authority.write_occurred, "receipt.write_occurred");
  require_authority_equal(receipt.receipt_root, authority.receipt_root, "receipt.receipt_root");
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
