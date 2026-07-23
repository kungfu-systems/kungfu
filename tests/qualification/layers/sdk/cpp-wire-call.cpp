// SPDX-License-Identifier: Apache-2.0

#include <kungfu/api.hpp>
#include <kungfu/sdk/generated/runtime_action_v1.hpp>
#include <kungfu/sdk/generated/work_lifecycle_v1.hpp>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>

namespace {

std::string hex(std::string_view bytes) {
  constexpr char DIGITS[] = "0123456789abcdef";
  std::string result;
  result.reserve(bytes.size() * 2);
  for (const auto byte : bytes) {
    const auto value = static_cast<uint8_t>(byte);
    result.push_back(DIGITS[value >> 4]);
    result.push_back(DIGITS[value & 0x0f]);
  }
  return result;
}

std::string json_string(std::string_view value) {
  std::string result{"\""};
  for (const auto character : value) {
    if (character == '\\' || character == '"') {
      result.push_back('\\');
      result.push_back(character);
    } else if (character == '\n') {
      result += "\\n";
    } else if (character == '\r') {
      result += "\\r";
    } else if (character == '\t') {
      result += "\\t";
    } else {
      result.push_back(character);
    }
  }
  result.push_back('"');
  return result;
}

std::size_t json_value_end(std::string_view value, std::size_t begin) {
  if (begin >= value.size()) {
    throw std::invalid_argument("missing JSON value");
  }
  const char opening = value[begin];
  if (opening != '{' && opening != '[') {
    const auto delimiter = value.find(',', begin);
    return delimiter == std::string_view::npos ? value.size() : delimiter;
  }
  const char closing = opening == '{' ? '}' : ']';
  int depth = 0;
  bool quoted = false;
  bool escaped = false;
  for (std::size_t index = begin; index < value.size(); ++index) {
    const char character = value[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        quoted = false;
      }
      continue;
    }
    if (character == '"') {
      quoted = true;
    } else if (character == opening) {
      ++depth;
    } else if (character == closing && --depth == 0) {
      return index + 1;
    }
  }
  throw std::invalid_argument("unterminated JSON value");
}

void print(const kungfu::api::wire_response &wire, std::string_view typed_root = {}) {
  std::cout << "{\"protocolId\":\"" << wire.protocol_id << "\",\"protocolVersion\":" << wire.protocol_version
            << ",\"schemaRef\":\"" << wire.schema_ref << "\",\"encoding\":\"" << wire.encoding << "\",\"bytesHex\":\""
            << hex(wire.bytes) << "\"";
  if (!typed_root.empty()) {
    std::cout << ",\"geometryRoot\":\"" << typed_root << "\"";
  }
  std::cout << "}\n";
}

