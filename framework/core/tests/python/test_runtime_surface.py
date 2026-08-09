# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu.action_envelope import canonical_json_bytes
from kungfu.cli.commands import kfc
from kungfu.cli.commands import runtime as _runtime_command  # noqa: F401
from kungfu.content_hash import compute_content_hash
from kungfu.execution_surface import authority as runtime_surface


ROOT_A = "sha256:" + "a" * 64
ROOT_B = "sha256:" + "b" * 64
ROOT_C = "sha256:" + "c" * 64
COMMIT = "1" * 40
TREE = "git:" + "2" * 40


def candidate(surface: str) -> dict:
    values = {
        "installed-product": {
            "providerId": "installed-kungfu",
            "surface": surface,
            "capabilities": [
                "assignment.capture",
                "assignment.seal-verify",
                "bundle.read",
                "dogfood.capture",
                "runtime.provenance",
            ],
            "executable": {
                "path": "/opt/kungfu/bin/kungfu",
                "digest": ROOT_A,
                "kind": "installed-kungfu",
                "version": "4.0.0-alpha.1",
            },
            "source": {"commit": None, "tree": None, "worktree": None},
            "bundleRoot": ROOT_B,
            "qualification": {"state": "qualified", "evidenceRoots": [ROOT_C]},
        },
        "source-checkout": {
            "providerId": "source-shifu",
            "surface": surface,
            "capabilities": [
                "dogfood.capture",
                "runtime.provenance",
                "source.build",
                "source.test",
            ],
            "executable": {
                "path": "/repo/shifu",
                "digest": ROOT_A,
                "kind": "source-shifu",
                "version": "4.0.0-alpha.1+source",
            },
            "source": {"commit": COMMIT, "tree": TREE, "worktree": "/repo"},
            "bundleRoot": None,
            "qualification": {
                "state": "source-qualified",
                "evidenceRoots": [ROOT_C],
            },
        },
        "hybrid-boundary": {
            "providerId": "xinfa-context-runtime",
            "surface": surface,
            "capabilities": [
                "context.compose",
                "dogfood.capture",
                "runtime.provenance",
            ],
            "executable": {
                "path": None,
                "digest": None,
                "kind": "composed-boundary",
                "version": None,
            },
            "source": {"commit": COMMIT, "tree": TREE, "worktree": "/repo"},
            "bundleRoot": ROOT_B,
            "qualification": {"state": "qualified", "evidenceRoots": [ROOT_C]},
        },
    }
    return copy.deepcopy(values[surface])


def request(operation: str, surface: str, candidates: list[dict]) -> dict:
    return {
        "schema": runtime_surface.REQUEST_SCHEMA,
        "operationId": operation,
        "requestedSurface": surface,
        "candidates": candidates,
        "authorityRoots": {
            "assignmentRequestRoot": ROOT_A,
            "workDefinitionRoot": ROOT_B,
            "workRoot": None,
        },
        "fallback": {"allowed": False, "reason": ""},
    }


def test_installed_assignment_receipt_is_rooted_and_explicit():
    receipt = runtime_surface.resolve(
        request(
            "assignment.capture", "installed-product", [candidate("installed-product")]
        )
    )

    assert receipt["runtimeSurface"] == "installed-product"
    assert receipt["source"] == {"commit": None, "tree": None, "worktree": None}
    assert receipt["selection"]["fallback"]["used"] is False
    assert runtime_surface.verify(receipt)["receiptRoot"] == receipt["receiptRoot"]


def test_negotiated_selection_is_deterministic_across_candidate_order():
    values = [candidate("hybrid-boundary"), candidate("source-checkout")]
    forward = runtime_surface.resolve(
        request("dogfood.capture", "capability-negotiated", values)
    )
    reverse = runtime_surface.resolve(
        request("dogfood.capture", "capability-negotiated", list(reversed(values)))
    )

    assert forward == reverse
    assert forward["runtimeSurface"] == "source-checkout"
    assert forward["selectedProvider"] == "source-shifu"


def test_fallback_requires_explicit_authorization_and_reason():
    value = request(
        "dogfood.capture", "installed-product", [candidate("source-checkout")]
    )
    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.resolve(value)
    assert rejected.value.code == "runtime-surface-fallback-forbidden"

    value["fallback"] = {"allowed": True, "reason": "qualified product unavailable"}
    receipt = runtime_surface.resolve(value)
    assert receipt["selection"]["fallback"] == {
        "allowed": True,
        "used": True,
        "from": "installed-product",
        "to": "source-checkout",
        "reason": "qualified product unavailable",
    }


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (
            lambda value: value.update(requestedSurface="windows-runner"),
            "runtime-surface-class-unknown",
        ),
        (
            lambda value: value["candidates"][0].update(
                capabilities=["runtime.provenance"]
            ),
            "runtime-surface-capability-missing",
        ),
        (
            lambda value: value["candidates"][0]["qualification"].update(
                state="unqualified"
            ),
            "runtime-surface-unqualified-evidence",
        ),
        (
            lambda value: value["candidates"].append(
                copy.deepcopy(value["candidates"][0])
            ),
            "runtime-surface-candidate-ambiguous",
        ),
    ],
)
def test_invalid_selection_inputs_fail_closed(mutation, code):
    value = request(
        "assignment.capture", "installed-product", [candidate("installed-product")]
    )
    mutation(value)
    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.resolve(value)
    assert rejected.value.code == code
    assert rejected.value.diagnosis()["nextActions"]


