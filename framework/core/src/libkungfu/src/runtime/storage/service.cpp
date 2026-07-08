// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/service.h>

#include <stdexcept>
#include <utility>

namespace kungfu::runtime::storage_service_api {

namespace {

std::string text_or(const nlohmann::json &object, const std::string &field, const std::string &fallback = {}) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_string()) {
    return value.get<std::string>();
  }
  if (value.is_null()) {
    return fallback;
  }
  return value.dump(-1, ' ', false);
}

bool bool_or(const nlohmann::json &object, const std::string &field, bool fallback) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  return value.is_boolean() ? value.get<bool>() : fallback;
}

nlohmann::json object_or_empty(const nlohmann::json &object, const std::string &field) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_object()) {
    return nlohmann::json::object();
  }
  return object.at(field);
}

class request_only_storage_service : public storage_service {
public:
  [[nodiscard]] nlohmann::json status(const storage_service_options &options) const override {
    return make_request(storage_operation::Status, options);
  }

  [[nodiscard]] nlohmann::json fsck(const storage_service_options &options) const override {
    return make_request(storage_operation::Fsck, options);
  }

  [[nodiscard]] nlohmann::json export_bundle(const storage_service_options &options) const override {
    return make_request(storage_operation::ExportBundle, options);
  }

  [[nodiscard]] nlohmann::json import_bundle(const storage_service_options &options) const override {
    return make_request(storage_operation::ImportBundle, options);
  }

  [[nodiscard]] nlohmann::json rebuild_index(const storage_service_options &options) const override {
    return make_request(storage_operation::RebuildIndex, options);
  }

  [[nodiscard]] nlohmann::json gc_plan(const storage_service_options &options) const override {
    return make_request(storage_operation::GcPlan, options);
  }

  [[nodiscard]] nlohmann::json compact_plan(const storage_service_options &options) const override {
    return make_request(storage_operation::CompactPlan, options);
  }

  [[nodiscard]] nlohmann::json verify_sync(const storage_service_options &options) const override {
    return make_request(storage_operation::VerifySync, options);
  }

private:
  [[nodiscard]] static nlohmann::json make_request(storage_operation operation,
                                                   const storage_service_options &options) {
    return {
        {"schema", RUNTIME_STORAGE_SERVICE_SCHEMA_V1},
        {"owner", RUNTIME_STORAGE_SERVICE_OWNER},
        {"operation", storage_operation_name(operation)},
        {"runtime_dir", options.runtime_dir},
        {"scope", options.scope},
        {"source_id", options.source_id},
        {"dry_run", options.dry_run},
        {"verify", options.verify},
        {"range", options.range},
        {"artifact_uri", options.artifact_uri},
    };
  }
};

const request_only_storage_service &request_service() {
  static const request_only_storage_service service;
  return service;
}

} // namespace

std::vector<std::string> storage_operation_names() {
  return {
      storage_operation_name(storage_operation::Status),       storage_operation_name(storage_operation::Fsck),
      storage_operation_name(storage_operation::ExportBundle), storage_operation_name(storage_operation::ImportBundle),
      storage_operation_name(storage_operation::RebuildIndex), storage_operation_name(storage_operation::GcPlan),
      storage_operation_name(storage_operation::CompactPlan),  storage_operation_name(storage_operation::VerifySync),
  };
}

std::string storage_operation_name(storage_operation operation) {
  switch (operation) {
  case storage_operation::Status:
    return "status";
  case storage_operation::Fsck:
    return "fsck";
  case storage_operation::ExportBundle:
    return "export_bundle";
  case storage_operation::ImportBundle:
    return "import_bundle";
  case storage_operation::RebuildIndex:
    return "rebuild_index";
  case storage_operation::GcPlan:
    return "gc_plan";
  case storage_operation::CompactPlan:
    return "compact_plan";
  case storage_operation::VerifySync:
    return "verify_sync";
  }
  throw std::invalid_argument("unknown storage operation");
}

storage_operation parse_storage_operation(const std::string &operation) {
  if (operation == "status") {
    return storage_operation::Status;
  }
  if (operation == "fsck") {
    return storage_operation::Fsck;
  }
  if (operation == "export_bundle") {
    return storage_operation::ExportBundle;
  }
  if (operation == "import_bundle") {
    return storage_operation::ImportBundle;
  }
  if (operation == "rebuild_index") {
    return storage_operation::RebuildIndex;
  }
  if (operation == "gc_plan") {
    return storage_operation::GcPlan;
  }
  if (operation == "compact_plan") {
    return storage_operation::CompactPlan;
  }
  if (operation == "verify_sync") {
    return storage_operation::VerifySync;
  }
  throw std::invalid_argument("unsupported storage operation: " + operation);
}

storage_service_options parse_storage_service_options(const std::string &runtime_dir, const nlohmann::json &options) {
  storage_service_options parsed;
  parsed.runtime_dir = runtime_dir;
  parsed.scope = text_or(options, "scope", "all");
  parsed.source_id = text_or(options, "source_id");
  parsed.dry_run = bool_or(options, "dry_run", true);
  parsed.verify = bool_or(options, "verify", true);
  parsed.range = object_or_empty(options, "range");
  parsed.artifact_uri = text_or(options, "artifact_uri");
  return parsed;
}

nlohmann::json make_storage_service_request(const std::string &operation, const std::string &runtime_dir,
                                            const nlohmann::json &options) {
  const auto parsed_operation = parse_storage_operation(operation);
  const auto parsed_options = parse_storage_service_options(runtime_dir, options);
  switch (parsed_operation) {
  case storage_operation::Status:
    return request_service().status(parsed_options);
  case storage_operation::Fsck:
    return request_service().fsck(parsed_options);
  case storage_operation::ExportBundle:
    return request_service().export_bundle(parsed_options);
  case storage_operation::ImportBundle:
    return request_service().import_bundle(parsed_options);
  case storage_operation::RebuildIndex:
    return request_service().rebuild_index(parsed_options);
  case storage_operation::GcPlan:
    return request_service().gc_plan(parsed_options);
  case storage_operation::CompactPlan:
    return request_service().compact_plan(parsed_options);
  case storage_operation::VerifySync:
    return request_service().verify_sync(parsed_options);
  }
  throw std::invalid_argument("unknown storage operation");
}

nlohmann::json storage_service_capabilities() {
  return {
      {"schema", RUNTIME_STORAGE_SERVICE_SCHEMA_V1},
      {"owner", RUNTIME_STORAGE_SERVICE_OWNER},
      {"operations", storage_operation_names()},
      {"backend", "request-only"},
      {"notes", nlohmann::json::array({
                    "The public runtime storage service surface is owned by libkungfu.",
                    "The interim content-addressed file backend remains in the language layer until the provider card.",
                })},
  };
}

} // namespace kungfu::runtime::storage_service_api
