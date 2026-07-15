# SPDX-License-Identifier: Apache-2.0

"""Deprecated compatibility alias for the Mission Control Profile domain.

The active implementation is content-bound to the Mission Control Suite. New
callers must use the public Profile intent/read surfaces instead of this alias.
"""

from kungfu import profile_sdk


def _domain():
    source = profile_sdk.discover_source("kungfu.mission-control")["source"]
    package = profile_sdk.load_member_python_package(
        source, "mission-control-actions", "domain"
    )
    return package.mission_control


def __getattr__(name):
    return getattr(_domain(), name)


def __dir__():
    return sorted(set(globals()) | set(dir(_domain())))
