#  SPDX-License-Identifier: Apache-2.0
"""Wrong-runtime guard: blessed passes, foreign fails with the named error.

The judgment is a pure function (kungfu._runtime_violation), so both verdicts
are tested without staging real interpreters; the integration test then proves
the live path — this test run itself executes on a uv-managed interpreter, so
loading the real binding must pass the guard.
"""

import sys

import pytest

import kungfu
from kungfu import WrongRuntimeError, _runtime_violation


BUILT_FOR = "3.13.14"
BLESSED_PREFIX = "/home/u/.cache/kungfu/python/cpython-3.13.14-linux-x86_64-none"


def test_frozen_host_is_blessed_unconditionally():
    assert (
        _runtime_violation(
            BUILT_FOR,
            frozen=True,
            base_prefix="/opt/anything",
            running_version="3.12.1",
        )
        is None
    )


def test_managed_matching_interpreter_is_blessed():
    assert (
        _runtime_violation(
            BUILT_FOR,
            frozen=False,
            base_prefix=BLESSED_PREFIX,
            running_version="3.13.2",
        )
        is None
    )


def test_foreign_prefix_is_named():
    violation = _runtime_violation(
        BUILT_FOR,
        frozen=False,
        base_prefix="/opt/homebrew/Frameworks/Python.framework/Versions/3.13",
        running_version="3.13.14",
    )
    assert violation is not None
    assert "not the kungfu-managed runtime" in violation


def test_feature_version_mismatch_is_named():
    violation = _runtime_violation(
        BUILT_FOR,
        frozen=False,
        base_prefix=BLESSED_PREFIX,
        running_version="3.12.8",
    )
    assert violation is not None
    assert "3.13" in violation and "3.12.8" in violation


def test_missing_buildinfo_version_judges_prefix_only():
    assert (
        _runtime_violation(
            "",
            frozen=False,
            base_prefix=BLESSED_PREFIX,
            running_version="3.99.0",
        )
        is None
    )


def test_live_binding_load_passes_on_the_dev_interpreter():
    # The test env is a uv-managed interpreter matching the build, so the
    # real lazy-load path must come up blessed end to end.
    assert kungfu.__binding__ is not None
    assert kungfu.__version__


def test_wrong_runtime_error_is_a_runtime_error():
    assert issubclass(WrongRuntimeError, RuntimeError)
    assert sys.version_info.major == 3


def test_guard_error_message_names_the_fix():
    with pytest.raises(WrongRuntimeError) as excinfo:
        raise WrongRuntimeError(
            "x\n  found:    /usr/bin/python3\n  expected: the kungfu runtime"
            "\n  fix:      run inside an env derived from it"
        )
    assert "fix:" in str(excinfo.value)
