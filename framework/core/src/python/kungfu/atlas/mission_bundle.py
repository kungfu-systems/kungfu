# SPDX-License-Identifier: Apache-2.0

"""Deprecated compatibility alias for Mission Control portable bundles."""

from kungfu import profile_sdk


def _domain():
    source = profile_sdk.discover_source("kungfu.mission-control")["source"]
    package = profile_sdk.load_member_python_package(
        source, "mission-control-actions", "domain"
    )
    return package.mission_bundle


def __getattr__(name):
    return getattr(_domain(), name)


def __dir__():
    return sorted(set(globals()) | set(dir(_domain())))
