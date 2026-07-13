// SPDX-License-Identifier: Apache-2.0

//! Safe Rust wrapper over the libkungfu embedding C ABI.
//!
//! This is the one shared borrowing layer required by the Stage 3 embedding
//! contract RFC (`docs/architecture/embedding-contract-face.md`, decision D7):
//! a single membrane (`kungfu_embedding_get_api` + the `kf_embedding_api_v*`
//! table, mirrored from `framework/core/src/libkungfu/include/kungfu/embedding.h`)
//! consumed by two callers — the product trunk (`crates/trunk`) and the future
//! native-authoring crate (`kungfu-kfx`, ADR-0045 gate 2). There is exactly one
//! copy of the FFI seam, here.
//!
//! The table is version-negotiated: v1 exposes journal batch-read + capability
//! negotiation; v2 (ADR-0071 Bucket A) appends a read-only substrate-diagnostic
//! surface ([`Context::storage_fsck`]) after a byte-identical v1 prefix.
//! [`Context::open`] negotiates v2 first and falls back to v1, so a v1-only core
//! still yields a working journal-read context.
//!
//! # ABI fidelity
//!
//! The `#[repr(C)]` structs below mirror `embedding.h` field-for-field; the
//! compile-time layout assertions at the bottom of this file fail the build if a
//! field is added, reordered, or resized out of step with the header. That is the
//! drift guard the RFC calls for on the Rust side.
//!
//! # Safety model
//!
//! All `unsafe` is confined to this crate. Ownership is expressed in the type
//! system: a [`Reader`] borrows its [`Context`], and a [`Batch`] mutably borrows
//! its [`Reader`], so the zero-copy, mmap-backed payload slices a batch exposes
//! cannot outlive the batch's release (RAII `Drop` calls `reader_release_batch`).
//! Handles are single-thread-affine in v1 (per the header); the wrappers are
//! `!Send`/`!Sync` by virtue of holding raw pointers, so the compiler keeps
//! callers from sharing them across threads.
//!
//! # Linking
//!
//! This crate does not link libkungfu. It declares the `extern "C"` bootstrap and
//! leaves the symbol unresolved in the rlib; the consumer that produces the final
//! binary supplies the link search path and `-lkungfu` in its own build script
//! (the D6 first-party, compiled-with-the-core path). Building the rlib therefore
//! needs no core in reach, which is why this crate stays inside the workspace CI
//! gate while `host-spike` (which links a sibling core) is workspace-excluded.

use std::error::Error;
use std::ffi::{c_char, c_void, CString};
use std::fmt;
use std::marker::PhantomData;
use std::slice;

/// The frozen v1 ABI version negotiated through [`kungfu_embedding_get_api`].
pub const ABI_V1: u32 = 1;

/// The v2 ABI version: v1 plus the read-only substrate-diagnostic surface
/// (`storage_fsck`). [`Context::open`] negotiates v2 first and falls back to v1,
/// so a v1-only core still yields a working journal-read context.
pub const ABI_V2: u32 = 2;

/// Maximum frames a single `read_batch` call may return (`KF_EMBEDDING_MAX_BATCH_FRAMES`).
pub const MAX_BATCH_FRAMES: u32 = 4096;

/// Context flag requesting the low-latency path (`KF_EMBEDDING_CONTEXT_LOW_LATENCY`).
pub const CONTEXT_LOW_LATENCY: u32 = 1;

/// Capability bit: the context can read journal batches (`KF_EMBEDDING_CAP_READ_JOURNAL_BATCH`).
pub const CAP_READ_JOURNAL_BATCH: u64 = 1 << 0;

/// Capability bit: batch payloads are zero-copy mmap views (`KF_EMBEDDING_CAP_MMAP_PAYLOAD_VIEW`).
pub const CAP_MMAP_PAYLOAD_VIEW: u64 = 1 << 1;

/// Capability bit: read-only substrate diagnostics reachable without CPython
/// (`KF_EMBEDDING_CAP_STORAGE_DIAGNOSTICS`).
pub const CAP_STORAGE_DIAGNOSTICS: u64 = 1 << 2;

/// Report blob format tag: UTF-8 JSON (`KF_EMBEDDING_REPORT_FORMAT_JSON`).
pub const REPORT_FORMAT_JSON: u32 = 1;

