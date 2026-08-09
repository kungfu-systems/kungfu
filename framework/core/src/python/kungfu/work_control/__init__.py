# SPDX-License-Identifier: Apache-2.0

"""Kungfu-native Work Control domain access."""

from kungfu import profile_sdk


def domain_package(runtime_dir: str | None = None):
    source = profile_sdk.discover_source("kungfu.work-control", runtime_dir or "")[
        "source"
    ]
    return profile_sdk.load_member_python_package(
        source, "work-control-actions", "domain"
    )


def domain(runtime_dir: str | None = None):
    return domain_package(runtime_dir).work_control


def initiative_bundle(runtime_dir: str | None = None):
    return domain_package(runtime_dir).initiative_bundle


def apply_intent(runtime_dir, intent_id, values):
    """Apply one native Work Control intent through its decision authority."""

    source = profile_sdk.discover_source("kungfu.work-control", runtime_dir)["source"]
    plan = profile_sdk.intent_plan(source, runtime_dir, intent_id, values)
    answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", "action-loop")
    receipt = profile_sdk.intent_apply(runtime_dir, plan, answer)
    return receipt["actionReceipt"]["coreReceipt"]


def __getattr__(name):
    return getattr(domain(), name)


def __dir__():
    return sorted(set(globals()) | set(dir(domain())))
