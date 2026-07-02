# SPDX-License-Identifier: Apache-2.0
#
# wingchun trading semantics, kept as a dormant module.
#
# The tracing-foundation cut moved trading semantics (book/broker/strategy/
# operator/...) out of the libkungfu build. This directory keeps that boundary
# physical: headers under include/, sources under src/, none of the sources
# compiled. The only live surface is a small header-only slice (instrument
# utils in kungfu/wingchun/common.h) that the language bindings still use,
# exposed through this interface target.
#
# Reviving wingchun as a compiled library is a deliberate decision, not a
# build-flag flip; it would need its own target definition and a fresh pass
# over these sources.

add_library(wingchun_headers INTERFACE)
target_include_directories(wingchun_headers INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
