// SPDX-License-Identifier: Apache-2.0

// Bounded Rust-host exception for the KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6 libwasm spike.
//
// The public surface is a small C ABI. Engine SDK types, panics, and raw
// libkungfu handles never cross it. Both engines execute the same core-Wasm
// bytes and receive journal data only after one explicit host-to-linear-memory
// copy per batch.

use std::ffi::{c_char, c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;
use std::time::Instant;

#[cfg(all(feature = "wasmtime-engine", feature = "wasmer-engine"))]
compile_error!("libwasm spike adapters must contain exactly one engine");
#[cfg(not(any(feature = "wasmtime-engine", feature = "wasmer-engine")))]
compile_error!("libwasm spike adapter requires one engine feature");

const KF_ABI_V1: u32 = 1;
const KF_INTERFACE_STREAM: u32 = 2;
const KF_STREAM_ABI_V1: u32 = 1;
const KF_CAP_STREAM: u64 = 1 << 1;
const MAX_BATCH_FRAMES: u32 = 4096;

const LIBWASM_ABI_V1: u32 = 1;
const COPY_BENCH_REPEATS: u64 = 8;
const ENGINE_WASMTIME: u32 = 1;
#[cfg(feature = "wasmer-engine")]
const ENGINE_WASMER: u32 = 2;

const OK: i32 = 0;
const INVALID_ARGUMENT: i32 = 1;
const UNSUPPORTED_ENGINE: i32 = 2;
const EMBEDDING_ERROR: i32 = 3;
const ENGINE_ERROR: i32 = 4;
const GUEST_TRAP: i32 = 5;
const PANIC_CONTAINED: i32 = 6;
const INVARIANT_ERROR: i32 = 7;

const GUEST_WAT: &str = r#"
(module
  (memory (export "memory") 32 32)
  (func (export "control") (result i32)
    i32.const 7)
  (func (export "consume") (param $ptr i32) (param $len i32) (result i64)
    local.get $ptr
    i64.load8_u
    i64.const 32
    i64.shl
    local.get $ptr
    local.get $len
    i32.add
    i32.const 1
    i32.sub
    i64.load8_u
    i64.or)
  (func (export "trap")
    unreachable))
"#;

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

type ContextOpen = unsafe extern "C" fn(*const ContextConfigV1, *mut *mut c_void) -> i32;
type ContextCapabilities = unsafe extern "C" fn(*const c_void, *mut u64) -> i32;
type ContextLastError = unsafe extern "C" fn(*const c_void, *mut *const c_char, *mut u64) -> i32;
type ContextRequestCancel = unsafe extern "C" fn(*mut c_void) -> i32;
type ContextResetCancel = unsafe extern "C" fn(*mut c_void) -> i32;
type InterfaceGet =
    unsafe extern "C" fn(*mut c_void, u32, u32, u32, *mut c_void) -> i32;
type ContextClose = unsafe extern "C" fn(*mut c_void) -> i32;
type ReaderOpen = unsafe extern "C" fn(*mut c_void, *const LocationV1, *mut *mut c_void) -> i32;
type ReaderReadBatch = unsafe extern "C" fn(*mut c_void, u32, *mut BatchV1) -> i32;
type ReaderReleaseBatch = unsafe extern "C" fn(*mut c_void, u64) -> i32;
type ReaderClose = unsafe extern "C" fn(*mut c_void) -> i32;

#[repr(C)]
pub struct ApiV1 {
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
#[derive(Clone, Copy)]
struct StreamApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    reader_open: Option<ReaderOpen>,
    reader_read: Option<ReaderReadBatch>,
    reader_release: Option<ReaderReleaseBatch>,
    reader_close: Option<ReaderClose>,
}

#[repr(C)]
pub struct LibwasmConfigV1 {
    pub struct_size: u32,
    pub engine: u32,
    pub root: *const c_char,
    pub source_namespace: *const c_char,
    pub source_name: *const c_char,
    pub batch_frames: u32,
    pub warmup_batches: u32,
    pub measured_batches: u32,
}

#[repr(C)]
pub struct LibwasmReportV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub engine: u32,
    pub trap_contained: u32,
    pub batch_calls: u64,
    pub frame_count: u64,
    pub payload_bytes: u64,
    pub host_to_guest_bytes_copied: u64,
    pub guest_to_host_bytes_copied: u64,
    pub control_p50_ns: u64,
    pub control_p99_ns: u64,
    pub batch_4k_p50_ns: u64,
    pub batch_4k_p99_ns: u64,
    pub cold_compile_ns: u64,
    pub cold_instantiate_ns: u64,
    pub one_mib_copy_ns: u64,
    pub one_mib_copy_bytes_per_second: u64,
    pub instance_idle_delta_bytes: u64,
}

