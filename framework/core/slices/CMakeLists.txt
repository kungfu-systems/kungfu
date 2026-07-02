# SPDX-License-Identifier: Apache-2.0
#
# Capability slices: minimal, independently runnable proofs of core
# capabilities (see README.md in this directory). One switch builds them
# all; each slice is a self-contained subdirectory with its own probe
# statement, sources and one-command run script.

add_subdirectory(fact-ledger)
add_subdirectory(schema-registry)
