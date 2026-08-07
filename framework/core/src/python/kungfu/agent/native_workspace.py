# SPDX-License-Identifier: Apache-2.0

import json
import os
from pathlib import Path

from kungfu.workspace import (
    WorkspaceTargetRequired,
    load_workspace_registry,
    resolve_workspace_target,
)


def unbound_work_selection(workspace_id):
    return {
        "schema": "kungfu.native-work-selection/v1",
        "workspaceId": workspace_id,
        "state": "none",
        "candidateAssignmentIds": [],
        "settledAssignmentIds": [],
        "selectionAuthority": "kungfu-work-cli",
        "entrypoint": "kungfu work status",
    }


def resolve_native_launch_target(ctx, workspace_root=None, *, cwd=None):
    """Resolve native provider cwd without requiring durable Project Work."""

    source_cwd = str(Path(cwd or os.getcwd()).expanduser().resolve())
    if workspace_root:
        target = resolve_workspace_target("read-only", workspace_root, cwd=source_cwd)
        return target, target.identity.workspace_root, "explicit-project"

    environment_root = os.environ.get("KF_WORKSPACE_ROOT")
    if environment_root:
        target = resolve_workspace_target("read-only", environment_root, cwd=source_cwd)
        return target, target.identity.workspace_root, "environment-project"

    discovery_environment = dict(os.environ)
    for name in ("KF_WORKSPACE_ROOT", "KF_HOME", "KF_RUNTIME_DIR"):
        discovery_environment.pop(name, None)
    try:
        target = resolve_workspace_target(
            "read-only", cwd=source_cwd, env=discovery_environment
        )
        if target.identity.workspace_kind == "project":
            return target, target.identity.workspace_root, "working-directory-project"
    except WorkspaceTargetRequired:
        pass

    active_root = os.environ.get("KUNGFU_WORKSPACE_ROOT")
    if active_root:
        try:
            target = resolve_workspace_target("read-only", active_root, cwd=source_cwd)
            if target.identity.workspace_kind == "project":
                return target, target.identity.workspace_root, "active-project"
        except (OSError, ValueError):
            pass

    try:
        registry = load_workspace_registry(config_home=ctx.config_home)
    except (OSError, ValueError, json.JSONDecodeError):
        registry = {"last_workspace_id": None, "recent": []}
    selected_id = registry.get("last_workspace_id")
    selected = next(
        (
            row
            for row in registry.get("recent") or []
            if row.get("workspace_id") == selected_id
            and row.get("workspace_kind") == "project"
            and row.get("workspace_root")
        ),
        None,
    )
    if selected is not None:
        try:
            target = resolve_workspace_target(
                "read-only", str(selected["workspace_root"]), cwd=source_cwd
            )
            if target.identity.workspace_id == selected_id:
                return target, target.identity.workspace_root, "selected-project"
        except (OSError, ValueError):
            pass

    home_environment = {
        **os.environ,
        "KF_CONFIG_HOME": str(ctx.config_home),
        "KF_HOME": str(ctx.home),
    }
    target = resolve_workspace_target(
        "capture-only", home=True, cwd=source_cwd, env=home_environment
    )
    return target, source_cwd, "working-directory-unbound"


def prepare_native_launch(ctx, workspace_root, provider_name, project_work_binding):
    target, launch_root, resolution = resolve_native_launch_target(ctx, workspace_root)
    if target.identity.workspace_kind == "project":
        work_ref, work_selection = project_work_binding(
            target.identity.workspace_root,
            target.identity.workspace_id,
            target.runtime_dir,
        )
    else:
        work_ref = None
        work_selection = unbound_work_selection(target.identity.workspace_id)
    notices = []
    if resolution == "selected-project":
        notices.append(f"Project: {launch_root} (current selection)")
    elif resolution == "working-directory-unbound":
        notices.append(
            f"No Project is selected for {launch_root}; starting {provider_name} "
            "in this directory without durable Work binding. Use `kungfu project "
            "create-plan` or `kungfu project select <path>` when you want a Project."
        )
    if provider_name == "codex":
        notices.append(
            f"Codex may ask whether to trust {launch_root}. Answer the prompt in "
            "this terminal; Kungfu will not answer it for you."
        )
    return target, launch_root, work_ref, work_selection, notices
