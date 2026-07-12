// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/ownership.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <utility>

#include <fmt/format.h>
#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace kungfu::yijinjing::ownership {
namespace {

namespace fs = std::filesystem;

std::mutex local_owners_mutex;
std::set<std::string> local_owners;
std::atomic<uint64_t> token_counter{0};

uint64_t current_pid() noexcept {
#ifdef _WIN32
  return static_cast<uint64_t>(GetCurrentProcessId());
#else
  return static_cast<uint64_t>(::getpid());
#endif
}

std::string normalized_path(const fs::path &path) { return fs::absolute(path).lexically_normal().string(); }

void validate_input(scope ownership_scope, const std::string &data_root, const std::string &resource_id) {
  if (data_root.empty()) {
    throw std::invalid_argument("ownership_invalid_data_root: path is empty");
  }
  if (resource_id.empty()) {
    throw std::invalid_argument("ownership_invalid_resource_id: value is empty");
  }
  if (ownership_scope == scope::StreamWriter) {
    const auto valid = std::all_of(resource_id.begin(), resource_id.end(), [](unsigned char value) {
      return std::isalnum(value) != 0 || value == '.' || value == '_' || value == '-';
    });
    if (!valid) {
      throw std::invalid_argument("ownership_invalid_resource_id: unsupported path character");
    }
  }
}

fs::path lock_path(scope ownership_scope, const std::string &data_root, const std::string &resource_id) {
  auto directory = fs::path(data_root) / "ownership";
  if (ownership_scope == scope::StreamWriter) {
    directory /= "writers";
  }
  fs::create_directories(directory);
  return ownership_scope == scope::DataRootService ? directory / "state-service.lock"
                                                   : directory / (resource_id + ".lock");
}

std::string make_fence_token(const std::string &data_root, const std::string &resource_id, uint64_t generation,
                             int64_t acquired_at, uint64_t pid) {
  const auto counter = token_counter.fetch_add(1, std::memory_order_relaxed) + 1;
  const auto input = data_root + "|" + resource_id + "|" + std::to_string(generation) + "|" +
                     std::to_string(acquired_at) + "|" + std::to_string(pid) + "|" + std::to_string(counter);
  return fmt::format("{:016x}", fast_hash_str_64(input));
}

nlohmann::json evidence_json(const evidence &value, const char *state) {
  return {{"schema", value.schema},
          {"scope", scope_name(value.ownership_scope)},
          {"data_root", value.data_root},
          {"resource_id", value.resource_id},
          {"generation", value.generation},
          {"fence_token", value.fence_token},
          {"owner_pid", value.owner_pid},
          {"acquired_at", value.acquired_at},
          {"recovered_stale_owner", value.recovered_stale_owner},
          {"state", state}};
}

struct prior_evidence {
  uint64_t generation = 0;
  bool was_owned = false;
};

prior_evidence parse_prior(const std::string &raw) noexcept {
  if (raw.empty()) {
    return {};
  }
  try {
    const auto value = nlohmann::json::parse(raw);
    if (value.value("schema", "") != OWNERSHIP_EVIDENCE_SCHEMA_V1) {
      return {};
    }
    return {value.value("generation", uint64_t{0}), value.value("state", "") == "owned"};
  } catch (...) {
    return {};
  }
}

evidence parse_evidence(const std::string &raw) {
  const auto value = nlohmann::json::parse(raw);
  if (value.value("schema", "") != OWNERSHIP_EVIDENCE_SCHEMA_V1 || value.value("scope", "") != "stream_writer" ||
      value.value("state", "") != "owned") {
    throw busy_error("ownership_not_active: writer evidence is not owned");
  }
  evidence result;
  result.schema = OWNERSHIP_EVIDENCE_SCHEMA_V1;
  result.ownership_scope = scope::StreamWriter;
  result.data_root = value.at("data_root").get<std::string>();
  result.resource_id = value.at("resource_id").get<std::string>();
  result.generation = value.at("generation").get<uint64_t>();
  result.fence_token = value.at("fence_token").get<std::string>();
  result.owner_pid = value.at("owner_pid").get<uint64_t>();
  result.acquired_at = value.at("acquired_at").get<int64_t>();
  result.recovered_stale_owner = value.value("recovered_stale_owner", false);
  result.owned = true;
  return result;
}

std::string read_path(const std::string &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("ownership_io_error: cannot read " + path);
  }
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

class local_reservation {
public:
  explicit local_reservation(std::string key) : key_(std::move(key)) {
    std::lock_guard<std::mutex> lock(local_owners_mutex);
    if (!local_owners.insert(key_).second) {
      throw busy_error("ownership_busy: this process already owns " + key_);
    }
    held_ = true;
  }

