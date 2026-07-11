// SPDX-License-Identifier: Apache-2.0

#include "py-runtime.h"

#include <limits>

#include <nlohmann/json.hpp>
#include <pybind11/stl.h>

#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/cache/profile.h>
#include <kungfu/runtime/index/session.h>
#include <kungfu/runtime/io.h>
#include <kungfu/runtime/nanomsg/socket.h>
#include <kungfu/runtime/practice/apprentice.h>
#include <kungfu/runtime/practice/master.h>
#include <kungfu/runtime/schema/schema_compiler.h>
#include <kungfu/runtime/storage/binding_reflection.h>
#include <kungfu/runtime/storage/hana_view.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/runtime/util/terminal.h>
#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>
#include <kungfu/yijinjing/storage/sync_root.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::runtime::cache;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::index;
using namespace kungfu::runtime::journal;
using namespace kungfu::runtime::nanomsg;
using namespace kungfu::runtime::practice;

namespace py = pybind11;

namespace {

nlohmann::json py_to_json(py::handle value) {
  if (value.is_none()) {
    return nullptr;
  }
  if (py::isinstance<py::bool_>(value)) {
    return value.cast<bool>();
  }
  if (py::isinstance<py::int_>(value)) {
    return value.cast<int64_t>();
  }
  if (py::isinstance<py::float_>(value)) {
    return value.cast<double>();
  }
  if (py::isinstance<py::str>(value)) {
    return value.cast<std::string>();
  }
  if (py::isinstance<py::dict>(value)) {
    nlohmann::json object = nlohmann::json::object();
    for (const auto item : py::reinterpret_borrow<py::dict>(value)) {
      object[item.first.cast<std::string>()] = py_to_json(item.second);
    }
    return object;
  }
  if (py::isinstance<py::list>(value) || py::isinstance<py::tuple>(value)) {
    nlohmann::json array = nlohmann::json::array();
    for (const auto item : py::reinterpret_borrow<py::iterable>(value)) {
      array.push_back(py_to_json(item));
    }
    return array;
  }
  throw std::invalid_argument("unsupported JSON value type");
}

std::vector<nlohmann::json> py_entries_to_json(py::iterable entries) {
  std::vector<nlohmann::json> result;
  for (const auto entry : entries) {
    result.emplace_back(py_to_json(entry));
  }
  return result;
}

py::object json_to_py(const nlohmann::json &value) {
  return py::module_::import("json").attr("loads")(value.dump(-1, ' ', false));
}

template <typename> inline constexpr bool dependent_false_v = false;

template <typename T> py::object hana_view_to_py(const T &value) {
  using value_t = std::decay_t<T>;
  if constexpr (std::is_same_v<value_t, bool>) {
    return py::bool_(value);
  } else if constexpr (std::is_integral_v<value_t>) {
    return py::int_(value);
  } else if constexpr (std::is_floating_point_v<value_t>) {
    return py::float_(value);
  } else if constexpr (std::is_enum_v<value_t>) {
    return py::int_(static_cast<std::underlying_type_t<value_t>>(value));
  } else if constexpr (std::is_same_v<value_t, std::string>) {
    return py::str(value);
  } else if constexpr (kungfu::is_array_of_v<value_t, char>) {
    return py::str(value.value);
  } else if constexpr (kungfu::is_array_of_others_v<value_t, char>) {
    py::list result;
    for (size_t index = 0; index < value_t::length; ++index)
      result.append(hana_view_to_py(value[index]));
    return result;
  } else if constexpr (kungfu::runtime::storage_binding::is_optional_v<value_t>) {
    return value.has_value() ? hana_view_to_py(*value) : py::none();
  } else if constexpr (kungfu::runtime::storage_binding::is_vector_v<value_t>) {
    py::list result;
    for (const auto &item : value)
      result.append(hana_view_to_py(item));
    return result;
  } else if constexpr (kungfu::runtime::storage_binding::is_variant_v<value_t>) {
    return std::visit([](const auto &item) { return hana_view_to_py(item); }, value);
  } else if constexpr (kungfu::runtime::storage_binding::is_hana_view_v<value_t>) {
    py::dict result;
    kungfu::runtime::storage_binding::for_each_field(
        value, [&](const auto &name, const auto &field) { result[py::str(name)] = hana_view_to_py(field); });
    return result;
  } else {
    static_assert(dependent_false_v<value_t>, "unsupported Hana binding value");
  }
}

} // namespace

namespace kungfu::runtime {
class PyLocator : public locator {
  using locator::locator;

  [[nodiscard]] bool has_env(const std::string &name) const override {
    PYBIND11_OVERLOAD(bool, locator, has_env, name);
  }

  [[nodiscard]] std::string get_env(const std::string &name) const override {
    PYBIND11_OVERLOAD(std::string, locator, get_env, name);
  }

  [[nodiscard]] std::string layout_dir(const location_ptr &location, layout l,
                                       bool create_not_exist = true) const override {
    PYBIND11_OVERLOAD(std::string, locator, layout_dir, location, l, create_not_exist);
  }

  [[nodiscard]] std::string layout_file(const location_ptr &location, layout l,
                                        const std::string &name) const override {
    PYBIND11_OVERLOAD(std::string, locator, layout_file, location, l, name);
  }

  [[nodiscard]] std::string default_to_system_db(const location_ptr &location, const std::string &name) const override {
    PYBIND11_OVERLOAD(std::string, locator, default_to_system_db, location, name);
  }

  [[nodiscard]] std::vector<uint32_t> list_page_id(const location_ptr &location, uint32_t dest_id) const override {
    PYBIND11_OVERLOAD(std::vector<uint32_t>, locator, list_page_id, location, dest_id);
  }

  [[nodiscard]] std::vector<location_ptr> list_locations(const std::string &role, const std::string &namespace_,
                                                         const std::string &name,
                                                         const std::string &mode) const override {
    PYBIND11_OVERLOAD(std::vector<location_ptr>, locator, list_locations, role, namespace_, name, mode);
  }

  [[nodiscard]] std::vector<uint32_t> list_location_dest(const location_ptr &location) const override {
    PYBIND11_OVERLOAD(std::vector<uint32_t>, locator, list_location_dest, location);
  }
};

class PyEvent : public event {
public:
  [[nodiscard]] int64_t gen_time() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, gen_time); }

  [[nodiscard]] int64_t trigger_time() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, trigger_time); }

  [[nodiscard]] int32_t carrier_type() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, carrier_type); }

  [[nodiscard]] uint32_t source() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, source); }

  [[nodiscard]] uint32_t initial_source() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, initial_source); }

  [[nodiscard]] uint32_t dest() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, dest); }
};

