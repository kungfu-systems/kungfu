// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-05-25.
//

#include <kungfu/common.h>
#include <kungfu/yijinjing/nanomsg/socket.h>

namespace kungfu::nanomsg {

const char *nn_exception::what() const throw() { return nng_strerror(errno_); }

int nn_exception::num() const { return errno_; }

socket::socket(protocol p, int buffer_size) : protocol_(p), buf_size_(buffer_size) {
  int rc;
  switch (p) {
  case protocol::REPLY:
    rc = nng_rep0_open(&sock_);
    break;
  case protocol::REQUEST:
    rc = nng_req0_open(&sock_);
    break;
  case protocol::PUSH:
    rc = nng_push0_open(&sock_);
    break;
  case protocol::PULL:
    rc = nng_pull0_open(&sock_);
    break;
  case protocol::PUBLISH:
    rc = nng_pub0_open(&sock_);
    break;
  case protocol::SUBSCRIBE:
    rc = nng_sub0_open(&sock_);
    break;
  default:
    SPDLOG_ERROR("unsupportted protocol {}", int(p));
  }

  if (rc != 0) {
    SPDLOG_ERROR("can not create socket, protocol {}, error [{}] {}", int(p), rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
}

socket::~socket() { nng_close(sock_); }

void socket::setsockopt(const char *opt, const void *val, size_t valsz) {
  int rc = nng_socket_set(sock_, opt, val, valsz);
  if (rc != 0) {
    SPDLOG_ERROR("can not setsockopt, error [{}] {}", rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
}

void socket::setsockopt_str(const char *opt, std::string value) { setsockopt(opt, value.c_str(), value.length()); }

void socket::setsockopt_int(const char *opt, int value) {
  int rc = nng_socket_set_int(sock_, opt, value);
  if (rc != 0) {
    SPDLOG_ERROR("can not setsockopt_int, error [{}] {}", rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
}

void socket::setsockopt_ms(const char *opt, nng_duration value) {
  int rc = nng_socket_set_ms(sock_, opt, value);
  if (rc != 0) {
    SPDLOG_ERROR("can not setsockopt_ms, error [{}] {}", rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
}

void socket::getsockopt(const char *opt, void *val, size_t *valszp) {
  int rc = nng_socket_get(sock_, opt, val, valszp);
  if (rc != 0) {
    SPDLOG_ERROR("can not getsockopt, error [{}] {}", rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
}

int socket::getsockopt_int(const char *opt) {
  int rc;
  int value;
  rc = nng_socket_get_int(sock_, opt, &value);
  if (rc != 0) {
    SPDLOG_ERROR("can not gesockopt_int, error [{}] {}", rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
  return value;
}

int socket::getsockopt_ms(const char *opt) {
  int rc;
  nng_duration value;
  rc = nng_socket_get_ms(sock_, opt, &value);
  if (rc != 0) {
    SPDLOG_ERROR("can not getsockopt_ms, error [{}] {}", rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
  return value;
}

int socket::listen(const std::string &path, int flags) {
  url_ = "ipc://" + path;
  int rc = nng_listen(sock_, url_.c_str(), NULL, flags);
  if (rc != 0) {
    SPDLOG_WARN("can not listen to {}, error [{}] {}", url_, rc, nng_strerror(rc));
  }

  return rc;
}

int socket::dial(const std::string &path, int flags) {
  url_ = "ipc://" + path;
  int rc = nng_dial(sock_, url_.c_str(), NULL, flags);
  if (rc != 0) {
    SPDLOG_WARN("can not dial to {}, error [{}] {}", url_, rc, nng_strerror(rc));
  }
  return rc;
}

void socket::close() {
  int rc = nng_close(sock_);
  if (rc != 0) {
    SPDLOG_ERROR("can not close, error [{}] {}", rc, nng_strerror(rc));
    throw nn_exception(rc);
  }
}

int socket::send(const std::string &msg, int flags, bool no_exception) const {
  void *msg_ptr = const_cast<void *>(reinterpret_cast<const void *>(msg.c_str()));
  int rc = nng_send(sock_, msg_ptr, msg.length(), flags);
  if (rc != 0 && rc != NNG_EAGAIN) {
    SPDLOG_ERROR("can not send to {} error [{}] {}", url_, rc, nng_strerror(rc));
    if (not no_exception) {
      throw nn_exception(rc);
    }
  }
  return rc;
}

int socket::send_json(const nlohmann::json &msg, int flags) const { return send(msg.dump(), flags); }

int socket::recv(int flags) {
  int rc = nng_recv(sock_, &buf_, &buf_size_, flags);
  if (rc != 0) {
    switch (rc) {
    case NNG_ETIMEDOUT:
    case NNG_EAGAIN:
      break;
    case NNG_EINTR: {
      SPDLOG_WARN("interrupted when receiving from [{}]", url_);
      break;
    }
    default: {
      SPDLOG_ERROR("can not recv from {} errno [{}] {}", url_, rc, nng_strerror(rc));
      throw nn_exception(rc);
    }
    }
    message_.assign("", 0);
  } else {
    message_.assign(buf_, buf_size_);
    nng_free(buf_, buf_size_);
  }
  return rc;
}

const std::string &socket::recv_msg(int flags) {
  recv(flags);
  return message_;
}

nlohmann::json socket::recv_json(int flags) {

  int rc = 0;
  if ((rc = recv(flags)) == 0) {
    SPDLOG_INFO("parsing json {} {}", rc, message_);
    return nlohmann::json::parse(message_);
  } else {
    return nlohmann::json{};
  }
}
} // namespace kungfu::nanomsg
