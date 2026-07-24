#  SPDX-License-Identifier: Apache-2.0

# Environment Variables
###########################################################
# KF_HOME - base folder for kungfu files
# KF_LOG_LEVEL - logging level
# KF_NO_EXT - disable extensions if set
###########################################################

import json
import os
from pathlib import Path


def run_internal_agent_hub_kfd_step():
    raw = os.environ.pop("KUNGFU_INTERNAL_AGENT_HUB_KFD_STEP", "")
    if not raw:
        return False
    payload = json.loads(raw)
    entry = payload.get("entry")
    commands = payload.get("commands")
    if (
        not isinstance(entry, str)
        or not isinstance(commands, list)
        or not all(isinstance(command, str) for command in commands)
    ):
        raise ValueError("invalid internal Agent Hub KFD step")
    from kungfu.agent.agent_hub_qualification import run_kfd_step

    run_kfd_step(Path(entry), *commands)
    return True


if run_internal_agent_hub_kfd_step():
    raise SystemExit(0)


from kungfu.distribution_update import reexec_selected_cli  # noqa: E402

reexec_selected_cli()

from kungfu.cli import available, select  # noqa: E402


def main(**kwargs):
    select(available(), **kwargs)


if __name__ == "__main__":
    main()
