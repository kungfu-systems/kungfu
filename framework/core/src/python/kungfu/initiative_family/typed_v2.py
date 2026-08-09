# SPDX-License-Identifier: Apache-2.0

"""Typed v2 envelope owner for Initiative-family orchestration."""

from __future__ import annotations

import json
from typing import Any, Mapping, Protocol, cast

from kungfu import initiative_family
from kungfu.initiative_family.canonical import (
    _root,
    _strict_object,
    _timestamp,
    canonical_json,
    semantic_root,
)

FAMILY_CONTRACT_V2_SCHEMA = "kungfu.work-control.initiative-family-contract/v2"
FAMILY_STATE_V2_SCHEMA = "kungfu.work-control.initiative-family-state/v2"
FAMILY_TRANSITION_V2_SCHEMA = "kungfu.work-control.initiative-family-transition/v2"
FAMILY_BINDING_V2_SCHEMA = (
    "kungfu.work-control.initiative-family-typed-binding-manifest/v2"
)
FAMILY_UPGRADE_V2_SCHEMA = "kungfu.work-control.initiative-family-upgrade/v2"
FAMILY_V2_REFERENCE_KINDS = (
    "acceptance-policy",
    "admission-receipt",
    "assessment",
    "assignment-state",
    "completion-claim",
    "decision",
    "delivery-evidence",
    "episode",
    "execution-warrant",
    "atlas",
    "project-cut",
    "publication-failure",
    "pursuit",
    "work-definition",
)


class InitiativeFamilyV1Port(Protocol):
    """Typed dependency seam consumed by the additive v2 envelope."""

    def family_contract(self) -> dict[str, Any]: ...

    def validate_family_state(self, value: Any) -> dict[str, Any]: ...

    def transition_family_state(
        self, current: Any, transition: Any
    ) -> dict[str, Any]: ...

    def verify_family_state(self, value: Any) -> dict[str, Any]: ...


_V1 = cast(InitiativeFamilyV1Port, initiative_family)
family_contract = _V1.family_contract
validate_family_state = _V1.validate_family_state
transition_family_state = _V1.transition_family_state
verify_family_state = _V1.verify_family_state
FAMILY_STATE_SCHEMA = initiative_family.FAMILY_STATE_SCHEMA


def family_contract_v2() -> dict[str, Any]:
    """Return the additive typed-envelope contract without changing v1."""

    body = {
        "schema": FAMILY_CONTRACT_V2_SCHEMA,
        "predecessorContractRoot": family_contract()["contractRoot"],
        "stateSchema": FAMILY_STATE_V2_SCHEMA,
        "transitionSchema": FAMILY_TRANSITION_V2_SCHEMA,
        "typedBindingSchema": FAMILY_BINDING_V2_SCHEMA,
        "upgradeSchema": FAMILY_UPGRADE_V2_SCHEMA,
        "typedReferenceKinds": list(FAMILY_V2_REFERENCE_KINDS),
        "typedReferenceFields": [
            "cutRoot",
            "factWorld",
            "identity",
            "kind",
            "root",
            "schema",
            "status",
        ],
        "authority": {
            "familyState": "coordination-projection-only",
            "initiativeParent": "inert",
            "referencedAuthorities": "retained-by-owner",
            "upgradeBindings": "caller-supplied-no-inference",
        },
        "compatibility": {
            "v1ReaderState": "under-typed",
            "v1Projection": "exact-root-preserving",
            "rewritesExistingRoots": False,
        },
    }
    return {**body, "contractRoot": semantic_root(body)}


def _family_v2_state_root(value: Mapping[str, Any]) -> str:
    preimage = dict(value)
    preimage.pop("stateRoot", None)
    return semantic_root(preimage)


def _family_v2_binding_root(value: Mapping[str, Any]) -> str:
    preimage = dict(value)
    preimage.pop("bindingRoot", None)
    return semantic_root(preimage)


