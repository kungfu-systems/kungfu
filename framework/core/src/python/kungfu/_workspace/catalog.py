# SPDX-License-Identifier: Apache-2.0

"""Own the machine-local workspace locator catalog and lifecycle contracts."""

from __future__ import annotations

import importlib
import json
import os
import re
from datetime import datetime
from typing import Any, Literal, Mapping, Protocol

from kungfu._workspace.io import (
    _now,
    _semantic_root,
    _workspace_available,
    _workspace_config_home,
    _write_json_atomic,
)


CATALOG_SCHEMA = "kungfu.workspace.locator-catalog/v1"
CATALOG_ENTRY_SCHEMA = "kungfu.workspace.locator-entry/v1"
CATALOG_VERIFICATION_SCHEMA = "kungfu.workspace.locator-verification/v1"
CATALOG_CUT_SCHEMA = "kungfu.workspace.locator-catalog-cut/v1"
CATALOG_LIFECYCLE_PLAN_SCHEMA = "kungfu.workspace.catalog-lifecycle-plan/v1"
CATALOG_LIFECYCLE_RECEIPT_SCHEMA = "kungfu.workspace.catalog-lifecycle-receipt/v1"

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
CatalogLifecycleState = Literal["active", "retired", "test-only", "quarantined"]
_CATALOG_EXCLUSION_POLICY = {
    "retired": "explicit-retirement",
    "test-only": "isolated-test-fixture",
    "quarantined": "explicit-quarantine",
}


class WorkspaceIdentityView(Protocol):
    workspace_id: str
    identity_root: str
    identity_state: str
    workspace_kind: str
    workspace_root: str | None
    data_home: str
    resolution_reason: str


WorkspaceIdentity = WorkspaceIdentityView


class LoadRegistry(Protocol):
    def __call__(
        self,
        config_home: str | None = None,
        *,
        env: Mapping[str, str] | None = None,
    ) -> dict[str, Any]: ...


class HomeIdentity(Protocol):
    def __call__(
        self, env: Mapping[str, str], resolution_reason: str
    ) -> WorkspaceIdentityView: ...


class ProjectIdentity(Protocol):
    def __call__(
        self,
        workspace_root: str,
        resolution_reason: str,
        *,
        env: Mapping[str, str] | None = None,
    ) -> WorkspaceIdentityView: ...


