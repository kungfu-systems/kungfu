# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _assignment_orchestration_support import *


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


def test_assignment_admit_omits_retired_atlas_root():
    source = inspect.getsource(ASSIGNMENT_CLI._admit_captured_assignment)

    assert '"atlasRoot"' not in source


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
