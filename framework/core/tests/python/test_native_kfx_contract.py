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


def _assessment_request(tmp_path):
    request = _registry_request()
    package_root = storage_service.kfx_registry(
        "inspect", {**request, "packageKey": "optional-view"}, tmp_path
    )["package"]["packageRoot"]
    fixture_path = (
        Path(__file__).parents[2]
        / "src"
        / "libkungfu"
        / "tests"
        / "fixtures"
        / "native_kfx_contract"
        / "buildchain-2.13.0-alpha.0-envelope.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    projection = fixture["projection"]
    assert fixture["producer"]["version"] == "2.13.0-alpha.0"
    assert projection["contract"] == "kungfu-buildchain-kfx-admission-inputs"
    assert projection["envelopeRoot"] == fixture["expected"]["envelopeRoot"]
    assert projection["trustInputs"]["packageRoot"] == package_root
    return {
        **request,
        **fixture["admission"],
        "assessmentTime": fixture["assessmentTime"],
        "trustInputs": projection["trustInputs"],
        "kfdAssessment": projection["kfdAssessment"],
        "attestation": projection["attestation"],
        "_expectedCoreReportRoot": fixture["expected"]["coreReportRoot"],
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


def test_native_kfx_assessment_projects_one_report_across_python_and_cli(tmp_path):
    request = _assessment_request(tmp_path / "runtime")
    expected_report_root = request.pop("_expectedCoreReportRoot")
    direct = storage_service.kfx_registry("assess", request, tmp_path / "runtime")
    policy_path = tmp_path / "policy.json"
    attestation_path = tmp_path / "attestation.json"
    trust_inputs_path = tmp_path / "trust-inputs.json"
    kfd_assessment_path = tmp_path / "kfd-assessment.json"
    policy_path.write_text(json.dumps(request["policy"]), encoding="utf-8")
    attestation_path.write_text(json.dumps(request["attestation"]), encoding="utf-8")
    trust_inputs_path.write_text(json.dumps(request["trustInputs"]), encoding="utf-8")
    kfd_assessment_path.write_text(
        json.dumps(request["kfdAssessment"]), encoding="utf-8"
    )
    root = request["roots"][0]
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path),
            "kfx",
            "native",
            "assess",
            "optional-view",
            "--root",
            f"{root['kind']}={root['path']}",
            "--runtime-tier",
            "optional-view=verified-third-party",
            "--operation",
            request["operation"],
            "--purpose",
            request["purpose"],
            "--cut",
            request["cut"],
            "--assessment-time",
            str(request["assessmentTime"]),
            "--requested-capability",
            request["requestedCapabilities"][0],
            "--policy",
            str(policy_path),
            "--attestation",
            str(attestation_path),
            "--trust-inputs",
            str(trust_inputs_path),
            "--kfd-assessment",
            str(kfd_assessment_path),
        ],
    )

    assert result.exit_code == 0, result.output
    projected = json.loads(result.output)
    assert projected["trustReport"]["reportRoot"] == direct["trustReport"]["reportRoot"]
    assert direct["trustReport"]["reportRoot"] == expected_report_root
    assert projected["admissionPlan"]["planRoot"] == direct["admissionPlan"]["planRoot"]
    assert projected["trustReport"]["admissionGrade"] == "kfd-attested"


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
