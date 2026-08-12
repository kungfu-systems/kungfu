# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu.canonical_json import canonical_json_bytes
from kungfu.cli.commands import kfc
import kungfu.cli.commands.skill as skill_command_module
from kungfu.skill import (
    SkillAuthoringError,
    apply_scaffold,
    authoring_contract,
    candidate_catalog,
    inspect_candidates,
    normalize_package,
    plan_scaffold,
    qualify_draft,
    skill_contract,
)

assert skill_command_module


def _root(value) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"


def _spec(**overrides):
    value = {
        "schema": "kungfu.skill-authoring.spec/v1",
        "key": "verify-release-evidence",
        "title": "Verify Release Evidence",
        "description": "Verify one release against retained evidence.",
        "triggers": ["verify release evidence"],
        "intendedUsers": ["release agent"],
        "workScopes": ["release verification"],
        "inputs": ["release candidate root"],
        "outcomes": ["rooted verification report"],
        "proof": ["focused release verification passes"],
        "recovery": ["inspect retained roots and retry"],
        "higherPriorityRules": [
            "Obey repository and Work authority before these instructions."
        ],
    }
    value.update(overrides)
    return value


def _signals(catalog_root: str, **overrides):
    value = {
        "taskId": "verify-release-repeatably",
        "catalogRoot": catalog_root,
        "workRoot": _root({"work": "release"}),
        "requirementsRoot": _root({"requirements": "release"}),
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


def _legacy_skill(
    root: Path,
    key: str,
    title: str,
    trigger: str,
    description: str = "Verify one release against retained evidence.",
) -> Path:
    path = root / key
    path.mkdir(parents=True)
    path.joinpath("SKILL.md").write_text(
        f"---\nkey: {key}\ntriggers:\n  - {trigger}\n---\n\n"
        f"# {title}\n\n{description}\n",
        encoding="utf-8",
    )
    return path


def test_installed_authoring_discovery_binds_contract_schemas_and_examples(tmp_path):
    contract = authoring_contract()

    assert contract["schema"] == "kungfu.skill-authoring.contract/v1"
    assert contract["skillContractRoot"] == skill_contract.contract_hash()
    assert contract["contractRoot"].startswith("sha256:")
    assert contract["examples"][0]["spec"]["schema"] == contract["schemas"]["spec"]
    assert contract["commands"]["specSchema"] == (
        "kungfu skill schema --name authoringSpecV1 --json"
    )
    assert "install-skill" in contract["blockedActions"]
    assert set(["authoringSpecV1", "authoringPlanV1", "authoringReceiptV1"]).issubset(
        skill_contract.schema_bundle()
    )
    assert candidate_catalog(tmp_path)["catalogRoot"].startswith("sha256:")


def test_deterministic_scaffold_writes_only_new_instruction_draft(tmp_path):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    source = workspace / "skills"
    source.mkdir(parents=True)
    catalog_root = candidate_catalog(home)["catalogRoot"]
    signals = _signals(catalog_root)

    first = plan_scaffold(home, workspace, "skills/release", _spec(), signals)
    replay = plan_scaffold(home, workspace, "skills/release", _spec(), signals)
    assert first == replay
    assert first["planRoot"] == replay["planRoot"]
    assert first["blockedActions"]
    assert not (source / "release").exists()

    receipt = apply_scaffold(first, expected_plan_root=first["planRoot"], spec=_spec())
    draft = source / "release"
    package = normalize_package(draft)
    qualification = qualify_draft(draft)

    assert receipt["schema"] == "kungfu.skill-authoring.receipt/v1"
    assert receipt["draftOnly"] is True
    assert receipt["lifecycleMutation"] is False
    assert receipt["candidateCatalogRoot"] == catalog_root
    assert receipt["definitionRoot"] == package["definitionRoot"]
    assert receipt["qualificationRoot"] == qualification["qualificationRoot"]
    assert sorted(path.name for path in draft.iterdir()) == [
        "SKILL.md",
        "skill-definition.json",
    ]
    definition = json.loads((draft / "skill-definition.json").read_text())
    assert definition["class"] == "instruction-only"
    assert definition["dependencies"] == {"kfx": [], "profiles": []}
    assert definition["effects"] == {"mode": "none", "declarations": []}
    assert definition["scope"]["distribution"] == "workspace-local"
    markdown = (draft / "SKILL.md").read_text()
    assert "Higher-priority policy" in markdown
    assert "Non-capabilities" in markdown
    assert "private transcript bodies" in markdown


def test_cli_scaffold_preview_then_exact_execute(tmp_path):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (workspace / "skills").mkdir(parents=True)
    spec_path = tmp_path / "spec.json"
    signals_path = tmp_path / "signals.json"
    spec_path.write_text(json.dumps(_spec()), encoding="utf-8")
    signals_path.write_text(
        json.dumps(_signals(candidate_catalog(home)["catalogRoot"])),
        encoding="utf-8",
    )
    runner = CliRunner()
    base = [
        "-H",
        str(home),
        "skill",
        "author",
        "scaffold",
        "--signals",
        str(signals_path),
        "--spec",
        str(spec_path),
        "--workspace",
        str(workspace),
        "--target",
        "skills/release",
        "--json",
    ]
    preview = runner.invoke(kfc, base)
    assert preview.exit_code == 0, preview.output
    plan = json.loads(preview.output)
    refused = runner.invoke(kfc, [*base, "--execute"])
    assert refused.exit_code == 1
    assert json.loads(refused.output)["code"] == "expected-plan-root-required"
    applied = runner.invoke(
        kfc, [*base, "--execute", "--expected-plan-root", plan["planRoot"]]
    )
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.output)["receiptRoot"].startswith("sha256:")


