# SPDX-License-Identifier: Apache-2.0

import sys

from kungfu.storage import service

runtime_dir = sys.argv[1]
opened = service.episode_begin(
    runtime_dir, title="vendor quickstart", actor="python-host"
)
print(
    service.episode_end(
        runtime_dir,
        episode_id=opened["episode_id"],
        reason="quickstart complete",
    )
)
