# SPDX-License-Identifier: Apache-2.0

"""Download transport, resume, and resource-safety contracts."""

from __future__ import annotations

from _distribution_update_support import *  # noqa: F403


def test_download_is_dry_run_first_resumable_and_fenced(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.tar.gz"
    artifact.write_bytes(b"verified-cli-archive")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "kungfu").write_text("fixture", "utf-8")
    manifest = _manifest(runtime)
    manifest["artifacts"].append(
        {
            "kind": "cli",
            "url": artifact.as_uri(),
            "size": artifact.stat().st_size,
            "digest": f"sha256:{hashlib.sha256(artifact.read_bytes()).hexdigest()}",
            "signature": "local-fixture-signature",
        }
    )
    plan = distribution_update.plan_download(
        manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
        allow_local_artifact=True,
    )
    preview = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=False
    )
    assert preview["executeRequired"] is True
    assert not Path(plan["target"]).exists()

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )
    assert receipt["state"] == "complete"
    assert Path(receipt["artifactPath"]).read_bytes() == artifact.read_bytes()
    repeated = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )
    assert repeated["artifactDigest"] == receipt["artifactDigest"]

    stale = {**plan, "target": str(tmp_path / "other")}
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            stale, expected_plan_id=plan["planId"], execute=False
        )
    assert error.value.code == "stale-plan"


def test_download_lock_identity_is_bound_to_target_not_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, target, _partial = _remote_download_plan(tmp_path)
    second_bytes = b"evil"
    second_artifact = {
        **first["artifact"],
        "digest": f"sha256:{hashlib.sha256(second_bytes).hexdigest()}",
    }
    second_identity = {
        "runtimeBuildId": first["manifest"]["runtimeBuildId"],
        "artifactUrl": second_artifact["url"],
        "artifactSize": second_artifact["size"],
        "artifactDigest": second_artifact["digest"],
        "target": first["target"],
    }
    second = {
        **first,
        "artifact": second_artifact,
        "planId": distribution_update._stable_id(
            "product-download-plan", second_identity
        ),
    }
    lock_names = []

    def held(_root, name, **_kwargs):
        lock_names.append(name)
        return contextlib.nullcontext()

    monkeypatch.setattr(distribution_update.coordination_locks, "held", held)
    target.parent.mkdir(parents=True)
    target.write_bytes(b"good")
    distribution_update.download(first, expected_plan_id=first["planId"], execute=True)
    target.write_bytes(second_bytes)
    distribution_update.download(
        second, expected_plan_id=second["planId"], execute=True
    )

    assert first["planId"] != second["planId"]
    assert len(lock_names) == 2
    assert lock_names[0] == lock_names[1]


def test_download_stops_before_streaming_past_declared_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(b"oversized-candidate"),
    )
    partial = tmp_path / "candidate.part"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update._download_to_partial(
            "https://example.invalid/candidate.tar.gz",
            partial,
            expected_size=4,
        )

    assert error.value.code == "artifact-verification-failed"
    assert partial.stat().st_size <= 4


def test_download_discards_complete_partial_when_stream_exceeds_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)

    class ChunkedResponse(_Response):
        def read(self, size: int = -1) -> bytes:
            return super().read(min(size, 4))

    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: ChunkedResponse(b"goodx"),
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-verification-failed"
    assert not target.exists()
    assert not partial.exists()


def test_download_discards_full_digest_mismatch_and_recovers_next_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    responses = iter([_Response(b"evil"), _Response(b"good")])
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: next(responses),
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-verification-failed"
    assert not target.exists()
    assert not partial.exists()

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"


def test_download_discards_oversized_partial_before_restarting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    partial.parent.mkdir(parents=True)
    partial.write_bytes(b"oversized")
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(b"good"),
    )

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"
    assert not partial.exists()


def test_download_preserves_incomplete_partial_for_exact_range_resume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    responses = iter(
        [
            _Response(b"go"),
            _Response(
                b"od",
                status=206,
                headers={"Content-Range": "bytes 2-3/4"},
            ),
        ]
    )
    requests = []

    def open_https(request, **_kwargs):
        requests.append(request)
        return next(responses)

    monkeypatch.setattr(distribution_update, "_open_https", open_https)

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-verification-failed"
    assert partial.read_bytes() == b"go"

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert requests[1].get_header("Range") == "bytes=2-"
    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"
    assert not partial.exists()


