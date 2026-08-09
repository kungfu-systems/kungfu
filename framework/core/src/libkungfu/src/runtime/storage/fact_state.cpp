// SPDX-License-Identifier: Apache-2.0

#include "fact_authority.h"
#include "fact_kernel_internal.h"

#include <type_traits>

#include <kungfu/common.h>
#include <kungfu/yijinjing/schema/types.h>
#include <kungfu/yijinjing/storage/fact_ledger.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace yy = kungfu::yijinjing;
using namespace kungfu::yijinjing::types;

namespace {
template <size_t N> std::string fixed_string(const kungfu::array<char, N> &value) {
  size_t length = 0;
  while (length < N && value.value[length] != '\0')
    ++length;
  return std::string(value.value, length);
}
void add_issue(kernel_state &state, uint32_t frame_tag, uint64_t sequence, bool sequence_known,
               const std::string &record_root, const std::string &failure_code, const std::string &message,
               const std::string &phase, const std::string &recovery) {
  state.issues.push_back({sequence, sequence_known, frame_tag, record_root, failure_code, message, phase, recovery});
  state.unknown_records = state.issues.size();
}

std::string root_protocol_for_version(uint32_t version) {
  if (version == LEGACY_RECORD_SCHEMA_VERSION)
    return LEGACY_ROOT_PROTOCOL;
  if (version == PORTABLE_RECORD_SCHEMA_VERSION)
    return PORTABLE_ROOT_PROTOCOL;
  return {};
}

const char *domain_for_tag(uint32_t tag) {
  if (tag == FactObjectRecorded::tag)
    return "kungfu.fact.object/v1";
  if (tag == FactVersionRecorded::tag)
    return "kungfu.fact.version/v1";
  if (tag == FactRelationAdded::tag)
    return "kungfu.fact.relation-add/v1";
  if (tag == FactRelationRevoked::tag)
    return "kungfu.fact.relation-revoke/v1";
  if (tag == FactCutCommitted::tag)
    return "kungfu.fact.cut/v1";
  if (tag == FactRefTransition::tag)
    return "kungfu.fact.ref-transition/v1";
  throw std::runtime_error("unsupported Fact authority record tag");
}
} // namespace

