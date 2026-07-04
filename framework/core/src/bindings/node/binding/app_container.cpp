// SPDX-License-Identifier: Apache-2.0
//
// Node binding for the Windows AppContainer guest launcher (ADR-0014). Thin: it
// marshals a JS spec into os::app_container_options, calls the libyijinjing
// launcher, and wraps the returned process. wait() runs the blocking native wait
// on a worker thread and resolves a Promise, so the event loop is never blocked.

#include "app_container.h"

#include <kungfu/yijinjing/util/os.h>

#include <memory>
#include <string>
#include <vector>

namespace kungfu::node {
namespace os = kungfu::yijinjing::os;

namespace {
std::vector<std::string> to_string_vector(const Napi::Value &value) {
  std::vector<std::string> out;
  if (!value.IsArray()) {
    return out;
  }
  auto array = value.As<Napi::Array>();
  for (uint32_t i = 0; i < array.Length(); ++i) {
    out.push_back(array.Get(i).ToString().Utf8Value());
  }
  return out;
}
} // namespace

// Runs the blocking os::app_container_process::wait() off-thread and resolves the
// returned promise with the exit code.
class WaitWorker : public Napi::AsyncWorker {
public:
  WaitWorker(Napi::Env env, std::shared_ptr<os::app_container_process> process, Napi::Promise::Deferred deferred)
      : Napi::AsyncWorker(env), process_(std::move(process)), deferred_(std::move(deferred)) {}

  void Execute() override { code_ = process_->wait(); }
  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), code_)); }
  void OnError(const Napi::Error &error) override { deferred_.Reject(error.Value()); }

private:
  std::shared_ptr<os::app_container_process> process_;
  Napi::Promise::Deferred deferred_;
  int code_ = -1;
};

class AppContainerProcess : public Napi::ObjectWrap<AppContainerProcess> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Use the callback-pointer overloads (name, &Method), matching the other
    // bindings in this tree. The template form InstanceMethod<&Method>(...) ICEs
    // MSVC (C1001 in napi-inl.h) on the pinned toolchain.
    Napi::Function func = DefineClass(env, "AppContainerProcess",
                                      {
                                          InstanceMethod("wait", &AppContainerProcess::Wait),
                                          InstanceMethod("kill", &AppContainerProcess::Kill),
                                      });
    constructor_ = Napi::Persistent(func);
    constructor_.SuppressDestruct();
    return exports;
  }

  static Napi::Object New(Napi::Env env, std::shared_ptr<os::app_container_process> process) {
    auto external = Napi::External<std::shared_ptr<os::app_container_process>>::New(
        env, new std::shared_ptr<os::app_container_process>(std::move(process)),
        [](Napi::Env, std::shared_ptr<os::app_container_process> *ptr) { delete ptr; });
    return constructor_.New({external});
  }

  explicit AppContainerProcess(const Napi::CallbackInfo &info) : Napi::ObjectWrap<AppContainerProcess>(info) {
    auto external = info[0].As<Napi::External<std::shared_ptr<os::app_container_process>>>();
    process_ = *external.Data();
  }

private:
  static Napi::FunctionReference constructor_;
  std::shared_ptr<os::app_container_process> process_;

  Napi::Value Wait(const Napi::CallbackInfo &info) {
    auto deferred = Napi::Promise::Deferred::New(info.Env());
    auto *worker = new WaitWorker(info.Env(), process_, deferred);
    worker->Queue();
    return deferred.Promise();
  }

  void Kill(const Napi::CallbackInfo &info) { process_->kill(); }
};

Napi::FunctionReference AppContainerProcess::constructor_;

Napi::Value SpawnAppContainer(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    throw Napi::Error::New(env, "spawnAppContainer expects a spec object");
  }
  auto spec = info[0].As<Napi::Object>();

  os::app_container_options options;
  options.command = spec.Get("command").ToString().Utf8Value();
  options.args = to_string_vector(spec.Get("args"));
  options.stdin_pipe = spec.Get("stdinPipe").ToString().Utf8Value();
  options.stdout_pipe = spec.Get("stdoutPipe").ToString().Utf8Value();
  options.moniker = spec.Get("moniker").ToString().Utf8Value();
  options.display_name = spec.Get("displayName").ToString().Utf8Value();
  options.capabilities = to_string_vector(spec.Get("capabilities"));
  options.allow_broad_write = spec.Get("allowBroadWrite").ToBoolean().Value();
  options.allow_loopback = spec.Get("allowLoopback").ToBoolean().Value();
  options.env = to_string_vector(spec.Get("env"));

  try {
    auto process = os::spawn_app_container(options);
    return AppContainerProcess::New(env, process);
  } catch (const std::exception &error) {
    throw Napi::Error::New(env, error.what());
  }
}

void InitAppContainer(Napi::Env env, Napi::Object exports) {
  AppContainerProcess::Init(env, exports);
  exports.Set("spawnAppContainer", Napi::Function::New(env, SpawnAppContainer));
}
} // namespace kungfu::node
