// SPDX-License-Identifier: Apache-2.0

#include <kungfu/embedding.h>
#include <kungfu/runtime/io.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <new>
#include <vector>

using namespace kungfu::yijinjing;

namespace {

constexpr uint64_t CAPABILITIES = KF_EMBEDDING_CAP_READ_JOURNAL_BATCH | KF_EMBEDDING_CAP_MMAP_PAYLOAD_VIEW;

bool valid_mode(uint8_t mode) { return mode <= KF_EMBEDDING_MODE_BACKTEST; }
bool valid_role(uint8_t role) { return role <= KF_EMBEDDING_ROLE_SERVICE; }

template <typename F> int32_t contain_exceptions(F &&operation) noexcept {
  try {
    return operation();
  } catch (...) {
    return KF_EMBEDDING_CORE_ERROR;
  }
}

} // namespace

struct kf_embedding_context {
  std::shared_ptr<data::locator> locator;
  data::location_ptr home;
  std::shared_ptr<kungfu::runtime::io_device> io;
  uint32_t active_readers = 0;
};

struct kf_embedding_reader {
  kf_embedding_context *owner = nullptr;
  journal::reader_ptr reader;
  std::vector<kf_embedding_frame_v1> frames;
  std::vector<journal::page_ptr> held_pages;
  uint64_t next_token = 1;
  uint64_t outstanding_token = 0;
};

