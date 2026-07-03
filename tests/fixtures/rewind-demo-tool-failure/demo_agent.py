# SPDX-License-Identifier: Apache-2.0
#
# Tool-failure demo (gate G6/D2): the model answers fine, then the tool the
# agent acts with fails for real — bad schema from a downstream service, no
# retry can save it. The recorded run must make the failure diagnosable in one
# look: which step (✗), what went in, what came back. Unmodified user code, as
# always: only the injected environment connects it to the recorder.

import json
import os
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
            "messages": [{"role": "user", "content": "look up the demo answer"}],
        }
    ).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    answer = json.load(response)
content = answer["choices"][0]["message"]["content"]


def broken_lookup(tool_input):
    # downstream returns a malformed record; the tool surfaces it as a hard error
    record = {"status": "ok"}  # missing the 'answer' field the contract requires
    if "answer" not in record:
        raise ValueError(
            f"lookup returned invalid schema: missing field 'answer' "
            f"(got keys {sorted(record)}) for query {tool_input['query']!r}"
        )
    return record


tool = rewind_demo_toolkit.Tool("lookup", broken_lookup)
try:
    tool.run({"query": content})
except ValueError as e:
    print(f"agent failed: {e}", file=sys.stderr)
    sys.exit(1)

print("unexpected success", file=sys.stderr)
sys.exit(2)
