// SPDX-License-Identifier: Apache-2.0

//! Production libwasm adapters share the spike-proven embedding membrane while
//! adding artifact admission, an engine-neutral guest contract, and equivalent
//! CPU metering. The spike exports stay isolated behind their original Cargo
//! packages; production packages enable the `production` feature below.

include!("../../libwasm-spike/src/lib.rs");

#[cfg(feature = "production")]
mod production;