  local_reservation(local_reservation &&other) noexcept
      : key_(std::move(other.key_)), held_(std::exchange(other.held_, false)) {}
  local_reservation(const local_reservation &) = delete;
  local_reservation &operator=(const local_reservation &) = delete;

  ~local_reservation() { release(); }

  void release() noexcept {
    if (!held_) {
      return;
    }
    std::lock_guard<std::mutex> lock(local_owners_mutex);
    local_owners.erase(key_);
    held_ = false;
  }

private:
  std::string key_;
  bool held_ = false;
};

} // namespace

struct lease::impl {
  impl(scope ownership_scope, std::string data_root, std::string resource_id)
      : lock_path([&] {
          validate_input(ownership_scope, data_root, resource_id);
          return normalized_path(ownership::lock_path(ownership_scope, data_root, resource_id));
        }()),
        reservation(lock_path) {
#ifdef _WIN32
    handle = CreateFileA(lock_path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                         OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("ownership_io_error: cannot open " + lock_path);
    }
    OVERLAPPED overlapped{};
    if (LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped) == 0) {
      CloseHandle(handle);
      handle = INVALID_HANDLE_VALUE;
      throw busy_error("ownership_busy: another process owns " + lock_path);
    }
#else
    fd = ::open(lock_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0644);
    if (fd < 0) {
      throw std::runtime_error("ownership_io_error: cannot open " + lock_path + ": " + std::to_string(errno));
    }
    if (::flock(fd, LOCK_EX | LOCK_NB) != 0) {
      ::close(fd);
      fd = -1;
      throw busy_error("ownership_busy: another process owns " + lock_path);
    }
#endif

    try {
      const auto previous = parse_prior(read_all());
      value.schema = OWNERSHIP_EVIDENCE_SCHEMA_V1;
      value.ownership_scope = ownership_scope;
      value.data_root = normalized_path(data_root);
      value.resource_id = std::move(resource_id);
      value.generation = previous.generation + 1;
      value.owner_pid = current_pid();
      value.acquired_at = time::now_in_nano();
      value.recovered_stale_owner = previous.was_owned;
      value.fence_token =
          make_fence_token(value.data_root, value.resource_id, value.generation, value.acquired_at, value.owner_pid);
      value.owned = true;
      write_all(evidence_json(value, "owned").dump());
    } catch (...) {
      release_os_lock();
      throw;
    }
  }

  ~impl() {
    if (value.owned) {
      try {
        write_all(evidence_json(value, "released").dump());
      } catch (...) {
      }
      value.owned = false;
    }
    release_os_lock();
  }

  void release_os_lock() noexcept {
#ifdef _WIN32
    if (handle != INVALID_HANDLE_VALUE) {
      OVERLAPPED overlapped{};
      UnlockFileEx(handle, 0, 1, 0, &overlapped);
      CloseHandle(handle);
      handle = INVALID_HANDLE_VALUE;
    }
#else
    if (fd >= 0) {
      ::flock(fd, LOCK_UN);
      ::close(fd);
      fd = -1;
    }
#endif
  }

  std::string read_all() {
#ifdef _WIN32
    LARGE_INTEGER zero{};
    SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN);
    std::string output;
    char buffer[4096];
    DWORD read = 0;
    while (ReadFile(handle, buffer, sizeof(buffer), &read, nullptr) != 0 && read > 0) {
      output.append(buffer, read);
    }
    return output;
#else
    if (::lseek(fd, 0, SEEK_SET) < 0) {
      throw std::runtime_error("ownership_io_error: cannot seek " + lock_path);
    }
    std::string output;
    char buffer[4096];
    ssize_t count = 0;
    while ((count = ::read(fd, buffer, sizeof(buffer))) > 0) {
      output.append(buffer, static_cast<size_t>(count));
    }
    if (count < 0) {
      throw std::runtime_error("ownership_io_error: cannot read " + lock_path);
    }
    return output;