const OK: i32 = 0;

// ── raw ABI (mirrors embedding.h; do not reorder without matching the header) ──

#[repr(C)]
#[derive(Clone, Copy)]
struct ContextConfigV1 {
    struct_size: u32,
    flags: u32,
    root: *const c_char,
    host_namespace: *const c_char,
    host_name: *const c_char,
    mode: u8,
    reserved: [u8; 7],
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

/// v2: a read-only storage fsck request (mirrors `kf_embedding_storage_fsck_request_v1`).
#[repr(C)]
#[derive(Clone, Copy)]
struct StorageFsckRequestV1 {
    struct_size: u32,
    scope: u32,
    runtime_dir: *const c_char,
    provider: *const c_char,
    provider_config_source: *const c_char,
    source_id: *const c_char,
    episode_id: u64,
    verify_frames: u32,
    reserved: u32,
}

/// v2: an owned diagnostic report blob (mirrors `kf_embedding_report_v1`). The
/// `data` bytes and their backing `owner` are freed by `report_release`.
#[repr(C)]
#[derive(Clone, Copy)]
struct ReportV1 {
    struct_size: u32,
    format: u32,
    ok: u8,
    degraded: u8,
    reserved0: [u8; 2],
    data: *const u8,
    data_size: u64,
    owner: *mut c_void,
}

type ContextOpen = unsafe extern "C" fn(*const ContextConfigV1, *mut *mut c_void) -> i32;
type ContextCapabilities = unsafe extern "C" fn(*const c_void, *mut u64) -> i32;
type ContextClose = unsafe extern "C" fn(*mut c_void) -> i32;
type ReaderOpen = unsafe extern "C" fn(*mut c_void, *const LocationV1, *mut *mut c_void) -> i32;
type ReaderReadBatch = unsafe extern "C" fn(*mut c_void, u32, *mut BatchV1) -> i32;
type ReaderReleaseBatch = unsafe extern "C" fn(*mut c_void, u64) -> i32;
type ReaderClose = unsafe extern "C" fn(*mut c_void) -> i32;
type StorageFsck =
    unsafe extern "C" fn(*mut c_void, *const StorageFsckRequestV1, *mut ReportV1) -> i32;
type ReportRelease = unsafe extern "C" fn(*mut ReportV1) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct ApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    context_open: ContextOpen,
    context_capabilities: ContextCapabilities,
    context_close: ContextClose,
    reader_open: ReaderOpen,
    reader_read_batch: ReaderReadBatch,
    reader_release_batch: ReaderReleaseBatch,
    reader_close: ReaderClose,
}

/// The v2 table: a byte-identical v1 prefix followed by the diagnostic pointers.
#[repr(C)]
#[derive(Clone, Copy)]
struct ApiV2 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    context_open: ContextOpen,
    context_capabilities: ContextCapabilities,
    context_close: ContextClose,
    reader_open: ReaderOpen,
    reader_read_batch: ReaderReadBatch,
    reader_release_batch: ReaderReleaseBatch,
    reader_close: ReaderClose,
    storage_fsck: StorageFsck,
    report_release: ReportRelease,
}

impl ApiV2 {
    /// The v1 view of this table's shared prefix.
    fn as_v1(&self) -> ApiV1 {
        ApiV1 {
            abi_version: self.abi_version,
            struct_size: self.struct_size,
            capabilities: self.capabilities,
            context_open: self.context_open,
            context_capabilities: self.context_capabilities,
            context_close: self.context_close,
            reader_open: self.reader_open,
            reader_read_batch: self.reader_read_batch,
            reader_release_batch: self.reader_release_batch,
            reader_close: self.reader_close,
        }
    }
}

extern "C" {
    /// The only link-visible bootstrap: negotiates version + table size and fills
    /// `out_api` (a `kf_embedding_api_v{requested_version}`). Supplied by libkungfu
    /// at final link (see the crate docs).
    fn kungfu_embedding_get_api(
        requested_version: u32,
        caller_struct_size: u32,
        out_api: *mut c_void,
    ) -> i32;
}

// ── errors ──

