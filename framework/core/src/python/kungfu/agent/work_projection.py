# SPDX-License-Identifier: Apache-2.0

"""Bounded, authority-preserving Work projection for native Agent sessions."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import json
import os
from pathlib import Path
import re
import time
from typing import Any

from kungfu.agent.session_contract import semantic_root, validate_work_ref


STARTUP_SCHEMA = "kungfu.agent-work-lab.startup-route/v1"
CONTENT_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
MIGRATION_MARKERS = (
    ".migration-in-progress",
    ".storage-migration-in-progress",
    "migration.lock",
)


def _startup_result(
    runtime_dir: Path,
    state: str,
    route: str,
    code: str,
    message: str,
    work_present: bool | None,
    evidence: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "schema": STARTUP_SCHEMA,
        "state": state,
        "route": route,
        "reasonCode": code,
        "message": message,
        "runtimeDir": str(runtime_dir),
        "workGraphPresent": work_present,
        "evidence": evidence or [],
        "writeOccurred": False,
    }


def _startup_diagnostic(
    runtime_dir: Path, code: str, message: str, *, evidence: list[str] | None = None
) -> dict[str, Any]:
    return _startup_result(
        runtime_dir, "diagnostic", "diagnostic", code, message, None, evidence
    )


def inspect_startup(
    runtime_dir: str | Path,
    *,
    config_home: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Resolve startup from an already-materialized observer snapshot only."""

    del env
    selected = Path(runtime_dir).expanduser()
    try:
        if selected.exists():
            if selected.is_symlink() or not selected.is_dir():
                return _startup_diagnostic(
                    selected.absolute(),
                    "runtime-home-invalid",
                    "The Kungfu runtime home is not a regular directory.",
                )
            selected = selected.resolve()
            if not os.access(selected, os.R_OK | os.X_OK):
                return _startup_diagnostic(
                    selected,
                    "runtime-home-permission-denied",
                    "The Kungfu runtime home cannot be inspected safely.",
                )
            markers = [name for name in MIGRATION_MARKERS if (selected / name).exists()]
            if markers:
                return _startup_diagnostic(
                    selected,
                    "runtime-migration-in-progress",
                    "Kungfu data is migrating; startup will not classify it as empty.",
                    evidence=markers,
                )
        else:
            selected = selected.absolute()

        config_root = Path(
            config_home
            if config_home is not None
            else os.environ.get("KF_CONFIG_HOME") or Path.home() / ".config" / "kungfu"
        ).expanduser()
        snapshots: list[tuple[int, dict[str, Any], Path]] = []
        for state_path in (
            config_root / "tui" / "global-work-observer.json",
            config_root / "gui" / "global-work-observer.json",
        ):
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                query = state.get("query") if isinstance(state, Mapping) else None
                if state.get(
                    "schema"
                ) != "kungfu.gui.global-work-observer/v2" or not isinstance(
                    query, Mapping
                ):
                    continue
                snapshots.append(
                    (state_path.stat().st_mtime_ns, dict(query), state_path)
                )
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                continue
        if not snapshots:
            return _startup_diagnostic(
                selected,
                "global-work-observation-unavailable",
                "No verified global Work observer snapshot is available yet; "
                "open All Work to start the bounded observer.",
            )
        _, query, state_path = max(snapshots, key=lambda row: row[0])
        verification = query.get("verification")
        aggregate = query.get("aggregate")
        global_work = query.get("global_work")
        proof = query.get("proof")
        if (
            not isinstance(verification, Mapping)
            or verification.get("ok") is not True
            or not isinstance(aggregate, Mapping)
            or aggregate.get("writes") != 0
            or not isinstance(global_work, Mapping)
            or global_work.get("writes") != 0
            or not isinstance(proof, Mapping)
            or query.get("writes") != []
        ):
            return _startup_diagnostic(
                selected,
                "global-work-unverified",
                "The global Work projection is incomplete or cannot be verified.",
            )
        canonical_count = global_work.get("canonical_work_count")
        if (
            type(canonical_count) is not int
            or canonical_count < 0
            or aggregate.get("canonical_work_count") != canonical_count
        ):
            return _startup_diagnostic(
                selected,
                "global-work-invalid",
                "The global Work projection has inconsistent canonical counts.",
            )
        projection_root = str(global_work.get("projection_root") or "")
        proof_root = str(proof.get("proof_root") or "")
        if not CONTENT_ROOT.fullmatch(projection_root) or not CONTENT_ROOT.fullmatch(
            proof_root
        ):
            return _startup_diagnostic(
                selected,
                "global-work-invalid",
                "The global Work projection is missing root-bound evidence.",
            )
        evidence = [projection_root, proof_root, str(state_path)]
        if canonical_count:
            return _startup_result(
                selected,
                "existing-work",
                "work-graph",
                "global-work-present",
                "Canonical local Work graph data is present.",
                True,
                evidence,
            )
        if aggregate.get("complete") is not True:
            return _startup_diagnostic(
                selected,
                "global-work-unverified",
                "The global Work projection is incomplete or cannot be verified.",
            )
        return _startup_result(
            selected,
            "verified-empty",
            "agent-work-lab",
            "global-work-verified-empty",
            "No canonical local Work graph data is present.",
            False,
        )
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        return _startup_diagnostic(
            selected.absolute(),
            "global-work-unreadable",
            f"The global Work projection cannot be inspected safely: {error}",
        )


