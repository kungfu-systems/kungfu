#  SPDX-License-Identifier: Apache-2.0
#
# The Python trusted (co-resident) tier runner: build the in-process capability
# surface, run the SAME facet source the sandboxed child runs, and print the
# result the facet delivered through the report sink. Here stdout is free (no
# relay), so the harness reads the JSON result from it.

import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from py_fixture import build_caps  # noqa: E402 — after sys.path setup


def main():
    facet_path = os.environ["KFX_FACET"]
    caps, report = build_caps()

    spec = importlib.util.spec_from_file_location("kfx_facet", facet_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    module.run(caps)
    sys.stdout.write(json.dumps(report.value))


if __name__ == "__main__":
    main()
