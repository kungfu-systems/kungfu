# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta, timezone
from typing import Any


def _iso(stamp: datetime) -> str:
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_relative(value: str, *, now: datetime) -> datetime | None:
    text = value.strip().lower()
    if len(text) < 2 or not text[:-1].isdigit():
        return None
    amount = int(text[:-1])
    unit = text[-1]
    if unit == "d":
        delta = timedelta(days=amount)
    elif unit == "h":
        delta = timedelta(hours=amount)
    elif unit == "m":
        delta = timedelta(minutes=amount)
    elif unit == "s":
        delta = timedelta(seconds=amount)
    else:
        return None
    return now - delta


def build_range_filter(
    *,
    since: str | None = None,
    from_time: str | None = None,
    until: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    if since and from_time:
        raise ValueError("use either --since or --from, not both")
    result: dict[str, Any] = {}
    if since:
        relative = _parse_relative(since, now=now or datetime.now(timezone.utc))
        result["since"] = _iso(relative) if relative is not None else since
    if from_time:
        result["since"] = from_time
    if until:
        result["until"] = until
    return result or None
