// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/profile/initiative_assignment_service.h>

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <algorithm>
#include <filesystem>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace kungfu::runtime::profile {

namespace action = kungfu::runtime::action;
namespace fs = std::filesystem;
namespace yy = kungfu::yijinjing;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

constexpr const char *JOURNAL_NAMESPACE = "initiative-assignment";
constexpr const char *JOURNAL_NAME = "admission";

bool exact_fields(const nlohmann::json &value, const std::set<std::string> &expected) {
  if (!value.is_object() || value.size() != expected.size())
    return false;
  return std::all_of(expected.begin(), expected.end(), [&value](const auto &field) { return value.contains(field); });
}

std::string required_text(const nlohmann::json &value, const char *field) {
  if (!value.contains(field) || !value.at(field).is_string() || value.at(field).get<std::string>().empty())
    throw std::invalid_argument(std::string("native admission requires non-empty text: ") + field);
  return value.at(field).get<std::string>();
}

bool lowercase_hex(std::string_view value, size_t size) {
  return value.size() == size && std::all_of(value.begin(), value.end(), [](char ch) {
           return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
         });
}

bool canonical_root(std::string_view value) {
  return value.starts_with("sha256:") && lowercase_hex(value.substr(7), 64);
}

std::string content_root(std::string_view bytes) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(bytes.data(), bytes.size()));
}

std::string protocol_root(std::string_view protocol, const nlohmann::json &value) {
  std::string preimage(protocol);
  preimage.push_back('\0');
  preimage += action::action_canonical_json(value);
  return content_root(preimage);
}

const std::set<std::string> EVIDENCE_FIELDS = {"historicalNoRewriteRoot",  "nativeImplementationRoot",
                                               "platformEvidenceRoot",     "pythonImplementationRoot",
                                               "rootProtocolContractRoot", "vectorRoot"};

void validate_admission(const nlohmann::json &request) {
  if (!exact_fields(request, {"assignmentId", "evidence", "expectedRoot", "rootInput", "schema", "serviceContractRoot",
                              "source"}) ||
      required_text(request, "schema") != INITIATIVE_ASSIGNMENT_NATIVE_ADMISSION_V1)
    throw std::invalid_argument("native admission field set or schema is invalid");
  (void)required_text(request, "assignmentId");
  const auto expected_root = required_text(request, "expectedRoot");
  const auto service_root = required_text(request, "serviceContractRoot");
  if (!canonical_root(expected_root) || !canonical_root(service_root))
    throw std::invalid_argument("native admission Roots must use canonical sha256 form");
  const auto contract = initiative_assignment_native_contract();
  if (service_root != contract.at("contractRoot").get<std::string>())
    throw std::invalid_argument("native service contract Root does not match the embedded contract");

  const auto &source = request.at("source");
  if (!exact_fields(source, {"head", "tree"}) || !lowercase_hex(required_text(source, "head"), 40) ||
      !lowercase_hex(required_text(source, "tree"), 40))
    throw std::invalid_argument("source head and tree must be exact lowercase Git object ids");
  const auto &evidence = request.at("evidence");
  if (!exact_fields(evidence, EVIDENCE_FIELDS))
    throw std::invalid_argument("native admission evidence field set is incomplete");
  for (const auto &field : EVIDENCE_FIELDS) {
    if (!canonical_root(required_text(evidence, field.c_str())))
      throw std::invalid_argument("native admission evidence Roots must use canonical sha256 form");
  }
  if (evidence.at("pythonImplementationRoot") == evidence.at("nativeImplementationRoot"))
    throw std::invalid_argument("Python and native implementation identities must be independent");
  const auto computed = compute_initiative_assignment_root(request.at("rootInput"));
  if (computed.at("root") != expected_root)
    throw std::invalid_argument("native admission expected Root does not match the independent C++ computation");
}

