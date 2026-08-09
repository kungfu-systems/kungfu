// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/types.h>
#include <kungfu/yijinjing/storage/fact_ledger.h>

#include <cstdint>
#include <filesystem>
#include <iostream>
#include <memory>
#include <string>

namespace yy = kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

namespace {

template <std::size_t N> void set(kungfu::array<char, N> &target, const char *value) {
  kungfu::copy_string(target, value);
}

location_ptr make_location(const std::string &root) {
  auto locator = std::make_shared<yy::data::locator>(root, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, "kfd7-source", "consumer", locator);
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 2) {
    std::cerr << "usage: kungfu_kfd7_yijinjing_source_consumer <journal-root>\n";
    return 2;
  }

  const std::filesystem::path root = argv[1];
  yy::storage::fact_ledger_store facts(root);

  const auto journal_location = make_location(root.string());
  writer output(journal_location, location::PUBLIC, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));

  FactObjectRecorded object{};
  object.schema_version = 2;
  object.sequence = 1;
  set(object.object_id, "fact-object-1");
  set(object.object_type, "example");
  set(object.created_by_receipt_root, "sha256:1111111111111111111111111111111111111111111111111111111111111111");
  set(object.object_root, "sha256:2222222222222222222222222222222222222222222222222222222222222222");
  FactOperationReceipt object_receipt{};
  object_receipt.schema_version = 2;
  object_receipt.sequence = 2;
  object_receipt.write_occurred = 1;
  set(object_receipt.operation_id, "op:source-static-object");
  set(object_receipt.operation, "object-put");
  set(object_receipt.status, "accepted");
  set(object_receipt.record_root, object.object_root.value);
  set(object_receipt.request_root, "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
  set(object_receipt.receipt_root, "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
  facts.append(yy::storage::fact_record(object), object_receipt);

  EpisodeOpen episode{};
  episode.schema_version = 1;
  episode.episode_id = 7;
  episode.parent_episode_id = 0;
  episode.root_trigger_frame_uid = output.current_frame_uid();
  episode.location_uid = journal_location->uid;
  episode.begin_time = yy::time::now_in_nano();
  set(episode.title, "source-static-closure");
  set(episode.actor, "external-cpp");
  set(episode.source, "kfd7");
  output.write(0, episode);

  EpisodeClosed closed{};
  closed.schema_version = 1;
  closed.episode_id = episode.episode_id;
  closed.location_uid = episode.location_uid;
  closed.status = EpisodeStatus::Ended;
  closed.end_time = yy::time::now_in_nano();
  closed.frame_count = 2;
  set(closed.reason, "completed");
  output.write(0, closed);

  FactCutCommitted cut{};
  cut.schema_version = 2;
  cut.sequence = 3;
  set(cut.cut_root, "sha256:3333333333333333333333333333333333333333333333333333333333333333");
  set(cut.parent_cuts_root, "sha256:4444444444444444444444444444444444444444444444444444444444444444");
  set(cut.object_versions_root, "sha256:5555555555555555555555555555555555555555555555555555555555555555");
  set(cut.active_relations_root, "sha256:6666666666666666666666666666666666666666666666666666666666666666");
  set(cut.declaration_roots_root, "sha256:7777777777777777777777777777777777777777777777777777777777777777");
  set(cut.admission_roots_root, "sha256:8888888888888888888888888888888888888888888888888888888888888888");
  set(cut.episode_frontier_root, "sha256:9999999999999999999999999999999999999999999999999999999999999999");
  set(cut.omission_roots_root, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  set(cut.conflict_roots_root, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  FactOperationReceipt cut_receipt{};
  cut_receipt.schema_version = 2;
  cut_receipt.sequence = 4;
  cut_receipt.write_occurred = 1;
  set(cut_receipt.operation_id, "op:source-static-cut");
  set(cut_receipt.operation, "cut-put");
  set(cut_receipt.status, "accepted");
  set(cut_receipt.record_root, cut.cut_root.value);
  set(cut_receipt.request_root, "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  set(cut_receipt.receipt_root, "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  facts.append(yy::storage::fact_record(cut), cut_receipt);
  output.release_page();

  const auto fact_view = facts.replay();
  const auto recovery = facts.recovery_plan();
  const auto snapshot = root / "fact-ledger.snapshot";
  const auto snapshot_schema = facts.export_snapshot(snapshot);

  assemble input(journal_location, location::PUBLIC, AssembleMode::Channel, 0);
  uint32_t episode_records = 0;
  while (input.data_available()) {
    const auto tag = input.current_frame()->carrier_type();
    episode_records += tag == EpisodeOpen::tag || tag == EpisodeClosed::tag ? 1 : 0;
    input.next();
  }

  std::cout << "{\"consumer\":\"source-static-cpp\",\"fact_records\":" << fact_view.accepted.size()
            << ",\"episode_records\":" << episode_records << ",\"language_hosts\":0"
            << ",\"verified\":" << (fact_view.verified() ? "true" : "false") << ",\"recovery\":\"" << recovery.action
            << "\""
            << ",\"snapshot_schema\":\"" << snapshot_schema << "\"}\n";
  return fact_view.accepted.size() == 2 && fact_view.verified() && recovery.mutation_allowed &&
                 std::filesystem::file_size(snapshot) > 16 && episode_records == 2
             ? 0
             : 1;
}