#endif
  }

  void write_all(const std::string &raw) {
#ifdef _WIN32
    LARGE_INTEGER zero{};
    if (SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) == 0 || SetEndOfFile(handle) == 0) {
      throw std::runtime_error("ownership_io_error: cannot truncate " + lock_path);
    }
    DWORD written = 0;
    if (WriteFile(handle, raw.data(), static_cast<DWORD>(raw.size()), &written, nullptr) == 0 ||
        written != raw.size() || FlushFileBuffers(handle) == 0) {
      throw std::runtime_error("ownership_io_error: cannot write " + lock_path);
    }
#else
    if (::ftruncate(fd, 0) != 0 || ::lseek(fd, 0, SEEK_SET) < 0) {
      throw std::runtime_error("ownership_io_error: cannot truncate " + lock_path);
    }
    size_t offset = 0;
    while (offset < raw.size()) {
      const auto count = ::write(fd, raw.data() + offset, raw.size() - offset);
      if (count <= 0) {
        throw std::runtime_error("ownership_io_error: cannot write " + lock_path);
      }
      offset += static_cast<size_t>(count);
    }
    if (::fsync(fd) != 0) {
      throw std::runtime_error("ownership_io_error: cannot flush " + lock_path);
    }
#endif
  }

  std::string lock_path;
  local_reservation reservation;
  evidence value = {};
#ifdef _WIN32
  HANDLE handle = INVALID_HANDLE_VALUE;
#else
  int fd = -1;
#endif
};

const char *scope_name(scope value) noexcept {
  switch (value) {
  case scope::DataRootService:
    return "data_root_service";
  case scope::StreamWriter:
    return "stream_writer";
  }
  return "unknown";
}

lease::lease(std::unique_ptr<impl> impl) noexcept : impl_(std::move(impl)) {}
lease::lease(lease &&other) noexcept = default;
lease &lease::operator=(lease &&other) noexcept = default;
lease::~lease() = default;

lease lease::acquire_data_root_service(const std::string &data_root, const std::string &owner_id) {
  return lease(std::make_unique<impl>(scope::DataRootService, data_root, owner_id));
}

lease lease::acquire_stream_writer(const std::string &data_root, const std::string &resource_id) {
  return lease(std::make_unique<impl>(scope::StreamWriter, data_root, resource_id));
}

bool lease::owns() const noexcept { return impl_ != nullptr && impl_->value.owned; }

const evidence &lease::status() const {
  if (impl_ == nullptr) {
    throw std::logic_error("ownership lease is empty");
  }
  return impl_->value;
}

evidence inspect_active_stream_writer(const std::string &data_root, const std::string &resource_id) {
  validate_input(scope::StreamWriter, data_root, resource_id);
  const auto path = normalized_path(lock_path(scope::StreamWriter, data_root, resource_id));
  bool held_locally = false;
  {
    std::lock_guard<std::mutex> lock(local_owners_mutex);
    held_locally = local_owners.contains(path);
  }
  if (!held_locally) {
#ifdef _WIN32
    const auto handle =
        CreateFileW(fs::path(path).wstring().c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("ownership_io_error: cannot inspect " + path);
    }
    OVERLAPPED overlapped{};
    if (LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped) != 0) {
      UnlockFileEx(handle, 0, 1, 0, &overlapped);
      CloseHandle(handle);
      throw busy_error("ownership_not_active: no live writer owns " + path);
    }
    const auto error = GetLastError();
    CloseHandle(handle);
    if (error != ERROR_LOCK_VIOLATION && error != ERROR_IO_PENDING) {
      throw std::system_error(static_cast<int>(error), std::system_category(), "inspect writer ownership");
    }
#else
    const auto fd = ::open(path.c_str(), O_RDWR | O_CLOEXEC);
    if (fd < 0) {
      throw std::runtime_error("ownership_io_error: cannot inspect " + path);
    }
    if (::flock(fd, LOCK_EX | LOCK_NB) == 0) {
      ::flock(fd, LOCK_UN);
      ::close(fd);
      throw busy_error("ownership_not_active: no live writer owns " + path);
    }
    const auto error = errno;
    ::close(fd);
    if (error != EWOULDBLOCK && error != EAGAIN) {
      throw std::system_error(error, std::generic_category(), "inspect writer ownership");
    }
#endif
  }
  auto result = parse_evidence(read_path(path));
  if (normalized_path(result.data_root) != normalized_path(data_root) || result.resource_id != resource_id) {
    throw busy_error("ownership_not_active: writer evidence identity mismatch");
  }
  return result;
}

} // namespace kungfu::yijinjing::ownership
