# SPDX-License-Identifier: Apache-2.0

"""Stable pytest collection facade for distribution-update contracts."""

# ruff: noqa: F401,F403

from _distribution_update_release_cases import *
from _distribution_update_download_cases import *
from _distribution_update_activation_cases import *
from _distribution_update_package_manager_cases import *
from _distribution_update_cli_cases import *
from _distribution_update_support import (
    _archive,
    _installed_product_version,
    distribution_update,
    update_command,
    update_test_cli,
)
