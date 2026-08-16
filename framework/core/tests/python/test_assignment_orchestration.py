# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta, timezone
import importlib
import json
from pathlib import Path
import shutil
from types import SimpleNamespace

import click
import kungfu
import pytest
from click.testing import CliRunner

from kungfu import (
    assignment_orchestration,
    initiative_family,
    profile_composition,
    profile_sdk,
)
from kungfu.initiative_family import canonical as assignment_canonical
from kungfu.initiative_family import typed_v2 as initiative_family_v2
from kungfu import work_control
from kungfu.cli.commands import kfc
from kungfu.workspace import (
    ensure_workspace_data_home,
    inspect_workspace,
    resolve_workspace_target,
)
from kungfu.workspace_federation import (
    build_relation,
    build_work_ref,
    query_federation,
)


SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "work-control"
ASSIGNMENT_CLI = importlib.import_module("kungfu.cli.commands.assignment")


@pytest.fixture(autouse=True)
def _bind_work_control_profile(monkeypatch):
    monkeypatch.setenv("KF_EXTENSION_PATH", str(SOURCE.parent))


def _sha256(marker):
    return "sha256:" + marker * 64


def test_assignment_atomic_paths_use_windows_extended_namespace():
    local = assignment_orchestration._filesystem_path(
        Path(r"C:\Users\Administrator\workspace\.kungfu\request.json"),
        platform="nt",
    )
    network = assignment_orchestration._filesystem_path(
        Path(r"\\server\share\workspace\.kungfu\request.json"),
        platform="nt",
    )

    assert local == (r"\\?\C:\Users\Administrator\workspace\.kungfu\request.json")
    assert network == (r"\\?\UNC\server\share\workspace\.kungfu\request.json")


def test_assignment_admit_defers_request_path_validation_to_orchestration():
    request_argument = next(
        parameter
        for parameter in ASSIGNMENT_CLI.admit.params
        if parameter.name == "request_file"
    )
    request_path = (
        Path("C:/actions-runner/_work/kungfu/kungfu/.buildchain/tmp")
        / ("long-assignment-path-" + "x" * 240)
        / "request.json"
    )

    assert request_argument.type.exists is False
    assert request_argument.type.convert(str(request_path), None, None) == request_path


def test_captured_request_reads_all_paths_through_filesystem_namespace(
    tmp_path, monkeypatch
):
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "assignment-request"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {"assignment_id": "filesystem-namespace-read"},
    }
    target = resolve_workspace_target(
        "capture-only", str(tmp_path), cwd=str(tmp_path), env={"HOME": str(tmp_path)}
    )
    response = assignment_orchestration.capture_assignment_request(request, target)
    observed = []
    original = assignment_orchestration._filesystem_path

    def observe(path, *, platform=None):
        observed.append(Path(path))
        return original(path) if platform is None else original(path, platform=platform)

    monkeypatch.setattr(assignment_orchestration, "_filesystem_path", observe)

    captured = assignment_orchestration.load_captured_request(response["requestPath"])

    request_path = Path(response["requestPath"]).resolve()
    receipt_dir = request_path.parent / "receipts" / "sha256"
    receipt_path = Path(response["receiptPath"]).resolve()
    assert captured["request_root"] == response["requestRoot"]
    assert request_path in observed
    assert receipt_dir in observed
    assert receipt_path in observed


def _activate(runtime):
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime,
            action,
            SOURCE,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")
    contract = profile_composition.contract_materialization_plan(SOURCE, runtime)
    if contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"], "approve", "test-owner"
            ),
        )


def _initiative_admission(
    initiative_id="initiative-a",
    title="Initiative A",
    intent="Own the continuing workstream",
):
    body = {
        "schema": assignment_orchestration.INITIATIVE_ADMISSION_SCHEMA,
        "initiativeId": initiative_id,
        "title": title,
        "intent": intent,
        "source": {
            "schema": assignment_orchestration.INITIATIVE_SOURCE_SCHEMA,
            "authority": "kungfu",
            "kind": "initiative-admission",
            "sourceId": initiative_id,
            "versionRoot": "sha256:" + "c" * 64,
        },
    }
    return {
        **body,
        "admissionRoot": assignment_canonical.semantic_root(body),
    }


def _family_blueprint():
    return {
        "schema": initiative_family.FAMILY_BLUEPRINT_SCHEMA,
        "initiative": {
            "initiativeId": "initiative-family-a",
            "versionRoot": _sha256("1"),
        },
        "wave": {
            "waveId": "wave-0",
            "ordinal": 0,
            "gateAssignmentId": "wave-0-gate",
        },
        "children": [
            {
                "assignmentId": "child-a",
                "workDefinitionRoot": _sha256("2"),
                "deliveryClass": "native-proof-required",
                "responsibilitySlices": ["schema"],
                "dependsOn": [],
            },
            {
                "assignmentId": "child-b",
                "workDefinitionRoot": _sha256("3"),
                "deliveryClass": "non-native-fast",
                "responsibilitySlices": ["cli", "tests"],
                "dependsOn": ["child-a"],
            },
            {
                "assignmentId": "child-c",
                "workDefinitionRoot": _sha256("4"),
                "deliveryClass": "cross-platform",
                "responsibilitySlices": ["compatibility"],
                "dependsOn": ["child-b"],
            },
        ],
        "acceptanceIds": ["evidence-completeness", "parent-liveness"],
    }


def _merged_terminal(marker="a"):
    return {
        "state": "merged",
        "recordedAt": "2026-07-28T03:00:00Z",
        "sourceRoot": _sha256(marker),
        "pullRequestRoot": _sha256("b"),
        "mergeCommitRoot": _sha256("c"),
        "finalAncestryRoot": _sha256("d"),
        "proofRoot": _sha256("e"),
        "sloRoot": _sha256("f"),
    }


def _transition(state, terminal_updates=None, acceptance_updates=None):
    return {
        "schema": initiative_family.FAMILY_TRANSITION_SCHEMA,
        "expectedStateRoot": state["stateRoot"],
        "terminalUpdates": terminal_updates or [],
        "acceptanceUpdates": acceptance_updates or [],
    }


def _typed_ref(
    kind,
    marker,
    *,
    identity=None,
    fact_world="work-control-world",
    cut_root=None,
    status="current",
):
    return {
        "kind": kind,
        "identity": identity or f"{kind}-{marker}",
        "root": _sha256(marker),
        "factWorld": fact_world,
        "cutRoot": cut_root or _sha256("0"),
        "schema": f"example.{kind}/v1",
        "status": status,
    }


def _settlement(
    publication_state="published",
    *,
    fact_world="work-control-world",
    cut_root=None,
):
    cut_root = cut_root or _sha256("0")
    lag_started_at = (
        None if publication_state == "published" else "2026-07-28T03:00:01Z"
    )
    failure = {"present": False, "reference": None}
    if publication_state == "failed":
        failure = {
            "present": True,
            "reference": _typed_ref(
                "publication-failure",
                "3",
                fact_world=fact_world,
                cut_root=cut_root,
                status="visible",
            ),
        }
    return {
        "factWorld": fact_world,
        "factCutRoot": cut_root,
        "references": {
            "completionClaim": _typed_ref(
                "completion-claim",
                "b",
                fact_world=fact_world,
                cut_root=cut_root,
                status="claimed-complete",
            ),
            "assessment": _typed_ref(
                "assessment",
                "c",
                fact_world=fact_world,
                cut_root=cut_root,
                status="fit",
            ),
            "decision": _typed_ref(
                "decision",
                "d",
                fact_world=fact_world,
                cut_root=cut_root,
                status="accepted",
            ),
            "admissionReceipt": _typed_ref(
                "admission-receipt",
                "e",
                fact_world=fact_world,
                cut_root=cut_root,
                status="admitted",
            ),
            "episode": _typed_ref(
                "episode",
                "f",
                fact_world=fact_world,
                cut_root=cut_root,
                status="sealed",
            ),
            "projectCut": _typed_ref(
                "project-cut",
                "1",
                fact_world=fact_world,
                cut_root=cut_root,
                status="settled",
            ),
            "deliveryEvidence": _typed_ref(
                "delivery-evidence",
                "2",
                fact_world=fact_world,
                cut_root=cut_root,
                status="verified",
            ),
        },
        "publication": {
            "state": publication_state,
            "lagStartedAt": lag_started_at,
            "failure": failure,
        },
    }


