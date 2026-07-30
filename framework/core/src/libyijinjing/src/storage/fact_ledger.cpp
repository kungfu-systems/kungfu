// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/fact_ledger.h>

#include <algorithm>
#include <array>
#include <fstream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <type_traits>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::yijinjing::storage {

namespace {
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

template <size_t N> std::string fixed_string(const kungfu::array<char, N> &value) {
  size_t length = 0;
  while (length < N && value.value[length] != '\0')
    ++length;
  return std::string(value.value, length);
}

location_ptr ledger_location(const std::filesystem::path &runtime_root) {
  auto locator = std::make_shared<data::locator>(runtime_root.string(), mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, FACT_LEDGER_NAMESPACE, FACT_LEDGER_NAME, locator);
}

bool supported_schema(uint32_t schema_version) {
  return schema_version == FACT_LEDGER_RECORD_SCHEMA_V1 || schema_version == FACT_LEDGER_RECORD_SCHEMA_V2;
}

template <typename Record> std::optional<fact_authority_record> decode_record(const frame_ptr &frame) {
  if (frame->data_length() < sizeof(Record))
    return std::nullopt;
  const auto record = frame->data<Record>();
  if (!supported_schema(record.schema_version))
    return std::nullopt;
  return fact_record(record);
}

std::optional<fact_authority_record> decode_authority_record(const frame_ptr &frame) {
  switch (frame->carrier_type()) {
  case FactObjectRecorded::tag:
    return decode_record<FactObjectRecorded>(frame);
  case FactVersionRecorded::tag:
    return decode_record<FactVersionRecorded>(frame);
  case FactRelationAdded::tag:
    return decode_record<FactRelationAdded>(frame);
  case FactRelationRevoked::tag:
    return decode_record<FactRelationRevoked>(frame);
  case FactCutCommitted::tag:
    return decode_record<FactCutCommitted>(frame);
  case FactRefTransition::tag:
    return decode_record<FactRefTransition>(frame);
  default:
    return std::nullopt;
  }
}

void write_record(writer &output, const fact_authority_record &record) {
  if (std::visit([](const auto &value) { return static_cast<uint32_t>(std::decay_t<decltype(value)>::tag); },
                 record.value) != record.tag)
    throw std::invalid_argument("fact-ledger-record-tag-unsupported");
  std::visit([&](const auto &value) { output.write_at(time::now_in_nano(), 0, value); }, record.value);
}

template <typename Value> void write_scalar(std::ofstream &output, const Value &value) {
  output.write(reinterpret_cast<const char *>(&value), sizeof(value));
}

void write_record_bytes(std::ofstream &output, const fact_record_variant &record) {
  std::visit(
      [&](const auto &value) {
        output.write(reinterpret_cast<const char *>(&value), static_cast<std::streamsize>(sizeof(value)));
      },
      record);
}
} // namespace

fact_ledger_store::fact_ledger_store(std::filesystem::path runtime_root) : runtime_root_(std::move(runtime_root)) {
  if (runtime_root_.empty())
    throw std::invalid_argument("fact-ledger-runtime-root-empty");
}