namespace {

int32_t KF_EMBEDDING_CALL context_open(const kf_embedding_context_config_v1 *config,
                                       kf_embedding_context **out_context) noexcept {
  return contain_exceptions([&]() -> int32_t {
    if (config == nullptr || out_context == nullptr || config->struct_size < sizeof(*config) ||
        config->root == nullptr || config->host_namespace == nullptr || config->host_name == nullptr ||
        !valid_mode(config->mode)) {
      return KF_EMBEDDING_INVALID_ARGUMENT;
    }
    *out_context = nullptr;
    auto result = std::make_unique<kf_embedding_context>();
    result->locator = std::make_shared<data::locator>(config->root);
    result->home = data::location::make_shared(static_cast<enums::mode>(config->mode), enums::location_role::SYSTEM,
                                               config->host_namespace, config->host_name, result->locator);
    const bool low_latency = (config->flags & KF_EMBEDDING_CONTEXT_LOW_LATENCY) != 0;
    result->io = std::make_shared<kungfu::runtime::io_device>(result->home, low_latency, /*lazy=*/true);
    *out_context = result.release();
    return KF_EMBEDDING_OK;
  });
}

int32_t KF_EMBEDDING_CALL context_capabilities(const kf_embedding_context *context,
                                               uint64_t *out_capabilities) noexcept {
  if (context == nullptr || out_capabilities == nullptr) {
    return KF_EMBEDDING_INVALID_ARGUMENT;
  }
  *out_capabilities = CAPABILITIES;
  return KF_EMBEDDING_OK;
}

int32_t KF_EMBEDDING_CALL context_close(kf_embedding_context *context) noexcept {
  return contain_exceptions([&]() -> int32_t {
    if (context == nullptr) {
      return KF_EMBEDDING_INVALID_ARGUMENT;
    }
    if (context->active_readers != 0) {
      return KF_EMBEDDING_BUSY;
    }
    delete context;
    return KF_EMBEDDING_OK;
  });
}

int32_t KF_EMBEDDING_CALL reader_open(kf_embedding_context *context, const kf_embedding_location_v1 *location,
                                      kf_embedding_reader **out_reader) noexcept {
  return contain_exceptions([&]() -> int32_t {
    if (context == nullptr || location == nullptr || out_reader == nullptr ||
        location->struct_size < sizeof(*location) || location->namespace_name == nullptr || location->name == nullptr ||
        !valid_mode(location->mode) || !valid_role(location->role)) {
      return KF_EMBEDDING_INVALID_ARGUMENT;
    }
    *out_reader = nullptr;
    auto result = std::make_unique<kf_embedding_reader>();
    result->owner = context;
    auto source = data::location::make_shared(static_cast<enums::mode>(location->mode),
                                              static_cast<enums::location_role>(location->role),
                                              location->namespace_name, location->name, context->locator);
    result->reader = context->io->open_reader(source, location->dest_id);
    result->reader->seek_to_time(location->from_time);
    ++context->active_readers;
    *out_reader = result.release();
    return KF_EMBEDDING_OK;
  });
}

int32_t KF_EMBEDDING_CALL reader_read_batch(kf_embedding_reader *reader, uint32_t max_frames,
                                            kf_embedding_batch_v1 *out_batch) noexcept {
  return contain_exceptions([&]() -> int32_t {
    if (reader == nullptr || out_batch == nullptr || out_batch->struct_size < sizeof(*out_batch) || max_frames == 0 ||
        max_frames > KF_EMBEDDING_MAX_BATCH_FRAMES) {
      return KF_EMBEDDING_INVALID_ARGUMENT;
    }
    if (reader->outstanding_token != 0) {
      return KF_EMBEDDING_BUSY;
    }

    reader->frames.clear();
    reader->held_pages.clear();
    reader->frames.reserve(max_frames);
    reader->held_pages.reserve(max_frames);
    uint64_t payload_bytes = 0;
    while (reader->frames.size() < max_frames && reader->reader->data_available()) {
      const auto frame = reader->reader->current_frame();
      reader->held_pages.emplace_back(reader->reader->current_page());
      kf_embedding_frame_v1 view{};
      view.gen_time = frame->gen_time();
      view.trigger_time = frame->trigger_time();
      view.frame_uid = frame->frame_uid();
      view.trigger_frame_uid = frame->trigger_frame_uid();
      view.stream_id = frame->stream_id();
      view.source = frame->source();
      view.initial_source = frame->initial_source();
      view.dest = frame->dest();
      view.msg_type = frame->carrier_type();
      view.data = static_cast<const uint8_t *>(frame->data_address());
      view.data_size = frame->data_length();
      view.data_type = frame->data_type();
      payload_bytes += view.data_size;
      reader->frames.emplace_back(view);
      reader->reader->next();
    }

    out_batch->frame_count = static_cast<uint32_t>(reader->frames.size());
    out_batch->frames = reader->frames.empty() ? nullptr : reader->frames.data();
    out_batch->payload_bytes = payload_bytes;
    out_batch->payload_bytes_copied = 0;
    out_batch->token = 0;
    if (!reader->frames.empty()) {
      if (reader->next_token == 0) {
        reader->next_token = 1;
      }
      reader->outstanding_token = reader->next_token++;
      out_batch->token = reader->outstanding_token;
    }
    return KF_EMBEDDING_OK;
  });
}

int32_t KF_EMBEDDING_CALL reader_release_batch(kf_embedding_reader *reader, uint64_t token) noexcept {
  return contain_exceptions([&]() -> int32_t {
    if (reader == nullptr || token == 0 || token != reader->outstanding_token) {
      return KF_EMBEDDING_INVALID_ARGUMENT;
    }
    reader->frames.clear();
    reader->held_pages.clear();
    reader->outstanding_token = 0;
    reader->reader->release_page();
    return KF_EMBEDDING_OK;
  });
}

int32_t KF_EMBEDDING_CALL reader_close(kf_embedding_reader *reader) noexcept {
  return contain_exceptions([&]() -> int32_t {
    if (reader == nullptr) {
      return KF_EMBEDDING_INVALID_ARGUMENT;
    }
    if (reader->outstanding_token != 0) {
      return KF_EMBEDDING_BUSY;
    }
    --reader->owner->active_readers;
    delete reader;
    return KF_EMBEDDING_OK;
  });
}

const kf_embedding_api_v1 API_V1 = {KF_EMBEDDING_ABI_V1, sizeof(kf_embedding_api_v1), CAPABILITIES,
                                    context_open,        context_capabilities,        context_close,
                                    reader_open,         reader_read_batch,           reader_release_batch,
                                    reader_close};

} // namespace

extern "C" KF_EMBEDDING_EXPORT int32_t KF_EMBEDDING_CALL kungfu_embedding_get_api(uint32_t requested_version,
                                                                                  uint32_t caller_struct_size,
                                                                                  kf_embedding_api_v1 *out_api) {
  if (requested_version != KF_EMBEDDING_ABI_V1) {
    return KF_EMBEDDING_UNSUPPORTED_VERSION;
  }
  if (out_api == nullptr || caller_struct_size < sizeof(kf_embedding_api_v1)) {
    return KF_EMBEDDING_INVALID_ARGUMENT;
  }
  std::memcpy(out_api, &API_V1, sizeof(API_V1));
  return KF_EMBEDDING_OK;
}
