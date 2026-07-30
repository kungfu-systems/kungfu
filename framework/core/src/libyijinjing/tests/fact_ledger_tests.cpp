// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/yijinjing/storage/fact_ledger.h>

#include <chrono>
#include <filesystem>
#include <stdexcept>
#include <string>

namespace yy = kungfu::yijinjing;
using namespace kungfu::yijinjing::types;

namespace {
template <std::size_t N> void set(kungfu::array<char, N> &target, const char *value) {
  kungfu::copy_string(target, value);
}

void require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}
} // namespace

int main() {
  const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = std::filesystem::temp_directory_path() / ("kungfu-fact-ledger-" + std::to_string(nonce));
  std::filesystem::remove_all(root);

  yy::storage::fact_ledger_store store(root);
  FactObjectRecorded record{};
  record.schema_version = yy::storage::FACT_LEDGER_RECORD_SCHEMA_V2;
  record.sequence = 1;
  set(record.object_id, "fact:00000000000000000000000000000001");
  set(record.object_type, "qualification");
  set(record.created_by_receipt_root, "sha256:1111111111111111111111111111111111111111111111111111111111111111");
  set(record.object_root, "sha256:2222222222222222222222222222222222222222222222222222222222222222");

  FactOperationReceipt receipt{};
  receipt.schema_version = record.schema_version;
  receipt.sequence = 2;
  receipt.write_occurred = 1;
  set(receipt.operation_id, "op:fact-ledger-test");
  set(receipt.operation, "object-put");
  set(receipt.status, "accepted");
  set(receipt.record_root, record.object_root.value);
  set(receipt.request_root, "sha256:3333333333333333333333333333333333333333333333333333333333333333");
  set(receipt.receipt_root, "sha256:4444444444444444444444444444444444444444444444444444444444444444");

  store.append(yy::storage::fact_record(record), receipt);
  const auto replay = store.replay();
  require(replay.verified(), "replayed authority must verify");
  require(replay.accepted.size() == 1, "one authority pair must replay");
  require(replay.next_sequence == 3, "replay must restore the next sequence");
  require(replay.accepted.front().record.record_root == record.object_root.value, "record root must round trip");

  const auto plan = store.recovery_plan();
  require(plan.authority_readable, "recovery must read the authority");
  require(plan.mutation_allowed, "verified authority must permit append");
  require(plan.action == "resume-authoritative-append", "verified recovery action must resume");

  const auto snapshot = root / "exports" / "authority.kffact";
  require(store.export_snapshot(snapshot) == yy::storage::FACT_LEDGER_SNAPSHOT_V1, "snapshot schema must be explicit");
  require(std::filesystem::file_size(snapshot) > 16, "snapshot must contain the authority pair");

  auto bad_receipt = receipt;
  bad_receipt.sequence = 9;
  bool rejected = false;
  try {
    store.append(yy::storage::fact_record(record), bad_receipt);
  } catch (const std::invalid_argument &) {
    rejected = true;
  }
  require(rejected, "mismatched receipt must fail closed");

  auto mismatched_record = yy::storage::fact_record(record);
  mismatched_record.record_root = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
  rejected = false;
  try {
    store.append(mismatched_record, receipt);
  } catch (const std::invalid_argument &) {
    rejected = true;
  }
  require(rejected, "an envelope that disagrees with its typed record must fail closed");

  std::filesystem::remove_all(root);
  return 0;
}
