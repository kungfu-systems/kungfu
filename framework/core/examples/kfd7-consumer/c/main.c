// SPDX-License-Identifier: Apache-2.0

#include <kungfu/api.h>

#include <stdio.h>
#include <string.h>

static int fail(const char *operation, int32_t status) {
  fprintf(stderr, "%s failed: %d\n", operation, (int)status);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: kungfu_kfd7_c_consumer <runtime-dir> <stream-root>\n");
    return 2;
  }

  kf_api_v1 api = {0};
  int32_t status = kungfu_get_api(KF_ABI_V1, sizeof(api), &api);
  if (status != KF_OK)
    return fail("kungfu_get_api", status);

  kf_context_config_v1 config = {0};
  config.struct_size = sizeof(config);
  config.runtime_dir = argv[1];
  config.stream_root = argv[2];
  config.host_namespace = "kfd7-external-c";
  config.host_name = "consumer";

  kf_context *context = NULL;
  status = api.context_open(&config, &context);
  if (status != KF_OK)
    return fail("context_open", status);

  kf_discovery_api_v1 discovery = {0};
  status = api.interface_get(context, KF_INTERFACE_DISCOVERY, KF_DISCOVERY_ABI_V1, sizeof(discovery), &discovery);
  if (status != KF_OK)
    return fail("interface_get(discovery)", status);

  kf_runtime_info_v1 info = {0};
  info.struct_size = sizeof(info);
  status = discovery.runtime_info(context, &info);
  if (status != KF_OK)
    return fail("runtime_info", status);
  if (info.interface_count != 4 || strcmp(info.abi_contract, "kungfu.kfd7-library-boundary.contract/v1") != 0) {
    fprintf(stderr, "unexpected runtime discovery report\n");
    return 1;
  }

  kf_ledger_action_api_v1 ledger = {0};
  status = api.interface_get(context, KF_INTERFACE_LEDGER_ACTION, KF_LEDGER_ACTION_ABI_V1, sizeof(ledger), &ledger);
  if (status != KF_OK)
    return fail("interface_get(ledger-action)", status);

  kf_action_binding_config_v1 binding_config = {0};
  binding_config.struct_size = sizeof(binding_config);
  binding_config.fact_cut_root = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  binding_config.pursuit_root = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  binding_config.atlas_root = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
  binding_config.warrant_root = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
  binding_config.candidate_action_root = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
  binding_config.preconditions_root = "sha256:6666666666666666666666666666666666666666666666666666666666666666";
  binding_config.resources_root = "sha256:7777777777777777777777777777777777777777777777777777777777777777";

  kf_action_binding *binding = NULL;
  status = ledger.binding_open(context, &binding_config, &binding);
  if (status != KF_OK)
    return fail("binding_open", status);

  kf_action_binding_info_v1 binding_info = {0};
  binding_info.struct_size = sizeof(binding_info);
  status = ledger.binding_info(binding, &binding_info);
  if (status != KF_OK)
    return fail("binding_info", status);
  if (strcmp(binding_info.binding_root, "sha256:c156cb56fc16603689f6b875985ed7b7d92bec5d5d5b76adc2f75c67fabb3739") !=
      0) {
    fprintf(stderr, "unexpected ActionBinding root: %s\n", binding_info.binding_root);
    return 1;
  }
  char binding_root[72] = {0};
  snprintf(binding_root, sizeof(binding_root), "%s", binding_info.binding_root);

  status = ledger.binding_close(binding);
  if (status != KF_OK)
    return fail("binding_close", status);
  status = api.context_close(context);
  if (status != KF_OK)
    return fail("context_close", status);

  printf("{\"consumer\":\"c\",\"abi\":%u,\"interfaces\":%u,\"runtime\":\"%s\",\"version\":\"%s\","
         "\"binding_root\":\"%s\"}\n",
         api.abi_version, info.interface_count, info.runtime_name, info.runtime_version, binding_root);
  return 0;
}
