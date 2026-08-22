// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/14.
//

#include "watcher.h"
#include "config_store.h"
#include "history.h"
#include <chrono>
#include <kungfu/runtime/state_cache/manager.h>
#include <kungfu/view/action_envelope.h>
#include <memory>
#include <sstream>
#include <typeinfo>
#include <utility>

using namespace kungfu::rx;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::runtime;
using namespace kungfu::runtime::state_cache;
using namespace kungfu::yijinjing::data;
using kungfu::runtime::live::route_extension;

namespace kungfu::node {

constexpr uint32_t STEP_INTERVAL = 10;

inline std::string format(uint32_t uid) { return fmt::format("{:08x}", uid); }

Napi::FunctionReference Watcher::constructor = {};
std::mutex Watcher::instances_mutex_ = {};
std::unordered_set<Watcher *> Watcher::instances_ = {};

inline location_ptr GetWatcherLocation(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsString)) {
    throw Napi::Error::New(info.Env(), "Invalid runtime dirname");
  }

  if (not IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::Error::New(info.Env(), "Invalid node app name");
  }

  auto runtime_dir = info[0].As<Napi::String>().Utf8Value();
  auto name = info[1].As<Napi::String>().Utf8Value();
  auto result = std::make_shared<location>(mode::LIVE, location_role::SYSTEM, "node", name,
                                           IODevice::GetRuntimeLocator(runtime_dir));
  yijinjing::log::copy_log_settings(result, result->name);
  return result;
}

inline bool GetBypassRestore(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 2, &Napi::Value::IsBoolean)) {
    throw Napi::Error::New(info.Env(), "Invalid bypassRestore argument");
  }
  return info[2].As<Napi::Boolean>().Value();
}

inline int GetMillisecondsSleepAfterStep(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 3, &Napi::Value::IsNumber)) {
    throw Napi::Error::New(info.Env(), "Invalid millisecondsSleepAfterStep argument");
  }
  return info[3].As<Napi::Number>().Int32Value();
}

inline bool GetCaptureCustom(const Napi::CallbackInfo &info) {
  return info.Length() > 4 && info[4].IsBoolean() && info[4].As<Napi::Boolean>().Value();
}

// The function-try-block is deliberate: base-class construction (peer
// opens the io device and session index storage) can throw under
// cross-process contention, and a body-level try cannot catch member
// initializer exceptions. A plain std::exception escaping this napi callback
// terminates the whole process; convert to a JS-catchable error instead.
Watcher::Watcher(const Napi::CallbackInfo &info) try
    : ObjectWrap(info),                                                                           //
      peer(GetWatcherLocation(info), true),                                                       //
      milliseconds_sleep_after_step_(GetNumber(info, 3)),                                         //
      capture_custom_(GetCaptureCustom(info)),                                                    //
      ledger_ref_(Napi::ObjectReference::New(Napi::Object::New(info.Env()), 1)),                  //
      app_states_ref_(Napi::ObjectReference::New(Napi::Object::New(info.Env()), 1)),              //
      config_ref_(Napi::ObjectReference::New(ConfigStore::NewInstance({info[0]}).ToObject(), 1)), //
      update_ledger(ledger_ref_),                                                                 //
      reset_cache(*this, ledger_ref_) {                                                           //
  {
    std::lock_guard<std::mutex> guard(instances_mutex_);
    instances_.insert(this);
  }

  serialize::InitStateMap(info, ledger_ref_, "ledger");

  auto from = yijinjing::time::history_window_start();
  auto config_store = ConfigStore::Unwrap(config_ref_.Value());

  bool sync_schema = not get_io_device()->is_usable();
  if (sync_schema) {
    config_store->profile_.setup();
  }

  SPDLOG_INFO("Watcher created for {}", get_home_uname());

  // byPassRestore will be true after ui browserWindow reopen by crashed
  if (GetBypassRestore(info)) {
    return;
  }

  for (const auto &item : config_store->profile_.get_all(Location{})) {
    auto saved_location = location::make_shared(item, get_locator());
    add_location(now(), saved_location);
    RestoreState(saved_location, from, INT64_MAX, sync_schema);
  }
  RestoreState(ledger_home_location_, from, INT64_MAX, sync_schema);
} catch (const Napi::Error &) {
  throw;
} catch (const std::exception &ex) {
  SPDLOG_ERROR("watcher init failed: {}", ex.what());
  throw Napi::Error::New(info.Env(), ex.what());
}

Watcher::~Watcher() {
  SPDLOG_INFO("~Watcher");
  StopAndJoinForCleanup();
  {
    std::lock_guard<std::mutex> guard(instances_mutex_);
    instances_.erase(this);
  }
  config_ref_.Reset();
  app_states_ref_.Reset();
  ledger_ref_.Reset();
  SPDLOG_INFO("~Watcher Done");
}

