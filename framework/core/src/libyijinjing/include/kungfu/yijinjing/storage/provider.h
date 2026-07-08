// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_PROVIDER_H
#define KUNGFU_YIJINJING_STORAGE_PROVIDER_H

#include <optional>
#include <string>

#include <kungfu/yijinjing/storage/acceptance.h>
#include <kungfu/yijinjing/storage/fsck.h>

namespace kungfu::yijinjing::storage {

struct import_options {
  std::string scope = {};
  range_selector range = {};
  bool verify = true;
};

struct export_options {
  std::string scope = {};
  range_selector range = {};
  std::string format = {};
};

class payload_store {
public:
  virtual ~payload_store() = default;

  [[nodiscard]] virtual payload_state state_of(const payload_ref &payload) const = 0;

  [[nodiscard]] virtual std::string read_payload(const payload_ref &payload) const = 0;
};

class manifest_store {
public:
  virtual ~manifest_store() = default;

  virtual void accept_manifest(const manifest_ref &manifest) = 0;

  [[nodiscard]] virtual std::optional<manifest_ref> load_manifest(const std::string &manifest_id) const = 0;
};

class source_registry {
public:
  virtual ~source_registry() = default;

  virtual void accept_source(const source_ref &source, const event_range &accepted_range) = 0;

  [[nodiscard]] virtual source_registry_snapshot snapshot() const = 0;
};

class storage_service {
public:
  virtual ~storage_service() = default;

  [[nodiscard]] virtual fsck_report fsck(const fsck_options &options) const = 0;

  [[nodiscard]] virtual import_result import_manifest(const manifest_ref &manifest, const import_options &options) = 0;

  [[nodiscard]] virtual export_result export_manifest(const export_options &options) const = 0;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_PROVIDER_H
