#  SPDX-License-Identifier: Apache-2.0
#
# Same-host agent coordination primitives (ADR-0077). The first slice is a
# file-backed named lock with crash-safe auto-release; it deliberately depends
# only on the Python standard library so it can run and be tested without the
# native runtime binding.

from kungfu.coordination.locks import acquire, held, release, status, with_lock

__all__ = ["acquire", "release", "held", "with_lock", "status"]