def _seal_binding_manifest(manifest):
    manifest.pop("bindingRoot", None)
    manifest["bindingRoot"] = assignment_canonical.semantic_root(manifest)
    return manifest


def _family_binding_manifest(state, publication_state="published"):
    fact_world = "work-control-world"
    cut_root = _sha256("0")
    children = []
    for index, child in enumerate(state["children"], start=4):
        marker = f"{index:x}"[-1]
        settlement = {"present": False, "value": None}
        if (child["terminal"] or {}).get("state") == "merged":
            settlement = {
                "present": True,
                "value": _settlement(
                    publication_state,
                    fact_world=fact_world,
                    cut_root=cut_root,
                ),
            }
        work_definition = _typed_ref(
            "work-definition",
            marker,
            identity=f"{child['assignmentId']}:work-definition",
            fact_world=fact_world,
            cut_root=cut_root,
            status="accepted",
        )
        work_definition["root"] = child["workDefinitionRoot"]
        children.append(
            {
                "assignmentId": child["assignmentId"],
                "assignmentState": _typed_ref(
                    "assignment-state",
                    marker,
                    identity=child["assignmentId"],
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status=("terminal" if child["terminal"] is not None else "active"),
                ),
                "workDefinition": work_definition,
                "pursuit": _typed_ref(
                    "pursuit",
                    "5",
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status="active",
                ),
                "atlas": _typed_ref(
                    "atlas",
                    "6",
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status="current",
                ),
                "executionWarrant": _typed_ref(
                    "execution-warrant",
                    "7",
                    fact_world=fact_world,
                    cut_root=cut_root,
                    status="active",
                ),
                "settlement": settlement,
            }
        )
    manifest = {
        "schema": initiative_family_v2.FAMILY_BINDING_V2_SCHEMA,
        "v1StateRoot": state["stateRoot"],
        "factWorld": fact_world,
        "factCutRoot": cut_root,
        "initiative": {
            "initiativeId": state["initiative"]["initiativeId"],
            "pursuit": _typed_ref(
                "pursuit",
                "1",
                fact_world=fact_world,
                cut_root=cut_root,
                status="active",
            ),
            "atlas": _typed_ref(
                "atlas",
                "2",
                fact_world=fact_world,
                cut_root=cut_root,
                status="current",
            ),
            "acceptancePolicy": _typed_ref(
                "acceptance-policy",
                "3",
                fact_world=fact_world,
                cut_root=cut_root,
                status="current",
            ),
        },
        "children": children,
    }
    return _seal_binding_manifest(manifest)


def test_initiative_family_state_is_rooted_bounded_and_parent_inert():
    state = initiative_family.create_family_state(_family_blueprint())
    verification = initiative_family.verify_family_state(state)

    assert state["schema"] == initiative_family.FAMILY_STATE_SCHEMA
    assert state["initiative"]["role"] == "inert-parent"
    assert set(state["initiative"]) == {"initiativeId", "versionRoot", "role"}
    assert state["wave"]["gateState"] == "terminal"
    assert verification["parentInert"] is True
    assert verification["waveGateTerminal"] is True
    assert verification["childCount"] == 3
    assert verification["waveDrained"] is False
    assert initiative_family.family_contract()["waveChildBounds"] == {
        "minimum": 3,
        "maximum": 6,
    }
    blueprint = _family_blueprint()
    blueprint["initiative"]["executionClaim"] = "forbidden"
    with pytest.raises(ValueError, match="invalid field set"):
        initiative_family.create_family_state(blueprint)


def test_retained_wave_0_v1_fixture_preserves_exact_bytes_and_root():
    fixture = (
        Path(__file__).resolve().parents[1]
        / "fixtures"
        / "assignment-family-wave-0-state-v1.json"
    )
    exact_bytes = fixture.read_bytes()
    state = json.loads(exact_bytes)

    assert exact_bytes == (assignment_canonical.canonical_json(state) + "\n").encode(
        "utf-8"
    )
    assert state["stateRoot"] == (
        "sha256:15b306c3c3ce52b4caf4a0fa0419f191d36e3a51e1cfdc54ebb2110e4aa3163a"
    )
    assert initiative_family.validate_family_state(state) == state


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            lambda value: value["children"].pop(),
            "exactly three to six children",
        ),
        (
            lambda value: value["children"].__setitem__(1, dict(value["children"][0])),
            "sorted and duplicate-free",
        ),
        (
            lambda value: value["children"][1].__setitem__(
                "dependsOn", ["orphan-child"]
            ),
            "not a Wave member",
        ),
        (
            lambda value: (
                value["children"][0].__setitem__("dependsOn", ["child-c"]),
                value["children"][1].__setitem__("dependsOn", ["child-a"]),
                value["children"][2].__setitem__("dependsOn", ["child-b"]),
            ),
            "contains a cycle",
        ),
    ],
)
def test_initiative_family_rejects_invalid_membership_and_dependencies(
    mutation, message
):
    blueprint = _family_blueprint()
    mutation(blueprint)

    with pytest.raises(ValueError, match=message):
        initiative_family.create_family_state(blueprint)


def test_family_transitions_bind_terminal_evidence_and_residual_only_successor():
    initial = initiative_family.create_family_state(_family_blueprint())
    merged = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {"assignmentId": "child-a", "terminal": _merged_terminal()}
            ],
            acceptance_updates=[
                {
                    "acceptanceId": "evidence-completeness",
                    "status": "partial",
                    "evidenceRoots": [_sha256("a")],
                }
            ],
        ),
    )
    continued_terminal = {
        "state": "continued",
        "recordedAt": "2026-07-28T03:04:59Z",
        "boundExceededAt": "2026-07-28T03:00:00Z",
        "sourceRoot": _sha256("1"),
        "decisionRoot": _sha256("2"),
        "completedEvidenceRoots": [_sha256("3")],
        "completedResponsibilitySlices": ["cli"],
        "residualSuccessor": {
            "assignmentId": "child-b-residual",
            "requestRoot": _sha256("4"),
            "captureReceiptRoots": [_sha256("5")],
            "responsibilitySlices": ["tests"],
        },
    }
    continued = initiative_family.transition_family_state(
        merged,
        _transition(
            merged,
            terminal_updates=[
                {"assignmentId": "child-b", "terminal": continued_terminal}
            ],
        ),
    )
    failed = initiative_family.transition_family_state(
        continued,
        _transition(
            continued,
            terminal_updates=[
                {
                    "assignmentId": "child-c",
                    "terminal": {
                        "state": "failed",
                        "recordedAt": "2026-07-28T03:05:00Z",
                        "sourceRoot": _sha256("6"),
                        "failureRoot": _sha256("7"),
                    },
                }
            ],
            acceptance_updates=[
                {
                    "acceptanceId": "evidence-completeness",
                    "status": "proved",
                    "evidenceRoots": [_sha256("8")],
                },
                {
                    "acceptanceId": "parent-liveness",
                    "status": "proved",
                    "evidenceRoots": [_sha256("9")],
                },
            ],
        ),
    )

    assert merged["previousStateRoot"] == initial["stateRoot"]
    assert continued["previousStateRoot"] == merged["stateRoot"]
    assert continued["children"][1]["terminal"] == continued_terminal
    verification = initiative_family.verify_family_state(failed)
    assert verification["waveDrained"] is True
    assert verification["terminalCounts"] == {
        "merged": 1,
        "continued": 1,
        "deferred": 0,
        "failed": 1,
    }


