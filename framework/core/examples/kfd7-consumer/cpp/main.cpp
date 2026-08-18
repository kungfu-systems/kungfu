// SPDX-License-Identifier: Apache-2.0

#include <kungfu/api.hpp>

#include <iostream>

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: kungfu_kfd7_cpp_consumer <runtime-dir> <stream-root>\n";
    return 2;
  }

  try {
    kf_context_config_v1 config{};
    config.struct_size = sizeof(config);
    config.runtime_dir = argv[1];
    config.stream_root = argv[2];
    config.host_namespace = "kfd7-external-cpp";
    config.host_name = "consumer";

    kungfu::api::context context(config);
    const auto discovery = context.interface<kf_discovery_api_v1>(KF_INTERFACE_DISCOVERY, KF_DISCOVERY_ABI_V1);
    kf_runtime_info_v1 info{};
    info.struct_size = sizeof(info);
    kungfu::api::check(discovery.runtime_info(context.get(), &info), "runtime_info");
    context.close();
    std::cout << "{\"consumer\":\"cpp\",\"abi\":" << KF_ABI_V1 << ",\"interfaces\":" << info.interface_count
              << ",\"runtime\":\"" << info.runtime_name << "\",\"version\":\"" << info.runtime_version << "\"}\n";
    return info.interface_count == 6 ? 0 : 1;
  } catch (const std::exception &error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
