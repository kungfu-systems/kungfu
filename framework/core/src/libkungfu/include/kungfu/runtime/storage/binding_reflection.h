// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_BINDING_REFLECTION_H
#define KUNGFU_RUNTIME_STORAGE_BINDING_REFLECTION_H

#include <boost/hana/adapt_struct.hpp>

#include <kungfu/runtime/durability.h>
#include <kungfu/runtime/storage/service.h>

// Owned API views use Hana field reflection without acquiring a carrier tag,
// packed layout, mmap lifetime, or journal-schema promise. This is the typed
// polyglot membrane; KF_DEFINE_* remains the closed-set POD admission path.
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::durability::stream_position, stream_id, container_epoch, sequence, frame_uid);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::durability::durability_receipt_view, schema, request_id, position,
                        requested_profile, achieved_profile, visible_watermark, durable_watermark, projection_watermark,
                        replicated_watermark, barrier_id, completed_at, status, error);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_count, table, count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_drift, table, projection_rows,
                        journal_distinct, reason, projection_digest, journal_digest);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_verify_result, ok, status, schema,
                        runtime_dir, authority, projection_present, degraded, note, drift, rows, journal_distinct);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_rebuild_result, ok, schema,
                        runtime_dir, authority, projection, sqlite_path, rows, journal_records, query_records);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_time_range, since, until);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_sync_root_view, algorithm, value);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_provider_runtime_view, lifecycle,
                        instance_lifecycle, handle, readonly_open_creates_backend, write_open_creates_backend,
                        read_fill_cache, write_sync);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_provider_layout_view, database,
                        manifest_catalog_journal, manifest_entries, payloads);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_provider_cache_view, lifecycle, entries, hits,
                        misses);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_layout_paths_view, data_home, runtime_dir,
                        dataset_dir, inbox_dir, journal_dir, storage_dir, source_registry_journal,
                        manifest_catalog_journal, manifest_entries, payloads, rocksdb, source_registry_projection,
                        manifest_catalog_projection, episode_manifest_journal_dir, episode_manifest_journal,
                        coordinator_state, remote_mirrors, atlas_store);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_layout_episode_view, authority, schema,
                        manifest_namespace, manifest_name, manifest_journal, query_tables, export_schema);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_layout_ownership_view, journal_dir,
                        episode_manifest_journal, storage_dir, source_registry_journal, manifest_catalog_journal,
                        manifest_entries, payloads, source_registry_projection, manifest_catalog_projection, rocksdb,
                        config_home);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_layout_result, schema, owner, layout_version,
                        runtime_home, workspace_data_home, runtime_home_source, runtime_dir,
                        runtime_dir_is_standard_child, config_home, provider, provider_layout, provider_runtime,
                        provider_cache, paths, episodes, ownership, notes);
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
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_causal_edge, from_frame_uid, to_frame_uid);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_dependency, kind, role, status, episode_id, frame_uid,
                        dependent_frame_uid, ref_uid, ref_id, ref_hash);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_causal_graph, schema, episode_id, frame_count, edges,
                        dependencies, errors, warnings, degraded);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_content_root, covered_record_count, algorithm, value);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_content_root_verification, recorded, computed, match,
                        status);
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
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_gc_candidate_view, payload_hash, uri, bytes,
                        safe_to_delete);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_gc_plan_result, ok, scope, source_id, dry_run,
                        payloads_scanned, referenced_payloads, candidate_bytes, candidates, notes);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_action_view, name, dry_run, written,
                        would_write, detail);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_error, code, projection, source_id);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_rebuild_index_result, ok, scope, source_id,
                        authority, rebuilt_from, projections, dry_run, would_write, written, sources_rebuilt, errors);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_retained_manifest_view, source_id, manifest_id,
                        entries, sync_root);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_projection_compact_view, name, path, action,
                        dry_run, rebuildable);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_unsupported_action_view, name, reason);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_compact_plan_result, ok, scope, source_id,
                        dry_run, retained_manifests, rebuild_index, gc, projection_compact, unsupported, notes);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::source_registry_fsck_issue, code, source_uid, source_id, count);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::source_registry_fsck_result, ok, status, schema, runtime_dir,
                        authority, errors, warnings, source_registry_records, sources);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::source_registry_unknown_record, carrier_type);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::source_registry_record, registry_frame_uid, registry_gen_time,
                        body);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::source_registry_current_view, source_uid, registered,
                        register_count, registration, head_update_seen, head_update, current_head, records,
                        accepted_range_indices);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::manifest_catalog_fsck_issue, code, source_id, manifest_id, error,
                        subject, payload_hash, state, kind, entry_source_id, manifest_uid, entry_index, expected,
                        actual, expected_text, actual_text, intentional);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::manifest_catalog_fsck_result, ok, status, degraded, schema,
                        runtime_dir, authority, errors, warnings, manifests, manifest_entries, payloads,
                        entries_documents, exports, cursors);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_fsck_issue, code, episode_id, dependency_episode_id,
                        frame_uid, dependent_frame_uid, count, status, claimed, actual, recorded_covered_record_count,
                        computed_covered_record_count, role, ref_id, ref_hash, detail, reason, algorithm, recorded,
                        computed);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_fsck_result, ok, status, schema, runtime_dir, authority,
                        degraded, errors, warnings, episode_manifest_records, episodes, unknown_records,
                        unfolded_records, episode);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_frame_field_mismatch, field, claimed, actual);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_frame_verification_issue, code, episode_id,
                        frame_uid, location_uid, dest, integrity_version, fields, claimed_payload_checksum,
                        actual_payload_checksum, claimed_frame_checksum, actual_frame_checksum);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_frame_verification, errors, warnings, verified,
                        degraded);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_qualification_evidence, name, state, issue_codes);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_qualification_issue, severity, code, evidence,
                        detail);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_qualification_capability, name, safe,
                        required_evidence, blocked_by);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_repair_subject, episode_id, dependency_episode_id,
                        frame_uid, dependent_frame_uid, ref_id, ref_hash, role);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_repair_prerequisite, issue_code, action,
                        required_inputs, subject);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::episode_qualification_result, episode_id, lifecycle,
                        status, evidence, issues, capabilities, repair_prerequisites);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_fsck_cross_issue, source_id, path, payload_hash,
                        expected, actual, reason);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_fsck_issue, severity, code, projection, detail);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_fsck_counts, sources, manifests, manifest_entries,
                        payloads, entries_documents, accepted_ranges, source_records, projection_indexes,
                        orphan_payloads, episode_manifest_records, episodes, episode_frames_verified);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_fsck_result, ok, degraded, status, scope,
                        source_id, episode_id, authority, checked, source_registry, manifest_catalog, episode_manifest,
                        projections, frame_verification, qualification, issues);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_repair_subject, episode_id, dependency_episode_id,
                        frame_uid, dependent_frame_uid, ref_id, ref_hash, source_id, subject, state, path,
                        payload_hash);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_repair_candidate_view, code, issue_code, kind,
                        role, action, safe_to_apply, required_inputs, subject, issue);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_repair_plan_result, ok, scope, source_id,
                        episode_id, dry_run, plan_only, status, degraded, candidates, unsupported, fsck, notes);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_close_write_result, close, content_root);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_recover_skipped_open, episode_id, location_uid);
BOOST_HANA_ADAPT_STRUCT(kungfu::yijinjing::storage::episode_recover_result, runtime_dir, recovered, skipped_open);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_episode_list_result, ok, runtime_dir, authority,
                        episodes, unknown_record_count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_episode_inspect_result, ok, runtime_dir,
                        authority, episode, content_root, causal_graph, unknown_record_count, qualification);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_source_list_result, ok, runtime_dir, authority,
                        sources, unknown_record_count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_source_inspect_result, ok, runtime_dir, authority,
                        source, unknown_record_count);
BOOST_HANA_ADAPT_STRUCT(kungfu::runtime::storage_service_api::storage_source_registry_fsck_result, ok, status, journal,
                        projection);

#endif // KUNGFU_RUNTIME_STORAGE_BINDING_REFLECTION_H
