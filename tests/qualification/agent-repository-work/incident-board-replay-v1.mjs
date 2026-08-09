// SPDX-License-Identifier: Apache-2.0

function text(value) {
  return `${value.replace(/^\n/u, '').trimEnd()}\n`;
}

const files = {
  'README.md': text(`
# Incident Board Replay

Incident Board is a small standard-library-only incident coordination service.
It accepts commands through a CLI, appends immutable JSONL events, and rebuilds
state and summaries by replaying those events after restart.

## Intended behavior

- One incident may have at most one active lease.
- A completion is authorized only by the current unexpired lease.
- Completion is idempotent across worker retry and process restart.
- Historical duplicate completion events remain readable, but they count as one
  completed incident and one accepted completion.
- Live and restarted summaries must be identical for the same event log.

Run the visible suite:

    python -m unittest discover -s tests -v

The repository intentionally contains a seeded retry/replay defect. Do not
change tests, configuration, examples, evidence, or expected outputs to hide
the defect.
`),
  'pyproject.toml': text(`
[build-system]
requires = []
build-backend = "incident_board.build"

[project]
name = "incident-board-replay"
version = "0.1.0"
description = "Deterministic incident lease and replay fixture"
requires-python = ">=3.11"
dependencies = []

[project.scripts]
incident-board = "incident_board.cli:main"
`),
  'incident_board/__init__.py': text(`
"""Incident Board public package."""

from .service import IncidentBoard
from .version import __version__

__all__ = ["IncidentBoard", "__version__"]
`),
  'incident_board/__main__.py': text(`
"""Module entry point."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
`),
  'incident_board/version.py': text(`
"""Package version."""

__version__ = "0.1.0"
`),
  'incident_board/errors.py': text(`
"""Stable domain errors used by the CLI and tests."""


class IncidentBoardError(RuntimeError):
    """Base class for expected domain failures."""


class IncidentNotFound(IncidentBoardError):
    """Raised when an incident id is unknown."""


class LeaseConflict(IncidentBoardError):
    """Raised when a lease cannot be granted."""


class CompletionRejected(IncidentBoardError):
    """Raised when a completion lacks current authority."""


class InvalidEvent(IncidentBoardError):
    """Raised when persisted input violates the event contract."""
`),
  'incident_board/clock.py': text(`
"""Clock helpers keep tests independent from wall-clock time."""

from dataclasses import dataclass
from datetime import datetime, timezone


def parse_time(value: str) -> datetime:
    """Parse one UTC ISO-8601 timestamp."""
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def format_time(value: datetime) -> str:
    """Render a timestamp in canonical UTC form."""
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class ManualClock:
    """Mutable test clock."""

    current: datetime

    @classmethod
    def at(cls, value: str) -> "ManualClock":
        return cls(parse_time(value))

    def now(self) -> datetime:
        return self.current

    def set(self, value: str) -> None:
        self.current = parse_time(value)
`),
  'incident_board/ids.py': text(`
"""Deterministic identifiers for event and command records."""

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """Return compact stable JSON."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def semantic_id(prefix: str, value: Any) -> str:
    """Create a bounded readable content identifier."""
    digest = hashlib.sha256(canonical_json(value).encode()).hexdigest()[:20]
    return f"{prefix}-{digest}"


def event_id(event_type: str, command_id: str, ordinal: int = 0) -> str:
    """Derive an event id from the command identity."""
    return semantic_id(
        "evt",
        {"type": event_type, "command_id": command_id, "ordinal": ordinal},
    )
`),
  'incident_board/domain.py': text(`
"""Domain records for incidents and leases."""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Lease:
    lease_id: str
    worker_id: str
    granted_at: str
    expires_at: str
    attempt: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "lease_id": self.lease_id,
            "worker_id": self.worker_id,
            "granted_at": self.granted_at,
            "expires_at": self.expires_at,
            "attempt": self.attempt,
        }


@dataclass
class Incident:
    incident_id: str
    title: str
    severity: str
    status: str = "open"
    lease: Lease | None = None
    completion_ids: set[str] = field(default_factory=set)
    completed_at: str | None = None
    result: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "incident_id": self.incident_id,
            "title": self.title,
            "severity": self.severity,
            "status": self.status,
            "lease": self.lease.as_dict() if self.lease else None,
            "completion_ids": sorted(self.completion_ids),
            "completed_at": self.completed_at,
            "result": self.result,
        }
`),
  'incident_board/events.py': text(`
"""Versioned event envelope."""

from dataclasses import dataclass
from typing import Any

from .errors import InvalidEvent

SUPPORTED_TYPES = {
    "incident.opened",
    "lease.granted",
    "lease.expired",
    "incident.completed",
}


@dataclass(frozen=True)
class Event:
    event_id: str
    sequence: int
    event_type: str
    incident_id: str
    occurred_at: str
    data: dict[str, Any]
    schema: str = "incident-board.event/v1"

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "event_id": self.event_id,
            "sequence": self.sequence,
            "type": self.event_type,
            "incident_id": self.incident_id,
            "occurred_at": self.occurred_at,
            "data": self.data,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Event":
        required = {
            "schema",
            "event_id",
            "sequence",
            "type",
            "incident_id",
            "occurred_at",
            "data",
        }
        if set(value) != required:
            raise InvalidEvent("event fields do not match v1")
        if value["schema"] != "incident-board.event/v1":
            raise InvalidEvent("event schema is unsupported")
        if value["type"] not in SUPPORTED_TYPES:
            raise InvalidEvent("event type is unsupported")
        if not isinstance(value["sequence"], int) or value["sequence"] < 1:
            raise InvalidEvent("event sequence must be positive")
        if not isinstance(value["data"], dict):
            raise InvalidEvent("event data must be an object")
        return cls(
            event_id=value["event_id"],
            sequence=value["sequence"],
            event_type=value["type"],
            incident_id=value["incident_id"],
            occurred_at=value["occurred_at"],
            data=value["data"],
        )
`),
  'incident_board/serde.py': text(`
"""Strict JSON serialization."""

import json
from typing import Any


def dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def loads(value: str) -> Any:
    return json.loads(value)


def pretty(value: Any) -> str:
    return json.dumps(value, sort_keys=True, indent=2)
`),
  'incident_board/event_store.py': text(`
"""Append-only JSONL event store."""

from pathlib import Path
from typing import Iterable

from .events import Event
from .serde import dumps, loads


class JsonlEventStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def read(self) -> list[Event]:
        if not self.path.exists():
            return []
        events = []
        for line_number, line in enumerate(
            self.path.read_text(encoding="utf-8").splitlines(),
            start=1,
        ):
            if not line.strip():
                continue
            try:
                events.append(Event.from_dict(loads(line)))
            except Exception as error:
                raise ValueError(
                    f"invalid event at line {line_number}: {error}"
                ) from error
        self._validate_sequences(events)
        return events

    def append(self, event: Event) -> None:
        events = self.read()
        expected = len(events) + 1
        if event.sequence != expected:
            raise ValueError(
                f"event sequence {event.sequence} does not match {expected}"
            )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(dumps(event.as_dict()))
            handle.write("\\n")

    def extend(self, events: Iterable[Event]) -> None:
        for event in events:
            self.append(event)

    @staticmethod
    def _validate_sequences(events: list[Event]) -> None:
        expected = list(range(1, len(events) + 1))
        actual = [event.sequence for event in events]
        if actual != expected:
            raise ValueError("event sequence is not contiguous")
`),
  'incident_board/state.py': text(`
"""Replay state and counters."""

from dataclasses import dataclass, field
from typing import Any

from .domain import Incident


@dataclass
class ReplayCounters:
    opened: int = 0
    leased: int = 0
    expired: int = 0
    completed: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "opened": self.opened,
            "leased": self.leased,
            "expired": self.expired,
            "completed": self.completed,
        }


@dataclass
class BoardState:
    incidents: dict[str, Incident] = field(default_factory=dict)
    counters: ReplayCounters = field(default_factory=ReplayCounters)
    seen_event_ids: set[str] = field(default_factory=set)
    last_sequence: int = 0

    def require_incident(self, incident_id: str) -> Incident:
        try:
            return self.incidents[incident_id]
        except KeyError as error:
            from .errors import IncidentNotFound

            raise IncidentNotFound(incident_id) from error

    def as_dict(self) -> dict[str, Any]:
        return {
            "incidents": {
                key: value.as_dict()
                for key, value in sorted(self.incidents.items())
            },
            "counters": self.counters.as_dict(),
            "last_sequence": self.last_sequence,
        }
`),
  'incident_board/lease.py': text(`
"""Lease policy.

The completion authorization below contains the seeded defect. It compares the
identifier but does not prove that the lease is still current and unexpired.
"""

from datetime import datetime

from .clock import parse_time
from .domain import Incident


def lease_is_expired(expires_at: str, at: str | datetime) -> bool:
    checked = parse_time(at) if isinstance(at, str) else at
    return checked >= parse_time(expires_at)


def completion_is_authorized(
    incident: Incident,
    supplied_lease_id: str,
    at: str,
) -> bool:
    """Return whether one lease authorizes completion."""
    if incident.lease is None:
        return False
    return incident.lease.lease_id == supplied_lease_id


def next_attempt(incident: Incident) -> int:
    if incident.lease is None:
        return 1
    return incident.lease.attempt + 1
`),
  'incident_board/replay.py': text(`
"""Event reducer and restart replay.

The completion reducer intentionally increments the replay counter for every
historical completion event. That makes a restarted summary diverge when an old
retry log contains duplicate completions.
"""

from collections.abc import Iterable

from .domain import Incident, Lease
from .errors import InvalidEvent
from .events import Event
from .state import BoardState


def apply_event(state: BoardState, event: Event) -> BoardState:
    if event.event_id in state.seen_event_ids:
        return state
    if event.sequence != state.last_sequence + 1:
        raise InvalidEvent("event sequence is not contiguous")

    if event.event_type == "incident.opened":
        if event.incident_id in state.incidents:
            raise InvalidEvent("incident was opened twice")
        state.incidents[event.incident_id] = Incident(
            incident_id=event.incident_id,
            title=event.data["title"],
            severity=event.data["severity"],
        )
        state.counters.opened += 1
    elif event.event_type == "lease.granted":
        incident = state.require_incident(event.incident_id)
        incident.status = "leased"
        incident.lease = Lease(
            lease_id=event.data["lease_id"],
            worker_id=event.data["worker_id"],
            granted_at=event.occurred_at,
            expires_at=event.data["expires_at"],
            attempt=event.data["attempt"],
        )
        state.counters.leased += 1
    elif event.event_type == "lease.expired":
        incident = state.require_incident(event.incident_id)
        if incident.lease and incident.lease.lease_id == event.data["lease_id"]:
            incident.status = "open"
        state.counters.expired += 1
    elif event.event_type == "incident.completed":
        incident = state.require_incident(event.incident_id)
        incident.status = "completed"
        incident.completion_ids.add(event.data["completion_id"])
        incident.completed_at = event.occurred_at
        incident.result = event.data["result"]
        state.counters.completed += 1
    else:
        raise InvalidEvent(f"unknown event type: {event.event_type}")

    state.seen_event_ids.add(event.event_id)
    state.last_sequence = event.sequence
    return state


def replay(events: Iterable[Event]) -> BoardState:
    state = BoardState()
    for event in events:
        apply_event(state, event)
    return state
`),
  'incident_board/commands.py': text(`
"""Command handlers append domain events."""

from datetime import timedelta

from .clock import format_time, parse_time
from .errors import CompletionRejected, LeaseConflict
from .events import Event
from .ids import event_id
from .lease import completion_is_authorized, lease_is_expired, next_attempt
from .state import BoardState


def open_incident(
    state: BoardState,
    *,
    incident_id: str,
    title: str,
    severity: str,
    at: str,
    command_id: str,
) -> Event:
    if incident_id in state.incidents:
        raise ValueError("incident already exists")
    return Event(
        event_id=event_id("incident.opened", command_id),
        sequence=state.last_sequence + 1,
        event_type="incident.opened",
        incident_id=incident_id,
        occurred_at=at,
        data={"title": title, "severity": severity},
    )


def grant_lease(
    state: BoardState,
    *,
    incident_id: str,
    lease_id: str,
    worker_id: str,
    ttl_seconds: int,
    at: str,
    command_id: str,
) -> list[Event]:
    incident = state.require_incident(incident_id)
    result = []
    sequence = state.last_sequence + 1
    if incident.status == "completed":
        raise LeaseConflict("completed incident cannot be leased")
    if incident.lease and not lease_is_expired(incident.lease.expires_at, at):
        raise LeaseConflict("incident already has an active lease")
    if incident.lease and incident.status == "leased":
        result.append(
            Event(
                event_id=event_id("lease.expired", command_id),
                sequence=sequence,
                event_type="lease.expired",
                incident_id=incident_id,
                occurred_at=at,
                data={"lease_id": incident.lease.lease_id},
            )
        )
        sequence += 1
    expires = format_time(parse_time(at) + timedelta(seconds=ttl_seconds))
    result.append(
        Event(
            event_id=event_id("lease.granted", command_id),
            sequence=sequence,
            event_type="lease.granted",
            incident_id=incident_id,
            occurred_at=at,
            data={
                "lease_id": lease_id,
                "worker_id": worker_id,
                "expires_at": expires,
                "attempt": next_attempt(incident),
            },
        )
    )
    return result


def complete_incident(
    state: BoardState,
    *,
    incident_id: str,
    lease_id: str,
    completion_id: str,
    result: str,
    at: str,
    command_id: str,
) -> Event | None:
    incident = state.require_incident(incident_id)
    if completion_id in incident.completion_ids:
        return None
    if not completion_is_authorized(incident, lease_id, at):
        raise CompletionRejected("lease does not authorize completion")
    return Event(
        event_id=event_id("incident.completed", command_id),
        sequence=state.last_sequence + 1,
        event_type="incident.completed",
        incident_id=incident_id,
        occurred_at=at,
        data={
            "lease_id": lease_id,
            "completion_id": completion_id,
            "result": result,
        },
    )
`),
  'incident_board/summary.py': text(`
"""Summary projections."""

from typing import Any

from .state import BoardState


def live_summary(state: BoardState) -> dict[str, Any]:
    """Compute current state without trusting replay counters."""
    incidents = list(state.incidents.values())
    return {
        "opened": len(incidents),
        "open": sum(item.status == "open" for item in incidents),
        "leased": sum(item.status == "leased" for item in incidents),
        "completed": sum(item.status == "completed" for item in incidents),
        "completion_records": sum(
            len(item.completion_ids) for item in incidents
        ),
    }


def replay_summary(state: BoardState) -> dict[str, Any]:
    """Project persisted replay counters after restart."""
    current = live_summary(state)
    return {
        **current,
        "completed": state.counters.completed,
        "completion_records": state.counters.completed,
    }
`),
  'incident_board/service.py': text(`
"""Application service joining commands, storage, and replay."""

from pathlib import Path
from typing import Any

from . import commands
from .event_store import JsonlEventStore
from .replay import apply_event, replay
from .summary import live_summary, replay_summary


class IncidentBoard:
    def __init__(self, store_path: str | Path):
        self.store = JsonlEventStore(store_path)
        self.state = replay(self.store.read())

    def _append(self, event):
        if event is None:
            return None
        self.store.append(event)
        apply_event(self.state, event)
        return event

    def open(self, **values):
        return self._append(commands.open_incident(self.state, **values))

    def lease(self, **values):
        events = commands.grant_lease(self.state, **values)
        for event in events:
            self._append(event)
        return events[-1]

    def complete(self, **values):
        return self._append(commands.complete_incident(self.state, **values))

    def summary(self, *, restarted: bool = False) -> dict[str, Any]:
        if restarted:
            restarted_state = replay(self.store.read())
            return replay_summary(restarted_state)
        return live_summary(self.state)
`),
  'incident_board/config.py': text(`
"""Configuration loader with strict supported fields."""

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    default_ttl_seconds: int = 30
    severity_levels: tuple[str, ...] = ("low", "medium", "high", "critical")


def load_config(path: str | Path | None = None) -> Config:
    if path is None:
        return Config()
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    allowed = {"default_ttl_seconds", "severity_levels"}
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"unknown configuration fields: {sorted(unknown)}")
    ttl = int(value.get("default_ttl_seconds", 30))
    if ttl < 1:
        raise ValueError("default_ttl_seconds must be positive")
    levels = tuple(value.get("severity_levels", Config.severity_levels))
    if not levels:
        raise ValueError("severity_levels cannot be empty")
    return Config(default_ttl_seconds=ttl, severity_levels=levels)
`),
  'incident_board/validation.py': text(`
"""Input validation kept separate from command policy."""

import re

IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]{2,63}$")


def require_identifier(value: str, label: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise ValueError(f"{label} is invalid")
    return value


def require_non_empty(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{label} cannot be empty")
    return normalized


def require_severity(value: str, allowed: tuple[str, ...]) -> str:
    if value not in allowed:
        raise ValueError(f"severity must be one of {allowed}")
    return value
`),
  'incident_board/cli.py': text(`
"""Command line interface."""

import argparse
import json
import sys

from .config import load_config
from .errors import IncidentBoardError
from .service import IncidentBoard
from .validation import require_identifier, require_non_empty, require_severity


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="incident-board")
    root.add_argument("--store", required=True)
    root.add_argument("--config")
    commands = root.add_subparsers(dest="command", required=True)

    opened = commands.add_parser("open")
    opened.add_argument("incident_id")
    opened.add_argument("--title", required=True)
    opened.add_argument("--severity", required=True)
    opened.add_argument("--at", required=True)
    opened.add_argument("--command-id", required=True)

    lease = commands.add_parser("lease")
    lease.add_argument("incident_id")
    lease.add_argument("--lease-id", required=True)
    lease.add_argument("--worker-id", required=True)
    lease.add_argument("--ttl", type=int)
    lease.add_argument("--at", required=True)
    lease.add_argument("--command-id", required=True)

    completed = commands.add_parser("complete")
    completed.add_argument("incident_id")
    completed.add_argument("--lease-id", required=True)
    completed.add_argument("--completion-id", required=True)
    completed.add_argument("--result", required=True)
    completed.add_argument("--at", required=True)
    completed.add_argument("--command-id", required=True)

    summary = commands.add_parser("summary")
    summary.add_argument("--restarted", action="store_true")
    return root


def execute(argv: list[str]) -> dict:
    args = parser().parse_args(argv)
    config = load_config(args.config)
    board = IncidentBoard(args.store)
    if args.command == "open":
        event = board.open(
            incident_id=require_identifier(args.incident_id, "incident_id"),
            title=require_non_empty(args.title, "title"),
            severity=require_severity(args.severity, config.severity_levels),
            at=args.at,
            command_id=require_identifier(args.command_id, "command_id"),
        )
        return event.as_dict()
    if args.command == "lease":
        event = board.lease(
            incident_id=require_identifier(args.incident_id, "incident_id"),
            lease_id=require_identifier(args.lease_id, "lease_id"),
            worker_id=require_identifier(args.worker_id, "worker_id"),
            ttl_seconds=args.ttl or config.default_ttl_seconds,
            at=args.at,
            command_id=require_identifier(args.command_id, "command_id"),
        )
        return event.as_dict()
    if args.command == "complete":
        event = board.complete(
            incident_id=require_identifier(args.incident_id, "incident_id"),
            lease_id=require_identifier(args.lease_id, "lease_id"),
            completion_id=require_identifier(
                args.completion_id, "completion_id"
            ),
            result=require_non_empty(args.result, "result"),
            at=args.at,
            command_id=require_identifier(args.command_id, "command_id"),
        )
        return {"idempotent": event is None, "event": event.as_dict() if event else None}
    return board.summary(restarted=args.restarted)


def main(argv: list[str] | None = None) -> int:
    try:
        output = execute(list(sys.argv[1:] if argv is None else argv))
    except (IncidentBoardError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
        return 2
    print(json.dumps({"ok": True, "result": output}, sort_keys=True))
    return 0
`),
  'incident_board/projections.py': text(`
"""Read-only projections used by operators."""

from collections import Counter
from typing import Any

from .state import BoardState


def by_severity(state: BoardState) -> dict[str, int]:
    return dict(
        sorted(Counter(item.severity for item in state.incidents.values()).items())
    )


def worker_load(state: BoardState) -> dict[str, int]:
    counter = Counter()
    for incident in state.incidents.values():
        if incident.status == "leased" and incident.lease:
            counter[incident.lease.worker_id] += 1
    return dict(sorted(counter.items()))


def incident_view(state: BoardState, incident_id: str) -> dict[str, Any]:
    return state.require_incident(incident_id).as_dict()
`),
};