struct Api {
    value: ApiV1,
}

impl Api {
    unsafe fn copy_from(raw: *const ApiV1) -> Result<Self, i32> {
        if raw.is_null() {
            return Err(INVALID_ARGUMENT);
        }
        let value = std::ptr::read(raw);
        if value.abi_version != KF_ABI_V1
            || value.struct_size < std::mem::size_of::<ApiV1>() as u32
            || value.capabilities & KF_CAP_STREAM == 0
            || value.context_open.is_none()
            || value.context_capabilities.is_none()
            || value.context_close.is_none()
            || value.interface_get.is_none()
        {
            return Err(INVALID_ARGUMENT);
        }
        Ok(Self { value })
    }
}

struct Context<'a> {
    api: &'a Api,
    stream: StreamApiV1,
    raw: *mut c_void,
}

impl<'a> Context<'a> {
    unsafe fn open(api: &'a Api, root: *const c_char, engine: u32) -> Result<Self, i32> {
        let namespace = b"libwasm_spike\0";
        let name = if engine == ENGINE_WASMTIME {
            b"wasmtime\0".as_slice()
        } else {
            b"wasmer\0".as_slice()
        };
        let config = ContextConfigV1 {
            struct_size: std::mem::size_of::<ContextConfigV1>() as u32,
            flags: 0,
            runtime_dir: root,
            stream_root: root,
            host_namespace: namespace.as_ptr().cast(),
            host_name: name.as_ptr().cast(),
            mode: 0,
            reserved0: [0; 7],
            default_timeout_ms: 0,
            reserved1: [0; 3],
        };
        let mut raw = std::ptr::null_mut();
        let status = (api.value.context_open.unwrap())(&config, &mut raw);
        if status != OK || raw.is_null() {
            return Err(EMBEDDING_ERROR);
        }
        let mut stream = StreamApiV1 {
            abi_version: 0,
            struct_size: 0,
            capabilities: 0,
            reader_open: None,
            reader_read: None,
            reader_release: None,
            reader_close: None,
        };
        let status = (api.value.interface_get.unwrap())(
            raw,
            KF_INTERFACE_STREAM,
            KF_STREAM_ABI_V1,
            std::mem::size_of::<StreamApiV1>() as u32,
            std::ptr::addr_of_mut!(stream).cast(),
        );
        if status != OK
            || stream.abi_version != KF_STREAM_ABI_V1
            || stream.struct_size < std::mem::size_of::<StreamApiV1>() as u32
            || stream.reader_open.is_none()
            || stream.reader_read.is_none()
            || stream.reader_release.is_none()
            || stream.reader_close.is_none()
        {
            let _ = (api.value.context_close.unwrap())(raw);
            return Err(EMBEDDING_ERROR);
        }
        Ok(Self { api, stream, raw })
    }

    unsafe fn open_reader(
        &'a self,
        namespace: *const c_char,
        name: *const c_char,
    ) -> Result<Reader<'a>, i32> {
        let location = LocationV1 {
            struct_size: std::mem::size_of::<LocationV1>() as u32,
            dest_id: 0,
            from_time: 0,
            namespace_name: namespace,
            name,
            mode: 0,
            role: 3,
            reserved: [0; 6],
        };
        let mut raw = std::ptr::null_mut();
        let status = (self.stream.reader_open.unwrap())(self.raw, &location, &mut raw);
        if status != OK || raw.is_null() {
            return Err(EMBEDDING_ERROR);
        }
        Ok(Reader {
            stream: &self.stream,
            raw,
        })
    }

    unsafe fn close(mut self) -> Result<(), i32> {
        let raw = std::mem::replace(&mut self.raw, std::ptr::null_mut());
        if (self.api.value.context_close.unwrap())(raw) == OK {
            Ok(())
        } else {
            Err(EMBEDDING_ERROR)
        }
    }
}

