#ifndef KUNGFU_WEBSERVER_H
#define KUNGFU_WEBSERVER_H

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <nng/nng.h>
#include <nng/supplemental/http/http.h>

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <shared_mutex>
#include <string>

#include <sstream>
#include <stdexcept>

#include <cassert>

#ifdef _WIN32
#include <WS2tcpip.h>
#include <winsock2.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#endif

namespace kungfu::webserver {

template <typename T> struct nng_data {
  char origin_data[sizeof(kungfu::longfist::types::frame_header) + sizeof(T)]{};
  size_t len;

  explicit nng_data(int32_t msg_type, uint64_t stream_id) {
    auto *header = reinterpret_cast<kungfu::longfist::types::frame_header *>(origin_data);
    len = sizeof(kungfu::longfist::types::frame_header) + sizeof(T);
    header->length = len;
    header->header_length = sizeof(kungfu::longfist::types::frame_header);
    header->trigger_time = yijinjing::time::now_in_nano();
    header->gen_time = header->trigger_time;
    header->msg_type = msg_type;
    header->source = 0;
    header->dest = 0;
    header->data_type = kungfu::longfist::enums::FrameDataType::Raw;
    header->initial_source = 0;
    header->frame_uid = 0;
    header->trigger_frame_uid = 0;
    header->stream_id = stream_id;
  }

  kungfu::longfist::types::frame_header *header() {
    return reinterpret_cast<kungfu::longfist::types::frame_header *>(origin_data);
  }

  T *data() { return reinterpret_cast<T *>(origin_data + sizeof(kungfu::longfist::types::frame_header)); }

  size_t length() { return len; }
};

class webserver_error : public std::runtime_error {
public:
  explicit webserver_error(const std::string &message) : runtime_error(message) { SPDLOG_CRITICAL(message); }
};

static void fatal(const char *what, int rv) {
  std::stringstream ss;
  ss << what << ": " << nng_strerror(rv);
  throw webserver_error(ss.str());
}

template <class nng_type> class nng_smart_ptr {
  using nng_free_function = std::function<void(nng_type *)>;
  nng_type *obj{nullptr};
  nng_free_function fn_free;
  void release() {
    if (obj != nullptr) {
      fn_free(obj);
      obj = nullptr;
    }
  }

public:
  explicit nng_smart_ptr(nng_free_function fn) : fn_free(fn) {}

  explicit nng_smart_ptr(nng_type *nng_pointer, nng_free_function fn) : obj(nng_pointer), fn_free(fn) {}

  ~nng_smart_ptr() { release(); }
  nng_smart_ptr &operator=(nng_type *new_obj) {
    release();
    obj = new_obj;
    return *this;
  }

  void reset(nng_type *new_obj = nullptr) {
    release();
    obj = new_obj;
  }

  nng_type **operator&() { return &obj; }

  operator nng_type *() const { return obj; }

  nng_type *operator->() { return obj; }
};

static uint64_t generate_stream_id(nng_stream *s, bool is_server) {
  nng_sockaddr sockaddr;
  if (is_server) {
    nng_stream_get_addr(s, NNG_OPT_REMADDR, &sockaddr);
    return (static_cast<uint64_t>(sockaddr.s_in.sa_addr) << 32) | (static_cast<uint64_t>(sockaddr.s_in.sa_port) << 16);
  } else {
    nng_stream_get_addr(s, NNG_OPT_LOCADDR, &sockaddr);
    return (static_cast<uint64_t>(sockaddr.s_in.sa_addr) << 32) | (static_cast<uint64_t>(sockaddr.s_in.sa_port) << 16);
  }
}

class web_agent : public std::enable_shared_from_this<web_agent> {
public:
  explicit web_agent();

  virtual void start() {}

  virtual void stop() {}

  virtual void onError(uint64_t stream_id) {}

  virtual void onDisconnect(uint64_t stream_id) {}

  virtual void onConnect(uint64_t stream_id) {}

  kungfu::yijinjing::journal::frame_ptr current_frame() { return reader_->current_frame(); }

  virtual bool data_available();

  virtual void next();

  virtual void on_frame();

  virtual void add_join(const kungfu::yijinjing::data::location_ptr &location, uint32_t dest, int64_t begin_time);

  virtual void add_disjion(const kungfu::yijinjing::data::location_ptr &location, uint32_t dest);

  virtual void cleanup_reader_join();

  virtual void cleanup_reader_disjoin();

private:
  yijinjing::journal::reader_ptr reader_;
  std::mutex mtx_;            // 子线程竞争
  std::atomic<bool> flag_has; // 子线程和主线程
  std::map<std::pair<kungfu::yijinjing::data::location_ptr, uint32_t>, int64_t> join_channels_ = {};
  std::set<std::pair<kungfu::yijinjing::data::location_ptr, uint32_t>> disjoin_channels_ = {};
};
DECLARE_PTR(web_agent)

class stream {
public:
  stream(nng_stream *s, bool is_server);

