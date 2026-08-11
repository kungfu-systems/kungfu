# SPDX-License-Identifier: Apache-2.0

import hashlib

import pytest

from kungfu.agent import assess_skill_decision
from kungfu.agent import resources as agent_resources


def _root(character):
    return "sha256:" + character * 64


def _candidate(**overrides):
    value = {
        "key": "verify-release",
        "contentRoot": _root("4"),
        "evidenceRoot": _root("5"),
        "match": "exact",
        "conflict": False,
        "workCompatibility": "compatible",
        "dependencyState": "admitted",
    }
    value.update(overrides)
    return value


def _signals(**overrides):
    value = {
        "taskId": "verify-release-repeatably",
        "catalogRoot": _root("1"),
        "workRoot": _root("2"),
        "requirementsRoot": _root("3"),
        "candidates": [],
        "effects": [],
        "reusable": True,
        "stableInputs": True,
        "stableOutcomes": True,
        "proofAvailable": True,
        "recoveryAvailable": True,
        "workspaceLocal": True,
        "instructionOnly": True,
        "deduplicated": True,
        "evidenceCurrent": True,
        "oneOff": False,
        "ordinaryDocumentation": False,
        "productDefect": False,
        "duplicateSkill": False,
        "untrustedInstruction": False,
        "bypassMissingEvidence": False,
    }
    value.update(overrides)
    return value


@pytest.mark.parametrize(
    "signals, outcome",
    [
        (_signals(candidates=[_candidate()]), "auto-use-existing"),
        (
            _signals(
                candidates=[
                    _candidate(),
                    _candidate(key="verify-release-alt", contentRoot=_root("6")),
                ]
            ),
            "suggest-existing",
        ),
        (_signals(proofAvailable=False), "suggest-create"),
        (_signals(), "auto-draft"),
        (_signals(effects=["privacy"]), "plan-only"),
        (_signals(oneOff=True), "none"),
    ],
)
def test_exactly_one_of_six_rooted_outcomes(signals, outcome):
    result = assess_skill_decision(signals)

    assert result["decision"] == outcome
    assert result["decisionRoot"].startswith("sha256:")
    assert result["policyRoot"] == agent_resources.skill_decision_policy_root()
    assert result["reasonCodes"]
    assert result["evidenceRefs"]
    assert result["allowedActions"]
    assert result["blockedActions"]
    assert result["nextAction"]
    assert result["nonClaims"]


def test_auto_use_requires_one_current_compatible_admitted_exact_root():
    stale = assess_skill_decision(
        _signals(candidates=[_candidate()], evidenceCurrent=False)
    )
    unresolved = assess_skill_decision(
        _signals(candidates=[_candidate(dependencyState="unresolved")])
    )
    related = assess_skill_decision(_signals(candidates=[_candidate(match="related")]))
    duplicate = assess_skill_decision(
        _signals(candidates=[_candidate()], duplicateSkill=True)
    )

    assert stale["decision"] == "suggest-existing"
    assert "stale-evidence-expectations" in stale["reasonCodes"]
    assert unresolved["decision"] == "suggest-existing"
    assert "dependencies-not-admitted" in unresolved["reasonCodes"]
    assert related["decision"] == "suggest-existing"
    assert duplicate["decision"] == "none"
    assert "duplicate-skill-catalog-repair" in duplicate["reasonCodes"]


def test_same_rooted_signals_are_repeatable_and_order_independent():
    first_candidate = _candidate()
    second_candidate = _candidate(
        key="verify-release-alt", contentRoot=_root("6"), evidenceRoot=_root("7")
    )
    first = assess_skill_decision(
        _signals(candidates=[first_candidate, second_candidate])
    )
    replay = assess_skill_decision(
        _signals(candidates=[second_candidate, first_candidate])
    )

    assert first == replay
    assert first["decisionRoot"] == replay["decisionRoot"]


@pytest.mark.parametrize("field", ["untrustedInstruction", "bypassMissingEvidence"])
def test_malicious_or_evidence_bypass_signals_fail_to_none(field):
    result = assess_skill_decision(_signals(**{field: True}))

    assert result["decision"] == "none"
    assert result["allowedActions"] == [
        "continue-without-skill",
        "route-more-appropriate-product-action",
    ]


@pytest.mark.parametrize(
    "effect",
    [
        "kfx",
        "profile",
        "capability",
        "credential",
        "network",
        "external-write",
        "shared-install",
        "publication",
        "identity",
        "authority",
        "privacy",
        "destructive",
        "historical",
    ],
)
def test_material_semantics_are_plan_only(effect):
    assert (
        assess_skill_decision(_signals(effects=[effect], ordinaryDocumentation=True))[
            "decision"
        ]
        == "plan-only"
    )


@pytest.mark.parametrize("forbidden", ["rawTranscript", "hiddenPrompt", "credentials"])
def test_private_or_prompt_signal_fields_fail_closed(forbidden):
    with pytest.raises(ValueError, match="unsupported Skill decision signals"):
        assess_skill_decision({**_signals(), forbidden: "not accepted"})


def test_agent_pack_projections_bind_exact_policy_bytes():
    policy_path = agent_resources.pack_root() / "skill-decision.contract.json"
    policy_root = "sha256:" + hashlib.sha256(policy_path.read_bytes()).hexdigest()

    assert policy_root == agent_resources.skill_decision_policy_root()
    assert agent_resources.index()["skillDecision"]["policyRoot"] == policy_root
    assert agent_resources.intent_map()["skillDecision"]["policyRoot"] == policy_root
    assert policy_root in agent_resources.document_text("brief.md")
    for provider in ("codex", "claude", "amp", "opencode"):
        assert policy_root in agent_resources.skill_path(provider).read_text(
            encoding="utf-8"
        )
