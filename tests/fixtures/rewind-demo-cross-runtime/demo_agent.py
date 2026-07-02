# SPDX-License-Identifier: Apache-2.0
#
# Cross-runtime demo agent (gate G7): a python agent makes one model call,
# then acts on it with a tool that delegates to a *Node* process. Everything
# stays unmodified user code: the python framework seam is patched by the
# python hook, the node process is patched by the node hook via NODE_OPTIONS,
# and the causal parent crosses the process boundary in the environment the
# python hook maintains — so one causal chain lands in one journal.

import json
import os
import subprocess
import sys
import urllib.request

import rewind_demo_toolkit

run_id = os.environ.get("KUNGFU_REWIND_RUN_ID")
base_url = os.environ.get("OPENAI_BASE_URL")
if not run_id or not base_url:
    print("injected capture environment missing", file=sys.stderr)
    sys.exit(1)

request = urllib.request.Request(
    base_url.rstrip("/") + "/chat/completions",
    data=json.dumps(
        {
            "model": "demo-model",
            "messages": [
                {"role": "user", "content": "what should the node tool reverse?"}
            ],
        }
    ).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    answer = json.load(response)
content = answer["choices"][0]["message"]["content"]


def delegate_to_node(tool_input):
    completed = subprocess.run(
        [
            "node",
            os.path.join(os.path.dirname(__file__), "node_tool.js"),
            json.dumps(tool_input),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


tool = rewind_demo_toolkit.Tool("delegate", delegate_to_node)
result = tool.run({"query": content})

expected = content[::-1]
if result != {"answer": expected}:
    print(f"unexpected cross-runtime result: {result}", file=sys.stderr)
    sys.exit(1)

print(f"cross-runtime demo done under traced run {run_id}")