void Watcher::NoSet(const Napi::CallbackInfo &info, const Napi::Value &value) {
  SPDLOG_WARN("do not manipulate watcher internals");
}

Napi::Value Watcher::HasLocation(const Napi::CallbackInfo &info) {
  uint32_t uid = 0;
  if (info[0].IsNumber()) {
    uid = info[0].ToNumber().Uint32Value();
  }
  if (info[0].IsString()) {
    std::stringstream ss;
    ss << std::hex << info[0].ToString().Utf8Value();
    ss >> uid;
  }

  return Napi::Boolean::New(info.Env(), has_location(uid));
}

Napi::Value Watcher::GetLocation(const Napi::CallbackInfo &info) {
  auto location = FindLocation(info);
  if (not location) {
    return {};
  }
  auto locationObj = Napi::Object::New(info.Env());
  locationObj.Set("role", Napi::String::New(info.Env(), get_location_role_name(location->role)));
  locationObj.Set("namespace", Napi::String::New(info.Env(), location->namespace_));
  locationObj.Set("name", Napi::String::New(info.Env(), location->name));
  locationObj.Set("mode", Napi::String::New(info.Env(), get_mode_name(location->mode)));
  locationObj.Set("uname", Napi::String::New(info.Env(), location->uname));
  locationObj.Set("uid", Napi::Number::New(info.Env(), location->uid));
  return locationObj;
}

Napi::Value Watcher::GetLocationUID(const Napi::CallbackInfo &info) {
  auto target_location = IODevice::ExtractLocation(info, 0, get_locator());
  return Napi::Number::New(info.Env(), target_location->uid);
}

Napi::Value Watcher::GetLedger(const Napi::CallbackInfo &info) { return ledger_ref_.Value(); }

Napi::Value Watcher::GetAppStates(const Napi::CallbackInfo &info) { return app_states_ref_.Value(); }

Napi::Value Watcher::Now(const Napi::CallbackInfo &info) {
  return Napi::BigInt::New(ledger_ref_.Env(), yijinjing::time::now_in_nano());
}

Napi::Value Watcher::IsUsable(const Napi::CallbackInfo &info) { return Napi::Boolean::New(info.Env(), is_usable()); }

Napi::Value Watcher::IsLive(const Napi::CallbackInfo &info) { return Napi::Boolean::New(info.Env(), is_live()); }

Napi::Value Watcher::IsStarted(const Napi::CallbackInfo &info) { return Napi::Boolean::New(info.Env(), is_started()); }

