// SPDX-License-Identifier: Apache-2.0
//
// libFuzzer-less driver: replay the checked-in seed corpus through
// LLVMFuzzerTestOneInput under ASan/UBSan. This is the *every-build* sanitizer
// tier — it needs no libFuzzer runtime, so it links with the ordinary build
// compiler (Apple clang on macOS, system clang/gcc on Linux, MSVC
// /fsanitize=address on Windows), unlike the libFuzzer tier which needs an
// LLVM clang. A sanitizer violation aborts the process; a clean exit 0 means
// every seed stayed in bounds through the view access boundary.
//
// Usage: fuzz_<target>_sanitize <corpus-dir-or-file> [more ...]
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

namespace {
void run_bytes(const std::vector<uint8_t> &buf) { LLVMFuzzerTestOneInput(buf.data(), buf.size()); }

int run_file(const std::filesystem::path &p) {
  std::ifstream f(p, std::ios::binary);
  if (!f)
    return 0;
  std::vector<uint8_t> buf((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  run_bytes(buf);
  return 1;
}
} // namespace

int main(int argc, char **argv) {
  namespace fs = std::filesystem;
  int files = 0;
  for (int i = 1; i < argc; ++i) {
    std::error_code ec;
    fs::path p(argv[i]);
    if (fs::is_directory(p, ec)) {
      for (const auto &e : fs::directory_iterator(p, ec))
        if (e.is_regular_file())
          files += run_file(e.path());
    } else if (fs::is_regular_file(p, ec)) {
      files += run_file(p);
    }
  }
  // Always exercise the degenerate empty input — a common boundary the seed
  // corpus does not otherwise cover.
  run_bytes(std::vector<uint8_t>{});
  std::fprintf(stderr, "[standalone-fuzz] replayed %d corpus file(s) + empty input clean\n", files);
  return 0;
}
