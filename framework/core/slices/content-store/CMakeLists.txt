# SPDX-License-Identifier: Apache-2.0
#
# content-store slice: standalone probe of the KF-ADR-019f86da-4f90-738c-b372-e509976f69ff immutable
# content-addressed store contract and its dependency-free file backend.
# Links only the yijinjing journal core -- the cut-proof in run.mjs asserts
# no other dynamic dependency, which is the point: the kernel content store
# stands with zero engine dependencies.

project(content_store_slice)

find_package(Threads REQUIRED)

add_executable(content_store_probe probe.cpp)
target_link_libraries(content_store_probe yijinjing Threads::Threads)
