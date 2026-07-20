// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/durable_ingest.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <exception>
#include <expected>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <stdexcept>
#include <system_error>
#include <utility>

#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/time.h>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace kungfu::runtime::durability {
namespace {

namespace fs = std::filesystem;
using yijinjing::ownership::evidence;
using yijinjing::ownership::lease;
using yijinjing::ownership::scope;
using yijinjing::storage::compute_content_hash_value;

// Classify-and-continue seam (ADR-0082 tier 2). A durability commit path throws
// through several helpers; rather than a hand-maintained catch ladder at every
// such seam, exceptions are captured once as a value and mapped through a single
// central classifier via `std::expected::transform_error`. The classifier is the
// one place that decides how an exception type projects onto the ingest error /
// receipt code / message triple, so the mapping cannot drift between seams.
struct ingest_failure {
  ingest_error error;
  durability_error_code code;
  std::string message;
};

// Run a throwing body and capture any exception as a value. The body's own
// early returns stay values (success or a valid non-error outcome); only a
// thrown exception becomes the unexpected branch.
template <class F>
auto capture_ingest_exception(F &&body) -> std::expected<std::invoke_result_t<F &>, std::exception_ptr> {
  try {
    return std::forward<F>(body)();
  } catch (...) {
    return std::unexpected(std::current_exception());
  }
}

// The single classification point for durability commit failures. Mirrors the
// former three-arm catch ladder exactly: fencing (logic) -> FencingLost,
// I/O (system) -> IoError, anything else -> InjectedFault; all surface as a
// ServiceUnavailable receipt with an Unknown outcome at the call site.
ingest_failure classify_durability_failure(std::exception_ptr eptr) {
  try {
    std::rethrow_exception(eptr);
  } catch (const std::logic_error &error) {
    return {ingest_error::FencingLost, durability_error_code::ServiceUnavailable, error.what()};
  } catch (const std::system_error &error) {
    return {ingest_error::IoError, durability_error_code::ServiceUnavailable, error.what()};
  } catch (const std::exception &error) {
    return {ingest_error::InjectedFault, durability_error_code::ServiceUnavailable, error.what()};
  }
}

constexpr std::array<char, 8> SEGMENT_MAGIC{'K', 'F', 'D', 'L', 'S', 'E', 'G', '2'};
constexpr std::array<char, 8> RECORD_MAGIC{'K', 'F', 'D', 'L', 'R', 'E', 'C', '2'};
constexpr std::array<char, 8> CHECKPOINT_MAGIC{'K', 'F', 'D', 'L', 'C', 'P', '0', '2'};
constexpr uint32_t FORMAT_VERSION = 2;
constexpr uint64_t SEGMENT_HEADER_SIZE = 40;
constexpr uint64_t RECORD_HEADER_SIZE = 244;

void append_u32(std::string &out, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    out.push_back(static_cast<char>((value >> shift) & 0xffU));
  }
}

void append_u64(std::string &out, uint64_t value) {
  for (unsigned shift = 0; shift < 64; shift += 8) {
    out.push_back(static_cast<char>((value >> shift) & 0xffU));
  }
}

uint32_t read_u32(const std::string &bytes, size_t &offset) {
  if (offset + 4 > bytes.size()) {
    throw std::runtime_error("durable_container_truncated");
  }
  uint32_t value = 0;
  for (unsigned shift = 0; shift < 32; shift += 8) {
    value |= static_cast<uint32_t>(static_cast<unsigned char>(bytes[offset++])) << shift;
  }
  return value;
}

uint64_t read_u64(const std::string &bytes, size_t &offset) {
  if (offset + 8 > bytes.size()) {
    throw std::runtime_error("durable_container_truncated");
  }
  uint64_t value = 0;
  for (unsigned shift = 0; shift < 64; shift += 8) {
    value |= static_cast<uint64_t>(static_cast<unsigned char>(bytes[offset++])) << shift;
  }
  return value;
}

void append_string(std::string &out, const std::string &value) {
  if (value.size() > std::numeric_limits<uint32_t>::max()) {
    throw std::invalid_argument("durable_string_too_large");
  }
  append_u32(out, static_cast<uint32_t>(value.size()));
  out.append(value);
}

std::string read_string(const std::string &bytes, size_t &offset) {
  const auto size = read_u32(bytes, offset);
  if (offset + size > bytes.size()) {
    throw std::runtime_error("durable_container_truncated");
  }
  auto result = bytes.substr(offset, size);
  offset += size;
  return result;
}

std::string sha256(const std::string &bytes) { return compute_content_hash_value(bytes); }

std::string normalized_root(const std::string &root) {
  if (root.empty()) {
    throw std::invalid_argument("durable_data_root_empty");
  }
  return fs::absolute(root).lexically_normal().string();
}

class native_file {
public:
  native_file(const fs::path &path, bool truncate) : path_(path) {
#ifdef _WIN32
    handle_ = CreateFileW(path.wstring().c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                          truncate ? CREATE_ALWAYS : OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) {
      throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "open durable file");
    }
    LARGE_INTEGER target{};
    if (!truncate && SetFilePointerEx(handle_, target, nullptr, FILE_END) == 0) {
      throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "seek durable file");
    }
#else
    fd_ = ::open(path.c_str(), O_CREAT | O_RDWR | (truncate ? O_TRUNC : O_APPEND) | O_CLOEXEC, 0644);
    if (fd_ < 0) {
      throw std::system_error(errno, std::generic_category(), "open durable file");
    }
#endif
  }

  ~native_file() {
#ifdef _WIN32
    if (handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
    }
#else
    if (fd_ >= 0) {
      ::close(fd_);
    }
#endif
  }

  native_file(const native_file &) = delete;
  native_file &operator=(const native_file &) = delete;

  void write(const std::string &bytes) {
    size_t offset = 0;
    while (offset < bytes.size()) {
#ifdef _WIN32
      const auto remaining = std::min<size_t>(bytes.size() - offset, std::numeric_limits<DWORD>::max());
      DWORD written = 0;
      if (WriteFile(handle_, bytes.data() + offset, static_cast<DWORD>(remaining), &written, nullptr) == 0 ||
          written == 0) {
        throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "write durable file");
      }
      offset += written;
#else
      const auto written = ::write(fd_, bytes.data() + offset, bytes.size() - offset);
      if (written <= 0) {
        throw std::system_error(errno, std::generic_category(), "write durable file");
      }
      offset += static_cast<size_t>(written);
#endif
    }
  }

  void sync() {
#ifdef _WIN32
    if (FlushFileBuffers(handle_) == 0) {
      throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "sync durable file");
    }
#else
    if (::fsync(fd_) != 0) {
      throw std::system_error(errno, std::generic_category(), "sync durable file");
    }
#endif
  }

private:
  fs::path path_;
#ifdef _WIN32
  HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
  int fd_ = -1;
#endif
};

