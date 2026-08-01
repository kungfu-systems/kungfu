# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import sys
import types

import pytest


def _install_fake_pykungfu() -> None:
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.runtime = types.ModuleType("pykungfu.runtime")
    fake.runtime.coordinator = type("FakeNativeCoordinator", (), {})
    fake.yijinjing = types.SimpleNamespace()
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", fake.runtime)


_install_fake_pykungfu()

from kungfu import runtime_upgrade as release_cut  # noqa: E402


def _root(seed: str) -> str:
    return f"sha256:{seed * 64}"


def _slice(*, signing: bool, seed: str = "1") -> dict:
    return release_cut.finish_platform_slice(
        {
            "schema": release_cut.PLATFORM_SLICE_SCHEMA,
            "platform": "linux",
            "architecture": "x64",
            "manifestIdentityRoot": _root(seed),
            "artifactRoot": _root("2"),
            "qualificationEvidenceRoots": [_root("3")],
            "signingEvidenceRoots": [_root("4")] if signing else [],
        }
    )


def _cut(
    *,
    version: str = "4.0.0-alpha.1",
    trust_domain: str = "public",
    parent: str | None = None,
    seed: str = "1",
) -> dict:
    public = trust_domain == "public"
    return release_cut.finish_release_cut(
        {
            "schema": release_cut.RELEASE_CUT_SCHEMA,
            "productVersion": version,
            "parentReleaseCutRoots": [parent] if parent else [],
            "sourceSettlementRoot": _root("5"),
            "semanticIdentityRoot": _root("6"),
            "productAssemblyRoot": _root("7"),
            "compatibilityContractRoot": _root("8"),
            "migrationContractRoot": _root("9"),
            "platformSlices": [_slice(signing=public, seed=seed)],
            "qualificationEvidenceRoots": [_root("a")],
            "signingEvidenceRoots": [_root("b")] if public else [],
            "publicationPolicy": {
                "trustDomain": trust_domain,
                "publicationEligible": public,
                "immutable": True,
                "eligibleChannels": ["alpha"] if public else [],
            },
            "omissionRoots": [],
            "waiverRoots": [],
        }
    )


def _transition(
    current: dict,
    target: dict,
    *,
    relation: str = "verified-successor",
    kind: str = "signed-lineage",
    compatibility: dict | None = None,
    active_work_policy: str = "keep-pinned",
) -> dict:
    public = target["publicationPolicy"]["trustDomain"] == "public"
    return release_cut.finish_cut_transition(
        {
            "schema": release_cut.CUT_TRANSITION_SCHEMA,
            "fromReleaseCutRoot": current["releaseCutRoot"],
            "toReleaseCutRoot": target["releaseCutRoot"],
            "fromProductVersion": current["productVersion"],
            "toProductVersion": target["productVersion"],
            "relation": relation,
            "authorization": {
                "trustDomain": target["publicationPolicy"]["trustDomain"],
                "kind": kind,
                "publicationEligible": public,
                "evidenceRoots": [_root("c")],
            },
            "compatibility": compatibility
            or {
                "controlProtocol": True,
                "peerWireProtocol": True,
                "journalReadable": True,
                "migrationClass": "none",
                "rollbackClass": "automatic",
                "providerResumeRequired": False,
            },
            "migrationPlanRoot": _root("d"),
            "rollbackPlanRoot": _root("e"),
            "activeWorkPolicy": active_work_policy,
            "evidenceRoots": [_root("f")],
            "diagnostics": [],
        }
    )


def test_release_cut_and_slice_roots_are_deterministic_and_tamper_evident() -> None:
    cut = _cut()
    assert release_cut.validate_release_cut(cut) == cut
    assert (
        release_cut.finish_release_cut(
            {key: value for key, value in cut.items() if key != "releaseCutRoot"}
        )
        == cut
    )

    tampered = copy.deepcopy(cut)
    tampered["platformSlices"][0]["artifactRoot"] = _root("0")
    with pytest.raises(release_cut.ReleaseCutError) as captured:
        release_cut.validate_release_cut(tampered)
    assert captured.value.code == "platform-slice-root-mismatch"


