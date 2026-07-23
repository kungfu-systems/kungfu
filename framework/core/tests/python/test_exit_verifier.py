# SPDX-License-Identifier: Apache-2.0

import copy
import base64
import json

import pytest
from click.testing import CliRunner
from jsonschema import Draft202012Validator

from kungfu import exit_bundle, exit_verifier
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


def _sealed_episode(runtime_dir, episode_id):
    storage_service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        begin_time=episode_id * 10,
        title=f"Verifier fixture {episode_id}",
        actor="pytest",
        source="exit-verifier-test",
    )
    storage_service.episode_end(
        runtime_dir,
        episode_id=episode_id,
        end_time=episode_id * 10 + 1,
        reason="sealed for verifier",
    )


def _request(episode_id, mode):
    return {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": f"exit:verifier-{mode}",
        "mode": mode,
        "scope": {
            "id": "verifier/fixture",
            "authority": "pytest",
            "schema": "test.verifier-scope/v1",
            "protocol": "test-verifier-scope-root/v1",
        },
        "members": [
            {
                "memberId": "episode-primary",
                "kind": "episode-v1",
                "requiredForScope": True,
                "options": {"episodeId": episode_id},
            }
        ],
    }


@pytest.fixture
def packages(tmp_path):
    source = tmp_path / "source"
    _sealed_episode(source, 801)
    return {
        mode: exit_bundle.build(source, _request(801, mode))
        for mode in ("full", "thin")
    }


def _recompute(package):
    package["manifest"]["bundleRoot"] = exit_bundle._manifest_root(package["manifest"])
    package["packageRoot"] = exit_bundle._package_root(package)
    return package


def test_packaged_verifier_is_discoverable_bounded_and_honest(tmp_path, monkeypatch):
    runtime = tmp_path / "must-not-exist"
    monkeypatch.setenv("KF_RUNTIME_DIR", str(runtime))

    first = exit_verifier.info()
    second = exit_verifier.info()

    assert first == second
    assert first["schema"] == "kungfu.exit-verifier-info/v1"
    assert first["product"] == {
        "version": "4.0.0-alpha.1",
        "channel": "pre-release",
        "source": "source-package-json",
    }
    assert first["verifier"]["independentImplementation"] is False
    assert first["verifier"]["runtimeMutation"] is False
    assert first["exitContract"]["schema"] == "kungfu.exit-bundle.contract/v1"
    assert first["exitContract"]["weldedSurface"] == "exit-bundle-contract"
    assert first["exitContract"]["contractRoot"].startswith("sha256:")
    assert first["exitContract"]["manifestSchemaRoot"].startswith("sha256:")
    assert (
        first["supportPolicy"]["productVersioning"]["stableSameMinor"]["commitment"]
        == "registered-authoritative-semantics-unchanged"
    )
    assert (
        first["supportPolicy"]["productVersioning"]["preRelease"]["commitment"]
        == "exact-evidence-only"
    )
    assert first["qualification"]["overallReleaseStatus"] == "not-qualified"
    assert first["qualification"]["unqualifiedPlatforms"] == [
        "linux-x86_64",
        "windows-x86_64",
    ]
    assert first["independence"]["kfr2"]["executedByThisEntrypoint"] is False
    assert first["independence"]["episode"]["executedByThisEntrypoint"] is False
    assert "kungfu.exit-package/v1" in first["supportedPackageSchemas"]
    assert "single-byte-tamper" in first["corpus"]["caseIds"]
    assert runtime.exists() is False


def test_full_and_thin_reports_are_stable_read_only_and_schema_valid(
    tmp_path, monkeypatch, packages
):
    runtime = tmp_path / "must-not-exist"
    monkeypatch.setenv("KF_RUNTIME_DIR", str(runtime))

    full = exit_verifier.verify(packages["full"])
    repeated = exit_verifier.verify(packages["full"])
    thin = exit_verifier.verify(packages["thin"])
    schema = exit_verifier.info()["reportSchema"]

    Draft202012Validator(schema).validate(full)
    Draft202012Validator(schema).validate(thin)
    assert full == repeated
    assert full["verdict"] == "verified"
    assert full["ok"] is True
    assert full["verifiedMembers"] == ["episode-primary"]
    assert "materialize" in full["safeCapabilities"]
    assert thin["verdict"] == "degraded"
    assert thin["ok"] is False
    assert thin["safeCapabilities"] == ["inspect", "verify-inventory"]
    assert "materialization" in thin["unverifiedDimensions"]
    assert runtime.exists() is False