void sync_directory(const fs::path &directory) {
#ifdef _WIN32
  // Win32 directory handles are valid only for a documented subset of file
  // APIs; FlushFileBuffers is not one of them.  Checkpoint publication already
  // uses MoveFileExW(MOVEFILE_WRITE_THROUGH), the Windows metadata barrier.
  // Keep this boundary fail-closed for a missing/non-directory path without
  // inventing a POSIX directory-fsync guarantee on Windows.
  std::error_code error;
  if (!fs::is_directory(directory, error) || error) {
    throw std::system_error(error ? error : std::make_error_code(std::errc::not_a_directory),
                            "validate durable directory");
  }
#else
  const auto fd = ::open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) {
    throw std::system_error(errno, std::generic_category(), "open durable directory");
  }
  const auto result = ::fsync(fd);
  const auto error = errno;
  ::close(fd);
  if (result != 0) {
    throw std::system_error(error, std::generic_category(), "sync durable directory");
  }
#endif
}

void create_directory_chain_durably(const fs::path &existing_root, const std::vector<std::string> &components) {
  auto current = existing_root;
  for (const auto &component : components) {
    const auto child = current / component;
    if (!fs::exists(child)) {
      if (!fs::create_directory(child)) {
        throw std::runtime_error("cannot create durable directory " + child.string());
      }
      sync_directory(current);
    }
    current = child;
  }
}

void replace_file(const fs::path &temporary, const fs::path &final) {
#ifdef _WIN32
  if (MoveFileExW(temporary.wstring().c_str(), final.wstring().c_str(),
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "publish durable checkpoint");
  }
#else
  if (::rename(temporary.c_str(), final.c_str()) != 0) {
    throw std::system_error(errno, std::generic_category(), "publish durable checkpoint");
  }
#endif
}

std::string read_file(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("cannot read durable file " + path.string());
  }
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void validate_owner(const lease &owner, scope expected_scope, const std::string &root,
                    const std::string &resource_id = {}) {
  if (!owner.owns()) {
    throw std::logic_error("durable_fencing_lost");
  }
  const auto &status = owner.status();
  if (!status.owned || status.ownership_scope != expected_scope || normalized_root(status.data_root) != root ||
      (!resource_id.empty() && status.resource_id != resource_id)) {
    throw std::logic_error("durable_fencing_mismatch");
  }
}

struct checkpoint {
  uint64_t request_id = 0;
  uint64_t barrier_id = 0;
  uint64_t chain_start_segment_id = 1;
  uint64_t segment_id = 1;
  uint64_t durable_offset = SEGMENT_HEADER_SIZE;
  stream_position position = {};
  uint64_t owner_generation = 0;
  uint64_t writer_generation = 0;
  std::string owner_fence = {};
  std::string writer_fence = {};
  std::string qualification_profile = {};
  std::string durability_profile = {};
  std::map<uint64_t, durability_receipt> completed_requests = {};
};

void append_completed_request(std::string &out, const durability_receipt &receipt) {
  append_u64(out, receipt.request_id);
  append_u64(out, receipt.position.stream_id);
  append_u64(out, receipt.position.container_epoch);
  append_u64(out, receipt.position.sequence);
  append_u64(out, receipt.position.frame_uid);
  append_string(out, durability_profile_name(receipt.requested_profile));
  append_u64(out, receipt.barrier_id);
  append_string(out, receipt.qualification_profile);
  append_u64(out, static_cast<uint64_t>(receipt.completed_at));
}

durability_receipt read_completed_request(const std::string &bytes, size_t &offset) {
  durability_receipt receipt;
  receipt.request_id = read_u64(bytes, offset);
  receipt.position.stream_id = read_u64(bytes, offset);
  receipt.position.container_epoch = read_u64(bytes, offset);
  receipt.position.sequence = read_u64(bytes, offset);
  receipt.position.frame_uid = read_u64(bytes, offset);
  receipt.requested_profile = parse_durability_profile(read_string(bytes, offset));
  receipt.achieved_profile = receipt.requested_profile;
  receipt.durable_watermark = receipt.position;
  receipt.barrier_id = read_u64(bytes, offset);
  receipt.qualification_profile = read_string(bytes, offset);
  receipt.completed_at = static_cast<int64_t>(read_u64(bytes, offset));
  receipt.status = receipt_status::Succeeded;
  receipt.error = durability_error_code::None;
  return receipt;
}

std::string encode_checkpoint(const checkpoint &value) {
  std::string body;
  append_u64(body, value.request_id);
  append_u64(body, value.barrier_id);
  append_u64(body, value.chain_start_segment_id);
  append_u64(body, value.segment_id);
  append_u64(body, value.durable_offset);
  append_u64(body, value.position.stream_id);
  append_u64(body, value.position.container_epoch);
  append_u64(body, value.position.sequence);
  append_u64(body, value.position.frame_uid);
  append_u64(body, value.owner_generation);
  append_u64(body, value.writer_generation);
  append_string(body, value.owner_fence);
  append_string(body, value.writer_fence);
  append_string(body, value.qualification_profile);
  append_string(body, value.durability_profile);
  if (value.completed_requests.size() > std::numeric_limits<uint32_t>::max()) {
    throw std::invalid_argument("durable_completed_request_index_too_large");
  }
  append_u32(body, static_cast<uint32_t>(value.completed_requests.size()));
  for (const auto &[request_id, receipt] : value.completed_requests) {
    if (request_id != receipt.request_id) {
      throw std::logic_error("durable_completed_request_index_mismatch");
    }
    append_completed_request(body, receipt);
  }

  std::string encoded(CHECKPOINT_MAGIC.data(), CHECKPOINT_MAGIC.size());
  append_u32(encoded, FORMAT_VERSION);
  append_u32(encoded, static_cast<uint32_t>(body.size()));
  encoded += body;
  encoded += sha256(encoded);
  return encoded;
}