void qualification_hold() {
  const char *value = std::getenv("KUNGFU_QUALIFICATION_HOLD_MS");
  if (value == nullptr) {
    return;
  }
  const std::string raw(value);
  std::size_t consumed = 0;
  const auto milliseconds = std::stoll(raw, &consumed);
  if (consumed != raw.size() || milliseconds < 0) {
    throw std::invalid_argument("KUNGFU_QUALIFICATION_HOLD_MS must be a non-negative integer");
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

kungfu::api::wire_response invalid_projection(std::string_view id) {
  const std::string root = "sha256:" + std::string(64, 'a');
  kungfu::api::wire_response wire{
      "kungfu.runtime.action",
      1,
      "kungfu.action-runtime.result/v1",
      "application/json",
      "{\"result\":{\"geometryRoot\":\"" + root + "\"},\"schema\":\"kungfu.action-runtime.result/v1\"}",
  };
  if (id == "wrong-metadata") {
    wire.schema_ref = "kungfu.action-runtime.wrong/v1";
  } else if (id == "extra-result-field") {
    wire.bytes = "{\"result\":{\"geometryRoot\":\"" + root +
                 "\",\"unexpected\":true},\"schema\":\"kungfu.action-runtime.result/v1\"}";
  } else if (id == "wrong-layer") {
    wire.bytes = "{\"geometryRoot\":\"" + root + "\"}";
  } else if (id == "schema-punctuation-mutation") {
    wire.bytes = "{\"result\":{\"geometryRoot\":\"" + root + "\"},\"schema\":\"kungfuXaction-runtimeXresult/v1\"}";
  } else if (id == "short-root") {
    wire.bytes = "{\"result\":{\"geometryRoot\":\"sha256:a\"},\"schema\":\"kungfu.action-runtime.result/v1\"}";
  } else if (id == "trailing-comma") {
    wire.bytes = "{\"result\":{\"geometryRoot\":\"" + root + "\"},\"schema\":\"kungfu.action-runtime.result/v1\",}";
  } else {
    throw std::invalid_argument("unsupported projection-negative case");
  }
  return wire;
}

kungfu::api::wire_response semantic_projection(std::string_view id) {
  const std::string root = "sha256:" + std::string(64, 'a');
  std::string bytes;
  if (id == "reordered-envelope") {
    bytes = "{\"schema\":\"kungfu.action-runtime.result/v1\",\"result\":{\"geometryRoot\":\"" + root + "\"}}";
  } else if (id == "whitespace-envelope") {
    bytes =
        "{ \"result\" : { \"geometryRoot\" : \"" + root + "\" }, \"schema\" : \"kungfu.action-runtime.result/v1\" }";
  } else {
    throw std::invalid_argument("unsupported projection-semantic case");
  }
  return {
      "kungfu.runtime.action", 1, "kungfu.action-runtime.result/v1", "application/json", std::move(bytes),
  };
}

} // namespace

int main(int argc, char **argv) {
  try {
    if (argc != 4) {
      throw std::invalid_argument(
          "usage: kungfu-sdk-wire-cpp RUNTIME_DIR __runtime_action_wire__|__runtime_action_geometry_root__ REQUEST");
    }
    const std::string runtime_dir = argv[1];
    const std::string operation = argv[2];
    const std::string request = argv[3];
    if (operation == "__runtime_action_projection_semantic__") {
      const auto result = kungfu::sdk::generated::runtime_action_v1::parse_geometry_root(semantic_projection(request));
      std::cout << "{\"geometryRoot\":\"" << result.geometry_root << "\",\"bytesHex\":\"" << hex(result.wire.bytes)
                << "\"}\n";
      qualification_hold();
      return 0;
    }
    if (operation == "__runtime_action_projection_negative__") {
      try {
        (void)kungfu::sdk::generated::runtime_action_v1::parse_geometry_root(invalid_projection(request));
      } catch (const std::exception &) {
        std::cout << "{\"rejected\":true}\n";
        qualification_hold();
        return 0;
      }
      throw std::runtime_error("generated projection accepted an invalid response");
    }
    kf_context_config_v1 config{};
    config.struct_size = sizeof(config);
    config.runtime_dir = runtime_dir.c_str();
    config.stream_root = runtime_dir.c_str();
    config.host_namespace = "kungfu-sdk";
    config.host_name = "cpp";
    kungfu::api::context context(config);
    if (operation == "__work_lifecycle_runtime__") {
      try {
        if (request == R"({"mode":"capabilities"})") {
          print(kungfu::sdk::generated::work_lifecycle_v1::capabilities(context));
        } else {
          const auto operation_id_begin = request.find(R"("operationId":")");
          const auto input_begin = request.find(R"("input":)");
          const auto execute_begin = request.find(R"("execute":)");
          if (operation_id_begin == std::string::npos || input_begin == std::string::npos ||
              execute_begin == std::string::npos) {
            throw std::invalid_argument("invalid Work lifecycle qualification request");
          }
          const auto operation_id_value = operation_id_begin + std::string_view{R"("operationId":")"}.size();
          const auto operation_id_end = request.find('"', operation_id_value);
          const auto input_value = input_begin + std::string_view{R"("input":)"}.size();
          const auto execute_value = execute_begin + std::string_view{R"("execute":)"}.size();
          if (operation_id_end == std::string::npos) {
            throw std::invalid_argument("invalid Work lifecycle qualification operation");
          }
          const auto input_end = json_value_end(request, input_value);
          print(kungfu::sdk::generated::work_lifecycle_v1::invoke(
              context, request.substr(operation_id_value, operation_id_end - operation_id_value),
              request.substr(input_value, input_end - input_value), request.compare(execute_value, 4, "true") == 0));
        }
      } catch (const std::exception &error) {
        std::cout << "{\"rawError\":" << json_string(error.what()) << "}\n";
      }
      qualification_hold();
      return 0;
    }
    if (operation == "__runtime_action_geometry_root__") {
      auto result = kungfu::sdk::generated::runtime_action_v1::geometry_root(context);
      print(result.wire, result.geometry_root);
      qualification_hold();
      return 0;
    }
    if (operation != "__runtime_action_wire__") {
      throw std::invalid_argument("unsupported wire fixture operation");
    }
    print(kungfu::api::call_runtime_action_json(context, request));
    qualification_hold();
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "kungfu-sdk-wire-cpp: " << error.what() << "\n";
    return 1;
  }
}