def test_identical_cut_is_current_and_equal_semver_needs_signed_supersession() -> None:
    current = _cut(seed="1")
    identical = release_cut.decide_cut_transition(
        current_release_cut_root=current["releaseCutRoot"],
        current_version=current["productVersion"],
        target_cut=current,
        transition=None,
    )
    assert identical["outcome"] == "identical"
    assert identical["reasonCode"] == "already-current"

    successor = _cut(
        version=current["productVersion"],
        parent=current["releaseCutRoot"],
        seed="0",
    )
    conflict = release_cut.decide_cut_transition(
        current_release_cut_root=current["releaseCutRoot"],
        current_version=current["productVersion"],
        target_cut=successor,
        transition=None,
    )
    assert conflict["reasonCode"] == "cut-conflict"
    assert conflict["updateAllowed"] is False

    ordinary_lineage = release_cut.decide_cut_transition(
        current_release_cut_root=current["releaseCutRoot"],
        current_version=current["productVersion"],
        target_cut=successor,
        transition=_transition(current, successor),
    )
    assert ordinary_lineage["reasonCode"] == "cut-conflict"

    supersession = release_cut.decide_cut_transition(
        current_release_cut_root=current["releaseCutRoot"],
        current_version=current["productVersion"],
        target_cut=successor,
        transition=_transition(
            current,
            successor,
            kind="signed-supersession",
        ),
    )
    assert supersession["outcome"] == "verified-successor"
    assert supersession["updateAllowed"] is True


@pytest.mark.parametrize(
    ("relation", "reason"),
    [
        ("ancestor", "cut-ancestor"),
        ("recovery", "cut-recovery-approval-required"),
        ("diverged", "cut-diverged"),
        ("unknown", "cut-relation-unknown"),
    ],
)
def test_non_successor_relations_never_implicitly_update(
    relation: str, reason: str
) -> None:
    current = _cut()
    target = _cut(
        version="4.0.0-alpha.2",
        parent=current["releaseCutRoot"],
        seed="0",
    )
    decision = release_cut.decide_cut_transition(
        current_release_cut_root=current["releaseCutRoot"],
        current_version=current["productVersion"],
        target_cut=target,
        transition=_transition(
            current,
            target,
            relation=relation,
            kind="incident-recovery" if relation == "recovery" else "signed-lineage",
        ),
    )
    assert decision["reasonCode"] == reason
    assert decision["updateAllowed"] is False
    assert decision["approvalRequired"] is (relation == "recovery")


@pytest.mark.parametrize(
    ("compatibility_update", "active_work_policy", "reason"),
    [
        (
            {"migrationClass": "irreversible"},
            "keep-pinned",
            "irreversible-migration-needs-approval",
        ),
        (
            {"rollbackClass": "none"},
            "keep-pinned",
            "rollback-unavailable",
        ),
        (
            {"rollbackClass": "manual"},
            "keep-pinned",
            "manual-rollback-needs-approval",
        ),
        (
            {"providerResumeRequired": True},
            "provider-resume",
            "provider-resume-required",
        ),
        ({}, "defer-until-idle", "active-work-must-be-idle"),
    ],
)
def test_successor_policy_never_grants_unsafe_automatic_movement(
    compatibility_update: dict,
    active_work_policy: str,
    reason: str,
) -> None:
    current = _cut()
    target = _cut(parent=current["releaseCutRoot"], seed="0")
    compatibility = {
        "controlProtocol": True,
        "peerWireProtocol": True,
        "journalReadable": True,
        "migrationClass": "none",
        "rollbackClass": "automatic",
        "providerResumeRequired": False,
        **compatibility_update,
    }
    decision = release_cut.decide_cut_transition(
        current_release_cut_root=current["releaseCutRoot"],
        current_version=current["productVersion"],
        target_cut=target,
        transition=_transition(
            current,
            target,
            compatibility=compatibility,
            active_work_policy=active_work_policy,
        ),
    )
    assert decision["reasonCode"] == reason
    assert decision["updateAllowed"] is False
    assert decision["approvalRequired"] is True


