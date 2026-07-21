// SPDX-License-Identifier: Apache-2.0

//! A small Rust owner for the standard versioned `libkungfu` ABI.
//!
//! The crate adds no storage semantics. Operations and named JSON edge
//! contracts are forwarded through `kungfu_get_api` ledger-action and
//! maintenance responsibility tables.

use serde_json::Value;
use std::ffi::{c_char, c_void, CString};
use std::fmt;
use std::mem;
use std::path::Path;
use std::ptr;

pub const ABI_V1: u32 = 1;
pub const CAP_EPISODE_LIFECYCLE: u64 = 1 << 0;
pub const CAP_HEAD_AND_HISTORICAL_QUERY: u64 = 1 << 1;
pub const CAP_FSCK: u64 = 1 << 2;
pub const CAP_EXPORT: u64 = 1 << 3;
pub const CAP_DOMAIN_FACT_ADMISSION: u64 = 1 << 4;
pub const REQUIRED_CAPABILITIES: u64 = CAP_EPISODE_LIFECYCLE
    | CAP_HEAD_AND_HISTORICAL_QUERY
    | CAP_FSCK
    | CAP_EXPORT
    | CAP_DOMAIN_FACT_ADMISSION;

const STATUS_OK: i32 = 0;
#[cfg(feature = "link-native")]
const INTERFACE_LEDGER_ACTION: u32 = 3;
#[cfg(feature = "link-native")]
const INTERFACE_MAINTENANCE: u32 = 4;
const PROTOCOL_STORAGE: &[u8] = b"kungfu.runtime.storage-service\0";
const SCHEMA_LEDGER_ACTION: &[u8] = b"kungfu.ledger-action.request/v1\0";
const SCHEMA_MAINTENANCE: &[u8] = b"kungfu.maintenance.request/v1\0";
const ENCODING_JSON: &[u8] = b"application/json\0";
#[cfg(feature = "link-native")]
const HOST_NAMESPACE: &[u8] = b"kungfu-sdk\0";
#[cfg(feature = "link-native")]
const HOST_NAME: &[u8] = b"rust\0";

#[repr(C)]
struct ContextConfigV1 {
    struct_size: u32,
    flags: u32,
    runtime_dir: *const c_char,
    stream_root: *const c_char,
    host_namespace: *const c_char,
    host_name: *const c_char,
    mode: u8,
    reserved0: [u8; 7],
    default_timeout_ms: u64,
    reserved1: [u64; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SemanticMessageV1 {
    struct_size: u32,
    flags: u32,
    protocol_id: *const c_char,
    protocol_version: u32,
    reserved0: u32,
    schema_ref: *const c_char,
    encoding: *const c_char,
    bytes: *const u8,
    byte_size: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct OwnedMessageV1 {
    struct_size: u32,
    flags: u32,
    message: SemanticMessageV1,
    token: u64,
}

type ContextOpen = unsafe extern "C" fn(*const ContextConfigV1, *mut *mut c_void) -> i32;
type ContextCapabilities = unsafe extern "C" fn(*const c_void, *mut u64) -> i32;
type ContextLastError = unsafe extern "C" fn(*const c_void, *mut *const c_char, *mut u64) -> i32;
type ContextRequestCancel = unsafe extern "C" fn(*mut c_void) -> i32;
type ContextResetCancel = unsafe extern "C" fn(*mut c_void) -> i32;
type InterfaceGet = unsafe extern "C" fn(*mut c_void, u32, u32, u32, *mut c_void) -> i32;
type ContextClose = unsafe extern "C" fn(*mut c_void) -> i32;
type ResultRelease = unsafe extern "C" fn(*mut c_void, u64) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct ApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    context_open: Option<ContextOpen>,
    context_capabilities: Option<ContextCapabilities>,
    context_last_error: Option<ContextLastError>,
    context_request_cancel: Option<ContextRequestCancel>,
    context_reset_cancel: Option<ContextResetCancel>,
    interface_get: Option<InterfaceGet>,
    context_close: Option<ContextClose>,
}

#[repr(C)]
struct ActionBindingConfigV1 {
    struct_size: u32,
    flags: u32,
    fact_cut_root: *const c_char,
    pursuit_root: *const c_char,
    atlas_root: *const c_char,
    warrant_root: *const c_char,
    candidate_action_root: *const c_char,
    preconditions_root: *const c_char,
    resources_root: *const c_char,
}

type BindingOpen =
    unsafe extern "C" fn(*mut c_void, *const ActionBindingConfigV1, *mut *mut c_void) -> i32;
type BindingInfo = unsafe extern "C" fn(*const c_void, *mut c_void) -> i32;
type BindingClose = unsafe extern "C" fn(*mut c_void) -> i32;
type LedgerExecute = unsafe extern "C" fn(
    *mut c_void,
    *const c_void,
    u32,
    *const SemanticMessageV1,
    *mut OwnedMessageV1,
) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct LedgerApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    binding_open: Option<BindingOpen>,
    binding_info: Option<BindingInfo>,
    binding_close: Option<BindingClose>,
    execute: Option<LedgerExecute>,
    result_release: Option<ResultRelease>,
}

type MaintenanceExecute =
    unsafe extern "C" fn(*mut c_void, u32, *const SemanticMessageV1, *mut OwnedMessageV1) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct MaintenanceApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    execute: Option<MaintenanceExecute>,
    result_release: Option<ResultRelease>,
}