class PyPublisher : public publisher {
public:
  int notify() override { PYBIND11_OVERLOAD_PURE(int, publisher, notify); }

  int publish(const std::string &json_message, int flags = NNG_FLAG_NONBLOCK, bool no_exception = false) override {
    PYBIND11_OVERLOAD_PURE(int, publisher, publish, json_message, flags, no_exception);
  }
};

class PyObserver : public observer {
public:
  bool wait() override { PYBIND11_OVERLOAD_PURE(bool, observer, wait); }

  const std::string &get_notice() override { PYBIND11_OVERLOAD_PURE(const std::string &, observer, get_notice); }
};

class PySink : public sink {
public:
  void put(const yijinjing::data::location_ptr &location, uint32_t dest_id, const frame_ptr &frame) override {
    PYBIND11_OVERLOAD_PURE(void, sink, put, location, dest_id, frame);
  }
  void close() override { PYBIND11_OVERLOAD(void, sink, close); }
};

class PyMaster : public master {
public:
  using master::master;

  void on_exit() override { PYBIND11_OVERLOAD(void, master, on_exit); }

  void on_register(int64_t gen_time, const Register &register_data) override {
    PYBIND11_OVERLOAD_PURE(void, master, on_register, gen_time, register_data);
  }

  bool check_register(int64_t gen_time, const Register &register_data) override {
    PYBIND11_OVERLOAD_PURE(bool, master, check_register, gen_time, register_data);
  }

  void on_interval_check(int64_t nanotime) override {
    PYBIND11_OVERLOAD_PURE(void, master, on_interval_check, nanotime);
  }
};

class PyApprentice : public apprentice {
public:
  using apprentice::apprentice;

  void on_exit() override { PYBIND11_OVERLOAD_PURE(void, apprentice, on_exit); }
};

