cmake_minimum_required(VERSION 3.20)
project(kungfu_sdk_wire_fixture LANGUAGES CXX)

find_package(Kungfu 4 CONFIG REQUIRED)

add_executable(kungfu-sdk-wire-cpp cpp-wire-call.cpp)
target_compile_features(kungfu-sdk-wire-cpp PRIVATE cxx_std_20)
target_link_libraries(kungfu-sdk-wire-cpp PRIVATE Kungfu::kungfu)
