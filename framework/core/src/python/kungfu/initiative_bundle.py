# SPDX-License-Identifier: Apache-2.0

"""Public native Initiative bundle API."""

from kungfu import profile_sdk


def _domain():
    source = profile_sdk.discover_source("kungfu.work-control")["source"]
    package = profile_sdk.load_member_python_package(
        source, "work-control-actions", "domain"
    )
    return source, package


def __getattr__(name):
    source, package = _domain()
    value = getattr(package.initiative_bundle, name)
    if not callable(value):
        return value

    def bound(*args, **kwargs):
        return package.work_control._with_profile_source(
            source, lambda: value(*args, **kwargs)
        )

    bound.__name__ = getattr(value, "__name__", name)
    bound.__doc__ = getattr(value, "__doc__", None)
    return bound


def __dir__():
    _, package = _domain()
    return sorted(set(globals()) | set(dir(package.initiative_bundle)))
