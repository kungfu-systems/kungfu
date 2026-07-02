# SPDX-License-Identifier: Apache-2.0
#
# Happy-path demo agent, capture-layer L0 smoke: a trivial child process the
# supervisor wraps. It must not import kungfu — the red line is that traced
# code needs no modification, so the only contact surface is the environment
# the supervisor injects. Model/tool activity arrives with the L1 proxy.

import os
import sys

run_id = os.environ.get("KUNGFU_REWIND_RUN_ID")
if not run_id:
    print("KUNGFU_REWIND_RUN_ID missing from injected environment", file=sys.stderr)
    sys.exit(1)

print(f"demo agent alive under traced run {run_id}")
