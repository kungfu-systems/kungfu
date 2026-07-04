# SPDX-License-Identifier: Apache-2.0
#
# Python AOT dogfood coverage probe.
#
# It exercises the bundled Python toolchain end to end: `kungfu engage pdm`
# installs the declared dependency (pydantic), and `kungfu engage nuitka
# --module` ahead-of-time compiles this module into a native .so. Importing the
# compiled module and running probe() proves the python-AOT extension build
# path — the dependency is resolvable and the kungfu runtime binding loads.
import pydantic

import kungfu


class _Probe(pydantic.BaseModel):
    value: int


def probe(value: int) -> int:
    # pydantic was installed by `kungfu engage pdm`; validate through it.
    model = _Probe(value=value)
    # the compiled libkungfu binding must be importable from the runtime.
    binding = kungfu.__binding__
    return model.value if binding is not None else -1