kernel_state fold_kernel(const std::string &runtime_dir) {
  kernel_state state;
  const auto ledger = yy::storage::fact_ledger_store(runtime_dir).replay();
  state.next_sequence = ledger.next_sequence;
  for (const auto &issue : ledger.issues) {
    add_issue(state, issue.frame_tag, issue.sequence, issue.sequence_known, issue.record_root, issue.code,
              "Fact authority record/receipt pairing is not readable", "authority-replay",
              "preserve-authority-and-run-fsck");
  }
  for (const auto &pair : ledger.accepted) {
    const auto &source = pair.record;
    try {
      auto accepted = kernel_authority_record{};
      accepted.tag = source.tag;
      accepted.sequence = source.sequence;
      accepted.record_root = source.record_root;
      accepted.root_protocol = root_protocol_for_version(source.schema_version);
      std::visit(
          [&](const auto &record) {
            using record_type = std::decay_t<decltype(record)>;
            if constexpr (std::is_same_v<record_type, FactObjectRecorded>) {
              accepted.key = fixed_string(record.object_id);
              accepted.document = parse_fact_document(
                  "kungfu.fact.object/v1", load_metadata(runtime_dir, source.record_root, "kungfu.fact.object/v1"));
              validate_fact_record_authority(
                  accepted.document,
                  object_record_authority{fixed_string(record.object_id), fixed_string(record.object_type),
                                          fixed_string(record.created_by_receipt_root), source.record_root},
                  accepted.root_protocol);
            } else if constexpr (std::is_same_v<record_type, FactVersionRecorded>) {
              accepted.key = source.record_root;
              accepted.document = parse_fact_document(
                  "kungfu.fact.version/v1", load_metadata(runtime_dir, source.record_root, "kungfu.fact.version/v1"));
              validate_fact_record_authority(
                  accepted.document,
                  version_record_authority{
                      fixed_string(record.object_id), source.record_root, fixed_string(record.body_root),
                      fixed_string(record.schema_root), fixed_string(record.parent_versions_root),
                      fixed_string(record.declaration_roots_root), fixed_string(record.admission_roots_root)},
                  accepted.root_protocol);
            } else if constexpr (std::is_same_v<record_type, FactRelationAdded>) {
              accepted.key = source.record_root;
              accepted.document =
                  parse_fact_document("kungfu.fact.relation-add/v1",
                                      load_metadata(runtime_dir, source.record_root, "kungfu.fact.relation-add/v1"));
              validate_fact_record_authority(
                  accepted.document,
                  relation_record_authority{fixed_string(record.relation_id), fixed_string(record.relation_type),
                                            fixed_string(record.source_kind), fixed_string(record.source_id),
                                            fixed_string(record.target_kind), fixed_string(record.target_id),
                                            fixed_string(record.attributes_root),
                                            fixed_string(record.admission_roots_root), source.record_root},
                  accepted.root_protocol);
            } else if constexpr (std::is_same_v<record_type, FactRelationRevoked>) {
              accepted.key = fixed_string(record.relation_root);
              accepted.document =
                  parse_fact_document("kungfu.fact.relation-revoke/v1",
                                      load_metadata(runtime_dir, source.record_root, "kungfu.fact.relation-revoke/v1"));
              validate_fact_record_authority(accepted.document,
                                             revocation_record_authority{fixed_string(record.relation_root),
                                                                         fixed_string(record.reason_root),
                                                                         source.record_root},
                                             accepted.root_protocol);
            } else if constexpr (std::is_same_v<record_type, FactCutCommitted>) {
              accepted.key = source.record_root;
              accepted.document = parse_fact_document(
                  "kungfu.fact.cut/v1", load_metadata(runtime_dir, source.record_root, "kungfu.fact.cut/v1"));
              validate_fact_record_authority(
                  accepted.document,
                  cut_record_authority{
                      source.record_root, fixed_string(record.parent_cuts_root),
                      fixed_string(record.object_versions_root), fixed_string(record.active_relations_root),
                      fixed_string(record.declaration_roots_root), fixed_string(record.admission_roots_root),
                      fixed_string(record.episode_frontier_root), fixed_string(record.omission_roots_root),
                      fixed_string(record.conflict_roots_root)},
                  accepted.root_protocol);
            } else if constexpr (std::is_same_v<record_type, FactRefTransition>) {
              accepted.key = fixed_string(record.transition_id);
              accepted.document =
                  parse_fact_document("kungfu.fact.ref-transition/v1",
                                      load_metadata(runtime_dir, source.record_root, "kungfu.fact.ref-transition/v1"),
                                      source.record_root, record.expected_old_revision + 1);
              validate_fact_record_authority(
                  accepted.document,
                  transition_record_authority{fixed_string(record.transition_id), fixed_string(record.ref_name),
                                              fixed_string(record.expected_old_cut_root), record.expected_old_revision,
                                              fixed_string(record.new_cut_root), fixed_string(record.transition_kind),
                                              fixed_string(record.reason_root), source.record_root},
                  accepted.root_protocol);
            }
          },
          source.value);

      const auto &receipt_record = pair.receipt;
      const auto receipt_root = fixed_string(receipt_record.receipt_root);
      auto failure_code = fixed_string(receipt_record.failure_code);
      accepted.receipt = parse_operation_receipt(
          load_metadata(runtime_dir, receipt_root, "kungfu.fact.operation-receipt/v1"), accepted.document,
          operation_receipt_authority{
              fixed_string(receipt_record.operation_id), fixed_string(receipt_record.operation),
              fixed_string(receipt_record.status),
              failure_code.empty() ? std::nullopt : std::optional<std::string>{std::move(failure_code)},
              fixed_string(receipt_record.request_root), fixed_string(receipt_record.record_root),
              fixed_string(receipt_record.prior_cut_root), fixed_string(receipt_record.current_cut_root),
              receipt_record.prior_revision, receipt_record.current_revision, receipt_record.write_occurred != 0,
              receipt_root});
      state.receipts[fixed_string(receipt_record.operation_id)] = accepted.receipt;

      const auto document = fact_document_json(accepted.document);
      const auto successor_root = accepted.root_protocol == PORTABLE_ROOT_PROTOCOL
                                      ? accepted.record_root
                                      : metadata_root(domain_for_tag(accepted.tag), document, PORTABLE_ROOT_PROTOCOL);
      accepted.mapping_receipt = parse_root_mapping(
          root_mapping_receipt(domain_for_tag(accepted.tag), document, successor_root, accepted.receipt.request_root));
      accepted.mapping_receipt_root = root_mapping_receipt_root(root_mapping_json(accepted.mapping_receipt));
      state.authority_records.push_back(std::move(accepted));
    } catch (const fact_authority_mismatch &error) {
      add_issue(state, source.tag, source.sequence, true, source.record_root, "authority-record-mismatch", error.what(),
                "authority-validation", "preserve-authority-and-run-fsck");
    } catch (const std::exception &) {
      add_issue(state, source.tag, source.sequence, true, source.record_root, "record-materialization-failed",
                "Fact record metadata could not be verified", "materialize", "preserve-authority-and-restore-content");
    }
  }
  for (const auto &record : state.authority_records) {
    switch (record.tag) {
    case FactObjectRecorded::tag:
      state.objects[record.key] = std::get<fact_object>(record.document);
      break;
    case FactVersionRecorded::tag:
      state.versions[record.key] = std::get<fact_version>(record.document);
      break;
    case FactRelationAdded::tag:
      state.relations[record.key] = std::get<fact_relation>(record.document);
      break;
    case FactRelationRevoked::tag:
      state.revoked_relations.insert(record.key);
      state.revocations[record.record_root] = std::get<fact_revocation>(record.document);
      break;
    case FactCutCommitted::tag:
      state.cuts[record.key] = std::get<fact_cut>(record.document);
      break;
    case FactRefTransition::tag: {
      const auto &transition = std::get<fact_transition>(record.document);
      state.refs[transition.ref_name] = {transition.ref_name, transition.new_cut_root, transition.revision,
                                         transition.transition_id, transition.transition_root};
      state.transitions[record.key] = transition;
    } break;
    default:
      add_issue(state, record.tag, record.sequence, true, record.record_root, "fold-dispatch-unsupported",
                "Accepted Fact record has no fold projection", "fold", "preserve-authority-and-upgrade-reader");
      break;
    }
  }
  return state;
}

nlohmann::json fold_issues_json(const std::vector<kernel_fold_issue> &issues) {
  auto result = nlohmann::json::array();
  for (const auto &issue : issues) {
    result.push_back(
        {{"sequence", issue.sequence_known ? nlohmann::json(issue.sequence) : nlohmann::json(nullptr)},
         {"frame_tag", issue.frame_tag},
         {"record_root", issue.record_root.empty() ? nlohmann::json(nullptr) : nlohmann::json(issue.record_root)},
         {"failure_code", issue.failure_code},
         {"message", issue.message},
         {"phase", issue.phase},
         {"recovery", issue.recovery}});
  }
  return result;
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
