// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/content_store.h>

#include <atomic>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <system_error>
#include <utility>

#include <kungfu/yijinjing/storage/content_hash.h>

#ifdef _WINDOWS
#include <io.h>
#include <process.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace kungfu::yijinjing::storage {

namespace {

namespace fs = std::filesystem;

constexpr const char *FILE_STORE_PROFILE = "yijinjing-file/v1";
constexpr const char *TEMP_DIR_NAME = "tmp";
constexpr size_t SHA256_HEX_LENGTH = 64;
constexpr size_t DIGEST_PREFIX_LENGTH = 2;
constexpr size_t MAX_NAMESPACE_LENGTH = 64;

bool is_lower_hex(const std::string &value) {
  for (const char c : value) {
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) {
      return false;
    }
  }
  return !value.empty();
}

int current_pid() {
#ifdef _WINDOWS
  return _getpid();
#else
  return static_cast<int>(::getpid());
#endif
}

uint64_t next_temp_sequence() {
  static std::atomic<uint64_t> sequence{0};
  return sequence.fetch_add(1, std::memory_order_relaxed) + 1;
}

bool flush_to_disk(std::FILE *file) {
  if (std::fflush(file) != 0) {
    return false;
  }
#ifdef _WINDOWS
  return _commit(_fileno(file)) == 0;
#else
  return ::fsync(fileno(file)) == 0;
#endif
}

// Publication is only durable once the directory entry is too; best-effort on
// platforms without directory fsync.
void sync_directory(const fs::path &dir) {
#ifndef _WINDOWS
  const int fd = ::open(dir.c_str(), O_RDONLY);
  if (fd >= 0) {
    ::fsync(fd);
    ::close(fd);
  }
#else
  (void)dir;
#endif
}

// Validate a caller-supplied digest against the store's algorithm without
// throwing across the contract; failures land in the declared error taxonomy.
content_store_error check_digest(const content_hash &hash, const std::string &store_algorithm, std::string &message) {
  std::string normalized;
  try {
    normalized = normalize_content_hash_algorithm(hash.algorithm);
  } catch (const std::invalid_argument &e) {
    message = e.what();
    return content_store_error::InvalidArgument;
  }
  if (normalized != store_algorithm) {
    message = "digest algorithm " + normalized + " does not match store algorithm " + store_algorithm;
    return content_store_error::InvalidArgument;
  }
  if (hash.value.size() != SHA256_HEX_LENGTH || !is_lower_hex(hash.value)) {
    message = "digest value must be " + std::to_string(SHA256_HEX_LENGTH) + " lowercase hex chars";
    return content_store_error::InvalidArgument;
  }
  return content_store_error::Ok;
}

content_store_error read_file_bytes(const fs::path &path, std::string &bytes, std::string &message) {
  std::error_code ec;
  if (!fs::exists(path, ec)) {
    message = "no object at " + path.string();
    return content_store_error::NotFound;
  }
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    message = "cannot open " + path.string();
    return content_store_error::IoError;
  }
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  if (stream.bad()) {
    message = "read failed for " + path.string();
    return content_store_error::IoError;
  }
  bytes = buffer.str();
  return content_store_error::Ok;
}

} // namespace

const char *content_store_error_name(content_store_error error) {
  switch (error) {
  case content_store_error::Ok:
    return "ok";
  case content_store_error::InvalidArgument:
    return "invalid_argument";
  case content_store_error::HashMismatch:
    return "hash_mismatch";
  case content_store_error::NotFound:
    return "not_found";
  case content_store_error::CorruptObject:
    return "corrupt_object";
  case content_store_error::SizeLimitExceeded:
    return "size_limit_exceeded";
  case content_store_error::IoError:
    return "io_error";
  }
  return "unknown";
}

