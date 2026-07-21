// SPDX-License-Identifier: Apache-2.0

use super::*;

use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const WORLD_V1: &str = "kungfu:journal/batch@1.0.0";
const CAP_JOURNAL_READ_BATCH: u64 = 1 << 0;
const MAX_MODULE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MEMORY_PAGES: u32 = 256;
const MIN_OUTPUT_BYTES: u32 = 8;

const HASH_MISMATCH: i32 = 8;
const CONTRACT_REJECTED: i32 = 9;
const LIMIT_EXCEEDED: i32 = 10;

#[repr(C)]
pub struct ExecuteConfigV1 {
    struct_size: u32,
    engine: u32,
    module_data: *const u8,
    module_size: u64,
    expected_sha256: *const c_char,
    world: *const c_char,
    granted_capabilities: u64,
    fuel: u64,
    max_memory_pages: u32,
    max_batch_frames: u32,
    max_module_bytes: u64,
    max_output_bytes: u32,
    reserved0: u32,
    root: *const c_char,
    source_namespace: *const c_char,
    source_name: *const c_char,
}

#[repr(C)]
pub struct ExecutionReceiptV1 {
    struct_size: u32,
    abi_version: u32,
    engine: u32,
    status: i32,
    admitted: u32,
    limit_exceeded: u32,
    trap_contained: u32,
    reserved0: u32,
    granted_capabilities: u64,
    fuel_limit: u64,
    fuel_consumed: u64,
    batch_calls: u64,
    frame_count: u64,
    payload_bytes: u64,
    host_to_guest_bytes_copied: u64,
    guest_result: u64,
    artifact_sha256: [c_char; 65],
    reserved1: [c_char; 7],
}

struct ModuleContract {
    bytes: Vec<u8>,
}

fn parse_text(raw: *const c_char) -> Result<String, i32> {
    if raw.is_null() {
        return Err(INVALID_ARGUMENT);
    }
    unsafe { CStr::from_ptr(raw) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| INVALID_ARGUMENT)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_hash(receipt: &mut ExecutionReceiptV1, hash: &str) {
    receipt.artifact_sha256.fill(0);
    for (target, source) in receipt
        .artifact_sha256
        .iter_mut()
        .take(64)
        .zip(hash.as_bytes())
    {
        *target = *source as c_char;
    }
}

fn preflight_module(raw: &[u8], max_pages: u32) -> Result<ModuleContract, i32> {
    let bytes = wat::parse_bytes(raw)
        .map_err(|_| CONTRACT_REJECTED)?
        .into_owned();
    let mut memories = 0_u32;
    let mut exports = BTreeSet::new();
    for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
        match payload.map_err(|_| CONTRACT_REJECTED)? {
            wasmparser::Payload::ImportSection(section) => {
                if section.count() != 0 {
                    return Err(CONTRACT_REJECTED);
                }
            }
            wasmparser::Payload::MemorySection(section) => {
                for memory in section {
                    let memory = memory.map_err(|_| CONTRACT_REJECTED)?;
                    memories += 1;
                    let maximum = memory.maximum.ok_or(CONTRACT_REJECTED)?;
                    if memory.memory64
                        || memory.shared
                        || memory.initial == 0
                        || memory.initial > max_pages as u64
                        || maximum != memory.initial
                    {
                        return Err(CONTRACT_REJECTED);
                    }
                }
            }
            wasmparser::Payload::TableSection(section) => {
                if section.count() != 0 {
                    return Err(CONTRACT_REJECTED);
                }
            }
            wasmparser::Payload::StartSection { .. } => return Err(CONTRACT_REJECTED),
            wasmparser::Payload::ExportSection(section) => {
                for export in section {
                    exports.insert(export.map_err(|_| CONTRACT_REJECTED)?.name.to_string());
                }
            }
            _ => {}
        }
    }
    if memories != 1
        || !exports.contains("memory")
        || !exports.contains("kf_control_v1")
        || !exports.contains("kf_consume_v1")
    {
        return Err(CONTRACT_REJECTED);
    }
    Ok(ModuleContract { bytes })
}

