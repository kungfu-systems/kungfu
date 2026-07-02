#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Drive the embedding slice end to end:
#   1. configure the standalone embedder project from scratch in a throwaway
#      build directory (add_subdirectory of src/libyijinjing; no kungfu parent)
#   2. build it
#   3. run embed_smoke: write a causal chain, reopen with assemble, assert
#
# Usage: run.sh [core-build-dir]
#   core-build-dir defaults to ../../build (relative to framework/core); it is
#   only used to locate the conan toolchain that stands in for the embedder's
#   own dependency provisioning.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_dir="$(cd "${here}/../.." && pwd)"
core_build="${1:-${core_dir}/build}"

toolchain="${core_build}/conan_toolchain.cmake"
if [[ ! -f "${toolchain}" ]]; then
  echo "error: ${toolchain} not found" >&2
  echo "seed the core build first (conan install / rebuild:core); the embedder" >&2
  echo "borrows its dependency provisioning from that toolchain." >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/embedding-slice-build.XXXXXX")"
work="$(mktemp -d "${TMPDIR:-/tmp}/embedding-slice-journal.XXXXXX")"

echo "== step 1: configure the standalone embedder (scratch: ${scratch})"
cmake -S "${here}" -B "${scratch}" \
  -DCMAKE_TOOLCHAIN_FILE="${toolchain}" \
  -DCMAKE_POLICY_DEFAULT_CMP0091=NEW \
  -DCMAKE_BUILD_TYPE=Release >/dev/null

echo "== step 2: build"
cmake --build "${scratch}" --target embed_smoke >/dev/null

echo "== step 3: write + reopen + assert the causal chain"
"${scratch}/embed_smoke" "${work}"

echo "artifacts in ${work} (embedder build: ${scratch})"