/// Failure from the embedding membrane, mirroring `kf_embedding_status` plus the
/// wrapper's own precondition failures.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmbeddingError {
    /// `KF_EMBEDDING_INVALID_ARGUMENT`.
    InvalidArgument,
    /// `KF_EMBEDDING_UNSUPPORTED_VERSION`.
    UnsupportedVersion,
    /// `KF_EMBEDDING_BUSY` — a handle is single-thread-affine and in use.
    Busy,
    /// `KF_EMBEDDING_CORE_ERROR` — the core caught an internal exception.
    CoreError,
    /// A status code the wrapper does not recognize.
    UnknownStatus(i32),
    /// libkungfu returned a table whose version or size is incompatible with v1.
    IncompatibleTable,
    /// A caller-supplied string contained an interior NUL and cannot cross the ABI.
    NulInString(&'static str),
}

impl fmt::Display for EmbeddingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument => f.write_str("embedding: invalid argument"),
            Self::UnsupportedVersion => f.write_str("embedding: unsupported ABI version"),
            Self::Busy => f.write_str("embedding: handle busy (single-thread-affine)"),
            Self::CoreError => f.write_str("embedding: core error"),
            Self::UnknownStatus(v) => write!(f, "embedding: unknown status {v}"),
            Self::IncompatibleTable => {
                f.write_str("embedding: libkungfu returned an incompatible v1 table")
            }
            Self::NulInString(field) => write!(f, "embedding: {field} contains an interior NUL"),
        }
    }
}

impl Error for EmbeddingError {}

fn status(value: i32) -> Result<(), EmbeddingError> {
    match value {
        OK => Ok(()),
        1 => Err(EmbeddingError::InvalidArgument),
        2 => Err(EmbeddingError::UnsupportedVersion),
        3 => Err(EmbeddingError::Busy),
        4 => Err(EmbeddingError::CoreError),
        other => Err(EmbeddingError::UnknownStatus(other)),
    }
}

fn cstr(value: &str, field: &'static str) -> Result<CString, EmbeddingError> {
    CString::new(value).map_err(|_| EmbeddingError::NulInString(field))
}

fn opt_cstr(value: Option<&str>, field: &'static str) -> Result<Option<CString>, EmbeddingError> {
    value.map(|v| cstr(v, field)).transpose()
}

fn opt_ptr(value: &Option<CString>) -> *const c_char {
    value.as_ref().map_or(std::ptr::null(), |c| c.as_ptr())
}

fn api_v1() -> Result<ApiV1, EmbeddingError> {
    let mut api = std::mem::MaybeUninit::<ApiV1>::uninit();
    // SAFETY: the negotiator fills `out_api` only on OK, and we pass our own
    // struct size so the core can refuse a caller it cannot satisfy.
    let result = unsafe {
        kungfu_embedding_get_api(
            ABI_V1,
            std::mem::size_of::<ApiV1>() as u32,
            api.as_mut_ptr().cast(),
        )
    };
    status(result)?;
    // SAFETY: OK from the negotiator means the table is initialized.
    let api = unsafe { api.assume_init() };
    if api.abi_version != ABI_V1 || api.struct_size < std::mem::size_of::<ApiV1>() as u32 {
        return Err(EmbeddingError::IncompatibleTable);
    }
    Ok(api)
}

fn api_v2() -> Result<ApiV2, EmbeddingError> {
    let mut api = std::mem::MaybeUninit::<ApiV2>::uninit();
    // SAFETY: the negotiator fills `out_api` only on OK; we pass our own struct
    // size so a v1-only core rejects v2 with UnsupportedVersion.
    let result = unsafe {
        kungfu_embedding_get_api(
            ABI_V2,
            std::mem::size_of::<ApiV2>() as u32,
            api.as_mut_ptr().cast(),
        )
    };
    status(result)?;
    // SAFETY: OK from the negotiator means the table is initialized.
    let api = unsafe { api.assume_init() };
    if api.abi_version != ABI_V2 || api.struct_size < std::mem::size_of::<ApiV2>() as u32 {
        return Err(EmbeddingError::IncompatibleTable);
    }
    Ok(api)
}

