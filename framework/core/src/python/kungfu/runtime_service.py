# SPDX-License-Identifier: Apache-2.0

"""Stable facade for runtime state, engine, and supervisor responsibilities."""

from __future__ import annotations

import signal as signal
from contextlib import contextmanager as contextmanager
from hashlib import sha256 as sha256
from typing import Mapping as Mapping

from kungfu import runtime_leases as runtime_leases
from kungfu import runtime_state as runtime_state
from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE as CARRIER_ACTION_ENVELOPE
from kungfu.coordination import locks as coordination_locks  # noqa: F401
from kungfu.coordination.arbiter import (
    ACTION_GRANT as ACTION_GRANT,
    ACTION_RELEASE as ACTION_RELEASE,
    ACTION_REQUEST as ACTION_REQUEST,
    LockTable as LockTable,
    grant_payload as grant_payload,
    parse_name as parse_name,
)
from kungfu.execution_surface import authority as runtime_surface_authority  # noqa: F401
from kungfu.storage import service as storage_service  # noqa: F401
from kungfu.action_wire import unwrap_event as unwrap_event
from kungfu.action_wire import wrap_event as wrap_event
from pykungfu.runtime import coordinator as NativeCoordinator  # noqa: F401

from kungfu._runtime_service.common import (
    json as json,
    os as os,
    platform as platform,
    subprocess as subprocess,
    tempfile as tempfile,
    threading as threading,
    time as time,
    dataclass as dataclass,
    Path as Path,
    Any as Any,
    Protocol as Protocol,
    kungfu as kungfu,
    psutil as psutil,
    runtime_paths as runtime_paths,
    runtime_service_config as runtime_service_config,
    _runtime_processes as _runtime_processes,
    lf as lf,
    yjj as yjj,
    SCHEMA_STATUS as SCHEMA_STATUS,
    SCHEMA_ROUTES as SCHEMA_ROUTES,
    SCHEMA_ASSESSMENT_SUBSCRIPTION as SCHEMA_ASSESSMENT_SUBSCRIPTION,
    SCHEMA_COORDINATOR_CONTINUITY as SCHEMA_COORDINATOR_CONTINUITY,
    LEGACY_SCHEMA_ROUTES as LEGACY_SCHEMA_ROUTES,
    COORDINATOR_WIRE_NAMESPACE as COORDINATOR_WIRE_NAMESPACE,
    COORDINATOR_WIRE_NAME as COORDINATOR_WIRE_NAME,
    LEGACY_STATE_DIR_NAME as LEGACY_STATE_DIR_NAME,
    ROUTE_LEASE_TTL_SECONDS as ROUTE_LEASE_TTL_SECONDS,
    RESTART_WINDOW_SECONDS as RESTART_WINDOW_SECONDS,
    RESTART_MAX_ATTEMPTS as RESTART_MAX_ATTEMPTS,
    RUNTIME_IDLE_GRACE_SECONDS as RUNTIME_IDLE_GRACE_SECONDS,
    SUPERVISOR_LIFECYCLE_LOCK as SUPERVISOR_LIFECYCLE_LOCK,
    _SUPERVISOR_LIFECYCLE_THREAD_LOCK as _SUPERVISOR_LIFECYCLE_THREAD_LOCK,
    SCHEMA_PLAN as SCHEMA_PLAN,
    SCHEMA_RESULT as SCHEMA_RESULT,
    SERVICE_ID as SERVICE_ID,
    SERVICE_NAME as SERVICE_NAME,
    SUPERVISOR_ALWAYS_ON_ENV as SUPERVISOR_ALWAYS_ON_ENV,
    ServicePlan as ServicePlan,
    _shell_join as _shell_join,
    shlex_quote as shlex_quote,
    _systemd_env_line as _systemd_env_line,
    _positive_generation as _positive_generation,
    supervisor_state_dir as supervisor_state_dir,
    supervisor_log_path as supervisor_log_path,
    entry_command as entry_command,
    command_env as command_env,
    coordinator_run_command as coordinator_run_command,
    assessment_worker_command as assessment_worker_command,
    run_assessment_worker as run_assessment_worker,
    supervisor_command as supervisor_command,
    RuntimeEngineRequest as RuntimeEngineRequest,
    RuntimeEngineReceipt as RuntimeEngineReceipt,
    AssessmentExecutor as AssessmentExecutor,
    CoordinatorProcess as CoordinatorProcess,
    AdoptedCoordinatorProcess as AdoptedCoordinatorProcess,
    _terminate_and_reap_child as _terminate_and_reap_child,
    _json_write as _json_write,
    _json_read as _json_read,
    _is_pid_running as _is_pid_running,
    _process_start_identity as _process_start_identity,
    _process_matches as _process_matches,
    _pid_state as _pid_state,
    _canonical_path as _canonical_path,
    resolve_config_home as resolve_config_home,
    resolve_runtime_home as resolve_runtime_home,
    resolve_runtime_dir as resolve_runtime_dir,
)
from kungfu._runtime_service.state import (
    route_id as route_id,
    route_record as route_record,
    supervisor_lifecycle_lock_dir as supervisor_lifecycle_lock_dir,
    supervisor_lifecycle_guard as supervisor_lifecycle_guard,
    state_dir as state_dir,
    legacy_state_dir as legacy_state_dir,
    supervisor_pid_path as supervisor_pid_path,
    coordinator_pid_path as coordinator_pid_path,
    legacy_coordinator_pid_path as legacy_coordinator_pid_path,
    state_path as state_path,
    coordinator_continuity_path as coordinator_continuity_path,
    allocate_coordinator_authority as allocate_coordinator_authority,
    legacy_state_path as legacy_state_path,
    supervisor_state_path as supervisor_state_path,
    routes_path as routes_path,
    coordinator_log_path as coordinator_log_path,
    assessment_subscription_path as assessment_subscription_path,
    read_pid as read_pid,
    read_coordinator_pid as read_coordinator_pid,
    unlink_coordinator_pid_files as unlink_coordinator_pid_files,
    write_pid as write_pid,
    unlink_if_exists as unlink_if_exists,
    assessment_snapshot as assessment_snapshot,
    publish_assessment_snapshot as publish_assessment_snapshot,
    read_routes as read_routes,
    write_routes as write_routes,
    _upsert_route_unlocked as _upsert_route_unlocked,
    upsert_route as upsert_route,
    _set_route_desired_unlocked as _set_route_desired_unlocked,
    set_route_desired as set_route_desired,
    _restart_permitted as _restart_permitted,
    _runtime_idle_grace_ns as _runtime_idle_grace_ns,
    _runtime_demand_status as _runtime_demand_status,
    _complete_runtime_drain as _complete_runtime_drain,
    _fence_runtime_restart as _fence_runtime_restart,
    _set_route_restart_status_unlocked as _set_route_restart_status_unlocked,
    _set_route_restart_status as _set_route_restart_status,
    _fenced_adopted_coordinator as _fenced_adopted_coordinator,
    _touch_route_heartbeat_unlocked as _touch_route_heartbeat_unlocked,
    touch_route_heartbeat as touch_route_heartbeat,
    _retire_idle_routes as _retire_idle_routes,
    _finalize_supervisor_state as _finalize_supervisor_state,
    _route_freshness as _route_freshness,
    _lifecycle_status as _lifecycle_status,
    repair_route_state as repair_route_state,
)
from kungfu._runtime_service.engine import (
    ProcessAssessmentExecutor as ProcessAssessmentExecutor,
    CoordinatorEngine as CoordinatorEngine,
    Coordinator as Coordinator,
)
from kungfu._runtime_service.supervisor import (
    ProcessRuntimeHost as ProcessRuntimeHost,
    run_coordinator as run_coordinator,
    status as status,
    route_status as route_status,
    run_supervisor as run_supervisor,
    ensure_coordinator as ensure_coordinator,
    _wait_for_coordinator as _wait_for_coordinator,
    stop_supervisor as stop_supervisor,
    supervisor_status as supervisor_status,
    service_plan as service_plan,
    install_service as install_service,
    uninstall_service as uninstall_service,
    service_status as service_status,
)


