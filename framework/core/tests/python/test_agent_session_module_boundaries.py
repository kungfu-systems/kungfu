# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

from kungfu.agent.managed_run import ManagedRunCoordinator
from kungfu.agent.native_launch import NativeLaunchCoordinator
from kungfu.agent.provider_bootstrap import ProviderBootstrapAdapter
from kungfu.agent.run_intent import RunIntentDispatcher
from kungfu.agent.runtime_profile_catalog import RuntimeProfileCatalog
from kungfu.agent.runtime_profile_store import RuntimeProfileStore
from kungfu.agent.verification_probe import VerificationProbe


ROOT = Path(__file__).resolve().parents[2]


def test_run_intent_dispatcher_keeps_native_and_managed_paths_explicit():
    dispatcher = RunIntentDispatcher()
    native = {
        "task": None,
        "work_selector": None,
        "workspace_root": None,
        "plan_only": False,
        "as_json": False,
        "events_json": False,
        "expected_plan_root": None,
        "allow_foreign_binding": False,
    }
    assert dispatcher.provider_mode(native) == "native"
    assert dispatcher.provider_mode({**native, "workspace_root": "/project"}) == (
        "managed"
    )
    assert (
        dispatcher.dispatch_provider(
            request=native, native=lambda: "native", managed=lambda: "managed"
        )
        == "native"
    )


def test_python_session_services_are_import_closed_and_bounded():
    assert all(
        value is not None
        for value in (
            NativeLaunchCoordinator,
            ManagedRunCoordinator,
            RuntimeProfileCatalog,
            ProviderBootstrapAdapter,
            VerificationProbe,
            RuntimeProfileStore,
        )
    )
    agent_root = ROOT / "src" / "python" / "kungfu" / "agent"
    budgets = {
        agent_root / "run_agent.py": 1450,
        agent_root / "runtime_profiles.py": 650,
        ROOT / "src" / "python" / "kungfu" / "cli" / "commands" / "run.py": 900,
    }
    for source, maximum in budgets.items():
        assert len(source.read_text(encoding="utf-8").splitlines()) <= maximum
    assert "kungfu.cli" not in (agent_root / "native_launch.py").read_text(
        encoding="utf-8"
    )
    assert "kungfu.cli" not in (agent_root / "managed_run.py").read_text(
        encoding="utf-8"
    )
