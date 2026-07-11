// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_BINDING_REFLECTION_H
#define KUNGFU_RUNTIME_STORAGE_BINDING_REFLECTION_H

#include <boost/hana/adapt_struct.hpp>

#include <kungfu/runtime/storage/service.h>

// Owned API views use Hana field reflection without acquiring a carrier tag,
// packed layout, mmap lifetime, or journal-schema promise. This is the typed
// polyglot membrane; KF_DEFINE_* remains the closed-set POD admission path.
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_count, table, count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_drift, table, projection_rows,
                        journal_distinct);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_verify_result, ok, status, schema,
                        runtime_dir, authority, projection_present, degraded, note, drift, rows, journal_distinct);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_time_range, since, until);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_sync_root_view, algorithm, value);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_provider_runtime_view, lifecycle,
                        instance_lifecycle, handle, readonly_open_creates_backend, write_open_creates_backend,
                        read_fill_cache, write_sync);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_provider_cache_view, lifecycle, entries, hits,
                        misses);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_frame_range_view, first_frame_uid, last_frame_uid,
                        since, until);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_source_registry_view, source_uid, source_id,
                        registered, record_count, accepted_range_count, kind, coordinate, head, location_uid,
                        register_time, current_range, inventory_hash, update_time);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_accepted_range_view, source_id, manifest_id,
                        range, source_head, sync_root, entry_count, status);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_cursor_view, source_id, manifest_id, source_head,
                        range, sync_root, entry_count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_manifest_source_view, source_id, source_type,
                        kind, coordinate, source_head, range, inventory_hash, accepted_range, manifest_id);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_source_status_view, source_id, ok, reason, source,
                        manifest_id, source_type, source_head, accepted_range, accepted_cursor, sync_root, entries,
                        payload_inventory, schema_inventory, source_record);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_status_view, name, path, rebuildable,
                        verification);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_status_result, ok, backend, provider,
                        provider_config_source, provider_runtime, provider_cache, scope, source_id, authority, sources,
                        projections, source_status);

#endif // KUNGFU_RUNTIME_STORAGE_BINDING_REFLECTION_H
