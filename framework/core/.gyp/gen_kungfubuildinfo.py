#!/usr/bin/env python3
#  SPDX-License-Identifier: Apache-2.0
"""生成 kungfubuildinfo.json。

`kungfu/__init__` 从 pykungfu 同目录读取本文件取 version。conanfile.build() 的
`__gen_build_info` 会在 conan 全流程里生成它，但 cmake-js 直编 / Stage C freeze 路径
不经过 build()，故这里把同一份生成逻辑独立出来，供 freeze 入口（.gyp/freeze-kungfu.sh）
与任何 cmake-js 直编后置步骤复用，避免再手敲/手造 json（对应迁移文档 Stage C 收尾 ④）。

用法: gen_kungfubuildinfo.py [输出路径]   # 默认写到 ./kungfubuildinfo.json
"""

import datetime
import getpass
import json
import os
import platform
import subprocess
import sys

CORE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # framework/core


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "kungfubuildinfo.json"
    with open(os.path.join(CORE, "package.json")) as f:
        version = json.load(f)["version"]

    now = datetime.datetime.now()
    build_info = {
        "version": version,
        "pythonVersion": platform.python_version(),
        "build": {
            "user": getpass.getuser(),
            "osVersion": platform.platform(),
            "timestamp": now.strftime("%Y/%m/%d %H:%M:%S"),
        },
    }
    try:

        def _git(*args):
            return subprocess.check_output(["git", *args], text=True, cwd=CORE).strip()

        build_info["git"] = {
            "tag": _git("describe", "--tags", "--always"),
            "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
            "revision": _git("rev-parse", "HEAD"),
            "pristine": _git("status", "--porcelain") == "",
        }
    except Exception:
        pass

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w") as output:
        json.dump(build_info, output, indent=2)
    print(f"wrote {out} (version={version}, python={build_info['pythonVersion']})")


if __name__ == "__main__":
    main()
