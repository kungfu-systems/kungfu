# SPDX-License-Identifier: Apache-2.0
#
# LangChain adapter — a kfx runtime facet (config.adapter, python). The trace
# supervisor discovers this package and injects this file into the traced
# child, where it registers a patcher for LangChain's tool seam so an
# unmodified `create_agent` run is captured with no code change. It uses the
# capture primitives the hook exposes (rewind_client) — no kungfu import — so
# it runs in the user's own interpreter.
#
# The seam: every tool execution — an agent's tool node calling
# `tool.invoke(...)` / `tool.ainvoke(...)`, or user code calling `tool.run(...)`
# — funnels through `BaseTool.run` (the async path runs the sync `run` in an
# executor), so wrapping this one method captures the whole tool call as a
# single span across sync and async agents. Model turns are captured upstream
# at the wire proxy; this adapter owns tool semantics only.

import os

import rewind_client


def _patch_langchain(module):
    base_tool = getattr(module, "BaseTool", None)
    if base_tool is None or getattr(base_tool, "_kungfu_rewind_patched", False):
        return
    original_run = base_tool.run

    def traced_run(self, *args, **kwargs):
        tool_input = args[0] if args else kwargs.get("tool_input")
        name = getattr(self, "name", None) or type(self).__name__
        capture = rewind_client._CallCapture(
            name, parent_span_id=os.environ.get(rewind_client.ENV_PARENT_SPAN)
        )
        return capture.run(
            lambda: original_run(self, *args, **kwargs),
            rewind_client._render(tool_input),
        )

    base_tool.run = traced_run
    base_tool._kungfu_rewind_patched = True


# BaseTool lives in `langchain_core.tools.base`; older layouts exposed it from
# the `langchain_core.tools` package. Register both — the patcher no-ops when
# BaseTool is absent or already wrapped.
rewind_client.register_adapter("langchain_core.tools.base", _patch_langchain)
rewind_client.register_adapter("langchain_core.tools", _patch_langchain)