def test_shifu_local_successor_is_explicitly_publication_ineligible() -> None:
    current = _cut(trust_domain="shifu-local")
    target = _cut(
        trust_domain="shifu-local",
        version=current["productVersion"],
        parent=current["releaseCutRoot"],
        seed="0",
    )
    transition = _transition(
        current,
        target,
        kind="shifu-local-successor",
    )
    decision = release_cut.decide_cut_transition(
        current_release_cut_root=current["releaseCutRoot"],
        current_version=current["productVersion"],
        target_cut=target,
        transition=transition,
    )
    assert decision["updateAllowed"] is True
    assert transition["authorization"]["publicationEligible"] is False
    assert target["publicationPolicy"]["publicationEligible"] is False

    contaminated = copy.deepcopy(target)
    contaminated["publicationPolicy"]["publicationEligible"] = True
    contaminated["releaseCutRoot"] = release_cut.content_root(
        {key: value for key, value in contaminated.items() if key != "releaseCutRoot"}
    )
    with pytest.raises(release_cut.ReleaseCutError) as captured:
        release_cut.validate_release_cut(contaminated)
    assert captured.value.code == "local-release-publication-eligible"


def test_shifu_local_bootstrap_is_explicit_and_cannot_target_public_cut() -> None:
    target = _cut(trust_domain="shifu-local")
    legacy_root = _root("0")
    transition = release_cut.build_shifu_local_transition(
        current_release_cut_root=legacy_root,
        current_version=target["productVersion"],
        target_cut=target,
        relation="verified-successor",
        authorization_kind="shifu-local-bootstrap",
        compatibility={
            "controlProtocol": True,
            "peerWireProtocol": True,
            "journalReadable": True,
            "migrationClass": "none",
            "rollbackClass": "automatic",
            "providerResumeRequired": False,
        },
        migration_plan_root=_root("d"),
        rollback_plan_root=_root("e"),
        active_work_policy="keep-pinned",
        evidence_roots=[_root("f")],
    )
    decision = release_cut.decide_cut_transition(
        current_release_cut_root=legacy_root,
        current_version=target["productVersion"],
        target_cut=target,
        transition=transition,
    )
    assert decision["reasonCode"] == "verified-local-bootstrap"
    assert decision["updateAllowed"] is True

    with pytest.raises(release_cut.ReleaseCutError) as captured:
        release_cut.build_shifu_local_transition(
            current_release_cut_root=legacy_root,
            current_version=target["productVersion"],
            target_cut=_cut(),
            relation="verified-successor",
            authorization_kind="shifu-local-bootstrap",
            compatibility=transition["compatibility"],
            migration_plan_root=_root("d"),
            rollback_plan_root=_root("e"),
            active_work_policy="keep-pinned",
            evidence_roots=[_root("f")],
        )
    assert captured.value.code == "local-release-policy-mismatch"


def test_manifest_identity_root_excludes_only_cut_projection_fields() -> None:
    manifest = {
        "schema": "kungfu.product-upgrade.manifest/v1",
        "productVersion": "4.0.0-alpha.1",
        "runtimeBuildId": "runtime-a",
        "releaseCutRoot": _root("1"),
        "platformSliceRoot": _root("2"),
        "cutTransition": {"cutTransitionRoot": _root("3")},
        "artifacts": [{"kind": "desktop", "digest": _root("4")}],
        "localArtifact": {
            "kind": "desktop-local",
            "format": "directory",
            "digest": _root("5"),
        },
        "qualificationEvidenceRef": _root("6"),
    }
    expected = release_cut.content_root(
        {
            "schema": manifest["schema"],
            "productVersion": manifest["productVersion"],
            "runtimeBuildId": manifest["runtimeBuildId"],
        }
    )
    assert release_cut.manifest_identity_root(manifest) == expected
