// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/action_recorder.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/time.h>

#include <cstring>

using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;

namespace kungfu::yijinjing::action {

action_recorder::action_recorder(const std::string &runtime_dir, const std::string &group, const std::string &name,
                                 uint32_t dest_id, uint64_t stream_id)
    : locator_(std::make_shared<locator>(runtime_dir, mode::LIVE)),
      location_(location::make_shared(mode::LIVE, category::SYSTEM, group, name, locator_)),
      publisher_(std::make_shared<noop_publisher>()), bus_(std::make_shared<bus>(false)),
      writer_(std::make_shared<writer>(location_, dest_id, true, publisher_, false, bus_)), dest_id_(dest_id),
      default_stream_id_(stream_id) {}

record_receipt action_recorder::record_bytes(int32_t msg_type, const std::vector<uint8_t> &payload,
                                             record_options options) {
  options.data_type = FrameDataType::Raw;
  return record_payload(msg_type, payload.data(), static_cast<uint32_t>(payload.size()), options);
}

record_receipt action_recorder::record_json(int32_t msg_type, const std::string &json_payload, record_options options) {
  options.data_type = FrameDataType::Json;
  return record_payload(msg_type, reinterpret_cast<const uint8_t *>(json_payload.data()),
                        static_cast<uint32_t>(json_payload.size()), options);
}

record_receipt action_recorder::mark(int32_t msg_type, record_options options) {
  options.data_type = FrameDataType::Raw;
  return record_payload(msg_type, nullptr, 0, options);
}

record_receipt action_recorder::record_payload(int32_t msg_type, const uint8_t *payload, uint32_t payload_length,
                                               record_options options) {
  const auto parent_frame_uid =
      options.parent_frame_uid != 0 ? options.parent_frame_uid : (options.chain_to_last ? last_frame_uid_ : 0);
  const auto stream_id = options.stream_id != 0 ? options.stream_id : default_stream_id_;
  const auto gen_time = options.gen_time != 0 ? options.gen_time : time::now_in_nano();

  bus::set_trigger_frame_uid(parent_frame_uid);
  auto frame = writer_->open_frame(options.trigger_time, msg_type, payload_length, stream_id);
  frame->set_data_type(options.data_type);
  if (payload_length > 0) {
    std::memcpy(const_cast<void *>(frame->data_address()), payload, payload_length);
  }
  const auto frame_uid = writer_->current_frame_uid();
  writer_->close_frame(payload_length, gen_time);
  bus::set_trigger_frame_uid(0);

  record_receipt receipt{};
  receipt.frame_uid = frame_uid;
  receipt.trigger_frame_uid = parent_frame_uid;
  receipt.stream_id = stream_id;
  receipt.gen_time = gen_time;
  receipt.trigger_time = options.trigger_time;
  receipt.msg_type = msg_type;
  receipt.source = location_->uid;
  receipt.initial_source = location_->uid;
  receipt.dest = dest_id_;
  receipt.data_length = payload_length;
  receipt.data_type = static_cast<int8_t>(options.data_type);
  last_frame_uid_ = receipt.frame_uid;
  return receipt;
}

} // namespace kungfu::yijinjing::action
