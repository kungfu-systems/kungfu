// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/14.
//

#include "watcher.h"
#include "config_store.h"
#include "history.h"
#include <kungfu/yijinjing/cache/cached.h>
#include <kungfu/yijinjing/util/os.h>
#include <sstream>

using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing;
using namespace kungfu::cache;
using namespace kungfu::yijinjing::data;

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

// The function-try-block is deliberate: base-class construction (apprentice
// opens the io device and session index storage) can throw under
// cross-process contention, and a body-level try cannot catch member
// initializer exceptions. A plain std::exception escaping this napi callback
// terminates the whole process; convert to a JS-catchable error instead.
Watcher::Watcher(const Napi::CallbackInfo &info) try
    : ObjectWrap(info),                                                                           //
      apprentice(GetWatcherLocation(info), true),                                                 //
      milliseconds_sleep_after_step_(GetNumber(info, 3)),                                         //
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
  locationObj.Set("group", Napi::String::New(info.Env(), location->group));
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

  // stop master
  if (app_location->role == location_role::SYSTEM && app_location->group == "master") {
    if (not has_writer(get_master_command_uid())) {
      return Napi::Boolean::New(info.Env(), false);
    }
    get_writer(get_master_command_uid())->mark(now(), RequestStop::tag);
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
                                        InstanceMethod("now", &Watcher::Now),                                   //
                                        InstanceMethod("isUsable", &Watcher::IsUsable),                         //
                                        InstanceMethod("isLive", &Watcher::IsLive),                             //
                                        InstanceMethod("isStarted", &Watcher::IsStarted),                       //
                                        InstanceMethod("requestStop", &Watcher::RequestStop),                   //
                                        InstanceMethod("hasLocation", &Watcher::HasLocation),                   //
                                        InstanceMethod("getLocation", &Watcher::GetLocation),                   //
                                        InstanceMethod("getLocationUID", &Watcher::GetLocationUID),             //
                                        InstanceMethod("publishState", &Watcher::PublishState),                 //
                                        InstanceMethod("isReadyToInteract", &Watcher::IsReadyToInteract),       //
                                        InstanceMethod("issueCustomData", &Watcher::IssueCustomData),           //
                                        InstanceMethod("issueMark", &Watcher::IssueMark),                       //
                                        InstanceMethod("start", &Watcher::Start),                               //
                                        InstanceMethod("sync", &Watcher::Sync),                                 //
                                        InstanceMethod("quit", &Watcher::Quit),                                 //
                                        InstanceAccessor("ledger", &Watcher::GetLedger, &Watcher::NoSet),       //
                                        InstanceAccessor("appStates", &Watcher::GetAppStates, &Watcher::NoSet), //
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("Watcher", func);
}

void Watcher::on_react() {
  SPDLOG_INFO("watcher on react");

  events_ | is(Register::tag) | $$(OnRegister(event->gen_time(), event->data<Register>()));
  events_ | is(Deregister::tag) | $$(OnDeregister(event->gen_time(), event->data<Deregister>()));
  auto before_start_events = events_ | take_until(events_ | is(RequestStart::tag));
  before_start_events | $$(cached::feed_state_data(event, data_bank_));
}

bool Watcher::has_writer(uint32_t dest_id) const { return writers_.find(dest_id) != writers_.end(); }

yijinjing::journal::writer_ptr Watcher::get_writer(uint32_t dest_id) const {
  if (writers_.find(dest_id) == writers_.end()) {
    SPDLOG_ERROR("no writer for {}", get_location_uname(dest_id));
  }
  return writers_.at(dest_id);
}

void Watcher::on_start() {
  events_ | $$(cached::feed_state_data(event, data_bank_));

  events_ | is(Channel::tag) | $$(InspectChannel(event->gen_time(), event->data<Channel>()));
  events_ | is(CacheReset::tag) | $$(UpdateEventCache(event));
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
  if (app_location->role == location_role::SYSTEM and app_location->group == "master" and
      app_location->name == "master") {
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
        SPDLOG_ERROR("watcher worker error, backing off: {}", ex.what());
      }
      std::this_thread::sleep_for(std::chrono::microseconds(watcher->milliseconds_sleep_after_step_));
    }
    watcher->signal_stop();
    watcher->pause();
    SPDLOG_INFO("Watcher uv loop stopped");
  };
  auto after = [](uv_work_t *req, int status) {
    SPDLOG_INFO("Watcher uv loop completed");
    // have to be at this position, for deleting old journal securitily
    auto &info = *static_cast<Napi::CallbackInfo *>(req->data);
    Napi::HandleScope scope(info.Env());

    auto watcher = static_cast<Watcher *>(req->data);
    if (watcher->quit_) {
      SPDLOG_INFO("watcher quit");
      return;
    } else {
      // have to wait for master down totally
      std::this_thread::sleep_for(std::chrono::milliseconds(1000));
    }

    watcher->AfterMasterDown(info);
    watcher->set_begin_time(yijinjing::time::now_in_nano());
    SPDLOG_INFO("Restart watcher uv loop");
    // master may quit within watcher running time,
    // so, once master deregistered, the uv logic in watcher need to be restarte.
    watcher->StartWorker();
  };

  uv_queue_work(uv_default_loop(), &uv_work_, worker, after);
}

void Watcher::CancelWorker() { uv_work_live_ = false; }

void Watcher::Quit(const Napi::CallbackInfo &info) {
  RequestDeregister();
  quit_ = true;
  uv_work_live_ = false;
}

void Watcher::RequestDeregister() {
  if (not has_writer(get_master_command_uid())) {
    SPDLOG_WARN("no master cmd writer");
    return;
  }

  auto writer = get_writer(get_master_command_uid());
  writer->mark(now(), RequestDeregister::tag);
  SPDLOG_INFO("RequestDeregister");
}

void Watcher::AfterMasterDown(const Napi::CallbackInfo &info) {
  SPDLOG_INFO("after master down");
  Napi::HandleScope scope(info.Env());
  //  disjoin(get_master_command_uid());
  reader_->clear();
  writers_.clear();
  band_writers_.clear();
  serialize::InitObjectReference(info, app_states_ref_);
  serialize::InitStateMap(info, ledger_ref_, "ledger");
}

bool Watcher::is_reactable(const event_ptr &event) { return not is_custom_event(event); }

bool Watcher::is_step_continually() { return reader_->data_available(); }

} // namespace kungfu::node
