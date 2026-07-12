# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import ctypes
import json
import os
import sys
from pathlib import Path
from typing import Any

ABI_V1 = 1
CAP_EPISODE_LIFECYCLE = 1 << 0
CAP_HEAD_AND_HISTORICAL_QUERY = 1 << 1
CAP_FSCK = 1 << 2
CAP_EXPORT = 1 << 3
CAP_DOMAIN_FACT_ADMISSION = 1 << 4
CAP_TRUST_ASSESSMENT = 1 << 5
REQUIRED_CAPABILITIES = (
    CAP_EPISODE_LIFECYCLE | CAP_HEAD_AND_HISTORICAL_QUERY | CAP_FSCK | CAP_EXPORT
)
_OK = 0


class _ContextConfigV1(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("runtime_dir", ctypes.c_char_p),
        ("reserved", ctypes.c_uint64 * 4),
    ]


class _ResultV1(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32),
        ("json_data", ctypes.c_void_p),
        ("json_size", ctypes.c_size_t),
        ("token", ctypes.c_uint64),
    ]


_ContextOpen = ctypes.CFUNCTYPE(
    ctypes.c_int32, ctypes.POINTER(_ContextConfigV1), ctypes.POINTER(ctypes.c_void_p)
)
_ContextCapabilities = ctypes.CFUNCTYPE(
    ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint64)
)
_ContextLastError = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_void_p),
    ctypes.POINTER(ctypes.c_size_t),
)
_ContextClose = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)
_Execute = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_size_t,
    ctypes.POINTER(_ResultV1),
)
_ReleaseResult = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint64)


class _ApiV1(ctypes.Structure):
    _fields_ = [
        ("abi_version", ctypes.c_uint32),
        ("struct_size", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint64),
        ("context_open", _ContextOpen),
        ("context_capabilities", _ContextCapabilities),
        ("context_last_error", _ContextLastError),
        ("context_close", _ContextClose),
        ("execute", _Execute),
        ("release_result", _ReleaseResult),
    ]


class NativeStorageError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"{message} (libkungfu status {status})")
        self.status = status


def _library_path() -> Path:
    root = Path(__file__).resolve().parent
    if sys.platform == "darwin":
        return root / "libkungfu.dylib"
    if sys.platform == "win32":
        return root / "kungfu.dll"
    return root / "libkungfu.so"


class NativeStorage:
    def __init__(self, runtime_dir: str | os.PathLike[str]):
        library_path = _library_path()
        if not library_path.is_file():
            raise NativeStorageError(-1, f"native library is missing: {library_path}")
        self._library = ctypes.CDLL(str(library_path))
        get_api = self._library.kungfu_native_storage_get_api
        get_api.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(_ApiV1)]
        get_api.restype = ctypes.c_int32
        self._api = _ApiV1()
        status = get_api(ABI_V1, ctypes.sizeof(self._api), ctypes.byref(self._api))
        if status != _OK:
            raise NativeStorageError(status, "native storage ABI negotiation failed")
        if self._api.abi_version != ABI_V1:
            raise NativeStorageError(-1, "libkungfu returned the wrong ABI version")

        encoded = os.fspath(runtime_dir).encode("utf-8")
        config = _ContextConfigV1(
            struct_size=ctypes.sizeof(_ContextConfigV1),
            flags=0,
            runtime_dir=encoded,
        )
        self._context = ctypes.c_void_p()
        status = self._api.context_open(
            ctypes.byref(config), ctypes.byref(self._context)
        )
        if status != _OK or not self._context:
            raise NativeStorageError(status, "native storage context open failed")

    @property
    def capabilities(self) -> int:
        value = ctypes.c_uint64()
        status = self._api.context_capabilities(self._context, ctypes.byref(value))
        if status != _OK:
            raise self._error(status, "capability discovery failed")
        return value.value

    def execute(self, operation: str, request: dict[str, Any]) -> dict[str, Any]:
        operation_bytes = operation.encode("utf-8")
        request_bytes = json.dumps(request, separators=(",", ":")).encode("utf-8")
        result = _ResultV1(struct_size=ctypes.sizeof(_ResultV1))
        status = self._api.execute(
            self._context,
            operation_bytes,
            request_bytes,
            len(request_bytes),
            ctypes.byref(result),
        )
        if status != _OK:
            raise self._error(status, "native storage operation failed")
        if not result.json_data or not result.json_size or not result.token:
            raise NativeStorageError(-1, "libkungfu returned an invalid result view")
        try:
            payload = ctypes.string_at(result.json_data, result.json_size)
            return dict(json.loads(payload))
        finally:
            release_status = self._api.release_result(self._context, result.token)
            if release_status != _OK:
                raise self._error(release_status, "result release failed")

    def close(self) -> None:
        if not getattr(self, "_context", None):
            return
        status = self._api.context_close(self._context)
        if status != _OK:
            raise self._error(status, "native storage context close failed")
        self._context = ctypes.c_void_p()

    def _error(self, status: int, fallback: str) -> NativeStorageError:
        data = ctypes.c_void_p()
        size = ctypes.c_size_t()
        if (
            self._api.context_last_error(
                self._context, ctypes.byref(data), ctypes.byref(size)
            )
            == _OK
            and data.value
        ):
            return NativeStorageError(
                status, ctypes.string_at(data.value, size.value).decode("utf-8")
            )
        return NativeStorageError(status, fallback)

    def __enter__(self) -> NativeStorage:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