const supportModules = {
  query: {
    title: 'Bounded incident query',
    functionName: 'select_status',
    body: 'return [item.as_dict() for item in state.incidents.values() if item.status == status]',
    args: 'state, status: str',
  },
  repository: {
    title: 'Repository coordinates',
    functionName: 'repository_identity',
    body: 'return {"kind": "jsonl", "path": str(path)}',
    args: 'path',
  },
  retry: {
    title: 'Retry classification',
    functionName: 'is_retryable',
    body: 'return code in {"lease-conflict", "timeout", "worker-lost"}',
    args: 'code: str',
  },
  snapshots: {
    title: 'Stable state snapshots',
    functionName: 'snapshot',
    body: 'return state.as_dict()',
  },
  telemetry: {
    title: 'Bounded telemetry dimensions',
    functionName: 'dimensions',
    body: 'return {"status": incident.status, "severity": incident.severity, "leased": incident.lease is not None}',
    args: 'incident',
  },
};

for (const [name, spec] of Object.entries(supportModules)) {
  const args = spec.args || 'state';
  files[`incident_board/${name}.py`] = text(`
"""${spec.title}.

This module is deliberately read-only. It keeps operational projections out of
the command and replay policy so recovery behavior remains testable.
"""

from __future__ import annotations

from typing import Any


def ${spec.functionName}(${args}) -> Any:
    """Return one deterministic projection."""
    ${spec.body}


def contract() -> dict[str, Any]:
    """Describe this small projection for diagnostics."""
    return {
        "schema": "incident-board.support-contract/v1",
        "module": "${name}",
        "mutation": False,
        "deterministic": True,
    }
`);
}

