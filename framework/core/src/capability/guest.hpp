// SPDX-License-Identifier: Apache-2.0
//
// The C++ child-side guest proxy: the native sibling of
// framework/api/src/capability/guest-node.ts and
// framework/core/src/python/kungfu/capability/guest.py. A sandboxed C++ service
// reaches only its declared capabilities, forwarded to the trusted host over a
// newline-delimited JSON channel carried on its stdio. Diagnostics MUST go to
// stderr — the child's stdout is the relay, and anything else written there
// corrupts it.
//
// Wire protocol (one JSON object per line, both directions) — the same
// serveSubprocessCapabilities (framework/api/src/capability/subprocess.ts)
// speaks from the host side:
//   child -> host   {"t":"invoke","id":n,"cap","method","args"}
//   host  -> child  {"t":"result","id":n,"ok":true,"value"} | {"ok":false,"error"}
//   host  -> child  {"t":"event","callback":n,"args"}
// A callback argument is replaced on the wire by {"__sandboxCallback": id}; when
// the host bridges it back as an event, the registered callback fires. Every
// frame crosses the relay serialized — the sandbox tier's defining property
// (ADR-0014): a result is a copy, never a live handle.
//
// Header-only and dependency-light (nlohmann/json + the C++ standard library):
// a service author compiles their body against this header and ships the
// resulting binary as the kfx's per-platform cpp entry (ADR-0017). Unlike the
// interpreted node/python guests — an interpreter already resident, loading a
// shipped source entry — a C++ service has no interpreter, so the compiled
// binary is itself the guest: it links this proxy and its own body into one
// image, and the host launches that image directly.
#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::capability {

using nlohmann::json;

// The stdio channel a sandboxed C++ child speaks to its host. A background
// reader thread pulls host->child frames: a `result` wakes the invoke() blocked
// on its id; an `event` fires the registered callback. Non-copyable and
// non-movable — it owns a reader thread that captured `this`, so the object must
// keep its address for its whole lifetime.
class Channel {
public:
  explicit Channel(std::istream &in = std::cin, std::ostream &out = std::cout)
      : in_(in), out_(out), reader_(&Channel::read_loop, this) {}

  ~Channel() { close(); }

  Channel(const Channel &) = delete;
  Channel &operator=(const Channel &) = delete;

  // Call a capability method and block until the host replies. Throws
  // std::runtime_error carrying the host's message when the call fails or the
  // channel closes first.
  json invoke(const std::string &cap, const std::string &method, const std::vector<json> &args = {}) {
    const std::int64_t id = next_seq();
    send({{"t", "invoke"}, {"id", id}, {"cap", cap}, {"method", method}, {"args", args}});
    std::unique_lock<std::mutex> lk(state_mu_);
    cv_.wait(lk, [&] { return results_.count(id) > 0 || closed_; });
    auto it = results_.find(id);
    if (it == results_.end()) {
      throw std::runtime_error("capability channel closed before result");
    }
    json result = std::move(it->second);
    results_.erase(it);
    lk.unlock();
    if (!result.value("ok", false)) {
      throw std::runtime_error(result.value("error", "capability call failed"));
    }
    return result.contains("value") ? result["value"] : json();
  }

  // Register a host->guest callback and return the wire marker to pass as a call
  // argument. The explicit form the statically-typed guest needs: node/python
  // detect a callable argument reflectively; C++ registers it here and hands
  // back the {"__sandboxCallback": id} marker the host reconstructs a forwarder
  // from. The callback fires on the reader thread — keep it short and
  // thread-aware.
  json make_callback(std::function<void(const std::vector<json> &)> fn) {
    const std::int64_t id = next_seq();
    {
      std::lock_guard<std::mutex> lk(state_mu_);
      callbacks_[id] = std::move(fn);
    }
    return json{{"__sandboxCallback", id}};
  }

  void close() {
    {
      std::lock_guard<std::mutex> lk(state_mu_);
      if (closed_)
        return;
      closed_ = true;
    }
    cv_.notify_all();
    // The reader blocks in getline(); there is no portable way to interrupt it,
    // so — like the python guest's daemon reader — it is detached and reclaimed
    // when the process exits. The guest owns the whole process (it IS the
    // service binary), so the object outlives every invoke() and close() runs at
    // process teardown.
    if (reader_.joinable())
      reader_.detach();
  }

private:
  std::int64_t next_seq() { return seq_.fetch_add(1) + 1; }

