# SPDX-License-Identifier: Apache-2.0

import pykungfu
import pytest


def _writer(tmp_path):
    runtime = pykungfu.runtime
    yijinjing = pykungfu.yijinjing
    location = runtime.location(
        yijinjing.enums.mode.LIVE,
        yijinjing.enums.location_role.SYSTEM,
        "mmap_test",
        "python_writer",
        runtime.locator(str(tmp_path)),
    )
    target = runtime.writer(
        location,
        0,
        runtime.noop_publisher(),
        False,
        runtime.bus(False),
        2,
    )
    return runtime, location, target


def test_writer_derives_length_from_contiguous_bytes_like_payload(tmp_path):
    runtime, location, target = _writer(tmp_path)

    target.write_bytes(1, 2001, b"abc")
    target.write_bytes(2, 2002, memoryview(b"def"))

    first = list(runtime.assemble(location, 0).read_bytes(2001))
    second = list(runtime.assemble(location, 0).read_bytes(2002))
    assert bytes(first[0][1]).startswith(b"abc")
    assert bytes(second[0][1]).startswith(b"def")


def test_writer_legacy_length_mismatch_is_stable_and_recoverable(tmp_path):
    runtime, location, target = _writer(tmp_path)

    with pytest.raises(
        RuntimeError,
        match=r"Writer byte length 1 does not match the 2 byte container",
    ):
        target.write_bytes(1, 2101, [1, 2], 1)
    with pytest.raises(
        RuntimeError,
        match=r"Writer byte length 3 does not match the 2 byte container",
    ):
        target.write_bytes(2, 2102, [1, 2], 3)

    target.write_bytes(3, 2103, b"ok")
    recovered = list(runtime.assemble(location, 0).read_bytes(2103))
    assert bytes(recovered[0][1]).startswith(b"ok")


def test_writer_rejects_noncontiguous_buffer_before_writing(tmp_path):
    runtime, location, target = _writer(tmp_path)

    with pytest.raises(
        ValueError,
        match=r"contiguous one-dimensional bytes-like buffer",
    ):
        target.write_bytes(1, 2201, memoryview(b"abcdef")[::2])

    target.write_bytes(2, 2202, b"recovered")
    recovered = list(runtime.assemble(location, 0).read_bytes(2202))
    assert bytes(recovered[0][1]).startswith(b"recovered")
