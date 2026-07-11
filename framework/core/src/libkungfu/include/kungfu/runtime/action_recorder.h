// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_ACTION_RECORDER_H
#define KUNGFU_YIJINJING_ACTION_RECORDER_H

#include <kungfu/runtime/common.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>

#include <cstdint>
#include <string>
#include <vector>

namespace kungfu::runtime::action {

inline constexpr uint32_t FRAME_INTEGRITY_VERSION_V1 = 1;
inline constexpr uint32_t FRAME_INTEGRITY_VERSION_V2 = 2;
inline constexpr uint32_t DEFAULT_FRAME_INTEGRITY_VERSION = FRAME_INTEGRITY_VERSION_V2;
inline constexpr const char *FRAME_CHECKSUM_ALGORITHM_FNV1A64 = "fnv1a64";
inline constexpr const char *FRAME_CHECKSUM_ALGORITHM_CRC32C = "crc32c";
inline constexpr const char *DEFAULT_FRAME_CHECKSUM_ALGORITHM = FRAME_CHECKSUM_ALGORITHM_CRC32C;

struct record_options {
  int64_t gen_time = 0;
  int64_t trigger_time = 0;
  uint64_t parent_frame_uid = 0;
  uint64_t stream_id = 0;
  bool chain_to_last = true;
  yijinjing::enums::FrameDataType data_type = yijinjing::enums::FrameDataType::Raw;
};

struct record_receipt {
  uint64_t frame_uid = 0;
  uint64_t trigger_frame_uid = 0;
  uint64_t stream_id = 0;
  int64_t gen_time = 0;
  int64_t trigger_time = 0;
  int32_t carrier_type = 0;
  uint32_t source = 0;
  uint32_t initial_source = 0;
  uint32_t dest = 0;
  uint32_t data_length = 0;
  int8_t data_type = 0;
  uint32_t integrity_version = 0;
  std::string checksum_algorithm = {};
  uint64_t payload_checksum = 0;
  uint64_t frame_checksum = 0;
};

[[nodiscard]] bool is_supported_frame_checksum_algorithm(const std::string &algorithm);

[[nodiscard]] std::string frame_checksum_algorithm_for_integrity_version(uint32_t integrity_version);

[[nodiscard]] uint32_t frame_integrity_version_for_checksum_algorithm(const std::string &algorithm);

[[nodiscard]] uint64_t checksum_payload(const uint8_t *payload, uint32_t payload_length,
                                        const std::string &algorithm = DEFAULT_FRAME_CHECKSUM_ALGORITHM);

[[nodiscard]] uint64_t checksum_frame(const yijinjing::types::frame_header &header, const uint8_t *payload,
                                      uint32_t payload_length,
                                      const std::string &algorithm = DEFAULT_FRAME_CHECKSUM_ALGORITHM);

class action_recorder {
public:
  action_recorder(const std::string &runtime_dir, const std::string &namespace_, const std::string &name,
                  uint32_t dest_id = yijinjing::data::location::PUBLIC, uint64_t stream_id = 0);

  record_receipt record_bytes(int32_t carrier_type, const std::vector<uint8_t> &payload, record_options options = {});

  record_receipt record_json(int32_t carrier_type, const std::string &json_payload, record_options options = {});

  record_receipt record_action(const view::action::envelope &envelope, record_options options = {});

  record_receipt mark(int32_t carrier_type, record_options options = {});

  [[nodiscard]] uint64_t last_frame_uid() const { return last_frame_uid_; }

  [[nodiscard]] const data::location_ptr &get_location() const { return location_; }

private:
  record_receipt record_payload(int32_t carrier_type, const uint8_t *payload, uint32_t payload_length,
                                record_options options);

  data::locator_ptr locator_;
  data::location_ptr location_;
  publisher_ptr publisher_;
  journal::bus_ptr bus_;
  journal::writer_ptr writer_;
  uint32_t dest_id_;
  uint64_t default_stream_id_;
  uint64_t last_frame_uid_ = 0;
};

DECLARE_PTR(action_recorder)

} // namespace kungfu::runtime::action

#endif // KUNGFU_YIJINJING_ACTION_RECORDER_H