trait ProductionGuest {
    fn control(&mut self) -> Result<i32, i32>;
    fn consume(&mut self, payloads: &[&[u8]]) -> Result<u64, i32>;
    fn remaining_fuel(&mut self) -> Result<u64, i32>;
    fn fuel_exhausted(&mut self) -> bool;
}

#[cfg(feature = "wasmtime-engine")]
struct WasmtimeProductionGuest {
    store: wasmtime::Store<()>,
    memory: wasmtime::Memory,
    control: wasmtime::TypedFunc<(), i32>,
    consume: wasmtime::TypedFunc<(i32, i32), i64>,
}

#[cfg(feature = "wasmtime-engine")]
impl WasmtimeProductionGuest {
    fn new(wasm: &[u8], fuel: u64) -> Result<Self, i32> {
        let mut config = wasmtime::Config::new();
        config.consume_fuel(true);
        let engine = wasmtime::Engine::new(&config).map_err(|_| ENGINE_ERROR)?;
        let module = wasmtime::Module::new(&engine, wasm).map_err(|_| CONTRACT_REJECTED)?;
        let mut store = wasmtime::Store::new(&engine, ());
        store.set_fuel(fuel).map_err(|_| ENGINE_ERROR)?;
        let instance =
            wasmtime::Instance::new(&mut store, &module, &[]).map_err(|_| ENGINE_ERROR)?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or(CONTRACT_REJECTED)?;
        let control = instance
            .get_typed_func::<(), i32>(&mut store, "kf_control_v1")
            .map_err(|_| CONTRACT_REJECTED)?;
        let consume = instance
            .get_typed_func::<(i32, i32), i64>(&mut store, "kf_consume_v1")
            .map_err(|_| CONTRACT_REJECTED)?;
        Ok(Self {
            store,
            memory,
            control,
            consume,
        })
    }
}

#[cfg(feature = "wasmtime-engine")]
impl ProductionGuest for WasmtimeProductionGuest {
    fn control(&mut self) -> Result<i32, i32> {
        self.control.call(&mut self.store, ()).map_err(|_| {
            if self.fuel_exhausted() {
                LIMIT_EXCEEDED
            } else {
                GUEST_TRAP
            }
        })
    }

    fn consume(&mut self, payloads: &[&[u8]]) -> Result<u64, i32> {
        let total = payloads.iter().map(|payload| payload.len()).sum::<usize>();
        if total == 0 || total > self.memory.data_size(&self.store) {
            return Err(LIMIT_EXCEEDED);
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
            .map_err(|_| {
                if self.fuel_exhausted() {
                    LIMIT_EXCEEDED
                } else {
                    GUEST_TRAP
                }
            })
    }

    fn remaining_fuel(&mut self) -> Result<u64, i32> {
        self.store.get_fuel().map_err(|_| ENGINE_ERROR)
    }

    fn fuel_exhausted(&mut self) -> bool {
        matches!(self.store.get_fuel(), Ok(0))
    }
}

#[cfg(feature = "wasmer-engine")]
struct WasmerProductionGuest {
    store: wasmer::Store,
    instance: wasmer::Instance,
    memory: wasmer::Memory,
    control: wasmer::TypedFunction<(), i32>,
    consume: wasmer::TypedFunction<(i32, i32), i64>,
}

#[cfg(feature = "wasmer-engine")]
impl WasmerProductionGuest {
    fn new(wasm: &[u8], fuel: u64) -> Result<Self, i32> {
        use std::sync::Arc;
        use wasmer::sys::{CompilerConfig, Cranelift, EngineBuilder};
        use wasmer_middlewares::Metering;

        let metering = Arc::new(Metering::new(fuel, |_| 1));
        let mut compiler = Cranelift::default();
        compiler.push_middleware(metering);
        let mut store = wasmer::Store::new(EngineBuilder::new(compiler));
        let module = wasmer::Module::new(&store, wasm).map_err(|_| CONTRACT_REJECTED)?;
        let instance = wasmer::Instance::new(&mut store, &module, &wasmer::imports! {})
            .map_err(|_| ENGINE_ERROR)?;
        let memory = instance
            .exports
            .get_memory("memory")
            .map_err(|_| CONTRACT_REJECTED)?
            .clone();
        let control = instance
            .exports
            .get_typed_function::<(), i32>(&store, "kf_control_v1")
            .map_err(|_| CONTRACT_REJECTED)?;
        let consume = instance
            .exports
            .get_typed_function::<(i32, i32), i64>(&store, "kf_consume_v1")
            .map_err(|_| CONTRACT_REJECTED)?;
        Ok(Self {
            store,
            instance,
            memory,
            control,
            consume,
        })
    }
}

#[cfg(feature = "wasmer-engine")]
impl ProductionGuest for WasmerProductionGuest {
    fn control(&mut self) -> Result<i32, i32> {
        self.control.call(&mut self.store).map_err(|_| {
            if self.fuel_exhausted() {
                LIMIT_EXCEEDED
            } else {
                GUEST_TRAP
            }
        })
    }

