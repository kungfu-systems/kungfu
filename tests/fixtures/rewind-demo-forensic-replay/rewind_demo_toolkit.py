# SPDX-License-Identifier: Apache-2.0
#
# A miniature tool framework standing in for the third-party ones agents use.
# It knows nothing about kungfu or tracing: the in-process adapter patches its
# natural seams (Tool.run = the user-facing call, Tool._invoke = one attempt
# inside the retry loop) from outside, exactly as adapters do for real
# frameworks. Keeping it a capability probe, not a product.


class Tool:
    def __init__(self, name, fn, retries=0):
        self.name = name
        self.fn = fn
        self.retries = retries

    def _invoke(self, tool_input):
        return self.fn(tool_input)

    def run(self, tool_input):
        attempts = self.retries + 1
        for attempt in range(attempts):
            try:
                return self._invoke(tool_input)
            except Exception:
                if attempt == attempts - 1:
                    raise