def test_family_transition_fails_closed_on_scope_growth_and_invalid_coverage():
    initial = initiative_family.create_family_state(_family_blueprint())
    merged = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {"assignmentId": "child-a", "terminal": _merged_terminal()}
            ],
            acceptance_updates=[
                {
                    "acceptanceId": "evidence-completeness",
                    "status": "proved",
                    "evidenceRoots": [_sha256("a")],
                }
            ],
        ),
    )
    grown = {
        "state": "continued",
        "recordedAt": "2026-07-28T03:04:00Z",
        "boundExceededAt": "2026-07-28T03:00:00Z",
        "sourceRoot": _sha256("1"),
        "decisionRoot": _sha256("2"),
        "completedEvidenceRoots": [_sha256("3")],
        "completedResponsibilitySlices": ["cli"],
        "residualSuccessor": {
            "assignmentId": "child-b-residual",
            "requestRoot": _sha256("4"),
            "captureReceiptRoots": [_sha256("5")],
            "responsibilitySlices": ["new-scope", "tests"],
        },
    }

    with pytest.raises(ValueError, match="exactly the uncompleted responsibility"):
        initiative_family.transition_family_state(
            merged,
            _transition(
                merged,
                terminal_updates=[{"assignmentId": "child-b", "terminal": grown}],
            ),
        )
    with pytest.raises(ValueError, match="coverage transition is invalid"):
        initiative_family.transition_family_state(
            merged,
            _transition(
                merged,
                acceptance_updates=[
                    {
                        "acceptanceId": "evidence-completeness",
                        "status": "missing",
                        "evidenceRoots": [],
                    }
                ],
            ),
        )
    with pytest.raises(ValueError, match="within five minutes"):
        late = dict(grown)
        late["residualSuccessor"] = {
            **grown["residualSuccessor"],
            "responsibilitySlices": ["tests"],
        }
        late["recordedAt"] = "2026-07-28T03:05:01Z"
        initiative_family.transition_family_state(
            merged,
            _transition(
                merged,
                terminal_updates=[{"assignmentId": "child-b", "terminal": late}],
            ),
        )
    with pytest.raises(ValueError, match="invalid field set"):
        incomplete = _merged_terminal()
        incomplete.pop("proofRoot")
        initiative_family.transition_family_state(
            initial,
            _transition(
                initial,
                terminal_updates=[{"assignmentId": "child-a", "terminal": incomplete}],
            ),
        )
    unchanged = {
        "acceptanceId": "evidence-completeness",
        "status": "proved",
        "evidenceRoots": [_sha256("a")],
    }
    with pytest.raises(ValueError, match="no semantic change"):
        initiative_family.transition_family_state(
            merged,
            _transition(merged, acceptance_updates=[unchanged]),
        )


def test_family_deferred_terminal_requires_an_exact_decision_root():
    initial = initiative_family.create_family_state(_family_blueprint())
    deferred = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {
                    "assignmentId": "child-a",
                    "terminal": {
                        "state": "deferred",
                        "recordedAt": "2026-07-28T03:00:00Z",
                        "sourceRoot": _sha256("a"),
                        "decisionRoot": _sha256("b"),
                    },
                }
            ],
        ),
    )

    assert deferred["children"][0]["terminal"]["state"] == "deferred"


def test_family_cli_writes_successor_without_overwriting_prior_state(tmp_path):
    runner = CliRunner()
    blueprint = tmp_path / "blueprint.json"
    initial_path = tmp_path / "initial.json"
    blueprint.write_text(json.dumps(_family_blueprint()), encoding="utf-8")

    created = runner.invoke(
        kfc,
        ["work", "family-create", str(blueprint), "--out", str(initial_path)],
    )
    assert created.exit_code == 0, created.output
    initial = json.loads(initial_path.read_text(encoding="utf-8"))
    transition = tmp_path / "transition.json"
    transition.write_text(
        json.dumps(
            _transition(
                initial,
                terminal_updates=[
                    {"assignmentId": "child-a", "terminal": _merged_terminal()}
                ],
            )
        ),
        encoding="utf-8",
    )
    successor_path = tmp_path / "successor.json"
    advanced = runner.invoke(
        kfc,
        [
            "work",
            "family-transition",
            str(initial_path),
            str(transition),
            "--out",
            str(successor_path),
        ],
    )
    assert advanced.exit_code == 0, advanced.output
    successor = json.loads(successor_path.read_text(encoding="utf-8"))
    assert successor["previousStateRoot"] == initial["stateRoot"]
    assert json.loads(initial_path.read_text(encoding="utf-8")) == initial
    verified = runner.invoke(kfc, ["work", "family-verify", str(successor_path)])
    assert verified.exit_code == 0, verified.output
    assert json.loads(verified.output)["ok"] is True


def test_family_v2_upgrade_is_explicit_and_projects_exact_v1_state():
    v1_state = initiative_family.create_family_state(_family_blueprint())
    v1_bytes = assignment_canonical.canonical_json(v1_state)
    manifest = _family_binding_manifest(v1_state)

    upgrade = initiative_family_v2.upgrade_family_state_v2(v1_state, manifest)
    successor = upgrade["successorState"]
    verification = initiative_family_v2.verify_family_state_v2(successor)
    under_typed = initiative_family_v2.verify_family_state_v2(v1_state)

    assert upgrade["predecessorStateRoot"] == v1_state["stateRoot"]
    assert upgrade["v1ProjectionRoot"] == v1_state["stateRoot"]
    assert upgrade["typedBindingRoot"] == manifest["bindingRoot"]
    assert upgrade["successorStateRoot"] == successor["stateRoot"]
    assert initiative_family_v2.project_family_state_v1(successor) == v1_state
    assert assignment_canonical.canonical_json(v1_state) == v1_bytes
    assert verification["typingState"] == "fully-typed-v2"
    assert verification["projectionMergeIsCompletion"] is False
    assert under_typed["typingState"] == "under-typed-v1"
    assert under_typed["fullyTyped"] is False
    assert "work-definition" in under_typed["missingSemanticBindings"]
    assert initiative_family.family_contract()["schema"].endswith("/v1")
    assert (
        initiative_family_v2.family_contract_v2()["predecessorContractRoot"]
        == initiative_family.family_contract()["contractRoot"]
    )


def test_family_v2_cli_upgrade_writes_only_the_successor_state(tmp_path):
    runner = CliRunner()
    v1_state = initiative_family.create_family_state(_family_blueprint())
    state_path = tmp_path / "state-v1.json"
    binding_path = tmp_path / "bindings-v2.json"
    successor_path = tmp_path / "state-v2.json"
    state_path.write_text(json.dumps(v1_state), encoding="utf-8")
    binding_path.write_text(
        json.dumps(_family_binding_manifest(v1_state)), encoding="utf-8"
    )

    result = runner.invoke(
        kfc,
        [
            "work",
            "family-upgrade-v2",
            str(state_path),
            str(binding_path),
            "--out",
            str(successor_path),
        ],
    )

    assert result.exit_code == 0, result.output
    successor = json.loads(successor_path.read_text(encoding="utf-8"))
    assert successor["schema"] == initiative_family_v2.FAMILY_STATE_V2_SCHEMA
    assert successor["v1ProjectionRoot"] == v1_state["stateRoot"]
    assert json.loads(state_path.read_text(encoding="utf-8")) == v1_state


def test_family_v2_transition_requires_typed_settlement_and_exposes_publication_lag():
    v1_state = initiative_family.create_family_state(_family_blueprint())
    v2_state = initiative_family_v2.upgrade_family_state_v2(
        v1_state, _family_binding_manifest(v1_state)
    )["successorState"]
    v1_transition = _transition(
        v1_state,
        terminal_updates=[{"assignmentId": "child-a", "terminal": _merged_terminal()}],
    )
    successor_projection = initiative_family.transition_family_state(
        v1_state, v1_transition
    )
    transition = {
        "schema": initiative_family_v2.FAMILY_TRANSITION_V2_SCHEMA,
        "expectedStateRoot": v2_state["stateRoot"],
        "v1Transition": v1_transition,
        "typedBindingManifest": _family_binding_manifest(
            successor_projection, publication_state="pending"
        ),
    }

    successor = initiative_family_v2.transition_family_state_v2(v2_state, transition)
    verification = initiative_family_v2.verify_family_state_v2(successor)
    settlement = successor["typedBindings"]["children"][0]["settlement"]["value"]

    assert successor["previousStateRoot"] == v2_state["stateRoot"]
    assert successor["predecessorStateRoot"] == v1_state["stateRoot"]
    assert successor["v1ProjectionRoot"] == successor_projection["stateRoot"]
    assert settlement["references"]["decision"]["kind"] == "decision"
    assert settlement["references"]["admissionReceipt"]["status"] == "admitted"
    assert settlement["publication"]["state"] == "pending"
    assert settlement["publication"]["lagStartedAt"]
    assert verification["pendingPublicationCount"] == 1
    assert verification["publicationComplete"] is False
    assert verification["completionQualified"] is False


