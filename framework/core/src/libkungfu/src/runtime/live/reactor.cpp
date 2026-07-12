// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <vector>

#include <kungfu/common.h>
#include <kungfu/runtime/live/reactor.h>
#include <kungfu/runtime/nanomsg/socket.h>
#include <kungfu/runtime/os.h>
#include <kungfu/runtime/util/rocks.h>
#include <kungfu/runtime/util/stacktrace.h>
#include <kungfu/runtime/util/terminal.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::rx;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::runtime;
using namespace kungfu::runtime::util;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::journal;
using namespace kungfu::runtime::nanomsg;

namespace kungfu::runtime::live {

namespace {
// Dispatch-latency probe for the reactive event layer (evidence for
// ADR-0005). Each sb.on_next in reactor::drain fans a frame synchronously
// through every rx filter chain subscribed on events_, so timing that call
// measures the full per-frame chain traversal for whichever form is
// pumping — coordinator and peer via run(), the node watcher via step().
// Opt-in via KF_DISPATCH_PROBE=1; when disabled the per-frame cost is one
// predictable branch. thread_local isolates samples per pump thread, which
// is per reactor instance.
struct dispatch_probe {
  struct stat {
    uint64_t count = 0;
    int64_t total_ns = 0;
    int64_t max_ns = 0;

    void add(int64_t ns) {
      count++;
      total_ns += ns;
      max_ns = std::max(max_ns, ns);
    }
  };

  const bool enabled = std::getenv("KF_DISPATCH_PROBE") != nullptr;
  uint64_t frames_seen = 0;
  stat overall = {};
  std::unordered_map<int32_t, stat> by_carrier_type = {};
  std::chrono::steady_clock::time_point last_report = std::chrono::steady_clock::now();

  void record(int32_t carrier_type, int64_t ns) {
    overall.add(ns);
    by_carrier_type[carrier_type].add(ns);
  }

  [[nodiscard]] bool due(std::chrono::steady_clock::time_point at) const {
    return at - last_report >= std::chrono::seconds(5);
  }

