// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/platform/mmap.h>
#include <kungfu/yijinjing/time.h>

#include <atomic>
#include <cstddef>
#include <filesystem>
#include <thread>

namespace kungfu::yijinjing::journal {

namespace {
constexpr uint64_t MIN_PAGE_SIZE_MB = 2;
constexpr uint64_t DEFAULT_PAGE_SIZE_MB = 16;
static_assert(offsetof(yijinjing::types::page_header, last_frame_position) %
                      std::atomic_ref<uint64_t>::required_alignment ==
                  0,
              "page publication token must satisfy atomic_ref alignment");
static_assert(std::atomic_ref<uint64_t>::is_always_lock_free,
              "cross-process page publication requires lock-free uint64 atomics");
static_assert(offsetof(yijinjing::types::page_header, status) %
                      std::atomic_ref<yijinjing::enums::PageStatus>::required_alignment ==
                  0,
              "page status must satisfy atomic_ref alignment");
static_assert(std::atomic_ref<yijinjing::enums::PageStatus>::is_always_lock_free,
              "cross-process page status requires lock-free atomics");
} // namespace
using namespace yijinjing::types;

page::page(data::location_ptr location, uint32_t dest_id, uint32_t page_id, size_t size, page_open_policy policy,
           platform::mapped_region region)
    : region_(std::move(region)), location_(std::move(location)), dest_id_(dest_id), page_id_(page_id), policy_(policy),
      size_(size), header_(reinterpret_cast<page_header *>(region_.address())) {
  assert(region_);
}

page::~page() {
  SPDLOG_TRACE("release page {}/{:08x}.{}.journal, intent {}", location_->uname, dest_id_, page_id_,
               static_cast<int>(policy_.intent()));
  if (not region_.reset()) {
    SPDLOG_ERROR("can not release page {}/{:08x}.{}.journal", location_->uname, dest_id_, page_id_);
  }
}

void page::flush() {
  SPDLOG_TRACE("flush page {}/{:08x}.{}.journal", location_->uname, dest_id_, page_id_);
  if (not region_.flush()) {
    SPDLOG_ERROR("can not flush page {}/{:08x}.{}.journal", location_->uname, dest_id_, page_id_);
  }
}

void page::set_last_frame_position(uint64_t position) {
  std::atomic_ref<uint64_t>(const_cast<page_header *>(header_)->last_frame_position)
      .store(position, std::memory_order_release);
}

void page::enable_page() {
  if (policy_.may_publish_normal()) {
    publish_status(yijinjing::enums::PageStatus::Normal);
  }
}

uint64_t page::acquire_last_frame_position() const {
  return std::atomic_ref<uint64_t>(const_cast<page_header *>(header_)->last_frame_position)
      .load(std::memory_order_acquire);
}

yijinjing::enums::PageStatus page::acquire_status() const {
  return std::atomic_ref<yijinjing::enums::PageStatus>(const_cast<page_header *>(header_)->status)
      .load(std::memory_order_acquire);
}

void page::publish_status(yijinjing::enums::PageStatus status) {
  std::atomic_ref<yijinjing::enums::PageStatus>(const_cast<page_header *>(header_)->status)
      .store(status, std::memory_order_release);
}

uintptr_t page::address_border() const {
  if (header_->page_size < sizeof(frame_header) || header_->page_size > size_) {
    throw journal_error("page border exceeds mapped region for " +
                        resolve_page_path(location_, dest_id_, page_id_, false));
  }
  return address() + header_->page_size - sizeof(frame_header);
}

uint64_t page::get_body_size() const {
  if (header_->page_header_length > size_) {
    throw journal_error("page header exceeds mapped region for " +
                        resolve_page_path(location_, dest_id_, page_id_, false));
  }
  return size_ - header_->page_header_length;
}

uintptr_t page::first_frame_address() const {
  if (header_->page_header_length > size_ || size_ - header_->page_header_length < sizeof(frame_header)) {
    throw journal_error("first frame exceeds mapped region for " +
                        resolve_page_path(location_, dest_id_, page_id_, false));
  }
  return address() + header_->page_header_length;
}

uintptr_t page::last_frame_address() const {
  const auto position = acquire_last_frame_position();
  if (position > size_ || size_ - position < sizeof(frame_header)) {
    throw journal_error("last frame exceeds mapped region for " +
                        resolve_page_path(location_, dest_id_, page_id_, false));
  }
  return address() + position;
}

int64_t page::end_time() const {
  return reinterpret_cast<yijinjing::types::frame_header *>(last_frame_address())->gen_time;
}

page_ptr page::load(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size, uint32_t page_id,
                    page_open_policy policy) {
  if (page_size < sizeof(page_header) + 2 * sizeof(frame_header)) {
    throw journal_error("page size is too small for page and frame publication headers");
  }
  const bool may_initialize = policy.may_initialize();
  std::string path = resolve_page_path(location, dest_id, page_id, policy.mapping().creates_or_grows());
  auto region = platform::mapped_region::map(path, page_size, policy.mapping());

  auto header = reinterpret_cast<page_header *>(region.address());
  auto loaded_page = std::shared_ptr<page>(new page(location, dest_id, page_id, page_size, policy, std::move(region)));
  const bool is_virgin_page = loaded_page->acquire_last_frame_position() == 0;
  SPDLOG_TRACE("load page {}/{:08x}.{}.journal intent {} size {} is_virgin_page {}", location->uname, dest_id, page_id,
               static_cast<int>(policy.intent()), page_size, is_virgin_page);

  if (may_initialize) {
    if (is_virgin_page) {
      header->version = __JOURNAL_VERSION__;
      header->page_header_length = sizeof(page_header);
      header->page_size = page_size;
      header->frame_header_length = sizeof(frame_header);
      loaded_page->publish_status(policy.opens_preopen() ? yijinjing::enums::PageStatus::PreOpen
                                                         : yijinjing::enums::PageStatus::Normal);
      loaded_page->set_last_frame_position(header->page_header_length);
    } else if (!policy.opens_preopen()) {
      loaded_page->publish_status(yijinjing::enums::PageStatus::Normal);
    }
  }

  int64_t nano = time::now_in_nano();
  while (loaded_page->acquire_last_frame_position() == 0) {
    if (time::now_in_nano() - nano > 10 * time_unit::NANOSECONDS_PER_SECOND) {
      throw journal_error("timed out waiting for page initialization: " + path);
    }
    std::this_thread::yield();
  }

  if (header->version != __JOURNAL_VERSION__) {
    uint32_t v = header->version;
    throw journal_error(fmt::format("{} version mismatch, required {}, found {}", path, __JOURNAL_VERSION__, v));
  }
  if (header->page_header_length != sizeof(page_header)) {
    uint32_t l = header->page_header_length;
    throw journal_error(fmt::format("{} header length mismatch, required {}, found {}", path, sizeof(page_header), l));
  }
  if (header->frame_header_length != sizeof(frame_header)) {
    uint32_t l = header->frame_header_length;
    throw journal_error(
        fmt::format("{} frame header length mismatch, required {}, found {}", path, sizeof(frame_header), l));
  }
  if (header->page_size != page_size) {
    uint64_t s = header->page_size;
    throw journal_error(
        fmt::format("page size mismatch, required {}, found {}, location {}, path {}, dest_id {}, page_id {} intent {}",
                    page_size, s, location->uname, path, dest_id, page_id, static_cast<int>(policy.intent())));
  }

  const auto last_frame_position = loaded_page->acquire_last_frame_position();
  if (last_frame_position < header->page_header_length || last_frame_position > page_size - sizeof(frame_header)) {
    throw journal_error(fmt::format("{} invalid last frame position {}, page header {}, page size {}", path,
                                    last_frame_position, header->page_header_length, page_size));
  }

  if (loaded_page->acquire_status() != yijinjing::enums::PageStatus::Normal && !policy.opens_preopen()) {
    SPDLOG_WARN("page is still preopen status");
  }

  return loaded_page;
}

page_ptr page::load(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size, uint32_t page_id,
                    bool is_writing, bool lazy, bool pre_open, bool allow_create) {
  (void)lazy;
  const auto policy = allow_create && !is_writing ? page_open_policy::coordinator_precreate()
                      : is_writing ? (pre_open ? page_open_policy::writer_preload() : page_open_policy::writer())
                                   : (pre_open ? page_open_policy::reader_preload() : page_open_policy::reader());
  return load(location, dest_id, page_size, page_id, policy);
}

page_ptr page::load_header_and_1st_frame_header(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id,
                                                page_open_policy policy) {
  uint32_t page_header_size = sizeof(page_header);
  uint32_t frame_header_size = sizeof(frame_header);
  uint32_t sliced_page_size = page_header_size + frame_header_size;
  std::string path = resolve_page_path(location, dest_id, page_id, policy.mapping().creates_or_grows());
  auto region = platform::mapped_region::map(path, sliced_page_size, policy.mapping());

  auto header = reinterpret_cast<page_header *>(region.address());
  auto loaded_page =
      std::shared_ptr<page>(new page(location, dest_id, page_id, sliced_page_size, policy, std::move(region)));
  if (loaded_page->acquire_last_frame_position() == 0) {
    SPDLOG_WARN("open a page never loaded : {}", path);
  }

  if (header->page_header_length != sizeof(page_header) || header->frame_header_length != sizeof(frame_header) ||
      header->page_size < sliced_page_size) {
    throw journal_error("invalid sliced page header for " + path);
  }

  return loaded_page;
}

page_ptr page::load_header_and_1st_frame_header(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id,
                                                bool is_writing, bool lazy) {
  (void)lazy;
  return load_header_and_1st_frame_header(location, dest_id, page_id,
                                          is_writing ? page_open_policy::writer() : page_open_policy::header_probe());
}

std::string page::get_page_path(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id) {
  return resolve_page_path(location, dest_id, page_id, true);
}

std::string page::resolve_page_path(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id,
                                    bool create_not_exist) {
  auto page_name = fmt::format("{:08x}.{}", dest_id, page_id);
  auto dir = location->locator->layout_dir(location, yijinjing::enums::layout::JOURNAL, create_not_exist);
  return (std::filesystem::path(dir) /
          fmt::format("{}.{}", page_name, yijinjing::enums::get_layout_name(yijinjing::enums::layout::JOURNAL)))
      .string();
}

uint32_t page::find_page_id(const data::location_ptr &location, uint32_t dest_id, int64_t time) {
  std::vector<uint32_t> page_ids = location->locator->list_page_id(location, dest_id);
  if (page_ids.empty()) {
    return 1;
  }
  if (time == 0) {
    return page_ids.front();
  }
  for (int i = static_cast<int>(page_ids.size()) - 1; i >= 0; i--) {
    auto loaded_page =
        page::load_header_and_1st_frame_header(location, dest_id, page_ids[i], page_open_policy::header_probe());
    const auto *loaded_page_header = loaded_page->header_;
    if (loaded_page->acquire_last_frame_position() != 0 &&
        loaded_page->acquire_status() != yijinjing::enums::PageStatus::PreOpen &&
        loaded_page_header->version == __JOURNAL_VERSION__ && loaded_page->begin_time() < time) {
      return page_ids[i];
    }
  }
  return page_ids.front();
}

uint64_t page::find_page_size(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size) {
  if (page_size > 0) {
    if (page_size < MIN_PAGE_SIZE_MB) {
      return MIN_PAGE_SIZE_MB * MB;
    }
    return std::min<uint64_t>(page_size * MB, UINT64_MAX / 2);
  }

  (void)location;
  (void)dest_id;
  return DEFAULT_PAGE_SIZE_MB * MB;
}

bool page::check_page_existed(const data::location_ptr &location, uint32_t dest_id) {
  std::vector<uint32_t> page_ids = location->locator->list_page_id(location, dest_id);
  if (page_ids.empty()) {
    return false;
  }
  return true;
}

bool page::check_page_existed(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id) {
  std::vector<uint32_t> page_ids = location->locator->list_page_id(location, dest_id);
  return std::any_of(page_ids.begin(), page_ids.end(), [&](uint32_t id) { return id == page_id; });
}
} // namespace kungfu::yijinjing::journal