def test_verifier_cli_emits_machine_report_and_stable_exit_codes(packages):
    runner = CliRunner()

    verified = runner.invoke(
        kfc,
        [
            "exit",
            "verify",
            "--input-base64",
            __import__("base64")
            .b64encode(json.dumps(packages["full"]).encode())
            .decode(),
            "--json",
        ],
    )
    degraded = runner.invoke(
        kfc,
        [
            "exit",
            "verify",
            "--input-base64",
            __import__("base64")
            .b64encode(json.dumps(packages["thin"]).encode())
            .decode(),
            "--json",
        ],
    )
    discovery = runner.invoke(kfc, ["exit", "verify", "--info", "--json"])

    assert verified.exit_code == 0, verified.output
    assert json.loads(verified.output)["verdict"] == "verified"
    assert degraded.exit_code == 3, degraded.output
    assert json.loads(degraded.output)["verdict"] == "degraded"
    assert discovery.exit_code == 0, discovery.output
    assert json.loads(discovery.output)["schema"] == "kungfu.exit-verifier-info/v1"


def test_standalone_entrypoint_avoids_runtime_bootstrap(
    tmp_path, monkeypatch, capsys, packages
):
    runtime = tmp_path / "must-not-exist"
    monkeypatch.setenv("KF_RUNTIME_DIR", str(runtime))
    encoded = base64.b64encode(json.dumps(packages["full"]).encode()).decode()

    assert exit_verifier.main(["--info", "--json"]) == 0
    info = json.loads(capsys.readouterr().out)
    assert info["schema"] == "kungfu.exit-verifier-info/v1"

    assert (
        exit_verifier.main(["--input-base64", encoded, "--json"])
        == info["exitCodes"]["verified"]
    )
    report = json.loads(capsys.readouterr().out)
    assert report["verdict"] == "verified"
    assert runtime.exists() is False


def test_packaged_corpus_replays_fail_closed(monkeypatch, packages):
    corpus = json.loads(
        exit_verifier._asset(exit_verifier.CORPUS_FILE).read_text(encoding="utf-8")
    )
    observed = {}
    for case in corpus["cases"]:
        fixture = case["fixture"]
        mutation = case["mutation"]
        package = copy.deepcopy(packages.get(fixture, packages["full"]))
        if mutation == "material-byte":
            package["materials"]["episode-primary"]["episode_id"] = "999"
        elif mutation == "package-schema":
            package["schema"] = "kungfu.exit-package/v9"
            package["packageRoot"] = exit_bundle._package_root(package)
        elif mutation == "member-protocol":
            package["manifest"]["members"][0]["protocol"] = (
                "episode-sealed-content-root/v9"
            )
            _recompute(package)
        elif mutation == "missing-member":
            package["manifest"]["members"] = []
            _recompute(package)
        elif mutation == "duplicate-member":
            package["manifest"]["members"].append(
                copy.deepcopy(package["manifest"]["members"][0])
            )
            _recompute(package)
        elif mutation == "thin-overclaim":
            package["manifest"]["capabilities"].append("materialize")
            _recompute(package)
        elif mutation == "required-redaction":
            package["manifest"]["omissions"].append(
                {
                    "omissionId": "required-redaction",
                    "memberId": "episode-primary",
                    "kind": "redacted",
                    "requiredForScope": True,
                    "affectsCapabilities": ["materialize", "continue"],
                    "detailRoot": "sha256:" + "1" * 64,
                }
            )
            _recompute(package)
        elif mutation == "oversize-package":
            contract = exit_verifier._contract()
            contract["bounds"]["maximumPackageBytes"] = 64
            monkeypatch.setattr(exit_verifier, "_contract", lambda: contract)
            report = exit_verifier.verify_bytes(b" " * 65)
            monkeypatch.undo()
            observed[case["id"]] = report
            continue
        elif mutation == "member-count":
            package["manifest"]["members"] = [
                {"memberId": f"member-{index}"} for index in range(257)
            ]
        elif mutation == "json-depth":
            nested = package
            for _ in range(65):
                nested["nested"] = {}
                nested = nested["nested"]
        elif mutation != "none":
            raise AssertionError(f"unhandled corpus mutation: {mutation}")
        observed[case["id"]] = exit_verifier.verify(package)

    for case in corpus["cases"]:
        report = observed[case["id"]]
        assert report["verdict"] == case["verdict"], case["id"]
        assert (report["failureCodes"][0] if report["failureCodes"] else None) == case[
            "failureCode"
        ], case["id"]
