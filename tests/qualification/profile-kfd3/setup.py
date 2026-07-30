# SPDX-License-Identifier: Apache-2.0

"""Prepare an independent Week/Day Profile for the dual-client live probe."""

import json
import sys
import tempfile
from pathlib import Path


repo = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repo / "framework" / "core" / "tests" / "python"))

from kungfu import profile_sdk  # noqa: E402
from test_agent_profile_sdk import (  # noqa: E402
    create_source,
    make_collaboration_action_lifecycle,
)


root = Path(tempfile.mkdtemp(prefix="kungfu-profile-kfd3-"))
source, _ = create_source(root)
make_collaboration_action_lifecycle(source)
home = root / "home"
runtime = home / "runtime"
for action in ["install", "qualify", "activate"]:
    plan = profile_sdk.lifecycle_plan(runtime, action, source)["corePlan"]
    profile_sdk.lifecycle_apply(runtime, plan, f"qualification-setup:{action}")

projection = profile_sdk.application(source, runtime, include_qualification=False)
print(
    json.dumps(
        {
            "schema": "kungfu.profile-kfd3-live-context/v1",
            "domain": "week-day",
            "source": str(source),
            "home": str(home),
            "runtime": str(runtime),
            "profileId": projection["profileId"],
            "profileSuiteRoot": projection["profileSuiteRoot"],
            "intentId": projection["intents"][0]["id"],
        },
        sort_keys=True,
    )
)