bool is_valid_content_namespace(const std::string &content_namespace) {
  if (content_namespace.empty() || content_namespace.size() > MAX_NAMESPACE_LENGTH) {
    return false;
  }
  for (const char c : content_namespace) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

file_content_store::file_content_store(std::string root_dir, file_content_store_options options)
    : root_dir_(std::move(root_dir)), options_(std::move(options)) {
  if (root_dir_.empty()) {
    throw std::invalid_argument("file_content_store: root_dir is empty");
  }
  // fail fast at construction instead of per operation
  options_.hash_algorithm = normalize_content_hash_algorithm(options_.hash_algorithm);
}

content_store_capabilities file_content_store::capabilities() const {
  content_store_capabilities caps{};
  caps.profile = FILE_STORE_PROFILE;
  caps.hash_algorithm = options_.hash_algorithm;
  caps.max_object_size = options_.max_object_size;
  caps.atomic_put_if_absent = true;
  caps.verified_reads = true;
  caps.durability = options_.fsync_on_publish ? "fsync-on-publish" : "os-buffered";
  caps.visibility = "publish-then-visible";
  caps.concurrency = "multi-writer-single-node";
  return caps;
}

std::string file_content_store::object_path(const std::string &content_namespace, const content_hash &hash) const {
  if (!is_valid_content_namespace(content_namespace)) {
    throw std::invalid_argument("invalid content namespace: " + content_namespace);
  }
  std::string message;
  if (check_digest(hash, options_.hash_algorithm, message) != content_store_error::Ok) {
    throw std::invalid_argument(message);
  }
  const auto path = fs::path(root_dir_) / content_namespace / hash.value.substr(0, DIGEST_PREFIX_LENGTH) / hash.value;
  return path.string();
}

content_store_result file_content_store::put_if_absent(const std::string &content_namespace, const void *data,
                                                       size_t size, const content_hash &expected) {
  content_store_result result{};
  if (!is_valid_content_namespace(content_namespace)) {
    result.error = content_store_error::InvalidArgument;
    result.message = "invalid content namespace: " + content_namespace;
    return result;
  }
  if (size > 0 && data == nullptr) {
    result.error = content_store_error::InvalidArgument;
    result.message = "null data with non-zero size";
    return result;
  }
  if (options_.max_object_size > 0 && size > options_.max_object_size) {
    result.error = content_store_error::SizeLimitExceeded;
    result.message = "object of " + std::to_string(size) + " bytes exceeds declared limit of " +
                     std::to_string(options_.max_object_size);
    return result;
  }
  const auto digest = compute_content_hash(data, size, options_.hash_algorithm);
  if (!expected.empty()) {
    result.error = check_digest(expected, options_.hash_algorithm, result.message);
    if (result.error != content_store_error::Ok) {
      return result;
    }
    if (expected.value != digest.value) {
      result.error = content_store_error::HashMismatch;
      result.message = "bytes hash to " + digest.value + ", caller declared " + expected.value;
      return result;
    }
  }
  result.hash = digest;
  result.byte_length = size;

  const fs::path final_path = object_path(content_namespace, digest);
  std::error_code ec;
  if (fs::exists(final_path, ec)) {
    const auto stored_size = fs::file_size(final_path, ec);
    if (ec) {
      result.error = content_store_error::IoError;
      result.message = "cannot stat existing object: " + ec.message();
      return result;
    }
    if (stored_size != size) {
      result.error = content_store_error::CorruptObject;
      result.message = "existing object holds " + std::to_string(stored_size) + " bytes, content is " +
                       std::to_string(size) + " bytes; run verify";
      return result;
    }
    result.existed = true;
    return result;
  }

  const fs::path temp_dir = fs::path(root_dir_) / content_namespace / TEMP_DIR_NAME;
  fs::create_directories(temp_dir, ec);
  if (ec) {
    result.error = content_store_error::IoError;
    result.message = "cannot create temp dir: " + ec.message();
    return result;
  }
  fs::create_directories(final_path.parent_path(), ec);
  if (ec) {
    result.error = content_store_error::IoError;
    result.message = "cannot create object dir: " + ec.message();
    return result;
  }

  const auto temp_name =
      digest.value.substr(0, 16) + "." + std::to_string(current_pid()) + "." + std::to_string(next_temp_sequence());
  const fs::path temp_path = temp_dir / temp_name;
  const auto discard_temp = [&temp_path]() {
    std::error_code ignored;
    fs::remove(temp_path, ignored);
  };

  std::FILE *file = std::fopen(temp_path.string().c_str(), "wb");
  if (file == nullptr) {
    result.error = content_store_error::IoError;
    result.message = "cannot open temp file " + temp_path.string();
    return result;
  }
  if (size > 0 && std::fwrite(data, 1, size, file) != size) {
    std::fclose(file);
    discard_temp();
    result.error = content_store_error::IoError;
    result.message = "short write to temp file";
    return result;
  }
  if (options_.fsync_on_publish && !flush_to_disk(file)) {
    std::fclose(file);
    discard_temp();
    result.error = content_store_error::IoError;
    result.message = "cannot flush temp file to disk";
    return result;
  }
  if (std::fclose(file) != 0) {
    discard_temp();
    result.error = content_store_error::IoError;
    result.message = "cannot close temp file";
    return result;
  }

  fs::rename(temp_path, final_path, ec);
  if (ec) {
    // Windows refuses to rename onto an existing file: a concurrent writer
    // published the identical bytes first, which under content identity is
    // this put succeeding as a dedup hit.
    std::error_code probe;
    if (fs::exists(final_path, probe)) {
      discard_temp();
      result.existed = true;
      return result;
    }
    discard_temp();
    result.error = content_store_error::IoError;
    result.message = "cannot publish object: " + ec.message();
    return result;
  }
  if (options_.fsync_on_publish) {
    sync_directory(final_path.parent_path());
  }
  return result;
}

bool file_content_store::has(const std::string &content_namespace, const content_hash &hash) const {
  if (!is_valid_content_namespace(content_namespace)) {
    return false;
  }
  std::string message;
  if (check_digest(hash, options_.hash_algorithm, message) != content_store_error::Ok) {
    return false;
  }
  std::error_code ec;
  return fs::exists(object_path(content_namespace, hash), ec);
}

content_store_result file_content_store::verify(const std::string &content_namespace, const content_hash &hash) const {
  content_store_result result{};
  if (!is_valid_content_namespace(content_namespace)) {
    result.error = content_store_error::InvalidArgument;
    result.message = "invalid content namespace: " + content_namespace;
    return result;
  }
  result.error = check_digest(hash, options_.hash_algorithm, result.message);
  if (result.error != content_store_error::Ok) {
    return result;
  }
  result.hash = make_content_hash(hash.value, options_.hash_algorithm);
  std::string bytes;
  result.error = read_file_bytes(object_path(content_namespace, result.hash), bytes, result.message);
  if (result.error != content_store_error::Ok) {
    return result;
  }
  result.byte_length = bytes.size();
  if (!verify_content_hash(bytes, result.hash)) {
    result.error = content_store_error::CorruptObject;
    result.message = "stored bytes do not hash to " + result.hash.value;
    return result;
  }
  return result;
}

content_get_result file_content_store::get(const std::string &content_namespace, const content_hash &hash) const {
  content_get_result result{};
  if (!is_valid_content_namespace(content_namespace)) {
    result.error = content_store_error::InvalidArgument;
    result.message = "invalid content namespace: " + content_namespace;
    return result;
  }
  result.error = check_digest(hash, options_.hash_algorithm, result.message);
  if (result.error != content_store_error::Ok) {
    return result;
  }
  result.hash = make_content_hash(hash.value, options_.hash_algorithm);
  std::string bytes;
  result.error = read_file_bytes(object_path(content_namespace, result.hash), bytes, result.message);
  if (result.error != content_store_error::Ok) {
    return result;
  }
  if (!verify_content_hash(bytes, result.hash)) {
    result.error = content_store_error::CorruptObject;
    result.message = "stored bytes do not hash to " + result.hash.value;
    return result;
  }
  result.bytes = std::move(bytes);
  return result;
}

} // namespace kungfu::yijinjing::storage
