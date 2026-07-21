# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import ctypes
import json
import os
import sys
from collections.abc import Mapping
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
_INTERFACE_LEDGER_ACTION = 3
_INTERFACE_MAINTENANCE = 4

_LEDGER_OPERATIONS = {
    "fact_kernel": 1,
    "fact_query": 2,
    "fact_contract": 3,
    "fact_declare_world": 4,
    "fact_declare_surface": 5,
    "fact_observe": 6,
    "fact_state": 7,
    "fact_library_contract": 8,
    "fact_type_create": 9,
    "fact_type_list": 10,
    "fact_material_put": 11,
    "fact_material_list": 12,
    "fact_library_export": 13,
    "fact_library_import": 14,
    "episode_begin": 16,
    "episode_heartbeat": 17,
    "episode_end": 18,
    "episode_abort": 19,
    "episode_attach_frame": 20,
    "episode_attach_ref": 21,
    "episode_list": 22,
    "episode_inspect": 23,
    "episode_recover": 24,
    "episode_recovery_plan": 25,
    "episode_recovery_execute": 26,
    "assessment_contract": 40,
    "assessment_request": 41,
    "assessment_execute": 42,
    "assessment_status": 43,
    "trust_require": 44,
    "assessment_list": 45,
    "assessment_invalidate": 46,
}
_MAINTENANCE_OPERATIONS = {
    "status": 1,
    "fsck": 2,
    "repair_plan": 3,
    "repair_apply": 4,
    "gc_plan": 5,
    "compact_plan": 6,
    "export_bundle": 7,
    "import_bundle": 8,
    "rebuild_index": 9,
    "backend_status": 10,
    "backend_switch": 11,
    "backend_rollback": 12,
    "episode_projection_rebuild": 13,
}
_ROOT_ENV = {
    "fact_cut_root": "KUNGFU_FACT_CUT_ROOT",
    "pursuit_root": "KUNGFU_PURSUIT_ROOT",
    "atlas_root": "KUNGFU_ATLAS_ROOT",
    "warrant_root": "KUNGFU_WARRANT_ROOT",
    "candidate_action_root": "KUNGFU_CANDIDATE_ACTION_ROOT",
    "preconditions_root": "KUNGFU_PRECONDITIONS_ROOT",
    "resources_root": "KUNGFU_RESOURCES_ROOT",
}


class _ContextConfigV1(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("runtime_dir", ctypes.c_char_p),
        ("stream_root", ctypes.c_char_p),
        ("host_namespace", ctypes.c_char_p),
        ("host_name", ctypes.c_char_p),
        ("mode", ctypes.c_uint8),
        ("reserved0", ctypes.c_uint8 * 7),
        ("default_timeout_ms", ctypes.c_uint64),
        ("reserved1", ctypes.c_uint64 * 3),
    ]


class _SemanticMessageV1(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("protocol_id", ctypes.c_char_p),
        ("protocol_version", ctypes.c_uint32),
        ("reserved0", ctypes.c_uint32),
        ("schema_ref", ctypes.c_char_p),
        ("encoding", ctypes.c_char_p),
        ("bytes", ctypes.c_void_p),
        ("byte_size", ctypes.c_uint64),
    ]


class _OwnedMessageV1(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("message", _SemanticMessageV1),
        ("token", ctypes.c_uint64),
    ]


class _ActionBindingConfigV1(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("fact_cut_root", ctypes.c_char_p),
        ("pursuit_root", ctypes.c_char_p),
        ("atlas_root", ctypes.c_char_p),
        ("warrant_root", ctypes.c_char_p),
        ("candidate_action_root", ctypes.c_char_p),
        ("preconditions_root", ctypes.c_char_p),
        ("resources_root", ctypes.c_char_p),
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
    ctypes.POINTER(ctypes.c_uint64),
)
_ContextUnary = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)
_InterfaceGet = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_void_p,
)
_ResultRelease = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint64)
_BindingOpen = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.POINTER(_ActionBindingConfigV1),
    ctypes.POINTER(ctypes.c_void_p),
)
_BindingInfo = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p)
_BindingClose = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)
_LedgerExecute = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.POINTER(_SemanticMessageV1),
    ctypes.POINTER(_OwnedMessageV1),
)
_MaintenanceExecute = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.POINTER(_SemanticMessageV1),
    ctypes.POINTER(_OwnedMessageV1),
)