checkpoint decode_checkpoint(const std::string &encoded) {
  if (encoded.size() < 8 + 4 + 4 + 64 ||
      !std::equal(CHECKPOINT_MAGIC.begin(), CHECKPOINT_MAGIC.end(), encoded.begin())) {
    throw std::runtime_error("durable_checkpoint_magic_mismatch");
  }
  const auto stored_digest = encoded.substr(encoded.size() - 64);
  if (sha256(encoded.substr(0, encoded.size() - 64)) != stored_digest) {
    throw std::runtime_error("durable_checkpoint_checksum_mismatch");
  }
  size_t offset = 8;
  if (read_u32(encoded, offset) != FORMAT_VERSION) {
    throw std::runtime_error("durable_checkpoint_version_mismatch");
  }
  const auto body_size = read_u32(encoded, offset);
  if (offset + body_size + 64 != encoded.size()) {
    throw std::runtime_error("durable_checkpoint_length_mismatch");
  }
  checkpoint value;
  value.request_id = read_u64(encoded, offset);
  value.barrier_id = read_u64(encoded, offset);
  value.chain_start_segment_id = read_u64(encoded, offset);
  value.segment_id = read_u64(encoded, offset);
  value.durable_offset = read_u64(encoded, offset);
  value.position.stream_id = read_u64(encoded, offset);
  value.position.container_epoch = read_u64(encoded, offset);
  value.position.sequence = read_u64(encoded, offset);
  value.position.frame_uid = read_u64(encoded, offset);
  value.owner_generation = read_u64(encoded, offset);
  value.writer_generation = read_u64(encoded, offset);
  value.owner_fence = read_string(encoded, offset);
  value.writer_fence = read_string(encoded, offset);
  value.qualification_profile = read_string(encoded, offset);
  value.durability_profile = read_string(encoded, offset);
  const auto completed_count = read_u32(encoded, offset);
  for (uint32_t index = 0; index < completed_count; ++index) {
    auto receipt = read_completed_request(encoded, offset);
    if (receipt.request_id == 0 || receipt.position.stream_id != value.position.stream_id ||
        receipt.position.container_epoch != value.position.container_epoch ||
        receipt.position.sequence > value.position.sequence || receipt.barrier_id > value.barrier_id ||
        receipt.qualification_profile != value.qualification_profile ||
        !value.completed_requests.emplace(receipt.request_id, std::move(receipt)).second) {
      throw std::runtime_error("durable_completed_request_index_invalid");
    }
  }
  const auto completing_request = value.completed_requests.find(value.request_id);
  if (value.request_id == 0 || completing_request == value.completed_requests.end() ||
      !(completing_request->second.position == value.position) ||
      completing_request->second.barrier_id != value.barrier_id ||
      durability_profile_name(completing_request->second.requested_profile) != value.durability_profile) {
    throw std::runtime_error("durable_checkpoint_completing_request_invalid");
  }
  if (value.chain_start_segment_id == 0 || value.chain_start_segment_id > value.segment_id ||
      offset + 64 != encoded.size()) {
    throw std::runtime_error("durable_checkpoint_trailing_bytes");
  }
  return value;
}

std::string segment_header(uint64_t segment_id, uint64_t stream_id, uint64_t epoch) {
  std::string header(SEGMENT_MAGIC.data(), SEGMENT_MAGIC.size());
  append_u32(header, FORMAT_VERSION);
  append_u32(header, static_cast<uint32_t>(SEGMENT_HEADER_SIZE));
  append_u64(header, segment_id);
  append_u64(header, stream_id);
  append_u64(header, epoch);
  return header;
}

std::string encode_record(const stream_position &position, int32_t carrier_type, const durable_frame_context &frame,
                          const void *payload, size_t payload_size, uint64_t owner_generation,
                          uint64_t writer_generation) {
  if (payload_size > std::numeric_limits<uint64_t>::max() - RECORD_HEADER_SIZE) {
    throw std::invalid_argument("durable_payload_too_large");
  }
  const std::string payload_bytes(static_cast<const char *>(payload), payload_size);
  std::string header(RECORD_MAGIC.data(), RECORD_MAGIC.size());
  append_u64(header, RECORD_HEADER_SIZE + payload_size);
  append_u64(header, payload_size);
  append_u64(header, position.stream_id);
  append_u64(header, position.container_epoch);
  append_u64(header, position.sequence);
  append_u64(header, position.frame_uid);
  append_u32(header, static_cast<uint32_t>(carrier_type));
  append_u64(header, static_cast<uint64_t>(frame.gen_time));
  append_u64(header, static_cast<uint64_t>(frame.trigger_time));
  append_u32(header, frame.source);
  append_u32(header, frame.dest);
  append_u32(header, static_cast<uint32_t>(frame.data_type));
  append_u32(header, frame.initial_source);
  append_u64(header, frame.trigger_frame_uid);
  append_u64(header, owner_generation);
  append_u64(header, writer_generation);
  header += sha256(payload_bytes);
  const auto record_digest = sha256(header + payload_bytes);
  header += record_digest;
  if (header.size() != RECORD_HEADER_SIZE) {
    throw std::logic_error("durable_record_header_size_mismatch");
  }
  return header + payload_bytes;
}

fs::path active_segment_path(const fs::path &directory, uint64_t segment_id) {
  return directory / ("active-" + std::to_string(segment_id) + ".kfdl");
}

fs::path sealed_segment_path(const fs::path &directory, uint64_t segment_id) {
  return directory / ("sealed-" + std::to_string(segment_id) + ".kfdl");
}

stream_position verify_segment_prefix(const fs::path &path, uint64_t segment_id, uint64_t stream_id, uint64_t epoch,
                                      uint64_t durable_offset,
                                      const std::optional<stream_position> &previous_position = std::nullopt,
                                      std::vector<durable_record> *records = nullptr) {
  const auto bytes = read_file(path);
  if (durable_offset > bytes.size() || durable_offset < SEGMENT_HEADER_SIZE ||
      !std::equal(SEGMENT_MAGIC.begin(), SEGMENT_MAGIC.end(), bytes.begin())) {
    throw std::runtime_error("durable_segment_header_or_offset_invalid");
  }
  size_t offset = 8;
  if (read_u32(bytes, offset) != FORMAT_VERSION || read_u32(bytes, offset) != SEGMENT_HEADER_SIZE ||
      read_u64(bytes, offset) != segment_id || read_u64(bytes, offset) != stream_id ||
      read_u64(bytes, offset) != epoch) {
    throw std::runtime_error("durable_segment_identity_mismatch");
  }
  stream_position last = previous_position.value_or(stream_position{});
  while (offset < durable_offset) {
    const auto record_start = offset;
    if (offset + RECORD_HEADER_SIZE > durable_offset ||
        !std::equal(RECORD_MAGIC.begin(), RECORD_MAGIC.end(), bytes.begin() + static_cast<ptrdiff_t>(offset))) {
      throw std::runtime_error("durable_record_header_invalid");
    }
    offset += RECORD_MAGIC.size();
    const auto record_size = read_u64(bytes, offset);
    const auto payload_size = read_u64(bytes, offset);
    if (record_size != RECORD_HEADER_SIZE + payload_size || record_start + record_size > durable_offset) {
      throw std::runtime_error("durable_record_length_invalid");
    }
    stream_position position;
    position.stream_id = read_u64(bytes, offset);
    position.container_epoch = read_u64(bytes, offset);
    position.sequence = read_u64(bytes, offset);
    position.frame_uid = read_u64(bytes, offset);
    const auto carrier_type = static_cast<int32_t>(read_u32(bytes, offset));
    durable_frame_context frame;
    frame.gen_time = static_cast<int64_t>(read_u64(bytes, offset));
    frame.trigger_time = static_cast<int64_t>(read_u64(bytes, offset));
    frame.source = read_u32(bytes, offset);
    frame.dest = read_u32(bytes, offset);
    frame.data_type = static_cast<int32_t>(read_u32(bytes, offset));
    frame.initial_source = read_u32(bytes, offset);
    frame.trigger_frame_uid = read_u64(bytes, offset);
    const auto owner_generation = read_u64(bytes, offset);
    const auto writer_generation = read_u64(bytes, offset);
    const auto payload_hash = bytes.substr(offset, 64);
    offset += 64;
    const auto record_hash = bytes.substr(offset, 64);
    offset += 64;
    const auto payload = bytes.substr(offset, payload_size);
    if (position.stream_id != stream_id || position.container_epoch != epoch || position.sequence == 0 ||
        (last.sequence != 0 && position.sequence != last.sequence + 1) || sha256(payload) != payload_hash ||
        sha256(bytes.substr(record_start, RECORD_HEADER_SIZE - 64) + payload) != record_hash) {
      throw std::runtime_error("durable_record_identity_order_or_checksum_invalid");
    }
    if (records != nullptr) {
      records->push_back({segment_id, record_start, record_size, position, carrier_type, frame, owner_generation,
                          writer_generation, payload_hash, record_hash, payload});
    }
    offset += payload_size;
    last = position;
  }
  if (offset != durable_offset) {
    throw std::runtime_error("durable_segment_boundary_invalid");
  }
  return last;
}

} // namespace

