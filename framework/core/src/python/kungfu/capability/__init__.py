#  SPDX-License-Identifier: Apache-2.0
#
# The guest (sandboxed) side of the capability relay for a Python child process
# (KF-ADR-019f86da-4f90-79f1-8716-aca36b142847). A child reaches only its declared capabilities, forwarded to the
# trusted host over a newline-delimited JSON channel (its stdio by default). This
# is the Python port of framework/api/src/capability/sandbox.ts
# createCapabilityGuest: each method call and each callback argument is
# marshalled over the channel, and a capability that was not declared is absent —
# not merely un-injected, but never built.

from kungfu.capability.guest import connect

__all__ = ["connect"]
