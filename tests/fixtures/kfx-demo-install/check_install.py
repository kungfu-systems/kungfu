# SPDX-License-Identifier: Apache-2.0
#
# Install assertions for the kfx distribution fixture: the tgz install left a
# complete, loadable package under the home's managed install root.
#
# Usage: check_install.py <home>

import json
import os
import sys

home = sys.argv[1]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


install_dir = os.path.join(home, "extensions", "work-dashboard")
manifest_path = os.path.join(install_dir, "package.json")
bundle_path = os.path.join(install_dir, "dist", "view", "index.js")

check("installed under <home>/extensions/<key>", os.path.isdir(install_dir))
check("package.json present", os.path.isfile(manifest_path))
check("view bundle present", os.path.isfile(bundle_path))

if os.path.isfile(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)
    config = manifest.get("kungfuConfig", {})
    view = (config.get("config") or {}).get("view", {})
    check("key is work-dashboard", config.get("key") == "work-dashboard")
    check(
        "view declares capabilities",
        view.get("capabilities") == ["ledger", "work"],
    )
    check(
        "package name is the published one",
        manifest.get("name") == "@kungfu-tech/kfx-view-work-dashboard",
    )

if os.path.isfile(bundle_path):
    with open(bundle_path) as f:
        code = f.read()
    check("bundle exports View", "View" in code and "exports" in code)
    check(
        "react stays external (shell-injected)",
        'require("react' in code,
    )
    check(
        "no bundled react copy",
        "react.production" not in code and "react.development" not in code,
    )

print(f"[kfx-demo-install] {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