const architectureComponents = [
  [
    'Command boundary',
    'validated command dictionaries',
    'domain events',
    'reject malformed user input',
    'retry with corrected arguments',
  ],
  [
    'CLI adapter',
    'process arguments and JSON config',
    'JSON result envelopes',
    'return a stable nonzero status',
    'inspect the structured error',
  ],
  [
    'Service facade',
    'validated domain values',
    'events and projections',
    'preserve the domain exception',
    'retry only idempotent calls',
  ],
  [
    'Command handler',
    'current state and one command',
    'zero or one new event',
    'reject stale authority',
    'obtain a successor lease',
  ],
  [
    'Lease policy',
    'lease identity and clock time',
    'authorization decision',
    'deny expired or replaced leases',
    'request a fresh lease',
  ],
  [
    'Replay reducer',
    'ordered immutable events',
    'rebuilt board state',
    'reject invalid sequence order',
    'restore from a verified copy',
  ],
  [
    'Event store',
    'versioned event envelopes',
    'durable JSONL records',
    'stop on malformed JSON',
    'quarantine the damaged copy',
  ],
  [
    'Event envelope',
    'domain payload and sequence',
    'canonical event dictionary',
    'reject unsupported event types',
    'upgrade through an explicit migration',
  ],
  [
    'Board state',
    'accepted domain events',
    'incident and counter projections',
    'reject unknown incidents',
    'replay from the first event',
  ],
  [
    'Incident model',
    'title severity and lifecycle data',
    'stable incident dictionary',
    'retain completion identity',
    'compare with the event log',
  ],
  [
    'Lease model',
    'worker identity and expiry',
    'stable lease dictionary',
    'retain attempt ordering',
    'grant a successor explicitly',
  ],
  [
    'Summary projection',
    'board state or replay result',
    'bounded counters',
    'never inspect wall clock time',
    'recompute from stored events',
  ],
  [
    'Severity projection',
    'current incidents',
    'sorted severity counters',
    'avoid mutating the board',
    'discard and recompute',
  ],
  [
    'Worker projection',
    'active leased incidents',
    'sorted worker counters',
    'exclude completed incidents',
    'discard and recompute',
  ],
  [
    'Configuration loader',
    'optional JSON document',
    'validated immutable config',
    'reject unknown severity values',
    'fall back only when absent',
  ],
  [
    'Validation layer',
    'external identifiers and text',
    'normalized domain values',
    'reject empty or malformed values',
    'correct the caller input',
  ],
  [
    'Clock adapter',
    'timezone-aware ISO timestamps',
    'canonical UTC values',
    'reject naive timestamps',
    'provide an explicit timezone',
  ],
  [
    'Identifier helper',
    'canonical command content',
    'bounded content identifiers',
    'avoid random process state',
    'recompute from the same input',
  ],
  [
    'Repository facade',
    'event-store path',
    'repository coordinates',
    'make storage kind explicit',
    'open a new bounded repository',
  ],
  [
    'Query helper',
    'board state and status filter',
    'incident dictionaries',
    'remain read-only',
    'repeat against rebuilt state',
  ],
  [
    'Retry classifier',
    'stable error code',
    'retryability boolean',
    'default unknown codes to false',
    'escalate non-retryable failures',
  ],
  [
    'Snapshot helper',
    'current board state',
    'stable state dictionary',
    'do not write snapshots automatically',
    'regenerate from replay',
  ],
  [
    'Telemetry helper',
    'one incident projection',
    'bounded low-cardinality dimensions',
    'exclude titles and results',
    'drop unsafe dimensions',
  ],
  [
    'Recovery procedure',
    'copied immutable event log',
    'verified replay projection',
    'keep admission stopped on mismatch',
    'compare live and replay summaries',
  ],
];