/// Negotiate the richest table the core offers: v2 (with diagnostics) if
/// available, otherwise fall back to v1. Only `UnsupportedVersion` triggers the
/// fallback; any other error is surfaced.
fn negotiate() -> Result<(ApiV1, Option<Diagnostics>), EmbeddingError> {
    match api_v2() {
        Ok(v2) => Ok((
            v2.as_v1(),
            Some(Diagnostics {
                storage_fsck: v2.storage_fsck,
                report_release: v2.report_release,
            }),
        )),
        Err(EmbeddingError::UnsupportedVersion) => Ok((api_v1()?, None)),
        Err(other) => Err(other),
    }
}

/// The v2 diagnostic function pointers, present only when v2 was negotiated.
#[derive(Clone, Copy)]
struct Diagnostics {
    storage_fsck: StorageFsck,
    report_release: ReportRelease,
}

// ── typed enums ──

/// Runtime mode of a context or location (`kf_embedding_mode`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// `KF_EMBEDDING_MODE_LIVE`.
    #[default]
    Live,
    /// `KF_EMBEDDING_MODE_DATA`.
    Data,
    /// `KF_EMBEDDING_MODE_REPLAY`.
    Replay,
    /// `KF_EMBEDDING_MODE_BACKTEST`.
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

/// Role a location plays in the graph (`kf_embedding_location_role`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LocationRole {
    /// `KF_EMBEDDING_ROLE_SOURCE`.
    Source,
    /// `KF_EMBEDDING_ROLE_SINK`.
    Sink,
    /// `KF_EMBEDDING_ROLE_ACTOR`.
    Actor,
    /// `KF_EMBEDDING_ROLE_SYSTEM` — the wrapper default (a host inspecting the graph).
    #[default]
    System,
    /// `KF_EMBEDDING_ROLE_SERVICE`.
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

/// The capability bits a context advertises.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities(u64);

impl Capabilities {
    /// Raw capability bitmask.
    pub fn bits(self) -> u64 {
        self.0
    }

    /// Whether the context can read journal batches.
    pub fn read_journal_batch(self) -> bool {
        self.0 & CAP_READ_JOURNAL_BATCH != 0
    }

    /// Whether batch payloads are zero-copy mmap views.
    pub fn mmap_payload_view(self) -> bool {
        self.0 & CAP_MMAP_PAYLOAD_VIEW != 0
    }

    /// Whether the read-only substrate-diagnostic surface (fsck) is reachable.
    pub fn storage_diagnostics(self) -> bool {
        self.0 & CAP_STORAGE_DIAGNOSTICS != 0
    }
}

// ── config ──

/// How a host identifies itself and which mode it opens the context in.
#[derive(Clone, Copy, Debug)]
pub struct ContextConfig<'a> {
    /// kungfu runtime root (the `KF_HOME` equivalent).
    pub root: &'a str,
    /// The host's namespace in the location graph.
    pub host_namespace: &'a str,
    /// The host's name in the location graph.
    pub host_name: &'a str,
    /// Runtime mode.
    pub mode: Mode,
    /// Request the low-latency path.
    pub low_latency: bool,
}

impl<'a> ContextConfig<'a> {
    /// A config with `mode = Live` and the low-latency path off.
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

/// A journal location to open a reader against.
#[derive(Clone, Copy, Debug)]
pub struct Location<'a> {
    /// The location's namespace.
    pub namespace: &'a str,
    /// The location's name.
    pub name: &'a str,
    /// Runtime mode.
    pub mode: Mode,
    /// The location's role.
    pub role: LocationRole,
    /// Destination id filter (`0` for none).
    pub dest_id: u32,
    /// Start time filter (`0` for the beginning).
    pub from_time: i64,
}

impl<'a> Location<'a> {
    /// A location with `role = System`, `mode = Live`, and no dest/time filter.
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

// ── storage diagnostics (v2) ──

/// Which slice of a runtime an fsck covers (`kf_embedding_storage_fsck_scope`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StorageFsckScope {
    /// `KF_EMBEDDING_FSCK_SCOPE_ALL` — the whole runtime.
    #[default]
    All,
    /// `KF_EMBEDDING_FSCK_SCOPE_SOURCE` — one source.
    Source,
    /// `KF_EMBEDDING_FSCK_SCOPE_EPISODE` — one episode of one source.
    Episode,
}