def _validate_family_v2_reference(
    value: Any,
    *,
    expected_kind: str,
    expected_fact_world: str,
    expected_cut_root: str,
    expected_status: str,
    label: str,
) -> dict[str, Any]:
    reference = _strict_object(
        value,
        {"kind", "identity", "root", "factWorld", "cutRoot", "schema", "status"},
        label,
    )
    if reference["kind"] != expected_kind:
        raise ValueError(f"{label}.kind must be {expected_kind}")
    if (
        not isinstance(reference["identity"], str)
        or not reference["identity"]
        or not isinstance(reference["schema"], str)
        or not reference["schema"]
        or not isinstance(reference["status"], str)
        or not reference["status"]
    ):
        raise ValueError(f"{label} identity, schema, and status are required")
    _root(reference["root"], f"{label}.root")
    _root(reference["cutRoot"], f"{label}.cutRoot")
    if reference["factWorld"] != expected_fact_world:
        raise ValueError(f"{label} belongs to the wrong fact world")
    if reference["cutRoot"] != expected_cut_root:
        raise ValueError(f"{label} belongs to the wrong cut")
    if expected_kind == "execution-warrant" and reference["status"] != "active":
        raise ValueError("execution Warrant must be active, not stale or revoked")
    if expected_kind == "admission-receipt" and reference["status"] != "admitted":
        raise ValueError("Admission receipt must record an admitted effect")
    if expected_kind == "publication-failure" and reference["status"] != "visible":
        raise ValueError("publication failure must remain visible")
    if reference["status"] != expected_status:
        raise ValueError(f"{label}.status must be {expected_status}")
    return reference


def _validate_family_v2_optional_reference(
    value: Any,
    *,
    expected_kind: str,
    expected_fact_world: str,
    expected_cut_root: str,
    expected_status: str,
    label: str,
) -> dict[str, Any]:
    optional = _strict_object(value, {"present", "reference"}, label)
    if not isinstance(optional["present"], bool):
        raise ValueError(f"{label}.present must be a boolean")
    if not optional["present"]:
        if optional["reference"] is not None:
            raise ValueError(f"{label} must not hide an undeclared reference")
        return optional
    if optional["reference"] is None:
        raise ValueError(f"{label} declares presence without a reference")
    _validate_family_v2_reference(
        optional["reference"],
        expected_kind=expected_kind,
        expected_fact_world=expected_fact_world,
        expected_cut_root=expected_cut_root,
        expected_status=expected_status,
        label=f"{label}.reference",
    )
    return optional


def _validate_family_v2_settlement(
    value: Any,
    *,
    expected_fact_world: str,
    expected_cut_root: str,
    label: str,
) -> dict[str, Any]:
    settlement = _strict_object(
        value,
        {"factWorld", "factCutRoot", "references", "publication"},
        label,
    )
    fact_world = settlement["factWorld"]
    if not isinstance(fact_world, str) or not fact_world:
        raise ValueError(f"{label}.factWorld must be a non-empty string")
    fact_cut_root = _root(settlement["factCutRoot"], f"{label}.factCutRoot")
    if fact_world != expected_fact_world:
        raise ValueError(f"{label}.factWorld does not match the family binding")
    if fact_cut_root != expected_cut_root:
        raise ValueError(f"{label}.factCutRoot does not match the family binding")
    references = _strict_object(
        settlement["references"],
        {
            "completionClaim",
            "assessment",
            "decision",
            "admissionReceipt",
            "episode",
            "projectCut",
            "deliveryEvidence",
        },
        f"{label}.references",
    )
    reference_contracts = {
        "completionClaim": ("completion-claim", "claimed-complete"),
        "assessment": ("assessment", "fit"),
        "decision": ("decision", "accepted"),
        "admissionReceipt": ("admission-receipt", "admitted"),
        "episode": ("episode", "sealed"),
        "projectCut": ("project-cut", "settled"),
        "deliveryEvidence": ("delivery-evidence", "verified"),
    }
    for field, (kind, status) in reference_contracts.items():
        _validate_family_v2_reference(
            references[field],
            expected_kind=kind,
            expected_fact_world=fact_world,
            expected_cut_root=fact_cut_root,
            expected_status=status,
            label=f"{label}.references.{field}",
        )

    publication = _strict_object(
        settlement["publication"],
        {"state", "lagStartedAt", "failure"},
        f"{label}.publication",
    )
    publication_state = publication["state"]
    if publication_state not in {"published", "pending", "failed"}:
        raise ValueError(f"{label}.publication.state is unsupported")
    lag_started_at = publication["lagStartedAt"]
    if publication_state == "published":
        if lag_started_at is not None:
            raise ValueError("published settlement cannot retain publication lag")
    else:
        _timestamp(lag_started_at, f"{label}.publication.lagStartedAt")
    failure = _validate_family_v2_optional_reference(
        publication["failure"],
        expected_kind="publication-failure",
        expected_fact_world=fact_world,
        expected_cut_root=fact_cut_root,
        expected_status="visible",
        label=f"{label}.publication.failure",
    )
    if failure["present"] != (publication_state == "failed"):
        raise ValueError("publication failure visibility does not match its state")
    return settlement


