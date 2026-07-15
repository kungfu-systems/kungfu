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

    def root(value):
        return f"sha256:{value * 64}"

    policy = {
        "schema": "kungfu.kfx-admission-policy/v1",
        "allowedIssuers": ["buildchain.libkungfu.dev"],
        "allowedPublishers": ["kungfu-systems"],
        "allowedContracts": ["buildchain.release/v1"],
        "allowedVerifierRoots": [root("7")],
        "autoOperations": ["install", "update", "activate"],
        "highConsequenceCapabilities": ["process"],
        "systemCapabilities": [],
        "productSystemRoots": [],
        "residualRisk": ["provenance does not prove universal safety"],
    }
    trust_inputs = {
        "schema": "kungfu.kfx-trust-inputs/v1",
        "packageRoot": package_root,
        "sourceRoot": root("1"),
        "dependencyRoot": root("2"),
        "buildPlanRoot": root("3"),
        "toolchainRoot": root("4"),
        "artifactRoot": root("5"),
        "qualificationRoot": root("6"),
        "verifierRoot": root("7"),
        "issuer": "buildchain.libkungfu.dev",
        "publisher": "kungfu-systems",
        "contractVersion": "buildchain.release/v1",
    }
    attestation = {
        "contract": "kungfu-buildchain-artifact-verification",
        "schemaVersion": 1,
        "outcome": "pass",
        "ok": True,
        "trust": "pass",
        "issuedAt": 100,
        "expiresAt": 200,
        "revoked": False,
        "subject": {"digest": root("5")},
        "passport": {"verification": {"ok": True, "trust": "pass"}},
        "match": {"artifact": {"digest": root("5")}},
        "bindings": dict(trust_inputs),
    }
    return {
        **request,
        "packageKey": "optional-view",
        "operation": "install",
        "purpose": "workspace-install",
        "cut": "cut:python-fixture",
        "assessmentTime": 150,
        "requestedCapabilities": ["domain"],
        "policy": policy,
        "trustInputs": trust_inputs,
        "kfdAssessment": {
            "schema": "kungfu.trust.assessment/v1",
            "state": "fresh",
            "assessment_key": root("a"),
            "report": {
                "report_hash": root("6"),
                "state": "fresh",
                "purpose": "workspace-install",
                "query_proof_root": root("b"),
                "contract_world": {"root": root("c")},
                "policy": {"root": root("d")},
                "fact_surfaces": [{"root": root("e")}],
            },
        },
        "attestation": attestation,
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
            "install",
            "--purpose",
            "workspace-install",
            "--cut",
            "cut:python-fixture",
            "--assessment-time",
            "150",
            "--requested-capability",
            "domain",
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
