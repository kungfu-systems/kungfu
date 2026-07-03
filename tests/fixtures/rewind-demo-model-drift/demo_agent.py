# SPDX-License-Identifier: Apache-2.0
#
# Model-drift demo (gate G6/D3): the model selects a tool the agent does not
# have. Nothing threw on the model side — the wrongness is semantic, inside
# the model's answer. The trace must show the drift point (the model node's
# response naming a nonexistent tool) and its consequence (the routing step
# failing on exactly that name).

import json
import os
import re
import sys
import urllib.request

import rewind_demo_toolkit

run_id = os.environ.get("KUNGFU_REWIND_RUN_ID")
base_url = os.environ.get("OPENAI_BASE_URL")
if not run_id or not base_url:
    print("injected capture environment missing", file=sys.stderr)
    sys.exit(2)

request = urllib.request.Request(
    base_url.rstrip("/") + "/chat/completions",
    data=json.dumps(
        {
            "model": "demo-model",
            "messages": [
                {
                    "role": "user",
                    "content": "find the demo answer (available tools: lookup)",
                }
            ],
        }
    ).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    answer = json.load(response)
content = answer["choices"][0]["message"]["content"]

TOOLS = {"lookup": lambda i: {"answer": str(i.get("query", "")).upper()}}


def route(tool_input):
    selected = tool_input["selected"]
    if selected not in TOOLS:
        raise KeyError(
            f"model selected unknown tool {selected!r}; available: {sorted(TOOLS)}"
        )
    return TOOLS[selected](tool_input)


match = re.search(r"use tool: ([\w-]+)", content)
selected = match.group(1) if match else "none"

router = rewind_demo_toolkit.Tool("tool-router", route)
try:
    router.run({"selected": selected, "query": "demo answer"})
except KeyError as e:
    print(f"agent failed on model drift: {e}", file=sys.stderr)
    sys.exit(1)

print("unexpected success", file=sys.stderr)
sys.exit(2)