struct durable_ingest_log::impl {
  explicit impl(ingest_options options, ingest_fault_injector fault_injector)
      : options(std::move(options)), root(normalized_root(this->options.data_root)),
        directory(fs::path(root) / "durable" / "streams" / std::to_string(this->options.stream_id) /
                  std::to_string(this->options.container_epoch)),
        fault_injector(std::move(fault_injector)) {
    if (this->options.stream_id == 0 || this->options.container_epoch == 0 ||
        this->options.writer_resource_id.empty() || this->options.segment_max_bytes <= SEGMENT_HEADER_SIZE) {
      throw std::invalid_argument("durable_ingest_options_invalid");
    }
    if (this->options.read_only) {
      if (!fs::is_directory(directory)) {
        throw std::runtime_error("durable_ingest_read_only_stream_missing");
      }
    } else {
      create_directory_chain_durably(root, {"durable", "streams", std::to_string(this->options.stream_id),
                                            std::to_string(this->options.container_epoch)});
    }
    load_checkpoint();
    if (this->options.read_only) {
      inspect_tail_read_only();
    } else {
      prepare_active_segment();
    }
  }

  void inject(ingest_fault_point point) {
    if (fault_injector) {
      fault_injector(point);
    }
  }

  void load_checkpoint() {
    std::optional<checkpoint> selected;
    bool corrupt_seen = false;
    bool checkpoint_seen = false;
    for (int slot = 0; slot < 2; ++slot) {
      const auto path = directory / ("checkpoint." + std::to_string(slot));
      if (!fs::exists(path)) {
        continue;
      }
      checkpoint_seen = true;
      try {
        auto candidate = decode_checkpoint(read_file(path));
        if (candidate.position.stream_id != options.stream_id ||
            candidate.position.container_epoch != options.container_epoch ||
            candidate.qualification_profile != options.qualification_profile) {
          throw std::runtime_error("durable_checkpoint_identity_mismatch");
        }
        (void)validate_checkpoint_candidate(candidate);
        if (!selected.has_value() || candidate.barrier_id > selected->barrier_id) {
          selected = std::move(candidate);
        }
      } catch (...) {
        corrupt_seen = true;
      }
    }
    if (selected.has_value()) {
      durable_checkpoint = *selected;
      chain_start_segment_id = selected->chain_start_segment_id;
      current_status.active_segment_id = selected->segment_id;
      current_status.durable_chain_start_segment_id = selected->chain_start_segment_id;
      current_status.durable_segment_id = selected->segment_id;
      current_status.durable_offset = selected->durable_offset;
      current_status.last_barrier_id = selected->barrier_id;
      current_status.durable_watermark = selected->position;
      completed_requests = selected->completed_requests;
      current_status.persisted_request_count = completed_requests.size();
      current_status.recovered_request_count = completed_requests.size();
      checkpoint_loaded = true;
      if (corrupt_seen) {
        current_status.last_error = ingest_error::CheckpointCorrupt;
        current_status.last_error_message = "newer_or_peer_checkpoint_slot_is_corrupt";
      }
    } else {
      current_status.active_segment_id = 1;
      current_status.durable_chain_start_segment_id = 0;
      current_status.durable_offset = SEGMENT_HEADER_SIZE;
      current_status.last_error = corrupt_seen ? ingest_error::CheckpointCorrupt : ingest_error::None;
      if (corrupt_seen) {
        current_status.last_error_message = "no_valid_checkpoint_slot";
      }
      if (checkpoint_seen && corrupt_seen) {
        checkpoint_blocked = true;
        current_status.available = false;
        current_status.last_error_message = "checkpoint_evidence_exists_but_no_frontier_is_provable";
      }
    }
    current_status.qualification_profile = options.qualification_profile;
    current_status.production_candidate_enabled = options.activation == ingest_activation::ProductionCandidate;
    const auto qualified_test = options.qualification_profile.starts_with("test/");
    const auto qualified_candidate =
        current_status.production_candidate_enabled && options.qualification_profile.starts_with("candidate/");
    current_status.qualification_passed = options.qualification_passed && (qualified_test || qualified_candidate);
  }

  fs::path existing_segment(uint64_t segment_id) const {
    const auto active = active_segment_path(directory, segment_id);
    const auto sealed = sealed_segment_path(directory, segment_id);
    const auto active_exists = fs::exists(active);
    const auto sealed_exists = fs::exists(sealed);
    if (active_exists == sealed_exists) {
      throw std::runtime_error(active_exists ? "durable_segment_has_active_and_sealed_names"
                                             : "durable_segment_missing");
    }
    return active_exists ? active : sealed;
  }

  stream_position validate_checkpoint_candidate(const checkpoint &candidate) const {
    std::optional<stream_position> verified_position = std::nullopt;
    for (uint64_t segment_id = candidate.chain_start_segment_id; segment_id <= candidate.segment_id; ++segment_id) {
      const auto segment = existing_segment(segment_id);
      if (segment_id < candidate.segment_id && !segment.filename().string().starts_with("sealed-")) {
        throw std::runtime_error("durable_covered_prior_segment_is_not_sealed");
      }
      const auto limit = segment_id == candidate.segment_id ? candidate.durable_offset : fs::file_size(segment);
      verified_position = verify_segment_prefix(segment, segment_id, options.stream_id, options.container_epoch, limit,
                                                verified_position);
    }
    if (!verified_position.has_value() || !(*verified_position == candidate.position)) {
      throw std::runtime_error("durable_checkpoint_position_mismatch");
    }
    return *verified_position;
  }