impl StorageFsckScope {
    fn as_u32(self) -> u32 {
        match self {
            Self::All => 0,
            Self::Source => 1,
            Self::Episode => 2,
        }
    }
}

/// A read-only storage fsck request. Optional fields map to nullable C strings.
#[derive(Clone, Copy, Debug)]
pub struct StorageFsckRequest<'a> {
    /// The runtime root to check (the `--runtime-dir`).
    pub runtime_dir: &'a str,
    /// Storage provider name (`None` for the runtime default).
    pub provider: Option<&'a str>,
    /// Where the provider config came from (`None` for the default).
    pub provider_config_source: Option<&'a str>,
    /// Which slice to check.
    pub scope: StorageFsckScope,
    /// The source id for `Source`/`Episode` scope.
    pub source_id: Option<&'a str>,
    /// The episode id for `Episode` scope.
    pub episode_id: u64,
    /// Whether to verify journal frame integrity (heavier).
    pub verify_frames: bool,
}

impl<'a> StorageFsckRequest<'a> {
    /// An `All`-scope request over `runtime_dir` with defaults elsewhere.
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

// ── handles ──

/// An open embedding context: a live view into a kungfu runtime root.
pub struct Context {
    api: ApiV1,
    diagnostics: Option<Diagnostics>,
    raw: *mut c_void,
}

impl Context {
    /// Negotiate the richest table the core offers (v2 with diagnostics, else v1)
    /// and open a context for `config`.
    pub fn open(config: &ContextConfig) -> Result<Self, EmbeddingError> {
        let (api, diagnostics) = negotiate()?;
        let root = cstr(config.root, "root")?;
        let namespace = cstr(config.host_namespace, "host_namespace")?;
        let name = cstr(config.host_name, "host_name")?;
        let raw_config = ContextConfigV1 {
            struct_size: std::mem::size_of::<ContextConfigV1>() as u32,
            flags: if config.low_latency {
                CONTEXT_LOW_LATENCY
            } else {
                0
            },
            root: root.as_ptr(),
            host_namespace: namespace.as_ptr(),
            host_name: name.as_ptr(),
            mode: config.mode.as_u8(),
            reserved: [0; 7],
        };
        let mut raw = std::ptr::null_mut();
        // SAFETY: the CStrings outlive the call; `raw_config` points at live memory.
        status(unsafe { (api.context_open)(&raw_config, &mut raw) })?;
        Ok(Self {
            api,
            diagnostics,
            raw,
        })
    }

    /// Run a read-only storage fsck over `request.runtime_dir`, returning the
    /// report (JSON detail plus an `ok`/`degraded` verdict). This is the
    /// `doctor`-class path: it reuses the C++ `storage_service::fsck` through the
    /// membrane and needs no CPython, so it works when the Python runtime is down.
    ///
    /// Returns [`EmbeddingError::UnsupportedVersion`] if the core only offers v1
    /// (no diagnostic surface).
    pub fn storage_fsck(&self, request: &StorageFsckRequest) -> Result<FsckReport, EmbeddingError> {
        let diagnostics = self.diagnostics.ok_or(EmbeddingError::UnsupportedVersion)?;

        let runtime_dir = cstr(request.runtime_dir, "runtime_dir")?;
        let provider = opt_cstr(request.provider, "provider")?;
        let provider_config_source =
            opt_cstr(request.provider_config_source, "provider_config_source")?;
        let source_id = opt_cstr(request.source_id, "source_id")?;

        let raw_request = StorageFsckRequestV1 {
            struct_size: std::mem::size_of::<StorageFsckRequestV1>() as u32,
            scope: request.scope.as_u32(),
            runtime_dir: runtime_dir.as_ptr(),
            provider: opt_ptr(&provider),
            provider_config_source: opt_ptr(&provider_config_source),
            source_id: opt_ptr(&source_id),
            episode_id: request.episode_id,
            verify_frames: u32::from(request.verify_frames),
            reserved: 0,
        };
        let mut raw_report = ReportV1 {
            struct_size: std::mem::size_of::<ReportV1>() as u32,
            format: 0,
            ok: 0,
            degraded: 0,
            reserved0: [0; 2],
            data: std::ptr::null(),
            data_size: 0,
            owner: std::ptr::null_mut(),
        };
        // SAFETY: the CStrings outlive the call; `self.raw` is a live context;
        // `raw_report` points at live stack memory.
        status(unsafe { (diagnostics.storage_fsck)(self.raw, &raw_request, &mut raw_report) })?;
        Ok(FsckReport {
            release: diagnostics.report_release,
            raw: raw_report,
        })
    }

