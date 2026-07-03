// SPDX-License-Identifier: Apache-2.0
//
// Native FlatBuffers schema compilation for the open layer. A kfx author (in
// this process or another, possibly untrusted) hands over a `.fbs` text schema;
// libkungfu parses and serializes it to a `.bfbs` (reflection binary) in
// process, using the FlatBuffers library it already links — no `flatc` binary,
// no subprocess. The resulting `.bfbs` is what the open-layer schema registry
// content-addresses and every runtime (C++/Python/Node) decodes by reflection.
//
// Trust model (ADR-0011, decision D32): compilation is tiered by the caller's
// kfx runtime declaration. `node-integrated` (trusted) compiles without limits;
// `sandboxed-ipc` (third-party) applies hard bounds. This header carries the
// options surface; the bound *enforcement* is filled in incrementally.

#ifndef KUNGFU_YIJINJING_SCHEMA_COMPILER_H
#define KUNGFU_YIJINJING_SCHEMA_COMPILER_H

#include <cstdint>
#include <string>
#include <vector>

namespace kungfu::yijinjing::schema {

// Compilation trust tier, mapped from the kfx runtime declaration.
enum class trust_tier {
  trusted,       // node-integrated kfx: no limits
  sandboxed,     // sandboxed-ipc / third-party kfx: hard bounds apply
};

struct compile_options {
  trust_tier tier = trust_tier::trusted;
  // sandboxed-tier bounds (ignored for trusted). 0 == unset/no explicit bound.
  bool allow_includes = true; // sandboxed forces false regardless
  std::size_t max_fbs_bytes = 0;
};

struct compile_result {
  bool ok = false;
  std::vector<std::uint8_t> bfbs; // reflection binary on success, empty on error
  std::string error;              // structured parser diagnostic on failure
};

// Parse `fbs_text` and serialize its schema to a `.bfbs`. Never throws: a parse
// failure returns ok=false with `error` carrying the FlatBuffers parser's
// diagnostic (file:line: message). Best-effort, safe on untrusted input — this
// is schema parsing, not code execution.
compile_result compile_fbs(const std::string &fbs_text, const compile_options &opts = {});

} // namespace kungfu::yijinjing::schema

#endif // KUNGFU_YIJINJING_SCHEMA_COMPILER_H
