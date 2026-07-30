// SPDX-License-Identifier: Apache-2.0

#include <kungfu/api.h>

#include <stdio.h>
#include <string.h>

#define ROOT_1 "sha256:1111111111111111111111111111111111111111111111111111111111111111"
#define ROOT_2 "sha256:2222222222222222222222222222222222222222222222222222222222222222"
#define ROOT_3 "sha256:3333333333333333333333333333333333333333333333333333333333333333"
#define ROOT_4 "sha256:4444444444444444444444444444444444444444444444444444444444444444"
#define ROOT_5 "sha256:5555555555555555555555555555555555555555555555555555555555555555"
#define ROOT_6 "sha256:6666666666666666666666666666666666666666666666666666666666666666"
#define ROOT_7 "sha256:7777777777777777777777777777777777777777777777777777777777777777"

static int execute(kf_ledger_action_api_v1 *ledger, kf_context *context, kf_action_binding *binding, uint32_t operation,
                   const char *request) {
  kf_semantic_message_v1 message = {.struct_size = sizeof(message),
                                    .protocol_id = KF_PROTOCOL_STORAGE_SERVICE,
                                    .protocol_version = 1,
                                    .schema_ref = KF_SCHEMA_LEDGER_ACTION_REQUEST_V1,
                                    .encoding = KF_ENCODING_JSON,
                                    .bytes = (const uint8_t *)request,
                                    .byte_size = strlen(request)};
  kf_owned_message_v1 result = {.struct_size = sizeof(result)};
  if (ledger->execute(context, binding, operation, &message, &result) != KF_OK) {
    return 1;
  }
  fwrite(result.message.bytes, 1, (size_t)result.message.byte_size, stdout);
  fputc('\n', stdout);
  return ledger->result_release(context, result.token) == KF_OK ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s RUNTIME_DIR\n", argv[0]);
    return 2;
  }
  kf_api_v1 api = {.struct_size = sizeof(api)};
  if (kungfu_get_api(KF_ABI_V1, sizeof(api), &api) != KF_OK) {
    return 1;
  }
  kf_context_config_v1 config = {.struct_size = sizeof(config),
                                 .runtime_dir = argv[1],
                                 .stream_root = argv[1],
                                 .host_namespace = "opencode-kungfu",
                                 .host_name = "episode-quickstart"};
  kf_context *context = NULL;
  if (api.context_open(&config, &context) != KF_OK) {
    return 1;
  }
  kf_ledger_action_api_v1 ledger = {.struct_size = sizeof(ledger)};
  if (api.interface_get(context, KF_INTERFACE_LEDGER_ACTION, KF_LEDGER_ACTION_ABI_V1, sizeof(ledger), &ledger) !=
      KF_OK) {
    api.context_close(context);
    return 1;
  }
  kf_action_binding_config_v1 binding_config = {.struct_size = sizeof(binding_config),
                                                .fact_cut_root = ROOT_1,
                                                .pursuit_root = ROOT_2,
                                                .atlas_root = ROOT_3,
                                                .warrant_root = ROOT_4,
                                                .candidate_action_root = ROOT_5,
                                                .preconditions_root = ROOT_6,
                                                .resources_root = ROOT_7};
  kf_action_binding *binding = NULL;
  if (ledger.binding_open(context, &binding_config, &binding) != KF_OK) {
    api.context_close(context);
    return 1;
  }
  const int begun = execute(&ledger, context, binding, KF_LEDGER_ACTION_EPISODE_BEGIN,
                            "{\"episode_id\":901,\"title\":\"vendor quickstart\",\"actor\":\"c-host\"}");
  const int ended = begun == 0 ? execute(&ledger, context, binding, KF_LEDGER_ACTION_EPISODE_END,
                                         "{\"episode_id\":901,\"reason\":\"quickstart complete\"}")
                               : 1;
  const int binding_closed = ledger.binding_close(binding) == KF_OK ? 0 : 1;
  const int context_closed = api.context_close(context) == KF_OK ? 0 : 1;
  return begun || ended || binding_closed || context_closed;
}
