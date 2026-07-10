// SPDX-License-Identifier: Apache-2.0

#include "probe.h"

#include <kungfu/embedding.hpp>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <vector>

namespace {

using clock_type = std::chrono::steady_clock;

uint64_t percentile(std::vector<uint64_t> values, double quantile) {
  std::sort(values.begin(), values.end());
  const auto index = static_cast<std::size_t>((values.size() - 1) * quantile);
  return values[index];
}

uint64_t consume(const kf_embedding_frame_v1 &frame) {
  uint64_t value = frame.msg_type;
  if (frame.data_size != 0) {
    value ^= frame.data[0];
    value ^= static_cast<uint64_t>(frame.data[frame.data_size - 1]) << 8U;
  }
  return value;
}

} // namespace

extern "C" KF_NATIVE_PROBE_EXPORT int32_t KF_EMBEDDING_CALL kf_native_probe_run_v1(const kf_embedding_api_v1 *api,
                                                                                   const char *root,
                                                                                   kf_native_probe_report_v1 *report) {
  try {
    if (api == nullptr || root == nullptr || report == nullptr || report->struct_size < sizeof(*report) ||
        api->abi_version != KF_EMBEDDING_ABI_V1 || api->struct_size < sizeof(*api)) {
      return 10;
    }

    kf_embedding_context_config_v1 config{};
    config.struct_size = sizeof(config);
    config.root = root;
    config.host_namespace = "shared_membrane";
    config.host_name = "native_kfx";
    config.mode = KF_EMBEDDING_MODE_LIVE;
    kungfu::embedding::context context(*api, config);

    std::vector<uint64_t> control_times;
    control_times.reserve(10000);
    for (int i = 0; i < 10000; ++i) {
      uint64_t capabilities = 0;
      const auto start = clock_type::now();
      kungfu::embedding::require_ok(api->context_capabilities(context.get(), &capabilities), "context_capabilities");
      const auto end = clock_type::now();
      if ((capabilities & KF_EMBEDDING_CAP_READ_JOURNAL_BATCH) == 0) {
        return 11;
      }
      control_times.push_back(std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count());
    }

    kf_embedding_location_v1 location{};
    location.struct_size = sizeof(location);
    location.namespace_name = "shared_membrane";
    location.name = "fixture";
    location.mode = KF_EMBEDDING_MODE_LIVE;
    location.role = KF_EMBEDDING_ROLE_SYSTEM;
    kungfu::embedding::reader reader(context, location);

    std::vector<uint64_t> batch_times;
    batch_times.reserve(100);
    uint64_t checksum = 0;
    for (int i = 0; i < 100; ++i) {
      const auto start = clock_type::now();
      auto batch = reader.read_batch(16);
      const auto end = clock_type::now();
      if (batch.size() != 16 || batch.payload_bytes() != 4096 || batch.payload_bytes_copied() != 0) {
        return 12;
      }
      if (report->first_payload_address == 0) {
        report->first_payload_address = reinterpret_cast<uintptr_t>(batch.begin()->data);
      }
      for (const auto &frame : batch) {
        checksum ^= consume(frame);
      }
      ++report->batch_calls;
      report->frame_count += batch.size();
      report->payload_bytes += batch.payload_bytes();
      report->payload_bytes_copied += batch.payload_bytes_copied();
      batch_times.push_back(std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count());
    }

    {
      auto batch = reader.read_batch(1);
      if (batch.size() != 1 || batch.payload_bytes() != 1024U * 1024U || batch.payload_bytes_copied() != 0) {
        return 13;
      }
      report->one_mib_payload_bytes = batch.payload_bytes();
      report->payload_bytes_copied += batch.payload_bytes_copied();
      checksum ^= consume(*batch.begin());
    }
    if (reader.read_batch(1).size() != 0) {
      return 14;
    }

    report->control_p50_ns = percentile(control_times, 0.50);
    report->control_p99_ns = percentile(control_times, 0.99);
    report->batch_4k_p50_ns = percentile(batch_times, 0.50);
    report->batch_4k_p99_ns = percentile(batch_times, 0.99);
    report->checksum = checksum;
    return 0;
  } catch (...) {
    return 99;
  }
}
