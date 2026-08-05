# SPDX-License-Identifier: Apache-2.0

"""Machine-global Runtime Profile persistence boundary."""

from __future__ import annotations

import copy
from typing import Any, Callable, Mapping


class RuntimeProfileStore:
    """Read and mutate only the Runtime Profile portion of Kungfu config."""

    def __init__(
        self,
        *,
        resolve_config: Callable[..., Mapping[str, Any]],
        set_config_value: Callable[..., Mapping[str, Any]],
        discover_catalog: Callable[..., Mapping[str, Any]],
    ) -> None:
        self.resolve_config = resolve_config
        self.set_config_value = set_config_value
        self.discover_catalog = discover_catalog

    def configured(
        self, *, config_home: str | None = None, runtime_home: str | None = None
    ) -> list[dict[str, Any]]:
        resolved = self.resolve_config(
            config_home=config_home, runtime_home=runtime_home
        )
        return copy.deepcopy(resolved["config"]["agent"]["runtimeProfiles"])

    def apply_upsert(
        self,
        plan: Mapping[str, Any],
        *,
        config_home: str | None = None,
        runtime_home: str | None = None,
    ) -> dict[str, Any]:
        if plan.get("schema") != "kungfu.agent-runtime-profile-plan/v1":
            raise ValueError("Agent Runtime Profile apply requires an exact plan")
        resolved = self.set_config_value(
            "agent.runtimeProfiles",
            copy.deepcopy(plan["runtimeProfiles"]),
            config_home=config_home,
            runtime_home=runtime_home,
        )
        return {
            "schema": "kungfu.agent-runtime-profile-receipt/v1",
            "action": plan["action"],
            "profileId": plan["profile"]["id"],
            "configPath": resolved["configPath"],
            "changed": True,
        }

    def apply_remove(
        self,
        plan: Mapping[str, Any],
        *,
        config_home: str | None = None,
        runtime_home: str | None = None,
    ) -> dict[str, Any]:
        if plan.get("schema") != "kungfu.agent-runtime-profile-remove-plan/v1":
            raise ValueError("Agent Runtime Profile removal requires an exact plan")
        resolved = self.set_config_value(
            "agent.runtimeProfiles",
            copy.deepcopy(plan["runtimeProfiles"]),
            config_home=config_home,
            runtime_home=runtime_home,
        )
        if (
            resolved["config"]["agent"].get("defaultRuntimeProfile")
            == plan["profileId"]
        ):
            resolved = self.set_config_value(
                "agent.defaultRuntimeProfile",
                None,
                config_home=config_home,
                runtime_home=runtime_home,
            )
        return {
            "schema": "kungfu.agent-runtime-profile-remove-receipt/v1",
            "profileId": plan["profileId"],
            "configPath": resolved["configPath"],
            "changed": True,
        }

    def set_default(
        self,
        profile_id: str,
        *,
        execute: bool,
        config_home: str | None = None,
        runtime_home: str | None = None,
    ) -> dict[str, Any]:
        resolved = self.resolve_config(
            config_home=config_home, runtime_home=runtime_home
        )
        configured = resolved["config"]["agent"]["runtimeProfiles"]
        known = {row.get("id") for row in configured}
        if profile_id not in known:
            catalog = self.discover_catalog(resolved_config=resolved)
            known.update(row["profile"]["id"] for row in catalog["discovered"])
        if profile_id not in known:
            raise ValueError(
                f"Agent Runtime Profile is not configured or discovered: {profile_id}"
            )
        receipt = {
            "schema": "kungfu.agent-runtime-default-plan/v1",
            "profileId": profile_id,
            "previous": resolved["config"]["agent"].get("defaultRuntimeProfile"),
            "execute": execute,
            "changed": False,
        }
        if execute:
            updated = self.set_config_value(
                "agent.defaultRuntimeProfile",
                profile_id,
                config_home=config_home,
                runtime_home=runtime_home,
            )
            receipt.update(
                {
                    "schema": "kungfu.agent-runtime-default-receipt/v1",
                    "configPath": updated["configPath"],
                    "changed": True,
                }
            )
        return receipt