def test_installed_product_rejects_source_coordinates():
    value = request(
        "assignment.capture", "installed-product", [candidate("installed-product")]
    )
    value["candidates"][0]["source"] = {
        "commit": COMMIT,
        "tree": TREE,
        "worktree": "/repo",
    }
    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.resolve(value)
    assert rejected.value.code == "runtime-surface-product-source-contradiction"


def test_custom_contract_receipts_bind_the_supplied_contract_content():
    contract = runtime_surface.load_contract()
    receipt = runtime_surface.resolve(
        request(
            "assignment.capture", "installed-product", [candidate("installed-product")]
        ),
        contract=contract,
    )

    assert receipt["contractRoot"] == compute_content_hash(
        canonical_json_bytes(contract)
    )
    assert runtime_surface.verify(receipt, contract=contract)["ok"] is True


def test_hybrid_receipt_can_bind_a_checkout_free_bundle_source_cut():
    hybrid = candidate("hybrid-boundary")
    hybrid["source"]["worktree"] = None
    receipt = runtime_surface.resolve(
        request("context.consume", "hybrid-boundary", [hybrid])
    )
    assert receipt["source"]["worktree"] is None
    assert receipt["bundleRoot"] == ROOT_B


def test_receipt_tamper_and_contract_root_drift_fail_closed():
    receipt = runtime_surface.resolve(
        request("source.test", "source-checkout", [candidate("source-checkout")])
    )
    receipt["reason"] = "tampered"
    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.verify(receipt)
    assert rejected.value.code == "runtime-surface-receipt-root"


def _reroot_receipt(receipt: dict) -> None:
    body = {key: value for key, value in receipt.items() if key != "receiptRoot"}
    receipt["receiptRoot"] = compute_content_hash(canonical_json_bytes(body))


def test_re_rooted_exact_selection_tamper_fails_closed():
    receipt = runtime_surface.resolve(
        request(
            "assignment.capture", "installed-product", [candidate("installed-product")]
        )
    )
    receipt["selection"]["requestedSurface"] = "source-checkout"
    _reroot_receipt(receipt)

    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.verify(receipt)
    assert rejected.value.code == "runtime-surface-receipt-selection"


def test_re_rooted_fallback_must_bind_request_and_selected_surface():
    value = request(
        "dogfood.capture", "installed-product", [candidate("source-checkout")]
    )
    value["fallback"] = {"allowed": True, "reason": "product unavailable"}
    receipt = runtime_surface.resolve(value)
    receipt["selection"]["fallback"].update(
        allowed=False,
        **{"from": "hybrid-boundary"},
    )
    _reroot_receipt(receipt)

    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.verify(receipt)
    assert rejected.value.code == "runtime-surface-receipt-fallback"


def test_cli_resolve_and_verify_use_the_same_receipt(tmp_path: Path):
    request_path = tmp_path / "request.json"
    request_path.write_text(
        json.dumps(
            request("source.build", "source-checkout", [candidate("source-checkout")])
        ),
        encoding="utf-8",
    )
    resolved = CliRunner().invoke(
        kfc, ["runtime", "surface", "resolve", str(request_path), "--json"]
    )
    assert resolved.exit_code == 0, resolved.output
    receipt = json.loads(resolved.output)
    receipt_path = tmp_path / "receipt.json"
    receipt_path.write_text(json.dumps(receipt), encoding="utf-8")

    verified = CliRunner().invoke(
        kfc, ["runtime", "surface", "verify", str(receipt_path), "--json"]
    )
    assert verified.exit_code == 0, verified.output
    assert json.loads(verified.output)["receiptRoot"] == receipt["receiptRoot"]

    registry = json.loads(
        (
            Path(__file__).parents[2] / "src/python/kungfu/agent/kfd3_api.registry.json"
        ).read_text(encoding="utf-8")
    )
    agent_api = next(
        row for row in registry["apis"] if row["id"] == "kungfu.runtime.surface.verify"
    )
    assert agent_api["visibility"] == "public-agent"
    assert agent_api["anchor"] == {"kind": "catalog"}


def test_contract_rejects_duplicate_provider_ownership():
    contract = runtime_surface.load_contract()
    broken = copy.deepcopy(contract)
    broken["providers"].append(copy.deepcopy(broken["providers"][0]))
    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.validate_contract(broken)
    assert rejected.value.code == "runtime-surface-duplicate-ownership"


def test_contract_rejects_duplicate_surface_ownership():
    contract = runtime_surface.load_contract()
    broken = copy.deepcopy(contract)
    broken["surfaceClasses"]["source-checkout"]["owner"] = broken["surfaceClasses"][
        "installed-product"
    ]["owner"]
    with pytest.raises(runtime_surface.RuntimeSurfaceError) as rejected:
        runtime_surface.validate_contract(broken)
    assert rejected.value.code == "runtime-surface-duplicate-ownership"