  uint64_t max_existing_segment_id() const {
    uint64_t result = 0;
    for (const auto &entry : fs::directory_iterator(directory)) {
      if (!entry.is_regular_file()) {
        continue;
      }
      const auto name = entry.path().filename().string();
      const auto prefix = name.starts_with("active-")   ? std::string("active-")
                          : name.starts_with("sealed-") ? std::string("sealed-")
                                                        : std::string();
      if (prefix.empty() || !name.ends_with(".kfdl")) {
        continue;
      }
      try {
        result = std::max(
            result, static_cast<uint64_t>(std::stoull(name.substr(prefix.size(), name.size() - prefix.size() - 5))));
      } catch (...) {
      }
    }
    return result;
  }

  uint64_t later_segment_bytes(uint64_t after_segment_id) const {
    uint64_t result = 0;
    for (uint64_t segment_id = after_segment_id + 1; segment_id <= max_existing_segment_id(); ++segment_id) {
      for (const auto &path :
           {active_segment_path(directory, segment_id), sealed_segment_path(directory, segment_id)}) {
        if (fs::exists(path)) {
          const auto size = fs::file_size(path);
          result += size > SEGMENT_HEADER_SIZE ? size - SEGMENT_HEADER_SIZE : 0;
        }
      }
    }
    return result;
  }

  uint64_t earlier_segment_bytes(uint64_t before_segment_id) const {
    uint64_t result = 0;
    for (uint64_t segment_id = 1; segment_id < before_segment_id; ++segment_id) {
      for (const auto &path :
           {active_segment_path(directory, segment_id), sealed_segment_path(directory, segment_id)}) {
        if (fs::exists(path)) {
          const auto size = fs::file_size(path);
          result += size > SEGMENT_HEADER_SIZE ? size - SEGMENT_HEADER_SIZE : 0;
        }
      }
    }
    return result;
  }

  void inspect_tail_read_only() {
    const auto max_segment_id = max_existing_segment_id();
    current_status.active_segment_id = max_segment_id;
    if (checkpoint_blocked) {
      current_status.unacknowledged_tail_bytes = later_segment_bytes(0);
      current_status.unacknowledged_tail_integrity =
          current_status.unacknowledged_tail_bytes == 0 ? tail_integrity::None : tail_integrity::Unverifiable;
      return;
    }

    uint64_t chain_start = 1;
    uint64_t earlier_bytes = 0;
    if (current_status.durable_watermark.has_value()) {
      chain_start = durable_checkpoint.chain_start_segment_id;
      earlier_bytes = earlier_segment_bytes(chain_start);
      const auto checkpoint_segment = existing_segment(durable_checkpoint.segment_id);
      const auto checkpoint_size = fs::file_size(checkpoint_segment);
      current_status.unacknowledged_tail_bytes = earlier_bytes + checkpoint_size - durable_checkpoint.durable_offset +
                                                 later_segment_bytes(durable_checkpoint.segment_id);
    } else {
      current_status.unacknowledged_tail_bytes = later_segment_bytes(0);
    }
    if (current_status.unacknowledged_tail_bytes == 0) {
      current_status.unacknowledged_tail_integrity = tail_integrity::None;
      return;
    }
    if (earlier_bytes > 0) {
      current_status.unacknowledged_tail_integrity = tail_integrity::Unverifiable;
      return;
    }
    try {
      std::optional<stream_position> verified_position = std::nullopt;
      for (uint64_t segment_id = chain_start; segment_id <= max_segment_id; ++segment_id) {
        const auto segment = existing_segment(segment_id);
        verified_position = verify_segment_prefix(segment, segment_id, options.stream_id, options.container_epoch,
                                                  fs::file_size(segment), verified_position);
      }
      current_status.unacknowledged_tail_integrity = tail_integrity::CompleteRecords;
    } catch (...) {
      current_status.unacknowledged_tail_integrity = tail_integrity::TornOrCorrupt;
    }
  }

  void create_segment(uint64_t segment_id) {
    const auto path = active_segment_path(directory, segment_id);
    native_file file(path, true);
    file.write(segment_header(segment_id, options.stream_id, options.container_epoch));
    file.sync();
    sync_directory(directory);
    current_status.active_segment_id = segment_id;
    active_path = path;
    active_size = SEGMENT_HEADER_SIZE;
  }

  void prepare_active_segment() {
    const auto max_segment_id = max_existing_segment_id();
    if (checkpoint_blocked) {
      current_status.active_segment_id = max_segment_id;
      current_status.unacknowledged_tail_bytes = later_segment_bytes(0);
      return;
    }
    if (current_status.durable_watermark.has_value()) {
      std::optional<stream_position> verified_position = std::nullopt;
      fs::path checkpoint_segment;
      for (uint64_t segment_id = durable_checkpoint.chain_start_segment_id; segment_id <= durable_checkpoint.segment_id;
           ++segment_id) {
        const auto segment = existing_segment(segment_id);
        if (segment_id < durable_checkpoint.segment_id && !segment.filename().string().starts_with("sealed-")) {
          throw std::runtime_error("durable_covered_prior_segment_is_not_sealed");
        }
        const auto limit =
            segment_id == durable_checkpoint.segment_id ? current_status.durable_offset : fs::file_size(segment);
        verified_position = verify_segment_prefix(segment, segment_id, options.stream_id, options.container_epoch,
                                                  limit, verified_position);
        if (segment_id == durable_checkpoint.segment_id) {
          checkpoint_segment = segment;
        }
      }
      const auto size = fs::file_size(checkpoint_segment);
      if (size < current_status.durable_offset) {
        throw std::runtime_error("durable_checkpoint_ahead_of_segment");
      }
      if (!verified_position.has_value() || !(*verified_position == durable_checkpoint.position)) {
        throw std::runtime_error("durable_checkpoint_position_mismatch");
      }
      const auto checkpoint_or_later_tail =
          size - current_status.durable_offset + later_segment_bytes(durable_checkpoint.segment_id);
      current_status.unacknowledged_tail_bytes =
          earlier_segment_bytes(durable_checkpoint.chain_start_segment_id) + checkpoint_or_later_tail;
      if (checkpoint_or_later_tail > 0 || checkpoint_segment.filename().string().starts_with("sealed-")) {
        create_segment(std::max(max_segment_id, durable_checkpoint.segment_id) + 1);
        return;
      }
      active_path = checkpoint_segment;
      active_size = size;
      return;
    }
    const auto first = active_segment_path(directory, 1);
    if (max_segment_id > 0) {
      current_status.unacknowledged_tail_bytes = later_segment_bytes(0);
    }
    if (current_status.unacknowledged_tail_bytes > 0) {
      create_segment(max_segment_id + 1);
      chain_start_segment_id = current_status.active_segment_id;
    } else if (!fs::exists(first)) {
      create_segment(max_segment_id > 0 ? max_segment_id + 1 : 1);
      chain_start_segment_id = current_status.active_segment_id;
    } else {
      active_path = first;
      active_size = fs::file_size(first);
      chain_start_segment_id = 1;
    }
  }

