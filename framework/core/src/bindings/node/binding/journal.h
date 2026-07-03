// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/1.
//

#ifndef KUNGFU_NODE_JOURNAL_H
#define KUNGFU_NODE_JOURNAL_H

#include "common.h"
#include "operators.h"

#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/journal/tracer.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::node {
class Tracer : public Napi::ObjectWrap<Tracer>, public yijinjing::journal::tracer {

public:
  explicit Tracer(const Napi::CallbackInfo &info);

  ~Tracer() override;

  [[nodiscard]] Napi::Value DataAvailable(const Napi::CallbackInfo &info);

  [[nodiscard]] Napi::Value CurrentFrame(const Napi::CallbackInfo &info);

  [[nodiscard]] Napi::Value CurrentFrameId(const Napi::CallbackInfo &info);

  [[nodiscard]] Napi::Value CurrentPageId(const Napi::CallbackInfo &info);

  Napi::Value Now(const Napi::CallbackInfo &info);

  void SeekToTime(const Napi::CallbackInfo &info);

  void Next(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("Tracer reset");
    Tracer::constructor.Reset();
  }
};

class Frame : public Napi::ObjectWrap<Frame> {
public:
  explicit Frame(const Napi::CallbackInfo &info);

  Napi::Value DataLength(const Napi::CallbackInfo &info);

  Napi::Value GenTime(const Napi::CallbackInfo &info);

  Napi::Value TriggerTime(const Napi::CallbackInfo &info);

  Napi::Value MsgType(const Napi::CallbackInfo &info);

  Napi::Value Source(const Napi::CallbackInfo &info);

  Napi::Value Dest(const Napi::CallbackInfo &info);

  Napi::Value InitialSource(const Napi::CallbackInfo &info);

  Napi::Value Data(const Napi::CallbackInfo &info);

  Napi::Value DataAsString(const Napi::CallbackInfo &info);

  Napi::Value DataBytes(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  yijinjing::journal::frame_ptr frame_;
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("Frame reset");
    Frame::constructor.Reset();
  }

  void SetFrame(yijinjing::journal::frame_ptr frame);

  friend class Reader;
  friend class Assemble;
  friend class Tracer;
};

class Reader : public Napi::ObjectWrap<Reader>, public yijinjing::journal::reader {
public:
  explicit Reader(const Napi::CallbackInfo &info);

  Napi::Value ToString(const Napi::CallbackInfo &info);

  Napi::Value CurrentFrame(const Napi::CallbackInfo &info);

  Napi::Value SeekToTime(const Napi::CallbackInfo &info);

  Napi::Value DataAvailable(const Napi::CallbackInfo &info);

  Napi::Value Next(const Napi::CallbackInfo &info);

  Napi::Value Join(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  yijinjing::io_device_ptr io_device_;
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("Reader reset");
    Reader::constructor.Reset();
  }
};

class Assemble : public Napi::ObjectWrap<Assemble>, public yijinjing::journal::assemble {
public:
  explicit Assemble(const Napi::CallbackInfo &info);

  Napi::Value CurrentFrame(const Napi::CallbackInfo &info);

  Napi::Value SeekToTime(const Napi::CallbackInfo &info);

  Napi::Value DataAvailable(const Napi::CallbackInfo &info);

  Napi::Value Next(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

private:
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("Assemble reset");
    Assemble::constructor.Reset();
  }
};
} // namespace kungfu::node
#endif // KUNGFU_NODE_JOURNAL_H