RuntimeEngineRequest.__module__ = __name__
RuntimeEngineReceipt.__module__ = __name__
AssessmentExecutor.__module__ = __name__
CoordinatorProcess.__module__ = __name__
AdoptedCoordinatorProcess.__module__ = __name__
ProcessAssessmentExecutor.__module__ = __name__
CoordinatorEngine.__module__ = __name__
Coordinator.__module__ = __name__
ProcessRuntimeHost.__module__ = __name__
_terminate_process_if_matches = _runtime_processes._terminate_process_if_matches
_terminate_process_tree_if_matches = (
    _runtime_processes._terminate_process_tree_if_matches
)
_terminate_and_reap_child.__module__ = __name__
_is_pid_running.__module__ = __name__
_process_start_identity.__module__ = __name__


def _now() -> float:
    return time.time()


for _facade_callable in (
    RuntimeEngineRequest,
    RuntimeEngineReceipt,
    AssessmentExecutor,
    CoordinatorProcess,
    AdoptedCoordinatorProcess,
    _terminate_and_reap_child,
    _now,
    _json_write,
    _json_read,
    _is_pid_running,
    _process_start_identity,
    _process_matches,
    _pid_state,
    route_id,
    route_record,
    supervisor_lifecycle_lock_dir,
    supervisor_lifecycle_guard,
    state_dir,
    legacy_state_dir,
    supervisor_pid_path,
    coordinator_pid_path,
    legacy_coordinator_pid_path,
    state_path,
    coordinator_continuity_path,
    allocate_coordinator_authority,
    legacy_state_path,
    supervisor_state_path,
    routes_path,
    coordinator_log_path,
    assessment_subscription_path,
    read_pid,
    read_coordinator_pid,
    unlink_coordinator_pid_files,
    write_pid,
    unlink_if_exists,
    assessment_snapshot,
    publish_assessment_snapshot,
    read_routes,
    write_routes,
    _upsert_route_unlocked,
    upsert_route,
    _set_route_desired_unlocked,
    set_route_desired,
    _restart_permitted,
    _runtime_idle_grace_ns,
    _runtime_demand_status,
    _complete_runtime_drain,
    _fence_runtime_restart,
    _set_route_restart_status_unlocked,
    _set_route_restart_status,
    _fenced_adopted_coordinator,
    _touch_route_heartbeat_unlocked,
    touch_route_heartbeat,
    _retire_idle_routes,
    _finalize_supervisor_state,
    _route_freshness,
    _lifecycle_status,
    repair_route_state,
    ProcessAssessmentExecutor,
    CoordinatorEngine,
    Coordinator,
    ProcessRuntimeHost,
    run_coordinator,
    status,
    route_status,
    run_supervisor,
    ensure_coordinator,
    _wait_for_coordinator,
    stop_supervisor,
    supervisor_status,
    service_plan,
    install_service,
    uninstall_service,
    service_status,
):
    _facade_callable.__module__ = __name__
del _facade_callable
