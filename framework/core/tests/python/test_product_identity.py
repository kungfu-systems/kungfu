# SPDX-License-Identifier: Apache-2.0

from kungfu.product_identity import (
    SECONDARY_SOURCE_SIGNATURE,
    SOURCE_PRINCIPLE,
    version_banner,
)


def test_version_banner_preserves_the_version_first_line():
    assert version_banner("4.0.0").splitlines() == [
        "4.0.0",
        f"{SECONDARY_SOURCE_SIGNATURE} · {SOURCE_PRINCIPLE}",
    ]