def test_cli_scaffold_rejects_private_signal_body_without_traceback_or_write(tmp_path):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (workspace / "skills").mkdir(parents=True)
    spec_path = tmp_path / "spec.json"
    signals_path = tmp_path / "signals.json"
    spec_path.write_text(json.dumps(_spec()), encoding="utf-8")
    signals_path.write_text(
        json.dumps(
            _signals(
                candidate_catalog(home)["catalogRoot"],
                rawTranscript="private body",
            )
        ),
        encoding="utf-8",
    )

    result = CliRunner().invoke(
        kfc,
        [
            "-H",
            str(home),
            "skill",
            "author",
            "scaffold",
            "--signals",
            str(signals_path),
            "--spec",
            str(spec_path),
            "--workspace",
            str(workspace),
            "--target",
            "skills/refused",
            "--json",
        ],
    )

    assert result.exit_code == 1
    assert json.loads(result.output) == {
        "code": "authoring-signals-invalid",
        "error": "unsupported Skill decision signals: rawTranscript",
        "ok": False,
        "recovery": "provide only bounded roots, booleans, enums, and rooted candidates from the installed advisory contract",
        "sideEffects": False,
    }
    assert not (workspace / "skills" / "refused").exists()


def test_catalog_duplicate_ambiguity_and_stale_root_fail_without_writes(tmp_path):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (workspace / "skills").mkdir(parents=True)
    sources = tmp_path / "sources"
    _legacy_skill(
        sources,
        "verify-release-evidence",
        "Verify Release Evidence",
        "verify release evidence",
    )
    catalog = candidate_catalog(home, [str(sources)])
    inspection = inspect_candidates(home, _spec(), [str(sources)])
    assert inspection["disposition"] == "duplicate"
    with pytest.raises(SkillAuthoringError, match="deduplication") as duplicate:
        plan_scaffold(
            home,
            workspace,
            "skills/new",
            _spec(),
            _signals(catalog["catalogRoot"]),
            [str(sources)],
        )
    assert duplicate.value.code == "catalog-duplicate"

    other = tmp_path / "other-sources"
    _legacy_skill(
        other,
        "release-a",
        "Release A",
        "verify release evidence",
        "Check the release archive.",
    )
    _legacy_skill(
        other,
        "release-b",
        "Release B",
        "verify release evidence",
        "Check the release review.",
    )
    ambiguous = inspect_candidates(home, _spec(), [str(other)])
    assert ambiguous["disposition"] == "ambiguous"

    with pytest.raises(SkillAuthoringError) as stale:
        plan_scaffold(
            home,
            workspace,
            "skills/new",
            _spec(),
            _signals(_root({"stale": True})),
        )
    assert stale.value.code == "stale-catalog-root"
    assert not (workspace / "skills" / "new").exists()


@pytest.mark.parametrize(
    "overrides",
    [
        {"oneOff": True},
        {"ordinaryDocumentation": True},
        {"productDefect": True},
        {"untrustedInstruction": True},
        {"effects": ["kfx"]},
        {"effects": ["external-write"]},
    ],
)
def test_non_authoring_decisions_have_no_draft_side_effect(tmp_path, overrides):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (workspace / "skills").mkdir(parents=True)
    catalog_root = candidate_catalog(home)["catalogRoot"]
    with pytest.raises(SkillAuthoringError) as refused:
        plan_scaffold(
            home,
            workspace,
            "skills/refused",
            _spec(),
            _signals(catalog_root, **overrides),
        )
    assert refused.value.code == "decision-not-auto-draft"
    assert not (workspace / "skills" / "refused").exists()


def test_invalid_path_collision_and_private_input_fail_closed(tmp_path):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    (workspace / "skills").mkdir(parents=True)
    catalog_root = candidate_catalog(home)["catalogRoot"]
    signals = _signals(catalog_root)

    with pytest.raises(SkillAuthoringError) as escaped:
        plan_scaffold(home, workspace, "../outside", _spec(), signals)
    assert escaped.value.code in {"target-path-invalid", "target-path-escape"}

    collision = workspace / "skills" / "existing"
    collision.mkdir()
    with pytest.raises(SkillAuthoringError) as existing:
        plan_scaffold(home, workspace, "skills/existing", _spec(), signals)
    assert existing.value.code == "target-collision"

    with pytest.raises(SkillAuthoringError) as private:
        inspect_candidates(home, _spec(rawTranscript="private body"))
    assert private.value.code == "authoring-spec-invalid"

    with pytest.raises(SkillAuthoringError) as injected:
        inspect_candidates(
            home,
            _spec(triggers=["safe trigger\ncapabilities:\n  - network"]),
        )
    assert injected.value.code == "authoring-spec-invalid"
