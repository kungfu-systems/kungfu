#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# Dependency-direction guard for the yijinjing static core.
#
# The core may see only: the C++ standard library, header-only formatting/json
# (fmt, spdlog, nlohmann, boost::hana via kungfu/common.h) and the longfist
# schema leaf (kungfu/longfist/core.h). It must never include runtime,
# transport or storage headers, the full type registry, or any trading type.
#
# Include lines are matched instead of bare words so that comments explaining
# a seam (e.g. "mirrors NNG_FLAG_NONBLOCK") do not trip the guard; trading
# types and the registry are matched as symbols since no comment should need
# them either.
#
# Usage: bash src/libyijinjing/check-deps.sh   (from framework/core, or anywhere)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0

forbidden_includes='^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"](nng/|rxcpp/|sqlite|rocksdb/|kungfu/longfist/longfist\.h|kungfu/longfist/types\.h|kungfu/longfist/enums\.h|kungfu/longfist/sqlite|kungfu/yijinjing/practice/|kungfu/yijinjing/cache/|kungfu/yijinjing/index/|kungfu/yijinjing/nanomsg/|kungfu/yijinjing/socket/|kungfu/yijinjing/io\.h|kungfu/yijinjing/rx\.h|kungfu/yijinjing/util/rocks\.h|kungfu/wingchun/)'

forbidden_symbols='longfist::types::(Order|Trade|Position)|types::(Order|Trade|Position)[A-Za-z]*\b|AllTypes\b|AllDataTypes\b|AllTypesTags\b|wingchun'

echo "yijinjing core dependency guard: ${here}"

if grep -rnE "${forbidden_includes}" "${here}/include" "${here}/src"; then
  echo "FAIL: forbidden include found (runtime/transport/storage/full registry)" >&2
  fail=1
fi

if grep -rnE "${forbidden_symbols}" "${here}/include" "${here}/src"; then
  echo "FAIL: forbidden symbol found (trading types / full type registry)" >&2
  fail=1
fi

if [[ ${fail} -ne 0 ]]; then
  exit 1
fi

echo "OK: core includes only the schema leaf and base utilities."