    /// The capabilities this specific context can service.
    pub fn capabilities(&self) -> Result<Capabilities, EmbeddingError> {
        let mut bits = 0u64;
        // SAFETY: `self.raw` is a live context for as long as `self` exists.
        status(unsafe { (self.api.context_capabilities)(self.raw, &mut bits) })?;
        Ok(Capabilities(bits))
    }

    /// The capabilities libkungfu advertised in the negotiated table (before any
    /// context-specific narrowing).
    pub fn advertised_capabilities(&self) -> Capabilities {
        Capabilities(self.api.capabilities)
    }

    /// Open a reader against `location`. The reader borrows this context.
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
        // SAFETY: the CStrings outlive the call; `self.raw` is a live context.
        status(unsafe { (self.api.reader_open)(self.raw, &raw_location, &mut raw) })?;
        Ok(Reader {
            api: self.api,
            raw,
            _context: PhantomData,
        })
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        // SAFETY: `self.raw` is a live context; close is idempotent for our lifetime.
        let result = unsafe { (self.api.context_close)(self.raw) };
        debug_assert_eq!(result, OK);
    }
}

/// A reader over one journal location, borrowing its [`Context`].
pub struct Reader<'context> {
    api: ApiV1,
    raw: *mut c_void,
    _context: PhantomData<&'context Context>,
}

impl<'context> Reader<'context> {
    /// Read up to `max_frames` frames (clamped by [`MAX_BATCH_FRAMES`] in the core).
    /// The returned batch mutably borrows the reader until it is dropped.
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
        // SAFETY: `self.raw` is a live reader; `raw` points at live stack memory.
        status(unsafe { (self.api.reader_read_batch)(self.raw, max_frames, &mut raw) })?;
        Ok(Batch { reader: self, raw })
    }
}

impl Drop for Reader<'_> {
    fn drop(&mut self) {
        // SAFETY: `self.raw` is a live reader owned by this wrapper.
        let result = unsafe { (self.api.reader_close)(self.raw) };
        debug_assert_eq!(result, OK);
    }
}

/// A single journal frame view. Its payload borrows the owning [`Batch`].
pub struct Frame<'batch> {
    raw: &'batch FrameV1,
}

impl Frame<'_> {
    /// Generation timestamp.
    pub fn gen_time(&self) -> i64 {
        self.raw.gen_time
    }

    /// Triggering timestamp.
    pub fn trigger_time(&self) -> i64 {
        self.raw.trigger_time
    }

    /// Unique frame id.
    pub fn frame_uid(&self) -> u64 {
        self.raw.frame_uid
    }

    /// Source location id.
    pub fn source(&self) -> u32 {
        self.raw.source
    }

    /// Destination location id.
    pub fn dest(&self) -> u32 {
        self.raw.dest
    }

    /// Message type tag.
    pub fn msg_type(&self) -> i32 {
        self.raw.msg_type
    }

    /// Data-type tag of the payload.
    pub fn data_type(&self) -> i8 {
        self.raw.data_type
    }

    /// The frame's payload — a zero-copy view into mmap-backed pages owned by the
    /// reader, valid only until the owning batch is dropped.
    pub fn payload(&self) -> &[u8] {
        if self.raw.data_size == 0 {
            &[]
        } else {
            // SAFETY: the core guarantees `data`/`data_size` describe live mmap
            // pages until release_batch; the batch borrow keeps them alive.
            unsafe { slice::from_raw_parts(self.raw.data, self.raw.data_size as usize) }
        }
    }
}

/// A batch of frames, mutably borrowing its [`Reader`]. Dropping it releases the
/// batch token back to the core, freeing the payload pages it exposed.
pub struct Batch<'reader, 'context> {
    reader: &'reader mut Reader<'context>,
    raw: BatchV1,
}

