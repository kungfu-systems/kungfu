#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu kfx install` / `list` disclose only Core-derived authority. Identity
# and Product System roles are metadata and cannot select a runtime placement.

from kungfu.cli.commands import kfx


def test_notice_reports_only_core_authority_and_exact_grant():
    package = {
        "supplyChainGrade": "kfd-attested",
        "admissionGrade": "product-system",
        "runtimeTier": "isolated",
        "grantedCapabilities": ["domain"],
        "productRoles": ["boot-critical"],
        "authority": {"capabilityGrantRoot": "sha256:grant"},
    }
    out = "\n".join(kfx._authority_notice(package))
    assert "supply-chain=kfd-attested" in out
    assert "runtime=isolated" in out
    assert "capabilityGrantRoot: sha256:grant" in out
    assert "assembly metadata only" in out
    assert "node-integrated" not in out
    assert "may inject" not in out


def test_identity_labels_do_not_change_notice_authority():
    base = {
        "runtimeTier": "isolated",
        "grantedCapabilities": [],
        "productRoles": [],
    }
    first_party = "\n".join(kfx._authority_notice({**base, "firstParty": True}))
    third_party = "\n".join(kfx._authority_notice({**base, "firstParty": False}))
    assert first_party == third_party