impl Drop for Context<'_> {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                let _ = (self.api.value.context_close.unwrap())(self.raw);
            }
        }
    }
}

struct Reader<'a> {
    stream: &'a StreamApiV1,
    raw: *mut c_void,
}

impl<'api> Reader<'api> {
    unsafe fn read_batch<'reader>(
        &'reader mut self,
        max_frames: u32,
    ) -> Result<Batch<'reader, 'api>, i32> {
        let mut raw = BatchV1 {
            struct_size: std::mem::size_of::<BatchV1>() as u32,
            frame_count: 0,
            frames: std::ptr::null(),
            payload_bytes: 0,
            payload_bytes_copied: 0,
            token: 0,
        };
        if (self.stream.reader_read.unwrap())(self.raw, max_frames, &mut raw) != OK
        {
            return Err(EMBEDDING_ERROR);
        }
        Ok(Batch { reader: self, raw })
    }

    unsafe fn close(mut self) -> Result<(), i32> {
        let raw = std::mem::replace(&mut self.raw, std::ptr::null_mut());
        if (self.stream.reader_close.unwrap())(raw) == OK {
            Ok(())
        } else {
            Err(EMBEDDING_ERROR)
        }
    }
}

impl Drop for Reader<'_> {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                let _ = (self.stream.reader_close.unwrap())(self.raw);
            }
        }
    }
}

struct Batch<'reader, 'api> {
    reader: &'reader mut Reader<'api>,
    raw: BatchV1,
}

impl Batch<'_, '_> {
    unsafe fn payloads(&self) -> Result<Vec<&[u8]>, i32> {
        if self.raw.payload_bytes_copied != 0 {
            return Err(INVARIANT_ERROR);
        }
        if self.raw.frame_count != 0 && self.raw.frames.is_null() {
            return Err(INVARIANT_ERROR);
        }
        let frames = if self.raw.frame_count == 0 {
            &[]
        } else {
            slice::from_raw_parts(self.raw.frames, self.raw.frame_count as usize)
        };
        let mut payloads = Vec::with_capacity(frames.len());
        let mut payload_bytes = 0_u64;
        for frame in frames {
            if frame.data_size != 0 && frame.data.is_null() {
                return Err(INVARIANT_ERROR);
            }
            let payload = if frame.data_size == 0 {
                &[]
            } else {
                slice::from_raw_parts(frame.data, frame.data_size as usize)
            };
            payload_bytes += payload.len() as u64;
            payloads.push(payload);
        }
        if payload_bytes != self.raw.payload_bytes {
            return Err(INVARIANT_ERROR);
        }
        Ok(payloads)
    }
}

impl Drop for Batch<'_, '_> {
    fn drop(&mut self) {
        if self.raw.token != 0 {
            unsafe {
                let _ = (self.reader.stream.reader_release.unwrap())(self.reader.raw, self.raw.token);
            }
        }
    }
}

trait GuestEngine {
    fn control(&mut self) -> Result<i32, i32>;
    fn consume(&mut self, payloads: &[&[u8]]) -> Result<u64, i32>;
    fn trap_is_contained(&mut self) -> bool;
    fn idle_delta_bytes(&self) -> u64;
    fn cold_compile_ns(&self) -> u64;
    fn cold_instantiate_ns(&self) -> u64;
}

#[cfg(feature = "wasmtime-engine")]
struct WasmtimeGuest {
    store: wasmtime::Store<()>,
    memory: wasmtime::Memory,
    control: wasmtime::TypedFunc<(), i32>,
    consume: wasmtime::TypedFunc<(i32, i32), i64>,
    trap: wasmtime::TypedFunc<(), ()>,
    idle_delta: u64,
    compile_ns: u64,
    instantiate_ns: u64,
}

