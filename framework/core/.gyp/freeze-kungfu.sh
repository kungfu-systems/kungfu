#!/usr/bin/env bash
#  SPDX-License-Identifier: Apache-2.0
#
# Stage C kfc freeze 正式入口（替代手敲 nuitka 命令；对应迁移文档 Stage C 收尾 ⑥）。
# 两平台通用（Mac arm64 / Linux x64）。把 kungfu Python 包 + 数据栈冻成独立 kfc，
# 用户无需另装 Python。
#
# 用法:
#   .gyp/freeze-kungfu.sh <pykungfu-release-dir> [output-dir]
#     pykungfu-release-dir : cmake-js 产物目录，含 pykungfu / libkungfu / libnode 原生库
#     output-dir           : 默认 /tmp/kungfu-nuitka
#
# 前置:
#   - uv 项目 venv 已装 nuitka(4.x) + numpy/pandas/scipy/plotly 数据栈（见 pyproject/uv.lock）
#   - pykungfu 的构建 Python 与 freeze 的 venv Python 同 minor（统一 3.13）
#   - Linux 需 patchelf（apt install patchelf）；Nuitka standalone 依赖它
#
# 自动处理（消除此前手动步骤）:
#   1. 生成 kungfubuildinfo.json 到 pykungfu 同目录（kungfu/__init__ 在那里读它取 version）
#   2. 确保 libnode 与 pykungfu 同目录（py-libnode 链 libnode，rpath @loader_path/$ORIGIN）
#   3. nuitka freeze，并用 --include-data-files 把 buildinfo 放进 dist 根（免 freeze 后手动 cp）
set -euo pipefail

RELEASE="${1:?用法: freeze-kungfu.sh <pykungfu-release-dir> [output-dir]}"
OUTDIR="${2:-/tmp/kungfu-nuitka}"

GYP="$(cd "$(dirname "$0")" && pwd)"
CORE="$(cd "$GYP/.." && pwd)"
RELEASE="$(cd "$RELEASE" && pwd)"
BUILDINFO="$RELEASE/kungfubuildinfo.json"
cd "$CORE"

echo "[freeze] 1/3 生成 kungfubuildinfo.json -> $BUILDINFO"
# 用 uv 项目 venv 的 python（与 freeze/pykungfu 同一 3.13），保证 pythonVersion 字段正确
uv run --frozen python3 "$GYP/gen_kungfubuildinfo.py" "$BUILDINFO"

echo "[freeze] 2/3 确保 libnode 与 pykungfu 同目录"
shopt -s nullglob
existing=("$RELEASE"/libnode.*)
if [ ${#existing[@]} -eq 0 ]; then
  copied=0
  for cand in \
    "$HOME/Code/libnode/dist/node"/libnode.* \
    "$HOME/Code/kungfu-trader/libnode/dist/node"/libnode.*; do
    if [ -e "$cand" ]; then
      cp "$cand" "$RELEASE/" && echo "  copied $(basename "$cand")" && copied=1
    fi
  done
  [ "$copied" = 1 ] || echo "  warn: 未在常见路径找到 libnode.*，若 pykungfu 链 libnode 请手动放入 $RELEASE"
else
  echo "  ok: $(basename "${existing[0]}") 已在 release 目录"
fi

echo "[freeze] 3/3 Nuitka freeze -> $OUTDIR"
rm -rf "$OUTDIR"
PYTHONPATH="$RELEASE" uv run --frozen python -m nuitka \
  --output-dir="$OUTDIR" \
  --assume-yes-for-downloads \
  --include-package-data=certifi \
  --include-data-files="$BUILDINFO=kungfubuildinfo.json" \
  src/python/kungfu_cli.py

BIN="$OUTDIR/kungfu_cli.dist/kungfu.bin"
echo "[freeze] done: $BIN"
ls -la "$BIN"
