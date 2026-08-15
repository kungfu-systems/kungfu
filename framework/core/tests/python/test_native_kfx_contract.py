import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu import kfx_contract, kfx_control, kfx_host
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
    return {"roots": [{"kind": "workspace", "path": str(root)}]}


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
    projection["attestation"]["bindings"]["packageRoot"] = package_root
    projection["trustInputs"]["packageRoot"] = package_root
    return {
        **request,
        **fixture["admission"],
        "assessmentTime": fixture["assessmentTime"],
        "trustInputs": projection["trustInputs"],
        "kfdAssessment": projection["kfdAssessment"],
        "attestation": projection["attestation"],
        "_expectedCoreReportRoot": fixture["expected"]["coreReportRoot"],
    }


def _semantic_registry_request():
    root = (
        Path(__file__).parents[2]
        / "src"
        / "libkungfu"
        / "tests"
        / "fixtures"
        / "native_kfx_registry"
        / "semantic"
    )
    return {"roots": [{"kind": "workspace", "path": str(root)}]}


def _expected_registry_roots():
    path = (
        Path(__file__).parents[2]
        / "src"
        / "libkungfu"
        / "tests"
        / "fixtures"
        / "native_kfx_registry"
        / "expected-roots.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))


def test_native_kfx_python_binding_is_a_thin_core_edge(tmp_path):
    contract = storage_service.kfx_runtime_contract(tmp_path)
    assert contract["schema"] == "kungfu.kfx.native-contract/v3"
    assert contract["contractVersion"] == 3
    assert contract["versionNegotiation"]["supported"] == [3]
    assert contract["runtimeTiers"] != contract["admissionGrades"]
    assert contract["authority"]["owner"] == "libkungfu"
    assert contract["sourceContractRoot"].startswith("sha256:")
    assert contract["nativeContractRoot"].startswith("sha256:")

    with pytest.raises(ValueError, match="KF_KFX_CONTRACT_VERSION_UNSUPPORTED"):
        storage_service.validate_kfx_runtime_document(
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


@pytest.mark.parametrize(
    "action",
    [
        "authorize-host",
        "runtime-warrant-issue",
        "runtime-warrant-heartbeat",
        "runtime-warrant-revoke",
        "runtime-warrant-settle",
        "runtime-warrant-recover",
        "kfd-10-witness",
    ],
)
def test_native_kfx_registry_python_edge_forwards_authority_actions(
    tmp_path, monkeypatch, action
):
    calls = []

    class Runtime:
        def run_storage_service_operation(self, operation, runtime_dir, options):
            calls.append((operation, runtime_dir, options))
            return {"executionAllowed": False}

    runtime = Runtime()
    monkeypatch.setattr(storage_service, "_runtime", lambda: runtime)
    request = {
        "packageKey": "langchain-adapter",
        "host": "adapter-python",
        "expectedAuthorizationRoot": f"sha256:{'a' * 64}",
    }

    assert storage_service.kfx_registry(action, request, tmp_path) == {
        "executionAllowed": False
    }
    assert calls == [
        (
            "kfx_runtime",
            str(tmp_path),
            {"action": action, "request": request},
        )
    ]


def test_native_kfx_registry_binding_reaches_host_authorization(tmp_path):
    with pytest.raises(ValueError, match="KF_KFX_CUT_MISSING"):
        storage_service.kfx_registry(
            "authorize-host",
            {
                "packageKey": "langchain-adapter",
                "host": "adapter-python",
            },
            tmp_path / "runtime",
        )


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
    assert status["readOnly"] is False
    assert status["cacheAuthority"] is False
    assert plan["graphRoot"] == status["graphRoot"]


def test_python_and_host_projections_preserve_core_semantic_roots(tmp_path):
    plan = storage_service.kfx_registry(
        "plan", _semantic_registry_request(), tmp_path / "runtime"
    )
    expected = _expected_registry_roots()
    assert plan["graphRoot"] == expected["semanticGraphRoot"]
    assert plan["planRoot"] == expected["semanticPlanRoot"]
    assert (
        plan["hostContract"]["receiptDependencyRoot"]
        == expected["semanticHostReceiptDependencyRoot"]
    )
    assert plan["graph"]["providers"]
    assert plan["graphRoot"].startswith("sha256:")
    assert plan["hostContract"]["planRoot"] == plan["planRoot"]

    projections = [
        kfx_host.project_experience_flow_host(plan["hostContract"], host)
        for host in ("gui", "tui", "cli", "agent")
    ]
    assert {projection["graphRoot"] for projection in projections} == {
        plan["graphRoot"]
    }
    assert {projection["planRoot"] for projection in projections} == {plan["planRoot"]}
    assert {projection["receiptDependencyRoot"] for projection in projections} == {
        plan["hostContract"]["receiptDependencyRoot"]
    }
    assert {projection["cutRoot"] for projection in projections} == {
        plan["hostContract"]["cutRoot"]
    }
    assert {projection["revision"] for projection in projections} == {
        plan["hostContract"]["revision"]
    }
    assert {projection["generationRoot"] for projection in projections} == {
        plan["hostContract"]["generationRoot"]
    }
    assert {projection["admissionState"] for projection in projections} == {
        "preview-only"
    }
    assert all(
        not projection["contributions"][0]["executionEligible"]
        for projection in projections
    )
    tui = next(item for item in projections if item["host"] == "tui")
    assert tui["contributions"][0]["semanticState"] == "active"
    assert tui["contributions"][0]["presentationState"] == "dormant"
    assert tui["diagnostics"][0]["code"] == "KF_KFX_HOST_NOT_ADMITTED"
    assert (
        kfx_host.project_cli_experience_flow_host(plan["hostContract"])["planRoot"]
        == plan["planRoot"]
    )
    assert (
        kfx_host.project_agent_experience_flow_host(plan["hostContract"])["planRoot"]
        == plan["planRoot"]
    )

    mismatched = json.loads(json.dumps(plan["hostContract"]))
    mismatched["admission"]["capabilityRoots"][0] = "sha256:" + "f" * 64
    with pytest.raises(
        ValueError, match="contribution admission identity does not match"
    ):
        kfx_host.project_experience_flow_host(mismatched, "gui")


def test_control_suite_safe_mode_projects_one_root_to_all_hosts(tmp_path):
    status = kfx_control.status(tmp_path / "runtime")
    assert status["mode"] == "safe-mode"
    assert status["executionAllowed"] is False
    projections = [
        kfx_host.project_control_suite_host(status, host)
        for host in ("gui", "tui", "cli", "agent")
    ]
    assert {row["statusRoot"] for row in projections} == {status["statusRoot"]}
    assert {row["revision"] for row in projections} == {0}
    assert {row["mode"] for row in projections} == {"safe-mode"}


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