Napi::Value Watcher::RequestStop(const Napi::CallbackInfo &info) {
  auto app_location = IODevice::ExtractLocation(info, 0, get_locator());

  // Stop the coordinator through its per-peer command channel.
  if (app_location->role == location_role::SYSTEM &&
      runtime::live::is_coordinator_wire_namespace(app_location->namespace_)) {
    if (not has_writer(get_coordinator_command_uid())) {
      return Napi::Boolean::New(info.Env(), false);
    }
    get_writer(get_coordinator_command_uid())->mark(now(), RequestStop::tag);
    return Napi::Boolean::New(info.Env(), true);
  }

  if (not has_writer(app_location->uid)) {
    return Napi::Boolean::New(info.Env(), false);
  }
  get_writer(app_location->uid)->mark(now(), RequestStop::tag);
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Watcher::PublishState(const Napi::CallbackInfo &info) {
  if (IsValid(info, 0, &Napi::Value::IsObject)) {
    publish(info[0].ToObject());
  }
  return {};
}

Napi::Value Watcher::IsReadyToInteract(const Napi::CallbackInfo &info) {
  auto account_location = IODevice::ExtractLocation(info, 0, get_locator());
  return Napi::Boolean::New(info.Env(), account_location and has_writer(account_location->uid) and
                                            is_location_live(account_location->uid));
}

Napi::Value Watcher::IssueCustomData(const Napi::CallbackInfo &info) {
  SPDLOG_INFO("issue custom data manually");
  return InteractWithLocation<TimeKeyValue>(info, info[0].ToObject());
}

Napi::Value Watcher::IssueRawPublic(const Napi::CallbackInfo &info) {
  if (not capture_custom_) {
    throw Napi::Error::New(info.Env(), "custom frame capture was not enabled for this peer");
  }
  if (not IsValid(info, 0, &Napi::Value::IsNumber) || not info[1].IsBuffer()) {
    throw Napi::Error::New(info.Env(), "issueRawPublic requires carrierType and Buffer");
  }
  auto carrier_type = info[0].As<Napi::Number>().Int32Value();
  if (carrier_type <= 0 || (carrier_type != kungfu::view::action::ACTION_ENVELOPE_CARRIER_TYPE &&
                            yijinjing::contains_tag(yijinjing::AllTypesTags, carrier_type))) {
    throw Napi::Error::New(info.Env(), "carrierType must be the action envelope or an open custom carrier");
  }
  auto &writer = get_public_writer();
  if (not writer) {
    return Napi::Boolean::New(info.Env(), false);
  }
  auto payload = info[1].As<Napi::Buffer<uint8_t>>();
  if (payload.Length() > MAX_CUSTOM_FRAME_BYTES) {
    throw Napi::Error::New(info.Env(), "custom frame exceeds the 1 MiB peer limit");
  }
  auto tx = writer->reserve_frame(now(), carrier_type, payload.Length());
  tx.copy_bytes(payload.Data(), payload.Length());
  tx.commit(payload.Length());
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Watcher::RequestReadFromPublic(const Napi::CallbackInfo &info) {
  if (not capture_custom_) {
    throw Napi::Error::New(info.Env(), "custom frame capture was not enabled for this peer");
  }
  if (not is_live()) {
    return Napi::Boolean::New(info.Env(), false);
  }
  if (not has_writer(get_coordinator_command_uid())) {
    return Napi::Boolean::New(info.Env(), false);
  }
  auto source_location = IODevice::ExtractLocation(info, 0, get_locator());
  auto from_time = GetBigInt(info, 1);
  request_read_from_public(now(), source_location->uid, from_time);
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Watcher::CanRequestReadFromPublic(const Napi::CallbackInfo &info) {
  std::lock_guard<std::mutex> lock(writers_mtx_);
  return Napi::Boolean::New(info.Env(), is_live() and writers_.find(get_coordinator_command_uid()) != writers_.end());
}

Napi::Value Watcher::DrainCustomData(const Napi::CallbackInfo &info) {
  std::deque<custom_frame_record> drained;
  uint64_t dropped = 0;
  {
    std::lock_guard<std::mutex> guard(custom_frames_mutex_);
    drained.swap(custom_frames_);
    dropped = std::exchange(custom_frames_dropped_, 0);
    custom_frames_bytes_ = 0;
  }
  auto frames = Napi::Array::New(info.Env(), drained.size());
  for (size_t index = 0; index < drained.size(); ++index) {
    const auto &record = drained[index];
    auto item = Napi::Object::New(info.Env());
    item.Set("genTime", Napi::BigInt::New(info.Env(), record.gen_time));
    item.Set("triggerTime", Napi::BigInt::New(info.Env(), record.trigger_time));
    item.Set("frameUid", Napi::BigInt::New(info.Env(), record.frame_uid));
    item.Set("carrierType", Napi::Number::New(info.Env(), record.carrier_type));
    item.Set("source", Napi::Number::New(info.Env(), record.source));
    item.Set("dest", Napi::Number::New(info.Env(), record.dest));
    item.Set("data", Napi::Buffer<uint8_t>::Copy(info.Env(), record.payload.data(), record.payload.size()));
    frames.Set(index, item);
  }
  auto result = Napi::Object::New(info.Env());
  result.Set("dropped", Napi::BigInt::New(info.Env(), dropped));
  result.Set("frames", frames);
  return result;
}

Napi::Value Watcher::GetRuntimeStats(const Napi::CallbackInfo &info) {
  size_t custom_queue_bytes = 0;
  size_t custom_queue_frames = 0;
  uint64_t custom_frames_dropped = 0;
  {
    std::lock_guard<std::mutex> guard(custom_frames_mutex_);
    custom_queue_bytes = custom_frames_bytes_;
    custom_queue_frames = custom_frames_.size();
    custom_frames_dropped = custom_frames_dropped_;
  }

  const auto step_count = step_count_.load();
  const auto snapshot_deliveries = snapshot_deliveries_.load();
  const auto snapshot_lock_samples = snapshot_lock_samples_.load();
  auto result = Napi::Object::New(info.Env());
  result.Set("schema", Napi::String::New(info.Env(), "kungfu.node-watcher-runtime-stats/v1"));
  result.Set("threadModel", Napi::String::New(info.Env(), "dedicated-native-thread"));
  result.Set("running", Napi::Boolean::New(info.Env(), worker_live_.load()));
  result.Set("stopRequested", Napi::Boolean::New(info.Env(), quit_.load()));
  result.Set("bridgeQueueCapacity", Napi::Number::New(info.Env(), 1));
  result.Set("bridgeQueueDepth", Napi::Number::New(info.Env(), snapshot_pending_.load() ? 1 : 0));
  result.Set("stepCount", Napi::BigInt::New(info.Env(), step_count));
  result.Set("stepMeanNanos",
             Napi::BigInt::New(info.Env(), step_count == 0 ? 0 : step_total_nanos_.load() / step_count));
  result.Set("stepMaxNanos", Napi::BigInt::New(info.Env(), step_max_nanos_.load()));
  result.Set("workerLockWaitMeanNanos",
             Napi::BigInt::New(info.Env(), step_count == 0 ? 0 : worker_lock_wait_total_nanos_.load() / step_count));
  result.Set("workerLockWaitMaxNanos", Napi::BigInt::New(info.Env(), worker_lock_wait_max_nanos_.load()));
  result.Set("snapshotLockWaitMeanNanos",
             Napi::BigInt::New(info.Env(), snapshot_lock_samples == 0
                                               ? 0
                                               : snapshot_lock_wait_total_nanos_.load() / snapshot_lock_samples));
  result.Set("snapshotLockWaitMaxNanos", Napi::BigInt::New(info.Env(), snapshot_lock_wait_max_nanos_.load()));
  result.Set("snapshotHoldMeanNanos",
             Napi::BigInt::New(info.Env(), snapshot_lock_samples == 0
                                               ? 0
                                               : snapshot_hold_total_nanos_.load() / snapshot_lock_samples));
  result.Set("snapshotHoldMaxNanos", Napi::BigInt::New(info.Env(), snapshot_hold_max_nanos_.load()));
  result.Set("snapshotRequests", Napi::BigInt::New(info.Env(), snapshot_requests_.load()));
  result.Set("snapshotDeliveries", Napi::BigInt::New(info.Env(), snapshot_deliveries));
  result.Set("snapshotCoalesced", Napi::BigInt::New(info.Env(), snapshot_coalesced_.load()));
  result.Set("bridgeFailures", Napi::BigInt::New(info.Env(), bridge_failures_.load()));
  result.Set("customQueueBytes", Napi::BigInt::New(info.Env(), static_cast<uint64_t>(custom_queue_bytes)));
  result.Set("customQueueFrames", Napi::BigInt::New(info.Env(), static_cast<uint64_t>(custom_queue_frames)));
  result.Set("customQueueCapacityBytes",
             Napi::BigInt::New(info.Env(), static_cast<uint64_t>(CUSTOM_FRAME_QUEUE_BYTES)));
  result.Set("customFramesDropped", Napi::BigInt::New(info.Env(), custom_frames_dropped));
  return result;
}

Napi::Value Watcher::IssueMark(const Napi::CallbackInfo &info) {
  SPDLOG_INFO("issue mark");
  uint32_t tag = GetNumber(info, 0);
  auto target_location = IODevice::ExtractLocation(info, 1, get_locator());
  if (not has_writer(target_location->location_uid)) {
    return Napi::Boolean::New(info.Env(), false);
  }
  get_writer(target_location->location_uid)->mark(yijinjing::time::now_in_nano(), tag);
  return Napi::Boolean::New(info.Env(), true);
}

void Watcher::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "Watcher",
                                    {
                                        InstanceMethod("now", &Watcher::Now),                                     //
                                        InstanceMethod("isUsable", &Watcher::IsUsable),                           //
                                        InstanceMethod("isLive", &Watcher::IsLive),                               //
                                        InstanceMethod("isStarted", &Watcher::IsStarted),                         //
                                        InstanceMethod("requestStop", &Watcher::RequestStop),                     //
                                        InstanceMethod("hasLocation", &Watcher::HasLocation),                     //
                                        InstanceMethod("getLocation", &Watcher::GetLocation),                     //
                                        InstanceMethod("getLocationUID", &Watcher::GetLocationUID),               //
                                        InstanceMethod("publishState", &Watcher::PublishState),                   //
                                        InstanceMethod("isReadyToInteract", &Watcher::IsReadyToInteract),         //
                                        InstanceMethod("issueCustomData", &Watcher::IssueCustomData),             //
                                        InstanceMethod("issueRawPublic", &Watcher::IssueRawPublic),               //
                                        InstanceMethod("requestReadFromPublic", &Watcher::RequestReadFromPublic), //
                                        InstanceMethod("canRequestReadFromPublic",                                //
                                                       &Watcher::CanRequestReadFromPublic),                       //
                                        InstanceMethod("drainCustomData", &Watcher::DrainCustomData),             //
                                        InstanceMethod("runtimeStats", &Watcher::GetRuntimeStats),                //
                                        InstanceMethod("issueMark", &Watcher::IssueMark),                         //
                                        InstanceMethod("start", &Watcher::Start),                                 //
                                        InstanceMethod("sync", &Watcher::Sync),                                   //
                                        InstanceMethod("quit", &Watcher::Quit),                                   //
                                        InstanceAccessor("ledger", &Watcher::GetLedger, &Watcher::NoSet),         //
                                        InstanceAccessor("appStates", &Watcher::GetAppStates, &Watcher::NoSet),   //
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("Watcher", func);
}

void Watcher::on_react() {
  SPDLOG_INFO("watcher on react");

  // Declared, not subscribed here: peer::react() calls this hook before its own
  // declarations and wires the whole table at the end, so these keep their
  // position ahead of the peer's routes (KF-ADR-019f86da-4f90-786d-9fd5-468c3f3d231b).
  using kungfu::runtime::live::route_phase;

  declare<Register>(route_phase::handle, "Watcher::OnRegister",
                    $R(OnRegister(event->gen_time(), event->data<Register>())));
  declare<Deregister>(route_phase::handle, "Watcher::OnDeregister",
                      $R(OnDeregister(event->gen_time(), event->data<Deregister>())));
  if (capture_custom_) {
    // Selects on no single carrier: a custom event is defined by not being a
    // known type, so the predicate cannot be a carrier tag. Installed only when
    // capture is enabled, which is why a topology answer for this consumer
    // cannot be read off the source alone.
    declare_events(route_phase::handle, "Watcher::CaptureCustomEvent", $R(CaptureCustomEvent(event)))
        .guard("is_custom_or_action_envelope",
               [](const event_ptr &event) {
                 return is_custom_event(event) ||
                        event->carrier_type() == kungfu::view::action::ACTION_ENVELOPE_CARRIER_TYPE;
               })
        // The guard is opaque, so this consumer is otherwise unattributable: it
        // handles ACTION_ENVELOPE without the carrier appearing in any selector.
        .consumes(kungfu::view::action::ACTION_ENVELOPE_CARRIER_TYPE)
        .why("the node client observes custom events and action envelopes when capture is enabled");
  }
  // take_until needs a second stream and cannot be a guard, so it uses the
  // stream slot; the chain is kept verbatim.
  declare_events(route_phase::handle, "Watcher::feed_state_data", $R(manager::feed_state_data(event, data_bank_)))
      .op([&](const rx::observable<event_ptr> &src) { return src | take_until(events_ | is(RequestStart::tag)); })
      .why("bootstrap state reaches the node data bank only until RequestStart");
}

bool Watcher::has_writer(uint32_t dest_id) const { return writers_.find(dest_id) != writers_.end(); }

yijinjing::journal::writer_ptr Watcher::get_writer(uint32_t dest_id) const {
  if (writers_.find(dest_id) == writers_.end()) {
    SPDLOG_ERROR("no writer for {}", get_location_uname(dest_id));
  }
  return writers_.at(dest_id);
}

void Watcher::on_start() {
  // These install here, not in on_react(), and on_start() may run from
  // peer::on_request_start() — that is, from inside an events_ handler, after
  // wire_routes() has already installed the table. They cannot be declared, so
  // they subscribe at once and are recorded to stay attributable (KF-ADR-019f86da-4f90-786d-9fd5-468c3f3d231b).
  declare_dynamic_events(route_extension::start_hook, "Watcher::feed_state_data_started",
                         $R(manager::feed_state_data(event, data_bank_)));
  declare_dynamic<Channel>(route_extension::start_hook, "Watcher::InspectChannel",
                           $R(InspectChannel(event->gen_time(), event->data<Channel>())));
  declare_dynamic<CacheReset>(route_extension::start_hook, "Watcher::UpdateEventCache", $R(UpdateEventCache(event)));
}

void Watcher::RestoreState(const location_ptr &state_location, int64_t from, int64_t to, bool sync_schema) {
  add_location(0, state_location);
  serialize::JsRestoreState(ledger_ref_, state_location)(from, to, sync_schema);
}

Napi::Value Watcher::Start(const Napi::CallbackInfo &info) {
  SPDLOG_INFO("start");
  StartWorker();
  return {};
}

void Watcher::Sync(const Napi::CallbackInfo &info) {
  const auto waiting_at = std::chrono::steady_clock::now();
  std::unique_lock<std::mutex> guard(feed_mutex_);
  const auto acquired_at = std::chrono::steady_clock::now();
  SyncEventCache();
  SyncAppStates();
  SyncLedger();
  const auto completed_at = std::chrono::steady_clock::now();
  ObserveDuration(snapshot_lock_wait_total_nanos_, snapshot_lock_wait_max_nanos_,
                  std::chrono::duration_cast<std::chrono::nanoseconds>(acquired_at - waiting_at).count());
  ObserveDuration(snapshot_hold_total_nanos_, snapshot_hold_max_nanos_,
                  std::chrono::duration_cast<std::chrono::nanoseconds>(completed_at - acquired_at).count());
  ++snapshot_lock_samples_;
}

void Watcher::SyncLedger() {
  boost::hana::for_each(StateDataTypes, [&](auto it) { UpdateLedger(+boost::hana::second(it)); });
}

void Watcher::SyncAppStates() {}

void Watcher::SyncEventCache() {
  if (reset_cache_states_.size()) {
    for (const auto &reset_state : reset_cache_states_) {
      reset_cache(reset_state);
    }
    reset_cache_states_.clear();
  }
}

void Watcher::UpdateEventCache(const event_ptr &event) {
  const auto &request = event->data<CacheReset>();
  boost::hana::for_each(StateDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (DataType::tag == request.carrier_type) {
      auto hana_type = boost::hana::type_c<DataType>;
      using DelMap = std::unordered_map<uint64_t, state<DataType>>;
      auto &del_map = const_cast<DelMap &>(data_bank_[hana_type]);
      auto iter = del_map.begin();
      while (iter != del_map.end()) {
        auto s = iter->second;
        auto source_id = s.source;
        auto dest_id = s.dest;
        if ((source_id == event->source() and dest_id == event->dest()) || source_id == event->dest()) {
          iter = del_map.erase(iter);
        } else {
          iter++;
        }
      }
    }
  });
  reset_cache_states_.push_back(state<CacheReset>(event));
}

void Watcher::CaptureCustomEvent(const event_ptr &event) {
  custom_frame_record record{
      event->gen_time(),
      event->trigger_time(),
      event->frame_uid(),
      event->carrier_type(),
      event->source(),
      event->dest(),
      std::vector<uint8_t>(reinterpret_cast<const uint8_t *>(event->data_address()),
                           reinterpret_cast<const uint8_t *>(event->data_address()) + event->data_length())};
  std::lock_guard<std::mutex> guard(custom_frames_mutex_);
  if (record.payload.size() > CUSTOM_FRAME_QUEUE_BYTES) {
    ++custom_frames_dropped_;
    return;
  }
  while (custom_frames_bytes_ + record.payload.size() > CUSTOM_FRAME_QUEUE_BYTES && not custom_frames_.empty()) {
    custom_frames_bytes_ -= custom_frames_.front().payload.size();
    custom_frames_.pop_front();
    ++custom_frames_dropped_;
  }
  custom_frames_bytes_ += record.payload.size();
  custom_frames_.push_back(std::move(record));
}

location_ptr Watcher::FindLocation(const Napi::CallbackInfo &info) {
  if (info.Length() == 0) {
    return get_io_device()->get_live_home();
  }
  uint32_t uid = 0;
  if (info[0].IsNumber()) {
    uid = info[0].ToNumber().Uint32Value();
  }
  if (info[0].IsString()) {
    std::stringstream ss;
    ss << std::hex << info[0].ToString().Utf8Value();
    ss >> uid;
  }
  if (has_location(uid)) {
    return get_location(uid);
  }
  return location_ptr();
}

void Watcher::InspectChannel(int64_t trigger_time, const Channel &channel) {
  if (channel.source_id != get_live_home_uid() and channel.dest_id != get_live_home_uid()) {
    reader_join(channel.source_id, channel.dest_id, trigger_time);
  }
}

void Watcher::OnRegister(int64_t trigger_time, const Register &register_data) {
  auto app_uid = register_data.location_uid;
  if (app_uid == get_live_home_uid()) {
    return;
  }
}

void Watcher::OnDeregister(int64_t trigger_time, const Deregister &deregister_data) {
  auto app_location = location::make_shared(deregister_data, get_locator());
  if (app_location->role == location_role::SYSTEM and
      runtime::live::is_coordinator_wire_namespace(app_location->namespace_) and
      app_location->name == runtime::live::COORDINATOR_WIRE_NAME) {
    CancelWorker();
  }
}

void Watcher::StartWorker() {
  if (quit_.load()) {
    throw Napi::Error::New(ledger_ref_.Env(), "cannot restart a watcher after quit");
  }
  if (worker_live_.load() || worker_thread_.joinable()) {
    throw Napi::Error::New(ledger_ref_.Env(), "watcher worker is already running");
  }

  worker_live_ = true;
  snapshot_pending_ = false;
  Ref();
  bool bridge_created = false;
  try {
    worker_bridge_ = Napi::ThreadSafeFunction::New(
        ledger_ref_.Env(), Napi::Function::New(ledger_ref_.Env(), [](const Napi::CallbackInfo &) {}),
        "KungfuWatcherBridge", 1, 1);
    bridge_created = true;
    worker_thread_ = std::thread(&Watcher::RunWorker, this);
  } catch (...) {
    worker_live_ = false;
    if (bridge_created) {
      worker_bridge_.Abort();
    }
    Unref();
    throw;
  }
}

void Watcher::CancelWorker() { worker_live_ = false; }

void Watcher::RunWorker() {
  while (worker_live_.load() && not environment_closing_.load()) {
    // An exception escaping this dedicated thread terminates the process.
    // Transient storage contention is retried after the bounded backoff.
    try {
      if (not is_live() and not is_started() and is_usable()) {
        setup();
      }
      while (worker_live_.load() && is_live()) {
        const auto waiting_at = std::chrono::steady_clock::now();
        std::unique_lock<std::mutex> guard(feed_mutex_);
        const auto acquired_at = std::chrono::steady_clock::now();
        if (not is_step_continually()) {
          break;
        }
        step(STEP_INTERVAL);
        const auto completed_at = std::chrono::steady_clock::now();
        ObserveDuration(worker_lock_wait_total_nanos_, worker_lock_wait_max_nanos_,
                        std::chrono::duration_cast<std::chrono::nanoseconds>(acquired_at - waiting_at).count());
        ObserveDuration(step_total_nanos_, step_max_nanos_,
                        std::chrono::duration_cast<std::chrono::nanoseconds>(completed_at - acquired_at).count());
        ++step_count_;
        guard.unlock();
        QueueSnapshot();
      }
    } catch (const std::exception &ex) {
      if (get_loop_error()) {
        SPDLOG_ERROR("watcher event loop failed: {}", ex.what());
        RecordWorkerError(std::current_exception());
        signal_stop();
        worker_live_ = false;
        break;
      }
      SPDLOG_ERROR("watcher worker error, backing off: {}", ex.what());
    } catch (...) {
      if (get_loop_error()) {
        SPDLOG_ERROR("watcher event loop failed with a non-standard exception");
        RecordWorkerError(std::current_exception());
        signal_stop();
        worker_live_ = false;
        break;
      }
      SPDLOG_ERROR("watcher worker got a transient non-standard error, backing off");
    }
    std::this_thread::sleep_for(std::chrono::microseconds(milliseconds_sleep_after_step_));
  }
  signal_stop();
  pause();
  worker_live_ = false;

  // Coordinator reconnect backoff belongs on the dedicated native thread, not
  // the Node event loop. Quit and fatal-error paths complete immediately.
  if (not quit_.load() && not environment_closing_.load() && not HasWorkerError()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1000));
  }
  QueueWorkerStopped();
  SPDLOG_INFO("Watcher dedicated loop stopped");
}