    fn consume(&mut self, payloads: &[&[u8]]) -> Result<u64, i32> {
        let total = payloads.iter().map(|payload| payload.len()).sum::<usize>();
        if total == 0 || total > self.memory.view(&self.store).data_size() as usize {
            return Err(LIMIT_EXCEEDED);
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
            .map_err(|_| {
                if self.fuel_exhausted() {
                    LIMIT_EXCEEDED
                } else {
                    GUEST_TRAP
                }
            })
    }

    fn remaining_fuel(&mut self) -> Result<u64, i32> {
        use wasmer_middlewares::metering::{get_remaining_points, MeteringPoints};
        match get_remaining_points(&mut self.store, &self.instance) {
            MeteringPoints::Remaining(points) => Ok(points),
            MeteringPoints::Exhausted => Ok(0),
        }
    }

    fn fuel_exhausted(&mut self) -> bool {
        use wasmer_middlewares::metering::{get_remaining_points, MeteringPoints};
        matches!(
            get_remaining_points(&mut self.store, &self.instance),
            MeteringPoints::Exhausted
        )
    }
}

unsafe fn execute(
    api_raw: *const ApiV1,
    config: &ExecuteConfigV1,
    receipt: &mut ExecutionReceiptV1,
) -> Result<(), i32> {
    if config.struct_size < std::mem::size_of::<ExecuteConfigV1>() as u32
        || config.module_data.is_null()
        || config.module_size < 8
        || config.module_size > config.max_module_bytes
        || config.max_module_bytes > MAX_MODULE_BYTES
        || config.expected_sha256.is_null()
        || config.world.is_null()
        || config.root.is_null()
        || config.source_namespace.is_null()
        || config.source_name.is_null()
        || config.granted_capabilities != CAP_JOURNAL_READ_BATCH
        || config.fuel < 1_000
        || config.max_memory_pages == 0
        || config.max_memory_pages > MAX_MEMORY_PAGES
        || config.max_batch_frames == 0
        || config.max_batch_frames > MAX_BATCH_FRAMES
        || config.max_output_bytes < MIN_OUTPUT_BYTES
    {
        return Err(INVALID_ARGUMENT);
    }
    if parse_text(config.world)? != WORLD_V1 {
        return Err(CONTRACT_REJECTED);
    }
    for raw in [config.root, config.source_namespace, config.source_name] {
        parse_text(raw)?;
    }
    let raw_module = slice::from_raw_parts(config.module_data, config.module_size as usize);
    let hash = sha256_hex(raw_module);
    write_hash(receipt, &hash);
    if parse_text(config.expected_sha256)? != hash {
        return Err(HASH_MISMATCH);
    }
    let module = preflight_module(raw_module, config.max_memory_pages)?;
    let api = Api::copy_from(api_raw)?;
    let mut guest: Box<dyn ProductionGuest> = match config.engine {
        #[cfg(feature = "wasmtime-engine")]
        ENGINE_WASMTIME => Box::new(WasmtimeProductionGuest::new(&module.bytes, config.fuel)?),
        #[cfg(feature = "wasmer-engine")]
        ENGINE_WASMER => Box::new(WasmerProductionGuest::new(&module.bytes, config.fuel)?),
        _ => return Err(UNSUPPORTED_ENGINE),
    };

    let _control = guest.control()?;
    let context = Context::open(&api, config.root, config.engine)?;
    let mut reader = context.open_reader(config.source_namespace, config.source_name)?;
    let batch = reader.read_batch(config.max_batch_frames)?;
    let payloads = batch.payloads()?;
    if batch.raw.frame_count != 0 {
        receipt.guest_result = guest.consume(&payloads)?;
        receipt.batch_calls = 1;
        receipt.frame_count = batch.raw.frame_count as u64;
        receipt.payload_bytes = batch.raw.payload_bytes;
        receipt.host_to_guest_bytes_copied = batch.raw.payload_bytes;
    }
    drop(batch);
    reader.close()?;
    context.close()?;
    let remaining = guest.remaining_fuel()?;
    receipt.fuel_consumed = config.fuel.saturating_sub(remaining);
    receipt.admitted = 1;
    receipt.trap_contained = 1;
    Ok(())
}

#[no_mangle]
/// Execute one admitted, bounded batch through the selected production engine.
///
/// # Safety
///
/// The caller must keep every pointed-to object and NUL-terminated string alive
/// for the call. `struct_size` must cover the complete v1 structure.
pub unsafe extern "C" fn kf_libwasm_execute_v1(
    api: *const ApiV1,
    config: *const ExecuteConfigV1,
    receipt: *mut ExecutionReceiptV1,
) -> i32 {
    if config.is_null() || receipt.is_null() {
        return INVALID_ARGUMENT;
    }
    let receipt = &mut *receipt;
    if receipt.struct_size < std::mem::size_of::<ExecutionReceiptV1>() as u32 {
        return INVALID_ARGUMENT;
    }
    receipt.abi_version = LIBWASM_ABI_V1;
    receipt.engine = (*config).engine;
    receipt.status = INVALID_ARGUMENT;
    receipt.admitted = 0;
    receipt.limit_exceeded = 0;
    receipt.trap_contained = 0;
    receipt.granted_capabilities = (*config).granted_capabilities;
    receipt.fuel_limit = (*config).fuel;
    let status = match catch_unwind(AssertUnwindSafe(|| execute(api, &*config, receipt))) {
        Ok(Ok(())) => OK,
        Ok(Err(status)) => status,
        Err(_) => PANIC_CONTAINED,
    };
    receipt.status = status;
    receipt.limit_exceeded = u32::from(status == LIMIT_EXCEEDED);
    receipt.trap_contained =
        u32::from(status == OK || status == GUEST_TRAP || status == LIMIT_EXCEEDED);
    status
}

#[no_mangle]
pub extern "C" fn kf_libwasm_self_test_v1() -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let valid = wat::parse_str(
            r#"(module
              (memory (export "memory") 1 1)
              (func (export "kf_control_v1") (result i32) i32.const 7)
              (func (export "kf_consume_v1") (param i32 i32) (result i64) i64.const 9))"#,
        )
        .map_err(|_| ENGINE_ERROR)?;
        #[cfg(feature = "wasmtime-engine")]
        let mut valid_guest = WasmtimeProductionGuest::new(&valid, 10_000)?;
        #[cfg(feature = "wasmer-engine")]
        let mut valid_guest = WasmerProductionGuest::new(&valid, 10_000)?;
        if valid_guest.control()? != 7 {
            return Err(INVARIANT_ERROR);
        }

