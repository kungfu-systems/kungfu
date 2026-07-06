#  SPDX-License-Identifier: Apache-2.0

import glob
import os
import platform


def prune_layout_files(base_dir, layout, mode):
    search_path = os.path.join(base_dir, layout, "*", "*", "*", mode, "*")
    for file in filter(os.path.isfile, glob.glob(search_path)):
        if "renderer-app" in file and layout == "log":
            continue
        if "cli-" in file and layout == "log":
            continue
        try:
            os.remove(file)
        except Exception:
            continue


def prue_layout_dirs_before_timestamp(base_dir, layout, mode, timestamp):
    search_path = os.path.join(base_dir, layout, "*", "*", "*", mode, "*")
    for file in filter(os.path.isfile, glob.glob(search_path)):
        created_at = os.path.getctime(file)
        modify_at = os.path.getmtime(file)
        if created_at < timestamp or modify_at < timestamp:
            try:
                os.remove(file)
            except Exception:
                continue


def get_default_home_dir():
    osname = platform.system()
    user_home = os.path.expanduser("~")
    home = ""
    if osname == "Linux":
        xdg_config_home = os.getenv("XDG_CONFIG_HOME")
        home = (
            xdg_config_home if xdg_config_home else os.path.join(user_home, ".config")
        )
    if osname == "Darwin":
        home = os.path.join(user_home, "Library", "Application Support")
    if osname == "Windows":
        app_data = os.path.join(os.getenv("USERPROFILE", ""), "AppData", "Roaming")
        home = os.getenv("APPDATA", app_data)
    return os.path.join(home, "kungfu", "home")