def test_family_v2_completion_requires_all_merged_accepted_and_published():
    initial = initiative_family.create_family_state(_family_blueprint())
    settled = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {
                    "assignmentId": child["assignmentId"],
                    "terminal": _merged_terminal(),
                }
                for child in initial["children"]
            ],
            acceptance_updates=[
                {
                    "acceptanceId": acceptance["acceptanceId"],
                    "status": "proved",
                    "evidenceRoots": [_sha256(str(index))],
                }
                for index, acceptance in enumerate(initial["acceptance"])
            ],
        ),
    )
    typed = initiative_family_v2.upgrade_family_state_v2(
        settled, _family_binding_manifest(settled, publication_state="published")
    )["successorState"]

    verification = initiative_family_v2.verify_family_state_v2(typed)

    assert verification["waveDrained"] is True
    assert verification["mergedSettlementCount"] == len(initial["children"])
    assert verification["publicationComplete"] is True
    assert verification["completionQualified"] is True
    assert verification["projectionMergeIsCompletion"] is False


@pytest.mark.parametrize("warrant_status", ["stale", "revoked"])
def test_family_v2_rejects_stale_or_revoked_warrant(warrant_status):
    state = initiative_family.create_family_state(_family_blueprint())
    manifest = _family_binding_manifest(state)
    manifest["children"][0]["executionWarrant"]["status"] = warrant_status
    _seal_binding_manifest(manifest)

    with pytest.raises(ValueError, match="active, not stale or revoked"):
        initiative_family_v2.upgrade_family_state_v2(state, manifest)


@pytest.mark.parametrize("missing_field", ["decision", "admissionReceipt"])
def test_family_v2_merged_settlement_requires_decision_and_admission(missing_field):
    initial = initiative_family.create_family_state(_family_blueprint())
    merged = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {"assignmentId": "child-a", "terminal": _merged_terminal()}
            ],
        ),
    )
    manifest = _family_binding_manifest(merged)
    references = manifest["children"][0]["settlement"]["value"]["references"]
    references.pop(missing_field)
    _seal_binding_manifest(manifest)

    with pytest.raises(ValueError, match="invalid field set"):
        initiative_family_v2.upgrade_family_state_v2(merged, manifest)


@pytest.mark.parametrize(
    ("coordinate", "wrong_value"),
    [
        ("factWorld", "other-world"),
        ("factCutRoot", _sha256("f")),
    ],
)
def test_family_v2_rejects_self_consistent_settlement_from_another_cut(
    coordinate, wrong_value
):
    initial = initiative_family.create_family_state(_family_blueprint())
    merged = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {"assignmentId": "child-a", "terminal": _merged_terminal()}
            ],
        ),
    )
    manifest = _family_binding_manifest(merged)
    settlement = manifest["children"][0]["settlement"]["value"]
    settlement[coordinate] = wrong_value
    reference_coordinate = "factWorld" if coordinate == "factWorld" else "cutRoot"
    for reference in settlement["references"].values():
        reference[reference_coordinate] = wrong_value
    _seal_binding_manifest(manifest)

    with pytest.raises(ValueError, match="does not match the family binding"):
        initiative_family_v2.upgrade_family_state_v2(merged, manifest)


@pytest.mark.parametrize(
    ("field", "wrong_status", "expected_status"),
    [
        ("completionClaim", "declared", "claimed-complete"),
        ("assessment", "qualified", "fit"),
        ("decision", "proposed", "accepted"),
        ("episode", "open", "sealed"),
        ("projectCut", "prepared", "settled"),
        ("deliveryEvidence", "missing", "verified"),
    ],
)
def test_family_v2_settlement_requires_exact_authority_status(
    field, wrong_status, expected_status
):
    initial = initiative_family.create_family_state(_family_blueprint())
    merged = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {"assignmentId": "child-a", "terminal": _merged_terminal()}
            ],
        ),
    )
    manifest = _family_binding_manifest(merged)
    references = manifest["children"][0]["settlement"]["value"]["references"]
    references[field]["status"] = wrong_status
    _seal_binding_manifest(manifest)

    with pytest.raises(ValueError, match=rf"status must be {expected_status}"):
        initiative_family_v2.upgrade_family_state_v2(merged, manifest)


def test_family_v2_assignment_state_status_must_match_v1_lifecycle():
    state = initiative_family.create_family_state(_family_blueprint())
    manifest = _family_binding_manifest(state)
    manifest["children"][0]["assignmentState"]["status"] = "terminal"
    _seal_binding_manifest(manifest)

    with pytest.raises(ValueError, match=r"assignmentState\.status must be active"):
        initiative_family_v2.upgrade_family_state_v2(state, manifest)


def test_family_v2_work_definition_identity_must_match_child():
    state = initiative_family.create_family_state(_family_blueprint())
    manifest = _family_binding_manifest(state)
    manifest["children"][0]["workDefinition"]["identity"] = "child-b:work-definition"
    _seal_binding_manifest(manifest)

    with pytest.raises(
        ValueError, match="work-definition reference identity does not match child"
    ):
        initiative_family_v2.upgrade_family_state_v2(state, manifest)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            lambda manifest: manifest["initiative"].update(
                {
                    "pursuit": manifest["initiative"]["atlas"],
                    "atlas": manifest["initiative"]["pursuit"],
                }
            ),
            r"initiative\.pursuit\.kind must be pursuit",
        ),
        (
            lambda manifest: manifest["children"][0]["atlas"].update(
                {"factWorld": "wrong-world"}
            ),
            "wrong fact world",
        ),
        (
            lambda manifest: manifest["children"][0]["pursuit"].update(
                {"cutRoot": _sha256("f")}
            ),
            "wrong cut",
        ),
        (
            lambda manifest: manifest.update({"v1StateRoot": _sha256("f")}),
            "wrong v1 predecessor state",
        ),
    ],
)
def test_family_v2_rejects_swapped_or_misbound_semantic_references(mutation, message):
    state = initiative_family.create_family_state(_family_blueprint())
    manifest = _family_binding_manifest(state)
    mutation(manifest)
    _seal_binding_manifest(manifest)

    with pytest.raises(ValueError, match=message):
        initiative_family_v2.upgrade_family_state_v2(state, manifest)


def test_family_v2_rejects_hidden_publication_lag():
    initial = initiative_family.create_family_state(_family_blueprint())
    merged = initiative_family.transition_family_state(
        initial,
        _transition(
            initial,
            terminal_updates=[
                {"assignmentId": "child-a", "terminal": _merged_terminal()}
            ],
        ),
    )
    manifest = _family_binding_manifest(merged, publication_state="pending")
    publication = manifest["children"][0]["settlement"]["value"]["publication"]
    publication["lagStartedAt"] = None
    _seal_binding_manifest(manifest)

    with pytest.raises(ValueError, match="must be an ISO-8601 timestamp"):
        initiative_family_v2.upgrade_family_state_v2(merged, manifest)


def test_cli_run_preserves_an_intentional_machine_readable_exit(monkeypatch):
    emitted = []
    monkeypatch.setattr(ASSIGNMENT_CLI, "_emit", emitted.append)

    with pytest.raises(click.exceptions.Exit) as failure:
        ASSIGNMENT_CLI._run(lambda: (_ for _ in ()).throw(click.exceptions.Exit(3)))

    assert failure.value.exit_code == 3
    assert emitted == []


def test_initiative_admission_requires_exact_content_root(tmp_path):
    admission = _initiative_admission()
    path = tmp_path / "initiative.json"
    path.write_text(json.dumps(admission), encoding="utf-8")

    loaded = assignment_orchestration.load_initiative_admission(path)

    assert loaded == admission
    admission["title"] = "Mutable label must not pass"
    path.write_text(json.dumps(admission), encoding="utf-8")
    with pytest.raises(ValueError, match="root does not verify"):
        assignment_orchestration.load_initiative_admission(path)


def test_exact_initiative_identity_uses_the_open_record_without_schema_drift(
    tmp_path,
):
    runtime = tmp_path / "runtime"
    _activate(runtime)
    admission = _initiative_admission()
    source_identity = {
        **admission["source"],
        "admissionRoot": admission["admissionRoot"],
    }

    work_control.create_initiative(
        str(runtime),
        initiative_id=admission["initiativeId"],
        title=admission["title"],
        intent=admission["intent"],
        actor="agent-a",
        actor_type="agent",
        source_identity=source_identity,
    )
    initiatives = work_control.list_initiatives(str(runtime))

    assert initiatives[0]["source_identity"] == source_identity


def test_cli_runtime_refreshes_a_new_workspace_identity(tmp_path, monkeypatch):
    monkeypatch.setenv("KF_CONFIG_HOME", str(tmp_path / "config"))
    identity, runtime_dir, receipt = ASSIGNMENT_CLI._runtime(str(tmp_path))

    assert identity.initialized is True
    assert identity.identity_state == "qualified"
    assert identity.identity_root == receipt["workspace_identity_root"]
    assert Path(runtime_dir).is_dir()


