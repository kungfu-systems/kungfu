// SPDX-License-Identifier: Apache-2.0

#include "io/durability.h"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
namespace durability = kungfu::yijinjing::io::durability;

namespace {

void require(bool condition, const char *message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::string read_file(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

} // namespace

int main() {
  const auto nonce = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
  const auto root = fs::temp_directory_path() / ("kungfu-durability-" + nonce);
  fs::create_directories(root);

  const auto durable_path = root / "durable.bin";
  {
    durability::durable_file file(durable_path, true);
    file.write("abc");
    file.sync();
  }
  {
    durability::durable_file file(durable_path, false);
    file.write("def");
    file.sync();
  }
  require(read_file(durable_path) == "abcdef", "durable file did not preserve append semantics");
  durability::sync_file(durable_path);

  const auto stream_path = root / "stream.bin";
  auto *stream = std::fopen(stream_path.string().c_str(), "wb");
  require(stream != nullptr, "failed to create stream fixture");
  require(std::fwrite("stream", 1, 6, stream) == 6, "failed to write stream fixture");
  require(std::fflush(stream) == 0, "failed to flush stdio fixture");
  durability::sync_file(stream);
  require(std::fclose(stream) == 0, "failed to close stream fixture");
  require(!durability::try_sync_file(nullptr), "best-effort file sync accepted a null stream");

  const auto final_path = root / "published.bin";
  const auto temporary_path = root / "published.tmp";
  {
    std::ofstream final(final_path, std::ios::binary);
    final << "old";
    std::ofstream temporary(temporary_path, std::ios::binary);
    temporary << "new";
  }
  durability::replace_file(temporary_path, final_path);
  require(read_file(final_path) == "new", "replacement did not publish the temporary file");
  require(!fs::exists(temporary_path), "replacement retained the temporary file");

  const auto directory_status = durability::sync_directory(root);
#ifdef _WIN32
  require(directory_status == durability::directory_sync_status::unsupported,
          "Windows directory sync claimed a POSIX guarantee");
#else
  require(directory_status == durability::directory_sync_status::synchronized,
          "POSIX directory sync did not report completion");
#endif
  durability::best_effort_sync_directory(root / "missing");

  fs::remove_all(root);
}
