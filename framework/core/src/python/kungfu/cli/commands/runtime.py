# SPDX-License-Identifier: Apache-2.0

"""Stable facade for resident runtime command domains."""

from __future__ import annotations

import sys as sys
from typing import Any as Any

from kungfu import contract as contract_runtime  # noqa: F401
from kungfu import peer_lifecycle as peer_lifecycle
from kungfu import runtime_broker as runtime_broker
from kungfu import runtime_service as runtime_service
from kungfu import runtime_upgrade as runtime_upgrade
from kungfu.cli.preflight import command_preflight as command_preflight

from kungfu.cli.commands._runtime.base import (
    json as json,
    Path as Path,
    click as click,
    diagnostics as diagnostics,
    PrioritizedCommandGroup as PrioritizedCommandGroup,
    kfc as kfc,
    runtime_surface as runtime_surface,
    runtime_command_context as runtime_command_context,
    _json as _json,
    _load_object as _load_object,
    _load_array as _load_array,
    _plain_status as _plain_status,
    runtime as runtime,
    runtime_surface_group as runtime_surface_group,
    runtime_surface_contract as runtime_surface_contract,
    runtime_surface_resolve as runtime_surface_resolve,
    runtime_surface_verify as runtime_surface_verify,
)
from kungfu.cli.commands._runtime.peer import (
    runtime_peer as runtime_peer,
    _peer_spec as _peer_spec,
    _peer_call as _peer_call,
    peer_contract as peer_contract,
    peer_plan as peer_plan,
    peer_start as peer_start,
    peer_ensure as peer_ensure,
    peer_status as peer_status,
    peer_health as peer_health,
    peer_stop as peer_stop,
    peer_restart as peer_restart,
    peer_host as peer_host,
)
from kungfu.cli.commands._runtime.upgrade import (
    runtime_upgrade_group as runtime_upgrade_group,
    upgrade_contract as upgrade_contract,
    upgrade_inventory as upgrade_inventory,
    upgrade_plan_install as upgrade_plan_install,
    upgrade_install as upgrade_install,
    upgrade_plan as upgrade_plan,
    upgrade_stage as upgrade_stage,
    upgrade_reconcile as upgrade_reconcile,
    upgrade_gc_plan as upgrade_gc_plan,
    upgrade_gc as upgrade_gc,
)
from kungfu.cli.commands._runtime.service import (
    runtime_status as runtime_status,
    runtime_operations as runtime_operations,
    runtime_plan as runtime_plan,
    ensure as ensure,
    start as start,
    stop as stop,
    restart as restart,
    run as run,
    assess_worker as assess_worker,
    assessments as assessments,
    trust as trust,
    supervise as supervise,
    service as service,
    plan as plan,
    service_status as service_status,
    install as install,
    uninstall as uninstall,
)