#[cfg(feature = "wasmtime-engine")]
impl WasmtimeGuest {
    fn new(wasm: &[u8]) -> Result<Self, i32> {
        Self::new_with_fuel(wasm, 100_000_000)
    }

    fn new_with_fuel(wasm: &[u8], fuel: u64) -> Result<Self, i32> {
        let compile_start = Instant::now();
        let mut config = wasmtime::Config::new();
        config.consume_fuel(true);
        let engine = wasmtime::Engine::new(&config).map_err(|_| ENGINE_ERROR)?;
        let module = wasmtime::Module::new(&engine, wasm).map_err(|_| ENGINE_ERROR)?;
        let compile_ns = compile_start.elapsed().as_nanos() as u64;
        let baseline = resident_bytes();
        let instantiate_start = Instant::now();
        let mut store = wasmtime::Store::new(&engine, ());
        store.set_fuel(fuel).map_err(|_| ENGINE_ERROR)?;
        let instance =
            wasmtime::Instance::new(&mut store, &module, &[]).map_err(|_| ENGINE_ERROR)?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or(ENGINE_ERROR)?;
        let control = instance
            .get_typed_func::<(), i32>(&mut store, "control")
            .map_err(|_| ENGINE_ERROR)?;
        let consume = instance
            .get_typed_func::<(i32, i32), i64>(&mut store, "consume")
            .map_err(|_| ENGINE_ERROR)?;
        let trap = instance
            .get_typed_func::<(), ()>(&mut store, "trap")
            .map_err(|_| ENGINE_ERROR)?;
        memory
            .write(&mut store, 0, &[0])
            .map_err(|_| ENGINE_ERROR)?;
        let instantiate_ns = instantiate_start.elapsed().as_nanos() as u64;
        let idle_delta = resident_bytes().saturating_sub(baseline);
        Ok(Self {
            store,
            memory,
            control,
            consume,
            trap,
            idle_delta,
            compile_ns,
            instantiate_ns,
        })
    }
}

#[cfg(feature = "wasmtime-engine")]
impl GuestEngine for WasmtimeGuest {
    fn control(&mut self) -> Result<i32, i32> {
        self.control
            .call(&mut self.store, ())
            .map_err(|_| ENGINE_ERROR)
    }

    fn consume(&mut self, payloads: &[&[u8]]) -> Result<u64, i32> {
        let total = payloads.iter().map(|payload| payload.len()).sum::<usize>();
        if total == 0 || total > self.memory.data_size(&self.store) {
            return Err(INVARIANT_ERROR);
        }
        let memory = self.memory.data_mut(&mut self.store);
        let mut offset = 0;
        for payload in payloads {
            memory[offset..offset + payload.len()].copy_from_slice(payload);
            offset += payload.len();
        }
        self.consume
            .call(&mut self.store, (0, total as i32))
            .map(|value| value as u64)
            .map_err(|_| ENGINE_ERROR)
    }

    fn trap_is_contained(&mut self) -> bool {
        self.trap.call(&mut self.store, ()).is_err()
    }

    fn idle_delta_bytes(&self) -> u64 {
        self.idle_delta
    }

    fn cold_compile_ns(&self) -> u64 {
        self.compile_ns
    }

    fn cold_instantiate_ns(&self) -> u64 {
        self.instantiate_ns
    }

}

#[cfg(feature = "wasmer-engine")]
struct WasmerGuest {
    store: wasmer::Store,
    memory: wasmer::Memory,
    control: wasmer::TypedFunction<(), i32>,
    consume: wasmer::TypedFunction<(i32, i32), i64>,
    trap: wasmer::TypedFunction<(), ()>,
    idle_delta: u64,
    compile_ns: u64,
    instantiate_ns: u64,
}

#[cfg(feature = "wasmer-engine")]
impl WasmerGuest {
    fn new(wasm: &[u8]) -> Result<Self, i32> {
        Self::new_with_fuel(wasm, 100_000_000)
    }