def validate_family_binding_v2(
    value: Any, v1_state: Mapping[str, Any]
) -> dict[str, Any]:
    """Validate caller-supplied semantic bindings against one exact v1 state."""

    projection = validate_family_state(v1_state)
    manifest = _strict_object(
        value,
        {
            "schema",
            "v1StateRoot",
            "factWorld",
            "factCutRoot",
            "initiative",
            "children",
            "bindingRoot",
        },
        "Initiative-family typed binding manifest",
    )
    if manifest["schema"] != FAMILY_BINDING_V2_SCHEMA:
        raise ValueError(f"typed binding schema must be {FAMILY_BINDING_V2_SCHEMA}")
    if manifest["v1StateRoot"] != projection["stateRoot"]:
        raise ValueError("typed binding names the wrong v1 predecessor state")
    fact_world = manifest["factWorld"]
    if not isinstance(fact_world, str) or not fact_world:
        raise ValueError("typed binding factWorld must be a non-empty string")
    fact_cut_root = _root(manifest["factCutRoot"], "typed binding factCutRoot")

    initiative = _strict_object(
        manifest["initiative"],
        {"initiativeId", "pursuit", "atlas", "acceptancePolicy"},
        "typed binding initiative",
    )
    if initiative["initiativeId"] != projection["initiative"]["initiativeId"]:
        raise ValueError("typed binding Initiative identity does not match v1")
    for field, kind, status in (
        ("pursuit", "pursuit", "active"),
        ("atlas", "atlas", "current"),
        ("acceptancePolicy", "acceptance-policy", "current"),
    ):
        _validate_family_v2_reference(
            initiative[field],
            expected_kind=kind,
            expected_fact_world=fact_world,
            expected_cut_root=fact_cut_root,
            expected_status=status,
            label=f"typed binding initiative.{field}",
        )

    children = manifest["children"]
    if not isinstance(children, list):
        raise ValueError("typed binding children must be an array")
    projected_children = {
        child["assignmentId"]: child for child in projection["children"]
    }
    child_ids: list[str] = []
    for child in children:
        bound = _strict_object(
            child,
            {
                "assignmentId",
                "assignmentState",
                "workDefinition",
                "pursuit",
                "atlas",
                "executionWarrant",
                "settlement",
            },
            "typed binding child",
        )
        assignment_id = bound["assignmentId"]
        child_ids.append(assignment_id)
        if assignment_id not in projected_children:
            raise ValueError(f"typed binding names an orphan child: {assignment_id}")
        projected = projected_children[assignment_id]
        reference_contracts = {
            "assignmentState": (
                "assignment-state",
                "terminal" if projected["terminal"] is not None else "active",
            ),
            "workDefinition": ("work-definition", "accepted"),
            "pursuit": ("pursuit", "active"),
            "atlas": ("atlas", "current"),
            "executionWarrant": ("execution-warrant", "active"),
        }
        for field, (kind, status) in reference_contracts.items():
            _validate_family_v2_reference(
                bound[field],
                expected_kind=kind,
                expected_fact_world=fact_world,
                expected_cut_root=fact_cut_root,
                expected_status=status,
                label=f"typed binding child.{assignment_id}.{field}",
            )
        if bound["assignmentState"]["identity"] != assignment_id:
            raise ValueError("Assignment-state reference identity does not match child")
        if bound["workDefinition"]["identity"] != f"{assignment_id}:work-definition":
            raise ValueError("work-definition reference identity does not match child")
        if bound["workDefinition"]["root"] != projected["workDefinitionRoot"]:
            raise ValueError("work-definition reference root does not match v1")

        optional = _strict_object(
            bound["settlement"], {"present", "value"}, "typed binding settlement"
        )
        if not isinstance(optional["present"], bool):
            raise ValueError("typed binding settlement.present must be a boolean")
        terminal_state = (projected["terminal"] or {}).get("state")
        if optional["present"] != (terminal_state == "merged"):
            raise ValueError(
                "typed settlement presence must exactly match a merged terminal child"
            )
        if optional["present"]:
            if optional["value"] is None:
                raise ValueError("typed settlement declares presence without a value")
            _validate_family_v2_settlement(
                optional["value"],
                expected_fact_world=fact_world,
                expected_cut_root=fact_cut_root,
                label=f"typed binding child.{assignment_id}.settlement",
            )
        elif optional["value"] is not None:
            raise ValueError("absent typed settlement must not hide a value")

    expected_ids = [child["assignmentId"] for child in projection["children"]]
    if child_ids != expected_ids:
        raise ValueError(
            "typed binding children must exactly match sorted v1 membership"
        )
    declared = _root(manifest["bindingRoot"], "typed binding bindingRoot")
    if declared != _family_v2_binding_root(manifest):
        raise ValueError("Initiative-family typed binding root does not verify")
    return manifest