files['docs/architecture.md'] = text(`
# Architecture and recovery contract

This document is intentionally detailed because the repository-load task asks
an agent to navigate a realistic service rather than a toy function. The event
log is authoritative. Every other view is disposable and reproducible.

${architectureComponents
  .map(
    ([title, input, output, failure, recovery], index) => `
## ${index + 1}. ${title}

- Responsibility: keep this boundary deterministic and independently testable.
- Input: ${input}.
- Output: ${output}.
- Failure rule: ${failure}.
- Recovery rule: ${recovery}.
- Mutation boundary: only command admission may append an event.
- Replay boundary: rebuilding state must not append or rewrite any event.
- Time boundary: timestamps enter as explicit command values.
- Identity boundary: content identifiers never depend on process randomness.
- Evidence boundary: errors remain structured and safe to retain.
- Compatibility boundary: historical bytes stay readable without silent edits.
- Review question: can this component alter completion cardinality?
- Review question: does restart reproduce the same observable summary?
- Review question: is a stale worker prevented from extending its authority?
`,
  )
  .join('\n')}

## End-to-end invariant

For one immutable event log, live state and restarted state must report the same
incident cardinality, completion cardinality, and completion identity set. A
successor lease may authorize new work, but it cannot make an expired lease
valid again. Repeated transport delivery may be idempotent; two distinct domain
completions for one incident are not.
`);

