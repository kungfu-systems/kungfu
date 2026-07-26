import json

from click.testing import CliRunner

from kungfu.cli.commands import kfc
from kungfu.cli.commands import __registry__ as _command_registry  # noqa: F401
from kungfu import release_verifier


def unavailable():
    return {
        "schema": "kungfu.release-status/v1",
        "status": "unavailable",
        "releasedUseClaim": False,
        "reason": "no-site-owned-qualified-bundle-pin",
        "documentationUrl": "https://kungfu.tech/install/",
        "release": None,
        "acquisitionEvidence": None,
        "legalBoundary": {
            "firstUseDateClaim": None,
            "legalConclusion": "not-made",
            "registrationStatusClaim": "none",
        },
    }


def current():
    value = unavailable()
    value.update(
        {
            "status": "current-release",
            "releasedUseClaim": True,
            "reason": "signed-publication-and-readback-qualified",
            "release": {
                "sourceSha": "a" * 40,
                "siteSourceSha": "b" * 40,
                "tag": "v4.0.0-alpha.1",
                "channel": "alpha",
                "version": "4.0.0-alpha.1",
                "channelPayloadRoot": "sha256:" + "1" * 64,
                "releasePassport": {
                    "ref": "buildchain:release-passport/example",
                    "root": "sha256:" + "2" * 64,
                },
            },
            "acquisitionEvidence": {
                "url": (
                    "https://kungfu.tech/.well-known/kungfu/"
                    "ungfu-release-acquisition.json"
                ),
                "root": "sha256:" + "3" * 64,
            },
        }
    )
    return value


def receipt_set():
    bindings = {
        "sourceSha": "a" * 40,
        "siteSourceSha": "b" * 40,
        "tag": "v4.0.0-alpha.1",
        "channel": "alpha",
        "version": "4.0.0-alpha.1",
        "environment": "shadow",
        "artifactSetRoot": "sha256:" + "1" * 64,
    }
    binding_root = release_verifier._activation_root(bindings)
    value = {
        "schema": "kungfu-buildchain-release-activation-receipt-set/v1",
        "transactionId": "shadow-test",
        "transactionRoot": "sha256:" + "2" * 64,
        "mode": "shadow",
        "releasedUseClaim": False,
        "bindings": bindings,
        "receipts": [
            {
                "kind": kind,
                "root": f"sha256:{index:064x}",
                "bindingRoot": binding_root,
                "locator": f"fixture:{kind}",
            }
            for index, kind in enumerate(
                [
                    "artifact-publication",
                    "release-passport",
                    "site-publication",
                    "public-readback",
                    "product-qualification",
                ],
                start=3,
            )
        ],
        "legalBoundary": {
            "firstUseDateClaim": None,
            "legalConclusion": "not-made",
            "registrationStatusClaim": "none",
        },
    }
    value["receiptSetRoot"] = release_verifier._activation_root(value)
    return value


def test_unavailable_status_is_truthful_and_understandable(tmp_path):
    subject = tmp_path / "status.json"
    subject.write_text(json.dumps(unavailable()), encoding="utf-8")
    result = CliRunner().invoke(kfc, ["release", "status", "--source", str(subject)])
    assert result.exit_code == 0, result.output
    assert "VERIFIED, NOT AVAILABLE" in result.output
    assert "What this proves:" in result.output
    assert "What this does not prove:" in result.output


def test_current_status_has_stable_json(tmp_path):
    subject = tmp_path / "status.json"
    subject.write_text(json.dumps(current()), encoding="utf-8")
    result = CliRunner().invoke(kfc, ["release", "verify", str(subject), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema"] == "kungfu.release-verification-result/v1"
    assert payload["verified"] is True
    assert payload["releaseAvailable"] is True
    assert payload["version"] == "4.0.0-alpha.1"
    assert payload["sourceSha"] == "a" * 40
    assert payload["siteSourceSha"] == "b" * 40


def test_partial_or_stale_status_fails_closed(tmp_path):
    value = current()
    value["acquisitionEvidence"]["root"] = "sha256:stale"
    subject = tmp_path / "status.json"
    subject.write_text(json.dumps(value), encoding="utf-8")
    result = CliRunner().invoke(kfc, ["release", "verify", str(subject)])
    assert result.exit_code == 4
    assert "REJECTED" in result.output
    assert "must not be used as release proof" in result.output


def test_explanation_names_non_claims():
    result = CliRunner().invoke(kfc, ["release", "explain", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["officialStatusUrl"] == release_verifier.OFFICIAL_STATUS_URL
    assert "first-use date" in payload["notClaims"]


def test_shadow_receipt_set_verifies_roots_without_claiming_release(tmp_path):
    value = receipt_set()
    subject = tmp_path / "receipt-set.json"
    subject.write_text(json.dumps(value), encoding="utf-8")
    result = CliRunner().invoke(kfc, ["release", "verify", str(subject), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["verified"] is True
    assert payload["releaseAvailable"] is False
    assert payload["state"] == "shadow"

    value["receipts"][0]["locator"] = "fixture:changed"
    subject.write_text(json.dumps(value), encoding="utf-8")
    rejected = CliRunner().invoke(kfc, ["release", "verify", str(subject)])
    assert rejected.exit_code == 4
    assert "receiptSetRoot does not match receipt bytes" in rejected.output
