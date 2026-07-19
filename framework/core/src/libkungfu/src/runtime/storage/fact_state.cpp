// SPDX-License-Identifier: Apache-2.0

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
} // namespace

template <typename T> bool decode_record(const frame_ptr &frame, T &value) {
  if (frame->data_length() < sizeof(T)) {
    return false;
  }
  value = frame->data<T>();
  return value.schema_version == SCHEMA_VERSION;
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
    uint64_t sequence = 0;
    try {
      switch (frame->carrier_type()) {
      case FactObjectRecorded::tag: {
        FactObjectRecorded record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.object_root);
        pending.push_back({FactObjectRecorded::tag, sequence, fixed_string(record.object_id), root,
                           load_metadata(runtime_dir, root, "kungfu.fact.object/v1")});
        break;
      }
      case FactVersionRecorded::tag: {
        FactVersionRecorded record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.version_root);
        pending.push_back({FactVersionRecorded::tag, sequence, root, root,
                           load_metadata(runtime_dir, root, "kungfu.fact.version/v1")});
        break;
      }
      case FactRelationAdded::tag: {
        FactRelationAdded record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.relation_root);
        pending.push_back({FactRelationAdded::tag, sequence, root, root,
                           load_metadata(runtime_dir, root, "kungfu.fact.relation-add/v1")});
        break;
      }
      case FactRelationRevoked::tag: {
        FactRelationRevoked record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.revoke_root);
        pending.push_back({FactRelationRevoked::tag, sequence, fixed_string(record.relation_root), root,
                           load_metadata(runtime_dir, root, "kungfu.fact.relation-revoke/v1")});
        break;
      }
      case FactCutCommitted::tag: {
        FactCutCommitted record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.cut_root);
        pending.push_back(
            {FactCutCommitted::tag, sequence, root, root, load_metadata(runtime_dir, root, "kungfu.fact.cut/v1")});
        break;
      }
      case FactRefTransition::tag: {
        FactRefTransition record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.transition_root);
        auto document = load_metadata(runtime_dir, root, "kungfu.fact.ref-transition/v1");
        document["transition_root"] = root;
        document["revision"] = record.expected_old_revision + 1;
        pending.push_back(
            {FactRefTransition::tag, sequence, fixed_string(record.transition_id), root, std::move(document)});
        break;
      }
      case FactOperationReceipt::tag: {
        FactOperationReceipt record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        auto receipt =
            load_metadata(runtime_dir, fixed_string(record.receipt_root), "kungfu.fact.operation-receipt/v1");
        receipt["requestRoot"] = fixed_string(record.request_root);
        receipt["receiptRoot"] = fixed_string(record.receipt_root);
        receipt["writeOccurred"] = record.write_occurred != 0;
        if (pending.empty() || pending.back().sequence + 1 != sequence ||
            pending.back().record_root != receipt.value("recordRoot", std::string{})) {
          ++state.unknown_records;
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
        ++state.unknown_records;
        break;
      }
    } catch (const std::exception &) {
      ++state.unknown_records;
    }
    state.next_sequence = std::max(state.next_sequence, sequence + 1);
    reader->next();
  }
  // Every authoritative record and its accepted receipt are one logical
  // append decision. A torn or mismatched pair remains diagnostic material.
  for (const auto &record : pending) {
    if (accepted_sequences.count(record.sequence) == 0) {
      ++state.unknown_records;
      continue;
    }
    state.authority_records.push_back(record);
    switch (record.tag) {
    case FactObjectRecorded::tag:
      state.objects[record.key] = record.document;
      break;
    case FactVersionRecorded::tag:
      state.versions[record.key] = record.document;
      break;
    case FactRelationAdded::tag:
      state.relations[record.key] = record.document;
      break;
    case FactRelationRevoked::tag:
      state.revoked_relations.insert(record.key);
      state.revocations[record.record_root] = record.document;
      break;
    case FactCutCommitted::tag:
      state.cuts[record.key] = record.document;
      break;
    case FactRefTransition::tag:
      state.refs[record.document.at("refName").get<std::string>()] = {
          {"ref_name", record.document.at("refName")},
          {"cut_root", record.document.at("newCutRoot")},
          {"revision", record.document.at("revision")},
          {"transition_id", record.document.at("transitionId")},
          {"transition_root", record.document.at("transition_root")}};
      state.transitions[record.key] = record.document;
      break;
    default:
      ++state.unknown_records;
      break;
    }
  }
  return state;
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
