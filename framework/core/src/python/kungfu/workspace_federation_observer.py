# SPDX-License-Identifier: Apache-2.0

"""Durable incremental observer for machine-local global Work.

The observer owns no Work authority. It keeps root-bound component envelopes
and per-workspace Fact changelog cursors in a machine-local cache, then reloads
only components whose durable changelog advanced. Catalog drift or a changelog
gap fails into a bounded full recovery.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from typing import Any, Callable, Iterator, Mapping, Sequence

from kungfu.storage import service as storage_service
from kungfu.workspace import WorkspaceIdentity, load_workspace_catalog
from kungfu.workspace_federation import query_federation


OBSERVER_STATE_SCHEMA = "kungfu.gui.global-work-observer/v2"
OBSERVER_EVENT_SCHEMA = "kungfu.gui.global-work-observer-event/v1"
GUI_SNAPSHOT_SCHEMA = "kungfu.gui.global-work-snapshot/v1"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _compact_snapshot(query: Mapping[str, Any]) -> dict[str, Any]:
    projection = query.get("global_work") or {}
    proof = query.get("proof") or {}
    return {
        "schema": GUI_SNAPSHOT_SCHEMA,
        "observed_at": query.get("observed_at"),
        "aggregate": query.get("aggregate"),
        "verification": query.get("verification"),
        "proof": {
            "proof_root": proof.get("proof_root"),
            "catalog_cut": proof.get("catalog_cut"),
            "catalog_changed_during_query": proof.get("catalog_changed_during_query"),
        },
        "global_work": {
            "schema": projection.get("schema"),
            "projection_root": projection.get("projection_root"),
            "visible_work": projection.get("visible_work"),
            "visible_work_count": projection.get("visible_work_count"),
            "canonical_work_count": projection.get("canonical_work_count"),
            "conflict_count": projection.get("conflict_count"),
            "label_collision_count": projection.get("label_collision_count"),
        },
    }


def _load_state(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    if not all(
        (
            value.get("schema") == OBSERVER_STATE_SCHEMA,
            isinstance(value.get("query"), dict),
            isinstance(value.get("cursors"), dict),
            isinstance(value.get("signals"), dict),
        )
    ):
        return None
    return value


def _write_state(
    path: Path,
    query: Mapping[str, Any],
    cursors: Mapping[str, Any],
    signals: Mapping[str, str],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(
            {
                "schema": OBSERVER_STATE_SCHEMA,
                "updated_at": _now(),
                "catalog_cut": (query.get("proof") or {}).get("catalog_cut"),
                "cursors": cursors,
                "signals": signals,
                "query": query,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _runtime_rows(query: Mapping[str, Any]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for component in query.get("components") or []:
        workspace = component.get("workspace") or {}
        identity_root = str(workspace.get("identity_root") or "")
        workspace_id = str(workspace.get("workspace_id") or "")
        data_home = str(workspace.get("data_home") or "")
        if identity_root and workspace_id and data_home:
            rows.append(
                {
                    "identity_root": identity_root,
                    "workspace_id": workspace_id,
                    "runtime_dir": str(Path(data_home) / "runtime"),
                }
            )
    return rows


def _definition() -> dict[str, Any]:
    return storage_service.build_fact_query_definition(
        episode_id=0,
        cut={"kind": "head"},
        limit=256,
    )


def _runtime_signal(runtime_dir: str) -> str:
    """Return a cheap append-journal invalidation signal, never Work authority."""

    system_journal = Path(runtime_dir) / "journal/system"
    rows = []
    try:
        for candidate in sorted(system_journal.rglob("*.journal")):
            stat = candidate.stat()
            relative = candidate.relative_to(system_journal)
            rows.append(
                f"{relative}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}"
            )
    except OSError:
        return ""
    return "|".join(rows)


def _signals(rows: Sequence[Mapping[str, str]]) -> dict[str, str]:
    return {row["identity_root"]: _runtime_signal(row["runtime_dir"]) for row in rows}


def _poll_row(
    row: Mapping[str, str],
    cursor: Mapping[str, Any] | None,
) -> tuple[str, str, dict[str, Any], bool, bool]:
    try:
        page = storage_service.fact_changelog(
            row["runtime_dir"],
            _definition(),
            resume_token=dict(cursor) if cursor else None,
            max_messages=10_000,
        )
    except (OSError, RuntimeError, TypeError, ValueError):
        return row["identity_root"], row["workspace_id"], {}, False, True
    messages = page.get("messages") or []
    gap = any(
        isinstance(message, Mapping) and message.get("type") == "Gap"
        for message in messages
    )
    resume = page.get("resume_token")
    if not isinstance(resume, dict):
        return row["identity_root"], row["workspace_id"], {}, False, True
    previous_hash = str((cursor or {}).get("target_result_hash") or "")
    current_hash = str(resume.get("target_result_hash") or "")
    changed = bool(cursor) and previous_hash != current_hash
    return row["identity_root"], row["workspace_id"], resume, changed, gap


def _component_cache(query: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {
        str((component.get("workspace") or {}).get("identity_root") or ""): component
        for component in query.get("components") or []
        if (component.get("workspace") or {}).get("identity_root")
    }


def _observer_state_advanced(
    previous_cursors: Mapping[str, Mapping[str, Any]],
    current_cursors: Mapping[str, Mapping[str, Any]],
    previous_signals: Mapping[str, str],
    current_signals: Mapping[str, str],
    changed_roots: set[str],
) -> bool:
    return bool(
        changed_roots
        or previous_cursors != current_cursors
        or previous_signals != current_signals
    )


def _write_state_if_advanced(
    path: Path,
    query: Mapping[str, Any],
    cursors: Mapping[str, Mapping[str, Any]],
    signals: Mapping[str, str],
    previous_cursors: Mapping[str, Mapping[str, Any]],
    previous_signals: Mapping[str, str],
    changed_roots: set[str],
) -> None:
    if not _observer_state_advanced(
        previous_cursors,
        cursors,
        previous_signals,
        signals,
        changed_roots,
    ):
        return
    _write_state(path, query, cursors, signals)


def _event(
    query: Mapping[str, Any],
    *,
    mode: str,
    changed_workspace_ids: list[str],
    started: float,
) -> dict[str, Any]:
    return {
        "schema": OBSERVER_EVENT_SCHEMA,
        "kind": "snapshot",
        "mode": mode,
        "observed_at": _now(),
        "latency_ms": round((time.monotonic() - started) * 1000),
        "changed_workspace_ids": changed_workspace_ids,
        "snapshot": _compact_snapshot(query),
    }


def observe_federation(
    current: WorkspaceIdentity,
    *,
    state_path: str | Path,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    max_workers: int = 8,
    poll_interval: float = 0.5,
    include_settled: bool = False,
    stop: Callable[[], bool] | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield compact snapshots while preserving component-local refresh."""

    state_file = Path(state_path)
    stop = stop or (lambda: False)
    state = _load_state(state_file)
    catalog = load_workspace_catalog(config_home, env=env)
    query: dict[str, Any] | None = None
    cursors: dict[str, dict[str, Any]] = {}
    signals: dict[str, str] = {}

    state_value = state or {}
    if all(
        (
            state is not None,
            state_value.get("catalog_cut") == catalog.get("catalog_cut"),
            (state_value.get("query") or {}).get("verification", {}).get("ok") is True,
            bool(
                ((state_value.get("query") or {}).get("global_work") or {})
                .get("filter", {})
                .get("include_settled")
            )
            is include_settled,
        )
    ):
        query = dict(state_value["query"])
        cursors = {
            str(key): dict(value)
            for key, value in state_value["cursors"].items()
            if isinstance(value, dict)
        }
        signals = {
            str(key): str(value) for key, value in state_value["signals"].items()
        }
        yield _event(
            query,
            mode="resume",
            changed_workspace_ids=[],
            started=time.monotonic(),
        )

    if query is None:
        started = time.monotonic()
        query = query_federation(
            current,
            scope="all",
            config_home=config_home,
            env=env,
            max_workers=max_workers,
            include_settled=include_settled,
        )
        cursors = {}
        signals = _signals(_runtime_rows(query))
        _write_state(state_file, query, cursors, signals)
        yield _event(
            query,
            mode="recovery",
            changed_workspace_ids=[],
            started=started,
        )

    while not stop():
        time.sleep(poll_interval)
        started = time.monotonic()
        catalog = load_workspace_catalog(config_home, env=env)
        if catalog.get("catalog_cut") != (query.get("proof") or {}).get("catalog_cut"):
            query = query_federation(
                current,
                scope="all",
                config_home=config_home,
                env=env,
                max_workers=max_workers,
                include_settled=include_settled,
            )
            cursors = {}
            signals = _signals(_runtime_rows(query))
            _write_state(state_file, query, cursors, signals)
            yield _event(
                query,
                mode="recovery",
                changed_workspace_ids=[],
                started=started,
            )
            continue

        rows = _runtime_rows(query)
        current_signals = _signals(rows)
        signaled_roots = {
            row["identity_root"]
            for row in rows
            if signals.get(row["identity_root"], current_signals[row["identity_root"]])
            != current_signals[row["identity_root"]]
        }
        if signaled_roots:
            signaled_ids = sorted(
                row["workspace_id"]
                for row in rows
                if row["identity_root"] in signaled_roots
            )
            query = query_federation(
                current,
                scope="all",
                config_home=config_home,
                env=env,
                max_workers=max_workers,
                include_settled=include_settled,
                component_cache=_component_cache(query),
                refresh_identity_roots=signaled_roots,
            )
            # The append journal is only a fast invalidation hint. Re-baseline
            # the durable changelog cursor after the exact component reload.
            for row in rows:
                if row["identity_root"] not in signaled_roots:
                    continue
                (
                    identity_root,
                    _workspace_id,
                    cursor,
                    _changed,
                    gap,
                ) = _poll_row(row, None)
                if cursor and not gap:
                    cursors[identity_root] = cursor
            signals = current_signals
            _write_state(state_file, query, cursors, signals)
            yield _event(
                query,
                mode="incremental",
                changed_workspace_ids=signaled_ids,
                started=started,
            )
            continue

        with ThreadPoolExecutor(
            max_workers=max(1, min(max_workers, len(rows) or 1))
        ) as executor:
            observations = list(
                executor.map(
                    lambda row: _poll_row(row, cursors.get(str(row["identity_root"]))),
                    rows,
                )
            )
        if any(gap for _, _, _, _, gap in observations):
            post_poll_signals = _signals(rows)
            raced_roots = {
                row["identity_root"]
                for row in rows
                if signals.get(
                    row["identity_root"], post_poll_signals[row["identity_root"]]
                )
                != post_poll_signals[row["identity_root"]]
            }
            if raced_roots:
                raced_ids = sorted(
                    row["workspace_id"]
                    for row in rows
                    if row["identity_root"] in raced_roots
                )
                query = query_federation(
                    current,
                    scope="all",
                    config_home=config_home,
                    env=env,
                    max_workers=max_workers,
                    include_settled=include_settled,
                    component_cache=_component_cache(query),
                    refresh_identity_roots=raced_roots,
                )
                for row in rows:
                    if row["identity_root"] not in raced_roots:
                        continue
                    (
                        identity_root,
                        _workspace_id,
                        cursor,
                        _changed,
                        gap,
                    ) = _poll_row(row, None)
                    if cursor and not gap:
                        cursors[identity_root] = cursor
                signals = post_poll_signals
                _write_state(state_file, query, cursors, signals)
                yield _event(
                    query,
                    mode="incremental",
                    changed_workspace_ids=raced_ids,
                    started=started,
                )
                continue
            query = query_federation(
                current,
                scope="all",
                config_home=config_home,
                env=env,
                max_workers=max_workers,
                include_settled=include_settled,
            )
            cursors = {}
            signals = _signals(_runtime_rows(query))
            _write_state(state_file, query, cursors, signals)
            yield _event(
                query,
                mode="recovery",
                changed_workspace_ids=[],
                started=started,
            )
            continue

        previous_cursors = dict(cursors)
        previous_signals = signals
        changed_roots: set[str] = set()
        changed_ids: list[str] = []
        for identity_root, workspace_id, cursor, changed, _gap in observations:
            cursors[identity_root] = cursor
            if changed:
                changed_roots.add(identity_root)
                changed_ids.append(workspace_id)
        if changed_roots:
            query = query_federation(
                current,
                scope="all",
                config_home=config_home,
                env=env,
                max_workers=max_workers,
                include_settled=include_settled,
                component_cache=_component_cache(query),
                refresh_identity_roots=changed_roots,
            )
            yield _event(
                query,
                mode="incremental",
                changed_workspace_ids=sorted(changed_ids),
                started=started,
            )
        signals = current_signals
        _write_state_if_advanced(
            state_file,
            query,
            cursors,
            signals,
            previous_cursors,
            previous_signals,
            changed_roots,
        )