#[cfg(feature = "link-native")]
unsafe extern "C" {
    fn kungfu_get_api(requested_version: u32, caller_struct_size: u32, out_api: *mut c_void)
        -> i32;
}

#[derive(Clone, Debug)]
pub struct ActionBindingRoots<'a> {
    pub fact_cut_root: &'a str,
    pub pursuit_root: &'a str,
    pub atlas_root: &'a str,
    pub warrant_root: &'a str,
    pub candidate_action_root: &'a str,
    pub preconditions_root: &'a str,
    pub resources_root: &'a str,
}

#[derive(Debug)]
pub struct Error {
    pub status: i32,
    pub message: String,
}

impl Error {
    fn new(status: i32, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} (libkungfu status {})",
            self.message, self.status
        )
    }
}

impl std::error::Error for Error {}

pub struct NativeStorage {
    api: ApiV1,
    ledger: LedgerApiV1,
    maintenance: MaintenanceApiV1,
    context: *mut c_void,
    binding: *mut c_void,
}

#[derive(Clone, Copy)]
enum OperationRoute {
    Ledger(u32),
    Maintenance(u32),
}

fn operation_route(operation: &str) -> Option<OperationRoute> {
    let ledger = match operation {
        "fact_kernel" => 1,
        "fact_query" => 2,
        "fact_contract" => 3,
        "fact_declare_world" => 4,
        "fact_declare_surface" => 5,
        "fact_observe" => 6,
        "fact_state" => 7,
        "fact_library_contract" => 8,
        "fact_type_create" => 9,
        "fact_type_list" => 10,
        "fact_material_put" => 11,
        "fact_material_list" => 12,
        "fact_library_export" => 13,
        "fact_library_import" => 14,
        "episode_begin" => 16,
        "episode_heartbeat" => 17,
        "episode_end" => 18,
        "episode_abort" => 19,
        "episode_attach_frame" => 20,
        "episode_attach_ref" => 21,
        "episode_list" => 22,
        "episode_inspect" => 23,
        "episode_recover" => 24,
        "episode_recovery_plan" => 25,
        "episode_recovery_execute" => 26,
        "assessment_contract" => 40,
        "assessment_request" => 41,
        "assessment_execute" => 42,
        "assessment_status" => 43,
        "trust_require" => 44,
        "assessment_list" => 45,
        "assessment_invalidate" => 46,
        _ => 0,
    };
    if ledger != 0 {
        return Some(OperationRoute::Ledger(ledger));
    }
    let maintenance = match operation {
        "status" => 1,
        "fsck" => 2,
        "repair_plan" => 3,
        "repair_apply" => 4,
        "gc_plan" => 5,
        "compact_plan" => 6,
        "export_bundle" => 7,
        "import_bundle" => 8,
        "rebuild_index" => 9,
        "backend_status" => 10,
        "backend_switch" => 11,
        "backend_rollback" => 12,
        "episode_projection_rebuild" => 13,
        _ => return None,
    };
    Some(OperationRoute::Maintenance(maintenance))
}

fn compatibility_status(status: i32) -> i32 {
    match status {
        7 => 5,
        8 => 3,
        9 => 4,
        value => value,
    }
}

