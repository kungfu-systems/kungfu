# SPDX-License-Identifier: Apache-2.0

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc


def test_click_tree_exposes_one_work_family_and_no_assignment_alias():
    assert "work" in kfc.commands
    assert "assignment" not in kfc.commands
    assert kfc.commands["work"].name == "work"


def test_work_family_contains_only_profile_backed_orchestration_commands():
    commands = set(kfc.commands["work"].commands)
    assert commands == {
        "admit",
        "bind",
        "binding-create",
        "capture",
        "claim",
        "claim-completion",
        "decide",
        "family-contract",
        "family-create",
        "family-transition",
        "family-verify",
        "gate",
        "kickoff",
        "relation-event",
        "review",
        "seal",
        "stage",
        "status",
        "verify-binding",
        "verify-seal",
    }
    assert commands.isdisjoint(
        {
            "artifact",
            "block",
            "checkpoint",
            "complete",
            "create",
            "done",
            "export",
            "import",
            "link-run",
            "next",
            "pause",
            "ready",
            "recover",
            "resume",
            "settle",
            "start",
            "validate",
        }
    )


def test_atlas_bridge_has_no_work_mutation_aliases():
    atlas_commands = set(kfc.commands["atlas"].commands)
    assert atlas_commands.isdisjoint(
        {
            "claim-completion",
            "create-go",
            "create-mission",
            "decide-continuation",
            "review-completion",
        }
    )
