// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/14.
//

#ifndef KUNGFU_NODE_WATCHER_H
#define KUNGFU_NODE_WATCHER_H

#include <napi.h>
#include <uv.h>

#include "common.h"
#include "io.h"
#include "journal.h"
#include "operators.h"
#include <kungfu/runtime/live/peer.h>
#include <kungfu/runtime/state_cache/model.h>

namespace kungfu::node {
constexpr uint64_t ID_TRANC = 0x00000000FFFFFFFF;
constexpr uint32_t PAGE_ID_MASK = 0x80000000;
constexpr uint32_t TRANSFER_STATIC_DATA_LIMIT = 2000;

class Watcher : public Napi::ObjectWrap<Watcher>, public runtime::live::peer {
public:
  explicit Watcher(const Napi::CallbackInfo &info);

  ~Watcher() override;

  void NoSet(const Napi::CallbackInfo &info, const Napi::Value &value);

  Napi::Value HasLocation(const Napi::CallbackInfo &info);

  Napi::Value GetLocation(const Napi::CallbackInfo &info);

  Napi::Value GetLocationUID(const Napi::CallbackInfo &info);

  Napi::Value GetLedger(const Napi::CallbackInfo &info);

  Napi::Value GetAppStates(const Napi::CallbackInfo &info);

  Napi::Value Now(const Napi::CallbackInfo &info);

  Napi::Value IsUsable(const Napi::CallbackInfo &info);

  Napi::Value IsLive(const Napi::CallbackInfo &info);

  Napi::Value IsStarted(const Napi::CallbackInfo &info);

  Napi::Value RequestStop(const Napi::CallbackInfo &info);

  Napi::Value PublishState(const Napi::CallbackInfo &info);

  Napi::Value IsReadyToInteract(const Napi::CallbackInfo &info);

  Napi::Value IssueCustomData(const Napi::CallbackInfo &info);

  Napi::Value IssueMark(const Napi::CallbackInfo &info);

  Napi::Value Start(const Napi::CallbackInfo &info);

  void Sync(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  void Quit(const Napi::CallbackInfo &info);

  void AfterCoordinatorDown(const Napi::CallbackInfo &info);

  void RequestDeregister();

  bool has_writer(uint32_t dest_id) const override;

  yijinjing::journal::writer_ptr get_writer(uint32_t dest_id) const override;

  bool is_reactable(const event_ptr &event) override;

  bool is_step_continually();

protected:
  const int milliseconds_sleep_after_step_;
  std::mutex feed_mutex_;

  void on_react() override;

  void on_start() override;

private:
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("Watcher reset");
    Watcher::constructor.Reset();
  }

  uv_work_t uv_work_ = {};
  bool uv_work_live_ = false;
  bool quit_ = false;

  Napi::ObjectReference ledger_ref_;
  Napi::ObjectReference app_states_ref_;
  Napi::ObjectReference config_ref_;
  serialize::JsUpdateState update_ledger;
  serialize::JsResetCache reset_cache;
  runtime::state_cache::bank data_bank_;
  std::vector<kungfu::state<yijinjing::types::CacheReset>> reset_cache_states_;

  typedef yijinjing::enums::mode mode;
  typedef yijinjing::enums::location_role role;

  static constexpr auto is_static_data = []() {
    return rx::filter([&](const event_ptr &event) {
      return yijinjing::StaticDataTags.find(event->carrier_type()) != yijinjing::StaticDataTags.end();
    });
  };

  void RestoreState(const yijinjing::data::location_ptr &state_location, int64_t from, int64_t to, bool sync_schema);

  yijinjing::data::location_ptr FindLocation(const Napi::CallbackInfo &info);

  void InspectChannel(int64_t trigger_time, const yijinjing::types::Channel &channel);

  void OnRegister(int64_t trigger_time, const yijinjing::types::Register &register_data);

  void OnDeregister(int64_t trigger_time, const yijinjing::types::Deregister &deregister_data);

  void SyncLedger();

  void SyncAppStates();

  void UpdateEventCache(const event_ptr &event);

  void SyncEventCache();

  void StartWorker();

  void CancelWorker();

  uint64_t MakeInstructionUID(yijinjing::journal::writer_ptr &writer, uint32_t dest, uint32_t client_id = 0) {
    uint64_t id_left = (uint64_t)(client_id xor dest) << 32u;
    uint64_t id_right = (ID_TRANC & writer->current_frame_uid()) | PAGE_ID_MASK;
    return id_left | id_right;
  }

  template <typename DataType> void UpdateLedger(const boost::hana::basic_type<DataType> &type) {
    using DataTypeMap = std::unordered_map<uint64_t, state<DataType>>;
    auto &target_map = const_cast<DataTypeMap &>(data_bank_[type]);
    auto is_static_data_type = yijinjing::StaticDataTags.find(DataType::tag) != yijinjing::StaticDataTags.end();
    auto count = 0;
    auto iter = target_map.begin();
    while (iter != target_map.end()) {
      const auto &state = iter->second;
      update_ledger(state.update_time, state.source, state.dest, state.data);
      iter = target_map.erase(iter);

      if (is_static_data_type && count++ >= TRANSFER_STATIC_DATA_LIMIT) {
        break;
      }
    }
  }

  template <typename Instruction>
  Napi::Value InteractWithLocation(const Napi::CallbackInfo &info, const Napi::Object &instruction_object) {
    try {
      auto target_location = IODevice::ExtractLocation(info, 1, get_locator());

      if (target_location->role == yijinjing::enums::location_role::SYSTEM &&
          runtime::live::is_coordinator_wire_namespace(target_location->namespace_)) {
        target_location = coordinator_cmd_location_;
      }

      if (not is_location_live(target_location->uid) or not has_writer(target_location->uid)) {
        return Napi::Boolean::New(info.Env(), false);
      }

      auto trigger_time = yijinjing::time::now_in_nano();
      auto target_writer = get_writer(target_location->uid);
      Instruction instruction = {};
      serialize::JsGet{}(instruction_object, instruction);

      if (info.Length() == 2) {
        target_writer->write(trigger_time, instruction);
        return Napi::Boolean::New(info.Env(), true);
      }

      throw Napi::Error::New(info.Env(), "Invalid instruction arguments length");
    } catch (const std::exception &ex) {
      throw Napi::Error::New(info.Env(), fmt::format("invalid instruction arguments: {}", ex.what()));
    } catch (...) {
      throw Napi::Error::New(info.Env(), "invalid instruction arguments");
    }
  }
};

} // namespace kungfu::node

#endif // KUNGFU_NODE_WATCHER_H
