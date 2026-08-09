// SPDX-License-Identifier: Apache-2.0
//
// The C++ sibling of dogfood-service.mjs (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): the first real C++
// config.service body, shaped after an OpenClaw-style agent — a long-lived
// process that reaches OUT to an external endpoint and reaches the host only
// over the capability relay. Unlike the node dogfood, a C++ service has no
// interpreter and no bootstrap: this source is compiled into a prebuilt binary
// that links the guest proxy (framework/core/src/capability/guest.hpp) and this
// body into one image, and the service host launches that binary directly — the
// prebuilt-artifact cpp entry KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be resolves.
//
// It exercises the service facet on the OS-sandbox plane end to end: discovery →
// plan → the user's authorization → landing → relay. It reaches the network (a
// raw TCP connect — the carrier, confined by the sandbox membrane when
// untrusted) and reads the ledger over the relay, then reports both back over
// the relay. Its only stdout writes go through the relay; diagnostics go to
// stderr.
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include <fcntl.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include "guest.hpp"

using kungfu::capability::Guest;
using kungfu::capability::json;

static std::string url_host(const std::string &url) {
  std::string s = url;
  const auto scheme = s.find("://");
  if (scheme != std::string::npos)
    s = s.substr(scheme + 3);
  const auto slash = s.find('/');
  if (slash != std::string::npos)
    s = s.substr(0, slash);
  const auto colon = s.find(':');
  if (colon != std::string::npos)
    s = s.substr(0, colon);
  return s;
}

// A real outbound egress: resolve the host and attempt a bounded TCP connect.
// Success means the sandbox let the socket out; a blocked resolve or refused
// connect is what an ungranted (default-deny) sandbox must produce.
static bool reach_network(const std::string &host, const char *port, std::string &error) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo *res = nullptr;
  const int gai = getaddrinfo(host.c_str(), port, &hints, &res);
  if (gai != 0) {
    error = std::string("getaddrinfo: ") + gai_strerror(gai);
    return false;
  }
  error = "no address";
  for (addrinfo *ai = res; ai != nullptr; ai = ai->ai_next) {
    const int fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) {
      error = std::string("socket: ") + std::strerror(errno);
      continue;
    }
    const int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    int rc = connect(fd, ai->ai_addr, ai->ai_addrlen);
    if (rc == 0) {
      close(fd);
      freeaddrinfo(res);
      return true;
    }
    if (errno != EINPROGRESS) {
      error = std::string("connect: ") + std::strerror(errno);
      close(fd);
      continue;
    }
    fd_set wf;
    FD_ZERO(&wf);
    FD_SET(fd, &wf);
    timeval tv{5, 0};
    rc = select(fd + 1, nullptr, &wf, nullptr, &tv);
    if (rc > 0) {
      int err = 0;
      socklen_t len = sizeof(err);
      getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
      if (err == 0) {
        close(fd);
        freeaddrinfo(res);
        return true;
      }
      error = std::string("connect: ") + std::strerror(err);
    } else if (rc == 0) {
      error = "connect: timeout";
    } else {
      error = std::string("select: ") + std::strerror(errno);
    }
    close(fd);
  }
  freeaddrinfo(res);
  return false;
}

int main() {
  const char *declared_env = std::getenv("KFX_DECLARED");
  std::vector<std::string> declared;
  if (declared_env != nullptr) {
    const json d = json::parse(declared_env, nullptr, /*allow_exceptions=*/false);
    if (d.is_array()) {
      for (const auto &x : d)
        declared.push_back(x.get<std::string>());
    }
  }
  const char *net_env = std::getenv("KFX_NET_URL");
  const std::string endpoint = net_env != nullptr ? net_env : "https://example.com";

  Guest guest(declared);
  try {
    std::string net_error;
    const bool reached = reach_network(url_host(endpoint), "443", net_error);

    json limit_arg;
    limit_arg["limit"] = 3;
    const json records = guest.cap("ledger").call("records", {limit_arg});
    const int record_count = records.is_array() ? static_cast<int>(records.size()) : -1;

    json report;
    report["facet"] = "service";
    report["kind"] = "dogfood-openclaw";
    report["runtime"] = "cpp";
    report["endpoint"] = endpoint;
    report["reachedNetwork"] = reached;
    if (reached) {
      report["netError"] = nullptr;
    } else {
      report["netError"] = net_error;
    }
    report["relayRecordCount"] = record_count;
    guest.cap("report").call("result", {report});
  } catch (const std::exception &e) {
    std::cerr << "[dogfood-service] " << e.what() << "\n";
    guest.close();
    return 1;
  }
  guest.close();
  return 0;
}
