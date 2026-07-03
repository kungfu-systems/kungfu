cmake_minimum_required(VERSION 3.23)
project(probe_cpp CXX)

include(${CMAKE_CURRENT_LIST_DIR}/cmake/kungfu.cmake)

kungfu_cpp_extension(probe_cpp)
