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
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_manifest_unknown_record, carrier_type, schema_version,
                        unknown_version);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_manifest_record, manifest_frame_uid, manifest_gen_time,
                        body);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_current_view, episode_id, opened, closed, open_count,
                        close_count, open, open_manifest_frame_uid, open_manifest_gen_time, heartbeat_seen, update_time,
                        claimed_frame_count, last_frame_uid_seen, last_frame_uid, unique_frame_count, close,
                        close_statuses, root_seen, root_count, root, records, frame_indices, ref_indices,
                        duplicate_frame_uids, missing_frame_uid_count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_source_query_row, source_uid, source_id,
                        source_type, coordinate, manifest_id, source_head, accept_time, entry_count, sync_root,
                        manifest_count, export_count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_manifest_query_row, source_id, manifest_id,
                        accept_time, entry_count, entries_hash, sync_root, status);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_entry_query_row, kind, source_id, source_path,
                        source_time, schema_version, content_type, payload_hash, byte_len, payload_state, entry_index,
                        accept_time, storage_source_id, manifest_id);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_query_error, code, episode_id);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_query_result, ok, scope, source_id, episode_id,
                        projection_name, projection_schema, authority, rebuildable, query, entry_kind, range, limit,
                        rows, errors);

#endif // KUNGFU_RUNTIME_STORAGE_BINDING_REFLECTION_H
