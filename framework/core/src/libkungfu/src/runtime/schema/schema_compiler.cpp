// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/schema/schema_compiler.h>

#include <kungfu/view/schema.h>

namespace kungfu::runtime::schema {

compile_result compile_fbs(const std::string &fbs_text, const compile_options &opts) {
  compile_result result;

  // sandboxed tier: hard bounds. `allow_includes` is forced off for untrusted
  // kfx; a size bound rejects oversized schema text before the parser runs.
  const bool allow_includes = opts.tier == trust_tier::trusted && opts.allow_includes;
  if (opts.tier == trust_tier::sandboxed) {
    const std::size_t cap = opts.max_fbs_bytes != 0 ? opts.max_fbs_bytes : (256u * 1024u);
    if (fbs_text.size() > cap) {
      result.error = "schema rejected: size " + std::to_string(fbs_text.size()) + " exceeds sandboxed limit " +
                     std::to_string(cap);
      return result;
    }
  } else if (opts.max_fbs_bytes != 0 && fbs_text.size() > opts.max_fbs_bytes) {
    result.error = "schema rejected: size " + std::to_string(fbs_text.size()) + " exceeds limit " +
                   std::to_string(opts.max_fbs_bytes);
    return result;
  }

  // The `.fbs` -> `.bfbs` compile itself goes through kungfu::view: FlatBuffers
  // is reached only through that one module (ADR-0039). This layer keeps just
  // the trust-tier policy above.
  auto compiled = kungfu::view::compile_schema(fbs_text, allow_includes);
  if (!compiled.ok) {
    result.error = std::move(compiled.error);
    return result;
  }
  result.bfbs.assign(compiled.bfbs.begin(), compiled.bfbs.end());
  result.ok = true;
  return result;
}

} // namespace kungfu::runtime::schema