  std::vector<durable_record> read_durable_records() const {
    std::lock_guard lock(mutex);
    std::vector<durable_record> records;
    if (!current_status.durable_watermark.has_value()) {
      return records;
    }
    std::optional<stream_position> verified_position = std::nullopt;
    for (uint64_t segment_id = durable_checkpoint.chain_start_segment_id; segment_id <= durable_checkpoint.segment_id;
         ++segment_id) {
      const auto segment = existing_segment(segment_id);
      const auto limit =
          segment_id == durable_checkpoint.segment_id ? durable_checkpoint.durable_offset : fs::file_size(segment);
      verified_position = verify_segment_prefix(segment, segment_id, options.stream_id, options.container_epoch, limit,
                                                verified_position, &records);
    }
    if (!verified_position.has_value() || !(*verified_position == durable_checkpoint.position)) {
      throw std::runtime_error("durable_inspection_frontier_mismatch");
    }
    return records;
  }

  ingest_status status() const {
    std::lock_guard lock(mutex);
    return current_status;
  }

  void maybe_rollover() {
    if (current_status.pending_records != 0 || active_size < options.segment_max_bytes) {
      return;
    }
    const auto sealed = sealed_segment_path(directory, current_status.active_segment_id);
    replace_file(active_path, sealed);
    sync_directory(directory);
    create_segment(current_status.active_segment_id + 1);
  }

  void validate_service_fence(const lease &service_owner) const {
    validate_owner(service_owner, scope::DataRootService, root);
  }

  void append(const stream_position &position, int32_t carrier_type, const durable_frame_context &frame,
              const void *payload, size_t payload_size, const lease &service_owner, const evidence &writer_generation) {
    std::lock_guard lock(mutex);
    if (options.read_only) {
      throw std::logic_error("durable_ingest_read_only");
    }
    if (!current_status.available) {
      throw std::logic_error("durable_ingest_is_unavailable");
    }
    if (append_poisoned) {
      throw std::logic_error("durable_ingest_requires_reopen_after_unknown_append");
    }
    validate_service_fence(service_owner);
    const auto active_writer = yijinjing::ownership::inspect_active_stream_writer(root, options.writer_resource_id);
    if (!writer_generation.owned || writer_generation.ownership_scope != scope::StreamWriter ||
        normalized_root(writer_generation.data_root) != root ||
        writer_generation.resource_id != options.writer_resource_id ||
        writer_generation.generation != active_writer.generation ||
        writer_generation.fence_token != active_writer.fence_token) {
      throw std::logic_error("durable_writer_generation_stale");
    }
    if (position.stream_id != options.stream_id || position.container_epoch != options.container_epoch ||
        position.sequence == 0 || position.frame_uid == 0 || (payload == nullptr && payload_size != 0)) {
      throw std::invalid_argument("durable_position_or_payload_invalid");
    }
    const auto expected = pending_position.has_value() ? pending_position->sequence + 1
                          : current_status.durable_watermark.has_value()
                              ? current_status.durable_watermark->sequence + 1
                              : position.sequence;
    if (position.sequence != expected) {
      throw std::logic_error("durable_position_gap");
    }
    maybe_rollover();
    const auto append_start_offset = active_size;
    try {
      inject(ingest_fault_point::BeforeRecordWrite);
      const auto record = encode_record(position, carrier_type, frame, payload, payload_size,
                                        service_owner.status().generation, writer_generation.generation);
      native_file file(active_path, false);
      file.write(record);
      inject(ingest_fault_point::AfterRecordWrite);
      active_size += record.size();
      pending_position = position;
      pending_owner_generation = service_owner.status().generation;
      pending_writer_generation = writer_generation.generation;
      pending_owner_fence = service_owner.status().fence_token;
      pending_writer_fence = writer_generation.fence_token;
      ++current_status.pending_records;
      current_status.pending_bytes += record.size();
      current_status.last_error = ingest_error::None;
      current_status.last_error_message.clear();
    } catch (const std::system_error &error) {
      current_status.last_error = ingest_error::IoError;
      current_status.last_error_message = error.what();
      std::error_code size_error;
      const auto observed_size = fs::file_size(active_path, size_error);
      if (!size_error && observed_size > append_start_offset) {
        current_status.unacknowledged_tail_bytes += observed_size - append_start_offset;
        active_size = observed_size;
        append_poisoned = true;
        current_status.available = false;
        current_status.requires_reopen = true;
        current_status.last_error = ingest_error::AppendOutcomeUnknown;
      }
      throw;
    } catch (const std::exception &error) {
      current_status.last_error = ingest_error::InjectedFault;
      current_status.last_error_message = error.what();
      std::error_code size_error;
      const auto observed_size = fs::file_size(active_path, size_error);
      if (!size_error && observed_size > append_start_offset) {
        current_status.unacknowledged_tail_bytes += observed_size - append_start_offset;
        active_size = observed_size;
        append_poisoned = true;
        current_status.available = false;
        current_status.requires_reopen = true;
        current_status.last_error = ingest_error::AppendOutcomeUnknown;
      }
      throw;
    }
  }

