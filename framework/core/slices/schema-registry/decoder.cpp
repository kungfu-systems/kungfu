// SPDX-License-Identifier: Apache-2.0
//
// Schema-registry slice, read side — the proof.
//
// Decodes a journal directory using ONLY what the bundle carries: the run
// manifest's schema bindings and the content-addressed .bfbs blobs, accessed
// through FlatBuffers runtime reflection. No generated code, no longfist type
// registry, no compiled knowledge of the event types. If this program can
// print named, typed fields, the "opens without a matching binary" promise
// holds.
//
// Exits non-zero if the manifest/blob hashes do not verify, an event has no
// binding, a bound schema fails to decode, or the causal chain is broken.
//
// Usage: schema_registry_decoder <journal-root> <bundle-dir>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/journal.h>

#include "../common/sha256.h"

#include <flatbuffers/reflection.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>

using namespace kungfu::yijinjing;
using kungfu::slices::sha256;
namespace longfist = kungfu::longfist;

namespace {
std::string read_file(const std::filesystem::path &path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw std::runtime_error("cannot read " + path.string());
  }
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

std::string strip_trailing_nuls(std::string s) {
  while (!s.empty() && s.back() == '\0') {
    s.pop_back();
  }
  return s;
}

struct Binding {
  std::string kind;    // "flatbuffers" | "json"
  std::string name;
  int version = 0;
  std::string bfbs;    // owned bytes (schema view binds to them)
  const reflection::Schema *schema = nullptr;
};
} // namespace

int main(int argc, char **argv) {
  if (argc < 3) {
    std::cerr << "usage: schema_registry_decoder <journal-root> <bundle-dir>\n";
    return 2;
  }
  const std::string root = argv[1];
  const std::filesystem::path bundle = argv[2];

  // ── load the bundle's format pieces (manifest is the trust root) ──
  const auto manifest = nlohmann::json::parse(read_file(bundle / "manifest.json"));
  std::map<int32_t, Binding> bindings;
  for (const auto &[key, entry] : manifest.at("schema_bindings").items()) {
    Binding b;
    b.kind = entry.at("schema_kind");
    b.name = entry.at("name");
    b.version = entry.at("schema_version");
    if (b.kind == "flatbuffers") {
      const std::string hash = entry.at("schema_hash");
      b.bfbs = read_file(bundle / "schemas" / (hash + ".bfbs"));
      if (sha256::hex(b.bfbs) != hash) {
        std::cerr << "FAIL: schema blob hash mismatch for msg_type " << key << "\n";
        return 1;
      }
      b.schema = reflection::GetSchema(b.bfbs.c_str());
    }
    bindings.emplace(std::stoi(key), std::move(b));
  }

  // ── reopen the journal independently and decode by binding ────────
  const auto &src = manifest.at("source");
  auto locator = std::make_shared<data::locator>(root);
  auto location = data::location::make_shared(longfist::enums::mode::LIVE, longfist::enums::category::SYSTEM,
                                              src.at("group"), src.at("name"), locator);
  journal::assemble reader(location, data::location::PUBLIC, longfist::enums::AssembleMode::Channel, 0);

  std::size_t count = 0;
  uint64_t last_uid = 0;
  while (reader.data_available()) {
    auto frame = reader.current_frame();
    const auto it = bindings.find(frame->msg_type());
    if (it == bindings.end()) {
      std::cerr << "FAIL: no schema binding for msg_type " << frame->msg_type() << "\n";
      return 1;
    }
    const Binding &b = it->second;

    nlohmann::json fields;
    if (b.kind == "flatbuffers") {
      const auto *buf = reinterpret_cast<const uint8_t *>(frame->data_address());
      const auto *table = flatbuffers::GetAnyRoot(buf);
      for (const auto *field : *b.schema->root_table()->fields()) {
        const auto bt = field->type()->base_type();
        const std::string fname = field->name()->str();
        if (bt == reflection::String) {
          fields[fname] = flatbuffers::GetAnyFieldS(*table, *field, b.schema);
        } else if (bt == reflection::Float || bt == reflection::Double) {
          fields[fname] = flatbuffers::GetAnyFieldF(*table, *field);
        } else {
          fields[fname] = flatbuffers::GetAnyFieldI(*table, *field);
        }
      }
    } else {
      fields = nlohmann::json::parse(strip_trailing_nuls(frame->data_as_string()), nullptr,
                                     /*allow_exceptions=*/false);
      if (fields.is_discarded()) {
        std::cerr << "FAIL: json payload did not parse at event " << count << "\n";
        return 1;
      }
    }

    const uint64_t trigger = frame->trigger_frame_uid();
    if (count == 0 ? trigger != 0 : trigger != last_uid) {
      std::cerr << "FAIL: causal chain broken at event " << count << "\n";
      return 1;
    }
    last_uid = frame->frame_uid();

    nlohmann::json line = {
        {"seq", count},
        {"msg_type", frame->msg_type()},
        {"type_name", b.name},
        {"schema_kind", b.kind},
        {"schema_version", b.version},
        {"frame_uid", frame->frame_uid()},
        {"trigger_frame_uid", trigger},
        {"fields", fields},
    };
    std::cout << line.dump() << std::endl;

    ++count;
    reader.next();
  }

  if (count == 0) {
    std::cerr << "FAIL: nothing decoded\n";
    return 1;
  }
  std::cerr << "OK: decoded " << count << " events by bundle schema alone" << std::endl;
  return 0;
}
