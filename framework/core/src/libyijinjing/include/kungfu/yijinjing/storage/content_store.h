// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_CONTENT_STORE_H
#define KUNGFU_YIJINJING_STORAGE_CONTENT_STORE_H

#include <cstddef>
#include <cstdint>
#include <string>

#include <kungfu/yijinjing/storage/common.h>

namespace kungfu::yijinjing::storage {

// KF-ADR-019f86da-4f90-738c-b372-e509976f69ff: the immutable content-addressed store is a runtime fact-ledger
// primitive. This is the one first-class contract for write-once bodies
// addressed by content hash -- manifests, snapshots, artifacts, arbitrary
// blobs are uses of this store plus the journal, never bespoke per-scenario
// stores. The interface belongs to yijinjing; concrete engine backends live
// in the runtime/provider layer above and are injected through it, so callers
// never program against a concrete engine. The kernel ships one
// dependency-free default backend (file_content_store below).
//
// Content identity: the key of an object is the hash of its bytes under the
// store's declared algorithm. Two writers proposing the same hash must
// propose identical bytes, so put-if-absent has no logical overwrite
// conflict; the backend still owns atomic publication, durability and
// visibility, which it declares through content_store_capabilities.

// Declared error categories. Every operation reports exactly one of these;
// a backend must map its internal failures into this taxonomy instead of
// leaking engine-specific errors through the contract.
enum class content_store_error : uint8_t {
  Ok = 0,
  InvalidArgument,   // malformed namespace or digest, unsupported algorithm
  HashMismatch,      // bytes do not hash to the digest the caller declared
  NotFound,          // no object under this digest in the namespace
  CorruptObject,     // stored bytes fail verification (torn or tampered)
  SizeLimitExceeded, // object larger than the backend's declared limit
  IoError,           // backend I/O failure (open/write/publish/read)
};

const char *content_store_error_name(content_store_error error);

// Capability discovery (KF-ADR-019f86da-4f90-738c-b372-e509976f69ff decisions 3 and 7): a backend declares its
// profile honestly so embedded and service-fronted implementations can differ
// without smuggling local assumptions through the shared vocabulary. Callers
// that need a guarantee check it here instead of assuming it.
struct content_store_capabilities {
  std::string profile = {}; // backend identity, e.g. "yijinjing-file/v1"
  std::string hash_algorithm = CONTENT_HASH_ALGORITHM_SHA256;
  uint64_t max_object_size = 0; // declared put limit in bytes; 0 = unbounded
  bool atomic_put_if_absent = false;
  bool verified_reads = false;  // get() re-hashes bytes before returning them
  std::string durability = {};  // e.g. "fsync-on-publish", "os-buffered"
  std::string visibility = {};  // e.g. "publish-then-visible"
  std::string concurrency = {}; // e.g. "multi-writer-single-node"
};

struct content_store_result {
  content_store_error error = content_store_error::Ok;
  content_hash hash = {};   // the content identity, set on success
  uint64_t byte_length = 0; // size of the object the result refers to
  bool existed = false;     // put_if_absent: the object was already present
  std::string message = {}; // human-readable diagnostic, edge only

  [[nodiscard]] bool ok() const { return error == content_store_error::Ok; }
};

struct content_get_result {
  content_store_error error = content_store_error::Ok;
  content_hash hash = {};
  std::string bytes = {}; // filled only when error == Ok
  std::string message = {};

  [[nodiscard]] bool ok() const { return error == content_store_error::Ok; }
};

// Namespaces partition one store into independent object families (payloads,
// snapshots, ...) without changing content identity inside each family.
// A valid namespace is 1..64 chars of [a-z0-9_-].
[[nodiscard]] bool is_valid_content_namespace(const std::string &content_namespace);

// Validate a caller-supplied digest against a store's normalized algorithm
// without throwing across the contract; failures land in the declared error
// taxonomy. Shared by every backend so digest hygiene stays identical.
[[nodiscard]] content_store_error validate_content_digest(const content_hash &hash, const std::string &store_algorithm,
                                                          std::string &message);

class content_store {
public:
  virtual ~content_store() = default;

  [[nodiscard]] virtual content_store_capabilities capabilities() const = 0;

  // Publish bytes under their content hash if no object with that identity
  // exists yet. When `expected` is non-empty the bytes must hash to it or the
  // put is rejected with HashMismatch and nothing is stored. When the object
  // already exists the put succeeds with existed=true; presence plus length
  // is the dedup fast path, full byte verification is what verify() is for.
  [[nodiscard]] virtual content_store_result put_if_absent(const std::string &content_namespace, const void *data,
                                                           size_t size, const content_hash &expected = {}) = 0;

  [[nodiscard]] content_store_result put_if_absent(const std::string &content_namespace, const std::string &bytes,
                                                   const content_hash &expected = {}) {
    return put_if_absent(content_namespace, bytes.data(), bytes.size(), expected);
  }

  [[nodiscard]] virtual bool has(const std::string &content_namespace, const content_hash &hash) const = 0;

  // Re-hash the stored bytes and compare against the digest. A torn or
  // tampered object reports CorruptObject and never verifies.
  [[nodiscard]] virtual content_store_result verify(const std::string &content_namespace,
                                                    const content_hash &hash) const = 0;

  // Verified read: bytes are returned only after they re-hash to the digest,
  // so a caller can never observe corrupt content through get().
  [[nodiscard]] virtual content_get_result get(const std::string &content_namespace,
                                               const content_hash &hash) const = 0;
};

struct file_content_store_options {
  std::string hash_algorithm = CONTENT_HASH_ALGORITHM_SHA256;
  uint64_t max_object_size = 0; // 0 = no declared limit
  bool fsync_on_publish = true; // fsync object bytes (and dir, POSIX) before publish
};

// The dependency-free default backend: a file-based content-addressed store
// over std::filesystem, so the yijinjing content store works standalone with
// zero heavy dependencies. Layout per namespace follows the KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5 payload
// layout -- <root>/<namespace>/<digest[0:2]>/<digest>, bare lowercase hex,
// no extension -- so with root <runtime>/storage and namespace "payloads" it
// is byte-compatible with the existing payload tree.
//
// Atomic publish: bytes are written to a temp file under
// <root>/<namespace>/tmp/ and renamed onto the final path, so a torn write is
// never visible under a content digest; a crash leaves only temp residue that
// lookups can never observe. Concurrent writers of the same content race on
// the rename at worst, and every rename publishes identical verified bytes.
class file_content_store : public content_store {
public:
  explicit file_content_store(std::string root_dir, file_content_store_options options = {});

  [[nodiscard]] std::string root_dir() const { return root_dir_; }

  [[nodiscard]] content_store_capabilities capabilities() const override;

  [[nodiscard]] content_store_result put_if_absent(const std::string &content_namespace, const void *data, size_t size,
                                                   const content_hash &expected = {}) override;
  using content_store::put_if_absent;

  [[nodiscard]] bool has(const std::string &content_namespace, const content_hash &hash) const override;

  [[nodiscard]] content_store_result verify(const std::string &content_namespace,
                                            const content_hash &hash) const override;

  [[nodiscard]] content_get_result get(const std::string &content_namespace, const content_hash &hash) const override;

  // The final path an object with this identity lives at; for tooling and
  // fixtures, not a read path (get() is the read path).
  [[nodiscard]] std::string object_path(const std::string &content_namespace, const content_hash &hash) const;

private:
  std::string root_dir_;
  file_content_store_options options_;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_CONTENT_STORE_H
