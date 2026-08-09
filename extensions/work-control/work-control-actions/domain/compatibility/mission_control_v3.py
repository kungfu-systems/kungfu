# SPDX-License-Identifier: Apache-2.0

"""Exact Mission Control v3 identities and native Work Control projection.

This module is the explicit compatibility boundary for retained v3 protocol
bytes. It does not own a writer; current writes use ``kungfu.work-control``.
"""

import re

CONTRACT_WORLD_ID = "kungfu.mission-control"
CONTRACT_VERSION = "3"
CONTRACT_VERSIONS = ("1", "2", "3")
MISSION_SURFACE_ID = "kungfu.mission-control.mission"
GO_SURFACE_ID = "kungfu.mission-control.go"
CLAIM_SURFACE_ID = "kungfu.mission-control.completion-claim"
BATCHED_STATE_QUERY_SCHEMA = "kungfu.mission-control.batched-state-query/v1"
STATE_SCHEMA = "kungfu.mission-control.state/v1"
MISSION_HOME_SCHEMA = "kungfu.mission-control.mission-home/v1"
DASHBOARD_SNAPSHOT_SCHEMA = "kungfu.mission-control.dashboard-snapshot/v1"
MISSING_CONTRACT_ERROR = (
    "legacy Mission Control v3 compatibility contract world is missing or ambiguous"
)
MISSING_SURFACE_ERROR = (
    "legacy Mission Control v3 compatibility fact surface is missing or ambiguous"
)


def project_native_string(value: str) -> str:
    """Project retained v3 vocabulary at the current adapter boundary."""

    if value.startswith("kungfu.mission-control"):
        return "kungfu.work-control" + value.removeprefix("kungfu.mission-control")
    exact = {
        "mission": "initiative",
        "goal": "assignment",
        "go": "assignment",
        "mission-go": "initiative-assignment",
        "mission-control-profile": "work-control-profile",
        "mission-intent": "initiative-intent",
        "mission_id": "initiative_id",
        "goal_id": "assignment_id",
        "go_set": "assignment_set",
    }
    if value in exact:
        return exact[value]
    projected = value.replace("Mission Control", "Work Control").replace(
        "Mission/Go", "Initiative/Assignment"
    )
    projected = re.sub(r"\bMission\b", "Initiative", projected)
    projected = re.sub(r"\bGo\(s\)", "Assignment(s)", projected)
    return re.sub(r"\bGo\b", "Assignment", projected)
