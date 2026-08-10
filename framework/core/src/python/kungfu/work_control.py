# SPDX-License-Identifier: Apache-2.0

"""Public Work Control domain facade."""

from kungfu import profile_sdk


def _domain():
    source = profile_sdk.discover_source("kungfu.work-control")["source"]
    package = profile_sdk.load_member_python_package(
        source, "work-control-actions", "domain"
    )
    return source, package.work_control


def __getattr__(name):
    source, domain = _domain()
    value = getattr(domain, name)
    if not callable(value):
        return value

    def bound(*args, **kwargs):
        return domain._with_profile_source(source, lambda: value(*args, **kwargs))

    bound.__name__ = getattr(value, "__name__", name)
    bound.__doc__ = getattr(value, "__doc__", None)
    return bound


def __dir__():
    _, domain = _domain()
    return sorted(set(globals()) | set(dir(domain)))
