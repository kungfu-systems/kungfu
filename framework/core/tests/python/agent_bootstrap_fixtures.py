# SPDX-License-Identifier: Apache-2.0

from kungfu.agent import resources as agent_resources
from kungfu.agent import run_agent


def verified_bootstrap_receipt(attempt_id="native:one"):
    body = {
        "schema": agent_resources.BOOTSTRAP_RECEIPT_SCHEMA,
        "attemptId": attempt_id,
        "state": "verified",
        "mutationsAllowed": True,
    }
    return {**body, "receiptRoot": run_agent.canonical_root(body)}
