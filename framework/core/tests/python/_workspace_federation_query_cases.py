# SPDX-License-Identifier: Apache-2.0
"""Federated query, catalog, and projection composition cases."""
# ruff: noqa: F401,F403

from _workspace_federation_support import *
from _workspace_federation_support import (
    _bind_work_control_profile,
    _component_fixture,
    _human_initiative_group_line,
    _human_work_line,
    _qualified_project,
    _ref,
    _observer_state_advanced,
    _runtime_signal,
)


def test_all_query_preserves_unavailable_catalog_entry_without_home_write(tmp_path):
    config_home = tmp_path / "config"
    identity = _qualified_project(tmp_path, "repo")
    select_workspace(
        identity,
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )
    unavailable = tmp_path / "unavailable"
    os.rename(identity.workspace_root, unavailable)
    home = inspect_workspace(home=True, env={"HOME": str(tmp_path)})
    assert home is not None
    home_data = tmp_path / ".kungfu"
    assert not home_data.exists()

    result = query_federation(
        home,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )

    assert result["atomic_global_cut"] is False
    assert result["writes"] == []
    assert all(row["observed_at"] for row in result["components"])
    assert all(row["observed_at"] for row in result["proof"]["component_cuts"])
    unavailable_rows = [
        row for row in result["components"] if row["availability"] == "unavailable"
    ]
    assert len(unavailable_rows) == 1
    assert unavailable_rows[0]["workspace"]["identity_root"] == identity.identity_root
    assert all(row["workspace"]["identity_root"] for row in result["components"])
    assert result["aggregate"]["state"] == "partial"
    assert result["aggregate"]["known_assignment_count"] == 0
    assert result["aggregate"]["false_zero_guard"] == "unknown-not-empty"
    assert not home_data.exists()