void Watcher::QueueSnapshot() {
  ++snapshot_requests_;
  if (snapshot_pending_.exchange(true)) {
    ++snapshot_coalesced_;
    return;
  }
  auto event = std::make_unique<bridge_event>(bridge_event{this, bridge_event_kind::snapshot_ready});
  const auto status = worker_bridge_.NonBlockingCall(event.get(), [](Napi::Env env, Napi::Function, bridge_event *raw) {
    const std::unique_ptr<bridge_event> event(raw);
    event->watcher->HandleBridgeEvent(env, event->kind);
  });
  if (status != napi_ok) {
    snapshot_pending_ = false;
    ++bridge_failures_;
  } else {
    // The accepted bridge callback now owns the event through its unique_ptr.
    (void)event.release();
  }
}

void Watcher::QueueWorkerStopped() {
  if (environment_closing_.load()) {
    worker_bridge_.Release();
    return;
  }
  auto event = std::make_unique<bridge_event>(bridge_event{this, bridge_event_kind::worker_stopped});
  napi_status status = napi_queue_full;
  while (status == napi_queue_full && not environment_closing_.load()) {
    status = worker_bridge_.NonBlockingCall(event.get(), [](Napi::Env env, Napi::Function, bridge_event *raw) {
      const std::unique_ptr<bridge_event> event(raw);
      event->watcher->HandleBridgeEvent(env, event->kind);
    });
    if (status == napi_queue_full) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  if (status != napi_ok) {
    ++bridge_failures_;
  } else {
    // The accepted bridge callback now owns the event through its unique_ptr.
    (void)event.release();
  }
  worker_bridge_.Release();
}

void Watcher::HandleBridgeEvent(Napi::Env env, bridge_event_kind kind) {
  if (kind == bridge_event_kind::snapshot_ready) {
    if (not quit_.load() && not environment_closing_.load()) {
      try {
        SyncSnapshot();
      } catch (...) {
        RecordWorkerError(std::current_exception());
        CancelWorker();
      }
    } else {
      snapshot_pending_ = false;
    }
    return;
  }

  SPDLOG_INFO("Watcher dedicated loop completed");
  if (worker_thread_.joinable()) {
    worker_thread_.join();
  }
  if (auto error = TakeWorkerError()) {
    try {
      std::rethrow_exception(error);
    } catch (const yijinjing::journal::replay_exhausted &ex) {
      auto js_error = Napi::Error::New(env, ex.what());
      js_error.Value().Set("name", Napi::String::New(env, "ReplayExhaustedError"));
      js_error.Value().Set("carrierType", Napi::Number::New(env, ex.carrier_type()));
      js_error.Value().Set("triggerTime", Napi::BigInt::New(env, ex.trigger_time()));
      js_error.ThrowAsJavaScriptException();
    } catch (const std::exception &ex) {
      auto js_error = Napi::Error::New(env, ex.what());
      js_error.Value().Set("name", Napi::String::New(env, "KungfuRuntimeError"));
      js_error.Value().Set("nativeType", Napi::String::New(env, typeid(ex).name()));
      js_error.ThrowAsJavaScriptException();
    } catch (...) {
      Napi::Error::New(env, "kungfu watcher failed with a non-standard exception").ThrowAsJavaScriptException();
    }
    Unref();
    return;
  }

  if (quit_.load()) {
    SPDLOG_INFO("watcher quit");
    Unref();
    return;
  }

  AfterCoordinatorDown(env);
  set_begin_time(yijinjing::time::now_in_nano());
  SPDLOG_INFO("Restart watcher dedicated loop");
  try {
    StartWorker();
  } catch (const Napi::Error &error) {
    error.ThrowAsJavaScriptException();
  } catch (const std::exception &error) {
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
  }
  Unref();
}

void Watcher::SyncSnapshot() {
  const auto waiting_at = std::chrono::steady_clock::now();
  std::unique_lock<std::mutex> guard(feed_mutex_);
  const auto acquired_at = std::chrono::steady_clock::now();
  SyncEventCache();
  SyncAppStates();
  SyncLedger();
  snapshot_pending_ = false;
  const auto completed_at = std::chrono::steady_clock::now();
  ++snapshot_deliveries_;
  ObserveDuration(snapshot_lock_wait_total_nanos_, snapshot_lock_wait_max_nanos_,
                  std::chrono::duration_cast<std::chrono::nanoseconds>(acquired_at - waiting_at).count());
  ObserveDuration(snapshot_hold_total_nanos_, snapshot_hold_max_nanos_,
                  std::chrono::duration_cast<std::chrono::nanoseconds>(completed_at - acquired_at).count());
  ++snapshot_lock_samples_;
}

void Watcher::StopAndJoinForCleanup() {
  environment_closing_ = true;
  worker_live_ = false;
  get_io_device()->cancel_usability_probe();
  if (worker_thread_.joinable()) {
    worker_thread_.join();
  }
}

void Watcher::ObserveDuration(std::atomic<uint64_t> &total, std::atomic<uint64_t> &maximum, uint64_t nanos) {
  total.fetch_add(nanos);
  auto observed = maximum.load();
  while (observed < nanos && not maximum.compare_exchange_weak(observed, nanos)) {
  }
}

void Watcher::cleanup() {
  SPDLOG_INFO("Watcher reset");
  std::vector<Watcher *> watchers;
  {
    std::lock_guard<std::mutex> guard(instances_mutex_);
    watchers.assign(instances_.begin(), instances_.end());
  }
  for (auto watcher : watchers) {
    watcher->StopAndJoinForCleanup();
  }
  Watcher::constructor.Reset();
}

void Watcher::RecordWorkerError(const std::exception_ptr &error) {
  std::lock_guard<std::mutex> guard(worker_error_mutex_);
  if (not worker_error_) {
    worker_error_ = error;
  }
}

bool Watcher::HasWorkerError() {
  std::lock_guard<std::mutex> guard(worker_error_mutex_);
  return static_cast<bool>(worker_error_);
}

std::exception_ptr Watcher::TakeWorkerError() {
  std::lock_guard<std::mutex> guard(worker_error_mutex_);
  return std::exchange(worker_error_, nullptr);
}

void Watcher::Quit(const Napi::CallbackInfo &info) {
  RequestDeregister();
  quit_ = true;
  worker_live_ = false;
  get_io_device()->cancel_usability_probe();
}

void Watcher::RequestDeregister() {
  if (not has_writer(get_coordinator_command_uid())) {
    SPDLOG_WARN("no coordinator command writer");
    return;
  }

  auto writer = get_writer(get_coordinator_command_uid());
  writer->mark(now(), RequestDeregister::tag);
  SPDLOG_INFO("RequestDeregister");
}

void Watcher::AfterCoordinatorDown(Napi::Env env) {
  SPDLOG_INFO("after coordinator down");
  reader_->clear();
  {
    std::lock_guard<std::mutex> lock(writers_mtx_);
    writers_.clear();
    coordinator_cmd_writer_for_thread_.reset();
    public_writer_.reset();
    thread_writer_.reset();
  }
  {
    std::lock_guard<std::mutex> lock(off_thread_mtx_);
    off_thread_writers_.clear();
  }
  serialize::InitObjectReference(env, app_states_ref_);
  serialize::InitStateMap(env, ledger_ref_, "ledger");
}

bool Watcher::is_reactable(const event_ptr &event) { return capture_custom_ || not is_custom_event(event); }

bool Watcher::is_step_continually() { return reader_->data_available(); }

} // namespace kungfu::node
