# SPDX-License-Identifier: Apache-2.0
#
# A real LangChain agent — not a stand-in toolkit. It builds a tool-calling
# agent with `langchain.agents.create_agent` (the langgraph runtime) and a
# `ChatOpenAI` model, then runs one turn that calls a tool and answers.
#
# The red line holds exactly as for the toy: this file must not import kungfu.
# Capture happens entirely through the environment the supervisor injects —
# the model-wire base url (ChatOpenAI honours OPENAI_BASE_URL) carries the
# model turns to the proxy, and the in-process adapter patches LangChain's
# `BaseTool.run` seam once `langchain_core.tools.base` imports. Proving the
# capture on a genuine third-party framework, run unmodified, is the whole
# point of this fixture.

import os
import sys

run_id = os.environ.get("KUNGFU_REWIND_RUN_ID")
if not run_id:
    print("KUNGFU_REWIND_RUN_ID missing from injected environment", file=sys.stderr)
    sys.exit(1)

if not os.environ.get("OPENAI_BASE_URL"):
    print("OPENAI_BASE_URL missing from injected environment", file=sys.stderr)
    sys.exit(1)

from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI


@tool
def lookup(query: str) -> str:
    """Look up a term and return its normalized (uppercase) form."""
    return query.upper()


# temperature omitted / model name is whatever the mock echoes; the mock is
# deterministic, so the run is reproducible without a real provider or key
model = ChatOpenAI(model="fixture-model", temperature=0)
agent = create_agent(model, [lookup])

result = agent.invoke(
    {"messages": [{"role": "user", "content": "normalize the term kungfu rewind"}]}
)

final = result["messages"][-1].content
if "done" not in final.lower():
    print(f"unexpected final answer from real langchain agent: {final!r}", file=sys.stderr)
    sys.exit(1)

print(f"real langchain agent ran a tool and answered under traced run {run_id}")
