// SPDX-License-Identifier: Apache-2.0

#include "fact_authority.h"
#include "fact_kernel_internal.h"

#include <algorithm>
#include <memory>

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace yy = kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

namespace {
template <size_t N> std::string fixed_string(const kungfu::array<char, N> &value) {
  size_t length = 0;
  while (length < N && value.value[length] != '\0')
    ++length;
  return std::string(value.value, length);
}
location_ptr kernel_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<yy::data::locator>(runtime_dir, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, JOURNAL_NAMESPACE, JOURNAL_NAME, locator);
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

template <typename T> bool decode_record(const frame_ptr &frame, T &value) {
  if (frame->data_length() < sizeof(T)) {
    return false;
  }
  value = frame->data<T>();
  return !root_protocol_for_version(value.schema_version).empty();
}

kernel_state fold_kernel(const std::string &runtime_dir) {
  kernel_state state;
  std::vector<kernel_authority_record> pending;
  std::set<uint64_t> accepted_sequences;
  const auto target = kernel_location(runtime_dir);
  if (target->locator->list_page_id(target, location::PUBLIC).empty()) {
    return state;
  }
  auto reader = std::make_shared<yy::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(target, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    const auto frame_tag = static_cast<uint32_t>(frame->carrier_type());
    uint64_t sequence = 0;
    bool sequence_known = false;
    std::string record_root;
    try {
      switch (frame->carrier_type()) {
      case FactObjectRecorded::tag: {
        FactObjectRecorded record{};
        if (!decode_record(frame, record)) {
          add_issue(state, frame_tag, 0, false, {}, "record-decode-failed",
                    "Fact record is truncated or uses an unsupported schema version", "decode",
                    "preserve-authority-and-upgrade-reader");
          break;
        }
        sequence = record.sequence;
        sequence_known = true;
        record_root = fixed_string(record.object_root);
        auto document = parse_fact_document("kungfu.fact.object/v1",
                                            load_metadata(runtime_dir, record_root, "kungfu.fact.object/v1"));
        validate_fact_record_authority(
            document,
            object_record_authority{fixed_string(record.object_id), fixed_string(record.object_type),
                                    fixed_string(record.created_by_receipt_root), record_root},
            root_protocol_for_version(record.schema_version));
        pending.push_back(
            {FactObjectRecorded::tag, sequence, fixed_string(record.object_id), record_root, std::move(document)});
        pending.back().root_protocol = root_protocol_for_version(record.schema_version);
        break;
      }
      case FactVersionRecorded::tag: {
        FactVersionRecorded record{};
        if (!decode_record(frame, record)) {
          add_issue(state, frame_tag, 0, false, {}, "record-decode-failed",
                    "Fact record is truncated or uses an unsupported schema version", "decode",
                    "preserve-authority-and-upgrade-reader");
          break;
        }
        sequence = record.sequence;
        sequence_known = true;
        record_root = fixed_string(record.version_root);
        auto document = parse_fact_document("kungfu.fact.version/v1",
                                            load_metadata(runtime_dir, record_root, "kungfu.fact.version/v1"));
        validate_fact_record_authority(
            document,
            version_record_authority{fixed_string(record.object_id), record_root, fixed_string(record.body_root),
                                     fixed_string(record.schema_root), fixed_string(record.parent_versions_root),
                                     fixed_string(record.declaration_roots_root),
                                     fixed_string(record.admission_roots_root)},
            root_protocol_for_version(record.schema_version));
        pending.push_back({FactVersionRecorded::tag, sequence, record_root, record_root, std::move(document)});
        pending.back().root_protocol = root_protocol_for_version(record.schema_version);
        break;
      }
      case FactRelationAdded::tag: {
        FactRelationAdded record{};
        if (!decode_record(frame, record)) {
          add_issue(state, frame_tag, 0, false, {}, "record-decode-failed",
                    "Fact record is truncated or uses an unsupported schema version", "decode",
                    "preserve-authority-and-upgrade-reader");
          break;
        }
        sequence = record.sequence;
        sequence_known = true;
        record_root = fixed_string(record.relation_root);
        auto document = parse_fact_document("kungfu.fact.relation-add/v1",
                                            load_metadata(runtime_dir, record_root, "kungfu.fact.relation-add/v1"));
        validate_fact_record_authority(
            document,
            relation_record_authority{
                fixed_string(record.relation_id), fixed_string(record.relation_type), fixed_string(record.source_kind),
                fixed_string(record.source_id), fixed_string(record.target_kind), fixed_string(record.target_id),
                fixed_string(record.attributes_root), fixed_string(record.admission_roots_root), record_root},
            root_protocol_for_version(record.schema_version));
        pending.push_back({FactRelationAdded::tag, sequence, record_root, record_root, std::move(document)});
        pending.back().root_protocol = root_protocol_for_version(record.schema_version);
        break;
      }
      case FactRelationRevoked::tag: {
        FactRelationRevoked record{};
        if (!decode_record(frame, record)) {
          add_issue(state, frame_tag, 0, false, {}, "record-decode-failed",
                    "Fact record is truncated or uses an unsupported schema version", "decode",
                    "preserve-authority-and-upgrade-reader");
          break;
        }
        sequence = record.sequence;
        sequence_known = true;
        record_root = fixed_string(record.revoke_root);
        auto document = parse_fact_document("kungfu.fact.relation-revoke/v1",
                                            load_metadata(runtime_dir, record_root, "kungfu.fact.relation-revoke/v1"));
        validate_fact_record_authority(document,
                                       revocation_record_authority{fixed_string(record.relation_root),
                                                                   fixed_string(record.reason_root), record_root},
                                       root_protocol_for_version(record.schema_version));
        pending.push_back(
            {FactRelationRevoked::tag, sequence, fixed_string(record.relation_root), record_root, std::move(document)});
        pending.back().root_protocol = root_protocol_for_version(record.schema_version);
        break;
      }
      case FactCutCommitted::tag: {
        FactCutCommitted record{};
        if (!decode_record(frame, record)) {
          add_issue(state, frame_tag, 0, false, {}, "record-decode-failed",
                    "Fact record is truncated or uses an unsupported schema version", "decode",
                    "preserve-authority-and-upgrade-reader");
          break;
        }
        sequence = record.sequence;
        sequence_known = true;
        record_root = fixed_string(record.cut_root);
        auto document =
            parse_fact_document("kungfu.fact.cut/v1", load_metadata(runtime_dir, record_root, "kungfu.fact.cut/v1"));
        validate_fact_record_authority(
            document,
            cut_record_authority{record_root, fixed_string(record.parent_cuts_root),
                                 fixed_string(record.object_versions_root), fixed_string(record.active_relations_root),
                                 fixed_string(record.declaration_roots_root), fixed_string(record.admission_roots_root),
                                 fixed_string(record.episode_frontier_root), fixed_string(record.omission_roots_root),
                                 fixed_string(record.conflict_roots_root)},
            root_protocol_for_version(record.schema_version));
        pending.push_back({FactCutCommitted::tag, sequence, record_root, record_root, std::move(document)});
        pending.back().root_protocol = root_protocol_for_version(record.schema_version);
        break;
      }
      case FactRefTransition::tag: {
        FactRefTransition record{};
        if (!decode_record(frame, record)) {
          add_issue(state, frame_tag, 0, false, {}, "record-decode-failed",
                    "Fact record is truncated or uses an unsupported schema version", "decode",
                    "preserve-authority-and-upgrade-reader");
          break;
        }
        sequence = record.sequence;
        sequence_known = true;
        record_root = fixed_string(record.transition_root);
        auto document = parse_fact_document("kungfu.fact.ref-transition/v1",
                                            load_metadata(runtime_dir, record_root, "kungfu.fact.ref-transition/v1"),
                                            record_root, record.expected_old_revision + 1);
        validate_fact_record_authority(
            document,
            transition_record_authority{fixed_string(record.transition_id), fixed_string(record.ref_name),
                                        fixed_string(record.expected_old_cut_root), record.expected_old_revision,
                                        fixed_string(record.new_cut_root), fixed_string(record.transition_kind),
                                        fixed_string(record.reason_root), record_root},
            root_protocol_for_version(record.schema_version));
        pending.push_back(
            {FactRefTransition::tag, sequence, fixed_string(record.transition_id), record_root, std::move(document)});
        pending.back().root_protocol = root_protocol_for_version(record.schema_version);
        break;
      }
      case FactOperationReceipt::tag: {
        FactOperationReceipt record{};
        if (!decode_record(frame, record)) {
          add_issue(state, frame_tag, 0, false, {}, "record-decode-failed",
                    "Fact receipt is truncated or uses an unsupported schema version", "decode",
                    "preserve-authority-and-upgrade-reader");
          break;
        }
        sequence = record.sequence;
        sequence_known = true;
        record_root = fixed_string(record.receipt_root);
        if (pending.empty()) {
          add_issue(state, frame_tag, sequence, true, {}, "receipt-pair-mismatch",
                    "Fact receipt does not pair with the immediately preceding record", "receipt-pairing",
                    "preserve-authority-and-run-fsck");
          break;
        }
        auto failure_code = fixed_string(record.failure_code);
        auto receipt = parse_operation_receipt(
            load_metadata(runtime_dir, record_root, "kungfu.fact.operation-receipt/v1"), pending.back().document,
            operation_receipt_authority{
                fixed_string(record.operation_id), fixed_string(record.operation), fixed_string(record.status),
                failure_code.empty() ? std::nullopt : std::optional<std::string>{std::move(failure_code)},
                fixed_string(record.request_root), fixed_string(record.record_root),
                fixed_string(record.prior_cut_root), fixed_string(record.current_cut_root), record.prior_revision,
                record.current_revision, record.write_occurred != 0, record_root});
        if (pending.back().sequence + 1 != sequence ||
            pending.back().root_protocol != root_protocol_for_version(record.schema_version) ||
            pending.back().record_root != receipt.record_root) {
          add_issue(state, frame_tag, sequence, true, receipt.record_root, "receipt-pair-mismatch",
                    "Fact receipt does not pair with the immediately preceding record", "receipt-pairing",
                    "preserve-authority-and-run-fsck");
          break;
        }
        accepted_sequences.insert(pending.back().sequence);
        pending.back().receipt = receipt;
        state.receipts[fixed_string(record.operation_id)] = std::move(receipt);
        break;
      }
      case PageEnd::tag:
        break;
      default:
        add_issue(state, frame_tag, 0, false, {}, "unknown-frame-tag", "Fact journal frame tag is not recognized",
                  "dispatch", "preserve-authority-and-upgrade-reader");
        break;
      }
    } catch (const fact_authority_mismatch &error) {
      add_issue(state, frame_tag, sequence, sequence_known, record_root, "authority-record-mismatch", error.what(),
                "authority-validation", "preserve-authority-and-run-fsck");
    } catch (const std::exception &) {
      add_issue(state, frame_tag, sequence, sequence_known, record_root, "record-materialization-failed",
                "Fact record metadata could not be verified", "materialize", "preserve-authority-and-restore-content");
    }
    state.next_sequence = std::max(state.next_sequence, sequence + 1);
    reader->next();
  }
  // Every authoritative record and its accepted receipt are one logical
  // append decision. A torn or mismatched pair remains diagnostic material.
  for (const auto &record : pending) {
    if (accepted_sequences.count(record.sequence) == 0) {
      add_issue(state, record.tag, record.sequence, true, record.record_root, "record-receipt-missing",
                "Fact record has no accepted adjacent operation receipt", "receipt-pairing",
                "preserve-authority-and-run-fsck");
      continue;
    }
    state.authority_records.push_back(record);
    auto &accepted = state.authority_records.back();
    const auto successor_root = accepted.root_protocol == PORTABLE_ROOT_PROTOCOL
                                    ? accepted.record_root
                                    : metadata_root(domain_for_tag(accepted.tag), fact_document_json(accepted.document),
                                                    PORTABLE_ROOT_PROTOCOL);
    accepted.mapping_receipt =
        parse_root_mapping(root_mapping_receipt(domain_for_tag(accepted.tag), fact_document_json(accepted.document),
                                                successor_root, accepted.receipt.request_root));
    accepted.mapping_receipt_root = root_mapping_receipt_root(root_mapping_json(accepted.mapping_receipt));
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
