# SPDX-License-Identifier: Apache-2.0

"""Episode lifecycle, recovery, and admission storage operations."""

from pathlib import Path
from typing import Any

from kungfu.storage._service_backend import _runtime_adapter as _runtime
from kungfu.storage.transfer import _binding_json, _u64


def _episode_write_options(
    operation_options: dict[str, Any], write_retry: dict[str, Any] | None
) -> dict[str, Any]:
    options = _binding_json(operation_options)
    if write_retry is not None:
        options["write_retry"] = _binding_json(write_retry)
    return options


def _episode_write_edge(value: dict[str, Any]) -> dict[str, Any]:
    """Preserve the established typed Python shape over the native JSON edge."""

    result = dict(value)
    status = result.get("status")
    if isinstance(status, str):
        result["status"] = {
            "open": 1,
            "ended": 2,
            "aborted": 3,
            "tombstoned": 4,
        }.get(status, 0)
    ref_kind = result.get("ref_kind")
    if isinstance(ref_kind, str):
        result["ref_kind"] = {
            "input_frame": 1,
            "payload": 2,
            "schema": 3,
            "episode": 4,
        }.get(ref_kind, 0)
    return result


def _episode_close_edge(value: dict[str, Any]) -> dict[str, Any]:
    result = _episode_write_edge(value)
    write_retry = result.pop("write_retry", None)
    content_root = result.pop("content_root", None)
    edge: dict[str, Any] = {"close": result}
    if content_root is not None:
        edge["content_root"] = content_root
    if write_retry is not None:
        edge["write_retry"] = write_retry
    return edge


