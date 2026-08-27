# SPDX-License-Identifier: Apache-2.0

"""Stable facade for Peer lifecycle state, client control, and host execution."""

from __future__ import annotations

import argparse as argparse
import math as math
import signal as signal
import subprocess as subprocess

from kungfu._peer_lifecycle.state import (
    hashlib as hashlib,
    json as json,
    os as os,
    platform as platform,
    re as re,
    sys as sys,
    time as time,
    Path as Path,
    Any as Any,
    Mapping as Mapping,
    psutil as psutil,
    coordination_locks as coordination_locks,
    SPEC_SCHEMA as SPEC_SCHEMA,
    STATE_SCHEMA as STATE_SCHEMA,
    STATUS_SCHEMA as STATUS_SCHEMA,
    PLAN_SCHEMA as PLAN_SCHEMA,
    READY_SCHEMA as READY_SCHEMA,
    IDENTITY_REQUEST_SCHEMA as IDENTITY_REQUEST_SCHEMA,
    RECOVERY_SCHEMA as RECOVERY_SCHEMA,
    PEER_ID as PEER_ID,
    HEARTBEAT_TTL_SECONDS as HEARTBEAT_TTL_SECONDS,
    DEFAULT_READY_TIMEOUT_SECONDS as DEFAULT_READY_TIMEOUT_SECONDS,
    DEFAULT_RESTART_WINDOW_SECONDS as DEFAULT_RESTART_WINDOW_SECONDS,
    DEFAULT_RESTART_MAX_ATTEMPTS as DEFAULT_RESTART_MAX_ATTEMPTS,
    PROCESS_IDENTITY_TIMEOUT_SECONDS as PROCESS_IDENTITY_TIMEOUT_SECONDS,
    PeerLifecycleError as PeerLifecycleError,
    _read_json as _read_json,
    _write_json as _write_json,
    _canonical_digest as _canonical_digest,
    _process_identity as _process_identity,
    _windows_process_identity as _windows_process_identity,
    _process_matches as _process_matches,
    _await_process_identity as _await_process_identity,
    _terminate_matching as _terminate_matching,
    peer_root as peer_root,
    peer_dir as peer_dir,
    state_path as state_path,
    spec_path as spec_path,
    ready_path as ready_path,
    identity_request_path as identity_request_path,
    log_path as log_path,
    _lock_root as _lock_root,
    validate_spec as validate_spec,
    load_spec as load_spec,
    plan as plan,
    _status_from_state as _status_from_state,
    status as status,
    list_status as list_status,
)
from kungfu._peer_lifecycle.client import (
    _host_command as _host_command,
    _product_entry_command as _product_entry_command,
    _wait_for_ensure_status as _wait_for_ensure_status,
    ensure as ensure,
    stop as stop,
    restart as restart,
    declare_ready_from_environment as declare_ready_from_environment,
)
from kungfu._peer_lifecycle.host import (
    _bound_peer_identity_from_environment as _bound_peer_identity_from_environment,
    _peer_identity_binding_timeout as _peer_identity_binding_timeout,
    _ready_mismatch_fields as _ready_mismatch_fields,
    _ready_matches as _ready_matches,
    _host_write_state as _host_write_state,
    _host_bind_state as _host_bind_state,
    _spawn_peer as _spawn_peer,
    _await_peer_identity_request as _await_peer_identity_request,
    _is_process_or_descendant as _is_process_or_descendant,
    _managed_peer_alive as _managed_peer_alive,
    run_host as run_host,
    _main as _main,
)


def _now() -> float:
    return time.time()


for _facade_callable in (
    PeerLifecycleError,
    _now,
    _read_json,
    _canonical_digest,
    _process_identity,
    _windows_process_identity,
    _process_matches,
    _await_process_identity,
    _terminate_matching,
    peer_root,
    peer_dir,
    state_path,
    spec_path,
    ready_path,
    identity_request_path,
    log_path,
    _lock_root,
    validate_spec,
    load_spec,
    plan,
    _status_from_state,
    status,
    list_status,
    _host_command,
    _product_entry_command,
    _wait_for_ensure_status,
    ensure,
    stop,
    restart,
    declare_ready_from_environment,
    _bound_peer_identity_from_environment,
    _peer_identity_binding_timeout,
    _ready_mismatch_fields,
    _ready_matches,
    _host_write_state,
    _host_bind_state,
    _spawn_peer,
    _await_peer_identity_request,
    _is_process_or_descendant,
    _managed_peer_alive,
    run_host,
    _main,
):
    _facade_callable.__module__ = __name__
del _facade_callable


# Preserve the canonical identity when executed with python -m.
sys.modules.setdefault("kungfu.peer_lifecycle", sys.modules[__name__])

if __name__ == "__main__":
    raise SystemExit(_main())