const operationalScenarios = Array.from({ length: 34 }, (_, index) => ({
  number: index + 1,
  severity: ['low', 'medium', 'high', 'critical'][index % 4],
  status: index % 2 === 0 ? 'open' : 'leased',
}));

files['tests/test_operational_matrix.py'] = text(`
import unittest

from incident_board.projections import by_severity, worker_load
from tests.helpers import board


class OperationalMatrixTests(unittest.TestCase):
${operationalScenarios
  .map(
    ({ number, severity, status }) => `
    def test_scenario_${String(number).padStart(2, '0')}_${status}_${severity}(self):
        temporary, value = board()
        self.addCleanup(temporary.cleanup)
        incident_id = "inc-scenario-${String(number).padStart(2, '0')}"
        value.open(
            incident_id=incident_id,
            title="Operational scenario ${number}",
            severity="${severity}",
            at="2026-01-01T00:00:00Z",
            command_id="cmd-open-${String(number).padStart(2, '0')}",
        )
${
  status === 'leased'
    ? `        value.lease(
            incident_id=incident_id,
            lease_id="lease-scenario-${String(number).padStart(2, '0')}",
            worker_id="worker-${(number % 3) + 1}",
            ttl_seconds=120,
            at="2026-01-01T00:00:01Z",
            command_id="cmd-lease-${String(number).padStart(2, '0')}",
        )
        self.assertEqual(sum(worker_load(value.state).values()), 1)`
    : '        self.assertEqual(worker_load(value.state), {})'
}
        self.assertEqual(by_severity(value.state), {"${severity}": 1})
        self.assertEqual(value.summary()["opened"], 1)
        self.assertEqual(value.summary(restarted=True)["opened"], 1)
`,
  )
  .join('\n')}
`);

