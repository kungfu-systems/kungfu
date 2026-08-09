// SPDX-License-Identifier: Apache-2.0

//! Shared Rust projection of the standard versioned libkungfu ABI.
//!
//! This module owns only Rust FFI declarations. The public C header remains
//! the ABI authority, and safe ownership stays in each consuming crate.

use std::ffi::{c_char, c_void};

#[repr(C)]
pub struct ContextConfigV1 {
    pub struct_size: u32,
    pub flags: u32,
    pub runtime_dir: *const c_char,
    pub stream_root: *const c_char,
    pub host_namespace: *const c_char,
    pub host_name: *const c_char,
    pub mode: u8,
    pub reserved0: [u8; 7],
    pub default_timeout_ms: u64,
    pub reserved1: [u64; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SemanticMessageV1 {
    pub struct_size: u32,
    pub flags: u32,
    pub protocol_id: *const c_char,
    pub protocol_version: u32,
    pub reserved0: u32,
    pub schema_ref: *const c_char,
    pub encoding: *const c_char,
    pub bytes: *const u8,
    pub byte_size: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct OwnedMessageV1 {
    pub struct_size: u32,
    pub flags: u32,
    pub message: SemanticMessageV1,
    pub token: u64,
}

pub type ContextOpen = unsafe extern "C" fn(*const ContextConfigV1, *mut *mut c_void) -> i32;
pub type ContextCapabilities = unsafe extern "C" fn(*const c_void, *mut u64) -> i32;
pub type ContextLastError =
    unsafe extern "C" fn(*const c_void, *mut *const c_char, *mut u64) -> i32;
pub type ContextRequestCancel = unsafe extern "C" fn(*mut c_void) -> i32;
pub type ContextResetCancel = unsafe extern "C" fn(*mut c_void) -> i32;
pub type InterfaceGet = unsafe extern "C" fn(*mut c_void, u32, u32, u32, *mut c_void) -> i32;
pub type ContextClose = unsafe extern "C" fn(*mut c_void) -> i32;
pub type ResultRelease = unsafe extern "C" fn(*mut c_void, u64) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ApiV1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub capabilities: u64,
    pub context_open: Option<ContextOpen>,
    pub context_capabilities: Option<ContextCapabilities>,
    pub context_last_error: Option<ContextLastError>,
    pub context_request_cancel: Option<ContextRequestCancel>,
    pub context_reset_cancel: Option<ContextResetCancel>,
    pub interface_get: Option<InterfaceGet>,
    pub context_close: Option<ContextClose>,
}

pub type MaintenanceExecute =
    unsafe extern "C" fn(*mut c_void, u32, *const SemanticMessageV1, *mut OwnedMessageV1) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MaintenanceApiV1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub capabilities: u64,
    pub execute: Option<MaintenanceExecute>,
    pub result_release: Option<ResultRelease>,
}

#[allow(dead_code)]
unsafe extern "C" {
    pub fn kungfu_get_api(
        requested_version: u32,
        caller_struct_size: u32,
        out_api: *mut c_void,
    ) -> i32;
}