        let infinite = wat::parse_str(
            r#"(module
              (memory (export "memory") 1 1)
              (func (export "kf_control_v1") (result i32)
                (loop $forever br $forever) i32.const 0)
              (func (export "kf_consume_v1") (param i32 i32) (result i64) i64.const 0))"#,
        )
        .map_err(|_| ENGINE_ERROR)?;
        #[cfg(feature = "wasmtime-engine")]
        let mut bounded_guest = WasmtimeProductionGuest::new(&infinite, 1_000)?;
        #[cfg(feature = "wasmer-engine")]
        let mut bounded_guest = WasmerProductionGuest::new(&infinite, 1_000)?;
        if bounded_guest.control() != Err(LIMIT_EXCEEDED) || !bounded_guest.fuel_exhausted() {
            return Err(INVARIANT_ERROR);
        }
        Ok(())
    }));
    match result {
        Ok(Ok(())) => OK,
        Ok(Err(status)) => status,
        Err(_) => PANIC_CONTAINED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    const VALID: &str = r#"(module
      (memory (export "memory") 2 2)
      (func (export "kf_control_v1") (result i32) i32.const 7)
      (func (export "kf_consume_v1") (param i32 i32) (result i64) i64.const 9))"#;

    #[test]
    fn contract_accepts_the_exact_bounded_world() {
        let module = preflight_module(VALID.as_bytes(), 2).expect("valid module");
        assert!(module.bytes.starts_with(b"\0asm"));
    }

    #[test]
    fn contract_rejects_imports_start_tables_and_growth() {
        for wat in [
            r#"(module (import "x" "y" (func)) (memory (export "memory") 1 1)
                (func (export "kf_control_v1") (result i32) i32.const 0)
                (func (export "kf_consume_v1") (param i32 i32) (result i64) i64.const 0))"#,
            r#"(module (memory (export "memory") 1 2)
                (func $start) (start $start)
                (func (export "kf_control_v1") (result i32) i32.const 0)
                (func (export "kf_consume_v1") (param i32 i32) (result i64) i64.const 0))"#,
            r#"(module (memory (export "memory") 1 1) (table 1 funcref)
                (func (export "kf_control_v1") (result i32) i32.const 0)
                (func (export "kf_consume_v1") (param i32 i32) (result i64) i64.const 0))"#,
        ] {
            assert_eq!(
                preflight_module(wat.as_bytes(), 2).err(),
                Some(CONTRACT_REJECTED)
            );
        }
    }

    #[test]
    fn engine_cpu_meter_contains_an_infinite_guest() {
        let wasm = wat::parse_str(
            r#"(module
              (memory (export "memory") 1 1)
              (func (export "kf_control_v1") (result i32)
                (loop $forever br $forever) i32.const 0)
              (func (export "kf_consume_v1") (param i32 i32) (result i64) i64.const 0))"#,
        )
        .expect("wat");
        #[cfg(feature = "wasmtime-engine")]
        let mut guest = WasmtimeProductionGuest::new(&wasm, 1_000).expect("wasmtime guest");
        #[cfg(feature = "wasmer-engine")]
        let mut guest = WasmerProductionGuest::new(&wasm, 1_000).expect("wasmer guest");
        assert_eq!(guest.control(), Err(LIMIT_EXCEEDED));
        assert!(guest.fuel_exhausted());
    }

    #[test]
    fn c_abi_rejects_a_hash_mismatch_before_embedding() {
        let module = wat::parse_str(VALID).expect("wat");
        let wrong_hash = CString::new("0".repeat(64)).expect("hash");
        let world = CString::new(WORLD_V1).expect("world");
        let root = CString::new("/tmp/libwasm-test").expect("root");
        let namespace = CString::new("test").expect("namespace");
        let name = CString::new("fixture").expect("name");
        let config = ExecuteConfigV1 {
            struct_size: std::mem::size_of::<ExecuteConfigV1>() as u32,
            #[cfg(feature = "wasmtime-engine")]
            engine: ENGINE_WASMTIME,
            #[cfg(feature = "wasmer-engine")]
            engine: ENGINE_WASMER,
            module_data: module.as_ptr(),
            module_size: module.len() as u64,
            expected_sha256: wrong_hash.as_ptr(),
            world: world.as_ptr(),
            granted_capabilities: CAP_JOURNAL_READ_BATCH,
            fuel: 10_000,
            max_memory_pages: 2,
            max_batch_frames: 16,
            max_module_bytes: 1_000_000,
            max_output_bytes: 64,
            reserved0: 0,
            root: root.as_ptr(),
            source_namespace: namespace.as_ptr(),
            source_name: name.as_ptr(),
        };
        let mut receipt: ExecutionReceiptV1 = unsafe { std::mem::zeroed() };
        receipt.struct_size = std::mem::size_of::<ExecutionReceiptV1>() as u32;
        let status = unsafe { kf_libwasm_execute_v1(std::ptr::null(), &config, &mut receipt) };
        assert_eq!(status, HASH_MISMATCH);
        assert_eq!(receipt.status, HASH_MISMATCH);
    }
}
