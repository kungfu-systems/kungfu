// SPDX-License-Identifier: Apache-2.0

//! Safe Rust owner for libkungfu's standard bootstrap.
//!
//! The public borrowing model remains the one used by the product trunk, while
//! the FFI boundary is now `kungfu_get_api` plus the stream and maintenance
//! responsibility tables. No compatibility bootstrap or compatibility header
//! participates in this wrapper.

use serde_json::{json, Value};
use std::error::Error;
use std::ffi::{c_char, c_void, CString};
use std::fmt;
use std::marker::PhantomData;
use std::slice;

pub const ABI_V1: u32 = 1;
pub const ABI_V2: u32 = 1;
pub const ABI_V3: u32 = 1;
pub const ABI_V4: u32 = 1;
pub const ABI_V5: u32 = 1;
pub const MAX_BATCH_FRAMES: u32 = 4096;

pub const CAP_READ_JOURNAL_BATCH: u64 = 1 << 0;
pub const CAP_MMAP_PAYLOAD_VIEW: u64 = 1 << 1;
pub const CAP_STORAGE_DIAGNOSTICS: u64 = 1 << 2;
pub const CAP_GENERIC_CODEC: u64 = 1 << 3;
pub const CAP_STORAGE_MAINTENANCE_PLANS: u64 = 1 << 4;
pub const CAP_STORAGE_STATUS: u64 = 1 << 5;
pub const REPORT_FORMAT_JSON: u32 = 1;

const OK: i32 = 0;
const INTERFACE_STREAM: u32 = 2;
const INTERFACE_MAINTENANCE: u32 = 4;
const STREAM_ABI_V1: u32 = 1;
const MAINTENANCE_ABI_V1: u32 = 1;
const MAINTENANCE_STATUS: u32 = 1;
const MAINTENANCE_FSCK: u32 = 2;
const MAINTENANCE_REPAIR_PLAN: u32 = 3;
const MAINTENANCE_GC_PLAN: u32 = 5;
const MAINTENANCE_COMPACT_PLAN: u32 = 6;
const ENCODING_JSON: &[u8] = b"application/json\0";
const PROTOCOL_STORAGE: &[u8] = b"kungfu.runtime.storage-service\0";
const SCHEMA_MAINTENANCE: &[u8] = b"kungfu.maintenance.request/v1\0";

#[repr(C)]
#[derive(Clone, Copy)]
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

