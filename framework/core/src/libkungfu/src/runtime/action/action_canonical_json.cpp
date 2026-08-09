// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_canonical_json.h>

namespace kungfu::runtime::action {

namespace {

void validate_action_canonical_json(const nlohmann::json &value) {
  if (value.is_number_float()) {
    throw canonical_json_error("canonical-float-unsupported",
                               "canonical JSON identity protocols do not admit floating-point values");
  }
  if (value.is_number_unsigned() && value.get<uint64_t>() > static_cast<uint64_t>(CANONICAL_JSON_MAX_INTEGER)) {
    throw canonical_json_error("canonical-integer-range",
                               "canonical JSON integers must be within the protocol safe range");
  }
  if (value.is_array()) {
    for (const auto &item : value)
      validate_action_canonical_json(item);
  } else if (value.is_object()) {
    for (const auto &[key, item] : value.items()) {
      (void)key;
      validate_action_canonical_json(item);
    }
  }
}

std::string encode_action_canonical_json(const nlohmann::json &value) {
  if (value.is_null())
    return "null";
  if (value.is_boolean())
    return value.get<bool>() ? "true" : "false";
  if (value.is_string())
    return value.dump(-1, ' ', /*ensure_ascii=*/false, nlohmann::json::error_handler_t::strict);
  if (value.is_number_unsigned())
    return std::to_string(value.get<uint64_t>());
  if (value.is_number_integer())
    return std::to_string(value.get<int64_t>());
  if (value.is_array()) {
    std::string result = "[";
    for (size_t index = 0; index < value.size(); ++index) {
      if (index != 0)
        result += ",";
      result += encode_action_canonical_json(value.at(index));
    }
    return result + "]";
  }
  std::string result = "{";
  bool first = true;
  for (const auto &[key, item] : value.items()) {
    if (!first)
      result += ",";
    first = false;
    result += nlohmann::json(key).dump(-1, ' ', /*ensure_ascii=*/false, nlohmann::json::error_handler_t::strict);
    result += ":";
    result += encode_action_canonical_json(item);
  }
  return result + "}";
}

} // namespace

std::string action_canonical_json(const nlohmann::json &value) {
  validate_action_canonical_json(value);
  try {
    return encode_action_canonical_json(value);
  } catch (const nlohmann::json::type_error &error) {
    throw canonical_json_error("canonical-invalid-unicode", error.what());
  }
}

} // namespace kungfu::runtime::action