nlohmann::json admission_identity(const nlohmann::json &request) {
  return {{"assignmentId", request.at("assignmentId")},
          {"evidence", request.at("evidence")},
          {"expectedRoot", request.at("expectedRoot")},
          {"rootInput", request.at("rootInput")},
          {"schema", request.at("schema")},
          {"serviceContractRoot", request.at("serviceContractRoot")},
          {"source", request.at("source")}};
}

nlohmann::json make_event(const nlohmann::json &request) {
  auto event = nlohmann::json{{"admission", admission_identity(request)},
                              {"assignmentId", request.at("assignmentId")},
                              {"bindingRoot", protocol_root(INITIATIVE_ASSIGNMENT_NATIVE_ADMISSION_V1, request)},
                              {"computedRoot", request.at("expectedRoot")},
                              {"schema", INITIATIVE_ASSIGNMENT_NATIVE_EVENT_V1}};
  event["eventRoot"] = protocol_root(INITIATIVE_ASSIGNMENT_NATIVE_EVENT_V1, event);
  return event;
}

action::record_receipt append_event(const std::string &runtime_dir, const nlohmann::json &event) {
  action::action_recorder recorder(runtime_dir, JOURNAL_NAMESPACE, JOURNAL_NAME);
  const auto bytes = action::action_canonical_json(event);
  view::action::envelope envelope{};
  envelope.action_type = "initiative-assignment.admit";
  envelope.schema_ref = {INITIATIVE_ASSIGNMENT_NATIVE_EVENT_V1, 1};
  envelope.payload = view::action::payload_view{view::action::payload_encoding::Json,
                                                std::vector<uint8_t>(bytes.begin(), bytes.end()),
                                                {},
                                                {},
                                                0,
                                                "application/json",
                                                "present"};
  return recorder.record_action(envelope);
}

struct replayed_event {
  nlohmann::json event;
  uint64_t frame_uid = 0;
  uint32_t source = 0;
  uint32_t dest = 0;
  int64_t gen_time = 0;
};

std::vector<replayed_event> read_events(const std::string &runtime_dir) {
  const auto journal_dir = fs::path(runtime_dir) / "journal" / "system" / JOURNAL_NAMESPACE / JOURNAL_NAME / "live";
  if (!fs::exists(journal_dir))
    return {};
  auto locator = std::make_shared<yy::data::locator>(runtime_dir);
  auto location = yy::data::location::make_shared(yy::enums::mode::LIVE, yy::enums::location_role::SYSTEM,
                                                  JOURNAL_NAMESPACE, JOURNAL_NAME, locator);
  std::vector<replayed_event> events;
  try {
    yy::journal::assemble reader(location, yy::data::location::PUBLIC, yy::enums::AssembleMode::Channel, 0);
    while (reader.data_available()) {
      const auto frame = reader.current_frame();
      if (frame->carrier_type() == view::action::ACTION_ENVELOPE_CARRIER_TYPE) {
        std::string error;
        const auto envelope = view::action::decode(reinterpret_cast<const uint8_t *>(frame->data_as_bytes()),
                                                   frame->data_length(), &error);
        if (!envelope.has_value())
          throw std::runtime_error("cannot decode Initiative/Assignment action envelope: " + error);
        if (envelope->schema_ref.id == INITIATIVE_ASSIGNMENT_NATIVE_EVENT_V1) {
          if (envelope->schema_ref.version != 1 || !envelope->payload.has_value() ||
              envelope->payload->encoding != view::action::payload_encoding::Json)
            throw std::runtime_error("Initiative/Assignment journal event has an invalid version or encoding");
          const auto &payload = envelope->payload->data;
          auto event = nlohmann::json::parse(payload.begin(), payload.end());
          if (!exact_fields(event,
                            {"admission", "assignmentId", "bindingRoot", "computedRoot", "eventRoot", "schema"}) ||
              required_text(event, "schema") != INITIATIVE_ASSIGNMENT_NATIVE_EVENT_V1)
            throw std::runtime_error("Initiative/Assignment journal event has an invalid field set");
          auto identity = event;
          const auto event_root = required_text(identity, "eventRoot");
          identity.erase("eventRoot");
          if (protocol_root(INITIATIVE_ASSIGNMENT_NATIVE_EVENT_V1, identity) != event_root)
            throw std::runtime_error("Initiative/Assignment journal event Root mismatch");
          validate_admission(event.at("admission"));
          if (protocol_root(INITIATIVE_ASSIGNMENT_NATIVE_ADMISSION_V1, event.at("admission")) !=
                  required_text(event, "bindingRoot") ||
              event.at("admission").at("expectedRoot") != event.at("computedRoot"))
            throw std::runtime_error("Initiative/Assignment journal binding mismatch");
          events.push_back({std::move(event), frame->frame_uid(), frame->source(), frame->dest(), frame->gen_time()});
        }
      }
      reader.next();
    }
  } catch (const yy::journal::assemble_exception &) {
    return {};
  }
  return events;
}