#[repr(C)]
#[derive(Clone, Copy)]
struct ApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    context_open: ContextOpen,
    context_capabilities: ContextCapabilities,
    context_last_error: ContextLastError,
    context_request_cancel: ContextRequestCancel,
    context_reset_cancel: ContextResetCancel,
    interface_get: InterfaceGet,
    context_close: ContextClose,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct LocationV1 {
    struct_size: u32,
    dest_id: u32,
    from_time: i64,
    namespace_name: *const c_char,
    name: *const c_char,
    mode: u8,
    role: u8,
    reserved: [u8; 6],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FrameV1 {
    gen_time: i64,
    trigger_time: i64,
    frame_uid: u64,
    trigger_frame_uid: u64,
    stream_id: u64,
    source: u32,
    initial_source: u32,
    dest: u32,
    msg_type: i32,
    data: *const u8,
    data_size: u32,
    data_type: i8,
    reserved: [u8; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct BatchV1 {
    struct_size: u32,
    frame_count: u32,
    frames: *const FrameV1,
    payload_bytes: u64,
    payload_bytes_copied: u64,
    token: u64,
}

type ReaderOpen = unsafe extern "C" fn(*mut c_void, *const LocationV1, *mut *mut c_void) -> i32;
type ReaderRead = unsafe extern "C" fn(*mut c_void, u32, *mut BatchV1) -> i32;
type ReaderRelease = unsafe extern "C" fn(*mut c_void, u64) -> i32;
type ReaderClose = unsafe extern "C" fn(*mut c_void) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct StreamApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    reader_open: ReaderOpen,
    reader_read: ReaderRead,
    reader_release: ReaderRelease,
    reader_close: ReaderClose,
}

type MaintenanceExecute =
    unsafe extern "C" fn(*mut c_void, u32, *const SemanticMessageV1, *mut OwnedMessageV1) -> i32;
type ResultRelease = unsafe extern "C" fn(*mut c_void, u64) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct MaintenanceApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    execute: MaintenanceExecute,
    result_release: ResultRelease,
}

extern "C" {
    fn kungfu_get_api(requested_version: u32, caller_struct_size: u32, out_api: *mut c_void)
        -> i32;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmbeddingError {
    InvalidArgument,
    UnsupportedVersion,
    Busy,
    CoreError,
    Status(i32),
    IncompatibleTable,
    NulInString(&'static str),
    InvalidReport,
}

impl fmt::Display for EmbeddingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument => f.write_str("libkungfu: invalid argument"),
            Self::UnsupportedVersion => f.write_str("libkungfu: unsupported ABI version"),
            Self::Busy => f.write_str("libkungfu: resource busy"),
            Self::CoreError => f.write_str("libkungfu: core error"),
            Self::Status(value) => write!(f, "libkungfu: status {value}"),
            Self::IncompatibleTable => {
                f.write_str("libkungfu returned an incompatible standard table")
            }
            Self::NulInString(field) => write!(f, "libkungfu: {field} contains an interior NUL"),
            Self::InvalidReport => f.write_str("libkungfu returned an invalid maintenance report"),
        }
    }
}

impl Error for EmbeddingError {}

fn status(value: i32) -> Result<(), EmbeddingError> {
    match value {
        0 => Ok(()),
        1 => Err(EmbeddingError::InvalidArgument),
        2 => Err(EmbeddingError::UnsupportedVersion),
        8 => Err(EmbeddingError::Busy),
        9 => Err(EmbeddingError::CoreError),
        other => Err(EmbeddingError::Status(other)),
    }
}

fn cstr(value: &str, field: &'static str) -> Result<CString, EmbeddingError> {
    CString::new(value).map_err(|_| EmbeddingError::NulInString(field))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Live,
    Data,
    Replay,
    Backtest,
}