def test_source_root_recovers_checkout_from_assembled_binding(tmp_path):
    checkout = tmp_path / "kungfu"
    checkout.mkdir()
    (checkout / ".git").write_text("gitdir: /tmp/example\n", encoding="utf-8")
    binding = checkout / "framework" / "core" / "dist" / "kungfu" / "pykungfu.so"
    binding.parent.mkdir(parents=True)
    binding.touch()

    assert assignment_orchestration.source_root(binding) == checkout


@pytest.mark.parametrize(
    ("binding_name", "runtime_entrypoint"),
    (("pykungfu.so", "kungfu"), ("pykungfu.pyd", "kungfu.exe")),
)
def test_binding_provenance_accepts_platform_bound_installed_product(
    tmp_path, monkeypatch, binding_name, runtime_entrypoint
):
    runtime = tmp_path / "installed" / "kungfu"
    runtime.mkdir(parents=True)
    binding = runtime / binding_name
    binding.touch()
    revision = "a" * 40
    build_info = {
        "version": "4.0.0-alpha.1",
        "git": {"revision": revision, "pristine": True},
    }
    (runtime / "kungfubuildinfo.json").write_text(
        json.dumps(build_info), encoding="utf-8"
    )
    manifest = {
        "schema": "kungfu.product-upgrade.manifest/v1",
        "sourceCommit": revision,
        "runtimeEntrypoint": runtime_entrypoint,
        "runtimeArtifactDigest": "sha256:" + "b" * 64,
    }
    manifest_path = tmp_path / "kungfu-release-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(kungfu, "_binding", SimpleNamespace(__file__=str(binding)))
    monkeypatch.setenv("KUNGFU_INSTALL_SOURCE", "archive")
    monkeypatch.setenv("KUNGFU_DIR", str(runtime))
    monkeypatch.setenv("KUNGFU_UPGRADE_MANIFEST", str(manifest_path))

    provenance = assignment_orchestration.binding_provenance()

    assert provenance["ok"] is True
    assert provenance["state"] == "installed-product"
    assert provenance["source_revision"] == revision
    assert provenance["override"] is False


def test_binding_provenance_rejects_platform_mismatched_manifest_entrypoint(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "installed" / "kungfu"
    runtime.mkdir(parents=True)
    binding = runtime / "pykungfu.pyd"
    binding.touch()
    revision = "a" * 40
    (runtime / "kungfubuildinfo.json").write_text(
        json.dumps(
            {
                "version": "4.0.0-alpha.1",
                "git": {"revision": revision, "pristine": True},
            }
        ),
        encoding="utf-8",
    )
    manifest_path = tmp_path / "kungfu-release-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema": "kungfu.product-upgrade.manifest/v1",
                "sourceCommit": revision,
                "runtimeEntrypoint": "kungfu",
                "runtimeArtifactDigest": "sha256:" + "b" * 64,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(kungfu, "_binding", SimpleNamespace(__file__=str(binding)))
    monkeypatch.setenv("KUNGFU_INSTALL_SOURCE", "archive")
    monkeypatch.setenv("KUNGFU_DIR", str(runtime))
    monkeypatch.setenv("KUNGFU_UPGRADE_MANIFEST", str(manifest_path))

    provenance = assignment_orchestration.binding_provenance()

    assert provenance["ok"] is False
    assert provenance["state"] == "degraded"


def test_installed_runtime_accepts_a_filesystem_alias_root(monkeypatch):
    binding = Path("/canonical/runtime/pykungfu.pyd")
    runtime_alias = Path("/short/runtime")

    def samefile(candidate, other):
        return candidate == binding.parent and other == runtime_alias

    monkeypatch.setattr(Path, "samefile", samefile)

    assert assignment_orchestration._same_or_descendant(binding, runtime_alias)


def test_installed_capture_matches_source_contract_without_runtime(tmp_path):
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "assignment-request"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {"assignment_id": "installed-capture"},
    }
    target = resolve_workspace_target(
        "capture-only", str(tmp_path), cwd=str(tmp_path), env={"HOME": str(tmp_path)}
    )

    response = assignment_orchestration.capture_assignment_request(request, target)

    assert response["schema"] == "kungfu.assignment-capture.response/v1"
    assert response["status"] == "captured"
    assert response["authority"] == "capture-material-only"
    assert response["target"]["runtimeInitialized"] is False
    assert not (tmp_path / ".kungfu" / "runtime").exists()
    captured = assignment_orchestration.load_captured_request(response["requestPath"])
    assert captured["request_root"] == response["requestRoot"]
    assert captured["capture_receipt_roots"] == [response["receiptRoot"]]
    assert (
        assignment_orchestration.capture_assignment_request(request, target)["status"]
        == "already-present"
    )


def test_family_initiative_child_parent_stays_advisory_at_assignment_admission():
    work_definition = {
        "assignment_id": "family-child",
        "initiative_id": "family-initiative",
        "parent_assignment_id": "family-initiative",
        "depends_on": ["prior-child"],
        "hierarchy": {
            "role": "initiative-child",
            "parent_assignment_id": "family-initiative",
        },
        "objective": "Admit the child without inventing a local parent Assignment",
    }
    captured = {
        "request": {
            "source": {"kind": "kungfu-assignment-family-child"},
            "workDefinition": work_definition,
        },
        "request_root": "sha256:" + "a" * 64,
        "capture_receipt_roots": ["sha256:" + "b" * 64],
    }

    projected = assignment_orchestration.assignment_projection(captured)

    assert projected["parent_assignment_id"] == ""
    assert projected["parent_assignment_ref"] == {}
    assert projected["depends_on"] == ["prior-child"]
    assert projected["work_definition"] == work_definition


def test_captured_request_admits_losslessly_and_drives_bounded_execution(tmp_path):
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "assignment-request"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "assignment_id": "assignment-a",
            "initiative_id": "initiative-a",
            "title": "Assignment A",
            "objective": "Prove the native state machine",
            "parent_assignment_id": "parent-assignment",
            "context_binding": {"root": "sha256:" + "c" * 64},
            "project_cut_root": "sha256:" + "d" * 64,
            "evidence_episode_roots": ["sha256:" + "e" * 64],
            "unknown_source_field": {"must": "survive"},
        },
    }
    request_root = assignment_canonical.semantic_root(request)
    directory = (
        tmp_path
        / ".kungfu"
        / "inbox"
        / "assignment-requests"
        / "sha256"
        / request_root[7:9]
        / request_root[7:]
    )
    directory.mkdir(parents=True)
    request_file = directory / "request.json"
    request_file.write_text(
        assignment_canonical.canonical_json(request) + "\n", encoding="utf-8"
    )
    receipt = {
        "schema": "kungfu.assignment-capture.receipt/v1",
        "requestRoot": request_root,
        "requestPath": "inbox/example/request.json",
    }
    receipt_root = assignment_canonical.semantic_root(receipt)
    receipt["receiptRoot"] = receipt_root
    receipt_dir = directory / "receipts" / "sha256"
    receipt_dir.mkdir(parents=True)
    (receipt_dir / f"{receipt_root[7:]}.json").write_text(
        assignment_canonical.canonical_json(receipt) + "\n", encoding="utf-8"
    )

    captured = assignment_orchestration.load_captured_request(request_file)
    projected = assignment_orchestration.assignment_projection(
        captured,
        initiative_id="initiative-a",
        initiative_admission=_initiative_admission(),
    )
    assert projected["work_definition"] == request["workDefinition"]
    assert projected["parent_assignment_id"] == "parent-assignment"
    assert projected["context_binding"] == request["workDefinition"]["context_binding"]
    assert projected["project_cut_root"] == "sha256:" + "d" * 64
    assert projected["evidence_episode_roots"] == ["sha256:" + "e" * 64]

    runtime = tmp_path / ".kungfu" / "runtime"
    _activate(runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative-a",
        title="Initiative A",
        intent="Own the control plane",
        actor="owner-a",
        actor_type="user",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        title=projected["title"],
        objective=projected["objective"],
        actor="agent-a",
        request_root=request_root,
        capture_receipt_roots=[receipt_root],
        work_definition=projected["work_definition"],
    )
    status = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert status["phase"] == "admitted"
    assert status["assignment"]["work_definition"] == request["workDefinition"]

    expiry = datetime.now(timezone.utc) + timedelta(hours=2)
    work_control.claim_assignment_execution(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        owner="owner-a",
        agent="agent-a",
        slot="codex-slot-1",
        lease_id="lease-a",
        lease_expires_at=expiry.isoformat(),
        authorized_by="owner-a",
    )
    claimed = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert claimed["phase"] == "claimed"
    assert claimed["active_lease"]["authority_semantics"]["slot"] == (
        "execution-lane-not-authority"
    )
    assert assignment_orchestration.gate(claimed, "run")["ok"] is True

    work_control.advance_assignment_phase(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        to_phase="executing",
        actor="agent-a",
        reason="begin exact admitted work",
    )
    executing = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert executing["phase"] == "executing"
    work_control.advance_assignment_phase(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        to_phase="stage-ready",
        actor="agent-a",
        reason="bounded stage is ready",
    )
    staged = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert staged["phase"] == "stage-ready"
    expired = work_control.assignment_orchestration_status(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        now=(expiry + timedelta(seconds=1)).isoformat(),
    )
    assert assignment_orchestration.gate(expired, "run")["ok"] is False