    fn new_with_fuel(wasm: &[u8], fuel: u64) -> Result<Self, i32> {
        use std::sync::Arc;
        use wasmer::sys::{CompilerConfig, Cranelift, EngineBuilder};
        use wasmer_middlewares::Metering;

        let compile_start = Instant::now();
        let metering = Arc::new(Metering::new(fuel, |_| 1));
        let mut compiler = Cranelift::default();
        compiler.push_middleware(metering);
        let mut store = wasmer::Store::new(EngineBuilder::new(compiler));
        let module = wasmer::Module::new(&store, wasm).map_err(|_| ENGINE_ERROR)?;
        let compile_ns = compile_start.elapsed().as_nanos() as u64;
        let baseline = resident_bytes();
        let instantiate_start = Instant::now();
        let instance = wasmer::Instance::new(&mut store, &module, &wasmer::imports! {})
            .map_err(|_| ENGINE_ERROR)?;
        let memory = instance
            .exports
            .get_memory("memory")
            .map_err(|_| ENGINE_ERROR)?
            .clone();
        let control = instance
            .exports
            .get_typed_function::<(), i32>(&store, "control")
            .map_err(|_| ENGINE_ERROR)?;
        let consume = instance
            .exports
            .get_typed_function::<(i32, i32), i64>(&store, "consume")
            .map_err(|_| ENGINE_ERROR)?;
        let trap = instance
            .exports
            .get_typed_function::<(), ()>(&store, "trap")
            .map_err(|_| ENGINE_ERROR)?;
        memory
            .view(&store)
            .write(0, &[0])
            .map_err(|_| ENGINE_ERROR)?;
        let instantiate_ns = instantiate_start.elapsed().as_nanos() as u64;
        let idle_delta = resident_bytes().saturating_sub(baseline);
        Ok(Self {
            store,
            memory,
            control,
            consume,
            trap,
            idle_delta,
            compile_ns,
            instantiate_ns,
        })
    }
}

#[cfg(feature = "wasmer-engine")]
impl GuestEngine for WasmerGuest {
    fn control(&mut self) -> Result<i32, i32> {
        self.control.call(&mut self.store).map_err(|_| ENGINE_ERROR)
    }

    fn consume(&mut self, payloads: &[&[u8]]) -> Result<u64, i32> {
        let total = payloads.iter().map(|payload| payload.len()).sum::<usize>();
        if total == 0 {
            return Err(INVARIANT_ERROR);
        }
        let view = self.memory.view(&self.store);
        let mut offset = 0_u64;
        for payload in payloads {
            view.write(offset, payload).map_err(|_| ENGINE_ERROR)?;
            offset += payload.len() as u64;
        }
        self.consume
            .call(&mut self.store, 0, total as i32)
            .map(|value| value as u64)
            .map_err(|_| ENGINE_ERROR)
    }

    fn trap_is_contained(&mut self) -> bool {
        self.trap.call(&mut self.store).is_err()
    }

    fn idle_delta_bytes(&self) -> u64 {
        self.idle_delta
    }

    fn cold_compile_ns(&self) -> u64 {
        self.compile_ns
    }

    fn cold_instantiate_ns(&self) -> u64 {
        self.instantiate_ns
    }

}

fn percentile(values: &mut [u64], percentile: usize) -> u64 {
    values.sort_unstable();
    let index = ((values.len() - 1) * percentile) / 100;
    values[index]
}

fn timed<T>(operation: impl FnOnce() -> Result<T, i32>) -> Result<(T, u64), i32> {
    let start = Instant::now();
    let result = operation()?;
    Ok((result, start.elapsed().as_nanos() as u64))
}