class WorkProjectionPort:
    """Cache full Work status independently from high-frequency liveness.

    The port is read-only. It polls only on first binding, explicit invalidation,
    or a bounded fallback deadline and retains the last coherent projection if
    a later authority query is temporarily unavailable.
    """

    def __init__(
        self,
        resolver: Callable[[Mapping[str, Any]], Mapping[str, Any]],
        *,
        fallback_seconds: float = 2.0,
        monotonic: Callable[[], float] = time.monotonic,
        wall_time_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        if fallback_seconds <= 0:
            raise ValueError("Work projection fallback must be positive")
        self._resolver = resolver
        self._fallback_seconds = fallback_seconds
        self._monotonic = monotonic
        self._wall_time_ms = wall_time_ms
        self._entries: dict[str, dict[str, Any]] = {}
        self.query_count = 0

    @staticmethod
    def _key(work_ref: Mapping[str, Any]) -> str:
        value = validate_work_ref(work_ref)
        identity = {
            "workspaceId": value["workspaceId"],
            "profileId": value["profileId"],
            "entityType": value["entityType"],
            "entityId": value["entityId"],
            **(
                {"initiativeId": value["initiativeId"]}
                if value.get("initiativeId")
                else {}
            ),
        }
        return semantic_root(identity)

    def invalidate(self, work_ref: Mapping[str, Any]) -> None:
        entry = self._entries.get(self._key(work_ref))
        if entry is not None:
            entry["invalidated"] = True

    def refresh(
        self, work_ref: Mapping[str, Any], *, force: bool = False
    ) -> dict[str, Any] | None:
        work = validate_work_ref(work_ref)
        key = self._key(work)
        now = self._monotonic()
        prior = self._entries.get(key)
        invalidated = bool(prior and prior.get("invalidated"))
        if (
            not force
            and not invalidated
            and prior is not None
            and now < float(prior["nextRefreshAt"])
        ):
            return None

        source = (
            "initial"
            if prior is None
            else "invalidation"
            if invalidated
            else "bounded-fallback"
        )
        self.query_count += 1
        observed_at = self._wall_time_ms()
        try:
            result = dict(self._resolver(work))
            projected_work = result.get("work")
            if projected_work is not None and not isinstance(projected_work, Mapping):
                raise ValueError("Work projection resolver returned invalid work")
            state = str(result.get("state") or "unknown")
            if state not in {"fresh", "degraded", "unknown"}:
                raise ValueError("Work projection resolver returned invalid state")
            retained = prior.get("snapshot") if prior else None
            if state != "fresh" and retained and retained.get("work"):
                projected_work = retained["work"]
                state = "stale"
            snapshot = {
                "schema": "kungfu.native-work-projection/v1",
                "workRefRoot": semantic_root(work),
                "state": state,
                "observedAt": observed_at,
                "source": source,
                "queryCount": self.query_count,
                "queryProofRoot": (
                    projected_work.get("queryProofRoot")
                    if isinstance(projected_work, Mapping)
                    else None
                ),
                "work": dict(projected_work) if projected_work is not None else None,
                "diagnostic": result.get("diagnostic"),
            }
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            retained = prior.get("snapshot") if prior else None
            snapshot = {
                "schema": "kungfu.native-work-projection/v1",
                "workRefRoot": semantic_root(work),
                "state": "stale" if retained and retained.get("work") else "degraded",
                "observedAt": observed_at,
                "source": source,
                "queryCount": self.query_count,
                "queryProofRoot": (
                    retained.get("queryProofRoot") if retained else None
                ),
                "work": retained.get("work") if retained else None,
                "diagnostic": str(error),
            }
        self._entries[key] = {
            "snapshot": snapshot,
            "nextRefreshAt": now + self._fallback_seconds,
            "invalidated": False,
        }
        return dict(snapshot)
