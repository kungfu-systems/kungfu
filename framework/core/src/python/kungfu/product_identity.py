# SPDX-License-Identifier: Apache-2.0

SECONDARY_SOURCE_SIGNATURE = "Kungfu UNGFU™"
SOURCE_PRINCIPLE = "Never Guess. Facts Unfold."


def version_banner(version: str) -> str:
    """Keep the compatible version first line and append the source signature."""
    return f"{version}\n{SECONDARY_SOURCE_SIGNATURE} · {SOURCE_PRINCIPLE}"