class _ApiV1(ctypes.Structure):
    _fields_ = [
        ("abi_version", ctypes.c_uint32),
        ("struct_size", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint64),
        ("context_open", _ContextOpen),
        ("context_capabilities", _ContextCapabilities),
        ("context_last_error", _ContextLastError),
        ("context_request_cancel", _ContextUnary),
        ("context_reset_cancel", _ContextUnary),
        ("interface_get", _InterfaceGet),
        ("context_close", _ContextUnary),
    ]


class _LedgerApiV1(ctypes.Structure):
    _fields_ = [
        ("abi_version", ctypes.c_uint32),
        ("struct_size", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint64),
        ("binding_open", _BindingOpen),
        ("binding_info", _BindingInfo),
        ("binding_close", _BindingClose),
        ("execute", _LedgerExecute),
        ("result_release", _ResultRelease),
    ]


class _MaintenanceApiV1(ctypes.Structure):
    _fields_ = [
        ("abi_version", ctypes.c_uint32),
        ("struct_size", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint64),
        ("execute", _MaintenanceExecute),
        ("result_release", _ResultRelease),
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


def _compatibility_status(status: int) -> int:
    return {7: 5, 8: 3, 9: 4}.get(status, status)


def _environment_binding() -> dict[str, str] | None:
    values = {field: os.environ.get(name, "") for field, name in _ROOT_ENV.items()}
    return values if all(values.values()) else None


class NativeStorage:
    def __init__(
        self,
        runtime_dir: str | os.PathLike[str],
        action_binding: Mapping[str, str] | None = None,
    ):
        library_path = _library_path()
        if not library_path.is_file():
            raise NativeStorageError(-1, f"native library is missing: {library_path}")
        self._library = ctypes.CDLL(str(library_path))
        get_api = self._library.kungfu_get_api
        get_api.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        get_api.restype = ctypes.c_int32
        self._api = _ApiV1()
        status = get_api(ABI_V1, ctypes.sizeof(self._api), ctypes.byref(self._api))
        if status != _OK:
            raise NativeStorageError(
                status, "standard libkungfu ABI negotiation failed"
            )
        if self._api.abi_version != ABI_V1:
            raise NativeStorageError(-1, "libkungfu returned the wrong ABI version")

        encoded = os.fspath(runtime_dir).encode("utf-8")
        config = _ContextConfigV1(
            struct_size=ctypes.sizeof(_ContextConfigV1),
            flags=0,
            runtime_dir=encoded,
            stream_root=encoded,
            host_namespace=b"kungfu-sdk",
            host_name=b"python",
            mode=0,
        )
        self._context = ctypes.c_void_p()
        status = self._api.context_open(
            ctypes.byref(config), ctypes.byref(self._context)
        )
        if status != _OK or not self._context:
            raise NativeStorageError(status, "native storage context open failed")

        self._ledger = _LedgerApiV1()
        status = self._api.interface_get(
            self._context,
            _INTERFACE_LEDGER_ACTION,
            ABI_V1,
            ctypes.sizeof(self._ledger),
            ctypes.byref(self._ledger),
        )
        if status != _OK:
            raise self._error(status, "ledger-action interface negotiation failed")
        self._maintenance = _MaintenanceApiV1()
        status = self._api.interface_get(
            self._context,
            _INTERFACE_MAINTENANCE,
            ABI_V1,
            ctypes.sizeof(self._maintenance),
            ctypes.byref(self._maintenance),
        )
        if status != _OK:
            raise self._error(status, "maintenance interface negotiation failed")
        self._binding = ctypes.c_void_p()
        binding = action_binding or _environment_binding()
        if binding is not None:
            self.bind_action(binding)

    @property
    def capabilities(self) -> int:
        return self._ledger.capabilities | self._maintenance.capabilities

    def bind_action(self, roots: Mapping[str, str]) -> None:
        if self._binding:
            raise NativeStorageError(-1, "an ActionBinding is already open")
        missing = [field for field in _ROOT_ENV if not roots.get(field)]
        if missing:
            raise NativeStorageError(
                -1, f"ActionBinding roots are missing: {', '.join(missing)}"
            )
        encoded = {field: roots[field].encode("utf-8") for field in _ROOT_ENV}
        config = _ActionBindingConfigV1(
            struct_size=ctypes.sizeof(_ActionBindingConfigV1),
            flags=0,
            **encoded,
        )
        status = self._ledger.binding_open(
            self._context, ctypes.byref(config), ctypes.byref(self._binding)
        )
        if status != _OK or not self._binding:
            raise self._error(status, "ActionBinding open failed")

    def execute(self, operation: str, request: dict[str, Any]) -> dict[str, Any]:
        request_bytes = json.dumps(request, separators=(",", ":")).encode("utf-8")
        request_buffer = ctypes.create_string_buffer(request_bytes)
        arguments: tuple[Any, ...]
        if operation in _LEDGER_OPERATIONS:
            if not self._binding:
                raise NativeStorageError(
                    -1, "ledger-action operation requires an explicit ActionBinding"
                )
            schema = b"kungfu.ledger-action.request/v1"
            execute = self._ledger.execute
            release = self._ledger.result_release
            arguments = (self._binding, _LEDGER_OPERATIONS[operation])
        elif operation in _MAINTENANCE_OPERATIONS:
            schema = b"kungfu.maintenance.request/v1"
            execute = self._maintenance.execute
            release = self._maintenance.result_release
            arguments = (_MAINTENANCE_OPERATIONS[operation],)
        else:
            raise NativeStorageError(5, "unsupported storage operation")
        message = _SemanticMessageV1(
            struct_size=ctypes.sizeof(_SemanticMessageV1),
            flags=0,
            protocol_id=b"kungfu.runtime.storage-service",
            protocol_version=1,
            schema_ref=schema,
            encoding=b"application/json",
            bytes=ctypes.cast(request_buffer, ctypes.c_void_p),
            byte_size=len(request_bytes),
        )
        result = _OwnedMessageV1(struct_size=ctypes.sizeof(_OwnedMessageV1))
        status = execute(
            self._context, *arguments, ctypes.byref(message), ctypes.byref(result)
        )
        if status != _OK:
            status = _compatibility_status(status)
            raise self._error(status, "native storage operation failed")
        if not result.message.bytes or not result.message.byte_size or not result.token:
            raise NativeStorageError(-1, "libkungfu returned an invalid result view")
        try:
            payload = ctypes.string_at(result.message.bytes, result.message.byte_size)
            envelope = json.loads(payload)
            value = envelope["result"]
            if not isinstance(value, dict):
                raise TypeError("standard result envelope payload is not an object")
            return dict(value)
        finally:
            release_status = release(self._context, result.token)
            if release_status != _OK:
                raise self._error(release_status, "result release failed")

    def close(self) -> None:
        if not getattr(self, "_context", None):
            return
        if getattr(self, "_binding", None):
            status = self._ledger.binding_close(self._binding)
            if status != _OK:
                raise self._error(status, "ActionBinding close failed")
            self._binding = ctypes.c_void_p()
        status = self._api.context_close(self._context)
        if status != _OK:
            raise self._error(status, "native storage context close failed")
        self._context = ctypes.c_void_p()

    def _error(self, status: int, fallback: str) -> NativeStorageError:
        data = ctypes.c_void_p()
        size = ctypes.c_uint64()
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
