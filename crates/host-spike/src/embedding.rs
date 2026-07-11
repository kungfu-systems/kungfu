// SPDX-License-Identifier: Apache-2.0

//! Safe, std-only Rust wrapper for the libkungfu embedding C ABI spike.
//!
//! The unsafe surface is confined to this module. `Batch` mutably borrows its
//! reader, so mmap-backed payload slices cannot outlive explicit batch release.

use std::ffi::{c_char, c_void, CString};
use std::marker::PhantomData;
use std::slice;

const ABI_V1: u32 = 1;
const OK: i32 = 0;

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

type ContextOpen = unsafe extern "C" fn(*const ContextConfigV1, *mut *mut c_void) -> i32;
type ContextCapabilities = unsafe extern "C" fn(*const c_void, *mut u64) -> i32;
type ContextClose = unsafe extern "C" fn(*mut c_void) -> i32;
type ReaderOpen = unsafe extern "C" fn(*mut c_void, *const LocationV1, *mut *mut c_void) -> i32;
type ReaderReadBatch = unsafe extern "C" fn(*mut c_void, u32, *mut BatchV1) -> i32;
type ReaderReleaseBatch = unsafe extern "C" fn(*mut c_void, u64) -> i32;
type ReaderClose = unsafe extern "C" fn(*mut c_void) -> i32;

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

extern "C" {
    fn kungfu_embedding_get_api(
        requested_version: u32,
        caller_struct_size: u32,
        out_api: *mut ApiV1,
    ) -> i32;
}

fn status(operation: &str, value: i32) -> Result<(), String> {
    if value == OK {
        Ok(())
    } else {
        Err(format!("{operation} failed with embedding status {value}"))
    }
}

fn api_v1() -> Result<ApiV1, String> {
    let mut api = std::mem::MaybeUninit::<ApiV1>::uninit();
    let result = unsafe {
        kungfu_embedding_get_api(
            ABI_V1,
            std::mem::size_of::<ApiV1>() as u32,
            api.as_mut_ptr(),
        )
    };
    status("kungfu_embedding_get_api", result)?;
    let api = unsafe { api.assume_init() };
    if api.abi_version != ABI_V1 || api.struct_size < std::mem::size_of::<ApiV1>() as u32 {
        return Err("libkungfu returned an incompatible embedding table".to_string());
    }
    Ok(api)
}

pub struct Context {
    api: ApiV1,
    raw: *mut c_void,
}

impl Context {
    pub fn open(root: &str) -> Result<Self, String> {
        let api = api_v1()?;
        let root = CString::new(root).map_err(|_| "root contains NUL")?;
        let namespace = CString::new("host_spike").unwrap();
        let name = CString::new("rust").unwrap();
        let config = ContextConfigV1 {
            struct_size: std::mem::size_of::<ContextConfigV1>() as u32,
            flags: 0,
            root: root.as_ptr(),
            host_namespace: namespace.as_ptr(),
            host_name: name.as_ptr(),
            mode: 0,
            reserved: [0; 7],
        };
        let mut raw = std::ptr::null_mut();
        status("context_open", unsafe {
            (api.context_open)(&config, &mut raw)
        })?;
        Ok(Self { api, raw })
    }

    pub fn open_reader<'a>(&'a self, namespace: &str, name: &str) -> Result<Reader<'a>, String> {
        let namespace = CString::new(namespace).map_err(|_| "namespace contains NUL")?;
        let name = CString::new(name).map_err(|_| "name contains NUL")?;
        let location = LocationV1 {
            struct_size: std::mem::size_of::<LocationV1>() as u32,
            dest_id: 0,
            from_time: 0,
            namespace_name: namespace.as_ptr(),
            name: name.as_ptr(),
            mode: 0,
            role: 3,
            reserved: [0; 6],
        };
        let mut raw = std::ptr::null_mut();
        status("reader_open", unsafe {
            (self.api.reader_open)(self.raw, &location, &mut raw)
        })?;
        Ok(Reader {
            api: self.api,
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
    api: ApiV1,
    raw: *mut c_void,
    _context: PhantomData<&'context Context>,
}

impl<'context> Reader<'context> {
    pub fn read_batch<'reader>(
        &'reader mut self,
        max_frames: u32,
    ) -> Result<Batch<'reader, 'context>, String> {
        let mut raw = BatchV1 {
            struct_size: std::mem::size_of::<BatchV1>() as u32,
            frame_count: 0,
            frames: std::ptr::null(),
            payload_bytes: 0,
            payload_bytes_copied: 0,
            token: 0,
        };
        status("reader_read_batch", unsafe {
            (self.api.reader_read_batch)(self.raw, max_frames, &mut raw)
        })?;
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
    pub fn msg_type(&self) -> i32 {
        self.raw.msg_type
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

    pub fn payload_bytes_copied(&self) -> u64 {
        self.raw.payload_bytes_copied
    }
}

impl Drop for Batch<'_, '_> {
    fn drop(&mut self) {
        if self.raw.token != 0 {
            let result =
                unsafe { (self.reader.api.reader_release_batch)(self.reader.raw, self.raw.token) };
            debug_assert_eq!(result, OK);
        }
    }
}