def test_work_resume_prepare_rebinds_stale_profile_without_losing_assignment(
    tmp_path,
    monkeypatch,
):
    source = tmp_path / "work-control"
    shutil.copytree(
        SOURCE,
        source,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"),
    )
    shutil.copytree(
        SOURCE.parent / "work-dashboard",
        source / "node_modules" / "@kungfu-tech" / "kfx-view-work-dashboard",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"),
    )
    runtime = tmp_path / ".kungfu" / "runtime"
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime,
            action,
            source,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime, plan, f"test:{action}")
    contract = profile_composition.contract_materialization_plan(source, runtime)
    if contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"],
                "approve",
                "test-owner",
            ),
        )
    work_control.create_initiative(
        str(runtime),
        initiative_id="retained-project",
        title="Retained Project",
        intent="Keep Work readable across a product Profile upgrade",
        actor="local-user",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="retained-project",
        assignment_id="retained-assignment",
        title="Retained Assignment",
        objective="Resume the exact retained Work after upgrade",
        actor="local-user",
    )
    previous_root = profile_sdk.validate_source(source, runtime)["inspection"][
        "profile_suite_root"
    ]
    adapter = source / "work-control-actions" / "adapter.py"
    adapter.write_text(
        adapter.read_text(encoding="utf-8")
        + "\n# Product-upgrade regression source root.\n",
        encoding="utf-8",
    )
    desired_root = profile_sdk.validate_source(source, runtime)["inspection"][
        "profile_suite_root"
    ]
    assert desired_root != previous_root
    monkeypatch.setattr(ASSIGNMENT_CLI, "profile_source", lambda: source)

    with pytest.raises(
        profile_sdk.ProfileSdkError,
        match="active exact Profile root",
    ):
        ASSIGNMENT_CLI._status(
            runtime,
            "retained-project",
            "retained-assignment",
        )

    prepared = ASSIGNMENT_CLI._prepare_resume_profile(
        runtime,
        "kungfu-product-project-resume",
    )

    assert prepared["status"] == "reconciled"
    assert prepared["previousProfileSuiteRoot"] == previous_root
    assert prepared["profileSuiteRoot"] == desired_root
    assert prepared["profileLifecycleReceiptCount"] >= 3
    assert prepared["writeOccurred"] is True
    status = ASSIGNMENT_CLI._status(
        runtime,
        "retained-project",
        "retained-assignment",
    )
    assert status["phase"] == "admitted"
    assert status["assignment"]["assignment_id"] == "retained-assignment"

    repeated = ASSIGNMENT_CLI._prepare_resume_profile(
        runtime,
        "kungfu-product-project-resume",
    )
    assert repeated["status"] == "ready"
    assert repeated["profileLifecycleReceiptCount"] == 0
    assert repeated["writeOccurred"] is False


@pytest.mark.parametrize("action", ["reopen", "request-evidence"])
def test_nonterminal_continuation_decision_starts_a_new_completion_cycle(
    tmp_path, action
):
    runtime = tmp_path / ".kungfu" / "runtime"
    _activate(runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative-a",
        title="Initiative A",
        intent="Keep failed review cycles open",
        actor="owner-a",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        title="Assignment A",
        objective="Require a new claim after a nonterminal decision",
        actor="agent-a",
    )
    first_claim = work_control.claim_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        statement="The first claim is intentionally missing independent evidence",
        actor="agent-a",
    )
    first_review = work_control.review_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        reviewer="reviewer-a",
        reviewer_source="independent-session-a",
    )
    assert action in first_review["review"]["continuation_plan"]["allowed_actions"]

    work_control.decide_continuation(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        review_id=first_review["review"]["review_id"],
        expected_review_root=first_review["review_root"],
        expected_plan_root=first_review["continuation_plan_root"],
        action=action,
        actor="agent-b",
        reason="return the Assignment to an evidence-bearing completion cycle",
    )
    reopened = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert reopened["phase"] == "stage-ready"
    assert assignment_orchestration.gate(reopened, "closeout")["ok"] is False
    assert assignment_orchestration.next_actions(reopened)[0]["action"] == (
        "claim-completion"
    )

    second_claim = work_control.claim_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        statement="A later claim begins a new completion cycle",
        actor="agent-a",
    )
    assert second_claim["claim"]["claim_id"] != first_claim["claim"]["claim_id"]
    claimed = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert claimed["phase"] == "completion-claimed"
    second_review = work_control.review_completion(
        str(runtime),
        initiative_id="initiative-a",
        assignment_id="assignment-a",
        reviewer="reviewer-a",
        reviewer_source="independent-session-a",
    )
    reviewed = work_control.assignment_orchestration_status(
        str(runtime), initiative_id="initiative-a", assignment_id="assignment-a"
    )
    assert reviewed["phase"] == "independently-reviewed"
    assert reviewed["completion_claim_count"] == 2
    assert reviewed["independent_review_count"] == 2
    assert second_review["review"]["claim_id"] == second_claim["claim"]["claim_id"]


def test_gate_field_equivalence_and_runtime_independent_seal(tmp_path):
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": "assignment-a",
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
        "execution_claims": [{}],
        "phase_transitions": [{}, {}],
        "completion_claim_count": 1,
        "independent_review_count": 1,
        "continuation_decision_count": 1,
    }
    closed = assignment_orchestration.gate(status, "closeout")
    assert "atlas_compatibility" not in closed
    assert closed["ok"] is True

    runtime = tmp_path / ".kungfu" / "runtime"
    runtime.mkdir(parents=True)
    plan = assignment_orchestration.sealed_state_plan(tmp_path, status)
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])
    shutil.rmtree(runtime)
    verified = assignment_orchestration.verify_sealed_state(state_file)
    assert verified == {
        "schema": "kungfu.assignment-orchestration.seal-verification/v1",
        "ok": True,
        "state_root": plan["state_root"],
        "phase": "continuation-decided",
        "next_actions": [],
    }


def test_sealed_state_survives_git_worktree_deletion(tmp_path):
    common = tmp_path / "repo.git"
    administration = common / "worktrees" / "assignment"
    administration.mkdir(parents=True)
    (administration / "commondir").write_text("../..\n", encoding="utf-8")
    workspace = tmp_path / "worktree"
    workspace.mkdir()
    (workspace / ".git").write_text(f"gitdir: {administration}\n", encoding="utf-8")
    status = {
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
    }

    plan = assignment_orchestration.sealed_state_plan(workspace, status)
    assert plan["storage_kind"] == "git-common-dir"
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])
    assert common in state_file.parents
    shutil.rmtree(workspace)

    assert receipt["worktreeDeletionSafe"] is True
    assert assignment_orchestration.verify_sealed_state(state_file)["ok"] is True