  void send(const json &msg) {
    const std::string line = msg.dump() + "\n";
    std::lock_guard<std::mutex> lk(write_mu_);
    out_ << line;
    out_.flush();
  }

  void read_loop() {
    std::string line;
    while (std::getline(in_, line)) {
      if (line.empty())
        continue;
      json msg = json::parse(line, nullptr, /*allow_exceptions=*/false);
      if (msg.is_discarded() || !msg.is_object()) {
        continue; // ignore anything that is not a protocol frame
      }
      // Guard the whole dispatch: a frame that is valid JSON but the wrong shape
      // must not terminate the reader (and with it the whole guest process); it
      // is dropped like a non-protocol line. The host is trusted, but robustness
      // here is cheap and the alternative is an uncatchable std::terminate on a
      // background thread.
      try {
        const std::string t = msg.value("t", std::string());
        if (t == "result" && msg.contains("id") && msg["id"].is_number()) {
          // Read the id BEFORE moving msg — evaluating the subscript index and
          // the moved-from source in one statement is not sequenced, so reading
          // msg["id"] after std::move(msg) would see a null.
          const auto id = msg["id"].get<std::int64_t>();
          std::lock_guard<std::mutex> lk(state_mu_);
          results_[id] = std::move(msg);
          cv_.notify_all();
        } else if (t == "event" && msg.contains("callback") && msg["callback"].is_number()) {
          const auto callback = msg["callback"].get<std::int64_t>();
          std::function<void(const std::vector<json> &)> fn;
          {
            std::lock_guard<std::mutex> lk(state_mu_);
            auto it = callbacks_.find(callback);
            if (it != callbacks_.end())
              fn = it->second;
          }
          // Fire outside the lock: user code may re-enter the channel (invoke,
          // register another callback) and must not deadlock on state_mu_.
          if (fn)
            fn(msg.value("args", std::vector<json>{}));
        }
      } catch (const std::exception &) {
        continue; // malformed frame: drop it, keep the channel alive
      }
    }
    // EOF: the host closed the channel. Wake any invoke() still blocked so it
    // fails loudly instead of hanging forever.
    {
      std::lock_guard<std::mutex> lk(state_mu_);
      closed_ = true;
    }
    cv_.notify_all();
  }

  std::istream &in_;
  std::ostream &out_;
  std::mutex write_mu_;
  std::mutex state_mu_;
  std::condition_variable cv_;
  std::map<std::int64_t, json> results_;
  std::map<std::int64_t, std::function<void(const std::vector<json> &)>> callbacks_;
  std::atomic<std::int64_t> seq_{0};
  bool closed_ = false;
  // Declared last so every member it touches is already constructed when the
  // reader thread starts.
  std::thread reader_;
};

// One declared capability: a thin handle that forwards method calls to the
// channel. `call("method", {args...})` mirrors the async method surface the
// node/python guests present — synchronous here because a C++ service blocks on
// its own thread rather than an event loop, but the same relay underneath.
class Capability {
public:
  Capability(Channel &channel, std::string name) : channel_(channel), name_(std::move(name)) {}

  json call(const std::string &method, const std::vector<json> &args = {}) const {
    return channel_.invoke(name_, method, args);
  }

private:
  Channel &channel_;
  std::string name_;
};

// The capability object a sandboxed C++ child receives: exactly the declared
// capabilities and nothing else. Owns the channel and lives for the guest's
// lifetime; construct it once at the top of the service body. Non-copyable and
// non-movable (it holds a Channel), so hold it by reference or in place — never
// return it by value.
class Guest {
public:
  explicit Guest(const std::vector<std::string> &declared, std::istream &in = std::cin, std::ostream &out = std::cout)
      : channel_(in, out) {
    for (const auto &name : declared) {
      caps_.emplace(name, Capability(channel_, name));
    }
  }

  // Reach a declared capability; throws if it was not declared. Undeclared
  // capabilities are absent, not merely un-injected — the boundary is real, the
  // same guarantee the node/python guests give by building from the declared set
  // alone.
  const Capability &cap(const std::string &name) const {
    auto it = caps_.find(name);
    if (it == caps_.end()) {
      throw std::runtime_error("capability '" + name + "' is not declared by this kfx");
    }
    return it->second;
  }

  bool has(const std::string &name) const { return caps_.count(name) > 0; }

  Channel &channel() { return channel_; }

  void close() { channel_.close(); }

private:
  Channel channel_;
  std::map<std::string, Capability> caps_;
};

} // namespace kungfu::capability
