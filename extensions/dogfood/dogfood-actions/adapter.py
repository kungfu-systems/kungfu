# SPDX-License-Identifier: Apache-2.0

"""Content-bound adapter for the Dogfood Feedback Domain Profile."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from kungfu import profile_sdk
from kungfu.workspace import inspect_workspace

WRITE_OPERATIONS = {
    "capture-finding",
    "admit-issue",
    "transition-issue",
    "record-consideration",
}


def _object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TypeError("Dogfood adapter input must be an object")
    return value


def _domain(context: Mapping[str, Any]):
    return profile_sdk.load_member_python_package(
        str(context["source"]), "dogfood-actions", "domain"
    ).dogfood


def _workspace(values: Mapping[str, Any]):
    workspace_root = str(values.get("workspaceRoot") or "")
    home = bool(values.get("home"))
    identity = inspect_workspace(workspace_root or None, home=home)
    if identity is None or identity.identity_state != "qualified":
        raise ValueError("Dogfood federation requires a qualified workspace")
    return identity


def _action(domain, operation: str, runtime_dir: str, values: Mapping[str, Any]):
    if operation == "capture-finding":
        result = domain.capture_finding(
            runtime_dir,
            finding_id=str(values.get("findingId") or ""),
            title=str(values.get("title") or ""),
            summary=str(values.get("summary") or ""),
            episode_root=str(values.get("episodeRoot") or ""),
            evidence_roots=values.get("evidenceRoots") or [],
            dimensions=values.get("dimensions") or {},
            privacy=str(values.get("privacy") or "internal"),
            runtime_surface=str(values.get("runtimeSurface") or ""),
            runtime_receipt_root=str(values.get("runtimeReceiptRoot") or ""),
            actor=str(values.get("actor") or ""),
            observed_at=str(values.get("observedAt") or ""),
            impact=str(values.get("impact") or "medium"),
            hard_class=str(values.get("hardClass") or ""),
            recurrence=int(values.get("recurrence") or 1),
        )
        affected = [result["finding"]["finding_root"]]
    elif operation == "admit-issue":
        result = domain.admit_issue(
            runtime_dir,
            issue_id=str(values.get("issueId") or ""),
            title=str(values.get("title") or ""),
            owner=str(values.get("owner") or ""),
            finding_roots=values.get("findingRoots") or [],
            impact=str(values.get("impact") or "medium"),
            hard_class=str(values.get("hardClass") or ""),
            verification_criteria=values.get("verificationCriteria") or [],
            actor=str(values.get("actor") or ""),
            admitted_at=str(values.get("admittedAt") or ""),
        )
        affected = [result["issue"]["issue_root"]]
    elif operation == "transition-issue":
        result = domain.transition_issue(
            runtime_dir,
            issue_id=str(values.get("issueId") or ""),
            expected_issue_root=str(values.get("expectedIssueRoot") or ""),
            to_state=str(values.get("toState") or ""),
            actor=str(values.get("actor") or ""),
            reason=str(values.get("reason") or ""),
            owner=str(values.get("owner") or ""),
            independent_assessment_root=str(
                values.get("independentAssessmentRoot") or ""
            ),
            authorized_decision_root=str(values.get("authorizedDecisionRoot") or ""),
            successor_fact_root=str(values.get("successorFactRoot") or ""),
            product_root=str(values.get("productRoot") or ""),
            verification_evidence_roots=values.get("verificationEvidenceRoots") or [],
            transitioned_at=str(values.get("transitionedAt") or ""),
        )
        affected = [result["issue"]["issue_root"]]
    elif operation == "record-consideration":
        result = domain.record_consideration(
            runtime_dir,
            _workspace(values),
            assignment=dict(values.get("assignment") or {}),
            stage=str(values.get("stage") or ""),
            actor=str(values.get("actor") or ""),
            dispositions=values.get("dispositions") or [],
            scope=str(values.get("scope") or "local"),
            limit=int(values.get("limit") or 50),
            config_home=str(values.get("configHome") or "") or None,
            recorded_at=str(values.get("recordedAt") or ""),
        )
        affected = [result["consideration"]["receipt_root"]]
    else:
        raise ValueError(f"unsupported Dogfood action: {operation}")
    return {
        "coreReceipt": result,
        "affected": {
            "profileId": "kungfu.dogfood-feedback",
            "entityKeys": affected,
            "queryKeys": ["dogfood-inbox", "dogfood-starvation"],
        },
    }


def invoke(
    operation: str, *, runtime_dir: str, input_value: Any, context: Mapping[str, Any]
):
    values = _object(input_value)
    domain = _domain(context)
    if operation in WRITE_OPERATIONS:
        if context.get("invocationMode") != "authorized-action":
            raise ValueError(
                "Dogfood writes require the Profile intent authorization path"
            )
        return _action(domain, operation, runtime_dir, values)
    if operation == "capabilities":
        return domain.capabilities()
    if operation == "query":
        return domain.federated_query(
            _workspace(values),
            scope=str(values.get("scope") or "local"),
            config_home=str(values.get("configHome") or "") or None,
        )
    if operation == "lookup":
        return domain.local_lookup(
            runtime_dir,
            str(values.get("identity") or ""),
        )
    if operation == "issue-proposal":
        return domain.propose_issue(
            runtime_dir,
            finding_identity=str(values.get("findingIdentity") or ""),
            owner_candidates=values.get("ownerCandidates") or [],
        )
    if operation == "issue-reconciliation":
        return domain.reconcile_issue(
            runtime_dir,
            issue_identity=str(values.get("issueIdentity") or ""),
            evidence=dict(values.get("evidence") or {}),
        )
    if operation == "health":
        return domain.health_projection(
            _workspace(values),
            scope=str(values.get("scope") or "local"),
            config_home=str(values.get("configHome") or "") or None,
            now=str(values.get("now") or ""),
        )
    if operation == "relevance":
        return domain.relevance_query(
            _workspace(values),
            assignment=dict(values.get("assignment") or {}),
            scope=str(values.get("scope") or "local"),
            limit=int(values.get("limit") or 50),
            config_home=str(values.get("configHome") or "") or None,
        )
    if operation == "consideration-gate":
        return domain.consideration_gate(
            runtime_dir,
            assignment_definition_root=str(
                values.get("assignmentDefinitionRoot") or ""
            ),
            target=str(values.get("target") or "closeout"),
            required_stages=values.get("requiredStages") or domain.CONSIDERATION_STAGES,
            now=str(values.get("now") or ""),
        )
    if operation == "starvation":
        if not values.get("workspaceRoot") and not values.get("home"):
            return domain.evaluate_starvation(
                runtime_dir,
                now=str(values.get("now") or ""),
            )
        return domain.starvation_projection(
            _workspace(values),
            scope=str(values.get("scope") or "local"),
            config_home=str(values.get("configHome") or "") or None,
            now=str(values.get("now") or ""),
        )
    raise ValueError(f"unsupported Dogfood adapter operation: {operation}")
