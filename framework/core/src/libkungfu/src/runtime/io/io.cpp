// SPDX-License-Identifier: Apache-2.0

#include <cstdlib>

#include <kungfu/common.h>
#include <kungfu/runtime/io.h>
#include <kungfu/runtime/live/identity.h>
#include <kungfu/runtime/live/key_value_store.h>
#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::journal;
using namespace kungfu::runtime::nanomsg;

namespace kungfu::runtime {
namespace {
constexpr int USABILITY_PROBE_ATTEMPTS = 5;
}

class ipc_url_factory : public url_factory {
public:
  virtual ~ipc_url_factory() {}

  [[nodiscard]] std::string make_path_listen(data::location_ptr location, protocol p) const override {
    return location->locator->layout_file(location, layout::NANOMSG, get_protocol_name(p));
  }

  [[nodiscard]] std::string make_path_dial(data::location_ptr location, protocol p) const override {
    return location->locator->layout_file(location, layout::NANOMSG, get_protocol_name(get_opposite_protol(p)));
  }
};

class nanomsg_resource : public resource {
protected:
  nanomsg_resource(const io_device &io_device, bool low_latency, protocol p)
      : io_device_(io_device), low_latency_(low_latency),
        location_(std::make_shared<data::location>(mode::LIVE, yijinjing::enums::location_role::SYSTEM,
                                                   live::COORDINATOR_WIRE_NAMESPACE, live::COORDINATOR_WIRE_NAME,
                                                   io_device_.get_live_home()->locator)),
        listen_path_(io_device_.get_url_factory()->make_path_listen(location_, p)),
        dial_path_(io_device_.get_url_factory()->make_path_dial(location_, p)), socket_(p) {}

  const io_device &io_device_;
  const bool low_latency_;
  const location_ptr location_;
  const std::string listen_path_;
  const std::string dial_path_;
  nanomsg::socket socket_;
};

class nanomsg_publisher : public publisher, protected nanomsg_resource {
public:
  nanomsg_publisher(const io_device &io_device, bool low_latency, protocol p)
      : nanomsg_resource(io_device, low_latency, p) {}

  ~nanomsg_publisher() override { socket_.close(); }

  int notify() override { return low_latency_ ? 0 : publish("{}"); }

  int publish(const std::string &json_message, int flags = NNG_FLAG_NONBLOCK, bool no_exception = false) override {
    return socket_.send(json_message, flags, no_exception);
  }
};

class nanomsg_publisher_coordinator : public nanomsg_publisher {
public:
  nanomsg_publisher_coordinator(const io_device &io_device, bool low_latency)
      : nanomsg_publisher(io_device, low_latency, protocol::PUBLISH) {}

  bool setup() override {
    socket_.setsockopt_ms(NNG_OPT_SENDTIMEO, DEFAULT_NOTICE_TIMEOUT);
    return socket_.listen(listen_path_) == 0;
  }

  bool is_usable() override { return true; }
};

class nanomsg_publisher_peer : public nanomsg_publisher {
public:
  nanomsg_publisher_peer(const io_device &io_device, bool low_latency)
      : nanomsg_publisher(io_device, low_latency, protocol::PUSH) {}

  bool setup() override {
    socket_.setsockopt_ms(NNG_OPT_SENDTIMEO, DEFAULT_NOTICE_TIMEOUT);
    return socket_.dial(dial_path_) == 0;
  }

  bool is_usable() override {
    nlohmann::json ping = {};
    ping["gen_time"] = time::now_in_nano();
    ping["trigger_time"] = 0;
    ping["carrier_type"] = Ping::tag;
    ping["source"] = io_device_.get_home()->uid;
    ping["dest"] = 0;
    ping["data"] = "";
    return publish(ping.dump()) == 0;
  }
};

class nanomsg_observer : public observer, protected nanomsg_resource {
public:
  nanomsg_observer(const io_device &io_device, bool low_latency, protocol p, int recv_timeout = DEFAULT_RECV_TIMEOUT)
      : nanomsg_resource(io_device, low_latency, p),
        recv_flags_(low_latency ? NNG_FLAG_NONBLOCK | NNG_FLAG_ALLOC : NNG_FLAG_ALLOC) {}

