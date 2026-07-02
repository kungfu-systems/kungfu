# SPDX-License-Identifier: Apache-2.0
#
# Happy-path demo agent: a minimal "agent" making one model call the way an
# SDK would — POST to $OPENAI_BASE_URL/chat/completions. It must not import
# kungfu — the red line is that traced code needs no modification, so the
# only contact surface is the environment the supervisor injects (run id and
# the base url pointing at the model-wire proxy).

import json
import os
import sys
import urllib.request

run_id = os.environ.get("KUNGFU_REWIND_RUN_ID")
if not run_id:
    print("KUNGFU_REWIND_RUN_ID missing from injected environment", file=sys.stderr)
    sys.exit(1)

base_url = os.environ.get("OPENAI_BASE_URL")
if not base_url:
    print("OPENAI_BASE_URL missing from injected environment", file=sys.stderr)
    sys.exit(1)

request = urllib.request.Request(
    base_url.rstrip("/") + "/chat/completions",
    data=json.dumps(
        {
            "model": "demo-model",
            "messages": [{"role": "user", "content": "what is the demo answer?"}],
        }
    ).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    answer = json.load(response)

content = answer["choices"][0]["message"]["content"]
if content != "the demo answer":
    print(f"unexpected model answer: {content}", file=sys.stderr)
    sys.exit(1)

print(f"demo agent got model answer under traced run {run_id}")
