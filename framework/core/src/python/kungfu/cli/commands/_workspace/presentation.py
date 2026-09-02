# SPDX-License-Identifier: Apache-2.0


def human_work_line(row, width):
    display = row["display"]
    state = display.get("portfolio_state") or display.get("status") or "unknown"
    phase = display.get("orchestration_phase")
    source_status = display.get("source_status") or display.get("status")
    state_detail = str(state)
    if phase:
        state_detail += f" phase={phase}"
    if source_status:
        state_detail += f" src={source_status}"
    conflict = " !conflict" if row["conflict"] else ""
    replicas = f" x{row['replica_count'] + 1}" if row["replica_count"] else ""
    suffix = f" [{state_detail}]{conflict}{replicas} {row['canonical_root'][7:15]}"
    prefix = f"{row['object_kind']} "
    available = max(8, width - len(prefix) - len(suffix))
    title = str(display["title"])
    if len(title) > available:
        title = title[: max(1, available - 1)] + "…"
    return f"{prefix}{title}{suffix}"


def human_initiative_group_line(group, width):
    state = group["display"].get("portfolio_state") or "unknown"
    authority = group["authority_state"]
    suffix = (
        f" [{state} {authority} authorities={group['authority_count']}] "
        f"{group['group_root'][7:15]}"
    )
    prefix = "initiative "
    available = max(1, width - len(prefix) - len(suffix))
    title = str(group["display"]["title"])
    if len(title) > available:
        title = title[: max(1, available - 1)] + "…"
    return f"{prefix}{title}{suffix}"