def test_root_bound_components_keep_distinct_profile_and_runtime_envelopes(tmp_path):
    config_home = tmp_path / "config"
    identities = [
        _qualified_project(tmp_path, name) for name in ("one", "two", "three")
    ]
    for identity in identities:
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    profile_roots = {
        identity.identity_root: f"sha256:{index:064x}"
        for index, identity in enumerate(identities, start=1)
    }

    def loader(identity):
        profile_root = profile_roots.get(identity.identity_root, ROOT_B)
        return {
            "availability": "available",
            "stale": False,
            "cut_root": ROOT_D,
            "query_proof_root": ROOT_D,
            "initiatives": [],
            "assignments": [],
            "relations": [],
            "problems": [],
            "profile_root": profile_root,
            "reader_runtime": {
                "schema": "kungfu.workspace-federation.reader-runtime/v1",
                "runtime_root": ROOT_C,
                "version": "4.0.0-controller",
            },
            "workspace_runtime": {
                "schema": "kungfu.workspace-federation.workspace-runtime/v1",
                "state": "identified",
                "runtime_root": profile_root,
                "version": f"4.0.0-workspace-{profile_root[-1]}",
            },
            "compatibility": {
                "state": "compatible",
                "protocol": "kungfu.fact-material-read/v1",
                "reason": "fixture",
            },
        }

    result = query_federation(
        identities[0],
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    assert len(result["components"]) == 4  # three projects plus logical Home
    project_components = [
        row
        for row in result["components"]
        if row["workspace"]["workspace_kind"] == "project"
    ]
    assert {row["envelope"]["profile_root"] for row in project_components} == set(
        profile_roots.values()
    )
    assert result["verification"]["ok"] is True
    assert result["aggregate"]["state"] == "complete"
    assert (
        len(
            {
                row["envelope"]["workspace_runtime"]["version"]
                for row in project_components
            }
        )
        == 3
    )


def test_incremental_query_reloads_only_changed_component(tmp_path):
    config_home = tmp_path / "config"
    identities = [_qualified_project(tmp_path, name) for name in ("one", "two")]
    for identity in identities:
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    initial = query_federation(
        identities[0],
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=lambda identity: _component_fixture(identity, {}),
    )
    cached = {row["workspace"]["identity_root"]: row for row in initial["components"]}
    unchanged_root = identities[0].identity_root
    changed_root = identities[1].identity_root
    unchanged_envelope = cached[unchanged_root]["envelope"]["envelope_root"]
    loaded = []

    def changed_loader(identity):
        loaded.append(identity.identity_root)
        return _component_fixture(identity, {})

    refreshed = query_federation(
        identities[0],
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=changed_loader,
        component_cache=cached,
        refresh_identity_roots={changed_root},
        max_workers=4,
    )

    assert loaded == [changed_root]
    refreshed_by_root = {
        row["workspace"]["identity_root"]: row for row in refreshed["components"]
    }
    assert (
        refreshed_by_root[unchanged_root]["envelope"]["envelope_root"]
        == unchanged_envelope
    )
    assert refreshed["verification"]["ok"] is True


def test_append_journal_signal_is_workspace_scoped_and_monotonic(tmp_path):
    runtime = tmp_path / "runtime"
    journal = (
        runtime
        / "journal"
        / "system"
        / "storage"
        / "episode-manifest"
        / "live"
        / "00000000.1.journal"
    )
    journal.parent.mkdir(parents=True)
    journal.write_bytes(b"before")
    before = _runtime_signal(str(runtime))
    journal.write_bytes(b"before-after")

    assert before
    assert _runtime_signal(str(runtime)) != before
    assert _runtime_signal(str(tmp_path / "other-runtime")) == ""


def test_observer_persists_only_when_durable_state_advances():
    cursor = {"workspace": {"target_result_hash": "sha256:same"}}
    signals = {"workspace": "journal:10:20:30"}

    assert not _observer_state_advanced(
        cursor, dict(cursor), signals, dict(signals), set()
    )
    assert _observer_state_advanced(
        cursor,
        {"workspace": {"target_result_hash": "sha256:next"}},
        signals,
        signals,
        set(),
    )
    assert _observer_state_advanced(
        cursor,
        cursor,
        signals,
        {"workspace": "journal:11:21:31"},
        set(),
    )
    assert _observer_state_advanced(cursor, cursor, signals, signals, {"workspace"})


def test_observer_stable_poll_does_not_rewrite_persisted_state(tmp_path, monkeypatch):
    query = {
        "schema": "kungfu.workspace-federation.query/v1",
        "observed_at": "2026-01-01T00:00:00Z",
        "aggregate": {},
        "verification": {"ok": True},
        "proof": {"catalog_cut": ROOT_A},
        "global_work": {"filter": {"include_settled": False}},
        "components": [],
    }
    writes = []
    stop_checks = 0

    def stop():
        nonlocal stop_checks
        stop_checks += 1
        return stop_checks > 2

    monkeypatch.setattr(
        federation_observer,
        "load_workspace_catalog",
        lambda *_args, **_kwargs: {"catalog_cut": ROOT_A},
    )
    monkeypatch.setattr(
        federation_observer,
        "query_federation",
        lambda *_args, **_kwargs: query,
    )
    monkeypatch.setattr(federation_observer.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        federation_observer,
        "_write_state",
        lambda *_args: writes.append("write"),
    )

    events = list(
        federation_observer.observe_federation(
            inspect_workspace(home=True, env={"HOME": str(tmp_path)}),
            state_path=tmp_path / "observer.json",
            config_home=str(tmp_path / "config"),
            env={"HOME": str(tmp_path)},
            poll_interval=0,
            stop=stop,
        )
    )

    assert [event["mode"] for event in events] == ["recovery"]
    assert writes == ["write"]


def test_false_zero_regression_preserves_31_unavailable_components(tmp_path):
    config_home = tmp_path / "config"
    home = inspect_workspace(home=True, env={"HOME": str(tmp_path)})
    assert home is not None
    catalog_path = config_home / "workspaces" / "catalog.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_text(
        json.dumps(
            {
                "schema": "kungfu.workspace.locator-catalog/v1",
                "entries": [
                    {
                        "schema": "kungfu.workspace.locator-entry/v1",
                        "workspace_id": f"project:missing-{index}",
                        "identity_root": f"sha256:{index + 1:064x}",
                        "identity_state": "qualified",
                        "workspace_kind": "project",
                        "locator": str(tmp_path / f"missing-{index}"),
                        "data_home": str(tmp_path / f"missing-{index}" / ".kungfu"),
                        "observed_at": "2026-07-24T00:00:00Z",
                    }
                    for index in range(31)
                ],
                "updated_at": "2026-07-24T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )

    result = query_federation(
        home,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
    )

    assert result["aggregate"]["known_assignment_count"] == 0
    assert result["aggregate"]["unavailable_component_count"] == 31
    assert result["aggregate"]["false_zero_guard"] == "unknown-not-empty"
    assert result["aggregate"]["complete"] is False


def test_global_projection_folds_only_root_proven_replicas(tmp_path):
    config_home = tmp_path / "config"
    left = _qualified_project(tmp_path, "replica-left")
    right = _qualified_project(tmp_path, "replica-right")
    for identity in (left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    assignments = {
        left.identity_root: [
            {
                "title": "Shared delivery",
                "status": "active",
                "work_ref": _ref(left, "kungfu:shared", ROOT_A, ROOT_D).as_dict(),
            }
        ],
        right.identity_root: [
            {
                "title": "Shared delivery",
                "status": "active",
                "work_ref": _ref(right, "kungfu:shared", ROOT_A, ROOT_D).as_dict(),
            }
        ],
    }

    result = query_federation(
        left,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=lambda identity: _component_fixture(identity, assignments),
        max_workers=2,
    )

    rows = result["global_work"]["canonical_work"]
    assert len(rows) == 1
    assert rows[0]["equivalence"]["state"] == "proven-replica"
    assert rows[0]["replica_count"] == 1
    assert len(rows[0]["authority_roots"]) == 2
    assert result["aggregate"]["canonical_work_count"] == 1
    assert result["aggregate"]["work_observation_count"] == 2
    assert result["aggregate"]["replica_count"] == 1


def test_same_label_divergent_roots_remain_distinct_without_unsafe_collapse(tmp_path):
    config_home = tmp_path / "config"
    left = _qualified_project(tmp_path, "conflict-left")
    right = _qualified_project(tmp_path, "conflict-right")
    for identity in (left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    assignments = {
        left.identity_root: [
            {
                "title": "Same label",
                "work_ref": _ref(left, "kungfu:same", ROOT_A, ROOT_D).as_dict(),
            }
        ],
        right.identity_root: [
            {
                "title": "Same label",
                "work_ref": _ref(right, "kungfu:same", ROOT_B, ROOT_D).as_dict(),
            }
        ],
    }

    result = query_federation(
        left,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=lambda identity: _component_fixture(identity, assignments),
    )

    assert result["aggregate"]["canonical_work_count"] == 2
    assert result["aggregate"]["conflict_count"] == 0
    assert result["aggregate"]["label_collision_count"] == 1
    assert not any(row["conflict"] for row in result["global_work"]["canonical_work"])
    collision = result["global_work"]["label_collisions"][0]
    assert collision["state"] == "authority-distinct"
    assert len(collision["canonical_roots"]) == 2


def test_initiative_group_preserves_authority_distinct_canonical_roots(tmp_path):
    config_home = tmp_path / "config"
    left = _qualified_project(tmp_path, "initiative-left")
    right = _qualified_project(tmp_path, "initiative-right")
    for identity in (left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )

    def loader(identity):
        component = _component_fixture(identity, {})
        version_root = ROOT_A if identity == left else ROOT_B
        component["initiatives"] = [
            {
                "title": "Technical stewardship",
                "status": "active",
                "lifecycle": {
                    "portfolio_state": "open",
                    "orchestration_phase": "executing",
                },
                "work_ref": build_work_ref(
                    identity,
                    object_kind="initiative",
                    subject="kungfu:technical-stewardship",
                    version_root=version_root,
                    cut_root=ROOT_D,
                ).as_dict(),
            }
        ]
        return component

    result = query_federation(
        left,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    projection = result["global_work"]
    assert len(projection["initiative_groups"]) == 1
    group = projection["initiative_groups"][0]
    raw_roots = sorted(
        row["canonical_root"]
        for row in projection["canonical_work"]
        if row["object_kind"] == "initiative"
    )
    assert group["authority_state"] == "authority-distinct"
    assert group["canonical_roots"] == raw_roots
    expected_authority_roots = sorted(
        {
            root
            for row in projection["canonical_work"]
            if row["object_kind"] == "initiative"
            for root in row["authority_roots"]
        }
    )
    assert group["authority_roots"] == expected_authority_roots
    assert {left.identity_root, right.identity_root}.issubset(group["authority_roots"])
    assert projection["visible_initiative_groups"] == [group]
    rendered = _human_initiative_group_line(group, 100)
    assert "authority-distinct" in rendered
    assert f"authorities={len(expected_authority_roots)}" in rendered


@pytest.mark.parametrize("terminal_status", ["complete", "merged"])
def test_default_portfolio_filter_normalizes_legacy_terminal_statuses(
    tmp_path, terminal_status
):
    identity = _qualified_project(tmp_path, terminal_status)
    assignments = {
        identity.identity_root: [
            {
                "title": f"Legacy {terminal_status}",
                "status": terminal_status,
                "updated_at": "2026-07-29T12:34:56Z",
                "lifecycle": {
                    "portfolio_state": "open",
                    "orchestration_phase": "stage-ready",
                },
                "work_ref": _ref(
                    identity, f"kungfu:legacy-{terminal_status}"
                ).as_dict(),
            }
        ]
    }

    default = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=lambda current: _component_fixture(current, assignments),
    )
    settled = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=lambda current: _component_fixture(current, assignments),
        include_settled=True,
    )

    assert default["global_work"]["visible_work"] == []
    assert len(settled["global_work"]["visible_work"]) == 1
    display = settled["global_work"]["visible_work"][0]["display"]
    assert display["source_status"] == terminal_status
    assert display["orchestration_phase"] == "stage-ready"
    assert display["portfolio_state"] == "open"
    assert display["updated_at"] == "2026-07-29T12:34:56Z"


def test_same_authority_divergent_versions_are_a_strict_conflict(tmp_path):
    identity = _qualified_project(tmp_path, "authority-conflict")
    assignments = {
        identity.identity_root: [
            {
                "title": "Version A",
                "work_ref": _ref(identity, "kungfu:conflict", ROOT_A, ROOT_D).as_dict(),
            },
            {
                "title": "Version B",
                "work_ref": _ref(identity, "kungfu:conflict", ROOT_B, ROOT_D).as_dict(),
            },
        ]
    }

    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=lambda current: _component_fixture(current, assignments),
    )

    assert result["aggregate"]["conflict_count"] == 1
    assert result["aggregate"]["complete"] is False
    assert result["global_work"]["canonical_work"][0]["conflict_reasons"] == [
        "same-authority-divergent-version"
    ]


def test_ambiguous_legacy_dependency_has_distinct_fail_closed_reason(tmp_path):
    source = _qualified_project(tmp_path, "ambiguous-source")
    left = _qualified_project(tmp_path, "ambiguous-left")
    right = _qualified_project(tmp_path, "ambiguous-right")
    config_home = tmp_path / "config"
    for identity in (source, left, right):
        observe_workspace_locator(
            identity,
            config_home=str(config_home),
            env={"HOME": str(tmp_path)},
        )
    assignments = {
        source.identity_root: [
            {
                "title": "Source",
                "work_ref": _ref(source, "kungfu:source", ROOT_C, ROOT_D).as_dict(),
            }
        ],
        left.identity_root: [
            {
                "title": "Target A",
                "work_ref": _ref(left, "kungfu:target", ROOT_A, ROOT_D).as_dict(),
            }
        ],
        right.identity_root: [
            {
                "title": "Target B",
                "work_ref": _ref(right, "kungfu:target", ROOT_B, ROOT_D).as_dict(),
            }
        ],
    }

    def loader(identity):
        component = _component_fixture(identity, assignments)
        if identity.identity_root == source.identity_root:
            component["problems"] = [
                {
                    "code": "unresolved-assignment-dependency",
                    "assignment_subject": "kungfu:source",
                    "dependency_id": "target",
                }
            ]
        return component

    result = query_federation(
        source,
        scope="all",
        config_home=str(config_home),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    unresolved = result["global_work"]["reference_resolution"]["unresolved"]
    assert unresolved[0]["code"] == "ambiguous-reference"
    assert len(unresolved[0]["candidate_canonical_roots"]) == 2
    assert result["aggregate"]["complete"] is False


def test_stale_required_component_fails_strict_completeness(tmp_path):
    identity = _qualified_project(tmp_path, "stale-required")

    def loader(current):
        component = _component_fixture(current, {})
        component["stale"] = True
        return component

    result = query_federation(
        identity,
        scope="local",
        config_home=str(tmp_path / "config"),
        env={"HOME": str(tmp_path)},
        loader=loader,
    )

    assert result["aggregate"]["stale_component_count"] == 1
    assert result["aggregate"]["unknown_component_count"] == 1
    assert result["aggregate"]["complete"] is False