impl Batch<'_, '_> {
    /// Iterate the frame views in this batch.
    pub fn frames(&self) -> impl Iterator<Item = Frame<'_>> {
        let frames = if self.raw.frame_count == 0 {
            &[]
        } else {
            // SAFETY: `frames`/`frame_count` describe a core-owned array live for
            // the batch's lifetime.
            unsafe { slice::from_raw_parts(self.raw.frames, self.raw.frame_count as usize) }
        };
        frames.iter().map(|raw| Frame { raw })
    }

    /// Number of frames in the batch.
    pub fn frame_count(&self) -> u32 {
        self.raw.frame_count
    }

    /// Total payload bytes the batch's frames reference.
    pub fn payload_bytes(&self) -> u64 {
        self.raw.payload_bytes
    }

    /// Payload bytes actually copied (should be `0` for the zero-copy mmap path).
    pub fn payload_bytes_copied(&self) -> u64 {
        self.raw.payload_bytes_copied
    }
}

impl Drop for Batch<'_, '_> {
    fn drop(&mut self) {
        if self.raw.token != 0 {
            // SAFETY: `token` is the live batch handle for `reader.raw`.
            let result =
                unsafe { (self.reader.api.reader_release_batch)(self.reader.raw, self.raw.token) };
            debug_assert_eq!(result, OK);
        }
    }
}

/// An owned storage fsck report. Holds the core-owned report blob until dropped,
/// when it returns the blob through `report_release`. The `ok`/`degraded` verdict
/// is typed, so a caller can decide an exit code without parsing the JSON.
pub struct FsckReport {
    release: ReportRelease,
    raw: ReportV1,
}

impl FsckReport {
    /// Whether the runtime passed the check.
    pub fn ok(&self) -> bool {
        self.raw.ok != 0
    }

    /// Whether the check ran but the runtime is degraded.
    pub fn degraded(&self) -> bool {
        self.raw.degraded != 0
    }

    /// Whether the report blob is UTF-8 JSON.
    pub fn is_json(&self) -> bool {
        self.raw.format == REPORT_FORMAT_JSON
    }

    /// The raw report blob (JSON bytes for the current core). Empty if the core
    /// returned no payload.
    pub fn bytes(&self) -> &[u8] {
        if self.raw.data.is_null() || self.raw.data_size == 0 {
            &[]
        } else {
            // SAFETY: the core guarantees `data`/`data_size` describe a live blob
            // owned by this report until `report_release` (called on drop).
            unsafe { slice::from_raw_parts(self.raw.data, self.raw.data_size as usize) }
        }
    }

    /// The report blob as UTF-8, or a UTF-8 error if the bytes are not valid text.
    pub fn as_str(&self) -> Result<&str, std::str::Utf8Error> {
        std::str::from_utf8(self.bytes())
    }
}

impl Drop for FsckReport {
    fn drop(&mut self) {
        if !self.raw.owner.is_null() {
            // SAFETY: `raw` owns a live report blob issued by `storage_fsck`.
            let result = unsafe { (self.release)(&mut self.raw) };
            debug_assert_eq!(result, OK);
        }
    }
}

// ── compile-time ABI layout guards (mirror embedding.h; 64-bit targets) ──
//
// kungfu ships on 64-bit platforms only (arm64 / x86-64), so the raw structs
// have a single fixed layout. These assertions fail the build if a field drifts
// from the C header — the Rust-side expression of the RFC's drift guard.
#[cfg(target_pointer_width = "64")]
mod layout_guards {
    use super::*;
    use std::mem::{align_of, size_of};

