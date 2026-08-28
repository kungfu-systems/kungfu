# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import pickle
import sys
import types

import pytest


def _install_fake_pykungfu() -> None:
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.runtime = types.ModuleType("pykungfu.runtime")
    fake.runtime.coordinator = type("FakeNativeCoordinator", (), {})
    fake.yijinjing = types.SimpleNamespace()
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", fake.runtime)


_install_fake_pykungfu()

from kungfu import exit_bundle, peer_lifecycle, runtime_service, runtime_upgrade  # noqa: E402


FACADE_CALLABLES = {
    runtime_upgrade: """
        UpgradeError _contract _validate _canonical _stable_id manifest_digest
        runtime_identity tree_digest inventory_root _state_root _image_root
        _write_json _read_json validate_manifest user_message
        is_public_release_cut release_check_impact plan_install
        _quarantine_record install_image list_images _contains compatibility
        plan_upgrade _pin_path active_image references_from_runtime_status
        stage_upgrade reconcile_upgrade pinned_entry_command pinned_environment
        image_from_environment plan_gc apply_gc ReleaseCutError
        canonical_json_bytes content_root manifest_identity_root
        _require_exact_fields _require_string _require_root _root_list
        validate_platform_slice finish_platform_slice validate_release_cut
        finish_release_cut validate_cut_transition finish_cut_transition
        build_shifu_local_transition is_legacy_bootstrap legacy_coordinate
        image_coordinate legacy_selection_is_bound manifest_compatibility
        shifu_local_transition image_selection legacy_selection
        legacy_recovery_transition decide_cut_transition
    """.split(),
    exit_bundle: """
        ExitBundleError _root _schema_root _normalized_root _manifest_root
        _package_root _contract _material_root _episode_root _fact_library_root
        _describe _require_full_material _build_material _member_order
        _validate_request build _validate_dependency_closure
        _validate_mode_semantics inspect _profile_source _apply_profile
        _apply_member _receipt import_package read write
    """.split(),
    peer_lifecycle: """
        PeerLifecycleError _now _read_json _canonical_digest _process_identity
        _windows_process_identity _process_matches _await_process_identity
        _terminate_matching peer_root peer_dir state_path spec_path ready_path
        identity_request_path log_path _lock_root validate_spec load_spec plan
        _status_from_state status list_status _host_command
        _product_entry_command _wait_for_ensure_status ensure stop restart
        declare_ready_from_environment _bound_peer_identity_from_environment
        _peer_identity_binding_timeout _ready_mismatch_fields _ready_matches
        _host_write_state _host_bind_state _spawn_peer
        _await_peer_identity_request _is_process_or_descendant
        _managed_peer_alive run_host _main
    """.split(),
    runtime_service: """
        RuntimeEngineRequest RuntimeEngineReceipt AssessmentExecutor
        CoordinatorProcess AdoptedCoordinatorProcess _terminate_and_reap_child
        _now _json_write _json_read _is_pid_running _process_start_identity
        _process_matches _pid_state route_id route_record
        supervisor_lifecycle_lock_dir supervisor_lifecycle_guard state_dir
        legacy_state_dir supervisor_pid_path coordinator_pid_path
        legacy_coordinator_pid_path state_path coordinator_continuity_path
        allocate_coordinator_authority legacy_state_path supervisor_state_path
        routes_path coordinator_log_path assessment_subscription_path read_pid
        read_coordinator_pid unlink_coordinator_pid_files write_pid
        unlink_if_exists assessment_snapshot publish_assessment_snapshot
        read_routes write_routes _upsert_route_unlocked upsert_route
        _set_route_desired_unlocked set_route_desired _restart_permitted
        _runtime_idle_grace_ns _runtime_demand_status _complete_runtime_drain
        _fence_runtime_restart _set_route_restart_status_unlocked
        _set_route_restart_status _fenced_adopted_coordinator
        _touch_route_heartbeat_unlocked touch_route_heartbeat
        _retire_idle_routes _finalize_supervisor_state _route_freshness
        _lifecycle_status repair_route_state ProcessAssessmentExecutor
        CoordinatorEngine Coordinator ProcessRuntimeHost run_coordinator status
        route_status run_supervisor ensure_coordinator _wait_for_coordinator
        stop_supervisor supervisor_status service_plan install_service
        uninstall_service service_status
    """.split(),
}


@pytest.mark.parametrize(
    ("facade", "names"),
    list(FACADE_CALLABLES.items()),
    ids=lambda value: getattr(value, "__name__", "callables"),
)
def test_moved_callables_keep_stable_facade_identity(facade, names) -> None:
    for name in names:
        value = getattr(facade, name)
        assert value.__module__ == facade.__name__
        assert value.__name__ == name
        assert value.__qualname__ == name
        assert pickle.loads(pickle.dumps(value)) is value
        if hasattr(value, "__wrapped__"):
            assert value.__doc__ == value.__wrapped__.__doc__


def test_runtime_upgrade_private_dependency_resolves_at_call_time(monkeypatch) -> None:
    saved = runtime_upgrade.validate_manifest

    def reject(*_args, **_kwargs):
        raise RuntimeError("facade-validate-sentinel")

    monkeypatch.setattr(runtime_upgrade, "_validate", reject)
    with pytest.raises(RuntimeError, match="facade-validate-sentinel"):
        saved({})


def test_exit_bundle_private_dependency_resolves_at_call_time(monkeypatch) -> None:
    saved = exit_bundle.build

    def reject(*_args, **_kwargs):
        raise RuntimeError("facade-request-sentinel")

    monkeypatch.setattr(exit_bundle, "_validate_request", reject)
    with pytest.raises(RuntimeError, match="facade-request-sentinel"):
        saved("ignored", {})


@pytest.mark.parametrize(
    ("facade", "name"),
    [(peer_lifecycle, "status"), (runtime_service, "status")],
)
def test_saved_facade_callable_dispatches_to_a_later_patch(
    monkeypatch, facade, name
) -> None:
    saved = getattr(facade, name)
    sentinel = object()
    monkeypatch.setattr(facade, name, lambda *_args, **_kwargs: sentinel)
    assert saved("ignored", "ignored") is sentinel
