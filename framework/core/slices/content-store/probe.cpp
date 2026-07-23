// SPDX-License-Identifier: Apache-2.0
//
// content-store slice probe (ADR-0040): drives the dependency-free file
// backend through the contract's four obligations -- atomic publish
// (put-if-absent), hash mismatch rejection, crash-safe visibility (a torn
// write is invisible or detectable, never a verified read), verified reads --
// plus the single-node concurrency proof: concurrent writers proposing the
// same content store it once, different content lands under distinct keys.
//
// Usage: content_store_probe <workdir>              full fixture suite
//        content_store_probe --writer <root> <n>    multi-process writer leg
//          (run.mjs spawns several writer processes against one root and
//           asserts single-copy dedup on the filesystem afterwards)

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/content_store.h>

using namespace kungfu::yijinjing::storage;
namespace fs = std::filesystem;

namespace {

int failures = 0;

void check(bool ok, const std::string &label) {
  std::printf("  %s: %s\n", ok ? "ok" : "FAIL", label.c_str());
  if (!ok) {
    ++failures;
  }
}

// Objects on disk for one namespace, ignoring the tmp/ staging dir; temp
// residue is counted separately because it must never look like an object.
size_t count_objects(const std::string &root, const std::string &content_namespace) {
  const auto dir = fs::path(root) / content_namespace;
  if (!fs::exists(dir)) {
    return 0;
  }
  size_t count = 0;
  for (const auto &entry : fs::recursive_directory_iterator(dir)) {
    if (entry.is_regular_file() && entry.path().parent_path().filename() != "tmp") {
      ++count;
    }
  }
  return count;
}

size_t count_temp_residue(const std::string &root, const std::string &content_namespace) {
  const auto dir = fs::path(root) / content_namespace / "tmp";
  if (!fs::exists(dir)) {
    return 0;
  }
  size_t count = 0;
  for (const auto &entry : fs::directory_iterator(dir)) {
    if (entry.is_regular_file()) {
      ++count;
    }
  }
  return count;
}

content_hash digest_of(const std::string &bytes) { return make_content_hash(compute_content_hash_value(bytes)); }

int run_suite(const std::string &root) {
  file_content_store store(root);

  std::printf("== capability discovery\n");
  const auto caps = store.capabilities();
  check(caps.profile == "yijinjing-file/v1", "backend declares its profile");
  check(caps.hash_algorithm == std::string(CONTENT_HASH_ALGORITHM_SHA256), "backend declares its hash algorithm");
  check(caps.atomic_put_if_absent, "backend declares atomic put-if-absent");
  check(caps.verified_reads, "backend declares verified reads");
  check(!caps.durability.empty() && !caps.visibility.empty() && !caps.concurrency.empty(),
        "durability/visibility/concurrency are declared, not implied");

  std::printf("== obligation: atomic publish + verified read\n");
  const std::string bytes = "content-store v1 first obligation payload";
  const auto put = store.put_if_absent("payloads", bytes);
  check(put.ok() && !put.existed, "first put publishes");
  check(put.hash.value == compute_content_hash_value(bytes), "identity is the hash of the bytes");
  check(put.byte_length == bytes.size(), "result reports the object length");
  const auto got = store.get("payloads", put.hash);
  check(got.ok() && got.bytes == bytes, "verified get returns the exact bytes");
  check(store.has("payloads", put.hash), "has sees the published object");
  const auto verified = store.verify("payloads", put.hash);
  check(verified.ok() && verified.byte_length == bytes.size(), "verify re-hashes the stored bytes");
  check(count_temp_residue(root, "payloads") == 0, "publish leaves no temp residue");

  std::printf("== dedup: same content is stored once\n");
  const auto again = store.put_if_absent("payloads", bytes);
  check(again.ok() && again.existed, "second put is a dedup hit");
  check(count_objects(root, "payloads") == 1, "exactly one object on disk");

  std::printf("== obligation: hash mismatch rejection\n");
  const std::string other = "different payload that will be rejected";
  const auto wrong = make_content_hash(std::string(64, '0'));
  const auto rejected = store.put_if_absent("mismatch", other, wrong);
  check(rejected.error == content_store_error::HashMismatch, "put with a wrong declared digest is rejected");
  check(count_objects(root, "mismatch") == 0, "rejected put stores nothing");
  const auto accepted = store.put_if_absent("mismatch", other, digest_of(other));
  check(accepted.ok(), "put with the correct declared digest is accepted");
  const auto absent = store.verify("mismatch", wrong);
  check(absent.error == content_store_error::NotFound, "verify of an absent digest reports not_found");

  std::printf("== obligation: crash-safe visibility\n");
  // a torn final object, as a crashed non-atomic legacy writer would leave it
  const std::string torn_body = "torn object body: the second half of this never reached disk";
  const auto torn_hash = digest_of(torn_body);
  const fs::path torn_path = store.object_path("torn", torn_hash);
  fs::create_directories(torn_path.parent_path());
  std::ofstream(torn_path, std::ios::binary) << torn_body.substr(0, torn_body.size() / 2);
  check(store.verify("torn", torn_hash).error == content_store_error::CorruptObject, "torn object fails verify");
  check(store.get("torn", torn_hash).error == content_store_error::CorruptObject,
        "torn object never comes back from get");
  check(store.put_if_absent("torn", torn_body).error == content_store_error::CorruptObject,
        "put onto a torn object reports corruption instead of trusting it");
  // same-length tampering passes the dedup fast path (declared: presence plus
  // length) but can never reach a caller through the verified read path
  const std::string true_body = "authentic bytes for the tamper case, same length as fake";
  std::string fake_body = true_body;
  fake_body[0] = 'X';
  const auto true_hash = digest_of(true_body);
  const fs::path tamper_path = store.object_path("tamper", true_hash);
  fs::create_directories(tamper_path.parent_path());
  std::ofstream(tamper_path, std::ios::binary) << fake_body;
  check(store.put_if_absent("tamper", true_body).existed, "same-length tamper passes the dedup fast path by design");
  check(store.verify("tamper", true_hash).error == content_store_error::CorruptObject, "verify detects the tamper");
  check(store.get("tamper", true_hash).error == content_store_error::CorruptObject, "get never returns tampered bytes");
  // a crash between temp write and publish leaves residue only under tmp/,
  // where no digest lookup can ever address it
  const std::string junk = "temp residue from a crashed writer";
  const fs::path residue = fs::path(root) / "payloads" / "tmp" / "deadbeef.99999.1";
  fs::create_directories(residue.parent_path());
  std::ofstream(residue, std::ios::binary) << junk;
  check(!store.has("payloads", digest_of(junk)), "temp residue is invisible to lookups");
  check(count_objects(root, "payloads") == 1, "temp residue is not an object");

  std::printf("== size limit semantics\n");
  file_content_store_options bounded_options{};
  bounded_options.max_object_size = 8;
  file_content_store bounded(root + "-bounded", bounded_options);
  check(bounded.capabilities().max_object_size == 8, "the limit is declared through capabilities");
  check(bounded.put_if_absent("payloads", std::string("123456789")).error == content_store_error::SizeLimitExceeded,
        "an oversized put is rejected");
  check(bounded.put_if_absent("payloads", std::string("12345678")).ok(), "a put at the limit is accepted");

  std::printf("== declared error categories\n");
  check(store.put_if_absent("Bad/Namespace", bytes).error == content_store_error::InvalidArgument,
        "an invalid namespace is invalid_argument");
  content_hash malformed{};
  malformed.value = "zz";
  check(store.get("payloads", malformed).error == content_store_error::InvalidArgument,
        "a malformed digest is invalid_argument");
  content_hash foreign{};
  foreign.algorithm = "md5";
  foreign.value = std::string(64, 'a');
  check(store.verify("payloads", foreign).error == content_store_error::InvalidArgument,
        "an unsupported algorithm is invalid_argument, not a crash");

  std::printf("== concurrency: same content from many threads is stored once\n");
  const std::string shared = "fleet-shared content every writer proposes";
  const int thread_count = 8;
  const int rounds = 32;
  std::atomic<int> put_errors{0};
  {
    std::vector<std::thread> writers;
    writers.reserve(thread_count);
    for (int t = 0; t < thread_count; ++t) {
      writers.emplace_back([&store, &shared, &put_errors]() {
        for (int i = 0; i < rounds; ++i) {
          if (!store.put_if_absent("conc-shared", shared).ok()) {
            put_errors.fetch_add(1, std::memory_order_relaxed);
          }
        }
      });
    }
    for (auto &writer : writers) {
      writer.join();
    }
  }
  check(put_errors.load() == 0, "every concurrent put succeeds");
  check(count_objects(root, "conc-shared") == 1, "one stored copy after the race");
  check(count_temp_residue(root, "conc-shared") == 0, "no torn state after the race");
  check(store.verify("conc-shared", digest_of(shared)).ok(), "the surviving copy verifies");

  std::printf("== concurrency: distinct content lands under distinct keys\n");
  std::atomic<int> distinct_errors{0};
  {
    std::vector<std::thread> writers;
    writers.reserve(thread_count);
    for (int t = 0; t < thread_count; ++t) {
      writers.emplace_back([&store, &distinct_errors, t]() {
        const std::string body = "writer-" + std::to_string(t) + " private content";
        const auto put = store.put_if_absent("conc-distinct", body);
        if (!put.ok() || put.existed || !store.verify("conc-distinct", put.hash).ok()) {
          distinct_errors.fetch_add(1, std::memory_order_relaxed);
        }
      });
    }
    for (auto &writer : writers) {
      writer.join();
    }
  }
  check(distinct_errors.load() == 0, "every distinct put publishes and verifies");
  check(count_objects(root, "conc-distinct") == static_cast<size_t>(thread_count),
        "distinct contents are distinct keys");

  if (failures > 0) {
    std::printf("FAIL: %d content-store obligations violated\n", failures);
    return 1;
  }
  std::printf("OK: content-store obligations and single-node concurrency proof hold\n");
  return 0;
}

// One writer leg of the multi-process proof: publish the same deterministic
// content set as every other writer, verifying each object after the put.
int run_writer(const std::string &root, int count) {
  file_content_store store(root);
  for (int i = 0; i < count; ++i) {
    const std::string body = "multi-process shared content #" + std::to_string(i);
    const auto put = store.put_if_absent("payloads", body);
    if (!put.ok()) {
      std::fprintf(stderr, "writer: put %d failed: %s\n", i, put.message.c_str());
      return 1;
    }
    if (!store.verify("payloads", put.hash).ok()) {
      std::fprintf(stderr, "writer: verify %d failed\n", i);
      return 1;
    }
  }
  std::printf("writer: %d contents published and verified\n", count);
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  if (argc >= 4 && std::strcmp(argv[1], "--writer") == 0) {
    return run_writer(argv[2], std::atoi(argv[3]));
  }
  if (argc < 2) {
    std::fprintf(stderr, "usage: content_store_probe <workdir> | content_store_probe --writer <root> <count>\n");
    return 2;
  }
  return run_suite(argv[1]);
}
