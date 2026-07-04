#  SPDX-License-Identifier: Apache-2.0
#
# The sandboxed Python child bootstrap: it runs INSIDE the OS sandbox, builds its
# declared capability object from the stdio relay (kungfu.capability.connect —
# the Python guest proxy), imports the facet, and runs it. Its only egress is the
# relay on stdout/stdin; diagnostics go to stderr. The host sets PYTHONPATH so
# kungfu.capability is importable.

import importlib.util
import json
import os
import sys

from kungfu.capability import connect


def main():
    declared = json.loads(os.environ.get("KFX_DECLARED", "[]"))
    facet_path = os.environ["KFX_FACET"]
    caps = connect(declared)

    spec = importlib.util.spec_from_file_location("kfx_facet", facet_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    module.run(caps)


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 — report and fail visibly
        sys.stderr.write(f"[py-child] {err}\n")
        sys.exit(1)
