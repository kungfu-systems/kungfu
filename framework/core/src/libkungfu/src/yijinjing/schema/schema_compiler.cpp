// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/schema/schema_compiler.h>

#include <flatbuffers/idl.h>

namespace kungfu::yijinjing::schema {

compile_result compile_fbs(const std::string &fbs_text, const compile_options &opts) {
  compile_result result;

  // sandboxed tier: hard bounds. `allow_includes` is forced off for untrusted
  // kfx; a size bound rejects oversized schema text before the parser runs.
  const bool allow_includes = opts.tier == trust_tier::trusted && opts.allow_includes;
  if (opts.tier == trust_tier::sandboxed) {
    const std::size_t cap = opts.max_fbs_bytes != 0 ? opts.max_fbs_bytes : (256u * 1024u);
    if (fbs_text.size() > cap) {
      result.error = "schema rejected: size " + std::to_string(fbs_text.size()) +
                     " exceeds sandboxed limit " + std::to_string(cap);
      return result;
    }
  } else if (opts.max_fbs_bytes != 0 && fbs_text.size() > opts.max_fbs_bytes) {
    result.error = "schema rejected: size " + std::to_string(fbs_text.size()) +
                   " exceeds limit " + std::to_string(opts.max_fbs_bytes);
    return result;
  }

  // In-memory compile against the already-linked FlatBuffers library. No
  // include directories are provided, so a schema that pulls in other files
  // fails to resolve — acceptable for the in-process open-layer path and
  // mandatory for the sandboxed tier.
  flatbuffers::IDLOptions idl_opts;
  flatbuffers::Parser parser(idl_opts);

  const char *include_paths[] = {nullptr};
  if (!parser.Parse(fbs_text.c_str(), allow_includes ? nullptr : include_paths)) {
    result.error = parser.error_;
    return result;
  }

  // Serialize the parsed schema to its reflection binary (.bfbs).
  parser.Serialize();
  const std::uint8_t *buf = parser.builder_.GetBufferPointer();
  const std::size_t size = parser.builder_.GetSize();
  result.bfbs.assign(buf, buf + size);
  result.ok = true;
  return result;
}

} // namespace kungfu::yijinjing::schema