fact_ledger_view fact_ledger_store::replay() const {
  fact_ledger_view view;
  const auto target = ledger_location(runtime_root_);
  if (target->locator->list_page_id(target, location::PUBLIC).empty())
    return view;

  auto input = std::make_shared<reader>(true, false, std::make_shared<bus>(false));
  input->join(target, location::PUBLIC, 0);
  std::optional<fact_authority_record> pending;
  while (input->data_available()) {
    const auto frame = input->current_frame();
    const auto tag = static_cast<uint32_t>(frame->carrier_type());
    if (tag == static_cast<uint32_t>(PageEnd::tag)) {
      input->next();
      continue;
    }
    if (tag == static_cast<uint32_t>(FactOperationReceipt::tag)) {
      if (frame->data_length() < sizeof(FactOperationReceipt)) {
        view.issues.push_back({tag, 0, false, {}, "receipt-decode-failed"});
      } else {
        const auto receipt = frame->data<FactOperationReceipt>();
        view.next_sequence = std::max(view.next_sequence, receipt.sequence + 1);
        const auto receipt_record_root = fixed_string(receipt.record_root);
        if (!supported_schema(receipt.schema_version)) {
          view.issues.push_back({tag, receipt.sequence, true, receipt_record_root, "receipt-version-unsupported"});
        } else if (!pending || pending->sequence + 1 != receipt.sequence ||
                   pending->schema_version != receipt.schema_version || pending->record_root != receipt_record_root) {
          view.issues.push_back({tag, receipt.sequence, true, receipt_record_root, "receipt-pair-mismatch"});
        } else {
          view.accepted.push_back({std::move(*pending), receipt});
        }
      }
      pending.reset();
      input->next();
      continue;
    }

    if (pending) {
      view.issues.push_back({pending->tag, pending->sequence, true, pending->record_root, "record-receipt-missing"});
      pending.reset();
    }
    auto record = decode_authority_record(frame);
    if (!record) {
      view.issues.push_back({tag, 0, false, {}, "record-decode-or-tag-unsupported"});
    } else {
      view.next_sequence = std::max(view.next_sequence, record->sequence + 1);
      pending = std::move(record);
    }
    input->next();
  }
  if (pending)
    view.issues.push_back({pending->tag, pending->sequence, true, pending->record_root, "record-receipt-missing"});
  return view;
}

fact_ledger_recovery_plan fact_ledger_store::recovery_plan() const {
  const auto view = replay();
  return {true, view.verified(),
          view.verified() ? "resume-authoritative-append" : "preserve-authority-and-repair-evidence", view.issues};
}

void fact_ledger_store::append(const fact_authority_record &record, const FactOperationReceipt &receipt) const {
  const auto intrinsic = std::visit([](const auto &value) { return fact_record(value); }, record.value);
  if (record.tag != intrinsic.tag || record.schema_version != intrinsic.schema_version ||
      record.sequence != intrinsic.sequence || record.record_root != intrinsic.record_root)
    throw std::invalid_argument("fact-ledger-record-envelope-mismatch");
  if (!supported_schema(record.schema_version) || record.schema_version != receipt.schema_version)
    throw std::invalid_argument("fact-ledger-schema-version-mismatch");
  if (record.sequence + 1 != receipt.sequence || record.record_root != fixed_string(receipt.record_root))
    throw std::invalid_argument("fact-ledger-receipt-pair-mismatch");
  writer output(ledger_location(runtime_root_), location::PUBLIC, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));
  write_record(output, record);
  output.write_at(time::now_in_nano(), 0, receipt);
}

std::string fact_ledger_store::export_snapshot(const std::filesystem::path &destination) const {
  const auto view = replay();
  if (!view.verified())
    throw std::runtime_error("fact-ledger-export-refuses-unverified-authority");
  std::filesystem::create_directories(destination.parent_path());
  std::ofstream output(destination, std::ios::binary | std::ios::trunc);
  if (!output)
    throw std::runtime_error("fact-ledger-export-open-failed");
  constexpr std::array<char, 8> magic = {'K', 'F', 'F', 'A', 'C', 'T', '0', '1'};
  output.write(magic.data(), magic.size());
  const auto count = static_cast<uint64_t>(view.accepted.size());
  write_scalar(output, count);
  for (const auto &pair : view.accepted) {
    write_scalar(output, pair.record.tag);
    const auto record_size =
        std::visit([](const auto &value) { return static_cast<uint32_t>(sizeof(value)); }, pair.record.value);
    write_scalar(output, record_size);
    write_record_bytes(output, pair.record.value);
    const auto receipt_size = static_cast<uint32_t>(sizeof(pair.receipt));
    write_scalar(output, receipt_size);
    output.write(reinterpret_cast<const char *>(&pair.receipt), sizeof(pair.receipt));
  }
  if (!output)
    throw std::runtime_error("fact-ledger-export-write-failed");
  return FACT_LEDGER_SNAPSHOT_V1;
}

} // namespace kungfu::yijinjing::storage