impl Mode {
    fn as_u8(self) -> u8 {
        match self {
            Self::Live => 0,
            Self::Data => 1,
            Self::Replay => 2,
            Self::Backtest => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LocationRole {
    Source,
    Sink,
    Actor,
    #[default]
    System,
    Service,
}

impl LocationRole {
    fn as_u8(self) -> u8 {
        match self {
            Self::Source => 0,
            Self::Sink => 1,
            Self::Actor => 2,
            Self::System => 3,
            Self::Service => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities(u64);

impl Capabilities {
    pub fn bits(self) -> u64 {
        self.0
    }
    pub fn read_journal_batch(self) -> bool {
        self.0 & CAP_READ_JOURNAL_BATCH != 0
    }
    pub fn mmap_payload_view(self) -> bool {
        self.0 & CAP_MMAP_PAYLOAD_VIEW != 0
    }
    pub fn storage_diagnostics(self) -> bool {
        self.0 & CAP_STORAGE_DIAGNOSTICS != 0
    }
    pub fn generic_codec(self) -> bool {
        self.0 & CAP_GENERIC_CODEC != 0
    }
    pub fn storage_maintenance_plans(self) -> bool {
        self.0 & CAP_STORAGE_MAINTENANCE_PLANS != 0
    }
    pub fn storage_status(self) -> bool {
        self.0 & CAP_STORAGE_STATUS != 0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ContextConfig<'a> {
    pub root: &'a str,
    pub host_namespace: &'a str,
    pub host_name: &'a str,
    pub mode: Mode,
    pub low_latency: bool,
}

impl<'a> ContextConfig<'a> {
    pub fn new(root: &'a str, host_namespace: &'a str, host_name: &'a str) -> Self {
        Self {
            root,
            host_namespace,
            host_name,
            mode: Mode::Live,
            low_latency: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Location<'a> {
    pub namespace: &'a str,
    pub name: &'a str,
    pub mode: Mode,
    pub role: LocationRole,
    pub dest_id: u32,
    pub from_time: i64,
}

impl<'a> Location<'a> {
    pub fn new(namespace: &'a str, name: &'a str) -> Self {
        Self {
            namespace,
            name,
            mode: Mode::Live,
            role: LocationRole::System,
            dest_id: 0,
            from_time: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StorageFsckScope {
    #[default]
    All,
    Source,
    Episode,
}

impl StorageFsckScope {
    fn name(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Source => "source",
            Self::Episode => "episode",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StorageFsckRequest<'a> {
    pub runtime_dir: &'a str,
    pub provider: Option<&'a str>,
    pub provider_config_source: Option<&'a str>,
    pub scope: StorageFsckScope,
    pub source_id: Option<&'a str>,
    pub episode_id: u64,
    pub verify_frames: bool,
}

impl<'a> StorageFsckRequest<'a> {
    pub fn new(runtime_dir: &'a str) -> Self {
        Self {
            runtime_dir,
            provider: None,
            provider_config_source: None,
            scope: StorageFsckScope::All,
            source_id: None,
            episode_id: 0,
            verify_frames: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StorageGcPlanRequest<'a> {
    pub runtime_dir: &'a str,
    pub provider: Option<&'a str>,
    pub source_id: Option<&'a str>,
}

#[derive(Clone, Copy, Debug)]
pub struct StorageCompactPlanRequest<'a> {
    pub runtime_dir: &'a str,
    pub provider: Option<&'a str>,
    pub source_id: Option<&'a str>,
}

impl<'a> StorageCompactPlanRequest<'a> {
    pub fn new(runtime_dir: &'a str) -> Self {
        Self {
            runtime_dir,
            provider: None,
            source_id: None,
        }
    }
}

impl<'a> StorageGcPlanRequest<'a> {
    pub fn new(runtime_dir: &'a str) -> Self {
        Self {
            runtime_dir,
            provider: None,
            source_id: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StorageStatusRequest<'a> {
    pub runtime_dir: &'a str,
    pub provider: Option<&'a str>,
    pub provider_config_source: Option<&'a str>,
    pub source_id: Option<&'a str>,
}

impl<'a> StorageStatusRequest<'a> {
    pub fn new(runtime_dir: &'a str) -> Self {
        Self {
            runtime_dir,
            provider: None,
            provider_config_source: None,
            source_id: None,
        }
    }
}

pub struct Context {
    api: ApiV1,
    stream: StreamApiV1,
    maintenance: MaintenanceApiV1,
    raw: *mut c_void,
}

impl Context {
    pub fn open(config: &ContextConfig) -> Result<Self, EmbeddingError> {
        let mut api = std::mem::MaybeUninit::<ApiV1>::uninit();
        status(unsafe {
            kungfu_get_api(
                ABI_V1,
                std::mem::size_of::<ApiV1>() as u32,
                api.as_mut_ptr().cast(),
            )
        })?;
        let api = unsafe { api.assume_init() };
        if api.abi_version != ABI_V1 || api.struct_size < std::mem::size_of::<ApiV1>() as u32 {
            return Err(EmbeddingError::IncompatibleTable);
        }
        let root = cstr(config.root, "root")?;
        let namespace = cstr(config.host_namespace, "host_namespace")?;
        let name = cstr(config.host_name, "host_name")?;
        let raw_config = ContextConfigV1 {
            struct_size: std::mem::size_of::<ContextConfigV1>() as u32,
            flags: u32::from(config.low_latency),
            runtime_dir: root.as_ptr(),
            stream_root: root.as_ptr(),
            host_namespace: namespace.as_ptr(),
            host_name: name.as_ptr(),
            mode: config.mode.as_u8(),
            reserved0: [0; 7],
            default_timeout_ms: 0,
            reserved1: [0; 3],
        };
        let mut raw = std::ptr::null_mut();
        status(unsafe { (api.context_open)(&raw_config, &mut raw) })?;
        let mut stream = std::mem::MaybeUninit::<StreamApiV1>::uninit();
        let mut maintenance = std::mem::MaybeUninit::<MaintenanceApiV1>::uninit();
        let stream_status = unsafe {
            (api.interface_get)(
                raw,
                INTERFACE_STREAM,
                STREAM_ABI_V1,
                std::mem::size_of::<StreamApiV1>() as u32,
                stream.as_mut_ptr().cast(),
            )
        };
        let maintenance_status = unsafe {
            (api.interface_get)(
                raw,
                INTERFACE_MAINTENANCE,
                MAINTENANCE_ABI_V1,
                std::mem::size_of::<MaintenanceApiV1>() as u32,
                maintenance.as_mut_ptr().cast(),
            )
        };
        if let Err(error) = status(stream_status).and_then(|_| status(maintenance_status)) {
            unsafe { (api.context_close)(raw) };
            return Err(error);
        }
        Ok(Self {
            api,
            stream: unsafe { stream.assume_init() },
            maintenance: unsafe { maintenance.assume_init() },
            raw,
        })
    }

    fn maintenance_report(
        &self,
        operation: u32,
        payload: Value,
    ) -> Result<FsckReport, EmbeddingError> {
        let bytes = serde_json::to_vec(&payload).map_err(|_| EmbeddingError::InvalidReport)?;
        let request = SemanticMessageV1 {
            struct_size: std::mem::size_of::<SemanticMessageV1>() as u32,
            flags: 0,
            protocol_id: PROTOCOL_STORAGE.as_ptr().cast(),
            protocol_version: 1,
            reserved0: 0,
            schema_ref: SCHEMA_MAINTENANCE.as_ptr().cast(),
            encoding: ENCODING_JSON.as_ptr().cast(),
            bytes: bytes.as_ptr(),
            byte_size: bytes.len() as u64,
        };
        let mut result: OwnedMessageV1 = unsafe { std::mem::zeroed() };
        result.struct_size = std::mem::size_of::<OwnedMessageV1>() as u32;
        status(unsafe { (self.maintenance.execute)(self.raw, operation, &request, &mut result) })?;
        let copied = if result.message.bytes.is_null() {
            Vec::new()
        } else {
            unsafe {
                slice::from_raw_parts(result.message.bytes, result.message.byte_size as usize)
            }
            .to_vec()
        };
        let release_status = unsafe { (self.maintenance.result_release)(self.raw, result.token) };
        status(release_status)?;
        let envelope: Value =
            serde_json::from_slice(&copied).map_err(|_| EmbeddingError::InvalidReport)?;
        let inner = envelope
            .get("result")
            .cloned()
            .ok_or(EmbeddingError::InvalidReport)?;
        let ok = inner.get("ok").and_then(Value::as_bool).unwrap_or(true);
        let degraded = inner
            .get("degraded")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let data = serde_json::to_vec(&inner).map_err(|_| EmbeddingError::InvalidReport)?;
        Ok(FsckReport { data, ok, degraded })
    }

    pub fn storage_status(
        &self,
        request: &StorageStatusRequest,
    ) -> Result<FsckReport, EmbeddingError> {
        self.maintenance_report(MAINTENANCE_STATUS, json!({"runtime_dir": request.runtime_dir, "provider": request.provider, "provider_config_source": request.provider_config_source, "source_id": request.source_id}))
    }
    pub fn storage_fsck(&self, request: &StorageFsckRequest) -> Result<FsckReport, EmbeddingError> {
        self.maintenance_report(MAINTENANCE_FSCK, json!({"runtime_dir": request.runtime_dir, "provider": request.provider, "provider_config_source": request.provider_config_source, "scope": request.scope.name(), "source_id": request.source_id, "episode_id": request.episode_id, "verify_frames": request.verify_frames}))
    }
    pub fn storage_gc_plan(
        &self,
        request: &StorageGcPlanRequest,
    ) -> Result<FsckReport, EmbeddingError> {
        self.maintenance_report(MAINTENANCE_GC_PLAN, json!({"runtime_dir": request.runtime_dir, "provider": request.provider, "source_id": request.source_id, "dry_run": true}))
    }
    pub fn storage_compact_plan(
        &self,
        request: &StorageCompactPlanRequest,
    ) -> Result<FsckReport, EmbeddingError> {
        self.maintenance_report(MAINTENANCE_COMPACT_PLAN, json!({"runtime_dir": request.runtime_dir, "provider": request.provider, "source_id": request.source_id, "dry_run": true}))
    }
    pub fn storage_repair_plan(
        &self,
        request: &StorageFsckRequest,
    ) -> Result<FsckReport, EmbeddingError> {
        self.maintenance_report(MAINTENANCE_REPAIR_PLAN, json!({"runtime_dir": request.runtime_dir, "provider": request.provider, "provider_config_source": request.provider_config_source, "scope": request.scope.name(), "source_id": request.source_id, "episode_id": request.episode_id, "verify_frames": request.verify_frames, "dry_run": true}))
    }
    pub fn capabilities(&self) -> Result<Capabilities, EmbeddingError> {
        let mut bits = 0;
        status(unsafe { (self.api.context_capabilities)(self.raw, &mut bits) })?;
        Ok(Capabilities(
            CAP_READ_JOURNAL_BATCH
                | CAP_MMAP_PAYLOAD_VIEW
                | CAP_STORAGE_DIAGNOSTICS
                | CAP_STORAGE_MAINTENANCE_PLANS
                | CAP_STORAGE_STATUS,
        ))
    }
    pub fn advertised_capabilities(&self) -> Capabilities {
        Capabilities(
            CAP_READ_JOURNAL_BATCH
                | CAP_MMAP_PAYLOAD_VIEW
                | CAP_STORAGE_DIAGNOSTICS
                | CAP_STORAGE_MAINTENANCE_PLANS
                | CAP_STORAGE_STATUS,
        )
    }
    pub fn open_reader<'a>(&'a self, location: &Location) -> Result<Reader<'a>, EmbeddingError> {
        let namespace = cstr(location.namespace, "namespace")?;
        let name = cstr(location.name, "name")?;
        let raw_location = LocationV1 {
            struct_size: std::mem::size_of::<LocationV1>() as u32,
            dest_id: location.dest_id,
            from_time: location.from_time,
            namespace_name: namespace.as_ptr(),
            name: name.as_ptr(),
            mode: location.mode.as_u8(),
            role: location.role.as_u8(),
            reserved: [0; 6],
        };
        let mut raw = std::ptr::null_mut();
        status(unsafe { (self.stream.reader_open)(self.raw, &raw_location, &mut raw) })?;
        Ok(Reader {
            api: self.stream,
            raw,
            _context: PhantomData,
        })
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        let result = unsafe { (self.api.context_close)(self.raw) };
        debug_assert_eq!(result, OK);
    }
}

pub struct Reader<'context> {
    api: StreamApiV1,
    raw: *mut c_void,
    _context: PhantomData<&'context Context>,
}
impl<'context> Reader<'context> {
    pub fn read_batch<'reader>(
        &'reader mut self,
        max_frames: u32,
    ) -> Result<Batch<'reader, 'context>, EmbeddingError> {
        let mut raw = BatchV1 {
            struct_size: std::mem::size_of::<BatchV1>() as u32,
            frame_count: 0,
            frames: std::ptr::null(),
            payload_bytes: 0,
            payload_bytes_copied: 0,
            token: 0,
        };
        status(unsafe { (self.api.reader_read)(self.raw, max_frames, &mut raw) })?;
        Ok(Batch { reader: self, raw })
    }
}
impl Drop for Reader<'_> {
    fn drop(&mut self) {
        let result = unsafe { (self.api.reader_close)(self.raw) };
        debug_assert_eq!(result, OK);
    }
}

pub struct Frame<'batch> {
    raw: &'batch FrameV1,
}
impl Frame<'_> {
    pub fn gen_time(&self) -> i64 {
        self.raw.gen_time
    }
    pub fn trigger_time(&self) -> i64 {
        self.raw.trigger_time
    }
    pub fn frame_uid(&self) -> u64 {
        self.raw.frame_uid
    }
    pub fn source(&self) -> u32 {
        self.raw.source
    }
    pub fn dest(&self) -> u32 {
        self.raw.dest
    }
    pub fn msg_type(&self) -> i32 {
        self.raw.msg_type
    }
    pub fn data_type(&self) -> i8 {
        self.raw.data_type
    }
    pub fn payload(&self) -> &[u8] {
        if self.raw.data_size == 0 {
            &[]
        } else {
            unsafe { slice::from_raw_parts(self.raw.data, self.raw.data_size as usize) }
        }
    }
}

pub struct Batch<'reader, 'context> {
    reader: &'reader mut Reader<'context>,
    raw: BatchV1,
}
impl Batch<'_, '_> {
    pub fn frames(&self) -> impl Iterator<Item = Frame<'_>> {
        let frames = if self.raw.frame_count == 0 {
            &[]
        } else {
            unsafe { slice::from_raw_parts(self.raw.frames, self.raw.frame_count as usize) }
        };
        frames.iter().map(|raw| Frame { raw })
    }
    pub fn frame_count(&self) -> u32 {
        self.raw.frame_count
    }
    pub fn payload_bytes(&self) -> u64 {
        self.raw.payload_bytes
    }
    pub fn payload_bytes_copied(&self) -> u64 {
        self.raw.payload_bytes_copied
    }
}
impl Drop for Batch<'_, '_> {
    fn drop(&mut self) {
        if self.raw.token != 0 {
            let result =
                unsafe { (self.reader.api.reader_release)(self.reader.raw, self.raw.token) };
            debug_assert_eq!(result, OK);
        }
    }
}

pub struct FsckReport {
    data: Vec<u8>,
    ok: bool,
    degraded: bool,
}
impl FsckReport {
    pub fn ok(&self) -> bool {
        self.ok
    }
    pub fn degraded(&self) -> bool {
        self.degraded
    }
    pub fn is_json(&self) -> bool {
        true
    }
    pub fn bytes(&self) -> &[u8] {
        &self.data
    }
    pub fn as_str(&self) -> Result<&str, std::str::Utf8Error> {
        std::str::from_utf8(&self.data)
    }
}

pub type DecodeReport = FsckReport;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_capabilities_are_standard_interface_projections() {
        let caps = Capabilities(CAP_READ_JOURNAL_BATCH | CAP_STORAGE_STATUS);
        assert!(caps.read_journal_batch());
        assert!(caps.storage_status());
        assert!(!caps.generic_codec());
    }
    #[test]
    fn standard_ffi_layouts_match_api_h() {
        assert_eq!(std::mem::size_of::<ApiV1>(), 72);
        assert_eq!(std::mem::size_of::<StreamApiV1>(), 48);
        assert_eq!(std::mem::size_of::<MaintenanceApiV1>(), 32);
        assert_eq!(std::mem::size_of::<FrameV1>(), 72);
    }

    #[test]
    fn compact_plan_request_has_no_mutating_control() {
        let request = StorageCompactPlanRequest::new("/runtime");
        assert_eq!(request.runtime_dir, "/runtime");
        assert_eq!(request.provider, None);
        assert_eq!(request.source_id, None);
        assert_eq!(MAINTENANCE_COMPACT_PLAN, 6);
    }
}
