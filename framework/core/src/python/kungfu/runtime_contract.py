# SPDX-License-Identifier: Apache-2.0

"""Runtime contract identifiers and schema validation shared by lifecycle owners."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from kungfu import contract as contract_runtime

PLAN_SCHEMA = "kungfu.runtime.invocation-plan/v1"
RECEIPT_SCHEMA = "kungfu.runtime.invocation-receipt/v1"
REQUIREMENT_SCHEMA = "kungfu.runtime.requirement/v1"
ACTIVATION_RECEIPT_SCHEMA = "kungfu.runtime.activation-receipt/v1"
PRODUCT_STATUS_SCHEMA = "kungfu.runtime.product-status/v1"
NATIVE_READINESS_EVIDENCE_SCHEMA = "kungfu.runtime.native-readiness-evidence/v1"
REQUEST_SOURCES = {"libkungfu", "cli", "python", "node", "gui", "kfx"}


def stable_id(prefix: str, value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()
    return f"{prefix}-{hashlib.sha256(encoded).hexdigest()[:24]}"


def validate_value(
    target: str,
    value: Mapping[str, Any],
    contract: Mapping[str, Any] | None = None,
) -> None:
    contract_value = (
        contract_runtime.load_contract("runtime") if contract is None else contract
    )
    bundle = contract_value["valueSchemaBundle"]
    schema = {
        "$schema": bundle["$schema"],
        "$defs": bundle["$defs"],
        "$ref": f"#/$defs/{target}",
    }
    contract_runtime.validate_json_schema(value, schema, f"runtime {target}")
