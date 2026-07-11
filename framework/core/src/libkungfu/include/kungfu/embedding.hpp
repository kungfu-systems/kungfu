// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_EMBEDDING_HPP
#define KUNGFU_EMBEDDING_HPP

#include <kungfu/embedding.h>

#include <stdexcept>
#include <string>
#include <utility>

namespace kungfu::embedding {

inline void require_ok(int32_t status, const char *operation) {
  if (status != KF_EMBEDDING_OK) {
    throw std::runtime_error(std::string(operation) + " failed with embedding status " + std::to_string(status));
  }
}

class context {
public:
  context(const kf_embedding_api_v1 &api, const kf_embedding_context_config_v1 &config) : api_(api) {
    require_ok(api_.context_open(&config, &handle_), "context_open");
  }

  context(const context &) = delete;
  context &operator=(const context &) = delete;
  context(context &&other) noexcept : api_(other.api_), handle_(std::exchange(other.handle_, nullptr)) {}
  context &operator=(context &&) = delete;

  ~context() {
    if (handle_ != nullptr) {
      (void)api_.context_close(handle_);
    }
  }

  [[nodiscard]] const kf_embedding_api_v1 &api() const { return api_; }
  [[nodiscard]] kf_embedding_context *get() const { return handle_; }

private:
  kf_embedding_api_v1 api_{};
  kf_embedding_context *handle_ = nullptr;
};

class batch {
public:
  batch(const kf_embedding_api_v1 &api, kf_embedding_reader *reader, kf_embedding_batch_v1 value)
      : api_(api), reader_(reader), value_(value) {}

  batch(const batch &) = delete;
  batch &operator=(const batch &) = delete;
  batch(batch &&other) noexcept
      : api_(other.api_), reader_(std::exchange(other.reader_, nullptr)), value_(other.value_) {}
  batch &operator=(batch &&) = delete;

  ~batch() {
    if (reader_ != nullptr && value_.token != 0) {
      (void)api_.reader_release_batch(reader_, value_.token);
    }
  }

  [[nodiscard]] const kf_embedding_frame_v1 *begin() const { return value_.frames; }
  [[nodiscard]] const kf_embedding_frame_v1 *end() const {
    return value_.frame_count == 0 ? value_.frames : value_.frames + value_.frame_count;
  }
  [[nodiscard]] uint32_t size() const { return value_.frame_count; }
  [[nodiscard]] uint64_t payload_bytes() const { return value_.payload_bytes; }
  [[nodiscard]] uint64_t payload_bytes_copied() const { return value_.payload_bytes_copied; }

private:
  kf_embedding_api_v1 api_{};
  kf_embedding_reader *reader_;
  kf_embedding_batch_v1 value_{};
};

class reader {
public:
  reader(context &owner, const kf_embedding_location_v1 &location) : owner_(&owner) {
    require_ok(owner_->api().reader_open(owner_->get(), &location, &handle_), "reader_open");
  }

  reader(const reader &) = delete;
  reader &operator=(const reader &) = delete;
  reader(reader &&) = delete;
  reader &operator=(reader &&) = delete;

  ~reader() {
    if (handle_ != nullptr) {
      (void)owner_->api().reader_close(handle_);
    }
  }

  [[nodiscard]] batch read_batch(uint32_t max_frames) {
    kf_embedding_batch_v1 value{};
    value.struct_size = sizeof(value);
    require_ok(owner_->api().reader_read_batch(handle_, max_frames, &value), "reader_read_batch");
    return batch(owner_->api(), handle_, value);
  }

private:
  context *owner_;
  kf_embedding_reader *handle_ = nullptr;
};

} // namespace kungfu::embedding

#endif // KUNGFU_EMBEDDING_HPP