def _create_family_state_v2(
    projection: Mapping[str, Any],
    bindings: Mapping[str, Any],
    *,
    predecessor_state_root: str,
    previous_state_root: str,
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "schema": FAMILY_STATE_V2_SCHEMA,
        "predecessorStateRoot": predecessor_state_root,
        "v1ProjectionRoot": projection["stateRoot"],
        "v1Projection": json.loads(canonical_json(projection)),
        "typedBindingRoot": bindings["bindingRoot"],
        "typedBindings": json.loads(canonical_json(bindings)),
        "previousStateRoot": previous_state_root,
    }
    state["stateRoot"] = _family_v2_state_root(state)
    return validate_family_state_v2(state)


def validate_family_state_v2(value: Any) -> dict[str, Any]:
    """Validate a fully typed v2 state and its exact v1 projection."""

    state = _strict_object(
        value,
        {
            "schema",
            "predecessorStateRoot",
            "v1ProjectionRoot",
            "v1Projection",
            "typedBindingRoot",
            "typedBindings",
            "previousStateRoot",
            "stateRoot",
        },
        "Initiative-family state v2",
    )
    if state["schema"] != FAMILY_STATE_V2_SCHEMA:
        raise ValueError(f"family state v2 schema must be {FAMILY_STATE_V2_SCHEMA}")
    _root(state["predecessorStateRoot"], "predecessorStateRoot")
    previous = str(state["previousStateRoot"] or "")
    if previous:
        _root(previous, "previousStateRoot")
    projection = validate_family_state(state["v1Projection"])
    if state["v1ProjectionRoot"] != projection["stateRoot"]:
        raise ValueError("v2 state does not bind its exact v1 projection root")
    bindings = validate_family_binding_v2(state["typedBindings"], projection)
    if state["typedBindingRoot"] != bindings["bindingRoot"]:
        raise ValueError("v2 state does not bind its typed manifest root")
    declared = _root(state["stateRoot"], "stateRoot")
    if declared != _family_v2_state_root(state):
        raise ValueError("Initiative-family state v2 root does not verify")
    return state


def upgrade_family_state_v2(
    v1_state: Any, typed_binding_manifest: Any
) -> dict[str, Any]:
    """Explicitly upgrade one immutable v1 state with caller-supplied bindings."""

    predecessor = validate_family_state(v1_state)
    bindings = validate_family_binding_v2(typed_binding_manifest, predecessor)
    successor = _create_family_state_v2(
        predecessor,
        bindings,
        predecessor_state_root=predecessor["stateRoot"],
        previous_state_root="",
    )
    return {
        "schema": FAMILY_UPGRADE_V2_SCHEMA,
        "predecessorStateRoot": predecessor["stateRoot"],
        "typedBindingRoot": bindings["bindingRoot"],
        "v1ProjectionRoot": predecessor["stateRoot"],
        "successorStateRoot": successor["stateRoot"],
        "successorState": successor,
    }


