// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-05-25.
//

#ifndef KUNGFU_NANOMSG_SOCKET_H
#define KUNGFU_NANOMSG_SOCKET_H

#include <algorithm>
#include <cstring>
#include <exception>

#include <kungfu/yijinjing/common.h>
#include <nng/nng.h>
#include <nng/protocol/pipeline0/pull.h>
#include <nng/protocol/pipeline0/push.h>
#include <nng/protocol/pubsub0/pub.h>
#include <nng/protocol/pubsub0/sub.h>
#include <nng/protocol/reqrep0/rep.h>
#include <nng/protocol/reqrep0/req.h>

#define MAX_MSG_LENGTH (16 * 1024)

// core-side publisher interface uses PUBLISH_NONBLOCK to stay nng-free;
// weld the mirrored value to the real nng flag here where both are visible
static_assert(kungfu::yijinjing::PUBLISH_NONBLOCK == NNG_FLAG_NONBLOCK,
              "PUBLISH_NONBLOCK must equal NNG_FLAG_NONBLOCK");

namespace kungfu::yijinjing::nanomsg {
enum class protocol : int { UNKNOWN = -1, REPLY, REQUEST, PUSH, PULL, PUBLISH, SUBSCRIBE };

inline std::string get_protocol_name(protocol p) {
  switch (p) {
  case protocol::REPLY:
    return "rep";
  case protocol::REQUEST:
    return "req";
  case protocol::PUSH:
    return "push";
  case protocol::PULL:
    return "pull";
  case protocol::PUBLISH:
    return "pub";
  case protocol::SUBSCRIBE:
    return "sub";
  default:
    return "unknown";
  }
}

inline protocol get_opposite_protol(protocol p) {
  switch (p) {
  case protocol::REPLY:
    return protocol::REQUEST;
  case protocol::REQUEST:
    return protocol::REPLY;
  case protocol::PUSH:
    return protocol::PULL;
  case protocol::PULL:
    return protocol::PUSH;
  case protocol::PUBLISH:
    return protocol::SUBSCRIBE;
  case protocol::SUBSCRIBE:
    return protocol::PUBLISH;
  default:
    return protocol::UNKNOWN;
  }
}

class url_factory {
public:
  [[nodiscard]] virtual std::string make_path_listen(data::location_ptr location, protocol p) const = 0;

  [[nodiscard]] virtual std::string make_path_dial(data::location_ptr location, protocol p) const = 0;
};

DECLARE_PTR(url_factory)

class nn_exception : public std::exception {
public:
  nn_exception(int err) : errno_(err) {}

  [[nodiscard]] const char *what() const noexcept override;

  [[nodiscard]] int num() const;

private:
  int errno_;
};

DECLARE_PTR(nn_exception)

class socket {
public:
  explicit socket(protocol p) : socket(p, MAX_MSG_LENGTH){};

  socket(protocol p, int buffer_size);

  ~socket();

  void setsockopt(const char *opt, const void *val, size_t valsz);

  void setsockopt_str(const char *opt, std::string value);

  void setsockopt_int(const char *opt, int value);

  void setsockopt_ms(const char *opt, int value);

  void getsockopt(const char *opt, void *val, size_t *valszp);

  int getsockopt_int(const char *opt);

  int getsockopt_ms(const char *opt);

  int listen(const std::string &path, int flags = 0);

  int dial(const std::string &path, int flags = 0);

  void close();

  // Send policy changed to flag = 0 at app register, then notify with flag = NNG_FLAG_NONBLOCK
  int send(const std::string &msg, int flags = NNG_FLAG_NONBLOCK, bool no_exception = false) const;

  int send_json(const nlohmann::json &msg, int flags = NNG_FLAG_NONBLOCK) const;

  int recv(int flags = NNG_FLAG_ALLOC);

  const std::string &recv_msg(int flags = NNG_FLAG_ALLOC);

  nlohmann::json recv_json(int flags = NNG_FLAG_ALLOC);

  [[nodiscard]] protocol get_protocol() const { return protocol_; };

  [[nodiscard]] const std::string &get_url() const { return url_; };

  [[nodiscard]] const std::string &last_message() const { return message_; };

private:
  nng_socket sock_ = NNG_SOCKET_INITIALIZER;
  protocol protocol_;
  std::string url_;
  char *buf_ = NULL;
  size_t buf_size_;
  std::string message_;

  /*  Prevent making copies of the socket by accident. */
  socket(const socket &);

  void operator=(const socket &);
};

DECLARE_PTR(socket)

struct nanomsg_json : event {
  explicit nanomsg_json(const std::string &msg)
      : binding_(nlohmann::json::parse(msg)), msg_(msg), data_(get_meta<std::string>("data", "")),
        header_(longfist::types::frame_header(msg.c_str(), msg.length())) {}

  [[nodiscard]] int64_t gen_time() const override { return header_.gen_time; }

  [[nodiscard]] int64_t trigger_time() const override { return header_.trigger_time; }

  [[nodiscard]] int32_t msg_type() const override { return header_.msg_type; }

  [[nodiscard]] uint32_t source() const override { return header_.source; }

  [[nodiscard]] uint32_t initial_source() const override { return header_.initial_source; }

  [[nodiscard]] uint32_t dest() const override { return header_.dest; }

  [[nodiscard]] uint32_t data_length() const override { return data_.length(); }

  [[nodiscard]] const void *data_address() const override { return data_.c_str(); }

  [[nodiscard]] const char *data_as_bytes() const override { return data_.c_str(); }

  [[nodiscard]] std::vector<uint8_t> data_as_byte_array() const override {
    return {data_as_bytes(), data_as_bytes() + data_length()};
  }

  [[nodiscard]] std::string data_as_string() const override { return data_; }

  [[nodiscard]] std::string to_string() const override { return msg_; }

  [[nodiscard]] int8_t data_type() const override { return int8_t(header_.data_type); }

  [[nodiscard]] bool is_json() const override { return data_type() == longfist::enums::FrameDataType::Json; }

  [[nodiscard]] uint64_t frame_uid() const override { return header_.frame_uid; }

  [[nodiscard]] uint64_t trigger_frame_uid() const override { return header_.trigger_frame_uid; }

  [[nodiscard]] uint64_t stream_id() const override { return header_.stream_id; }

private:
  const nlohmann::json binding_;
  const std::string msg_;
  const longfist::types::frame_header header_;
  const std::string data_;

  template <typename T> [[nodiscard]] T get_meta(const std::string &name, T default_value) const {
    if (binding_.find(name) == binding_.end()) {
      return default_value;
    }
    T value = binding_[name];
    return value;
  }
};

DECLARE_PTR(nanomsg_json)
} // namespace kungfu::yijinjing::nanomsg

#endif // KUNGFU_NANOMSG_SOCKET_H