Object.assign(files, {
  'tests/__init__.py': '',
  'tests/helpers.py': text(`
"""Shared visible test helpers."""

import tempfile
from pathlib import Path

from incident_board.service import IncidentBoard

T0 = "2026-01-01T00:00:00Z"


def board():
    temporary = tempfile.TemporaryDirectory()
    path = Path(temporary.name) / "events.jsonl"
    return temporary, IncidentBoard(path)


def opened_and_leased():
    temporary, value = board()
    value.open(
        incident_id="inc-one",
        title="Database unavailable",
        severity="critical",
        at=T0,
        command_id="cmd-open",
    )
    value.lease(
        incident_id="inc-one",
        lease_id="lease-one",
        worker_id="worker-one",
        ttl_seconds=30,
        at=T0,
        command_id="cmd-lease",
    )
    return temporary, value
`),
  'tests/test_commands.py': text(`
import unittest

from tests.helpers import opened_and_leased


class CommandTests(unittest.TestCase):
    def test_open_lease_and_complete(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        event = board.complete(
            incident_id="inc-one",
            lease_id="lease-one",
            completion_id="done-one",
            result="recovered",
            at="2026-01-01T00:00:10Z",
            command_id="cmd-complete",
        )
        self.assertEqual(event.event_type, "incident.completed")
        self.assertEqual(board.summary()["completed"], 1)

    def test_same_completion_is_idempotent(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        values = dict(
            incident_id="inc-one",
            lease_id="lease-one",
            completion_id="done-one",
            result="recovered",
            at="2026-01-01T00:00:10Z",
        )
        board.complete(command_id="cmd-complete", **values)
        self.assertIsNone(
            board.complete(command_id="cmd-complete-retry", **values)
        )
`),
  'tests/test_retry_regression.py': text(`
import unittest

from incident_board.errors import CompletionRejected
from tests.helpers import opened_and_leased


class RetryRegressionTests(unittest.TestCase):
    def test_expired_lease_cannot_complete(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        with self.assertRaises(CompletionRejected):
            board.complete(
                incident_id="inc-one",
                lease_id="lease-one",
                completion_id="done-stale",
                result="stale worker result",
                at="2026-01-01T00:00:31Z",
                command_id="cmd-stale",
            )

    def test_legacy_duplicate_log_has_stable_restart_summary(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        board.complete(
            incident_id="inc-one",
            lease_id="lease-one",
            completion_id="done-one",
            result="recovered",
            at="2026-01-01T00:00:10Z",
            command_id="cmd-complete",
        )
        duplicate = board.store.read()[-1]
        value = duplicate.as_dict()
        value["event_id"] = "evt-legacy-duplicate"
        value["sequence"] += 1
        value["data"] = {**value["data"], "completion_id": "done-retry"}
        from incident_board.events import Event

        board.store.append(Event.from_dict(value))
        self.assertEqual(board.summary()["completed"], 1)
        self.assertEqual(board.summary(restarted=True)["completed"], 1)
`),
  'tests/test_replay.py': text(`
import unittest

from incident_board.replay import replay
from tests.helpers import opened_and_leased


class ReplayTests(unittest.TestCase):
    def test_normal_replay_matches_live_state(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        restored = replay(board.store.read())
        self.assertEqual(restored.as_dict(), board.state.as_dict())

    def test_replay_is_deterministic(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        events = board.store.read()
        self.assertEqual(replay(events).as_dict(), replay(events).as_dict())
`),
  'tests/test_store.py': text(`
import unittest

from incident_board.event_store import JsonlEventStore
from tests.helpers import opened_and_leased


class StoreTests(unittest.TestCase):
    def test_round_trip(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        reopened = JsonlEventStore(board.store.path)
        self.assertEqual(
            [event.as_dict() for event in reopened.read()],
            [event.as_dict() for event in board.store.read()],
        )

    def test_missing_store_is_empty(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        missing = JsonlEventStore(board.store.path.parent / "missing.jsonl")
        self.assertEqual(missing.read(), [])
`),
  'tests/test_config.py': text(`
import json
import tempfile
import unittest
from pathlib import Path

from incident_board.config import Config, load_config


class ConfigTests(unittest.TestCase):
    def test_default(self):
        self.assertEqual(load_config(), Config())

    def test_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(
                json.dumps({"default_ttl_seconds": 45}),
                encoding="utf-8",
            )
            self.assertEqual(load_config(path).default_ttl_seconds, 45)
`),
  'tests/test_cli.py': text(`
import json
import tempfile
import unittest
from pathlib import Path

from incident_board.cli import execute


class CliTests(unittest.TestCase):
    def test_open_and_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            store = str(Path(directory) / "events.jsonl")
            execute(
                [
                    "--store", store, "open", "inc-one",
                    "--title", "API unavailable",
                    "--severity", "high",
                    "--at", "2026-01-01T00:00:00Z",
                    "--command-id", "cmd-open",
                ]
            )
            summary = execute(["--store", store, "summary"])
            self.assertEqual(summary["opened"], 1)
            self.assertEqual(summary["completed"], 0)
`),
  'tests/test_domain.py': text(`
import unittest

from incident_board.domain import Incident, Lease


class DomainTests(unittest.TestCase):
    def test_incident_projection_is_sorted(self):
        incident = Incident("inc-one", "Example", "low")
        incident.completion_ids.update({"done-two", "done-one"})
        self.assertEqual(
            incident.as_dict()["completion_ids"],
            ["done-one", "done-two"],
        )

    def test_lease_projection(self):
        lease = Lease(
            "lease-one", "worker-one",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:30Z",
            1,
        )
        self.assertEqual(lease.as_dict()["attempt"], 1)
`),
  'tests/test_validation.py': text(`
import unittest

from incident_board.validation import (
    require_identifier,
    require_non_empty,
    require_severity,
)


class ValidationTests(unittest.TestCase):
    def test_identifier(self):
        self.assertEqual(require_identifier("inc-one", "id"), "inc-one")
        with self.assertRaises(ValueError):
            require_identifier("../escape", "id")

    def test_text_and_severity(self):
        self.assertEqual(require_non_empty(" value ", "value"), "value")
        self.assertEqual(
            require_severity("high", ("low", "high")),
            "high",
        )
`),
  'tests/test_projections.py': text(`
import unittest

from incident_board.projections import by_severity, worker_load
from tests.helpers import opened_and_leased


class ProjectionTests(unittest.TestCase):
    def test_severity_and_worker_views(self):
        temporary, board = opened_and_leased()
        self.addCleanup(temporary.cleanup)
        self.assertEqual(by_severity(board.state), {"critical": 1})
        self.assertEqual(worker_load(board.state), {"worker-one": 1})
`),
  'config/default.json': text(`
{
  "default_ttl_seconds": 30,
  "severity_levels": ["low", "medium", "high", "critical"]
}
`),
  'config/retry-fast.json': text(`
{
  "default_ttl_seconds": 5,
  "severity_levels": ["low", "medium", "high", "critical"]
}
`),
  'config/retry-slow.json': text(`
{
  "default_ttl_seconds": 120,
  "severity_levels": ["low", "medium", "high", "critical"]
}
`),
  'docs/domain.md': text(`
# Domain model

An Incident begins open, may become leased, and ends completed. A Lease is a
bounded authority record, not merely a worker label. A retry grants a successor
lease only after the prior lease expires. The successor does not retroactively
authorize the prior worker.

Completion identity and event identity are different. Repeated delivery of one
completion is idempotent. Legacy logs may contain two completion events from a
past bug; replay must preserve the bytes while folding them into one incident
completion.
`),
  'docs/event-log.md': text(`
# Event log

The JSONL store is append-only and sequence ordered. Event ids make transport
retry idempotent, while domain identity prevents two distinct event ids from
representing two completions of the same incident.

Restart replay must be deterministic. It may diagnose historical anomalies but
cannot silently discard or rewrite stored lines. Summary counters are derived
state and must agree with the incident projection.
`),
  'docs/recovery.md': text(`
# Recovery procedure

1. Stop command admission.
2. Copy the JSONL file without editing it.
3. Replay into a fresh in-memory state.
4. Compare live incident counts with replay counters.
5. Resume admission only when the projections agree.

This fixture does not implement destructive repair. Historical duplicates are
handled by a backward-compatible reducer rule.
`),
  'examples/normal-events.jsonl': '',
  'examples/README.md': text(`
# Examples

The empty JSONL file is intentional. Visible tests create deterministic examples
with fixed timestamps so repository bytes remain stable.
`),
  LICENSE: text(`
Apache License 2.0

This qualification fixture is distributed under the repository license.
`),
});

export const INCIDENT_BOARD_FIXTURE = Object.freeze({
  schema: 'kungfu.agent-repository-work.fixture/v1',
  id: 'incident-board-replay-v1',
  language: 'python',
  runtime: 'python-standard-library-only',
  defect: {
    id: 'expired-lease-duplicate-completion-replay-divergence',
    seeded: true,
    requiredBoundaries: ['lease', 'command', 'replay', 'summary', 'cli'],
  },
  task: {
    title:
      'Repair completion idempotency across lease retry and restart replay',
    visibleTestCommand: 'python -m unittest discover -s tests -v',
    expectedBehavior: [
      'expired leases cannot authorize completion',
      'completion retry is idempotent',
      'legacy duplicate completion events replay as one completed incident',
      'live and restarted summaries agree',
    ],
  },
  warrants: {
    agentA: {
      mode: 'investigation-only',
      writablePaths: [],
    },
    agentB: {
      mode: 'bounded-repair',
      writablePaths: [
        'incident_board/commands.py',
        'incident_board/lease.py',
        'incident_board/replay.py',
      ],
    },
  },
  protectedPaths: [
    'README.md',
    'pyproject.toml',
    'tests',
    'config',
    'docs',
    'examples',
  ],
  files: Object.freeze(files),
});