  ~nanomsg_observer() override { socket_.close(); }

  bool wait() override {
    bool rc = socket_.recv(recv_flags_) == 0;
    return rc;
  }

  bool nonblock_wait() override {
    bool rc = socket_.recv(NNG_FLAG_NONBLOCK | NNG_FLAG_ALLOC) == 0;
    return rc;
  }

  int get_recv_timeout() const override { return DEFAULT_RECV_TIMEOUT; }

  const std::string &get_notice() override { return socket_.last_message(); }

private:
  int recv_flags_;
};

class nanomsg_observer_coordinator : public nanomsg_observer {
public:
  nanomsg_observer_coordinator(const io_device &io_device, bool low_latency)
      : nanomsg_observer(io_device, low_latency, protocol::PULL) {}

  bool setup() override {
    socket_.setsockopt_ms(NNG_OPT_RECVTIMEO, DEFAULT_RECV_TIMEOUT);
    return socket_.listen(listen_path_) == 0;
  }

  bool is_usable() override { return true; }
};

class nanomsg_observer_peer : public nanomsg_observer {
public:
  nanomsg_observer_peer(const io_device &io_device, bool low_latency)
      : nanomsg_observer(io_device, low_latency, protocol::SUBSCRIBE) {}

  bool setup() override {
    socket_.setsockopt_str(NNG_OPT_SUB_SUBSCRIBE, "");
    socket_.setsockopt_ms(NNG_OPT_RECVTIMEO, DEFAULT_RECV_TIMEOUT);
    return socket_.dial(dial_path_) == 0;
  }