def transition_family_state_v2(current: Any, transition: Any) -> dict[str, Any]:
    """Advance v2 only with a v1 transition and a complete successor manifest."""

    prior = validate_family_state_v2(current)
    update = _strict_object(
        transition,
        {
            "schema",
            "expectedStateRoot",
            "v1Transition",
            "typedBindingManifest",
        },
        "Initiative-family transition v2",
    )
    if update["schema"] != FAMILY_TRANSITION_V2_SCHEMA:
        raise ValueError(
            f"family transition v2 schema must be {FAMILY_TRANSITION_V2_SCHEMA}"
        )
    expected = _root(update["expectedStateRoot"], "expectedStateRoot")
    if expected != prior["stateRoot"]:
        raise ValueError("Initiative-family state v2 changed before transition")
    successor_projection = transition_family_state(
        prior["v1Projection"], update["v1Transition"]
    )
    bindings = validate_family_binding_v2(
        update["typedBindingManifest"], successor_projection
    )
    return _create_family_state_v2(
        successor_projection,
        bindings,
        predecessor_state_root=prior["predecessorStateRoot"],
        previous_state_root=prior["stateRoot"],
    )


def project_family_state_v1(value: Any) -> dict[str, Any]:
    """Return the exact v1-compatible state carried by a typed v2 envelope."""

    state = validate_family_state_v2(value)
    return json.loads(canonical_json(state["v1Projection"]))


def verify_family_state_v2(value: Any) -> dict[str, Any]:
    """Read v1 as under-typed or verify a complete v2 typed envelope."""

    if isinstance(value, dict) and value.get("schema") == FAMILY_STATE_SCHEMA:
        state = validate_family_state(value)
        return {
            "schema": "kungfu.work-control.initiative-family-verification/v2",
            "ok": True,
            "inputSchema": FAMILY_STATE_SCHEMA,
            "typingState": "under-typed-v1",
            "stateRoot": state["stateRoot"],
            "v1ProjectionRoot": state["stateRoot"],
            "fullyTyped": False,
            "completionQualified": False,
            "missingSemanticBindings": [
                "acceptance-policy",
                "admission-receipt",
                "assessment",
                "assignment-state",
                "completion-claim",
                "decision",
                "delivery-evidence",
                "episode",
                "execution-warrant",
                "atlas",
                "project-cut",
                "pursuit",
                "work-definition",
            ],
        }
    state = validate_family_state_v2(value)
    projection = state["v1Projection"]
    merged = [
        child
        for child in state["typedBindings"]["children"]
        if (
            next(
                row["terminal"]
                for row in projection["children"]
                if row["assignmentId"] == child["assignmentId"]
            )
            or {}
        ).get("state")
        == "merged"
    ]
    publication_states = [
        child["settlement"]["value"]["publication"]["state"] for child in merged
    ]
    v1_verification = verify_family_state(projection)
    acceptance_proved = all(
        row["status"] == "proved" for row in projection["acceptance"]
    )
    all_children_merged = len(merged) == len(projection["children"])
    publication_complete = all(row == "published" for row in publication_states)
    return {
        "schema": "kungfu.work-control.initiative-family-verification/v2",
        "ok": True,
        "inputSchema": FAMILY_STATE_V2_SCHEMA,
        "typingState": "fully-typed-v2",
        "stateRoot": state["stateRoot"],
        "previousStateRoot": state["previousStateRoot"],
        "predecessorStateRoot": state["predecessorStateRoot"],
        "v1ProjectionRoot": state["v1ProjectionRoot"],
        "typedBindingRoot": state["typedBindingRoot"],
        "fullyTyped": True,
        "waveDrained": v1_verification["waveDrained"],
        "mergedSettlementCount": len(merged),
        "publicationComplete": publication_complete,
        "pendingPublicationCount": publication_states.count("pending"),
        "failedPublicationCount": publication_states.count("failed"),
        "completionQualified": (
            v1_verification["waveDrained"]
            and all_children_merged
            and acceptance_proved
            and publication_complete
        ),
        "projectionMergeIsCompletion": False,
    }
