# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

import pytest

from kungfu.storage import service


CORPUS = json.loads(
    (
        Path(__file__).parents[4]
        / "tests/fixtures/storage-synthetic-source/vectors.json"
    ).read_text(encoding="utf-8")
)


def test_synthetic_source_fixture_matches_exact_vector(monkeypatch, tmp_path) -> None:
    case = CORPUS["case"]
    writes: list[dict[str, str]] = []
    accepted: list[dict[str, object]] = []

    def capture_write(runtime_dir, digest, raw):
        writes.append({"digest": digest, "utf8": raw.decode("utf-8")})
        return "fixture://payload"

    def capture_manifest(runtime_dir, manifest):
        accepted.append(manifest)
        return {"ok": True}

    monkeypatch.setattr(service, "write_payload_bytes", capture_write)
    monkeypatch.setattr(service, "accept_manifest", capture_manifest)

    assert service.write_synthetic_source(
        tmp_path,
        source_id=case["sourceId"],
        manifest_id=case["manifestId"],
        source_head=case["sourceHead"],
        range_filter=case["range"],
        records=case["records"],
    ) == {"ok": True}
    assert writes == case["expectedPayloadWrites"]
    assert accepted == [case["expectedManifest"]]


@pytest.mark.parametrize("vector", CORPUS["rejected"], ids=lambda row: row["id"])
def test_synthetic_source_fixture_rejects_unknown_state(
    vector: dict[str, str], tmp_path
) -> None:
    with pytest.raises(ValueError, match="unsupported synthetic payload state"):
        service.write_synthetic_source(
            tmp_path,
            source_id="fixture",
            records=[{"payload_state": vector["payloadState"]}],
        )
