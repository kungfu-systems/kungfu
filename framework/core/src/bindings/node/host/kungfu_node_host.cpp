// SPDX-License-Identifier: Apache-2.0

//
// Python-free Node launcher entry (ADR-0046 stage 3).
//
// The `kungfu` front door (the Rust trunk) runs the KUNGFU_AS_VARIANT=node
// variant by dlopening this library and calling `kungfu_node_run` — the same
// node::Start the pykungfu binding drives (see
// bindings/python/binding/py-libnode.cpp), but reachable *without* initializing
// CPython, so a node-only invocation never pays the domain-runtime startup tax.
//
// This is not a napi addon: it is a standalone shared library the product ships
// next to the front door (dist/kungfu). Its only export is the C entry below; it
// links libnode directly and inherits the core's @loader_path/$ORIGIN rpath, so it
// resolves the sibling libnode at load time.
//

#include <node.h>

#if defined(_WIN32)
#define KF_NODE_HOST_EXPORT __declspec(dllexport)
#else
#define KF_NODE_HOST_EXPORT __attribute__((visibility("default")))
#endif

extern "C" {

// Start the embedded Node runtime with the given argv (argv[0] = program name),
// run it to completion, and return its exit code. Mirrors the node::Start call
// the pykungfu `libnode.run` binding makes; the trunk supplies the same argv it
// received, so behavior matches the Python-side node variant.
KF_NODE_HOST_EXPORT int kungfu_node_run(int argc, char **argv) { return node::Start(argc, argv); }

} // extern "C"
