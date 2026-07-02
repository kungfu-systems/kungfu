#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Drive the minimal fact-ledger slice end to end:
#   1. assert the tools carry no dynamic dependencies beyond the system runtime
#   2. run the host (write path); it exits
#   3. run the independent export tool (read path) on the same directory
#   4. verify the manifest's whole-segment checksum with the system shasum
#
# Usage: run.sh [build-dir] [event-count]
#   build-dir defaults to ../../build (relative to framework/core)
#   event-count defaults to 5

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_dir="$(cd "${here}/../.." && pwd)"
build_dir="${1:-${core_dir}/build}"
event_count="${2:-5}"

# Executables land in the project's global runtime output dir (build/Release);
# fall back to the per-subdir location for other generators.
find_bin() {
  local name="$1"
  for cand in "${build_dir}/Release/${name}" "${build_dir}/slices/fact-ledger/${name}" "${build_dir}/${name}"; do
    if [[ -x "${cand}" ]]; then
      echo "${cand}"
      return 0
    fi
  done
  return 1
}

host_bin="$(find_bin fact_ledger_host || true)"
export_bin="$(find_bin fact_ledger_export || true)"

if [[ -z "${host_bin}" || -z "${export_bin}" ]]; then
  echo "error: fact_ledger_host / fact_ledger_export not found under ${build_dir}" >&2
  echo "build first, e.g.:" >&2
  echo "  cmake --build ${build_dir} --target fact_ledger_host fact_ledger_export" >&2
  exit 1
fi

# The cut-proof itself: the slice tools must link only the yijinjing static
# core, so their dynamic dependencies are exactly the system C/C++ runtime.
# Any extra entry means runtime coupling crept back into the journal core.
assert_no_extra_dylibs() {
  local bin="$1" deps
  if command -v otool >/dev/null 2>&1; then
    deps="$(otool -L "${bin}" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/libc\+\+|/usr/lib/libSystem|/usr/lib/libobjc)' || true)"
  elif command -v ldd >/dev/null 2>&1; then
    deps="$(ldd "${bin}" | awk '{print $1}' | grep -vE '^(linux-vdso|libc\.|libm\.|libgcc_s|libstdc\+\+|libpthread|libdl\.|librt\.|/lib)' || true)"
  else
    echo "  (skip: no otool/ldd on this platform)"
    return 0
  fi
  if [[ -n "${deps}" ]]; then
    echo "FAIL: unexpected dynamic dependencies in ${bin}:" >&2
    echo "${deps}" >&2
    exit 1
  fi
  echo "  ${bin##*/}: system runtime only"
}

echo "== step 0: assert zero extra dynamic dependencies (cut-proof)"
assert_no_extra_dylibs "${host_bin}"
assert_no_extra_dylibs "${export_bin}"
echo

work="$(mktemp -d "${TMPDIR:-/tmp}/fact-ledger-slice.XXXXXX")"
echo "== journal root: ${work}"

echo "== step 1: host writes ${event_count} events, then exits"
"${host_bin}" "${work}" "${event_count}"

echo
echo "== step 2: independent export tool reopens the directory"
"${export_bin}" "${work}" fact_ledger_slice host "${work}/export"

echo
echo "== step 3: verify whole-segment checksum with system shasum"
declared="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["event_log"]["segment_sha256"])' "${work}/export.manifest.json")"
if command -v sha256sum >/dev/null 2>&1; then
  recomputed="$(sha256sum "${work}/export.jsonl" | awk '{print $1}')"
else
  recomputed="$(shasum -a 256 "${work}/export.jsonl" | awk '{print $1}')"
fi
echo "declared:   ${declared}"
echo "recomputed: ${recomputed}"
if [[ "${declared}" != "${recomputed}" ]]; then
  echo "FAIL: segment checksum mismatch" >&2
  exit 1
fi

echo
echo "== exported event log (${work}/export.jsonl):"
cat "${work}/export.jsonl"
echo
echo "== run manifest (${work}/export.manifest.json):"
cat "${work}/export.manifest.json"
echo
echo "OK: host wrote, independent tool reopened, checksum verified."
echo "artifacts in ${work}"