    const _: () = assert!(size_of::<ContextConfigV1>() == 40);
    const _: () = assert!(align_of::<ContextConfigV1>() == 8);
    const _: () = assert!(size_of::<LocationV1>() == 40);
    const _: () = assert!(align_of::<LocationV1>() == 8);
    const _: () = assert!(size_of::<FrameV1>() == 72);
    const _: () = assert!(align_of::<FrameV1>() == 8);
    const _: () = assert!(size_of::<BatchV1>() == 40);
    const _: () = assert!(align_of::<BatchV1>() == 8);
    const _: () = assert!(size_of::<ApiV1>() == 72);
    const _: () = assert!(align_of::<ApiV1>() == 8);
    const _: () = assert!(size_of::<StorageFsckRequestV1>() == 56);
    const _: () = assert!(align_of::<StorageFsckRequestV1>() == 8);
    const _: () = assert!(size_of::<ReportV1>() == 40);
    const _: () = assert!(align_of::<ReportV1>() == 8);
    const _: () = assert!(size_of::<ApiV2>() == 88);
    const _: () = assert!(align_of::<ApiV2>() == 8);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_maps_to_abi_values() {
        assert_eq!(Mode::Live.as_u8(), 0);
        assert_eq!(Mode::Data.as_u8(), 1);
        assert_eq!(Mode::Replay.as_u8(), 2);
        assert_eq!(Mode::Backtest.as_u8(), 3);
        assert_eq!(Mode::default(), Mode::Live);
    }

    #[test]
    fn role_maps_to_abi_values() {
        assert_eq!(LocationRole::Source.as_u8(), 0);
        assert_eq!(LocationRole::Sink.as_u8(), 1);
        assert_eq!(LocationRole::Actor.as_u8(), 2);
        assert_eq!(LocationRole::System.as_u8(), 3);
        assert_eq!(LocationRole::Service.as_u8(), 4);
        assert_eq!(LocationRole::default(), LocationRole::System);
    }

    #[test]
    fn status_maps_known_codes() {
        assert_eq!(status(0), Ok(()));
        assert_eq!(status(1), Err(EmbeddingError::InvalidArgument));
        assert_eq!(status(2), Err(EmbeddingError::UnsupportedVersion));
        assert_eq!(status(3), Err(EmbeddingError::Busy));
        assert_eq!(status(4), Err(EmbeddingError::CoreError));
        assert_eq!(status(9), Err(EmbeddingError::UnknownStatus(9)));
    }

    #[test]
    fn capabilities_decode_bits() {
        let caps = Capabilities(CAP_READ_JOURNAL_BATCH | CAP_MMAP_PAYLOAD_VIEW);
        assert!(caps.read_journal_batch());
        assert!(caps.mmap_payload_view());
        assert_eq!(caps.bits(), 3);
        assert!(!Capabilities(0).read_journal_batch());
        assert!(!caps.storage_diagnostics());
        assert!(Capabilities(CAP_STORAGE_DIAGNOSTICS).storage_diagnostics());
    }

    #[test]
    fn fsck_scope_maps_to_abi_values() {
        assert_eq!(StorageFsckScope::All.as_u32(), 0);
        assert_eq!(StorageFsckScope::Source.as_u32(), 1);
        assert_eq!(StorageFsckScope::Episode.as_u32(), 2);
        assert_eq!(StorageFsckScope::default(), StorageFsckScope::All);
    }

    #[test]
    fn fsck_request_defaults() {
        let req = StorageFsckRequest::new("/rt");
        assert_eq!(req.runtime_dir, "/rt");
        assert_eq!(req.scope, StorageFsckScope::All);
        assert!(req.provider.is_none());
        assert!(!req.verify_frames);
        assert_eq!(req.episode_id, 0);
    }

    #[test]
    fn opt_cstr_handles_none_and_nul() {
        assert!(matches!(opt_cstr(None, "provider"), Ok(None)));
        assert!(matches!(opt_cstr(Some("ok"), "provider"), Ok(Some(_))));
        assert_eq!(
            opt_cstr(Some("a\0b"), "provider"),
            Err(EmbeddingError::NulInString("provider"))
        );
        assert!(opt_ptr(&None).is_null());
    }

    #[test]
    fn cstr_rejects_interior_nul() {
        assert_eq!(
            cstr("a\0b", "root"),
            Err(EmbeddingError::NulInString("root"))
        );
        assert!(cstr("ok", "root").is_ok());
    }

    #[test]
    fn config_and_location_defaults() {
        let cfg = ContextConfig::new("/root", "ns", "name");
        assert_eq!(cfg.mode, Mode::Live);
        assert!(!cfg.low_latency);
        let loc = Location::new("ns", "name");
        assert_eq!(loc.role, LocationRole::System);
        assert_eq!(loc.from_time, 0);
    }
}
