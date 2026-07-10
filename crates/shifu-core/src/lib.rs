// SPDX-License-Identifier: Apache-2.0
//
// shifu-core — the shifu role as a library: the parts of "the one you turn to
// when your kungfu fails you" that more than one binary needs to carry.
//
// The dev launcher (crates/shifu) is the role's first bearer; the product's
// Rust trunk is the next (ADR-0046: stage 1 shares the bootstrap leg for the
// lazy pinned-uv fetch, stage 3 consumes the rest). This crate exists so each
// new appearance of the role — install diagnostics, self-update, crash triage
// — adds a probe or a tool spec instead of re-implementing downloads and
// checklists.
//
// Two legs, two disciplines:
//
//   bootstrap — acquire pinned tools: download the exact pinned version,
//               verify the pinned SHA-256, cache user-globally, honor mirror
//               overrides. A failed fetch is a named error carrying the exact
//               URL, the expected checksum, and the mirror override to set —
//               self-diagnosing by construction.
//   probe     — declarative environment checks. Reports, never repairs: a
//               probe may name the exact repair command, but running it is a
//               human (or explicit verb) decision, never a doctor side effect.
//
// std-only on purpose, like the launcher: the helper of last resort cannot
// afford dependencies of its own (docs/rust-adoption.md).

pub mod bootstrap;
pub mod host;
pub mod probe;
pub mod style;