  barrier_result barrier(uint64_t request_id, durability_profile profile, const durability_request *expected_request,
                         const lease &service_owner, const lease *writer_owner, barrier_options barrier_options) {
    std::lock_guard lock(mutex);
    const auto barrier_started_at = yijinjing::time::now_in_nano();
    ++current_status.barrier_attempt_count;
    barrier_result result;
    result.receipt.request_id = request_id;
    result.receipt.requested_profile = profile;
    if (expected_request != nullptr) {
      result.receipt.position = expected_request->position;
    }
    result.receipt.status = receipt_status::Failed;
    result.receipt.error = durability_error_code::InvalidRequest;
    if (options.read_only) {
      result.error = ingest_error::InvalidArgument;
      result.message = "durable_ingest_read_only";
      ++current_status.barrier_terminal_failure_count;
      result.status = current_status;
      return result;
    }
    const auto set_current_error = [&](ingest_error error, const std::string &message) {
      current_status.last_error = error;
      current_status.last_error_message = message;
    };
    const auto complete_result = [&]() {
      switch (result.receipt.status) {
      case receipt_status::Succeeded:
        ++current_status.barrier_succeeded_count;
        break;
      case receipt_status::Failed:
        ++current_status.barrier_terminal_failure_count;
        break;
      case receipt_status::Unknown:
        ++current_status.barrier_unknown_count;
        break;
      }
      result.status = current_status;
      return result;
    };
    const auto deadline_expired = [&]() {
      return barrier_options.deadline_at_ns > 0 && yijinjing::time::now_in_nano() >= barrier_options.deadline_at_ns;
    };
    const auto timeout_result = [&](bool barrier_io_started) {
      current_status.last_error = ingest_error::Timeout;
      current_status.last_error_message =
          barrier_io_started ? "durable_barrier_timeout_outcome_unknown" : "durable_barrier_timeout_before_io";
      result.error = ingest_error::Timeout;
      result.receipt.error = durability_error_code::Timeout;
      result.receipt.status = barrier_io_started ? receipt_status::Unknown : receipt_status::Failed;
      result.message = current_status.last_error_message;
      return complete_result();
    };
    if (request_id == 0) {
      result.error = ingest_error::InvalidArgument;
      result.message = "durable_request_id_zero";
      set_current_error(result.error, result.message);
      return complete_result();
    }
    const auto completed = completed_requests.find(request_id);
    if (completed != completed_requests.end()) {
      if (completed->second.requested_profile == profile &&
          (!pending_position.has_value() || *pending_position == completed->second.position)) {
        result.receipt = completed->second;
        if (expected_request != nullptr &&
            (!(completed->second.position == expected_request->position) ||
             completed->second.requested_profile != expected_request->requested_profile)) {
          result.receipt.error = durability_error_code::ConflictingRequestId;
          result.receipt.status = receipt_status::Failed;
          result.error = ingest_error::InvalidArgument;
          result.message = "durable_request_id_conflict";
          set_current_error(result.error, result.message);
          return complete_result();
        }
        result.receipt = completed->second;
        ++current_status.reconciled_request_count;
        return complete_result();
      }
      result.receipt.error = durability_error_code::ConflictingRequestId;
      result.error = ingest_error::InvalidArgument;
      result.message = "durable_request_id_conflict";
      set_current_error(result.error, result.message);
      return complete_result();
    }
    if (!current_status.available || append_poisoned) {
      result.error = append_poisoned ? ingest_error::AppendOutcomeUnknown : ingest_error::ServiceUnavailable;
      result.receipt.error = durability_error_code::ServiceUnavailable;
      result.receipt.status = receipt_status::Unknown;
      result.message =
          append_poisoned ? "durable_ingest_requires_reopen_after_unknown_append" : "durable_ingest_is_unavailable";
      set_current_error(result.error, result.message);
      return complete_result();
    }
    if (!pending_position.has_value()) {
      result.error = ingest_error::InvalidArgument;
      result.message = "durable_barrier_without_pending_record";
      set_current_error(result.error, result.message);
      return complete_result();
    }
    if (expected_request != nullptr && !(*pending_position == expected_request->position)) {
      result.receipt.error = durability_error_code::PositionEpochMismatch;
      result.error = ingest_error::PositionMismatch;
      result.message = "durable_request_position_does_not_match_pending_frontier";
      set_current_error(result.error, result.message);
      return complete_result();
    }
    result.receipt.position = *pending_position;
    const auto commit_barrier = [&]() -> barrier_result {
      validate_service_fence(service_owner);
      if (service_owner.status().generation != pending_owner_generation ||
          service_owner.status().fence_token != pending_owner_fence) {
        throw std::logic_error("durable_pending_fence_changed");
      }
      if (writer_owner != nullptr &&
          (!writer_owner->owns() || writer_owner->status().generation != pending_writer_generation ||
           writer_owner->status().fence_token != pending_writer_fence)) {
        throw std::logic_error("durable_pending_writer_fence_changed");
      }
      if ((profile != durability_profile::DurableGroup && profile != durability_profile::DurableSync) ||
          !current_status.qualification_passed) {
        result.error = ingest_error::UnsupportedProfile;
        result.receipt.error = durability_error_code::UnsupportedProfile;
        result.message = "durability profile is not qualified for this local storage envelope";
        set_current_error(result.error, result.message);
        return complete_result();
      }
      if (deadline_expired()) {
        return timeout_result(false);
      }

      inject(ingest_fault_point::BeforeDataSync);
      if (deadline_expired()) {
        return timeout_result(false);
      }
      {
        native_file file(active_path, false);
        file.sync();
      }
      inject(ingest_fault_point::AfterDataSync);
      if (deadline_expired()) {
        return timeout_result(true);
      }

      checkpoint next;
      next.request_id = request_id;
      next.barrier_id = current_status.last_barrier_id + 1;
      next.chain_start_segment_id = chain_start_segment_id;
      next.segment_id = current_status.active_segment_id;
      next.durable_offset = active_size;
      next.position = *pending_position;
      next.owner_generation = pending_owner_generation;
      next.writer_generation = pending_writer_generation;
      next.owner_fence = pending_owner_fence;
      next.writer_fence = pending_writer_fence;
      next.qualification_profile = options.qualification_profile;
      next.durability_profile = durability_profile_name(profile);
      durability_receipt completed_receipt = result.receipt;
      completed_receipt.achieved_profile = profile;
      completed_receipt.durable_watermark = next.position;
      completed_receipt.barrier_id = next.barrier_id;
      completed_receipt.qualification_profile = options.qualification_profile;
      completed_receipt.completed_at = yijinjing::time::now_in_nano();
      completed_receipt.status = receipt_status::Succeeded;
      completed_receipt.error = durability_error_code::None;
      next.completed_requests = completed_requests;
      next.completed_requests.emplace(request_id, completed_receipt);
      const auto slot = next.barrier_id % 2;
      const auto final_path = directory / ("checkpoint." + std::to_string(slot));
      const auto temporary = directory / ("checkpoint." + std::to_string(slot) + ".next");
      inject(ingest_fault_point::BeforeCheckpointWrite);
      if (deadline_expired()) {
        return timeout_result(true);
      }
      {
        native_file file(temporary, true);
        file.write(encode_checkpoint(next));
        file.sync();
      }
      inject(ingest_fault_point::BeforeCheckpointRename);
      if (deadline_expired()) {
        return timeout_result(true);
      }
      replace_file(temporary, final_path);
      inject(ingest_fault_point::AfterCheckpointRename);
      if (deadline_expired()) {
        return timeout_result(true);
      }
      inject(ingest_fault_point::BeforeDirectorySync);
      if (deadline_expired()) {
        return timeout_result(true);
      }
      sync_directory(directory);
      inject(ingest_fault_point::AfterDirectorySync);

      durable_checkpoint = next;
      current_status.durable_offset = next.durable_offset;
      current_status.durable_chain_start_segment_id = next.chain_start_segment_id;
      current_status.durable_segment_id = next.segment_id;
      current_status.last_barrier_id = next.barrier_id;
      current_status.durable_watermark = next.position;
      current_status.pending_records = 0;
      current_status.pending_bytes = 0;
      current_status.last_barrier_duration_ns =
          static_cast<uint64_t>(yijinjing::time::now_in_nano() - barrier_started_at);
      current_status.last_error = ingest_error::None;
      current_status.last_error_message.clear();
      pending_position.reset();
      result.receipt = completed_receipt;
      completed_requests = next.completed_requests;
      current_status.persisted_request_count = completed_requests.size();
      result.error = ingest_error::None;
      return complete_result();
    };
    auto outcome = capture_ingest_exception(commit_barrier).transform_error(classify_durability_failure);
    if (outcome) {
      return *outcome;
    }
    const ingest_failure &failure = outcome.error();
    current_status.last_error = failure.error;
    current_status.last_error_message = failure.message;
    result.error = failure.error;
    result.receipt.error = failure.code;
    result.message = failure.message;
    result.receipt.status = receipt_status::Unknown;
    return complete_result();
  }