impl NativeStorage {
    #[cfg(feature = "link-native")]
    pub fn open(runtime_dir: impl AsRef<Path>) -> Result<Self, Error> {
        let runtime_dir = runtime_dir
            .as_ref()
            .to_str()
            .ok_or_else(|| Error::new(-1, "the libkungfu runtime directory must be valid UTF-8"))?;
        let runtime_dir = CString::new(runtime_dir)
            .map_err(|_| Error::new(-1, "the libkungfu runtime directory contains NUL"))?;
        let mut api: ApiV1 = unsafe { mem::zeroed() };
        let status = unsafe {
            kungfu_get_api(
                ABI_V1,
                mem::size_of::<ApiV1>() as u32,
                (&mut api as *mut ApiV1).cast(),
            )
        };
        if status != STATUS_OK {
            return Err(Error::new(
                status,
                "standard libkungfu ABI negotiation failed",
            ));
        }
        if api.abi_version != ABI_V1 || api.struct_size < mem::size_of::<ApiV1>() as u32 {
            return Err(Error::new(
                -1,
                "libkungfu returned an incomplete ABI v1 table",
            ));
        }

        let config = ContextConfigV1 {
            struct_size: mem::size_of::<ContextConfigV1>() as u32,
            flags: 0,
            runtime_dir: runtime_dir.as_ptr(),
            stream_root: runtime_dir.as_ptr(),
            host_namespace: HOST_NAMESPACE.as_ptr().cast(),
            host_name: HOST_NAME.as_ptr().cast(),
            mode: 0,
            reserved0: [0; 7],
            default_timeout_ms: 0,
            reserved1: [0; 3],
        };
        let mut context = ptr::null_mut();
        let open = api
            .context_open
            .ok_or_else(|| Error::new(-1, "libkungfu omitted context_open"))?;
        let status = unsafe { open(&config, &mut context) };
        if status != STATUS_OK || context.is_null() {
            return Err(Error::new(status, "native storage context open failed"));
        }
        let interface_get = api
            .interface_get
            .ok_or_else(|| Error::new(-1, "libkungfu omitted interface_get"))?;
        let mut ledger: LedgerApiV1 = unsafe { mem::zeroed() };
        let status = unsafe {
            interface_get(
                context,
                INTERFACE_LEDGER_ACTION,
                ABI_V1,
                mem::size_of::<LedgerApiV1>() as u32,
                (&mut ledger as *mut LedgerApiV1).cast(),
            )
        };
        if status != STATUS_OK {
            return Err(Error::new(
                status,
                "ledger-action interface negotiation failed",
            ));
        }
        let mut maintenance: MaintenanceApiV1 = unsafe { mem::zeroed() };
        let status = unsafe {
            interface_get(
                context,
                INTERFACE_MAINTENANCE,
                ABI_V1,
                mem::size_of::<MaintenanceApiV1>() as u32,
                (&mut maintenance as *mut MaintenanceApiV1).cast(),
            )
        };
        if status != STATUS_OK {
            return Err(Error::new(
                status,
                "maintenance interface negotiation failed",
            ));
        }
        Ok(Self {
            api,
            ledger,
            maintenance,
            context,
            binding: ptr::null_mut(),
        })
    }

    #[cfg(not(feature = "link-native"))]
    pub fn open(_runtime_dir: impl AsRef<Path>) -> Result<Self, Error> {
        Err(Error::new(
            -1,
            "enable feature 'link-native' and set KUNGFU_NATIVE_DIR",
        ))
    }

    pub fn capabilities(&self) -> Result<u64, Error> {
        Ok(self.ledger.capabilities | self.maintenance.capabilities)
    }

    pub fn bind_action(&mut self, roots: &ActionBindingRoots<'_>) -> Result<(), Error> {
        if !self.binding.is_null() {
            return Err(Error::new(-1, "an ActionBinding is already open"));
        }
        let values = [
            roots.fact_cut_root,
            roots.pursuit_root,
            roots.atlas_root,
            roots.warrant_root,
            roots.candidate_action_root,
            roots.preconditions_root,
            roots.resources_root,
        ]
        .map(|value| {
            CString::new(value).map_err(|_| Error::new(-1, "ActionBinding root contains NUL"))
        })
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
        let config = ActionBindingConfigV1 {
            struct_size: mem::size_of::<ActionBindingConfigV1>() as u32,
            flags: 0,
            fact_cut_root: values[0].as_ptr(),
            pursuit_root: values[1].as_ptr(),
            atlas_root: values[2].as_ptr(),
            warrant_root: values[3].as_ptr(),
            candidate_action_root: values[4].as_ptr(),
            preconditions_root: values[5].as_ptr(),
            resources_root: values[6].as_ptr(),
        };
        let open = self
            .ledger
            .binding_open
            .ok_or_else(|| Error::new(-1, "libkungfu omitted binding_open"))?;
        let status = unsafe { open(self.context, &config, &mut self.binding) };
        if status != STATUS_OK || self.binding.is_null() {
            return Err(self.context_error(status, "ActionBinding open failed"));
        }
        Ok(())
    }