  void report(const std::string &uname) {
    last_report = std::chrono::steady_clock::now();
    if (overall.count == 0) {
      return;
    }
    SPDLOG_INFO("dispatch probe [{}] frames_seen={} dispatched={} mean={}ns max={}ns total={}us", uname, frames_seen,
                overall.count, overall.total_ns / static_cast<int64_t>(overall.count), overall.max_ns,
                overall.total_ns / 1000);
    std::vector<std::pair<int32_t, stat>> ranked(by_carrier_type.begin(), by_carrier_type.end());
    std::sort(ranked.begin(), ranked.end(),
              [](const auto &a, const auto &b) { return a.second.total_ns > b.second.total_ns; });
    constexpr std::size_t top = 8;
    for (std::size_t i = 0; i < ranked.size() and i < top; i++) {
      const auto &[carrier_type, s] = ranked[i];
      SPDLOG_INFO("dispatch probe [{}] carrier_type={:#010x} n={} mean={}ns max={}ns total={}us", uname, carrier_type,
                  s.count, s.total_ns / static_cast<int64_t>(s.count), s.max_ns, s.total_ns / 1000);
    }
  }
};

thread_local dispatch_probe dispatch_probe_ = {};
} // namespace

inline std::string encode(const kungfu::runtime::io_device_ptr &io_device) {
  auto home_uid =
      io_device->get_home()->mode == mode::BACKTEST ? io_device->get_home()->uid : io_device->get_live_home()->uid;
  return fmt::format("{:08x}", home_uid);
}

reactor::reactor(kungfu::runtime::io_device_ptr io_device)
    : begin_time_(yijinjing::time::now_in_nano()), end_time_(INT64_MAX),
      coordinator_home_location_(
          make_system_location(COORDINATOR_WIRE_NAMESPACE, COORDINATOR_WIRE_NAME, io_device->get_locator())),
      coordinator_cmd_location_(make_system_location(COORDINATOR_WIRE_NAMESPACE, encode(io_device),
                                                     io_device->get_locator(), io_device->get_home()->seed)),
      ledger_home_location_(make_system_location("service", "ledger", io_device->get_locator())),
      io_device_(std::move(io_device)), now_(0), main_thread_id_(util::get_thread_id()) {

  os::handle_os_signals(this);
  util::set_error_log_dir(get_locator()->layout_dir(get_home(), layout::LOG));
  reader_ = io_device_->open_reader_to_subscribe();
}

reactor::~reactor() {
  signal_stop();
  cs_.unsubscribe();
  loop_error_state_.reset();
  {
    std::lock_guard<std::mutex> lock(writers_mtx_);
    writers_.clear();
  }
  {
    std::lock_guard<std::mutex> lock(band_mtx_);
    band_writers_.clear();
  }
  reader_.reset();
  io_device_.reset();
  ensure_sqlite_shutdown();
  os::reset_reactor_instance();
  rocks::clear_rocksdb(&coordinator_db_);
  rocks::clear_rocksdb(&peer_db_);
}

bool reactor::is_usable() { return io_device_->is_usable(); }

bool reactor::setup() {
  loop_error_state_->reset();
  io_device_->setup();
  SPDLOG_DEBUG("io setup done");
  rx::loop_error_scope error_scope(loop_error_state_);
  events_ = observable<>::create<event_ptr>([this](auto &s) { delegate_produce(this, s); }) | holdon();
  now_ = get_begin_time();
  react();
  live_ = true;
  return true;
}

void reactor::pre_setup() {
  ensure_coordinator_rocksdb();
  read_location_from_rocksdb();
  add_location(0, get_io_device()->get_live_home());
  add_location(0, coordinator_home_location_);
  add_location(0, coordinator_cmd_location_);
  add_location(0, ledger_home_location_);
  // could get in rocksdb in live
  if (get_home()->mode != mode::LIVE) {
    for (const auto &l : get_home()->locator->list_locations("*", "*", "*", "*")) {
      add_location(0, l);
    }
  }
}

void reactor::step(uint32_t step_limit) {
  continual_ = false;
  step_limit_ = step_limit;
  rx::loop_error_scope error_scope(loop_error_state_);
  events_.connect(cs_);
  loop_error_state_->rethrow_if_error();
}

void reactor::run(uint32_t step_limit) {
  SPDLOG_INFO("[{:08x}] {} running", get_home_uid(), get_home_uname());
  SPDLOG_DEBUG("from {} until {}", yijinjing::time::strftime(begin_time_), yijinjing::time::strftime(end_time_));
  step_limit_ = step_limit;
  pre_setup();
  setup();
  SPDLOG_DEBUG("live runtime setup done");
  continual_ = true;
  {
    rx::loop_error_scope error_scope(loop_error_state_);
    events_.connect(cs_);
  }
  on_exit();
  loop_error_state_->rethrow_if_error();
  SPDLOG_INFO("[{:08x}] {} done", get_home_uid(), get_home_uname());
}

bool reactor::is_live() const { return live_ and not loop_error_state_->stop_requested(); }

bool reactor::is_low_latency() const { return io_device_->is_low_latency(); }

const bus_ptr &reactor::get_bus() const { return io_device_->get_bus(); }

void reactor::signal_stop() {
  loop_error_state_->request_stop();
  live_ = false;
}

int64_t reactor::now() const { return now_; }

void reactor::set_now(int64_t now) { now_ = now; }

void reactor::set_begin_time(int64_t begin_time) {
  begin_time_ = begin_time;
  io_device_->set_begin_time(begin_time);
}

int64_t reactor::get_begin_time() const { return begin_time_; }

void reactor::set_end_time(int64_t end_time) { end_time_ = end_time; }

int64_t reactor::get_end_time() const { return end_time_; }

const locator_ptr &reactor::get_locator() const { return io_device_->get_locator(); }

kungfu::runtime::io_device_ptr reactor::get_io_device() const { return io_device_; }

const location_ptr &reactor::get_home() const { return get_io_device()->get_home(); }

uint32_t reactor::get_home_uid() const { return get_io_device()->get_home()->uid; }

const std::string &reactor::get_home_uname() const { return get_io_device()->get_home()->uname; }

const location_ptr &reactor::get_live_home() const { return get_io_device()->get_live_home(); }

uint32_t reactor::get_live_home_uid() const { return get_io_device()->get_live_home()->uid; }

reader_ptr reactor::get_reader() const { return reader_; }

bool reactor::has_writer(uint32_t dest_id) const {
  if (util::get_thread_id() != main_thread_id_ and has_band_writer(dest_id)) {
    return true;
  }
  std::lock_guard<std::mutex> lock(writers_mtx_);
  return writers_.find(dest_id) != writers_.end();
}

writer_ptr reactor::get_writer(uint32_t dest_id) const {
  if (util::get_thread_id() != main_thread_id_) {
    try {
      return get_band_writer(dest_id);
    } catch (const std::exception &e) {
      SPDLOG_WARN("Unexpected exception by get_band_writer for dest_id {}:{}, {}", dest_id, get_location_uname(dest_id),
                  e.what());
    }
  } else {
    std::lock_guard<std::mutex> lock(band_mtx_);
    auto band_writer = band_writers_.find(dest_id);
    if (band_writer != band_writers_.end()) {
      return band_writer->second;
    }
  }

  std::lock_guard<std::mutex> lock(writers_mtx_);
  auto writer = writers_.find(dest_id);
  if (writer == writers_.end()) {
    SPDLOG_ERROR("no writer for {}", get_location_uname(dest_id));
    return writers_.at(dest_id);
  }
  return writer->second;
}

bool reactor::has_band_writer(uint32_t dest_id) const {
  std::lock_guard<std::mutex> lk(band_mtx_);
  return band_writers_.find(dest_id) != band_writers_.end();
}

writer_ptr reactor::get_band_writer(uint32_t dest_id) const {
  std::lock_guard<std::mutex> lk(band_mtx_);
  if (band_writers_.find(dest_id) == band_writers_.end()) {
    SPDLOG_ERROR("no band writer for {}", get_location_uname(dest_id));
  }
  return band_writers_.at(dest_id);
}

WriterMap reactor::get_writers() const {
  WriterMap snapshot;
  {
    std::lock_guard<std::mutex> lock(writers_mtx_);
    snapshot = writers_;
  }
  {
    std::lock_guard<std::mutex> lock(band_mtx_);
    snapshot.insert(band_writers_.begin(), band_writers_.end());
  }
  return snapshot;
}

bool reactor::has_location(uint32_t uid) const { return locations_.find(uid) != locations_.end(); }

location_ptr reactor::get_location(uint32_t uid) const {
  if (not has_location(uid)) {
    SPDLOG_ERROR("no location {} in locations_", uid);
  }

  if (location::PUBLIC == uid or location::SYNC == uid) {
    return nullptr;
  }

  assert(has_location(uid));
  return locations_.at(uid);
}

std::string reactor::get_location_uname(uint32_t uid) const {
  if (uid == location::PUBLIC) {
    return "public";
  }
  if (uid == location::SYNC) {
    return "sync";
  }
  if (not has_location(uid)) {
    return fmt::format("{:08x}", uid);
  }
  return get_location(uid)->uname;
}

bool reactor::is_location_live(uint32_t uid) const { return registry_.find(uid) != registry_.end(); }

bool reactor::has_channel(uint32_t source, uint32_t dest) const {
  return has_channel(make_source_dest_hash(source, dest));
}

bool reactor::has_channel(uint64_t hash) const { return channels_.find(hash) != channels_.end(); }

const yijinjing::types::Channel &reactor::get_channel(uint32_t source, uint32_t dest) const {
  return get_channel(make_source_dest_hash(source, dest));
}

const Channel &reactor::get_channel(uint64_t hash) const {
  assert(has_channel(hash));
  return channels_.at(hash);
}

const std::unordered_map<uint64_t, yijinjing::types::Channel> &reactor::get_channels() const { return channels_; }

const std::unordered_map<uint32_t, yijinjing::types::Register> &reactor::get_registry() const { return registry_; }

const std::unordered_map<uint32_t, yijinjing::data::location_ptr> &reactor::get_locations() const { return locations_; }

bool reactor::has_band(uint32_t source, uint32_t dest) const { return has_band(make_source_dest_hash(source, dest)); }

bool reactor::has_band(uint64_t hash) const { return bands_.find(hash) != bands_.end(); }

const yijinjing::types::Band &reactor::get_band(uint32_t source, uint32_t dest) const {
  return get_band(make_source_dest_hash(source, dest));
}

const yijinjing::types::Band &reactor::get_band(uint64_t hash) const {
  assert(has_band(hash));
  return bands_.at(hash);
}

const std::unordered_map<uint64_t, yijinjing::types::Band> &reactor::get_bands() const { return bands_; }

void reactor::on_notify() {}

void reactor::on_exit() { SPDLOG_INFO("default on_exit"); }

location_ptr reactor::get_ledger_home_location() const { return ledger_home_location_; }

location_ptr reactor::get_coordinator_home_location() const { return coordinator_home_location_; }

location_ptr reactor::get_coordinator_cmd_location() const { return coordinator_cmd_location_; }

const rx::connectable_observable<event_ptr> &reactor::get_events() const { return events_; }

uint64_t reactor::make_source_dest_hash(uint32_t source_id, uint32_t dest_id) {
  return uint64_t(source_id) << 32u | uint64_t(dest_id);
}

bool reactor::check_location_exists(uint32_t source_id, uint32_t dest_id) const {
  if (not has_location(source_id)) {
    SPDLOG_ERROR("source_id {}, {} does not exist", source_id, get_location_uname(source_id));
    return false;
  }
  if (dest_id != location::PUBLIC and dest_id != location::SYNC and not has_location(dest_id)) {
    SPDLOG_ERROR("dest_id {}, {} does not exist", dest_id, get_location_uname(dest_id));
    return false;
  }
  return true;
}

bool reactor::check_location_live(uint32_t source_id, uint32_t dest_id) const {
  if (not check_location_exists(source_id, dest_id)) {
    return false;
  }
  if (!is_location_live(source_id)) {
    SPDLOG_ERROR("{} is not live", get_location_uname(source_id));
    return false;
  }
  if (!is_location_live(dest_id)) {
    SPDLOG_ERROR("{} is not live", get_location_uname(dest_id));
    return false;
  }
  return true;
}

void reactor::add_location(int64_t, const location_ptr &location) {
  location_uid64s_.insert(std::to_string(location->uid64));
  bool write_rocks = locations_.try_emplace(location->uid, location).second |
                     location64s_.try_emplace(location->uid64, location).second;
  if (write_rocks) {
    write_location_to_rocksdb(location);
  }
}

void reactor::add_location(int64_t trigger_time, const Location &location) {
  add_location(trigger_time, yijinjing::data::location::make_shared(location, get_locator()));
}

void reactor::remove_location(int64_t trigger_time, uint32_t location_uid) { locations_.erase(location_uid); }

void reactor::register_location(int64_t, const Register &register_data) {
  uint32_t location_uid = register_data.location_uid;
  registry_.insert_or_assign(location_uid, register_data);
}

void reactor::deregister_location(int64_t, const uint32_t location_uid) {
  auto result = registry_.erase(location_uid);
  if (result) {
    SPDLOG_TRACE("location [{:08x}] {} down", location_uid, get_location_uname(location_uid));
  }
}

void reactor::register_channel(int64_t, const Channel &channel) {
  uint64_t channel_uid = make_source_dest_hash(channel.source_id, channel.dest_id);
  auto result = channels_.try_emplace(channel_uid, channel);
  if (result.second) {
    auto source_uname = get_location_uname(channel.source_id);
    auto dest_uname = get_location_uname(channel.dest_id);
    SPDLOG_TRACE("channel [{:08x}] {} -> {} up", channel_uid, source_uname, dest_uname);
  }
}

void reactor::deregister_channel(uint32_t source_id) {
  auto channel_it = channels_.begin();
  while (channel_it != channels_.end()) {
    if (channel_it->second.source_id == source_id) {
      const auto &channel_uid = channel_it->first;
      const auto &channel = channel_it->second;
      auto source_uname = get_location_uname(channel.source_id);
      auto dest_uname = get_location_uname(channel.dest_id);
      SPDLOG_TRACE("channel [{:08x}] {} -> {} down", channel_uid, source_uname, dest_uname);
      channel_it = channels_.erase(channel_it);
      continue;
    }
    channel_it++;
  }
}

void reactor::register_band(int64_t, const Band &band) {
  uint64_t band_uid = make_source_dest_hash(band.source_id, band.dest_id);
  auto result = bands_.try_emplace(band_uid, band);
  if (result.second) {
    auto source_uname = get_location_uname(band.source_id);
    auto dest_uname = get_location_uname(band.dest_id);
    SPDLOG_TRACE("band [{:08x}] {} -> {} up", band_uid, source_uname, dest_uname);
  }
}

void reactor::deregister_band(uint32_t source_id) {
  auto band_it = bands_.begin();
  while (band_it != bands_.end()) {
    if (band_it->second.source_id == source_id) {
      const auto &band_uid = band_it->first;
      const auto &band = band_it->second;
      auto source_uname = get_location_uname(band.source_id);
      auto dest_uname = get_location_uname(band.dest_id);
      SPDLOG_TRACE("band [{:08x}] {} -> {} down", band_uid, source_uname, dest_uname);
      band_it = bands_.erase(band_it);
      continue;
    }
    band_it++;
  }
}

void reactor::require_read_from(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                                uint64_t page_size) {
  do_require_read_from<RequestReadFrom>(get_writer(dest_id), trigger_time, dest_id, source_id, from_time, page_size);
}

void reactor::require_read_from_public(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                                       uint64_t page_size) {
  do_require_read_from<RequestReadFromPublic>(get_writer(dest_id), trigger_time, dest_id, source_id, from_time,
                                              page_size);
}

void reactor::require_read_from_sync(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                                     uint64_t page_size) {
  do_require_read_from<RequestReadFromSync>(get_writer(dest_id), trigger_time, dest_id, source_id, from_time,
                                            page_size);
}

void reactor::require_write_to(int64_t trigger_time, uint32_t source_id, uint32_t dest_id, uint64_t page_size) {
  if (not check_location_exists(source_id, dest_id)) {
    return;
  }
  auto writer = get_writer(source_id);
  RequestWriteTo &msg = writer->open_data<RequestWriteTo>(trigger_time);
  msg.dest_id = dest_id;
  msg.page_size = page_size;
  writer->close_data();
}

void reactor::require_write_to_band(int64_t trigger_time, uint32_t source_id,
                                    const yijinjing::data::location_ptr &location, uint64_t page_size) const {
  auto writer = get_writer(source_id);
  RequestWriteToBand msg = {};
  location->to<RequestWriteToBand>(msg);
  msg.page_size = page_size;
  writer->write(trigger_time, msg);
}

void reactor::produce(const rx::subscriber<event_ptr> &sb) {
  try {
    do {
      live_ = drain(sb) && live_ && not loop_error_state_->stop_requested();
      on_active();
      cleanup_reader_disjoin(); // subclass may call disjoin in on_active
    } while (continual_ and live_);
  } catch (...) {
    live_ = false;
    sb.on_error(std::current_exception());
    return;
  }
  if (not live_) {
    sb.on_completed();
  }
}

void reactor::deal_notice(bool bypass, bool notify, const rx::subscriber<event_ptr> &sb) {
  if (bypass or io_device_->get_home()->mode != mode::LIVE) {
    return;
  }

  auto rc = notify ? io_device_->get_observer()->wait() : io_device_->get_observer()->nonblock_wait();
  if (not rc)
    return;

  const std::string &notice = io_device_->get_observer()->get_notice();
  now_ = yijinjing::time::now_in_nano();
  if (notice.length() > 2) {
    const auto frame = std::make_shared<nanomsg_json>(notice);
    io_device_->get_bus()->set_trigger_frame(frame);
    sb.on_next(frame);
    cleanup_reader_disjoin(); // socket frame may call disjoin
  } else if (notify) {
    on_notify();
  }
}

bool reactor::drain(const rx::subscriber<event_ptr> &sb) {
  bool bypass = io_device_->is_lazy() and is_low_latency();
  deal_notice(bypass, true, sb);
  for (std::size_t step_count = 0;                                                             //
       live_ and reader_->data_available() and (step_limit_ == 0 || step_count < step_limit_); //
       step_count++) {
    deal_notice(io_device_->is_lazy(), false, sb);
    const frame_ptr frame = reader_->current_frame();
    io_device_->get_bus()->set_trigger_frame(frame);
    if (frame->gen_time() <= end_time_) {
      int64_t frame_time = frame->gen_time();
      if (frame_time > now_) {
        now_ = frame_time;
      }
      if (dispatch_probe_.enabled) {
        dispatch_probe_.frames_seen++;
        if (is_reactable(frame)) {
          const auto start = std::chrono::steady_clock::now();
          sb.on_next(frame);
          const auto stop = std::chrono::steady_clock::now();
          dispatch_probe_.record(frame->carrier_type(),
                                 std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count());
          if (dispatch_probe_.due(stop)) {
            dispatch_probe_.report(get_home_uname());
          }
        }
      } else if (is_reactable(frame)) {
        sb.on_next(frame);
      }
      on_frame();
      reader_->next();
      cleanup_reader_disjoin();
    } else {
      SPDLOG_INFO("reached journal end {}", yijinjing::time::strftime(frame->gen_time()));
      if (dispatch_probe_.enabled) {
        dispatch_probe_.report(get_home_uname());
      }
      return false;
    }
  }
  if (get_io_device()->get_home()->mode != mode::LIVE and not reader_->data_available()) {
    SPDLOG_INFO("reached journal end {}", yijinjing::time::strftime(now()));
    if (dispatch_probe_.enabled) {
      dispatch_probe_.report(get_home_uname());
    }
    return false;
  }
  return true;
}

void reactor::delegate_produce(reactor *instance, const rx::subscriber<event_ptr> &subscriber) {
#ifdef _WIN32
  __try {
    instance->produce(subscriber);
  } __except (util::print_stack_trace(GetExceptionInformation())) {
  }
#else
  instance->produce(subscriber);
#endif
}

bool reactor::is_reactable(const event_ptr &event) { return true; }

void reactor::disjoin(const location_ptr &location) { disjoin_locations_.insert(location); }

void reactor::disjoin_channel(const location_ptr &location, uint32_t dest_id) {
  disjoin_channels_.insert({location, dest_id});
}

void reactor::cleanup_reader_disjoin() {
  /**
   * Invoking reader_->disjoin within the events_ stream is forbidden due to several critical reasons:
   * 1. It may release current reading journal, causing segmentation violation or memory crash,
   * 2. It may change reader_->current_ to another journal, leading to reader->next() in wrong journal,
   * 3. It poses a risk of processing the current frame multiple times.
   * Consequently, reader_->disjoin  should only be invoked after events_ stream over,
   * specifically when the current frame dealt over and reader_->next() called.
   */

  for (const auto &location : disjoin_locations_) {
    reader_->disjoin(location);
  }
  for (auto &pair : disjoin_channels_) {
    reader_->disjoin_channel(pair.first, pair.second);
  }
  disjoin_locations_.clear();
  disjoin_channels_.clear();
}

rocksdb::DB *reactor::get_coordinator_rocksdb() const {
  static const std::string coordinator_db_dir = get_locator()->layout_dir(get_coordinator_home_location(), layout::MAP);
  SPDLOG_DEBUG("get_coordinator_rocksdb from dir: {}", coordinator_db_dir);
  if (io_device_->is_lazy()) {
    std::lock_guard<std::mutex> lk(coordinator_db_mtx_);
    rocks::clear_rocksdb(&coordinator_db_);
    rocksdb::Status status = rocks::open_db(coordinator_db_dir, &coordinator_db_, false);
    if (not status.ok()) {
      const std::string msg = fmt::format("OpenForReadOnly for {} failed, {}", coordinator_db_dir, status.ToString());
      SPDLOG_INFO(msg);
      throw yijinjing_error(msg);
    }
  } else {
    if (nullptr == coordinator_db_) {
      std::lock_guard<std::mutex> lk(coordinator_db_mtx_);
      if (nullptr != coordinator_db_) {
        return coordinator_db_;
      }
      rocksdb::Status status = rocks::open_db(coordinator_db_dir, &coordinator_db_, true);
      if (not status.ok()) {
        const std::string msg = fmt::format("Open for {} failed, {}", coordinator_db_dir, status.ToString());
        SPDLOG_ERROR(msg);
        throw yijinjing_error(msg);
      }
    }
  }
  return coordinator_db_;
}

rocksdb::DB *reactor::get_peer_rocksdb() const {
  if (not io_device_->is_lazy()) {
    return get_coordinator_rocksdb();
  }
  if (nullptr == peer_db_) {
    std::lock_guard<std::mutex> lk(peer_db_mtx_);
    if (nullptr != peer_db_) {
      return peer_db_;
    }
    rocksdb::Status status = rocks::open_db(get_locator()->layout_dir(get_home(), layout::MAP), &peer_db_, true);
    if (not status.ok()) {
      const std::string msg =
          fmt::format("Open for {} failed, {}", get_locator()->layout_dir(get_home(), layout::MAP), status.ToString());
      SPDLOG_ERROR(msg);
      throw yijinjing_error(msg);
    }
  }
  return peer_db_;
}

std::string reactor::get_coordinator_kv(const std::string &key) const {
  std::string value{};
  rocksdb::Status status = rocks::get_kv(key, value, get_coordinator_rocksdb());
  if (not status.ok()) {
    SPDLOG_DEBUG("get key:{} failed, {}", key, status.ToString());
  }
  return value;
}

void reactor::put_coordinator_kv(const std::string &key, const std::string &value) const {
  if (io_device_->is_lazy()) {
    return;
  }
  rocksdb::Status status = rocks::put_kv(key, value, get_coordinator_rocksdb());
  if (not status.ok()) {
    SPDLOG_ERROR("put key:{} value: {}, failed, {}", key, value, status.ToString());
  }
}

std::string reactor::get_peer_kv(const std::string &key) const {
  std::string value{};
  rocksdb::Status status = rocks::get_kv(key, value, get_peer_rocksdb());
  if (not status.ok()) {
    SPDLOG_ERROR("get key:{} failed, {}", key, status.ToString());
  }
  return value;
}

void reactor::put_peer_kv(const std::string &key, const std::string &value) const {
  rocksdb::Status status = rocks::put_kv(key, value, get_peer_rocksdb());
  if (not status.ok()) {
    SPDLOG_ERROR("put key:{} value: {}, failed, {}", key, value, status.ToString());
  }
}

void reactor::ensure_coordinator_rocksdb() {
  static const std::string coordinator_db_dir = get_locator()->layout_dir(get_coordinator_home_location(), layout::MAP);
  try {
    get_coordinator_rocksdb();
  } catch (const std::exception &e) {
    SPDLOG_DEBUG("catch exception: {}", e.what());
    std::lock_guard<std::mutex> lk(coordinator_db_mtx_);
    rocks::open_db(get_locator()->layout_dir(get_coordinator_home_location(), layout::MAP), &coordinator_db_, true);
    rocks::clear_rocksdb(&coordinator_db_);
  }
}

std::map<std::string, std::string> reactor::get_coordinator_kvs(const std::set<std::string> &keys) const {
  return rocks::get_kvs(keys, get_coordinator_rocksdb());
}

std::map<std::string, std::string> reactor::get_peer_kvs(const std::set<std::string> &keys) const {
  return rocks::get_kvs(keys, get_peer_rocksdb());
}

void reactor::put_coordinator_kvs(const std::map<std::string, std::string> &kvs) const {
  if (io_device_->is_lazy()) {
    return;
  }

  rocksdb::Status status = rocks::put_kvs(kvs, get_coordinator_rocksdb());
  if (not status.ok()) {
    SPDLOG_ERROR("Write failed, {}", status.ToString());
  }
}

void reactor::put_peer_kvs(const std::map<std::string, std::string> &kvs) const {
  rocksdb::Status status = rocks::put_kvs(kvs, get_peer_rocksdb());
  if (not status.ok()) {
    SPDLOG_ERROR("Write failed, {}", status.ToString());
  }
}

void reactor::write_location_to_rocksdb(const location_ptr &location) {
  if (io_device_->is_lazy()) {
    return;
  }

  const std::string str_uid32 = std::to_string(location->uid);
  const std::string str_uid64 = std::to_string(location->uid64);
  location_uid64s_.insert(str_uid64);

  nlohmann::json json_array;
  for (const auto &uid : location_uid64s_) {
    json_array.push_back(uid);
  }
  nlohmann::json json_obj;
  json_obj[LOCATION_KEYS] = json_array;

  rocksdb::WriteBatch batch;
  batch.Put(str_uid32, location->uname);
  batch.Put(location->uname, std::to_string(location->seed));
  batch.Put(str_uid64, location->to_string());
  batch.Put(LOCATION_KEYS, json_obj.dump());
  rocks::put_kvs(batch, get_coordinator_rocksdb());
}

void reactor::read_location_from_rocksdb() {
  std::string str_location_uid64s_json = get_coordinator_kv(LOCATION_KEYS);
  SPDLOG_DEBUG("str_location_uid64s_json: {}", str_location_uid64s_json);
  if (str_location_uid64s_json.empty()) {
    return;
  }
  auto location_uid64s_json = nlohmann::json::parse(str_location_uid64s_json);
  if (location_uid64s_json.contains(LOCATION_KEYS) && location_uid64s_json[LOCATION_KEYS].is_array()) {
    for (const std::string uid64 : location_uid64s_json[LOCATION_KEYS]) {
      location_uid64s_.insert(uid64);
    }
    std::map<std::string, std::string> map_str_location64s_ = get_coordinator_kvs(location_uid64s_);
    for (const auto &pair : map_str_location64s_) {
      SPDLOG_DEBUG("uid64: {}, location_json: {}", pair.first, pair.second);
      const location_ptr location = location::make_shared(Location{pair.second}, get_locator());
      SPDLOG_DEBUG("location: {}", location->to_string());
      locations_.try_emplace(location->uid, location);
      location64s_.try_emplace(location->uid64, location);
    }
  }
}
} // namespace kungfu::runtime::live