  receipt_reconciliation_view reconcile(const durability_request &request) {
    std::lock_guard lock(mutex);
    receipt_reconciliation_view result;
    result.request_id = request.request_id;
    if (request.request_id == 0) {
      result.state = reconciliation_state_name(reconciliation_state::TerminalFailure);
      result.error = durability_error_name(durability_error_code::InvalidRequest);
      result.message = "durable_request_id_zero";
      return result;
    }
    const auto completed = completed_requests.find(request.request_id);
    if (completed == completed_requests.end()) {
      ++current_status.reconciliation_unknown_count;
      result.state = reconciliation_state_name(reconciliation_state::Unknown);
      result.error = durability_error_name(durability_error_code::OutcomeUnknown);
      result.message = "request_id_not_present_in_checkpoint_covered_receipt_index";
      return result;
    }
    if (!(completed->second.position == request.position) ||
        completed->second.requested_profile != request.requested_profile) {
      result.state = reconciliation_state_name(reconciliation_state::TerminalFailure);
      result.error = durability_error_name(durability_error_code::ConflictingRequestId);
      result.message = "durable_request_id_conflict";
      return result;
    }
    ++current_status.reconciled_request_count;
    result.state = reconciliation_state_name(reconciliation_state::Reconciled);
    result.recovered = checkpoint_loaded;
    result.receipt = make_receipt_view(completed->second);
    result.error = durability_error_name(durability_error_code::None);
    result.message =
        checkpoint_loaded ? "receipt_reconciled_from_durable_checkpoint" : "receipt_reconciled_from_live_service";
    return result;
  }

  ingest_options options;
  std::string root;
  fs::path directory;
  ingest_fault_injector fault_injector;
  ingest_status current_status = {};
  checkpoint durable_checkpoint = {};
  fs::path active_path;
  uint64_t active_size = SEGMENT_HEADER_SIZE;
  std::optional<stream_position> pending_position = std::nullopt;
  uint64_t pending_owner_generation = 0;
  uint64_t pending_writer_generation = 0;
  std::string pending_owner_fence = {};
  std::string pending_writer_fence = {};
  uint64_t chain_start_segment_id = 1;
  bool checkpoint_blocked = false;
  bool checkpoint_loaded = false;
  bool append_poisoned = false;
  std::map<uint64_t, durability_receipt> completed_requests = {};
  mutable std::mutex mutex;
};

durable_ingest_log::durable_ingest_log(ingest_options options, ingest_fault_injector fault_injector)
    : impl_(std::make_unique<impl>(std::move(options), std::move(fault_injector))) {}
durable_ingest_log::~durable_ingest_log() = default;

void durable_ingest_log::append(const stream_position &position, int32_t carrier_type, const void *payload,
                                size_t payload_size, const lease &service_owner, const lease &writer_owner) {
  append(position, carrier_type, durable_frame_context{}, payload, payload_size, service_owner, writer_owner);
}

void durable_ingest_log::append(const stream_position &position, int32_t carrier_type,
                                const durable_frame_context &frame, const void *payload, size_t payload_size,
                                const lease &service_owner, const lease &writer_owner) {
  impl_->append(position, carrier_type, frame, payload, payload_size, service_owner, writer_owner.status());
}

void durable_ingest_log::append(const stream_position &position, int32_t carrier_type, const void *payload,
                                size_t payload_size, const lease &service_owner, const evidence &writer_generation) {
  append(position, carrier_type, durable_frame_context{}, payload, payload_size, service_owner, writer_generation);
}

void durable_ingest_log::append(const stream_position &position, int32_t carrier_type,
                                const durable_frame_context &frame, const void *payload, size_t payload_size,
                                const lease &service_owner, const evidence &writer_generation) {
  impl_->append(position, carrier_type, frame, payload, payload_size, service_owner, writer_generation);
}

barrier_result durable_ingest_log::barrier(uint64_t request_id, durability_profile profile, const lease &service_owner,
                                           const lease &writer_owner) {
  return barrier(request_id, profile, service_owner, writer_owner, {});
}

barrier_result durable_ingest_log::barrier(uint64_t request_id, durability_profile profile, const lease &service_owner,
                                           const lease &writer_owner, barrier_options options) {
  return impl_->barrier(request_id, profile, nullptr, service_owner, &writer_owner, options);
}

barrier_result durable_ingest_log::barrier(uint64_t request_id, durability_profile profile,
                                           const lease &service_owner) {
  return barrier(request_id, profile, service_owner, barrier_options{});
}

barrier_result durable_ingest_log::barrier(uint64_t request_id, durability_profile profile, const lease &service_owner,
                                           barrier_options options) {
  return impl_->barrier(request_id, profile, nullptr, service_owner, nullptr, options);
}

barrier_result durable_ingest_log::barrier(const durability_request &request, const lease &service_owner,
                                           const lease &writer_owner, barrier_options options) {
  return impl_->barrier(request.request_id, request.requested_profile, &request, service_owner, &writer_owner, options);
}

barrier_result durable_ingest_log::barrier(const durability_request &request, const lease &service_owner,
                                           barrier_options options) {
  return impl_->barrier(request.request_id, request.requested_profile, &request, service_owner, nullptr, options);
}

receipt_reconciliation_view durable_ingest_log::reconcile(const durability_request &request) {
  return impl_->reconcile(request);
}

ingest_status durable_ingest_log::status() const { return impl_->status(); }

std::vector<durable_record> durable_ingest_log::read_durable_records() const { return impl_->read_durable_records(); }

const char *ingest_error_name(ingest_error error) noexcept {
  switch (error) {
  case ingest_error::None:
    return "none";
  case ingest_error::InvalidArgument:
    return "invalid_argument";
  case ingest_error::PositionMismatch:
    return "position_mismatch";
  case ingest_error::PositionGap:
    return "position_gap";
  case ingest_error::FencingLost:
    return "fencing_lost";
  case ingest_error::UnsupportedProfile:
    return "unsupported_profile";
  case ingest_error::Timeout:
    return "timeout";
  case ingest_error::ServiceUnavailable:
    return "service_unavailable";
  case ingest_error::AppendOutcomeUnknown:
    return "append_outcome_unknown";
  case ingest_error::IoError:
    return "io_error";
  case ingest_error::CheckpointCorrupt:
    return "checkpoint_corrupt";
  case ingest_error::InjectedFault:
    return "injected_fault";
  }
  return "unknown";
}

const char *reconciliation_state_name(reconciliation_state state) noexcept {
  switch (state) {
  case reconciliation_state::Reconciled:
    return "reconciled";
  case reconciliation_state::Unknown:
    return "unknown";
  case reconciliation_state::TerminalFailure:
    return "terminal_failure";
  }
  return "unknown";
}

receipt_reconciliation_view reconcile_durable_receipt(ingest_options options, const durability_request &request) {
  options.read_only = true;
  durable_ingest_log log(std::move(options));
  return log.reconcile(request);
}

} // namespace kungfu::runtime::durability
