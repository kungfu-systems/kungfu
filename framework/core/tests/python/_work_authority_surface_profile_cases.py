# SPDX-License-Identifier: Apache-2.0

from _work_authority_surface_support import *  # noqa: F401,F403


def test_qualified_work_profile_resolves_retained_exact_source(monkeypatch, tmp_path):
    source = tmp_path / "installed" / "work-control"
    source.mkdir(parents=True)
    (source / "profile.json").write_text("{}\n", encoding="utf-8")
    profile_root = f"sha256:{'a' * 64}"
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": profile_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {"closure": {"profile_path": str(source / "profile.json")}},
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, observed_runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": profile_root,
                }
            }
            if observed_source == source.resolve() and observed_runtime == tmp_path
            else (_ for _ in ()).throw(AssertionError("source/runtime drift"))
        ),
    )

    assert profile_lifecycle.resolve_qualified_work_profile(tmp_path) == {
        "id": "kungfu.work-control",
        "root": profile_root,
        "source": str(source.resolve()),
    }


def test_qualified_work_profile_accepts_equivalent_explicit_bundled_source(
    monkeypatch, tmp_path
):
    retained = tmp_path / "rollback-image" / "work-control"
    bundled = tmp_path / "current-image" / "work-control"
    retained.mkdir(parents=True)
    bundled.mkdir(parents=True)
    (retained / "profile.json").write_text("{}\n", encoding="utf-8")
    profile_root = f"sha256:{'a' * 64}"
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": profile_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {
                "closure": {"profile_path": str(retained / "profile.json")}
            },
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, observed_runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": profile_root,
                }
            }
            if observed_source in {retained.resolve(), bundled.resolve()}
            and observed_runtime == tmp_path
            else (_ for _ in ()).throw(AssertionError("source/runtime drift"))
        ),
    )

    assert profile_lifecycle.resolve_qualified_work_profile(
        tmp_path,
        source=bundled,
    ) == {
        "id": "kungfu.work-control",
        "root": profile_root,
        "source": str(bundled.resolve()),
    }


def test_qualified_work_profile_rejects_explicit_source_with_different_root(
    monkeypatch, tmp_path
):
    retained = tmp_path / "rollback-image" / "work-control"
    bundled = tmp_path / "current-image" / "work-control"
    retained.mkdir(parents=True)
    bundled.mkdir(parents=True)
    (retained / "profile.json").write_text("{}\n", encoding="utf-8")
    retained_root = f"sha256:{'a' * 64}"
    observed_root = f"sha256:{'b' * 64}"
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": retained_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {
                "closure": {"profile_path": str(retained / "profile.json")}
            },
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, _runtime: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": (
                    retained_root
                    if observed_source == retained.resolve()
                    else observed_root
                ),
            }
        },
    )

    with __import__("pytest").raises(
        profile_lifecycle.profile_sdk.ProfileSdkError,
        match="does not match the qualified retained root",
    ) as error:
        profile_lifecycle.resolve_qualified_work_profile(
            tmp_path,
            source=bundled,
        )

    assert error.value.diagnosis["code"] == "work-control-profile-source-drift"
    assert error.value.diagnosis["retainedRoot"] == retained_root
    assert error.value.diagnosis["observedRoot"] == observed_root


def test_qualified_work_profile_relocates_missing_source_by_exact_root(
    monkeypatch, tmp_path
):
    missing = tmp_path / "removed-image" / "work-control" / "profile.json"
    bundled_root = tmp_path / "current-image" / "extensions"
    source = bundled_root / "work-control"
    source.mkdir(parents=True)
    profile_root = f"sha256:{'a' * 64}"
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled_root))
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": profile_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {"closure": {"profile_path": str(missing)}},
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "discover_source",
        lambda profile_id, runtime_dir, *, search_roots: (
            {
                "source": str(source),
                "profileSuiteRoot": profile_root,
            }
            if profile_id == "kungfu.work-control"
            and runtime_dir == tmp_path
            and search_roots == [str(bundled_root)]
            else (_ for _ in ()).throw(AssertionError("discovery boundary drift"))
        ),
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda observed_source, observed_runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": profile_root,
                }
            }
            if observed_source == source.resolve() and observed_runtime == tmp_path
            else (_ for _ in ()).throw(AssertionError("source/runtime drift"))
        ),
    )

    assert profile_lifecycle.resolve_qualified_work_profile(tmp_path) == {
        "id": "kungfu.work-control",
        "root": profile_root,
        "source": str(source.resolve()),
    }


def test_qualified_work_profile_relocation_rejects_root_drift(monkeypatch, tmp_path):
    missing = tmp_path / "removed-image" / "work-control" / "profile.json"
    bundled_root = tmp_path / "current-image" / "extensions"
    source = bundled_root / "work-control"
    source.mkdir(parents=True)
    retained_root = f"sha256:{'a' * 64}"
    observed_root = f"sha256:{'b' * 64}"
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled_root))
    monkeypatch.setattr(
        profile_lifecycle.storage_service,
        "profile_lifecycle",
        lambda *_args, **_kwargs: {
            "profile_suite_root": retained_root,
            "qualified": True,
            "activated": True,
            "removed": False,
            "latest_event": {"closure": {"profile_path": str(missing)}},
        },
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "discover_source",
        lambda *_args, **_kwargs: {"source": str(source)},
    )
    monkeypatch.setattr(
        profile_lifecycle.profile_sdk,
        "validate_source",
        lambda *_args, **_kwargs: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": observed_root,
            }
        },
    )

    with __import__("pytest").raises(
        profile_lifecycle.profile_sdk.ProfileSdkError,
        match="retained source no longer matches its exact root",
    ) as error:
        profile_lifecycle.resolve_qualified_work_profile(tmp_path)

    assert error.value.diagnosis["code"] == "work-control-profile-source-root-drift"
    assert error.value.diagnosis["retainedRoot"] == retained_root
    assert error.value.diagnosis["observedRoot"] == observed_root


def test_missing_work_profile_has_specific_fail_closed_diagnosis(monkeypatch, tmp_path):
    def missing(*_args, **_kwargs):
        raise ValueError("Profile not found: kungfu.work-control")

    monkeypatch.setattr(profile_lifecycle.storage_service, "profile_lifecycle", missing)

    with __import__("pytest").raises(
        profile_lifecycle.profile_sdk.ProfileSdkError,
        match="Work Control Profile is not installed",
    ) as error:
        profile_lifecycle.resolve_qualified_work_profile(tmp_path)

    assert error.value.diagnosis["code"] == "work-control-profile-not-installed"

    with __import__("pytest").raises(
        LocalRuntimeError,
        match="Work Control Profile is not installed",
    ) as runtime_error:
        WorkControlAuthority(tmp_path).inspect()

    assert runtime_error.value.code == "backend-unavailable"
    assert runtime_error.value.diagnostics[0]["code"] == (
        "work-control-profile-not-installed"
    )
