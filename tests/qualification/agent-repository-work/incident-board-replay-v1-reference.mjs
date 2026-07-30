// SPDX-License-Identifier: Apache-2.0

function text(value) {
  return `${value.replace(/^\n/u, '').trimEnd()}\n`;
}

export const INCIDENT_BOARD_REFERENCE_REPAIR = Object.freeze({
  'incident_board/lease.py': text(`
"""Lease authorization policy."""

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
    """Require the current active and unexpired lease."""
    if incident.status != "leased" or incident.lease is None:
        return False
    if incident.lease.lease_id != supplied_lease_id:
        return False
    return not lease_is_expired(incident.lease.expires_at, at)


def next_attempt(incident: Incident) -> int:
    if incident.lease is None:
        return 1
    return incident.lease.attempt + 1
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
    if incident.status == "completed":
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
  'incident_board/replay.py': text(`
"""Event reducer and restart replay."""

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
        first_completion = not incident.completion_ids
        incident.status = "completed"
        incident.completion_ids.add(event.data["completion_id"])
        if first_completion:
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
});