def test_sealed_state_index_retains_exact_work_coordinate(tmp_path):
    common = tmp_path / "repo.git"
    administration = common / "worktrees" / "assignment-index"
    administration.mkdir(parents=True)
    (administration / "commondir").write_text("../..\n", encoding="utf-8")
    workspace = tmp_path / "worktree"
    workspace.mkdir()
    (workspace / ".git").write_text(f"gitdir: {administration}\n", encoding="utf-8")
    owning_root = "sha256:" + "b" * 64
    status = {
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {
            "assignment_id": "assignment-a",
            "owning_workspace_identity_root": owning_root,
        },
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
    }
    plan = assignment_orchestration.sealed_state_plan(workspace, status)
    assignment_orchestration.apply_sealed_state(plan, plan["state_root"])

    index = assignment_orchestration.list_sealed_assignment_states(workspace)

    assert index["issues"] == []
    assert index["writes"] == []
    assert index["index_root"].startswith("sha256:")
    assert index["states"] == [
        {
            "schema": "kungfu.assignment-orchestration.sealed-work-coordinate/v1",
            "assignment_subject": "kungfu:assignment-a",
            "workspace_identity_root": owning_root,
            "assignment_state_root": assignment_canonical.semantic_root(
                {
                    "schema": "kungfu.assignment-orchestration.retained-assignment-state/v1",
                    "workspace": {},
                    "initiative_subject": status["initiative_subject"],
                    "assignment_subject": status["assignment_subject"],
                    "assignment": status["assignment"],
                    "phase": status["phase"],
                    "active_lease": status["active_lease"],
                    "event_counts": plan["snapshot"]["counts"],
                }
            ),
            "event_counts": plan["snapshot"]["counts"],
            "state_root": plan["state_root"],
            "query_proof_root": status["query_proof_root"],
            "phase": "continuation-decided",
            "settled": True,
            "storage_kind": "git-common-dir",
        }
    ]


def test_assignment_relation_handshake_is_workspace_routed_and_fact_backed(
    tmp_path,
):
    source_root = tmp_path / "source"
    destination_root = tmp_path / "destination"
    source_root.mkdir()
    destination_root.mkdir()
    source_candidate = inspect_workspace(str(source_root), env={"HOME": str(tmp_path)})
    destination_candidate = inspect_workspace(
        str(destination_root), env={"HOME": str(tmp_path)}
    )
    assert source_candidate is not None
    assert destination_candidate is not None
    ensure_workspace_data_home(source_candidate, "create-assignment")
    ensure_workspace_data_home(destination_candidate, "create-assignment")
    source_identity = inspect_workspace(str(source_root), env={"HOME": str(tmp_path)})
    destination_identity = inspect_workspace(
        str(destination_root), env={"HOME": str(tmp_path)}
    )
    assert source_identity is not None
    assert destination_identity is not None
    source_runtime = source_root / ".kungfu" / "runtime"
    destination_runtime = destination_root / ".kungfu" / "runtime"
    _activate(source_runtime)
    _activate(destination_runtime)
    source_ref = build_work_ref(
        source_identity,
        object_kind="assignment",
        subject="kungfu:parent",
        version_root="sha256:" + "a" * 64,
        cut_root="sha256:" + "b" * 64,
    )
    destination_ref = build_work_ref(
        destination_identity,
        object_kind="assignment",
        subject="kungfu:child",
        version_root="sha256:" + "c" * 64,
        cut_root="sha256:" + "d" * 64,
    )
    relation = build_relation("delegates-to", source_ref, destination_ref)

    offer = work_control.append_assignment_relation_event(
        str(source_runtime),
        workspace_identity_root=source_identity.identity_root,
        relation=relation,
        event_type="delegation-offer",
        actor="source-agent",
    )
    assert offer["next_action"] == "destination-acceptance"
    assert work_control.assignment_relations(str(source_runtime)) == [relation]
    other_ref = build_work_ref(
        source_identity,
        object_kind="assignment",
        subject="kungfu:other",
        version_root="sha256:" + "e" * 64,
        cut_root="sha256:" + "f" * 64,
    )
    other_relation = build_relation("delegates-to", source_ref, other_ref)
    repeated = work_control.append_assignment_relation_event(
        str(source_runtime),
        workspace_identity_root=source_identity.identity_root,
        relation=relation,
        event_type="delegation-offer",
        actor="source-agent",
        known_relations=[relation, other_relation],
    )
    assert repeated["event"]["event_root"] == offer["event"]["event_root"]
    assert repeated["receipt"]["reused"] is True

    related = query_federation(
        source_identity,
        scope="related",
        config_home=source_identity.config_home,
        env={"HOME": str(tmp_path)},
    )
    assert {row["workspace"]["identity_root"] for row in related["components"]} == {
        source_identity.identity_root,
        destination_identity.identity_root,
    }

    with pytest.raises(ValueError, match="wrong owning workspace"):
        work_control.append_assignment_relation_event(
            str(source_runtime),
            workspace_identity_root=source_identity.identity_root,
            relation=relation,
            event_type="destination-acceptance",
            actor="wrong-agent",
            predecessor_event_roots=[offer["event"]["event_root"]],
        )

    accepted = work_control.append_assignment_relation_event(
        str(destination_runtime),
        workspace_identity_root=destination_identity.identity_root,
        relation=relation,
        event_type="destination-acceptance",
        actor="destination-agent",
        predecessor_event_roots=[offer["event"]["event_root"]],
    )
    assert accepted["next_action"] == "source-observation"
    assert accepted["event"]["predecessor_event_roots"] == [
        offer["event"]["event_root"]
    ]


def test_external_initiative_ref_owns_no_duplicate_project_initiative(tmp_path):
    env = {"HOME": str(tmp_path)}
    home = inspect_workspace(home=True, env=env)
    assert home is not None
    ensure_workspace_data_home(home, "create-initiative")
    home_runtime = tmp_path / ".kungfu" / "runtime"
    _activate(home_runtime)
    work_control.create_initiative(
        str(home_runtime),
        initiative_id="portfolio",
        title="Portfolio",
        intent="Coordinate independent projects",
        actor="owner",
    )
    home_work = query_federation(
        home,
        scope="local",
        config_home=home.config_home,
        env=env,
    )
    initiative_ref = home_work["components"][0]["initiatives"][0]["work_ref"]

    project_refs = []
    project_identities = []
    for name in ("typescript-project", "python-project"):
        root = tmp_path / name
        root.mkdir()
        if name == "typescript-project":
            (root / "package.json").write_text(
                '{"name":"workspace-federation-typescript-fixture"}\n',
                encoding="utf-8",
            )
        else:
            (root / "pyproject.toml").write_text(
                '[project]\nname = "workspace-federation-python-fixture"\n',
                encoding="utf-8",
            )
        candidate = inspect_workspace(str(root), env=env)
        assert candidate is not None
        ensure_workspace_data_home(candidate, "create-assignment")
        identity = inspect_workspace(str(root), env=env)
        assert identity is not None
        project_identities.append(identity)
        runtime = root / ".kungfu" / "runtime"
        _activate(runtime)
        written = work_control.create_assignment(
            str(runtime),
            initiative_id="portfolio",
            assignment_id="duplicate-local-id",
            title=f"Work in {name}",
            objective="Prove workspace-qualified duplicate IDs",
            actor="agent",
            storage_source_id="kungfu",
            owning_workspace_identity_root=identity.identity_root,
            initiative_ref=initiative_ref,
        )
        assert written["initiative_subject"] == initiative_ref["subject"]
        assert work_control.list_initiatives(str(runtime)) == []
        status = work_control.assignment_orchestration_status(
            str(runtime),
            initiative_id="portfolio",
            assignment_id="duplicate-local-id",
            storage_source_id="kungfu",
        )
        assert status["phase"] == "admitted"
        project_work = query_federation(
            identity,
            scope="local",
            config_home=identity.config_home,
            env=env,
        )
        assert (
            project_work["components"][0]["assignments"][0]["lifecycle"][
                "portfolio_state"
            ]
            == "open"
        )
        project_refs.append(project_work["components"][0]["assignments"][0]["work_ref"])

    assert project_refs[0]["subject"] == project_refs[1]["subject"]
    assert (
        project_refs[0]["workspace_identity_root"]
        != project_refs[1]["workspace_identity_root"]
    )
    all_work = query_federation(
        home,
        scope="all",
        config_home=home.config_home,
        env=env,
    )
    assert {row["workspace"]["identity_root"] for row in all_work["components"]} == {
        home.identity_root,
        project_identities[0].identity_root,
        project_identities[1].identity_root,
    }
    assert all(row["availability"] == "available" for row in all_work["components"])