    pub fn execute_json(&mut self, operation: &str, request_json: &str) -> Result<String, Error> {
        let route = operation_route(operation)
            .ok_or_else(|| Error::new(5, "unsupported storage operation"))?;
        let schema = match route {
            OperationRoute::Ledger(_) => SCHEMA_LEDGER_ACTION,
            OperationRoute::Maintenance(_) => SCHEMA_MAINTENANCE,
        };
        let request = SemanticMessageV1 {
            struct_size: mem::size_of::<SemanticMessageV1>() as u32,
            flags: 0,
            protocol_id: PROTOCOL_STORAGE.as_ptr().cast(),
            protocol_version: 1,
            reserved0: 0,
            schema_ref: schema.as_ptr().cast(),
            encoding: ENCODING_JSON.as_ptr().cast(),
            bytes: request_json.as_ptr(),
            byte_size: request_json.len() as u64,
        };
        let mut result = OwnedMessageV1 {
            struct_size: mem::size_of::<OwnedMessageV1>() as u32,
            flags: 0,
            message: unsafe { mem::zeroed() },
            token: 0,
        };
        let (status, release) = match route {
            OperationRoute::Ledger(code) => {
                if self.binding.is_null() {
                    return Err(Error::new(
                        -1,
                        "ledger-action operation requires an explicit ActionBinding",
                    ));
                }
                let execute = self
                    .ledger
                    .execute
                    .ok_or_else(|| Error::new(-1, "libkungfu omitted ledger-action execute"))?;
                let status =
                    unsafe { execute(self.context, self.binding, code, &request, &mut result) };
                (status, self.ledger.result_release)
            }
            OperationRoute::Maintenance(code) => {
                let execute = self
                    .maintenance
                    .execute
                    .ok_or_else(|| Error::new(-1, "libkungfu omitted maintenance execute"))?;
                let status = unsafe { execute(self.context, code, &request, &mut result) };
                (status, self.maintenance.result_release)
            }
        };
        if status != STATUS_OK {
            return Err(self.context_error(
                compatibility_status(status),
                "native storage operation failed",
            ));
        }
        if result.message.bytes.is_null() || result.message.byte_size == 0 || result.token == 0 {
            return Err(Error::new(-1, "libkungfu returned an invalid result view"));
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(result.message.bytes, result.message.byte_size as usize)
        }
        .to_vec();
        let release = release.ok_or_else(|| Error::new(-1, "libkungfu omitted result_release"))?;
        let release_status = unsafe { release(self.context, result.token) };
        if release_status != STATUS_OK {
            return Err(self.context_error(release_status, "result release failed"));
        }
        let envelope: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new(-1, "libkungfu returned invalid JSON"))?;
        serde_json::to_string(
            envelope
                .get("result")
                .ok_or_else(|| Error::new(-1, "standard result envelope omitted result"))?,
        )
        .map_err(|_| Error::new(-1, "libkungfu result serialization failed"))
    }

    fn context_error(&self, status: i32, fallback: &str) -> Error {
        let Some(last_error) = self.api.context_last_error else {
            return Error::new(status, fallback);
        };
        let mut data = ptr::null();
        let mut size = 0_u64;
        if unsafe { last_error(self.context, &mut data, &mut size) } != STATUS_OK || data.is_null()
        {
            return Error::new(status, fallback);
        }
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), size as usize) };
        Error::new(status, String::from_utf8_lossy(bytes).into_owned())
    }
}

impl Drop for NativeStorage {
    fn drop(&mut self) {
        if !self.binding.is_null() {
            if let Some(close) = self.ledger.binding_close {
                let _ = unsafe { close(self.binding) };
            }
            self.binding = ptr::null_mut();
        }
        if self.context.is_null() {
            return;
        }
        if let Some(close) = self.api.context_close {
            let _ = unsafe { close(self.context) };
        }
        self.context = ptr::null_mut();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_capability_mask_matches_native_v1() {
        assert_eq!(REQUIRED_CAPABILITIES, 0b1_1111);
    }

    #[cfg(feature = "link-native")]
    #[test]
    fn domain_fact_contract_is_forwarded_without_rust_semantic_duplication() {
        let runtime_dir = std::env::temp_dir().join("kungfu-sdk-domain-fact-contract");
        let mut storage = NativeStorage::open(&runtime_dir).expect("open native storage");
        let roots = [
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            "sha256:5555555555555555555555555555555555555555555555555555555555555555",
            "sha256:6666666666666666666666666666666666666666666666666666666666666666",
            "sha256:7777777777777777777777777777777777777777777777777777777777777777",
        ];
        storage
            .bind_action(&ActionBindingRoots {
                fact_cut_root: roots[0],
                pursuit_root: roots[1],
                atlas_root: roots[2],
                warrant_root: roots[3],
                candidate_action_root: roots[4],
                preconditions_root: roots[5],
                resources_root: roots[6],
            })
            .expect("bind qualification action");
        let contract = storage
            .execute_json("fact_contract", "{}")
            .expect("read the libkungfu-owned contract");
        assert!(contract.contains("kungfu.facts.domain-admission/v1"));
        assert!(contract.contains("unregistered-surface"));
        assert!(contract.contains("ambiguous-authority"));
    }

    #[test]
    fn error_is_explicit_without_native_link_feature() {
        #[cfg(not(feature = "link-native"))]
        match NativeStorage::open("fixture.kungfu") {
            Ok(_) => panic!("link-free SDK unexpectedly opened native storage"),
            Err(error) => assert!(error.to_string().contains("link-native")),
        }
    }
}