def episode_begin(
    runtime_dir: str | Path,
    *,
    title: str = "",
    actor: str = "",
    source: str = "",
    episode_id: int = 0,
    parent_episode_id: int = 0,
    root_trigger_frame_uid: int = 0,
    location_uid: int = 0,
    begin_time: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_begin",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "parent_episode_id": parent_episode_id,
                        "root_trigger_frame_uid": root_trigger_frame_uid,
                        "location_uid": location_uid,
                        "begin_time": begin_time,
                        "title": title,
                        "actor": actor,
                        "source": source,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_heartbeat(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    update_time: int = 0,
    last_frame_uid: int = 0,
    frame_count: int = 0,
    note: str = "",
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_heartbeat",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "location_uid": location_uid,
                        "update_time": update_time,
                        "last_frame_uid": last_frame_uid,
                        "frame_count": frame_count,
                        "note": note,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_attach_frame(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    frame_uid: int,
    location_uid: int = 0,
    trigger_frame_uid: int = 0,
    stream_id: int = 0,
    gen_time: int = 0,
    trigger_time: int = 0,
    carrier_type: int = 0,
    source: int = 0,
    dest: int = 0,
    data_length: int = 0,
    integrity_version: int = 0,
    payload_checksum: int = 0,
    frame_checksum: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_attach_frame",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "frame_uid": frame_uid,
                        "location_uid": location_uid,
                        "trigger_frame_uid": trigger_frame_uid,
                        "stream_id": stream_id,
                        "gen_time": gen_time,
                        "trigger_time": trigger_time,
                        "carrier_type": carrier_type,
                        "source": source,
                        "dest": dest,
                        "data_length": data_length,
                        "integrity_version": integrity_version,
                        "payload_checksum": payload_checksum,
                        "frame_checksum": frame_checksum,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_attach_ref(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    ref_kind: str = "input_frame",
    ref_uid: int = 0,
    ref_id: str = "",
    ref_hash: str = "",
    location_uid: int = 0,
    update_time: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_write_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_attach_ref",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "ref_kind": ref_kind,
                        "ref_uid": ref_uid,
                        "ref_id": ref_id,
                        "ref_hash": ref_hash,
                        "location_uid": location_uid,
                        "update_time": update_time,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_end(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    end_time: int = 0,
    last_frame_uid: int = 0,
    frame_count: int = 0,
    reason: str = "",
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_close_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_end",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "location_uid": location_uid,
                        "end_time": end_time,
                        "last_frame_uid": last_frame_uid,
                        "frame_count": frame_count,
                        "reason": reason,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_abort(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    end_time: int = 0,
    last_frame_uid: int = 0,
    frame_count: int = 0,
    reason: str = "",
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _episode_close_edge(
        dict(
            _runtime().run_storage_service_operation(
                "episode_abort",
                str(runtime_dir),
                _episode_write_options(
                    {
                        "episode_id": episode_id,
                        "location_uid": location_uid,
                        "end_time": end_time,
                        "last_frame_uid": last_frame_uid,
                        "frame_count": frame_count,
                        "reason": reason,
                    },
                    write_retry,
                ),
            )
        )
    )


def episode_list(
    runtime_dir: str | Path,
    *,
    location_uid: int = 0,
    limit: int = 100,
) -> dict[str, Any]:
    return dict(
        _runtime().storage_episode_list_typed(
            str(runtime_dir), location_uid=location_uid, limit=limit
        )
    )


def episode_inspect(runtime_dir: str | Path, *, episode_id: int) -> dict[str, Any]:
    return dict(
        _runtime().storage_episode_inspect_typed(
            str(runtime_dir), episode_id=episode_id
        )
    )


def episode_recover(
    runtime_dir: str | Path,
    *,
    episode_id: int = 0,
    location_uid: int = 0,
    end_time: int = 0,
    reason: str = "",
    expected_manifest_frame_uid: int = 0,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = dict(
        _runtime().run_storage_service_operation(
            "episode_recover",
            str(runtime_dir),
            _episode_write_options(
                {
                    "episode_id": episode_id,
                    "location_uid": location_uid,
                    "end_time": end_time,
                    "reason": reason,
                    "expected_manifest_frame_uid": expected_manifest_frame_uid,
                },
                write_retry,
            ),
        )
    )
    result["recovered"] = [
        _episode_close_edge(dict(item)) for item in result.get("recovered", [])
    ]
    return result


def episode_recovery_plan(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    now_ns: int | None = None,
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "episode_id": episode_id,
        "location_uid": location_uid,
        "stale_after_seconds": stale_after_seconds,
    }
    if now_ns is not None:
        options["now_ns"] = now_ns
    return dict(
        _runtime().run_storage_service_operation(
            "episode_recovery_plan", str(runtime_dir), _binding_json(options)
        )
    )


def episode_recovery_execute(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    reason: str = "operator recovery",
    now_ns: int | None = None,
    write_retry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "episode_id": episode_id,
        "location_uid": location_uid,
        "stale_after_seconds": stale_after_seconds,
        "reason": reason,
    }
    if now_ns is not None:
        options["now_ns"] = now_ns
    result = dict(
        _runtime().run_storage_service_operation(
            "episode_recovery_execute",
            str(runtime_dir),
            _episode_write_options(options, write_retry),
        )
    )
    if result.get("ok") and isinstance(result.get("recovery"), dict):
        recovery = dict(result["recovery"])
        recovery["recovered"] = [
            _episode_close_edge(dict(item)) for item in recovery.get("recovered", [])
        ]
        result["recovery"] = recovery
    return result


def episode_projection_rebuild(runtime_dir: str | Path) -> dict[str, Any]:
    """Rebuild the Episode manifest SQLite projection from the journal."""

    return dict(_runtime().storage_episode_projection_rebuild_typed(str(runtime_dir)))


def episode_admission(
    destination_runtime_dir: str | Path,
    *,
    action: str = "plan",
    source_runtime_dir: str | Path | None = None,
    episode_ids: list[int] | None = None,
    transport: str = "local-direct",
    initiator: str = "destination-pull",
    plan: dict[str, Any] | None = None,
    plan_root: str = "",
    episode_bundles: list[dict[str, Any]] | None = None,
    source_identity: dict[str, Any] | None = None,
    destination_identity: dict[str, Any] | None = None,
    project_cut_roots: list[str] | None = None,
) -> dict[str, Any]:
    """Run the destination-owned Episode Admission protocol in libkungfu."""

    options: dict[str, Any] = {
        "action": action,
        "transport": transport,
        "initiator": initiator,
        "episode_ids": [_u64(value) for value in (episode_ids or [])],
        "project_cut_roots": project_cut_roots or [],
    }
    if source_runtime_dir is not None:
        options["source_runtime_dir"] = str(source_runtime_dir)
    if plan is not None:
        options["plan"] = _binding_json(plan)
    if plan_root:
        options["plan_root"] = plan_root
    if episode_bundles is not None:
        options["episode_bundles"] = _binding_json(episode_bundles)
    if source_identity is not None:
        options["source_identity"] = _binding_json(source_identity)
    if destination_identity is not None:
        options["destination_identity"] = _binding_json(destination_identity)
    return dict(
        _runtime().run_storage_service_operation(
            "episode_admission", str(destination_runtime_dir), options
        )
    )