unsafe fn run(
    api_raw: *const ApiV1,
    config: *const LibwasmConfigV1,
    report: *mut LibwasmReportV1,
) -> Result<(), i32> {
    if config.is_null() || report.is_null() {
        return Err(INVALID_ARGUMENT);
    }
    let config = &*config;
    let report = &mut *report;
    if config.struct_size < std::mem::size_of::<LibwasmConfigV1>() as u32
        || report.struct_size < std::mem::size_of::<LibwasmReportV1>() as u32
        || config.root.is_null()
        || config.source_namespace.is_null()
        || config.source_name.is_null()
        || config.batch_frames == 0
        || config.batch_frames > MAX_BATCH_FRAMES
        || config.measured_batches == 0
    {
        return Err(INVALID_ARGUMENT);
    }
    CStr::from_ptr(config.root)
        .to_str()
        .map_err(|_| INVALID_ARGUMENT)?;
    CStr::from_ptr(config.source_namespace)
        .to_str()
        .map_err(|_| INVALID_ARGUMENT)?;
    CStr::from_ptr(config.source_name)
        .to_str()
        .map_err(|_| INVALID_ARGUMENT)?;

    let api = Api::copy_from(api_raw)?;
    let wasm = wat::parse_str(GUEST_WAT).map_err(|_| ENGINE_ERROR)?;
    let mut guest: Box<dyn GuestEngine> = match config.engine {
        #[cfg(feature = "wasmtime-engine")]
        ENGINE_WASMTIME => Box::new(WasmtimeGuest::new(&wasm)?),
        #[cfg(feature = "wasmer-engine")]
        ENGINE_WASMER => Box::new(WasmerGuest::new(&wasm)?),
        _ => return Err(UNSUPPORTED_ENGINE),
    };

    for _ in 0..10 {
        if guest.control()? != 7 {
            return Err(INVARIANT_ERROR);
        }
    }
    let mut controls = Vec::with_capacity(1000);
    for _ in 0..1000 {
        let (value, elapsed) = timed(|| guest.control())?;
        if value != 7 {
            return Err(INVARIANT_ERROR);
        }
        controls.push(elapsed);
    }

    let context = Context::open(&api, config.root, config.engine)?;
    let mut reader = context.open_reader(config.source_namespace, config.source_name)?;
    let total_batches = config.warmup_batches + config.measured_batches;
    let mut batch_times = Vec::with_capacity(config.measured_batches as usize);
    let mut frame_count = 0_u64;
    let mut payload_bytes = 0_u64;
    let mut copied_bytes = 0_u64;
    for batch_index in 0..total_batches {
        let ((), elapsed) = timed(|| {
            let batch = reader.read_batch(config.batch_frames)?;
            if batch.raw.frame_count != config.batch_frames {
                return Err(INVARIANT_ERROR);
            }
            let payloads = batch.payloads()?;
            let expected_first = ((batch_index * config.batch_frames) & 0xff) as u64;
            let expected_last = (((batch_index + 1) * config.batch_frames - 1) & 0xff) as u64;
            let expected = (expected_first << 32) | expected_last;
            if guest.consume(&payloads)? != expected {
                return Err(INVARIANT_ERROR);
            }
            if batch_index >= config.warmup_batches {
                frame_count += batch.raw.frame_count as u64;
                payload_bytes += batch.raw.payload_bytes;
                copied_bytes += batch.raw.payload_bytes;
            }
            Ok(())
        })?;
        if batch_index >= config.warmup_batches {
            batch_times.push(elapsed);
        }
    }

    let one_mib = reader.read_batch(1)?;
    if one_mib.raw.frame_count != 1 || one_mib.raw.payload_bytes != 1024 * 1024 {
        return Err(INVARIANT_ERROR);
    }
    let payloads = one_mib.payloads()?;
    let ((), copy_total_ns) = timed(|| {
        for _ in 0..COPY_BENCH_REPEATS {
            if guest.consume(&payloads)? != ((0x5a_u64 << 32) | 0x5a) {
                return Err(INVARIANT_ERROR);
            }
        }
        Ok(())
    })?;
    if copy_total_ns == 0 {
        return Err(INVARIANT_ERROR);
    }
    let one_mib_bytes = one_mib.raw.payload_bytes;
    let measured_copy_bytes = one_mib_bytes * COPY_BENCH_REPEATS;
    let copy_ns = copy_total_ns / COPY_BENCH_REPEATS;
    let throughput =
        ((measured_copy_bytes as u128) * 1_000_000_000_u128 / copy_total_ns as u128) as u64;
    drop(one_mib);

    let trap_contained = guest.trap_is_contained();
    let idle_delta = guest.idle_delta_bytes();
    reader.close()?;
    context.close()?;
    if !trap_contained {
        return Err(GUEST_TRAP);
    }

    report.abi_version = LIBWASM_ABI_V1;
    report.engine = config.engine;
    report.trap_contained = 1;
    report.batch_calls = config.measured_batches as u64;
    report.frame_count = frame_count;
    report.payload_bytes = payload_bytes;
    report.host_to_guest_bytes_copied = copied_bytes + measured_copy_bytes;
    report.guest_to_host_bytes_copied = 0;
    report.control_p50_ns = percentile(&mut controls.clone(), 50);
    report.control_p99_ns = percentile(&mut controls, 99);
    report.batch_4k_p50_ns = percentile(&mut batch_times.clone(), 50);
    report.batch_4k_p99_ns = percentile(&mut batch_times, 99);
    report.cold_compile_ns = guest.cold_compile_ns();
    report.cold_instantiate_ns = guest.cold_instantiate_ns();
    report.one_mib_copy_ns = copy_ns;
    report.one_mib_copy_bytes_per_second = throughput;
    report.instance_idle_delta_bytes = idle_delta;
    Ok(())
}

