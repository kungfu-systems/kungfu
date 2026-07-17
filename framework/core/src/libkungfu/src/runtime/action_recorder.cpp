// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/io.h>
#include <kungfu/yijinjing/time.h>

#include <array>
#include <cstring>
#include <stdexcept>
#include <string>
#include <type_traits>

using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::journal;

namespace kungfu::runtime::action {

namespace {
constexpr uint64_t FNV1A64_OFFSET = 14695981039346656037ull;
constexpr uint64_t FNV1A64_PRIME = 1099511628211ull;
constexpr uint32_t CRC32C_INITIAL = 0xffffffffu;
constexpr uint32_t CRC32C_XOR_OUT = 0xffffffffu;
constexpr uint32_t CRC32C_REVERSED_POLY = 0x82f63b78u;

class trigger_frame_scope {
public:
  explicit trigger_frame_scope(uint64_t frame_uid) { bus::set_trigger_frame_uid(frame_uid); }
  trigger_frame_scope(const trigger_frame_scope &) = delete;
  trigger_frame_scope &operator=(const trigger_frame_scope &) = delete;
  ~trigger_frame_scope() { bus::set_trigger_frame_uid(0); }
};

uint32_t align_frame_payload_length(uint32_t length) {
  return static_cast<uint32_t>((length + (sizeof(uintptr_t) - 1)) & ~(sizeof(uintptr_t) - 1));
}

void checksum_byte(uint64_t &state, uint8_t value) {
  state ^= static_cast<uint64_t>(value);
  state *= FNV1A64_PRIME;
}

void checksum_bytes(uint64_t &state, const uint8_t *data, size_t size) {
  for (size_t i = 0; i < size; ++i) {
    checksum_byte(state, data[i]);
  }
}

template <typename T> void checksum_scalar(uint64_t &state, const T &value) {
  static_assert(std::is_integral_v<T>);
  using unsigned_t = std::make_unsigned_t<T>;
  auto raw = static_cast<unsigned_t>(value);
  for (size_t i = 0; i < sizeof(T); ++i) {
    checksum_byte(state, static_cast<uint8_t>((raw >> (i * 8)) & 0xffu));
  }
}

const std::array<uint32_t, 256> &crc32c_table() {
  static const auto table = [] {
    std::array<uint32_t, 256> result{};
    for (uint32_t i = 0; i < result.size(); ++i) {
      uint32_t crc = i;
      for (int bit = 0; bit < 8; ++bit) {
        crc = (crc >> 1u) ^ ((crc & 1u) != 0u ? CRC32C_REVERSED_POLY : 0u);
      }
      result[i] = crc;
    }
    return result;
  }();
  return table;
}

void checksum_crc32c_bytes(uint32_t &state, const uint8_t *data, size_t size) {
  const auto &table = crc32c_table();
  for (size_t i = 0; i < size; ++i) {
    state = (state >> 8u) ^ table[(state ^ data[i]) & 0xffu];
  }
}

template <typename T> void checksum_crc32c_scalar(uint32_t &state, const T &value) {
  static_assert(std::is_integral_v<T>);
  using unsigned_t = std::make_unsigned_t<T>;
  auto raw = static_cast<unsigned_t>(value);
  for (size_t i = 0; i < sizeof(T); ++i) {
    const auto byte = static_cast<uint8_t>((raw >> (i * 8)) & 0xffu);
    checksum_crc32c_bytes(state, &byte, 1);
  }
}

uint64_t finalize_crc32c(uint32_t state) { return static_cast<uint64_t>(state ^ CRC32C_XOR_OUT); }

bool is_fnv1a64(const std::string &algorithm) { return algorithm == FRAME_CHECKSUM_ALGORITHM_FNV1A64; }

bool is_crc32c(const std::string &algorithm) { return algorithm == FRAME_CHECKSUM_ALGORITHM_CRC32C; }
} // namespace

bool is_supported_frame_checksum_algorithm(const std::string &algorithm) {
  return is_fnv1a64(algorithm) || is_crc32c(algorithm);
}

std::string frame_checksum_algorithm_for_integrity_version(uint32_t integrity_version) {
  switch (integrity_version) {
  case FRAME_INTEGRITY_VERSION_V1:
    return FRAME_CHECKSUM_ALGORITHM_FNV1A64;
  case FRAME_INTEGRITY_VERSION_V2:
    return FRAME_CHECKSUM_ALGORITHM_CRC32C;
  default:
    throw std::invalid_argument("unsupported frame integrity version: " + std::to_string(integrity_version));
  }
}

uint32_t frame_integrity_version_for_checksum_algorithm(const std::string &algorithm) {
  if (is_fnv1a64(algorithm)) {
    return FRAME_INTEGRITY_VERSION_V1;
  }
  if (is_crc32c(algorithm)) {
    return FRAME_INTEGRITY_VERSION_V2;
  }
  throw std::invalid_argument("unsupported frame checksum algorithm: " + algorithm);
}

uint64_t checksum_payload(const uint8_t *payload, uint32_t payload_length, const std::string &algorithm) {
  if (is_crc32c(algorithm)) {
    uint32_t state = CRC32C_INITIAL;
    if (payload != nullptr and payload_length > 0) {
      checksum_crc32c_bytes(state, payload, payload_length);
    }
    return finalize_crc32c(state);
  }
  if (!is_fnv1a64(algorithm)) {
    throw std::invalid_argument("unsupported frame checksum algorithm: " + algorithm);
  }
  uint64_t state = FNV1A64_OFFSET;
  if (payload != nullptr and payload_length > 0) {
    checksum_bytes(state, payload, payload_length);
  }
  return state;
}

uint64_t checksum_frame(const yijinjing::types::frame_header &header, const uint8_t *payload, uint32_t payload_length,
                        const std::string &algorithm) {
  if (is_crc32c(algorithm)) {
    uint32_t state = CRC32C_INITIAL;
    checksum_crc32c_scalar(state, header.length);
    checksum_crc32c_scalar(state, header.header_length);
    checksum_crc32c_scalar(state, header.gen_time);
    checksum_crc32c_scalar(state, header.trigger_time);
    checksum_crc32c_scalar(state, header.carrier_type);
    checksum_crc32c_scalar(state, header.source);
    checksum_crc32c_scalar(state, header.dest);
    const auto data_type = static_cast<int8_t>(header.data_type);
    checksum_crc32c_scalar(state, data_type);
    checksum_crc32c_scalar(state, header.initial_source);
    checksum_crc32c_scalar(state, header.journal_frame_uid);
    checksum_crc32c_scalar(state, header.trigger_frame_uid);
    checksum_crc32c_scalar(state, header.stream_id);
    checksum_crc32c_scalar(state, payload_length);
    if (payload != nullptr and payload_length > 0) {
      checksum_crc32c_bytes(state, payload, payload_length);
    }
    return finalize_crc32c(state);
  }
  if (!is_fnv1a64(algorithm)) {
    throw std::invalid_argument("unsupported frame checksum algorithm: " + algorithm);
  }
  uint64_t state = FNV1A64_OFFSET;
  checksum_scalar(state, header.length);
  checksum_scalar(state, header.header_length);
  checksum_scalar(state, header.gen_time);
  checksum_scalar(state, header.trigger_time);
  checksum_scalar(state, header.carrier_type);
  checksum_scalar(state, header.source);
  checksum_scalar(state, header.dest);
  const auto data_type = static_cast<int8_t>(header.data_type);
  checksum_scalar(state, data_type);
  checksum_scalar(state, header.initial_source);
  checksum_scalar(state, header.journal_frame_uid);
  checksum_scalar(state, header.trigger_frame_uid);
  checksum_scalar(state, header.stream_id);
  checksum_scalar(state, payload_length);
  if (payload != nullptr and payload_length > 0) {
    checksum_bytes(state, payload, payload_length);
  }
  return state;
}

action_recorder::action_recorder(const std::string &runtime_dir, const std::string &namespace_, const std::string &name,
                                 uint32_t dest_id, uint64_t stream_id)
    : locator_(std::make_shared<locator>(runtime_dir, mode::LIVE)),
      location_(location::make_shared(mode::LIVE, location_role::SYSTEM, namespace_, name, locator_)),
      publisher_(std::make_shared<noop_publisher>()), bus_(std::make_shared<bus>(false)),
      writer_(std::make_shared<writer>(location_, dest_id, publisher_, false, bus_)), dest_id_(dest_id),
      default_stream_id_(stream_id) {}

record_receipt action_recorder::record_bytes(int32_t carrier_type, const std::vector<uint8_t> &payload,
                                             record_options options) {
  options.data_type = FrameDataType::Raw;
  return record_payload(carrier_type, payload.data(), static_cast<uint32_t>(payload.size()), options);
}

record_receipt action_recorder::record_json(int32_t carrier_type, const std::string &json_payload,
                                            record_options options) {
  options.data_type = FrameDataType::Json;
  return record_payload(carrier_type, reinterpret_cast<const uint8_t *>(json_payload.data()),
                        static_cast<uint32_t>(json_payload.size()), options);
}

record_receipt action_recorder::record_action(const view::action::envelope &envelope, record_options options) {
  const auto payload = view::action::encode(envelope);
  options.data_type = FrameDataType::Raw;
  return record_payload(view::action::ACTION_ENVELOPE_CARRIER_TYPE, payload.data(),
                        static_cast<uint32_t>(payload.size()), options);
}

record_receipt action_recorder::mark(int32_t carrier_type, record_options options) {
  options.data_type = FrameDataType::Raw;
  return record_payload(carrier_type, nullptr, 0, options);
}

record_receipt action_recorder::record_payload(int32_t carrier_type, const uint8_t *payload, uint32_t payload_length,
                                               record_options options) {
  const auto parent_frame_uid =
      options.parent_frame_uid != 0 ? options.parent_frame_uid : (options.chain_to_last ? last_frame_uid_ : 0);
  const auto stream_id = options.stream_id != 0 ? options.stream_id : default_stream_id_;
  const auto gen_time = options.gen_time != 0 ? options.gen_time : time::now_in_nano();

  const trigger_frame_scope trigger_scope(parent_frame_uid);
  auto tx = writer_->reserve_frame(options.trigger_time, carrier_type, payload_length, stream_id);
  auto frame = tx.frame();
  frame->set_data_type(options.data_type);
  if (payload_length > 0) {
    std::memcpy(const_cast<void *>(frame->data_address()), payload, payload_length);
  }
  const auto frame_uid = writer_->current_frame_uid();
  auto checksum_header = *reinterpret_cast<const yijinjing::types::frame_header *>(frame->address());
  checksum_header.length = checksum_header.header_length + align_frame_payload_length(payload_length);
  checksum_header.gen_time = gen_time;
  checksum_header.journal_frame_uid = frame_uid;
  checksum_header.trigger_frame_uid = parent_frame_uid;
  const auto checksum_algorithm = frame_checksum_algorithm_for_integrity_version(DEFAULT_FRAME_INTEGRITY_VERSION);
  const auto payload_checksum = checksum_payload(payload, payload_length, checksum_algorithm);
  const auto frame_checksum = checksum_frame(checksum_header, payload, payload_length, checksum_algorithm);
  tx.commit(payload_length, gen_time);
  record_receipt receipt{};
  receipt.frame_uid = frame_uid;
  receipt.trigger_frame_uid = parent_frame_uid;
  receipt.stream_id = stream_id;
  receipt.gen_time = gen_time;
  receipt.trigger_time = options.trigger_time;
  receipt.carrier_type = carrier_type;
  receipt.source = location_->uid;
  receipt.initial_source = location_->uid;
  receipt.dest = dest_id_;
  receipt.data_length = payload_length;
  receipt.data_type = static_cast<int8_t>(options.data_type);
  receipt.integrity_version = DEFAULT_FRAME_INTEGRITY_VERSION;
  receipt.checksum_algorithm = checksum_algorithm;
  receipt.payload_checksum = payload_checksum;
  receipt.frame_checksum = frame_checksum;
  last_frame_uid_ = receipt.frame_uid;
  return receipt;
}

} // namespace kungfu::runtime::action
