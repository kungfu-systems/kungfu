import json
from pathlib import Path

from click.testing import CliRunner

from kungfu import kfx_contract
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service as storage_service


def _registry_request():
    root = (
        Path(__file__).parents[2]
        / "src"
        / "libkungfu"
        / "tests"
        / "fixtures"
        / "native_kfx_registry"
        / "roots"
        / "workspace"
    )
    return {
        "roots": [{"kind": "workspace", "path": str(root)}],
        "runtimeTiers": {"optional-view": "verified-third-party"},
    }


def test_native_kfx_python_binding_is_a_thin_core_edge(tmp_path):
    contract = storage_service.kfx_runtime_contract(tmp_path)
    assert contract["schema"] == "kungfu.kfx.native-contract/v2"
    assert contract["contractVersion"] == 2
    assert contract["versionNegotiation"]["supported"] == [1, 2]
    assert contract["runtimeTiers"] != contract["admissionGrades"]
    assert contract["authority"]["owner"] == "libkungfu"
    assert contract["sourceContractRoot"].startswith("sha256:")
    assert contract["nativeContractRoot"].startswith("sha256:")

    validated = storage_service.validate_kfx_runtime_document(
        "request",
        {
            "schema": "kungfu.kfx.native-request/v2",
            "contractVersion": 2,
            "operation": "inspect",
            "packagePath": "extensions/example",
            "requestedCapabilities": [],
        },
        tmp_path,
    )
    assert validated["valid"] is True
    assert validated["nativeContractRoot"] == contract["nativeContractRoot"]


def test_native_kfx_registry_python_projection_matches_core_roots(tmp_path):
    request = _registry_request()
    plan = storage_service.kfx_registry("plan", request, tmp_path)
    listed = storage_service.kfx_registry("list", request, tmp_path)
    resolved = storage_service.kfx_registry(
        "resolve", {**request, "suiteKey": "example-suite"}, tmp_path
    )
    status = storage_service.kfx_registry("status", request, tmp_path)

    assert plan["registryRoot"] == listed["registryRoot"] == status["registryRoot"]
    assert plan["suites"][0]["suiteRoot"] == resolved["suite"]["suiteRoot"]
    assert plan["suites"][0]["profileRoot"] == resolved["suite"]["profileRoot"]
    assert plan["planRoot"].startswith("sha256:")
    assert status["readOnly"] is True
    assert status["cacheAuthority"] is False


def test_native_kfx_cli_projects_the_same_plan_root(tmp_path):
    request = _registry_request()
    direct = storage_service.kfx_registry("plan", request, tmp_path / "runtime")
    root = request["roots"][0]
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path),
            "kfx",
            "native",
            "plan",
            "--root",
            f"{root['kind']}={root['path']}",
            "--runtime-tier",
            "optional-view=verified-third-party",
        ],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["planRoot"] == direct["planRoot"]


def test_python_shadow_parity_matches_the_shared_fixture_corpus():
    cases_path = (
        Path(__file__).parents[4]
        / "tests"
        / "fixtures"
        / "native-kfx-registry-parity"
        / "cases.json"
    )
    cases = json.loads(cases_path.read_text(encoding="utf-8"))

    for case in cases:
        comparison = kfx_contract.compare_kfx_shadow_plans(
            case["legacy"], case["native"]
        )
        assert comparison["findings"][0]["classification"] == case["expected"], case[
            "name"
        ]