def test_download_recovers_from_disk_full_using_retained_partial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    responses = iter(
        [
            _Response(b"good"),
            _Response(
                b"od",
                status=206,
                headers={"Content-Range": "bytes 2-3/4"},
            ),
        ]
    )
    requests = []
    copy_bounded_download = distribution_update._copy_bounded_download
    fail_write = True

    def open_https(request, **_kwargs):
        requests.append(request)
        return next(responses)

    def copy_with_disk_full(input_file, output_file, **kwargs):
        nonlocal fail_write
        if fail_write:
            fail_write = False
            output_file.write(b"go")
            raise OSError(errno.ENOSPC, "No space left on device")
        copy_bounded_download(input_file, output_file, **kwargs)

    monkeypatch.setattr(distribution_update, "_open_https", open_https)
    monkeypatch.setattr(
        distribution_update,
        "_copy_bounded_download",
        copy_with_disk_full,
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-download-failed"
    assert not target.exists()
    assert partial.read_bytes() == b"go"

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert requests[1].get_header("Range") == "bytes=2-"
    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"
    assert not partial.exists()


def test_remote_manifest_rejects_redirect_to_insecure_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(
            b"{}", url="http://mirror.invalid/release.json"
        ),
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.load_release_manifest(
            "https://example.invalid/release.json"
        )

    assert error.value.code == "manifest-transport-insecure"


def test_https_redirect_handler_rejects_an_insecure_intermediate_hop() -> None:
    handler = distribution_update._HttpsOnlyRedirectHandler(
        code="manifest-transport-insecure",
        message="release manifest redirect requires HTTPS",
    )
    request = distribution_update.urllib.request.Request(
        "https://example.invalid/release.json"
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "http://mirror.invalid/release.json",
        )

    assert error.value.code == "manifest-transport-insecure"


def test_https_redirect_handler_allows_a_secure_intermediate_hop() -> None:
    handler = distribution_update._HttpsOnlyRedirectHandler(
        code="manifest-transport-insecure",
        message="release manifest redirect requires HTTPS",
    )
    request = distribution_update.urllib.request.Request(
        "https://example.invalid/release.json"
    )

    redirected = handler.redirect_request(
        request,
        None,
        302,
        "Found",
        {},
        "https://mirror.invalid/release.json",
    )

    assert redirected.full_url == "https://mirror.invalid/release.json"


def test_artifact_download_rejects_redirect_to_insecure_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(
            b"abcd", url="http://mirror.invalid/candidate.tar.gz"
        ),
    )
    partial = tmp_path / "candidate.part"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update._download_to_partial(
            "https://example.invalid/candidate.tar.gz",
            partial,
            expected_size=4,
        )

    assert error.value.code == "artifact-transport-insecure"
    assert not partial.exists()


@pytest.mark.parametrize(
    "content_range",
    [None, "bytes 0-1/4", "bytes 2-3/5", "bytes */4"],
)
def test_artifact_resume_rejects_unbound_content_range(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    content_range: str | None,
) -> None:
    headers = {"Content-Range": content_range} if content_range is not None else {}
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(b"cd", status=206, headers=headers),
    )
    partial = tmp_path / "candidate.part"
    partial.write_bytes(b"ab")

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update._download_to_partial(
            "https://example.invalid/candidate.tar.gz",
            partial,
            expected_size=4,
        )

    assert error.value.code == "artifact-verification-failed"
    assert partial.read_bytes() == b"ab"


def test_artifact_resume_appends_only_the_exact_remaining_range(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(
            b"cd",
            status=206,
            headers={"Content-Range": "bytes 2-3/4"},
        ),
    )
    partial = tmp_path / "candidate.part"
    partial.write_bytes(b"ab")

    distribution_update._download_to_partial(
        "https://example.invalid/candidate.tar.gz",
        partial,
        expected_size=4,
    )

    assert partial.read_bytes() == b"abcd"


@pytest.mark.parametrize("execute", [False, True])
def test_apply_rejects_declared_size_drift_before_inventory_write(
    tmp_path: Path, execute: bool
) -> None:
    archive, manifest = _archive(tmp_path)
    artifact = next(item for item in manifest["artifacts"] if item["kind"] == "cli")
    artifact["size"] += 1

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            archive,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=artifact["digest"],
            execute=execute,
        )

    assert error.value.code == "artifact-verification-failed"
    assert not (tmp_path / "config").exists()


@pytest.mark.parametrize("archive_format", ["tar", "zip"])
@pytest.mark.parametrize("limit", ["entries", "expanded-bytes"])
@pytest.mark.parametrize("execute", [False, True])
def test_apply_rejects_archive_resource_exhaustion_before_inventory_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    archive_format: str,
    limit: str,
    execute: bool,
) -> None:
    _valid_archive, manifest = _archive(tmp_path)
    candidate = tmp_path / f"resource-exhaustion.{archive_format}"
    members = [("one.bin", b"1"), ("two.bin", b"22")]
    if archive_format == "tar":
        source = tmp_path / "resource-source"
        source.mkdir()
        for name, payload in members:
            (source / name).write_bytes(payload)
        with tarfile.open(candidate, "w") as output:
            for name, _payload in members:
                output.add(source / name, arcname=name)
    else:
        with zipfile.ZipFile(
            candidate, "w", compression=zipfile.ZIP_DEFLATED
        ) as output:
            for name, payload in members:
                output.writestr(name, payload)
    if limit == "entries":
        monkeypatch.setattr(distribution_update, "_MAX_ARCHIVE_ENTRIES", 1)
    else:
        monkeypatch.setattr(distribution_update, "_MIN_ARCHIVE_EXPANDED_BYTES", 1)
        monkeypatch.setattr(distribution_update, "_MAX_ARCHIVE_EXPANDED_BYTES", 1)
        monkeypatch.setattr(distribution_update, "_MAX_ARCHIVE_EXPANSION_RATIO", 1)
    artifact = next(item for item in manifest["artifacts"] if item["kind"] == "cli")
    artifact["size"] = candidate.stat().st_size
    artifact["digest"] = f"sha256:{hashlib.sha256(candidate.read_bytes()).hexdigest()}"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            candidate,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=artifact["digest"],
            execute=execute,
        )

    assert error.value.code == "archive-resource-limit"
    assert not (tmp_path / "config").exists()
