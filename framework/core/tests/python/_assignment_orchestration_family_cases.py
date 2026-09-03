# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _assignment_orchestration_support import *


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
