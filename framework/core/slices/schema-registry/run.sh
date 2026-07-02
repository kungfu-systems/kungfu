#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Drive the schema-registry slice end to end:
#   1. producer writes a run bound to schema v1; decoder decodes it from the
#      bundle alone (runtime reflection, no generated code)
#   2. producer writes a second run bound to schema v2 (adds a field);
#      decoder decodes it the same way
#   3. assert the two runs bound different schema hashes (version coexistence)
#      and that only the v2 output carries the added field
#
# Usage: run.sh [build-dir]

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_dir="$(cd "${here}/../.." && pwd)"
build_dir="${1:-${core_dir}/build}"

find_bin() {
  local name="$1"
  for cand in "${build_dir}/Release/${name}" "${build_dir}/slices/schema-registry/${name}" "${build_dir}/${name}"; do
    if [[ -x "${cand}" ]]; then
      echo "${cand}"
      return 0
    fi
  done
  return 1
}

producer="$(find_bin schema_registry_producer || true)"
decoder="$(find_bin schema_registry_decoder || true)"
gen_dir="${build_dir}/slices/schema-registry/generated"

if [[ -z "${producer}" || -z "${decoder}" || ! -f "${gen_dir}/demo_v1.bfbs" ]]; then
  echo "error: slice binaries or generated .bfbs not found under ${build_dir}" >&2
  echo "build first: cmake --build ${build_dir} --target schema_registry_producer schema_registry_decoder" >&2
  exit 1
fi

run_one() {
  local version="$1"
  local work bundle out
  work="$(mktemp -d "${TMPDIR:-/tmp}/schema-registry-journal.XXXXXX")"
  bundle="$(mktemp -d "${TMPDIR:-/tmp}/schema-registry-bundle.XXXXXX")"
  echo "== run v${version}: produce" >&2
  "${producer}" "${work}" "${bundle}" "${version}" "${gen_dir}/demo_v${version}.bfbs" >&2
  echo "== run v${version}: decode from bundle alone" >&2
  "${decoder}" "${work}" "${bundle}"
  echo "${bundle}" >&3
}

# stdout of run_one = decoded JSONL; fd 3 captures the bundle path
out_v1="$(mktemp)" out_v2="$(mktemp)" bundles="$(mktemp)"
run_one 1 3>>"${bundles}" >"${out_v1}"
run_one 2 3>>"${bundles}" >"${out_v2}"

echo
echo "== assertions"
grep -q '"kind":"observe"' "${out_v1}" || { echo "FAIL: v1 decode missing named field" >&2; exit 1; }
if grep -q '"note"' "${out_v1}"; then
  echo "FAIL: v1 output should not carry the v2-added field" >&2
  exit 1
fi
grep -q '"note":"added in v2"' "${out_v2}" || { echo "FAIL: v2 decode missing the added field" >&2; exit 1; }
grep -q '"schema_kind":"json"' "${out_v1}" || { echo "FAIL: json event missing from decode" >&2; exit 1; }

hash_v1="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["schema_bindings"]["20021"]["schema_hash"])' "$(sed -n 1p "${bundles}")/manifest.json")"
hash_v2="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["schema_bindings"]["20021"]["schema_hash"])' "$(sed -n 2p "${bundles}")/manifest.json")"
if [[ "${hash_v1}" == "${hash_v2}" ]]; then
  echo "FAIL: v1 and v2 runs bound the same schema hash" >&2
  exit 1
fi
echo "  v1 schema ${hash_v1:0:12}... != v2 schema ${hash_v2:0:12}... (coexisting, both decoded)"

echo
echo "OK: independent decoder produced named fields from the bundle alone, across two schema versions."