void bind(pybind11::module &&m) {
  ensure_sqlite_initilize();

  // nanosecond-time related
  m.def("now_in_nano", &yijinjing::time::now_in_nano);
  m.def("nano_hashed", &yijinjing::time::nano_hashed);
  m.def("next_minute", &yijinjing::time::next_minute);
  m.def("next_session_boundary", &yijinjing::time::next_session_boundary);
  m.def("calendar_day_start", &yijinjing::time::calendar_day_start);
  m.def("today_start", &yijinjing::time::today_start);
  m.def("session_window_start", &yijinjing::time::session_window_start);
  m.def("history_window_start", &yijinjing::time::history_window_start);
  m.def("strftime", &yijinjing::time::strftime, py::arg("nanotime"), py::arg("format") = KUNGFU_TIMESTAMP_FORMAT);
  m.def("strptime", py::overload_cast<const std::string &, const std::string &>(&yijinjing::time::strptime),
        py::arg("timestr"), py::arg("format") = KUNGFU_TIMESTAMP_FORMAT);
  m.def("strfnow", &yijinjing::time::strfnow, py::arg("format") = KUNGFU_TIMESTAMP_FORMAT);

  m.def("get_page_path", &page::get_page_path);

  // open-layer schema compilation: a kfx `.fbs` text schema -> `.bfbs`
  // reflection binary, compiled in-process by the linked FlatBuffers library
  // (no flatc binary, no subprocess). Returns (bfbs_bytes, error): on success
  // error is empty; on a parse/policy failure bfbs is empty and error carries
  // the diagnostic. `sandboxed=True` applies the untrusted-kfx bounds.
  m.def(
      "compile_schema",
      [](const std::string &fbs_text, bool sandboxed) {
        schema::compile_options opts;
        opts.tier = sandboxed ? schema::trust_tier::sandboxed : schema::trust_tier::trusted;
        auto r = schema::compile_fbs(fbs_text, opts);
        return py::make_tuple(py::bytes(reinterpret_cast<const char *>(r.bfbs.data()), r.bfbs.size()), r.error);
      },
      py::arg("fbs_text"), py::arg("sandboxed") = false);

  m.def("thread_id", &runtime::util::get_thread_id);
  m.def("in_color_terminal", &runtime::util::in_color_terminal);
  m.def("color_print", &runtime::util::color_print);

  auto fast_hash_buffer = [](py::buffer payload, uint32_t seed, auto hash_fn) {
    const auto view = payload.request();
    const auto byte_length = view.size * view.itemsize;
    if (byte_length > std::numeric_limits<int32_t>::max()) {
      throw std::invalid_argument("fast_hash payload is too large");
    }
    return hash_fn(static_cast<const unsigned char *>(view.ptr), static_cast<int32_t>(byte_length), seed);
  };

  m.def(
      "fast_hash_32",
      [fast_hash_buffer](py::buffer payload, uint32_t seed) {
        return fast_hash_buffer(payload, seed, yijinjing::fast_hash_32);
      },
      py::arg("payload"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def(
      "fast_hash_64",
      [fast_hash_buffer](py::buffer payload, uint32_t seed) {
        return fast_hash_buffer(payload, seed, yijinjing::fast_hash_64);
      },
      py::arg("payload"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def("fast_hash_str_32", &yijinjing::fast_hash_str_32, py::arg("key"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def("fast_hash_str_64", &yijinjing::fast_hash_str_64, py::arg("key"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def(
      "fast_hash_string_32",
      [](const std::string &key, uint32_t seed) { return py::bytes(yijinjing::fast_hash_string_32(key, seed)); },
      py::arg("key"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def(
      "fast_hash_string_64",
      [](const std::string &key, uint32_t seed) { return py::bytes(yijinjing::fast_hash_string_64(key, seed)); },
      py::arg("key"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def(
      "fast_hash_string_128",
      [](const std::string &key, uint32_t seed) { return py::bytes(yijinjing::fast_hash_string_128(key, seed)); },
      py::arg("key"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def(
      "hash_32",
      [fast_hash_buffer](py::buffer payload, uint32_t seed) {
        return fast_hash_buffer(payload, seed, yijinjing::fast_hash_32);
      },
      py::arg("payload"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def("hash_str_32", &yijinjing::fast_hash_str_32, py::arg("key"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.attr("FAST_HASH_ALGORITHM") = yijinjing::FAST_HASH_ALGORITHM;
  m.attr("FAST_HASH_ALGORITHM_64") = yijinjing::FAST_HASH_ALGORITHM_64;
  m.attr("FAST_HASH_ALGORITHM_128") = yijinjing::FAST_HASH_ALGORITHM_128;
  m.attr("FRAME_INTEGRITY_VERSION_V1") = action::FRAME_INTEGRITY_VERSION_V1;
  m.attr("FRAME_INTEGRITY_VERSION_V2") = action::FRAME_INTEGRITY_VERSION_V2;
  m.attr("DEFAULT_FRAME_INTEGRITY_VERSION") = action::DEFAULT_FRAME_INTEGRITY_VERSION;
  m.attr("FRAME_CHECKSUM_ALGORITHM_FNV1A64") = action::FRAME_CHECKSUM_ALGORITHM_FNV1A64;
  m.attr("FRAME_CHECKSUM_ALGORITHM_CRC32C") = action::FRAME_CHECKSUM_ALGORITHM_CRC32C;
  m.attr("DEFAULT_FRAME_CHECKSUM_ALGORITHM") = action::DEFAULT_FRAME_CHECKSUM_ALGORITHM;
  m.def("is_supported_frame_checksum_algorithm", &action::is_supported_frame_checksum_algorithm, py::arg("algorithm"));
  m.def("frame_checksum_algorithm_for_integrity_version", &action::frame_checksum_algorithm_for_integrity_version,
        py::arg("integrity_version"));
  m.def("frame_integrity_version_for_checksum_algorithm", &action::frame_integrity_version_for_checksum_algorithm,
        py::arg("algorithm"));
  m.def(
      "checksum_payload",
      [](py::buffer payload, const std::string &algorithm) {
        const auto view = payload.request();
        return action::checksum_payload(static_cast<const uint8_t *>(view.ptr),
                                        static_cast<uint32_t>(view.size * view.itemsize), algorithm);
      },
      py::arg("payload"), py::arg("algorithm") = action::DEFAULT_FRAME_CHECKSUM_ALGORITHM);
  m.attr("CONTENT_HASH_ALGORITHM_SHA256") = yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256;
  m.attr("CONTENT_HASH_ALGORITHM_BLAKE3") = yijinjing::storage::CONTENT_HASH_ALGORITHM_BLAKE3;
  m.def("is_supported_content_hash_algorithm", &yijinjing::storage::is_supported_content_hash_algorithm,
        py::arg("algorithm"));
  m.def("normalize_content_hash_algorithm", &yijinjing::storage::normalize_content_hash_algorithm,
        py::arg("algorithm"));
  m.def(
      "compute_content_hash_value",
      [](py::buffer payload, const std::string &algorithm) {
        const auto view = payload.request();
        return yijinjing::storage::compute_content_hash_value(view.ptr, static_cast<size_t>(view.size * view.itemsize),
                                                              algorithm);
      },
      py::arg("payload"), py::arg("algorithm") = yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
  m.def(
      "compute_content_hash",
      [](py::buffer payload, const std::string &algorithm) {
        const auto view = payload.request();
        return yijinjing::storage::format_content_hash(yijinjing::storage::compute_content_hash(
            view.ptr, static_cast<size_t>(view.size * view.itemsize), algorithm));
      },
      py::arg("payload"), py::arg("algorithm") = yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
  m.def(
      "format_content_hash",
      [](const std::string &algorithm, const std::string &value) {
        return yijinjing::storage::format_content_hash(yijinjing::storage::make_content_hash(value, algorithm));
      },
      py::arg("algorithm"), py::arg("value"));
  m.def(
      "parse_content_hash",
      [](const std::string &formatted) {
        const auto parsed = yijinjing::storage::parse_content_hash(formatted);
        return py::make_tuple(parsed.algorithm, parsed.value);
      },
      py::arg("formatted"));
  m.def(
      "verify_content_hash",
      [](py::buffer payload, const std::string &expected, const std::string &algorithm) {
        const auto parsed = algorithm.empty() ? yijinjing::storage::parse_content_hash(expected)
                                              : yijinjing::storage::make_content_hash(expected, algorithm);
        const auto view = payload.request();
        return yijinjing::storage::verify_content_hash(view.ptr, static_cast<size_t>(view.size * view.itemsize),
                                                       parsed);
      },
      py::arg("payload"), py::arg("expected"), py::arg("algorithm") = "");
  m.def(
      "storage_sync_root_entry_commitment",
      [](py::dict entry) { return json_to_py(yijinjing::storage::make_sync_root_entry_commitment(py_to_json(entry))); },
      py::arg("entry"));
  m.def(
      "compute_storage_sync_root",
      [](py::iterable entries) {
        return json_to_py(yijinjing::storage::compute_linear_sync_root(py_entries_to_json(entries)));
      },
      py::arg("entries"));
  m.def(
      "verify_storage_sync_root",
      [](py::object actual, py::iterable entries) {
        py::list result;
        for (const auto &issue :
             yijinjing::storage::verify_linear_sync_root(py_to_json(actual), py_entries_to_json(entries))) {
          py::dict item;
          item["code"] = issue.code;
          if (!issue.field.empty()) {
            item["field"] = issue.field;
          }
          if (!issue.expected.is_null()) {
            item["expected"] = json_to_py(issue.expected);
          }
          if (!issue.actual.is_null()) {
            item["actual"] = json_to_py(issue.actual);
          }
          result.append(item);
        }
        return result;
      },
      py::arg("actual"), py::arg("entries"));
  m.def(
      "verify_storage_payload",
      [](py::buffer payload, const std::string &expected_hash, uint64_t expected_byte_length,
         const std::string &algorithm) {
        const auto view = payload.request();
        return yijinjing::storage::verify_payload_ref(view.ptr, static_cast<size_t>(view.size * view.itemsize),
                                                      expected_hash, expected_byte_length, algorithm);
      },
      py::arg("payload"), py::arg("expected_hash"), py::arg("expected_byte_length"),
      py::arg("algorithm") = yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
  m.def(
      "filter_storage_manifest_entries",
      [](py::iterable entries, py::dict range_filter) {
        return json_to_py(
            yijinjing::storage::filter_storage_manifest_entries(py_to_json(entries), py_to_json(range_filter)));
      },
      py::arg("entries"), py::arg("range_filter"));
  m.def(
      "verify_storage_import_manifest",
      [](py::dict manifest) {
        py::list result;
        for (const auto &issue : yijinjing::storage::verify_storage_import_manifest(py_to_json(manifest))) {
          py::dict item;
          item["severity"] = issue.severity;
          item["code"] = issue.code;
          if (!issue.path.empty()) {
            item["path"] = issue.path;
          }
          if (!issue.message.empty()) {
            item["message"] = issue.message;
          }
          if (!issue.expected.is_null()) {
            item["expected"] = json_to_py(issue.expected);
          }
          if (!issue.actual.is_null()) {
            item["actual"] = json_to_py(issue.actual);
          }
          result.append(item);
        }
        return result;
      },
      py::arg("manifest"));
  m.def(
      "build_storage_export_bundle",
      [](py::dict manifest, py::iterable records) {
        return json_to_py(yijinjing::storage::build_storage_export_bundle(py_to_json(manifest), py_to_json(records)));
      },
      py::arg("manifest"), py::arg("records"));
  m.def("storage_service_capabilities",
        []() { return json_to_py(storage_service_api::storage_service_capabilities()); });
  m.def(
      "storage_status_typed",
      [](const std::string &runtime_dir, const std::optional<std::string> &source_id) {
        storage_service_api::storage_status_request request{};
        request.runtime_dir = runtime_dir;
        if (source_id.has_value())
          request.source_id = *source_id;
        return hana_view_to_py(storage_service_api::default_storage_service().status(request));
      },
      py::arg("runtime_dir"), py::arg("source_id") = py::none());
  m.def(
      "storage_query_typed",
      [](const std::string &runtime_dir, const std::string &query, const std::optional<std::string> &source_id,
         const std::optional<std::string> &entry_kind, uint64_t episode_id, uint64_t limit, const std::string &since,
         const std::string &until) {
        storage_service_api::storage_query_request request{};
        request.runtime_dir = runtime_dir;
        request.query = storage_service_api::parse_storage_query_kind(query);
        request.source_id = source_id.value_or("");
        request.entry_kind = entry_kind.value_or("");
        request.episode_id = episode_id;
        request.limit = limit;
        request.range = {since, until};
        return hana_view_to_py(storage_service_api::default_storage_service().query(request));
      },
      py::arg("runtime_dir"), py::arg("query"), py::arg("source_id") = py::none(), py::arg("entry_kind") = py::none(),
      py::arg("episode_id") = 0, py::arg("limit") = 100, py::arg("since") = "", py::arg("until") = "");
  m.def(
      "storage_gc_plan_typed",
      [](const std::string &runtime_dir, const std::optional<std::string> &source_id, bool dry_run) {
        storage_service_api::storage_gc_plan_request request{};
        request.runtime_dir = runtime_dir;
        request.source_id = source_id.value_or("");
        request.dry_run = dry_run;
        return hana_view_to_py(storage_service_api::default_storage_service().gc_plan(request));
      },
      py::arg("runtime_dir"), py::arg("source_id") = py::none(), py::arg("dry_run") = true);
  m.def(
      "storage_rebuild_index_typed",
      [](const std::string &runtime_dir, const std::optional<std::string> &source_id, bool dry_run) {
        storage_service_api::storage_rebuild_index_request request{};
        request.runtime_dir = runtime_dir;
        request.source_id = source_id.value_or("");
        request.dry_run = dry_run;
        return hana_view_to_py(storage_service_api::default_storage_service().rebuild_index(request));
      },
      py::arg("runtime_dir"), py::arg("source_id") = py::none(), py::arg("dry_run") = true);
  m.def(
      "storage_compact_plan_typed",
      [](const std::string &runtime_dir, const std::optional<std::string> &source_id, bool dry_run) {
        storage_service_api::storage_compact_plan_request request{};
        request.runtime_dir = runtime_dir;
        request.source_id = source_id.value_or("");
        request.dry_run = dry_run;
        return hana_view_to_py(storage_service_api::default_storage_service().compact_plan(request));
      },
      py::arg("runtime_dir"), py::arg("source_id") = py::none(), py::arg("dry_run") = true);
  m.def(
      "storage_fsck_typed",
      [](const std::string &runtime_dir, const std::optional<std::string> &source_id, uint64_t episode_id,
         bool verify_frames) {
        storage_service_api::storage_fsck_request request{};
        request.runtime_dir = runtime_dir;
        request.source_id = source_id.value_or("");
        request.episode_id = episode_id;
        request.verify_frames = verify_frames;
        request.scope = episode_id != 0 || verify_frames
                            ? storage_service_api::storage_fsck_scope::Episode
                            : (request.source_id.empty() ? storage_service_api::storage_fsck_scope::All
                                                         : storage_service_api::storage_fsck_scope::Source);
        return hana_view_to_py(storage_service_api::default_storage_service().fsck(request));
      },
      py::arg("runtime_dir"), py::arg("source_id") = py::none(), py::arg("episode_id") = 0,
      py::arg("verify_frames") = false);
  m.def(
      "storage_repair_plan_typed",
      [](const std::string &runtime_dir, const std::optional<std::string> &source_id, uint64_t episode_id,
         bool verify_frames, bool dry_run) {
        storage_service_api::storage_repair_plan_request request{};
        request.runtime_dir = runtime_dir;
        request.source_id = source_id.value_or("");
        request.episode_id = episode_id;
        request.verify_frames = verify_frames;
        request.dry_run = dry_run;
        request.scope = episode_id != 0 || verify_frames
                            ? storage_service_api::storage_fsck_scope::Episode
                            : (request.source_id.empty() ? storage_service_api::storage_fsck_scope::All
                                                         : storage_service_api::storage_fsck_scope::Source);
        return hana_view_to_py(storage_service_api::default_storage_service().repair_plan(request));
      },
      py::arg("runtime_dir"), py::arg("source_id") = py::none(), py::arg("episode_id") = 0,
      py::arg("verify_frames") = false, py::arg("dry_run") = true);
  m.def(
      "storage_episode_begin_typed",
      [](const std::string &runtime_dir, uint64_t episode_id, uint64_t parent_episode_id,
         uint64_t root_trigger_frame_uid, uint32_t location_uid, int64_t begin_time, const std::string &title,
         const std::string &actor, const std::string &source) {
        storage_service_api::storage_episode_begin_request request{};
        request.runtime_dir = runtime_dir;
        request.options = {
            episode_id, parent_episode_id, root_trigger_frame_uid, location_uid, begin_time, title, actor, source};
        return hana_view_to_py(storage_service_api::default_storage_service().episode_begin(request));
      },
      py::arg("runtime_dir"), py::arg("episode_id") = 0, py::arg("parent_episode_id") = 0,
      py::arg("root_trigger_frame_uid") = 0, py::arg("location_uid") = 0, py::arg("begin_time") = 0,
      py::arg("title") = "", py::arg("actor") = "", py::arg("source") = "");
  m.def(
      "storage_episode_heartbeat_typed",
      [](const std::string &runtime_dir, uint64_t episode_id, uint32_t location_uid, int64_t update_time,
         uint64_t last_frame_uid, uint64_t frame_count, const std::string &note) {
        storage_service_api::storage_episode_heartbeat_request request{};
        request.runtime_dir = runtime_dir;
        request.options = {episode_id, location_uid, update_time, last_frame_uid, frame_count, note};
        return hana_view_to_py(storage_service_api::default_storage_service().episode_heartbeat(request));
      },
      py::arg("runtime_dir"), py::arg("episode_id"), py::arg("location_uid") = 0, py::arg("update_time") = 0,
      py::arg("last_frame_uid") = 0, py::arg("frame_count") = 0, py::arg("note") = "");
  m.def(
      "storage_episode_attach_frame_typed",
      [](const std::string &runtime_dir, uint64_t episode_id, uint64_t frame_uid, uint32_t location_uid,
         uint64_t trigger_frame_uid, uint64_t stream_id, int64_t gen_time, int64_t trigger_time, int32_t carrier_type,
         uint32_t source, uint32_t dest, uint32_t data_length, uint32_t integrity_version, uint64_t payload_checksum,
         uint64_t frame_checksum) {
        storage_service_api::storage_episode_frame_attach_request request{};
        request.runtime_dir = runtime_dir;
        request.options = {episode_id,       location_uid,  frame_uid,    trigger_frame_uid,
                           stream_id,        gen_time,      trigger_time, carrier_type,
                           source,           dest,          data_length,  integrity_version,
                           payload_checksum, frame_checksum};
        return hana_view_to_py(storage_service_api::default_storage_service().episode_attach_frame(request));
      },
      py::arg("runtime_dir"), py::arg("episode_id"), py::arg("frame_uid"), py::arg("location_uid") = 0,
      py::arg("trigger_frame_uid") = 0, py::arg("stream_id") = 0, py::arg("gen_time") = 0, py::arg("trigger_time") = 0,
      py::arg("carrier_type") = 0, py::arg("source") = 0, py::arg("dest") = 0, py::arg("data_length") = 0,
      py::arg("integrity_version") = 0, py::arg("payload_checksum") = 0, py::arg("frame_checksum") = 0);
  m.def(
      "storage_episode_attach_ref_typed",
      [](const std::string &runtime_dir, uint64_t episode_id, const std::string &ref_kind, uint64_t ref_uid,
         const std::string &ref_id, const std::string &ref_hash, uint32_t location_uid, int64_t update_time) {
        storage_service_api::storage_episode_ref_attach_request request{};
        request.runtime_dir = runtime_dir;
        request.options = {episode_id,
                           location_uid,
                           ref_kind == "payload"   ? EpisodeRefKind::Payload
                           : ref_kind == "schema"  ? EpisodeRefKind::Schema
                           : ref_kind == "episode" ? EpisodeRefKind::Episode
                                                   : EpisodeRefKind::InputFrame,
                           ref_uid,
                           update_time,
                           ref_id,
                           ref_hash};
        return hana_view_to_py(storage_service_api::default_storage_service().episode_attach_ref(request));
      },
      py::arg("runtime_dir"), py::arg("episode_id"), py::arg("ref_kind") = "input_frame", py::arg("ref_uid") = 0,
      py::arg("ref_id") = "", py::arg("ref_hash") = "", py::arg("location_uid") = 0, py::arg("update_time") = 0);
  m.def(
      "storage_episode_close_typed",
      [](const std::string &runtime_dir, uint64_t episode_id, bool aborted, uint32_t location_uid, int64_t end_time,
         uint64_t last_frame_uid, uint64_t frame_count, const std::string &reason) {
        storage_service_api::storage_episode_close_request request{};
        request.runtime_dir = runtime_dir;
        request.options = {episode_id, location_uid,   aborted ? EpisodeStatus::Aborted : EpisodeStatus::Ended,
                           end_time,   last_frame_uid, frame_count,
                           reason};
        const auto &service = storage_service_api::default_storage_service();
        return hana_view_to_py(aborted ? service.episode_abort(request) : service.episode_end(request));
      },
      py::arg("runtime_dir"), py::arg("episode_id"), py::arg("aborted") = false, py::arg("location_uid") = 0,
      py::arg("end_time") = 0, py::arg("last_frame_uid") = 0, py::arg("frame_count") = 0, py::arg("reason") = "");
  m.def(
      "storage_episode_recover_typed",
      [](const std::string &runtime_dir, uint64_t episode_id, uint32_t location_uid, int64_t end_time,
         const std::string &reason) {
        storage_service_api::storage_episode_recover_request request{};
        request.runtime_dir = runtime_dir;
        request.options = {episode_id, location_uid, end_time, reason};
        return hana_view_to_py(storage_service_api::default_storage_service().episode_recover(request));
      },
      py::arg("runtime_dir"), py::arg("episode_id") = 0, py::arg("location_uid") = 0, py::arg("end_time") = 0,
      py::arg("reason") = "");
  m.def(
      "storage_episode_projection_rebuild_typed",
      [](const std::string &runtime_dir) {
        return hana_view_to_py(storage_service_api::default_storage_service().episode_projection_rebuild(
            storage_service_api::storage_episode_projection_rebuild_request{runtime_dir}));
      },
      py::arg("runtime_dir"));
  m.def(
      "make_storage_service_request",
      [](const std::string &operation, const std::string &runtime_dir, py::dict options) {
        return json_to_py(
            storage_service_api::make_storage_service_request(operation, runtime_dir, py_to_json(options)));
      },
      py::arg("operation"), py::arg("runtime_dir"), py::arg("options") = py::dict());
  m.def(
      "run_storage_service_operation",
      [](const std::string &operation, const std::string &runtime_dir, py::dict options) {
        return json_to_py(
            storage_service_api::run_storage_service_operation(operation, runtime_dir, py_to_json(options)));
      },
      py::arg("operation"), py::arg("runtime_dir"), py::arg("options") = py::dict());
  m.def(
      "accept_storage_manifest",
      [](const std::string &runtime_dir, py::dict manifest) {
        return json_to_py(storage_service_api::accept_storage_manifest(runtime_dir, py_to_json(manifest)));
      },
      py::arg("runtime_dir"), py::arg("manifest"));
  m.def(
      "load_storage_latest_manifest",
      [](const std::string &runtime_dir, const std::string &source_id) {
        return json_to_py(storage_service_api::load_storage_latest_manifest(runtime_dir, source_id));
      },
      py::arg("runtime_dir"), py::arg("source_id"));
  m.def(
      "export_storage_records",
      [](const std::string &runtime_dir, const std::string &source_id, py::dict range_filter) {
        return json_to_py(
            storage_service_api::export_storage_records(runtime_dir, source_id, py_to_json(range_filter)));
      },
      py::arg("runtime_dir"), py::arg("source_id"), py::arg("range_filter") = py::dict());
  // The content-store facade releases the GIL around the C++ call so Python
  // threads genuinely share the process-cached provider (the concurrency the
  // service-level lifecycle guarantees); conversions between Python and C++
  // values stay under the GIL on both sides of the release window.
  m.def(
      "write_storage_payload_bytes",
      [](const std::string &runtime_dir, const std::string &digest, py::bytes payload) {
        const std::string raw = payload;
        py::gil_scoped_release release;
        return storage_service_api::write_storage_payload_bytes(runtime_dir, digest, raw);
      },
      py::arg("runtime_dir"), py::arg("digest"), py::arg("payload"));
  m.def(
      "content_store_put_if_absent",
      [](const std::string &runtime_dir, const std::string &content_namespace, py::bytes payload,
         const std::string &expected_hash) {
        const std::string raw = payload;
        nlohmann::json result;
        {
          py::gil_scoped_release release;
          result = storage_service_api::content_store_put_if_absent(runtime_dir, content_namespace, raw, expected_hash);
        }
        return json_to_py(result);
      },
      py::arg("runtime_dir"), py::arg("content_namespace"), py::arg("payload"), py::arg("expected_hash") = "");
  m.def("content_store_has", &storage_service_api::content_store_has, py::call_guard<py::gil_scoped_release>(),
        py::arg("runtime_dir"), py::arg("content_namespace"), py::arg("content_hash"));
  m.def(
      "content_store_verify",
      [](const std::string &runtime_dir, const std::string &content_namespace, const std::string &content_hash) {
        nlohmann::json result;
        {
          py::gil_scoped_release release;
          result = storage_service_api::content_store_verify(runtime_dir, content_namespace, content_hash);
        }
        return json_to_py(result);
      },
      py::arg("runtime_dir"), py::arg("content_namespace"), py::arg("content_hash"));
  m.def(
      "content_store_get",
      [](const std::string &runtime_dir, const std::string &content_namespace, const std::string &content_hash) {
        std::string bytes;
        {
          py::gil_scoped_release release;
          bytes = storage_service_api::content_store_get(runtime_dir, content_namespace, content_hash);
        }
        return py::bytes(bytes);
      },
      py::arg("runtime_dir"), py::arg("content_namespace"), py::arg("content_hash"));
  m.def(
      "content_store_capabilities",
      [](const std::string &runtime_dir) {
        nlohmann::json result;
        {
          py::gil_scoped_release release;
          result = storage_service_api::content_store_capabilities(runtime_dir);
        }
        return json_to_py(result);
      },
      py::arg("runtime_dir"));

  m.def("setup_log", &yijinjing::log::setup_log);
  m.def("emit_log", &yijinjing::log::emit_log);

  py::enum_<nanomsg::protocol>(m, "protocol", py::arithmetic(), "Nanomsg Protocol")
      .value("REPLY", nanomsg::protocol::REPLY)
      .value("REQUEST", nanomsg::protocol::REQUEST)
      .value("PUSH", nanomsg::protocol::PUSH)
      .value("PULL", nanomsg::protocol::PULL)
      .value("PUBLISH", nanomsg::protocol::PUBLISH)
      .value("SUBSCRIBE", nanomsg::protocol::SUBSCRIBE)
      .export_values();

  auto event_class = py::class_<event, PyEvent, std::shared_ptr<event>>(m, "event");
  event_class.def_property_readonly("gen_time", &event::gen_time)
      .def_property_readonly("trigger_time", &event::trigger_time)
      .def_property_readonly("frame_uid", &event::frame_uid)
      .def_property_readonly("trigger_frame_uid", &event::trigger_frame_uid)
      .def_property_readonly("stream_id", &event::stream_id)
      .def_property_readonly("source", &event::source)
      .def_property_readonly("initial_source", &event::initial_source)
      .def_property_readonly("dest", &event::dest)
      .def_property_readonly("carrier_type", &event::carrier_type)
      .def_property_readonly("data_length", &event::data_length)
      .def_property_readonly("data_type", &event::data_type)
      .def_property_readonly("is_json", &event::is_json)
      .def_property_readonly("data_as_bytes", &event::data_as_bytes)
      .def_property_readonly("data_as_byte_array", &event::data_as_byte_array)
      .def_property_readonly("data_as_string", &event::data_as_string)
      .def("to_string", &event::to_string);

  py::class_<frame, event, frame_ptr>(m, "frame")
      .def_property_readonly("frame_length", &frame::frame_length)
      .def("has_data", &frame::has_data);

  py::class_<action::record_options>(m, "action_record_options")
      .def(py::init<>())
      .def_readwrite("gen_time", &action::record_options::gen_time)
      .def_readwrite("trigger_time", &action::record_options::trigger_time)
      .def_readwrite("parent_frame_uid", &action::record_options::parent_frame_uid)
      .def_readwrite("stream_id", &action::record_options::stream_id)
      .def_readwrite("chain_to_last", &action::record_options::chain_to_last)
      .def_readwrite("data_type", &action::record_options::data_type);

  py::class_<action::record_receipt>(m, "action_record_receipt")
      .def_readonly("frame_uid", &action::record_receipt::frame_uid)
      .def_readonly("trigger_frame_uid", &action::record_receipt::trigger_frame_uid)
      .def_readonly("stream_id", &action::record_receipt::stream_id)
      .def_readonly("gen_time", &action::record_receipt::gen_time)
      .def_readonly("trigger_time", &action::record_receipt::trigger_time)
      .def_readonly("carrier_type", &action::record_receipt::carrier_type)
      .def_readonly("source", &action::record_receipt::source)
      .def_readonly("initial_source", &action::record_receipt::initial_source)
      .def_readonly("dest", &action::record_receipt::dest)
      .def_readonly("data_length", &action::record_receipt::data_length)
      .def_readonly("data_type", &action::record_receipt::data_type)
      .def_readonly("integrity_version", &action::record_receipt::integrity_version)
      .def_readonly("checksum_algorithm", &action::record_receipt::checksum_algorithm)
      .def_readonly("payload_checksum", &action::record_receipt::payload_checksum)
      .def_readonly("frame_checksum", &action::record_receipt::frame_checksum);

  py::class_<action::action_recorder, action::action_recorder_ptr>(m, "action_recorder")
      .def(py::init<const std::string &, const std::string &, const std::string &, uint32_t, uint64_t>(),
           py::arg("runtime_dir"), py::arg("namespace"), py::arg("name"),
           py::arg("dest_id") = yijinjing::data::location::PUBLIC, py::arg("stream_id") = 0)
      .def(
          "record_bytes",
          [](action::action_recorder &recorder, int32_t carrier_type, py::bytes payload,
             action::record_options options) {
            std::string bytes = payload;
            return recorder.record_bytes(carrier_type, std::vector<uint8_t>(bytes.begin(), bytes.end()), options);
          },
          py::arg("carrier_type"), py::arg("payload"),
          py::arg_v("options", action::record_options{}, "action_record_options()"))
      .def("record_json", &action::action_recorder::record_json, py::arg("carrier_type"), py::arg("json_payload"),
           py::arg_v("options", action::record_options{}, "action_record_options()"))
      .def("mark", &action::action_recorder::mark, py::arg("carrier_type"),
           py::arg_v("options", action::record_options{}, "action_record_options()"))
      .def_property_readonly("last_frame_uid", &action::action_recorder::last_frame_uid);

  auto location_class = py::class_<location, location_ptr>(m, "location");
  location_class
      .def(py::init<mode, location_role, const std::string &, const std::string &, locator_ptr, uint32_t>(),
           py::arg("m"), py::arg("c"), py::arg("namespace"), py::arg("n"), py::arg("l"),
           py::arg("default_seed") = KUNGFU_HASH_SEED)
      .def_readonly("mode", &location::mode)
      .def_readonly("role", &location::role)
      .def_readonly("namespace", &location::namespace_)
      .def_readonly("name", &location::name)
      .def_readonly("uname", &location::uname)
      .def_readonly("uid", &location::uid)
      .def_readonly("locator", &location::locator)
      .def("__repr__", [&](location &target) { return target.uname; });
  location_class.def("to", py::overload_cast<Config &>(&location::to<Config>, py::const_));
  location_class.def("to", py::overload_cast<Register &>(&location::to<Register>, py::const_));
  location_class.def("to", py::overload_cast<Deregister &>(&location::to<Deregister>, py::const_));
  location_class.def("to", py::overload_cast<Location &>(&location::to<Location>, py::const_));

  py::class_<locator, PyLocator, locator_ptr>(m, "locator")
      .def(py::init())
      .def(py::init<const std::string &>())
      .def(py::init<const std::string &, mode>())
      .def(py::init<mode, const std::vector<std::string> &>(), py::arg("mode"),
           py::arg("tags") = std::vector<std::string>{})
      .def("has_env", &locator::has_env)
      .def("get_env", &locator::get_env)
      .def("layout_dir", &locator::layout_dir)
      .def("layout_file", &locator::layout_file)
      .def("get_root", &locator::get_root)
      .def("list_page_id", &locator::list_page_id)
      .def("list_locations", &locator::list_locations, py::arg("role") = "*", py::arg("namespace") = "*",
           py::arg("name") = "*", py::arg("mode") = "*")
      .def("list_location_dest", &locator::list_location_dest);

  py::class_<nanomsg::socket, socket_ptr>(m, "socket")
      .def(py::init<protocol>(), py::arg("protocol"))
      .def("setsockopt", &socket::setsockopt_str, py::arg("option"), py::arg("value"))
      .def("setsockopt", &socket::setsockopt_int, py::arg("option"), py::arg("value"))
      .def("setsockopt", &socket::setsockopt_ms, py::arg("option"), py::arg("value"))
      .def("getsockopt", &socket::getsockopt_int, py::arg("option"))
      .def("getsockopt", &socket::getsockopt_ms, py::arg("option"))
      .def("listen", &socket::listen, py::arg("url"), py::arg("flags") = 0)
      .def("dial", &socket::dial, py::arg("url"), py::arg("flags") = 0)
      .def("close", &socket::close)
      .def("send", &socket::send, py::arg("msg"), py::arg("flags") = 0, py::arg("no_exception") = false)
      .def("recv", &socket::recv_msg, py::arg("flags") = 0)
      .def("last_message", &socket::last_message);

  py::class_<publisher, PyPublisher, publisher_ptr>(m, "publisher")
      .def("publish", &publisher::publish)
      .def("notify", &publisher::notify);

  // standalone python journal writers (e.g. the rewind capture supervisor)
  // need the same no-op publisher the C++ slices use
  py::class_<journal::noop_publisher, publisher, std::shared_ptr<journal::noop_publisher>>(m, "noop_publisher")
      .def(py::init<>());

  py::class_<observer, PyObserver, observer_ptr>(m, "observer")
      .def("wait", &observer::wait)
      .def("get_notice", &observer::get_notice);

  py::class_<reader, reader_ptr>(m, "reader")
      .def(py::init<bool, bool, bus_ptr>())
      .def(py::init<const reader &>())
      .def("subscribe", &reader::join)
      .def("current_frame", &reader::current_frame)
      .def("seek_to_time", &reader::seek_to_time)
      .def("data_available", &reader::data_available)
      .def("next", &reader::next)
      .def("join", &reader::join, py::arg("location"), py::arg("dest_id"), py::arg("from_time"),
           py::arg("page_size") = 0, py::arg("priority") = Priority::Medium)
      .def("disjoin", &reader::disjoin)
      .def("disjoin_channel", &reader::disjoin_channel);

  py::class_<bus, bus_ptr>(m, "bus").def(py::init<bool>()).def("on_load_page", &bus::on_load_page);

  auto writer_class = py::class_<writer, writer_ptr>(m, "writer");
  writer_class
      .def(py::init<const yijinjing::data::location_ptr &, uint32_t, bool, publisher_ptr, bool, const bus_ptr &,
                    uint32_t>())
      .def("current_frame_uid", &writer::current_frame_uid)
      .def("get_location", &writer::get_location)
      .def("get_dest", &writer::get_dest)
      .def("copy_frame", &writer::copy_frame)
      .def("mark", &writer::mark)
      .def("mark_at", &writer::mark_at)
      .def("write_bytes", &writer::write_bytes);

  py::class_<sink, PySink, sink_ptr>(m, "sink")
      .def(py::init())
      .def_property_readonly("publisher", &sink::get_publisher)
      .def_property_readonly("bus", &sink::get_bus)
      .def("put", &sink::put)
      .def("find_page_size", &sink::find_page_size)
      .def("close", &sink::close);

  py::class_<null_sink, sink, std::shared_ptr<null_sink>>(m, "null_sink").def(py::init<>());

  py::class_<copy_sink, sink, std::shared_ptr<copy_sink>>(m, "copy_sink")
      .def(py::init<yijinjing::data::locator_ptr>())
      .def("put", &copy_sink::put);

  auto assemble_class = py::class_<assemble, assemble_ptr>(m, "assemble");
  assemble_class
      .def(py::init<const std::vector<yijinjing::data::locator_ptr> &, const std::string &, const std::string &,
                    const std::string &, const std::string &>(),
           py::arg("locators"), py::arg("mode") = "*", py::arg("role") = "*", py::arg("namespace") = "*",
           py::arg("name") = "*")
      .def(py::init<const yijinjing::data::location_ptr &, uint32_t, uint32_t, int64_t>(), py::arg("source_location"),
           py::arg("dest_id"), py::arg("assemble_mode") = yijinjing::enums::AssembleMode::Channel,
           py::arg("from_time") = 0)
      .def("read_headers", (std::vector<frame_header> (assemble::*)(int32_t, int64_t))&assemble::read_headers,
           py::arg("carrier_type"), py::arg("end_time") = INT64_MAX, py::return_value_policy::move)
      .def("read_bytes",
           (std::vector<std::pair<yijinjing::types::frame_header, std::vector<uint8_t>>> (assemble::*)(
               int32_t, int64_t))&assemble::read_bytes,
           py::arg("carrier_type"), py::arg("end_time") = INT64_MAX, py::return_value_policy::move)
      .def("__plus__", &assemble::operator+)
      .def("__rshift__", &assemble::operator>>);

  py::class_<io_device, kungfu::runtime::io_device_ptr>(m, "io_device")
      .def(py::init<location_ptr, bool, bool>(), py::arg("home"), py::arg("low_latency") = false,
           py::arg("lazy") = true)
      .def_property_readonly("publisher", &io_device::get_publisher)
      .def_property_readonly("bus", &io_device::get_bus)
      .def_property_readonly("observer", &io_device::get_observer)
      .def_property_readonly("home", &io_device::get_home)
      .def_property_readonly("live_home", &io_device::get_live_home)
      .def("is_usable", &io_device::is_usable)
      .def("setup", &io_device::setup)
      .def("open_reader", &io_device::open_reader)
      .def("open_reader_to_subscribe", &io_device::open_reader_to_subscribe)
      .def("open_writer", &io_device::open_writer);

  py::class_<kungfu::runtime::io_device_master, io_device, io_device_master_ptr>(m, "kungfu::runtime::io_device_master")
      .def(py::init<location_ptr, bool>(), py::arg("home"), py::arg("low_latency"));

  py::class_<kungfu::runtime::io_device_client, io_device, io_device_client_ptr>(m, "kungfu::runtime::io_device_client")
      .def(py::init<location_ptr, bool>(), py::arg("home"), py::arg("low_latency"));

  py::class_<kungfu::runtime::io_device_console, io_device, io_device_console_ptr>(m,
                                                                                   "kungfu::runtime::io_device_console")
      .def(py::init<location_ptr, uint32_t, uint32_t>(), py::arg("home"), py::arg("width"), py::arg("height"))
      .def("trace", &kungfu::runtime::io_device_console::trace)
      .def("show", &kungfu::runtime::io_device_console::show);

  py::class_<session_finder, std::shared_ptr<session_finder>>(m, "session_finder")
      .def(py::init<kungfu::runtime::io_device_ptr>())
      .def("find_sessions", &session_finder::find_sessions, py::arg("from") = 0, py::arg("to") = INT64_MAX)
      .def("find_sessions_for", &session_finder::find_sessions_for, py::arg("source"), py::arg("from") = 0,
           py::arg("to") = INT64_MAX);

  py::class_<session_builder, session_finder, std::shared_ptr<session_builder>>(m, "session_builder")
      .def(py::init<kungfu::runtime::io_device_ptr>())
      .def("rebuild_index_db", &session_builder::rebuild_index_db)
      .def("update_index_db", &session_builder::update_index_db);

  auto profile_class = py::class_<profile, std::shared_ptr<profile>>(m, "profile");
  profile_class.def(py::init<const locator_ptr &>());
  boost::hana::for_each(yijinjing::CorePublicProfileDataTypes, [&](auto type) {
    using DataType = typename decltype(+boost::hana::second(type))::type;
    profile_class.def("set", &profile::set<DataType>);
    profile_class.def("get", &profile::get<DataType>);
    profile_class.def("get_all", &profile::get_all<DataType>);
    profile_class.def("remove", &profile::remove<DataType>);
  });

  py::class_<master, PyMaster>(m, "master")
      .def(py::init<location_ptr, bool>(), py::arg("home"), py::arg("low_latency") = false)
      .def_property_readonly("io_device", &master::get_io_device)
      .def_property_readonly("home", &master::get_home)
      .def_property_readonly("live", &master::is_live)
      .def("get_begin_time", &master::get_begin_time)
      .def("get_end_time", &master::get_end_time)
      .def("get_home_uid", &master::get_home_uid)
      .def("get_home_uname", &master::get_home_uname)
      .def("now", &master::now)
      .def("run", &master::run, py::arg("step_limit") = 0)
      .def("pre_setup", &master::pre_setup)
      .def("setup", &master::setup)
      .def("step", &master::step)
      .def("is_live", &master::is_live)
      .def("on_exit", &master::on_exit)
      .def("on_register", &master::on_register)
      .def("check_register", &master::check_register)
      .def("on_interval_check", &master::on_interval_check)
      .def("deregister_app", &master::deregister_app);

  py::class_<apprentice, PyApprentice, apprentice_ptr>(m, "apprentice")
      .def(py::init<location_ptr, bool, std::string>(), py::arg("home"), py::arg("low_latency") = false,
           py::arg("arguments") = "{}")
      .def_property_readonly("io_device", &apprentice::get_io_device)
      .def_property_readonly("home", &apprentice::get_home)
      .def_property_readonly("live", &apprentice::is_live)
      .def("set_begin_time", &apprentice::set_begin_time)
      .def("set_end_time", &apprentice::set_end_time)
      .def("get_begin_time", &apprentice::get_begin_time)
      .def("get_end_time", &apprentice::get_end_time)
      .def("get_location", &apprentice::get_location)
      .def("get_home_uid", &apprentice::get_home_uid)
      .def("get_home_uname", &apprentice::get_home_uname)
      .def("now", &apprentice::now)
      .def("run", &apprentice::run, py::arg("step_limit") = 0)
      .def("pre_setup", &apprentice::pre_setup)
      .def("setup", &apprentice::setup)
      .def("step", &apprentice::step)
      .def("is_live", &apprentice::is_live)
      .def("is_started", &apprentice::is_started)
      .def("has_writer", &apprentice::has_writer)
      .def("get_writer", &apprentice::get_writer)
      .def("on_exit", &apprentice::on_exit);
}
} // namespace kungfu::runtime
