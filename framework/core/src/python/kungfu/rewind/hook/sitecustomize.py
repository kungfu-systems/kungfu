# SPDX-License-Identifier: Apache-2.0
#
# Injected into the child interpreter by the supervisor (this directory is
# prepended to PYTHONPATH, python's site machinery imports the first
# sitecustomize it finds). Everything here is best-effort: a traced program
# must behave exactly like an untraced one, minus nothing.

try:
    import rewind_client

    rewind_client.install_adapters()
except Exception:  # noqa: BLE001 — never break the user's interpreter
    pass

# python imports only the first sitecustomize on the path; if the user's
# environment had its own, run it too so tracing does not eat their setup
try:
    import importlib.util
    import os
    import sys

    _here = os.path.dirname(os.path.abspath(__file__))
    _rest = [p for p in sys.path if os.path.abspath(p or os.getcwd()) != _here]
    _spec = None
    for _p in _rest:
        _candidate = os.path.join(_p or os.getcwd(), "sitecustomize.py")
        if os.path.exists(_candidate):
            _spec = importlib.util.spec_from_file_location(
                "sitecustomize_user", _candidate
            )
            break
    if _spec and _spec.loader:
        _module = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_module)
except Exception:  # noqa: BLE001
    pass
