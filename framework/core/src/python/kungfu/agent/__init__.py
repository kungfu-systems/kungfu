# SPDX-License-Identifier: Apache-2.0

from .resources import (
    assess_work_advisory,
    bootstrap_contract,
    bootstrap_receipt_schema,
    bootstrap_status,
    choose_mode,
    cli_surface_catalog,
    commands,
    document_text,
    docs_context,
    index,
    intent_map,
    pack_root,
    profile_sdk_contract,
    registry,
    registry_schema,
    skill_state,
    skill_path,
    work_authority_capabilities,
)
from . import documentation


def skill_registry(home):
    from kungfu.skill import inspect_registry

    return inspect_registry(home)


__all__ = [
    "assess_work_advisory",
    "bootstrap_contract",
    "bootstrap_receipt_schema",
    "bootstrap_status",
    "choose_mode",
    "cli_surface_catalog",
    "commands",
    "document_text",
    "docs_context",
    "index",
    "intent_map",
    "pack_root",
    "profile_sdk_contract",
    "registry",
    "registry_schema",
    "skill_state",
    "skill_path",
    "skill_registry",
    "work_authority_capabilities",
    "documentation",
]
