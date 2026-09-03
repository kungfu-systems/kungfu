# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from _assignment_runtime_support import *  # noqa: F403


# The stable facade is the only pytest collection surface.
def test_profile_source_resolves_installed_bundled_root(monkeypatch, tmp_path):
    bundled = tmp_path / "installed" / "extensions"
    source = bundled / "work-control"
    observed = []
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled))
    monkeypatch.delenv("KF_EXTENSION_PATH", raising=False)
    monkeypatch.setattr(
        profile_sdk,
        "discover_source",
        lambda profile_id, *, search_roots: (
            observed.append((profile_id, search_roots)) or {"source": str(source)}
        ),
    )

    assert profile_source() == source
    assert observed == [("kungfu.work-control", [bundled])]


def test_work_profile_ensure_uses_profile_owned_retained_history_compatibility(
    monkeypatch, tmp_path
):
    from kungfu.cli.commands import assignment as work_commands

    runtime = tmp_path / "runtime"
    monkeypatch.setattr(work_commands, "profile_source", lambda: PROFILE_SOURCE)
    monkeypatch.setattr(
        profile_sdk,
        "validate_source",
        lambda _source, _runtime: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": ROOT_A,
            }
        },
    )
    monkeypatch.setattr(
        work_commands.storage_service,
        "profile_lifecycle",
        lambda _runtime, operation, **_values: (
            {
                "profiles": [
                    {
                        "profile_id": "kungfu.work-control",
                        "profile_suite_root": ROOT_A,
                        "qualified": True,
                        "activated": True,
                        "removed": False,
                    }
                ]
            }
            if operation == "list"
            else {}
        ),
    )
    compatibility = {
        "schema": "kungfu.work-control.profile-contract/v1",
        "status": "retained-history-compatible",
        "retained_source_authorities": ["atlas-adapter"],
    }
    domain = types.SimpleNamespace(
        work_control=types.SimpleNamespace(
            ensure_profile_contract=lambda _runtime, _source, _actor: [
                {
                    "schema": "kungfu.work.profile-contract-compatibility-receipt/v1",
                    "profileContract": compatibility,
                    "writeOccurred": False,
                }
            ]
        )
    )
    monkeypatch.setattr(
        profile_sdk,
        "load_member_python_package",
        lambda _source, _member, _package: domain,
    )

    receipts = work_commands._ensure_profile(runtime, "test-agent")

    assert receipts == [
        {
            "schema": "kungfu.work.profile-contract-compatibility-receipt/v1",
            "profileContract": compatibility,
            "writeOccurred": False,
        }
    ]


def test_profile_source_prefers_bundled_root_before_dev_overrides(
    monkeypatch, tmp_path
):
    bundled = tmp_path / "installed" / "extensions"
    dev_one = tmp_path / "dev-one"
    dev_two = tmp_path / "dev-two"
    observed = []
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(bundled))
    monkeypatch.setenv(
        "KF_EXTENSION_PATH", os.pathsep.join([str(dev_one), str(dev_two)])
    )
    monkeypatch.setattr(
        profile_sdk,
        "discover_source",
        lambda profile_id, *, search_roots: (
            observed.append((profile_id, search_roots))
            or {"source": str(bundled / "work-control")}
        ),
    )

    assert profile_source() == bundled / "work-control"
    assert observed == [
        ("kungfu.work-control", [bundled, dev_one, dev_two]),
    ]


def test_gui_stdio_host_announces_ready_after_start_and_preserves_envelopes(
    tmp_path,
):
    authority = FakeAuthority(tmp_path)
    runtime = EmbeddedLocalAssignmentRuntime(
        tmp_path,
        realm_id=REALM["realmId"],
        generation=REALM["generation"],
        authority=authority,
        contract=ASSIGNMENT_RUNTIME_CONTRACT,
        request_schema=ENVELOPE_SCHEMA,
    )
    request = _request(
        "assignment.snapshot",
        "assignment.snapshot.read",
        request_id="gui.work-dashboard:1",
    )
    output = StringIO()

    serve(runtime, StringIO(json.dumps(request) + "\n"), output)

    hello, response = [json.loads(line) for line in output.getvalue().splitlines()]
    assert hello["schema"] == "kungfu.gui.assignment-runtime-host/v1"
    assert hello["status"] == "ready"
    assert hello["realm"] == REALM
    assert hello["genesisCursor"] == runtime.genesis_cursor(REALM["generation"])
    assert response["schema"] == "kungfu.assignment-runtime.response/v1"
    assert response["requestId"] == request["requestId"]
    assert response["status"] == "ok"
    assert runtime._started is False


def test_gui_stdio_host_maps_unexpected_writer_start_failure_to_stable_error():
    class FailingRuntime:
        def start(self):
            raise OSError("private native bind detail")

    output = StringIO()

    with pytest.raises(LocalRuntimeError, match="writer failed to start") as raised:
        serve(FailingRuntime(), StringIO(), output)  # type: ignore[arg-type]

    assert raised.value.code == "backend-unavailable"
    envelope = json.loads(output.getvalue())
    assert envelope["status"] == "error"
    assert envelope["error"]["code"] == "backend-unavailable"
    assert "private native bind detail" not in output.getvalue()


__all__ = [name for name in globals() if name.startswith("test_")]