nlohmann::json admit(const std::string &runtime_dir, const nlohmann::json &request) {
  validate_admission(request);
  const auto event = make_event(request);
  const auto recorded = append_event(runtime_dir, event);
  return {{"schema", "kungfu.initiative-assignment.native-admission-record/v1"},
          {"status", "recorded-awaiting-restart-replay"},
          {"assignmentId", request.at("assignmentId")},
          {"computedRoot", request.at("expectedRoot")},
          {"bindingRoot", event.at("bindingRoot")},
          {"eventRoot", event.at("eventRoot")},
          {"journal", {{"namespace", JOURNAL_NAMESPACE}, {"name", JOURNAL_NAME}, {"frameUid", recorded.frame_uid}}},
          {"receiptIssued", false}};
}

nlohmann::json replay(const std::string &runtime_dir, const nlohmann::json &request) {
  if (!exact_fields(request, {"assignmentId", "expectedBindingRoot", "expectedEventRoot", "schema"}) ||
      required_text(request, "schema") != INITIATIVE_ASSIGNMENT_REPLAY_REQUEST_V1)
    throw std::invalid_argument("native replay request field set or schema is invalid");
  const auto assignment_id = required_text(request, "assignmentId");
  const auto binding_root = required_text(request, "expectedBindingRoot");
  const auto event_root = required_text(request, "expectedEventRoot");
  if (!canonical_root(binding_root) || !canonical_root(event_root))
    throw std::invalid_argument("native replay expectations must use canonical sha256 Roots");
  const auto events = read_events(runtime_dir);
  const replayed_event *matched = nullptr;
  size_t match_count = 0;
  for (const auto &candidate : events) {
    if (candidate.event.at("assignmentId") == assignment_id && candidate.event.at("bindingRoot") == binding_root) {
      matched = &candidate;
      ++match_count;
    }
  }
  if (matched == nullptr)
    throw std::invalid_argument("no journal event matches the exact Assignment and binding Root");
  if (matched->event.at("eventRoot") != event_root)
    throw std::invalid_argument("replayed event Root does not match the exact expected event");

  const auto &admission = matched->event.at("admission");
  auto replay_evidence = nlohmann::json{{"assignmentId", assignment_id},
                                        {"bindingRoot", binding_root},
                                        {"computedRoot", matched->event.at("computedRoot")},
                                        {"eventRoot", event_root},
                                        {"journal",
                                         {{"dest", matched->dest},
                                          {"frameUid", matched->frame_uid},
                                          {"genTime", matched->gen_time},
                                          {"name", JOURNAL_NAME},
                                          {"namespace", JOURNAL_NAMESPACE},
                                          {"source", matched->source}}},
                                        {"matchedEventCount", match_count},
                                        {"schema", INITIATIVE_ASSIGNMENT_REPLAY_EVIDENCE_V1}};
  const auto replay_root = protocol_root(INITIATIVE_ASSIGNMENT_REPLAY_EVIDENCE_V1, replay_evidence);
  replay_evidence["replayEvidenceRoot"] = replay_root;

  const auto &evidence = admission.at("evidence");
  auto receipt = nlohmann::json{
      {"assignmentId", assignment_id},
      {"historicalNoRewriteRoot", evidence.at("historicalNoRewriteRoot")},
      {"implementations",
       {{"languages", nlohmann::json::array({"c++", "python"})},
        {"nativeRoot", evidence.at("nativeImplementationRoot")},
        {"pythonRoot", evidence.at("pythonImplementationRoot")}}},
      {"journal", {{"bindingRoot", binding_root}, {"eventRoot", event_root}, {"replayEvidenceRoot", replay_root}}},
      {"platformEvidenceRoot", evidence.at("platformEvidenceRoot")},
      {"rootProtocol",
       {{"contractRoot", evidence.at("rootProtocolContractRoot")},
        {"root", admission.at("expectedRoot")},
        {"vectorRoot", evidence.at("vectorRoot")}}},
      {"schema", INITIATIVE_ASSIGNMENT_ADMISSION_RECEIPT_V1},
      {"serviceContractRoot", admission.at("serviceContractRoot")},
      {"source", admission.at("source")}};
  receipt["receiptRoot"] = protocol_root(INITIATIVE_ASSIGNMENT_ADMISSION_RECEIPT_V1, receipt);
  return {{"schema", "kungfu.initiative-assignment.native-replay-result/v1"},
          {"status", "replayed-and-receipt-issued"},
          {"replayEvidence", std::move(replay_evidence)},
          {"receipt", std::move(receipt)}};
}

} // namespace