  virtual ~stream();

  [[nodiscard]] const yijinjing::data::location_ptr &get_location() const;

  [[nodiscard]] uint64_t get_stream_id() const;

protected:
  void close_data();

  void open_data(nng_iov &iov);

private:
  uint64_t stream_id_;
  yijinjing::data::location_ptr location_ = nullptr;
  yijinjing::journal::writer_ptr writer_ = nullptr;
  yijinjing::journal::frame_ptr current_frame_ = nullptr;
};
DECLARE_PTR(stream)

class session : public stream {
public:
  session(web_agent_ptr agent, nng_stream *s, bool is_server);

  ~session() override;

  void start_recv();

  int send(const char *data, int len);

  void recv_cb();

  void send_cb();

private:
  web_agent_ptr agent_;
  nng_smart_ptr<nng_aio> aio_send_{nng_aio_free};
  nng_smart_ptr<nng_aio> aio_recv_{nng_aio_free};
  nng_smart_ptr<nng_stream> stream_;
};
DECLARE_PTR(session)

class websocket_client : public web_agent {
public:
  explicit websocket_client(const std::string &address, bool is_text_mode, bool tcp_no_delay);

  virtual ~websocket_client();

  uint64_t get_stream_id();

  void start() override;

  void stop() override;

  int send(const char *data, int len);

  void onError(uint64_t stream_id) override;

  void onDisconnect(uint64_t stream_id) override;

  void onConnect(uint64_t stream_id) override;

private:
  nng_smart_ptr<nng_stream_dialer> dialer_{nng_stream_dialer_free};
  nng_smart_ptr<nng_aio> aio_dialer_{nng_aio_free};
  session_ptr session_;

  bool tcp_no_delay_;
};
DECLARE_PTR(websocket_client)

FORWARD_DECLARE_CLASS_PTR(http_server)
class websocket_server : public web_agent {
public:
  explicit websocket_server(const nng_url *base_url, const std::string &path, bool is_text_mode, bool tcp_no_delay,
                            size_t max_num_connections);

  explicit websocket_server(http_server_ptr http_server, const nng_url *base_url, const std::string &path,
                            bool is_text_mode, bool tcp_no_delay, size_t max_num_connections);

  virtual ~websocket_server();

  void start() override;

  void stop() override;

  void start_accept();

  void accept_cb();

  void send(const char *data, int len, uint64_t stream_id);

  void add_session(nng_stream *stream);

  void remove_session(uint64_t stream_id);

  session_ptr get_session(uint64_t stream_id);

  void onError(uint64_t stream_id) override;

  void onDisconnect(uint64_t stream_id) override;

  void onConnect(uint64_t stream_id) override;

  bool data_available() override;

  void next() override;

  void on_frame() override;

  void add_join(const yijinjing::data::location_ptr &location, uint32_t dest, int64_t begin_time) override;

  void add_disjion(const yijinjing::data::location_ptr &location, uint32_t dest) override;

  void cleanup_reader_join() override;

  void cleanup_reader_disjoin() override;

private:
  const nng_url *url_;
  const bool is_text_mode_;
  const bool tcp_no_delay_;
  const size_t session_max_;
  http_server_ptr http_server_ = nullptr;
  size_t session_num_;
  nng_smart_ptr<nng_stream_listener> listener_{nng_stream_listener_free};
  nng_smart_ptr<nng_aio> aio_listener_{nng_aio_free};

  std::unordered_map<uint64_t, session_ptr> sessions_;
  std::shared_mutex sessions_mtx_;
};
DECLARE_PTR(websocket_server)

class http_server : public web_agent {
public:
  explicit http_server(const std::string &address);

  virtual ~http_server();

  void add_websocket(const std::string &path, bool is_text_mode, bool tcp_no_delay = true,
                     size_t max_num_connections = 0);

  void remove_websocket(const std::string &path);

  int port();

  void start() override;

  void stop() override;

  void onError(uint64_t stream_id) override;

  void onDisconnect(uint64_t stream_id) override;

  void onConnect(uint64_t stream_id) override;

  session_ptr get_session(uint64_t stream_id);

private:
  std::map<std::string, std::shared_ptr<websocket_server>> websockets_;
  nng_smart_ptr<nng_http_server> server_{nng_http_server_release};
  bool started_;
  nng_smart_ptr<nng_url> url_{nng_url_free};
};
DECLARE_PTR(http_server)

} // namespace kungfu::webserver

#endif // KUNGFU_WEBSERVER_H
