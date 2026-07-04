#  SPDX-License-Identifier: Apache-2.0

import json
import os

import pykungfu as __binding__

with open(
    os.path.join(os.path.dirname(__binding__.__file__), "kungfubuildinfo.json"),
    "r",
) as build_info_file:
    __build_info__ = json.load(build_info_file)

__version__ = __build_info__["version"]


def schema_data_path(module_file, name):
    """Resolve a package data file (e.g. a *.bfbs schema blob) in both layouts.

    In a source checkout the file sits next to its module; in the frozen
    standalone runtime the module is compiled into the executable (so
    ``dirname(__file__)`` is not a real directory) and data files are shipped
    flat next to the binding — the same place ``kungfubuildinfo.json`` lands.
    Try the source layout first, then fall back to the binding directory.
    """
    beside_module = os.path.join(os.path.dirname(module_file), name)
    if os.path.exists(beside_module):
        return beside_module
    return os.path.join(os.path.dirname(__binding__.__file__), name)