#[no_mangle]
/// Run one bounded libwasm probe through the supplied standard bootstrap table.
///
/// # Safety
///
/// `api`, `config`, and `report` must either be null (to exercise validation)
/// or point to readable/writable C objects whose `struct_size` covers the v1
/// fields. All strings must be NUL-terminated and remain alive for the call.
pub unsafe extern "C" fn kf_libwasm_run_v1(
    api: *const ApiV1,
    config: *const LibwasmConfigV1,
    report: *mut LibwasmReportV1,
) -> i32 {
    match catch_unwind(AssertUnwindSafe(|| run(api, config, report))) {
        Ok(Ok(())) => OK,
        Ok(Err(status)) => status,
        Err(_) => PANIC_CONTAINED,
    }
}

#[no_mangle]
pub extern "C" fn kf_libwasm_panic_probe_v1() -> i32 {
    let result = catch_unwind(|| panic!("libwasm spike panic containment probe"));
    match result {
        Ok(_) => INVARIANT_ERROR,
        Err(_) => PANIC_CONTAINED,
    }
}

#[cfg(target_os = "linux")]
fn resident_bytes() -> u64 {
    let Ok(statm) = std::fs::read_to_string("/proc/self/statm") else {
        return 0;
    };
    let Some(pages) = statm
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return 0;
    };
    pages * 4096
}

#[cfg(target_os = "macos")]
fn resident_bytes() -> u64 {
    #[repr(C)]
    struct TaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: [i32; 2],
        system_time: [i32; 2],
        policy: i32,
        suspend_count: i32,
    }
    unsafe extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(task: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
    }
    let mut info = TaskBasicInfo {
        virtual_size: 0,
        resident_size: 0,
        resident_size_max: 0,
        user_time: [0; 2],
        system_time: [0; 2],
        policy: 0,
        suspend_count: 0,
    };
    let mut count = (std::mem::size_of::<TaskBasicInfo>() / std::mem::size_of::<i32>()) as u32;
    let status = unsafe {
        task_info(
            mach_task_self(),
            20,
            (&mut info as *mut TaskBasicInfo).cast(),
            &mut count,
        )
    };
    if status == 0 {
        info.resident_size
    } else {
        0
    }
}

#[cfg(target_os = "windows")]
fn resident_bytes() -> u64 {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters = unsafe { std::mem::zeroed::<PROCESS_MEMORY_COUNTERS>() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let ok = unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if ok != 0 {
        counters.WorkingSetSize as u64
    } else {
        0
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn resident_bytes() -> u64 {
    0
}
