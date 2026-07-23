# SPDX-License-Identifier: Apache-2.0

"""Shadow-compare Action Geometry / Domain Profile / Profile against golden fixtures.

Mode: ``compare-without-authority-selection`` — read-only parity checks that do
not select or mutate write authority.

Authority for public APIs already forwards to the native ``action_runtime`` edge
when ``kernel is None`` (stage-7 flip). This suite proves the live edge still
matches the Python-recorded characterization corpus byte-for-byte, and that the
residual Python orchestration path (injected ``kernel=``) still matches the same
corpus when kernel I/O is replayed.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

if importlib.util.find_spec("pykungfu") is None:
    pytest.skip("native pykungfu binding is not built", allow_module_level=True)

from kungfu.agent import action_geometry, domain_profile, work_profile  # noqa: E402
from kungfu.storage import service as storage_service  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURES = (
    REPO_ROOT
    / "framework"
    / "core"
    / "src"
    / "libkungfu"
    / "tests"
    / "fixtures"
    / "action-geometry"
)
SHADOW_MODE = "compare-without-authority-selection"


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _load_fixture(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _fixture_paths() -> list[Path]:
    return sorted(FIXTURES.glob("*.json"))


def _compare(case: str, actual: Any, expected: Any) -> dict[str, Any]:
    actual_bytes = _canonical(actual)
    expected_bytes = _canonical(expected)
    ok = actual_bytes == expected_bytes
    return {
        "mode": SHADOW_MODE,
        "case": case,
        "ok": ok,
        "counts": {
            "mismatch": 0 if ok else 1,
            "missing": 0,
            "extra": 0,
            "stale": 0,
            "divergent": 0,
        },
        "actual": actual_bytes,
        "expected": expected_bytes,
    }


class ReplayKernel:
    """Replay golden ``kernel_io`` and check emitted requests byte-for-byte."""

    def __init__(self, kernel_io: list[dict[str, Any]]) -> None:
        self._io = kernel_io
        self.index = 0

    def __call__(
        self,
        runtime_dir: str | Path,
        action: str,
        request: dict[str, Any] | None,
    ) -> dict[str, Any]:
        assert self.index < len(self._io), f"extra kernel call: {action}"
        expected = self._io[self.index]
        self.index += 1
        assert expected["action"] == action, (
            f"kernel action mismatch at #{self.index - 1}: "
            f"actual={action} expected={expected['action']}"
        )
        expected_request = expected.get("request") or {}
        actual_request = request or {}
        assert _canonical(actual_request) == _canonical(expected_request), (
            f"kernel request mismatch at #{self.index - 1} action={action}\n"
            f"  actual  : {_canonical(actual_request)}\n"
            f"  expected: {_canonical(expected_request)}"
        )
        return dict(expected["response"])


def _run_native_pure(fixture: dict[str, Any]) -> Any:
    kind = fixture["kind"]
    payload = fixture["input"]
    if kind == "geometry_evaluate":
        return action_geometry.evaluate(
            payload["responsibilityIds"],
            inference_claims=payload.get("inferenceClaims") or (),
        )
    if kind == "geometry_session_refinement":
        return action_geometry.evaluate_session_refinement(
            payload["before"], payload["after"]
        )
    if kind == "domain_roots":
        return domain_profile.roots()
    if kind == "domain_role_bindings":
        return domain_profile.role_bindings(payload["role"])
    if kind == "validate_role_body":
        return domain_profile.validate_role_body(
            payload["body"],
            allow_legacy=bool(payload.get("allow_legacy", True)),
        )
    if kind == "capabilities":
        return work_profile.capabilities()
    raise AssertionError(f"unsupported pure kind: {kind}")


@pytest.mark.parametrize("path", _fixture_paths(), ids=lambda p: p.stem)
def test_golden_shadow_matches_live_paths(path: Path) -> None:
    fixture = _load_fixture(path)
    kind = fixture["kind"]
    case = fixture["case"]
    expected = fixture["output"]

    if kind in {
        "geometry_evaluate",
        "geometry_session_refinement",
        "domain_roots",
        "domain_role_bindings",
        "validate_role_body",
        "capabilities",
    }:
        actual = _run_native_pure(fixture)
        report = _compare(case, actual, expected)
        assert report["ok"], (
            f"{case}: native edge diverged from golden\n"
            f"  actual  : {report['actual']}\n"
            f"  expected: {report['expected']}"
        )
        if kind == "geometry_evaluate":
            reference = action_geometry.evaluate_python(
                fixture["input"]["responsibilityIds"],
                inference_claims=list(fixture["input"].get("inferenceClaims") or ()),
            )
            dual = _compare(f"{case}/python-vs-native", actual, reference)
            assert dual["ok"], (
                f"{case}: python reference vs native shadow mismatch\n"
                f"  native   : {dual['actual']}\n"
                f"  reference: {dual['expected']}"
            )
        return

    if kind == "apply_action":
        execute = bool(fixture.get("execute", False))
        kernel_io = list(fixture.get("kernel_io") or [])
        if not kernel_io:
            # No kernel traffic: native public path is the live authority.
            actual = work_profile.apply_action(
                "/runtime", fixture["input"], execute=execute
            )
            report = _compare(case, actual, expected)
            assert report["ok"], (
                f"{case}: native apply_action diverged from golden\n"
                f"  actual  : {report['actual']}\n"
                f"  expected: {report['expected']}"
            )
            return

        # Residual Python orchestration with replayed kernel I/O.
        kernel = ReplayKernel(kernel_io)
        actual = work_profile.apply_action(
            "/runtime",
            fixture["input"],
            execute=execute,
            kernel=kernel,
        )
        assert kernel.index == len(kernel_io), (
            f"{case}: missing kernel calls (used {kernel.index} of {len(kernel_io)})"
        )
        report = _compare(case, actual, expected)
        assert report["ok"], (
            f"{case}: python+replay diverged from golden\n"
            f"  actual  : {report['actual']}\n"
            f"  expected: {report['expected']}"
        )
        return

    if kind == "inspect":
        kernel_io = list(fixture.get("kernel_io") or [])
        kernel = ReplayKernel(kernel_io)
        actual = work_profile.inspect(
            "/runtime",
            fixture["input"]["refName"],
            kernel=kernel,
        )
        assert kernel.index == len(kernel_io), f"{case}: missing kernel calls"
        report = _compare(case, actual, expected)
        assert report["ok"], (
            f"{case}: python+replay inspect diverged from golden\n"
            f"  actual  : {report['actual']}\n"
            f"  expected: {report['expected']}"
        )
        return

    raise AssertionError(f"unhandled fixture kind: {kind}")


def test_authority_flip_public_apply_uses_action_runtime(monkeypatch) -> None:
    """Public apply_action (no kernel=) must forward to the native edge."""

    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_action_runtime(runtime_dir, action, request=None):
        calls.append((action, dict(request or {})))
        return {
            "schema": work_profile.RECEIPT_SCHEMA,
            "actionId": "shadow-probe",
            "status": "denied",
            "failureCode": "invalid-request",
            "message": "shadow probe",
            "details": {},
            "steps": [],
            "writeOccurred": False,
            "refWriteOccurred": False,
            "residualRisk": [],
        }

    monkeypatch.setattr(storage_service, "action_runtime", fake_action_runtime)
    receipt = work_profile.apply_action(
        "/runtime",
        {
            "schema": work_profile.ACTION_SCHEMA,
            "actionId": "shadow-probe",
            "refName": "profiles/shadow/probe",
            "basis": {"cutRoot": None, "revision": 0},
            "ref": {"cutRoot": None, "revision": 0},
            "subject": {
                "role": "fact",
                "operation": "create",
                "fromState": "absent",
                "toState": "declared",
            },
            "responsibilities": {
                role: {"objectId": f"fact:{index:032x}", "expectedVersionRoot": None}
                for index, role in enumerate(work_profile.ROLES, start=1)
            },
            "roleInputs": {},
            "relations": [],
            "support": {
                "createdByReceiptRoot": "sha256:" + "1" * 64,
                "schemaRoot": "sha256:" + "2" * 64,
                "declarationRoots": ["sha256:" + "3" * 64],
                "admissionRoots": ["sha256:" + "4" * 64],
                "reasonRoot": "sha256:" + "5" * 64,
            },
        },
        execute=False,
    )
    assert calls and calls[0][0] == "apply_action"
    assert receipt["actionId"] == "shadow-probe"
    assert receipt["status"] == "denied"


def test_edge_capabilities_discovery() -> None:
    caps = storage_service.action_runtime("", "edge_capabilities")
    assert caps["operation"] == "action_runtime"
    assert caps["owner"] == "libkungfu/runtime/action"
    assert "apply_action" in caps["actions"]
    assert "evaluate" in caps["actions"]
