// SPDX-License-Identifier: Apache-2.0
//
// The C++ counterpart of guest-harness/service-facet.mjs: a background-service
// body that runs INSIDE the OS sandbox and, unlike the node/python fixtures,
// needs no bootstrap — a compiled C++ service IS the guest, linking the guest
// proxy (framework/core/src/capability/guest.hpp) and this body into one binary
// the host launches directly (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be prebuilt-artifact cpp entry).
//
// It does the same two independent things the node service facet does, so the
// same membrane proof applies to the C++ runtime:
//   1. a real outbound network egress (a raw TCP connect) — exercises the OS
//      sandbox membrane's network rule;
//   2. a real capability call over the stdio relay (ledger.records) — exercises
//      the relay, which rides the child's stdio and is independent of the
//      network.
// It reports BOTH outcomes over the relay (report.result), so the host can prove
// egress succeeds when the profile allows it, is refused when the profile denies
// it, and the relay flows either way. Its only stdout writes go through the
// relay; diagnostics go to stderr.
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

// Extract the bare host from a URL like "https://example.com/path" -> "example.com".
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

struct EgressResult {
  bool ok;
  std::string error;
};

// A real outbound egress probe: resolve the host and attempt a TCP connect with
// a bounded timeout. Success means the sandbox let the socket out; a failure
// (blocked resolve or refused connect) is what denyNetwork must produce. No HTTP
// client — the connect alone crosses the membrane, which is the property under
// test.
static EgressResult probe_egress(const std::string &host, const char *port) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo *res = nullptr;
  const int gai = getaddrinfo(host.c_str(), port, &hints, &res);
  if (gai != 0) {
    return {false, std::string("getaddrinfo: ") + gai_strerror(gai)};
  }
  EgressResult out{false, "no address"};
  for (addrinfo *ai = res; ai != nullptr; ai = ai->ai_next) {
    const int fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) {
      out = {false, std::string("socket: ") + std::strerror(errno)};
      continue;
    }
    const int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    int rc = connect(fd, ai->ai_addr, ai->ai_addrlen);
    if (rc == 0) {
      close(fd);
      freeaddrinfo(res);
      return {true, ""};
    }
    if (errno != EINPROGRESS) {
      out = {false, std::string("connect: ") + std::strerror(errno)};
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
        return {true, ""};
      }
      out = {false, std::string("connect: ") + std::strerror(err)};
    } else if (rc == 0) {
      out = {false, "connect: timeout"};
    } else {
      out = {false, std::string("select: ") + std::strerror(errno)};
    }
    close(fd);
  }
  freeaddrinfo(res);
  return out;
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
  const std::string url = net_env != nullptr ? net_env : "https://example.com";

  Guest guest(declared);
  try {
    // (1) egress through the sandbox membrane.
    const EgressResult egress = probe_egress(url_host(url), "443");

    // (2) a capability call over the relay — must succeed regardless of the
    // network knob, because the relay rides stdio, not the network.
    json limit_arg;
    limit_arg["limit"] = 3;
    const json records = guest.cap("ledger").call("records", {limit_arg});
    const int record_count = records.is_array() ? static_cast<int>(records.size()) : -1;

    // (3) report over the relay (another relay call); its delivery is itself
    // proof the relay flowed.
    json report;
    report["facet"] = "service";
    report["runtime"] = "cpp";
    report["url"] = url;
    report["networkOk"] = egress.ok;
    if (egress.ok) {
      report["netError"] = nullptr;
    } else {
      report["netError"] = egress.error;
    }
    report["relayRecordCount"] = record_count;
    guest.cap("report").call("result", {report});
  } catch (const std::exception &e) {
    std::cerr << "[cpp-service] " << e.what() << "\n";
    guest.close();
    return 1;
  }
  guest.close();
  return 0;
}
