// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/14.
//

#include "watcher.h"
#include "config_store.h"
#include "history.h"
#include <kungfu/runtime/state_cache/manager.h>
#include <kungfu/view/action_envelope.h>
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
  uv_work_.data = nullptr;
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
  writer->write_raw(now(), carrier_type, reinterpret_cast<uintptr_t>(payload.Data()), payload.Length());
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Watcher::RequestReadFromPublic(const Napi::CallbackInfo &info) {
  if (not capture_custom_) {
    throw Napi::Error::New(info.Env(), "custom frame capture was not enabled for this peer");
  }
  if (not is_live()) {
    return Napi::Boolean::New(info.Env(), false);
  }
  auto source_location = IODevice::ExtractLocation(info, 0, get_locator());
  auto from_time = GetBigInt(info, 1);
  request_read_from_public(now(), source_location->uid, from_time);
  return Napi::Boolean::New(info.Env(), true);
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
                                        InstanceMethod("drainCustomData", &Watcher::DrainCustomData),             //
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
  std::lock_guard<std::mutex> guard(feed_mutex_);
  SyncEventCache();
  SyncAppStates();
  SyncLedger();
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
  uv_work_.data = static_cast<void *>(this);
  uv_work_live_ = true;
  auto worker = [](uv_work_t *req) {
    auto watcher = static_cast<Watcher *>(req->data);
    while (req->data && watcher->uv_work_live_) {
      // An exception escaping this uv worker thread cannot be caught by any
      // frame above us and terminates the whole process. Storage contention
      // (e.g. SQLITE_BUSY when another process holds a write lock past the
      // busy timeout) is transient by nature: log, back off, and retry on
      // the next tick instead of dying.
      try {
        if (not watcher->is_live() and not watcher->is_started() and watcher->is_usable()) {
          watcher->setup();
        }
        while (watcher->is_live()) {
          std::lock_guard<std::mutex> guard(watcher->feed_mutex_);

          if (not watcher->is_step_continually()) {
            break;
          }

          watcher->step(STEP_INTERVAL);
        }
      } catch (const std::exception &ex) {
        if (watcher->get_loop_error()) {
          SPDLOG_ERROR("watcher event loop failed: {}", ex.what());
          watcher->RecordWorkerError(std::current_exception());
          watcher->signal_stop();
          watcher->uv_work_live_ = false;
          break;
        }
        SPDLOG_ERROR("watcher worker error, backing off: {}", ex.what());
      } catch (...) {
        if (watcher->get_loop_error()) {
          SPDLOG_ERROR("watcher event loop failed with a non-standard exception");
          watcher->RecordWorkerError(std::current_exception());
          watcher->signal_stop();
          watcher->uv_work_live_ = false;
          break;
        }
        SPDLOG_ERROR("watcher worker got a transient non-standard error, backing off");
      }
      std::this_thread::sleep_for(std::chrono::microseconds(watcher->milliseconds_sleep_after_step_));
    }
    watcher->signal_stop();
    watcher->pause();
    SPDLOG_INFO("Watcher uv loop stopped");
  };
  auto after = [](uv_work_t *req, int status) {
    SPDLOG_INFO("Watcher uv loop completed");
    auto watcher = static_cast<Watcher *>(req->data);
    if (auto error = watcher->TakeWorkerError()) {
      auto env = watcher->ledger_ref_.Env();
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
      watcher->Unref();
      return;
    }
    // have to be at this position, for deleting old journal securitily
    auto env = watcher->ledger_ref_.Env();
    Napi::HandleScope scope(env);

    if (watcher->quit_) {
      SPDLOG_INFO("watcher quit");
      watcher->Unref();
      return;
    } else {
      // Wait until the coordinator is fully down before reconnecting.
      std::this_thread::sleep_for(std::chrono::milliseconds(1000));
    }

    watcher->AfterCoordinatorDown(env);
    watcher->set_begin_time(yijinjing::time::now_in_nano());
    SPDLOG_INFO("Restart watcher uv loop");
    // The coordinator may quit while the watcher is running; restart the UV
    // loop after its deregistration has been observed.
    try {
      watcher->StartWorker();
    } catch (const Napi::Error &error) {
      error.ThrowAsJavaScriptException();
    } catch (const std::exception &error) {
      Napi::Error::New(watcher->ledger_ref_.Env(), error.what()).ThrowAsJavaScriptException();
    }
    watcher->Unref();
  };

  Ref();
  const auto rc = uv_queue_work(uv_default_loop(), &uv_work_, worker, after);
  if (rc != 0) {
    Unref();
    uv_work_live_ = false;
    throw Napi::Error::New(ledger_ref_.Env(), fmt::format("failed to queue watcher worker: {}", uv_strerror(rc)));
  }
}

void Watcher::CancelWorker() { uv_work_live_ = false; }

void Watcher::RecordWorkerError(const std::exception_ptr &error) {
  if (not worker_error_) {
    worker_error_ = error;
  }
}

std::exception_ptr Watcher::TakeWorkerError() { return std::exchange(worker_error_, nullptr); }

void Watcher::Quit(const Napi::CallbackInfo &info) {
  RequestDeregister();
  quit_ = true;
  uv_work_live_ = false;
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
  // disjoin(get_coordinator_command_uid());
  reader_->clear();
  writers_.clear();
  off_thread_writers_.clear();
  serialize::InitObjectReference(env, app_states_ref_);
  serialize::InitStateMap(env, ledger_ref_, "ledger");
}

bool Watcher::is_reactable(const event_ptr &event) { return capture_custom_ || not is_custom_event(event); }

bool Watcher::is_step_continually() { return reader_->data_available(); }

} // namespace kungfu::node
