// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STREAM_CANCELLATION_H
#define KUNGFU_RUNTIME_STREAM_CANCELLATION_H

#include <cstddef>
#include <cstdint>

namespace kungfu::runtime::detail {

constexpr uint32_t STREAM_CANCELLATION_CHECK_INTERVAL = 32;

enum class stream_cancellation_disposition {
  continue_reading,
  cancel_empty_batch,
  publish_partial_batch,
};

constexpr stream_cancellation_disposition stream_cancellation_checkpoint(bool cancelled,
                                                                         std::size_t collected_frames) noexcept {
  if (collected_frames % STREAM_CANCELLATION_CHECK_INTERVAL != 0 || !cancelled) {
    return stream_cancellation_disposition::continue_reading;
  }
  return collected_frames == 0 ? stream_cancellation_disposition::cancel_empty_batch
                               : stream_cancellation_disposition::publish_partial_batch;
}

} // namespace kungfu::runtime::detail

#endif // KUNGFU_RUNTIME_STREAM_CANCELLATION_H
