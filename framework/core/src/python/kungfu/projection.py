# SPDX-License-Identifier: Apache-2.0

"""Thin Python projection of the libkungfu peer-bootstrap authority."""

from __future__ import annotations

from typing import Any

import kungfu


def candidate_status(
    *,
    data_root: str,
    stream_id: int,
    container_epoch: int,
    writer_resource_id: str,
    qualification_profile: str,
    projection_name: str = "typed-peer-state",
    requirement: str = "required",
) -> dict[str, Any]:
    """Inspect a candidate cut without rebuilding or widening eligibility."""

    return dict(
        kungfu.__binding__.runtime.projection_candidate_status_typed(
            data_root,
            stream_id,
            container_epoch,
            writer_resource_id,
            qualification_profile,
            projection_name,
            requirement,
        )
    )