def test_local_parent_shorthand_is_frozen_as_workspace_qualified_ref(tmp_path):
    env = {"HOME": str(tmp_path)}
    root = tmp_path / "project"
    root.mkdir()
    candidate = inspect_workspace(str(root), env=env)
    assert candidate is not None
    ensure_workspace_data_home(candidate, "create-assignment")
    identity = inspect_workspace(str(root), env=env)
    assert identity is not None
    runtime = root / ".kungfu" / "runtime"
    _activate(runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative",
        title="Initiative",
        intent="Resolve local shorthand before admission",
        actor="owner",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative",
        assignment_id="parent",
        title="Parent",
        objective="Own parent authority",
        actor="owner",
        storage_source_id="kungfu",
        owning_workspace_identity_root=identity.identity_root,
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative",
        assignment_id="child",
        title="Child",
        objective="Freeze exact parent WorkRef",
        actor="agent",
        storage_source_id="kungfu",
        owning_workspace_identity_root=identity.identity_root,
        parent_assignment_id="parent",
    )
    child = next(
        row
        for row in work_control.list_assignments(str(runtime))
        if row["assignment_id"] == "child"
    )
    assert child["parent_assignment_id"] == ""
    assert child["parent_assignment_ref"]["workspace_identity_root"] == (
        identity.identity_root
    )
    assert child["parent_assignment_ref"]["subject"] == "kungfu:parent"

    with pytest.raises(ValueError, match="resolve exactly once"):
        work_control.create_assignment(
            str(runtime),
            initiative_id="initiative",
            assignment_id="bad-child",
            title="Bad child",
            objective="Reject unresolved cross-workspace string",
            actor="agent",
            storage_source_id="kungfu",
            owning_workspace_identity_root=identity.identity_root,
            parent_assignment_id="not-local",
        )


def test_unresolved_dependency_shorthand_remains_visible_without_fake_work_ref(
    tmp_path,
):
    env = {"HOME": str(tmp_path)}
    root = tmp_path / "project"
    root.mkdir()
    candidate = inspect_workspace(str(root), env=env)
    assert candidate is not None
    ensure_workspace_data_home(candidate, "create-assignment")
    identity = inspect_workspace(str(root), env=env)
    assert identity is not None
    runtime = root / ".kungfu" / "runtime"
    _activate(runtime)
    work_control.create_initiative(
        str(runtime),
        initiative_id="initiative",
        title="Initiative",
        intent="Keep unavailable dependencies explicit",
        actor="owner",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id="initiative",
        assignment_id="current",
        title="Current",
        objective="Expose unresolved cross-workspace dependency",
        actor="agent",
        storage_source_id="kungfu",
        owning_workspace_identity_root=identity.identity_root,
        depends_on=["historical-assignment"],
    )

    current = next(
        row
        for row in work_control.list_assignments(str(runtime))
        if row["assignment_id"] == "current"
    )
    assert current["depends_on"] == []
    assert current["dependency_refs"] == []
    assert current["unresolved_dependency_ids"] == ["historical-assignment"]

    result = query_federation(
        identity,
        scope="local",
        config_home=identity.config_home,
        env=env,
    )
    component = result["components"][0]
    assert component["problems"] == [
        {
            "code": "unresolved-assignment-dependency",
            "assignment_subject": "kungfu:current",
            "dependency_id": "historical-assignment",
        }
    ]
    assert result["proof"]["unresolved_references"] == [
        {
            "kind": "legacy-assignment-dependency",
            "code": "missing-reference",
            "workspace_identity_root": identity.identity_root,
            "assignment_subject": "kungfu:current",
            "dependency_id": "historical-assignment",
            "dependency_subject": "kungfu:historical-assignment",
            "candidate_canonical_roots": [],
            "candidate_sealed_state_roots": [],
            "candidate_unqualified_state_roots": [],
            "next_action": "register the dependency authority",
        }
    ]


def test_sealed_state_verification_survives_path_free_transfer(tmp_path):
    status = {
        "initiative_subject": "kungfu:initiative-a",
        "assignment_subject": "kungfu:assignment-a",
        "assignment": {"assignment_id": "assignment-a"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "a" * 64,
    }
    source = tmp_path / "source"
    source.mkdir()
    plan = assignment_orchestration.sealed_state_plan(source, status)
    receipt = assignment_orchestration.apply_sealed_state(plan, plan["state_root"])
    state_file = Path(receipt["statePath"])

    transferred = tmp_path / "transferred"
    transferred.mkdir()
    transferred_state = transferred / "state.json"
    shutil.copy2(state_file, transferred_state)
    shutil.copy2(state_file.with_name("receipt.json"), transferred / "receipt.json")

    assert assignment_orchestration.verify_sealed_state(transferred_state)["ok"] is True
    tampered = json.loads(transferred_state.read_text(encoding="utf-8"))
    tampered["phase"] = "tampered"
    transferred_state.write_text(json.dumps(tampered), encoding="utf-8")
    assert (
        assignment_orchestration.verify_sealed_state(transferred_state)["ok"] is False
    )


def test_home_sealed_state_uses_home_storage_without_embedding_its_path(tmp_path):
    home = tmp_path / ".kungfu"
    status = {
        "initiative_subject": "kungfu:initiative-home",
        "assignment_subject": "kungfu:assignment-home",
        "assignment": {"assignment_id": "assignment-home"},
        "phase": "continuation-decided",
        "active_lease": None,
        "query_proof_root": "sha256:" + "d" * 64,
    }
    plan = assignment_orchestration.sealed_state_plan(
        home,
        status,
        workspace_identity={"workspace_id": "home", "workspace_kind": "home"},
    )

    assert plan["storage_kind"] == "home-workspace"
    assert plan["storage_root"] == str(home)
    assert plan["snapshot"]["workspace"] == {
        "workspace_id": "home",
        "workspace_kind": "home",
    }
    assert str(home) not in assignment_canonical.canonical_json(plan["snapshot"])


def _binding_endpoint_fixture(workspace_id, workspace_kind, assignment_id, marker):
    digits = [format(int(marker, 16) + offset, "x") for offset in range(4)]
    admission = {
        "workspace": {
            "workspace_id": workspace_id,
            "workspace_kind": workspace_kind,
        },
        "assignment_receipt": {"receipt": {"payload_hash": "sha256:" + digits[0] * 64}},
    }
    status = {
        "initiative_id": "initiative-a",
        "assignment_id": assignment_id,
        "query_proof_root": "sha256:" + digits[1] * 64,
        "assignment": {
            "request_root": "sha256:" + digits[2] * 64,
            "capture_receipt_roots": ["sha256:" + digits[3] * 64],
            "project_cut_root": "",
            "evidence_episode_roots": [],
        },
    }
    return admission, status


def test_cross_workspace_binding_has_two_local_receipts_and_verifies_offline(tmp_path):
    parent_admission, parent_status = _binding_endpoint_fixture(
        "home", "home", "parent-assignment", "1"
    )
    child_admission, child_status = _binding_endpoint_fixture(
        "project:child", "project", "child-assignment", "8"
    )
    binding = assignment_orchestration.cross_workspace_binding(
        parent_admission,
        parent_status,
        child_admission,
        child_status,
    )
    assert binding["relationshipType"] == "parent-child"
    assert "path" not in assignment_canonical.canonical_json(binding).lower()

    home = tmp_path / "home" / ".kungfu"
    parent_plan = assignment_orchestration.cross_workspace_binding_plan(
        home,
        {"workspace_id": "home", "workspace_kind": "home"},
        parent_status,
        binding,
    )
    parent_receipt = assignment_orchestration.apply_cross_workspace_binding(
        parent_plan, binding, binding["bindingRoot"]
    )
    child = tmp_path / "child"
    child.mkdir()
    child_plan = assignment_orchestration.cross_workspace_binding_plan(
        child,
        {"workspace_id": "project:child", "workspace_kind": "project"},
        child_status,
        binding,
    )
    child_receipt = assignment_orchestration.apply_cross_workspace_binding(
        child_plan, binding, binding["bindingRoot"]
    )

    assert parent_receipt["localRole"] == "parent"
    assert child_receipt["localRole"] == "child"
    verification = assignment_orchestration.verify_cross_workspace_binding_receipt(
        parent_receipt["bindingPath"], parent_receipt["receiptPath"]
    )
    assert verification["ok"] is True
    assert verification["runtimeIndependent"] is True

    tampered = dict(binding)
    tampered["relationshipType"] = "string-parent-id"
    with pytest.raises(ValueError, match="contract mismatch"):
        assignment_orchestration.verify_cross_workspace_binding(tampered)