nlohmann::json initiative_assignment_native_contract() {
  auto contract = nlohmann::json{
      {"schema", INITIATIVE_ASSIGNMENT_NATIVE_CONTRACT_V1},
      {"abi", {{"interfaceId", 6}, {"version", 1}}},
      {"operations", nlohmann::json::array({"contract", "compute-root", "admit", "replay"})},
      {"journal", {{"namespace", JOURNAL_NAMESPACE}, {"name", JOURNAL_NAME}, {"owner", "libkungfu/action-recorder"}}},
      {"admission", {{"recordIsReceipt", false}, {"receiptRequiresRestartReplay", true}}},
      {"receipt",
       {{"schema", INITIATIVE_ASSIGNMENT_ADMISSION_RECEIPT_V1},
        {"requiredBindings",
         nlohmann::json::array({"assignment", "source-head", "source-tree", "root-protocol-contract",
                                "service-contract", "vectors", "python-implementation", "native-implementation",
                                "platform-evidence", "journal-replay", "historical-no-rewrite"})}}},
      {"authorityBoundary",
       "Python remains the L3 rules/projection writer; this service owns only L5 native Root admission."}};
  contract["contractRoot"] = protocol_root(INITIATIVE_ASSIGNMENT_NATIVE_CONTRACT_V1, contract);
  return contract;
}

nlohmann::json run_initiative_assignment_native_service(const std::string &runtime_dir, uint32_t operation,
                                                        const nlohmann::json &request) {
  switch (operation) {
  case 1:
    if (!request.empty())
      throw std::invalid_argument("native contract operation requires an empty request object");
    return initiative_assignment_native_contract();
  case 2:
    if (!exact_fields(request, {"rootInput"}))
      throw std::invalid_argument("native compute-root requires exactly rootInput");
    return compute_initiative_assignment_root(request.at("rootInput"));
  case 3:
    return admit(runtime_dir, request);
  case 4:
    return replay(runtime_dir, request);
  default:
    throw std::invalid_argument("unsupported Initiative/Assignment native operation");
  }
}

} // namespace kungfu::runtime::profile