  bool is_usable() override { return socket_.recv(NNG_FLAG_ALLOC) == 0; }
};

namespace {
/**
 * The process's single read of the legacy page-lifecycle environment knobs.
 *
 * Transitional. KF_KEEP_PAGE and KF_MAX_PRE_CREATE_SIZE are undocumented
 * diagnostic knobs with no in-tree consumer; they are honoured here for one
 * migration window and are scheduled for retirement, after which page
 * lifecycle is supplied by the caller through io_mapping_policy only.
 *
 * Reading them here rather than inside journal's constructor keeps the journal
 * a function of its arguments: the entry layer owns configuration, the core
 * carries policy.
 */
io_mapping_policy resolve_legacy_env_lifecycle(io_mapping_policy policy) {
  const auto parsed =
      yijinjing::journal::parse_page_lifecycle(std::getenv("KF_KEEP_PAGE"), std::getenv("KF_MAX_PRE_CREATE_SIZE"));
  if (not parsed.ok()) {
    SPDLOG_WARN("ignoring unusable KF_MAX_PRE_CREATE_SIZE; page pre-creation size ceiling stays disabled");
  }
  return policy.with_lifecycle(parsed.policy);
}
} // namespace

io_device::io_device(data::location_ptr home, const bool low_latency, io_mapping_policy policy)
    : home_(std::move(home)),
      live_home_(location::make_shared(mode::LIVE, home_->role, home_->namespace_, home_->name, home_->locator)),
      low_latency_(low_latency), mapping_policy_(resolve_legacy_env_lifecycle(policy)),
      begin_time_(time::now_in_nano()), bus_(std::make_shared<bus>(is_resource_manager_required())) {
  // keep the guarantees deterministic even when static-library linking drops
  // the seam installers' load-time static initializers
  journal::install_typed_frame_dumper();
  live::install_coordinator_key_value_provider();
  if (spdlog::default_logger()->name().empty()) {
    yijinjing::log::setup_log(home_, home_->name);
  }
  ensure_sqlite_initilize();
  url_factory_ = std::make_shared<ipc_url_factory>();
}

reader_ptr io_device::open_reader_to_subscribe() {
  return std::make_shared<reader>(mapping_policy_.reader, low_latency_, bus_);
}

reader_ptr io_device::open_reader(const data::location_ptr &location, uint32_t dest_id) {
  auto r = std::make_shared<reader>(mapping_policy_.reader, low_latency_, bus_);
  r->join(location, dest_id, 0);
  return r;
}

writer_ptr io_device::open_writer(uint32_t dest_id, uint64_t page_size) {
  if (home_->mode != mode::REPLAY) {
    return std::make_shared<writer>(home_, dest_id, publisher_, low_latency_, bus_, page_size);
  } else {
    return std::make_shared<replay_writer>(live_home_, dest_id, std::make_shared<noop_publisher>(),
                                           std::make_shared<bus>(false), page_size, begin_time_);
  }
}

writer_ptr io_device::open_writer_at(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size) {
  if (home_->mode != mode::REPLAY) {
    return std::make_shared<writer>(location, dest_id, publisher_, low_latency_, bus_, page_size);
  } else {
    return std::make_shared<replay_writer>(location, dest_id, std::make_shared<noop_publisher>(),
                                           std::make_shared<bus>(false), page_size, begin_time_);
  }
}

writer_ptr io_device::open_hookable_writer(uint32_t dest_id, const writer_hook_ptr &hook, uint64_t page_size) {
  if (home_->mode != mode::REPLAY) {
    return std::make_shared<hookable_writer>(home_, dest_id, publisher_, low_latency_, bus_, page_size, hook);
  } else {
    return std::make_shared<replay_writer>(live_home_, dest_id, std::make_shared<noop_publisher>(),
                                           std::make_shared<bus>(false), page_size, begin_time_);
  }
}

writer_ptr io_device::open_hookable_writer_at(const data::location_ptr &location, uint32_t dest_id,
                                              const writer_hook_ptr &hook, uint64_t page_size) {
  if (home_->mode != mode::REPLAY) {
    return std::make_shared<hookable_writer>(location, dest_id, publisher_, low_latency_, bus_, page_size, hook);
  } else {
    return std::make_shared<replay_writer>(live_home_, dest_id, std::make_shared<noop_publisher>(),
                                           std::make_shared<bus>(false), page_size, begin_time_);
  }
}

io_device_coordinator::io_device_coordinator(data::location_ptr home, bool low_latency)
    : io_device(std::move(home), low_latency, io_mapping_policy::coordinator()) {
  publisher_ = std::make_shared<nanomsg_publisher_coordinator>(*this, is_low_latency());
  observer_ = std::make_shared<nanomsg_observer_coordinator>(*this, is_low_latency());
}

io_device_peer::io_device_peer(data::location_ptr home, bool low_latency)
    : io_device(std::move(home), low_latency, io_mapping_policy::peer()) {}

bool io_device_peer::is_usable() {
  nanomsg_publisher_peer publisher(*this, false);
  nanomsg_observer_peer observer(*this, false);
  if (not publisher.setup() or not observer.setup()) {
    return false;
  }
  // Keep the same sockets across this bounded handshake. Recreating the SUB
  // socket after every missed pong repeats the NNG slow-joiner window on
  // Windows and can prevent a healthy coordinator from ever becoming usable.
  for (int attempt = 0; attempt < USABILITY_PROBE_ATTEMPTS; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(TEST_USABLE_TIMEOUT));
    if (publisher.is_usable() and observer.is_usable()) {
      return true;
    }
  }
  return false;
}

bool io_device_peer::setup() {
  publisher_ = std::make_shared<nanomsg_publisher_peer>(*this, is_low_latency());
  observer_ = std::make_shared<nanomsg_observer_peer>(*this, is_low_latency());
  auto is_live_mode = get_home()->mode == mode::LIVE;
  if (not is_live_mode) {
    return true;
  }

  auto try_setup = [&]() {
    auto prc = publisher_->setup();
    auto orc = observer_->setup();
    return prc && orc;
  };

  int count = (REGISTER_TIMEOUT_SECONDS * 1000) / SETUP_TIMEOUT;
  while (not try_setup()) {
    SPDLOG_WARN("try setup failed, retrying...");
    std::this_thread::sleep_for(std::chrono::milliseconds(SETUP_TIMEOUT));
    if (count-- <= 0) {
      SPDLOG_ERROR("setup failed");
      throw yijinjing_error("setup failed");
    }
  }

  return true;
}
} // namespace kungfu::runtime
