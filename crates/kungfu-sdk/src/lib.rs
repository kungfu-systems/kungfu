// SPDX-License-Identifier: Apache-2.0

//! A small Rust owner for the versioned `libkungfu` native storage table.
//!
//! The crate adds no storage semantics. Operations and JSON edge contracts are
//! forwarded verbatim to `kungfu/native_storage.h` ABI v1.

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
pub const REQUIRED_CAPABILITIES: u64 =
    CAP_EPISODE_LIFECYCLE | CAP_HEAD_AND_HISTORICAL_QUERY | CAP_FSCK | CAP_EXPORT;

const STATUS_OK: i32 = 0;

#[repr(C)]
struct ContextConfigV1 {
    struct_size: u32,
    flags: u32,
    runtime_dir: *const c_char,
    reserved: [u64; 4],
}

#[repr(C)]
struct ResultV1 {
    struct_size: u32,
    reserved: u32,
    json_data: *const c_char,
    json_size: usize,
    token: u64,
}

type ContextOpen = unsafe extern "C" fn(*const ContextConfigV1, *mut *mut c_void) -> i32;
type ContextCapabilities = unsafe extern "C" fn(*const c_void, *mut u64) -> i32;
type ContextLastError = unsafe extern "C" fn(*const c_void, *mut *const c_char, *mut usize) -> i32;
type ContextClose = unsafe extern "C" fn(*mut c_void) -> i32;
type Execute =
    unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, usize, *mut ResultV1) -> i32;
type ReleaseResult = unsafe extern "C" fn(*mut c_void, u64) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct ApiV1 {
    abi_version: u32,
    struct_size: u32,
    capabilities: u64,
    context_open: Option<ContextOpen>,
    context_capabilities: Option<ContextCapabilities>,
    context_last_error: Option<ContextLastError>,
    context_close: Option<ContextClose>,
    execute: Option<Execute>,
    release_result: Option<ReleaseResult>,
}

#[cfg(feature = "link-native")]
unsafe extern "C" {
    fn kungfu_native_storage_get_api(
        requested_version: u32,
        caller_struct_size: u32,
        out_api: *mut ApiV1,
    ) -> i32;
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
    context: *mut c_void,
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
            kungfu_native_storage_get_api(ABI_V1, mem::size_of::<ApiV1>() as u32, &mut api)
        };
        if status != STATUS_OK {
            return Err(Error::new(status, "native storage ABI negotiation failed"));
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
            reserved: [0; 4],
        };
        let mut context = ptr::null_mut();
        let open = api
            .context_open
            .ok_or_else(|| Error::new(-1, "libkungfu omitted context_open"))?;
        let status = unsafe { open(&config, &mut context) };
        if status != STATUS_OK || context.is_null() {
            return Err(Error::new(status, "native storage context open failed"));
        }
        Ok(Self { api, context })
    }

    #[cfg(not(feature = "link-native"))]
    pub fn open(_runtime_dir: impl AsRef<Path>) -> Result<Self, Error> {
        Err(Error::new(
            -1,
            "enable feature 'link-native' and set KUNGFU_NATIVE_DIR",
        ))
    }

    pub fn capabilities(&self) -> Result<u64, Error> {
        let function = self
            .api
            .context_capabilities
            .ok_or_else(|| Error::new(-1, "libkungfu omitted context_capabilities"))?;
        let mut capabilities = 0;
        let status = unsafe { function(self.context, &mut capabilities) };
        if status != STATUS_OK {
            return Err(self.context_error(status, "capability discovery failed"));
        }
        Ok(capabilities)
    }

    pub fn execute_json(&mut self, operation: &str, request_json: &str) -> Result<String, Error> {
        let operation =
            CString::new(operation).map_err(|_| Error::new(-1, "operation contains NUL"))?;
        let execute = self
            .api
            .execute
            .ok_or_else(|| Error::new(-1, "libkungfu omitted execute"))?;
        let mut result = ResultV1 {
            struct_size: mem::size_of::<ResultV1>() as u32,
            reserved: 0,
            json_data: ptr::null(),
            json_size: 0,
            token: 0,
        };
        let status = unsafe {
            execute(
                self.context,
                operation.as_ptr(),
                request_json.as_ptr().cast(),
                request_json.len(),
                &mut result,
            )
        };
        if status != STATUS_OK {
            return Err(self.context_error(status, "native storage operation failed"));
        }
        if result.json_data.is_null() || result.json_size == 0 || result.token == 0 {
            return Err(Error::new(-1, "libkungfu returned an invalid result view"));
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(result.json_data.cast::<u8>(), result.json_size) };
        let json = String::from_utf8(bytes.to_vec())
            .map_err(|_| Error::new(-1, "libkungfu returned non-UTF-8 JSON"));
        let release = self
            .api
            .release_result
            .ok_or_else(|| Error::new(-1, "libkungfu omitted release_result"))?;
        let release_status = unsafe { release(self.context, result.token) };
        if release_status != STATUS_OK {
            return Err(self.context_error(release_status, "result release failed"));
        }
        json
    }

    fn context_error(&self, status: i32, fallback: &str) -> Error {
        let Some(last_error) = self.api.context_last_error else {
            return Error::new(status, fallback);
        };
        let mut data = ptr::null();
        let mut size = 0;
        if unsafe { last_error(self.context, &mut data, &mut size) } != STATUS_OK || data.is_null()
        {
            return Error::new(status, fallback);
        }
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), size) };
        Error::new(status, String::from_utf8_lossy(bytes).into_owned())
    }
}

impl Drop for NativeStorage {
    fn drop(&mut self) {
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
        assert_eq!(REQUIRED_CAPABILITIES, 0b1111);
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