def load_workspace_registry(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    workspace = importlib.import_module("kungfu.workspace")
    return workspace.load_workspace_registry(config_home, env=env)


def _home_identity(
    env: Mapping[str, str], resolution_reason: str
) -> WorkspaceIdentityView:
    workspace = importlib.import_module("kungfu.workspace")
    return workspace._home_identity(env, resolution_reason)


def _project_identity(
    workspace_root: str,
    resolution_reason: str,
    *,
    env: Mapping[str, str] | None = None,
) -> WorkspaceIdentityView:
    workspace = importlib.import_module("kungfu.workspace")
    return workspace._project_identity(workspace_root, resolution_reason, env=env)


def workspace_catalog_path(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    """Return the machine-local locator Catalog path.

    The Catalog is deliberately separate from bounded GUI recents and from
    every workspace's semantic authority.
    """

    return os.path.join(
        config_home or _workspace_config_home(env),
        "workspaces",
        "catalog.json",
    )


def load_workspace_catalog(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Read the locator Catalog without creating or repairing it."""

    path = workspace_catalog_path(config_home, env=env)
    payload: dict[str, Any]
    if not os.path.exists(path):
        payload = {
            "schema": CATALOG_SCHEMA,
            "entries": [],
            "epoch": 0,
        }
        return _loaded_catalog(payload, path)
    try:
        with open(path, encoding="utf-8") as stream:
            loaded_payload = json.load(stream)
        if (
            not isinstance(loaded_payload, dict)
            or loaded_payload.get("schema") != CATALOG_SCHEMA
            or not isinstance(loaded_payload.get("entries"), list)
        ):
            raise ValueError("Catalog contract mismatch")
        payload = loaded_payload
        persisted_cut = _catalog_cut(payload)
        entries: list[dict[str, Any]] = []
        for entry in payload["entries"]:
            if (
                not isinstance(entry, dict)
                or entry.get("schema") != CATALOG_ENTRY_SCHEMA
            ):
                raise ValueError("Catalog entry contract mismatch")
            identity_state = str(entry.get("identity_state") or "qualified")
            identity_root = str(entry.get("identity_root") or "")
            locator_key = str(entry.get("locator_key") or "")
            if identity_state not in {"qualified", "locator-candidate"}:
                raise ValueError("Catalog entry identity_state is invalid")
            if identity_state == "qualified" and not _ROOT.fullmatch(identity_root):
                raise ValueError("Catalog entry identity_root is invalid")
            if identity_state == "locator-candidate" and (
                identity_root or not _ROOT.fullmatch(locator_key)
            ):
                raise ValueError("Catalog locator candidate is invalid")
            lifecycle = _catalog_lifecycle(entry)
            entries.append(
                {
                    **dict(entry),
                    "provenance": _catalog_provenance(entry),
                    "lifecycle": lifecycle,
                    "retained": True,
                    "required": lifecycle["state"] not in _CATALOG_EXCLUSION_POLICY,
                    "exclusion_policy": _CATALOG_EXCLUSION_POLICY.get(
                        lifecycle["state"]
                    ),
                }
            )
        return {
            **payload,
            "entries": entries,
            "epoch": int(payload.get("epoch") or 0),
            "issues": [],
            "catalog_path": path,
            "catalog_cut": persisted_cut,
        }
    except (OSError, ValueError, json.JSONDecodeError) as error:
        fallback = {
            "schema": CATALOG_SCHEMA,
            "entries": [],
            "epoch": 0,
        }
        return {
            **fallback,
            "issues": [
                {
                    "code": "catalog-invalid",
                    "path": path,
                    "message": str(error),
                }
            ],
            "catalog_path": path,
            "catalog_cut": _catalog_cut(fallback),
        }


def observe_workspace_locator(
    identity: WorkspaceIdentityView,
    *,
    lifecycle: CatalogLifecycleState = "active",
    lifecycle_reason: str | None = None,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Record one explicitly selected or successfully written locator."""

    if lifecycle not in {"active", "test-only"}:
        raise ValueError(
            "initial Catalog observation supports only active or test-only; "
            "use catalog-maintain for other lifecycle states"
        )
    lifecycle_reason = str(lifecycle_reason or "").strip()
    if lifecycle != "active" and not lifecycle_reason:
        raise ValueError("non-active Catalog observation requires a reason")

    catalog = load_workspace_catalog(config_home, env=env)
    if catalog["issues"]:
        raise ValueError(
            "invalid Workspace Locator Catalog must be repaired explicitly"
        )
    observed_at = _now()
    entry = _catalog_entry(
        identity,
        observed_at,
        provenance={
            "source": "explicit-observation",
            "registration_reason": identity.resolution_reason,
        },
    )
    if lifecycle != "active":
        entry["provenance"] = {
            "source": "explicit-disposable-observation",
            "registration_reason": lifecycle_reason,
        }
        entry["lifecycle"] = {
            "state": lifecycle,
            "reason": lifecycle_reason,
            "transitioned_at": observed_at,
            "previous_state": None,
        }
    existing = next(
        (
            row
            for row in catalog["entries"]
            if _catalog_entry_key(row) == _catalog_entry_key(entry)
        ),
        None,
    )
    if existing is not None:
        if lifecycle != _catalog_lifecycle(existing)["state"]:
            raise ValueError(
                "existing Catalog lifecycle must change through catalog-maintain"
            )
        entry["lifecycle"] = _catalog_lifecycle(existing)
        entry["provenance"] = _catalog_provenance(existing)
        unchanged_entry = {
            **entry,
            "observed_at": existing.get("observed_at"),
        }
        conflicting_locator = any(
            _catalog_entry_key(row) != _catalog_entry_key(entry)
            and identity.identity_state == "qualified"
            and row.get("locator_key") == entry["locator_key"]
            for row in catalog["entries"]
        )
        if (
            _persisted_catalog_entry(existing) == unchanged_entry
            and not conflicting_locator
        ):
            # The Catalog is a locator set, not a recency log. Re-observing the
            # same locator must not invalidate a live federation query cut.
            payload = {
                "schema": CATALOG_SCHEMA,
                "entries": [
                    _persisted_catalog_entry(row) for row in catalog["entries"]
                ],
                "epoch": int(catalog.get("epoch") or 0),
            }
            if "updated_at" in catalog:
                payload["updated_at"] = catalog["updated_at"]
            return {
                **payload,
                "catalog_path": catalog["catalog_path"],
                "catalog_cut": catalog["catalog_cut"],
                "observed": _persisted_catalog_entry(existing),
                "changed": False,
            }
    entries: list[dict[str, Any]] = []
    replaced = False
    for row in catalog["entries"]:
        if _catalog_entry_key(row) == _catalog_entry_key(entry):
            entries.append(entry)
            replaced = True
            continue
        if (
            identity.identity_state == "qualified"
            and row.get("locator_key") == entry["locator_key"]
        ):
            continue
        entries.append(_persisted_catalog_entry(row))
    if not replaced:
        entries.insert(0, entry)
    payload = {
        "schema": CATALOG_SCHEMA,
        "entries": entries,
        "epoch": int(catalog.get("epoch") or 0) + 1,
        "updated_at": observed_at,
    }
    path = workspace_catalog_path(config_home, env=env)
    _write_json_atomic(path, payload)
    return {
        **payload,
        "catalog_path": path,
        "catalog_cut": _catalog_cut(payload),
        "observed": entry,
        "changed": True,
    }


def rebuild_workspace_catalog(
    workspace_roots: list[str] | None = None,
    *,
    include_recents: bool = True,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Rebuild discovery only from bounded recents and explicit locators.

    This never scans parent directories or the filesystem for ``.kungfu``.
    It can repair a missing/corrupt Catalog because workspace authority remains
    in each explicitly inspected workspace.
    """

    env = os.environ if env is None else env
    identities: list[WorkspaceIdentity] = []
    sources: list[dict[str, str]] = []
    if include_recents:
        registry = load_workspace_registry(config_home, env=env)
        for row in registry["recent"]:
            kind = str(row.get("workspace_kind") or "")
            locator = row.get("workspace_root") or row.get("locator")
            try:
                identity = (
                    _home_identity(env, "catalog-rebuild-recent")
                    if kind == "home"
                    else (
                        _project_identity(
                            str(locator),
                            "catalog-rebuild-recent",
                            env=env,
                        )
                        if kind == "project" and locator
                        else None
                    )
                )
            except (OSError, ValueError):
                identity = None
            if identity is not None:
                identities.append(identity)
                sources.append(
                    {
                        "source": "bounded-recent",
                        "workspace_id": identity.workspace_id,
                    }
                )
    for root in workspace_roots or []:
        identity = _project_identity(root, "catalog-rebuild-explicit", env=env)
        identities.append(identity)
        sources.append({"source": "explicit", "workspace_id": identity.workspace_id})

    observed_at = _now()
    by_key: dict[str, dict[str, Any]] = {}
    for identity in identities:
        entry = _catalog_entry(
            identity,
            observed_at,
            provenance={
                "source": next(
                    (
                        row["source"]
                        for row in sources
                        if row["workspace_id"] == identity.workspace_id
                    ),
                    "catalog-rebuild",
                ),
                "registration_reason": identity.resolution_reason,
            },
        )
        by_key[_catalog_entry_key(entry)] = entry
    payload = {
        "schema": CATALOG_SCHEMA,
        "entries": [by_key[key] for key in sorted(by_key)],
        "epoch": int(load_workspace_catalog(config_home, env=env).get("epoch") or 0)
        + 1,
        "updated_at": observed_at,
    }
    path = workspace_catalog_path(config_home, env=env)
    _write_json_atomic(path, payload)
    return {
        **payload,
        "catalog_path": path,
        "catalog_cut": _catalog_cut(payload),
        "sources": sources,
        "filesystem_scan": False,
        "authority": False,
    }


def verify_workspace_catalog(
    config_home: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Verify every accessible locator without changing the Catalog."""

    catalog = load_workspace_catalog(config_home, env=env)
    results: list[dict[str, Any]] = []
    for entry in catalog["entries"]:
        locator = entry.get("locator")
        problem: dict[str, str] | None = None
        try:
            if entry["workspace_kind"] == "home":
                identity = _home_identity(
                    os.environ if env is None else env,
                    "catalog-verification",
                )
            elif isinstance(locator, str) and locator:
                identity = _project_identity(locator, "catalog-verification", env=env)
            else:
                identity = None
        except (OSError, ValueError) as error:
            identity = None
            problem = {
                "code": "workspace-identity-unreadable",
                "message": str(error),
            }
        available = bool(identity and _workspace_available(identity))
        actual_root = identity.identity_root if identity else ""
        result = {
            "identity_root": entry["identity_root"],
            "workspace_id": entry["workspace_id"],
            "available": available,
            "identity_matches": bool(
                available and actual_root == entry["identity_root"]
            ),
            "actual_identity_root": actual_root,
        }
        if problem is not None:
            result["problem"] = problem
        results.append(result)
    ok = not catalog["issues"] and all(
        ("problem" not in row) and (not row["available"] or row["identity_matches"])
        for row in results
    )
    return {
        "schema": CATALOG_VERIFICATION_SCHEMA,
        "ok": ok,
        "catalog_path": catalog["catalog_path"],
        "catalog_cut": catalog["catalog_cut"],
        "epoch": catalog["epoch"],
        "issues": catalog["issues"],
        "entries": results,
        "authority": False,
        "writes": [],
    }


def maintain_workspace_catalog(
    entry_keys: list[str],
    action: Literal["retire", "test-only", "quarantine", "restore"],
    reason: str,
    *,
    execute: bool = False,
    transitioned_at: str | None = None,
    expected_plan_root: str | None = None,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Plan or execute explicit, reversible Catalog lifecycle transitions.

    The Catalog contains locators only. This operation never touches a
    workspace, its ``.kungfu`` authority, or any Work evidence. Dry-run is the
    default and the execute path is bound to the exact Catalog cut it planned.
    """

    reason = reason.strip()
    if action not in {"retire", "test-only", "quarantine", "restore"}:
        raise ValueError("unsupported Catalog lifecycle action")
    if not reason:
        raise ValueError("Catalog lifecycle maintenance requires a reason")
    if transitioned_at is not None:
        try:
            parsed_transition = datetime.fromisoformat(
                transitioned_at.replace("Z", "+00:00")
            )
        except ValueError as error:
            raise ValueError(
                "Catalog lifecycle transitioned_at must be an ISO-8601 timestamp"
            ) from error
        if parsed_transition.tzinfo is None:
            raise ValueError(
                "Catalog lifecycle transitioned_at must include a timezone"
            )
    if expected_plan_root is not None:
        if not execute:
            raise ValueError(
                "expected Catalog lifecycle plan root requires execute=True"
            )
        if transitioned_at is None:
            raise ValueError(
                "expected Catalog lifecycle plan root requires transitioned_at"
            )
        if not _ROOT.fullmatch(expected_plan_root):
            raise ValueError(
                "expected Catalog lifecycle plan root must be a SHA-256 root"
            )
    requested = set(entry_keys)
    if not requested:
        raise ValueError("Catalog lifecycle maintenance requires an entry key")
    catalog = load_workspace_catalog(config_home, env=env)
    if catalog["issues"]:
        raise ValueError("invalid Workspace Locator Catalog must be repaired first")
    by_key = {_catalog_entry_key(row): row for row in catalog["entries"]}
    missing = sorted(requested - set(by_key))
    if missing:
        raise ValueError(f"Catalog entry key not found: {missing[0]}")

    target_state: CatalogLifecycleState = {
        "restore": "active",
        "retire": "retired",
        "test-only": "test-only",
        "quarantine": "quarantined",
    }[action]  # type: ignore[assignment]
    transitioned_at = transitioned_at or _now()
    changes: list[dict[str, Any]] = []
    persisted_entries: list[dict[str, Any]] = []
    for row in catalog["entries"]:
        before = _persisted_catalog_entry(row)
        key = _catalog_entry_key(row)
        if key not in requested:
            persisted_entries.append(before)
            continue
        after = {
            **before,
            "lifecycle": {
                "state": target_state,
                "reason": reason,
                "transitioned_at": transitioned_at,
                "previous_state": _catalog_lifecycle(row)["state"],
            },
        }
        changes.append(
            {
                "entry_key": key,
                "workspace_id": row.get("workspace_id"),
                "identity_root": row.get("identity_root"),
                "locator": row.get("locator"),
                "before": before,
                "after": after,
            }
        )
        persisted_entries.append(after)

    next_payload = {
        "schema": CATALOG_SCHEMA,
        "entries": persisted_entries,
        "epoch": int(catalog.get("epoch") or 0) + 1,
        "updated_at": transitioned_at,
    }
    plan = {
        "schema": CATALOG_LIFECYCLE_PLAN_SCHEMA,
        "action": action,
        "reason": reason,
        "catalog_path": catalog["catalog_path"],
        "catalog_cut_before": catalog["catalog_cut"],
        "catalog_cut_after": _catalog_cut(next_payload),
        "epoch_before": int(catalog.get("epoch") or 0),
        "epoch_after": next_payload["epoch"],
        "changes": changes,
        "workspace_writes": 0,
        "authority_writes": 0,
        "rollback": "restore each before entry from this receipt at the recorded cut",
    }
    plan_root = _semantic_root(
        {key: value for key, value in plan.items() if key != "catalog_path"}
    )
    if expected_plan_root is not None and plan_root != expected_plan_root:
        raise ValueError(
            "Catalog lifecycle plan does not match expected dry-run plan root"
        )
    if not execute:
        return {
            **plan,
            "plan_root": plan_root,
            "executed": False,
            "writes": [],
        }

    current = load_workspace_catalog(config_home, env=env)
    if current["catalog_cut"] != plan["catalog_cut_before"]:
        raise ValueError("Catalog changed after planning; retry from a fresh dry-run")
    _write_json_atomic(catalog["catalog_path"], next_payload)
    receipt_body = {
        "schema": CATALOG_LIFECYCLE_RECEIPT_SCHEMA,
        "plan_root": plan_root,
        "action": action,
        "reason": reason,
        "catalog_cut_before": plan["catalog_cut_before"],
        "catalog_cut_after": plan["catalog_cut_after"],
        "epoch_before": plan["epoch_before"],
        "epoch_after": plan["epoch_after"],
        "changes": changes,
        "workspace_writes": 0,
        "authority_writes": 0,
    }
    receipt = {**receipt_body, "receipt_root": _semantic_root(receipt_body)}
    receipt_path = os.path.join(
        os.path.dirname(catalog["catalog_path"]),
        "receipts",
        receipt["receipt_root"].removeprefix("sha256:") + ".json",
    )
    _write_json_atomic(receipt_path, receipt)
    return {
        **plan,
        "plan_root": plan_root,
        "executed": True,
        "receipt": {**receipt, "receipt_path": receipt_path},
        "writes": [catalog["catalog_path"], receipt_path],
    }


def rebind_workspace_locator(
    identity_root: str,
    workspace_root: str,
    *,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Rebind one exact identity to a moved locator after verification."""

    if not _ROOT.fullmatch(identity_root):
        raise ValueError("identity_root must be a SHA-256 root")
    identity = _project_identity(workspace_root, "catalog-rebind", env=env)
    if identity.identity_root != identity_root:
        raise ValueError("new locator does not contain the expected workspace identity")
    return observe_workspace_locator(
        identity,
        config_home=config_home,
        env=env,
    )


def _catalog_entry(
    identity: WorkspaceIdentityView,
    observed_at: str,
    *,
    provenance: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    locator_key = _semantic_root(
        {
            "schema": "kungfu.workspace.locator-key/v1",
            "workspace_kind": identity.workspace_kind,
            "locator": identity.workspace_root or "home",
        }
    )
    return {
        "schema": CATALOG_ENTRY_SCHEMA,
        "workspace_id": identity.workspace_id,
        "identity_root": identity.identity_root,
        "identity_state": identity.identity_state,
        "locator_key": locator_key,
        "workspace_kind": identity.workspace_kind,
        "locator": identity.workspace_root,
        "data_home": identity.data_home,
        "available": _workspace_available(identity),
        "observed_at": observed_at,
        "provenance": dict(
            provenance
            or {
                "source": "explicit-observation",
                "registration_reason": identity.resolution_reason,
            }
        ),
        "lifecycle": {
            "state": "active",
            "reason": "observed",
            "transitioned_at": observed_at,
            "previous_state": None,
        },
    }


def _catalog_entry_key(entry: Mapping[str, Any]) -> str:
    return str(entry.get("identity_root") or entry.get("locator_key") or "")


def _catalog_cut(payload: Mapping[str, Any]) -> str:
    body = {
        "schema": CATALOG_CUT_SCHEMA,
        "catalog": {
            "schema": payload.get("schema"),
            "entries": list(payload.get("entries") or []),
            "epoch": int(payload.get("epoch") or 0),
            "updated_at": payload.get("updated_at"),
        },
    }
    return _semantic_root(body)


def _loaded_catalog(payload: Mapping[str, Any], path: str) -> dict[str, Any]:
    return {
        **dict(payload),
        "entries": list(payload.get("entries") or []),
        "epoch": int(payload.get("epoch") or 0),
        "issues": [],
        "catalog_path": path,
        "catalog_cut": _catalog_cut(payload),
    }


def _catalog_provenance(entry: Mapping[str, Any]) -> dict[str, str]:
    value = entry.get("provenance")
    if isinstance(value, Mapping):
        source = str(value.get("source") or "legacy")
        reason = str(value.get("registration_reason") or "legacy-observation")
    else:
        source = "legacy"
        reason = "legacy-observation"
    return {"source": source, "registration_reason": reason}


def _catalog_lifecycle(entry: Mapping[str, Any]) -> dict[str, Any]:
    value = entry.get("lifecycle")
    state = str((value or {}).get("state") or "active")
    if state not in {"active", "retired", "test-only", "quarantined"}:
        raise ValueError("Catalog entry lifecycle state is invalid")
    return {
        "state": state,
        "reason": str((value or {}).get("reason") or "legacy-default-active"),
        "transitioned_at": str(
            (value or {}).get("transitioned_at") or entry.get("observed_at") or ""
        ),
        "previous_state": (value or {}).get("previous_state"),
    }


def _persisted_catalog_entry(entry: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in entry.items()
        if key
        not in {
            "retained",
            "required",
            "exclusion_policy",
        }
    }
