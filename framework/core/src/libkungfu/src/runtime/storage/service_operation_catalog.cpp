// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/runtime/storage/service.h>

#include <array>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace kungfu::runtime::storage_service_api {

namespace {

struct storage_operation_entry {
  storage_operation operation;
  std::string_view name;
};

constexpr std::array operation_catalog{
    storage_operation_entry{storage_operation::Status, "status"},
    storage_operation_entry{storage_operation::Fsck, "fsck"},
    storage_operation_entry{storage_operation::RepairPlan, "repair_plan"},
    storage_operation_entry{storage_operation::RepairFetch, "repair_fetch"},
    storage_operation_entry{storage_operation::RepairApply, "repair_apply"},
    storage_operation_entry{storage_operation::ExportBundle, "export_bundle"},
    storage_operation_entry{storage_operation::ImportBundle, "import_bundle"},
    storage_operation_entry{storage_operation::EpisodeAdmission, "episode_admission"},
    storage_operation_entry{storage_operation::RebuildIndex, "rebuild_index"},
    storage_operation_entry{storage_operation::GcPlan, "gc_plan"},
    storage_operation_entry{storage_operation::CompactPlan, "compact_plan"},
    storage_operation_entry{storage_operation::VerifySync, "verify_sync"},
    storage_operation_entry{storage_operation::BackendStatus, "backend_status"},
    storage_operation_entry{storage_operation::BackendSwitch, "backend_switch"},
    storage_operation_entry{storage_operation::BackendRollback, "backend_rollback"},
    storage_operation_entry{storage_operation::Query, "query"},
    storage_operation_entry{storage_operation::QueryPlan, "query_plan"},
    storage_operation_entry{storage_operation::FactQuery, "fact_query"},
    storage_operation_entry{storage_operation::FactChangelog, "fact_changelog"},
    storage_operation_entry{storage_operation::SavedQueryCatalog, "saved_query_catalog"},
    storage_operation_entry{storage_operation::ProfileLifecycle, "profile_lifecycle"},
    storage_operation_entry{storage_operation::ActionRuntime, "action_runtime"},
    storage_operation_entry{storage_operation::KfxRuntime, "kfx_runtime"},
    storage_operation_entry{storage_operation::FactKernel, "fact_kernel"},
    storage_operation_entry{storage_operation::FactContract, "fact_contract"},
    storage_operation_entry{storage_operation::FactDeclareWorld, "fact_declare_world"},
    storage_operation_entry{storage_operation::FactDeclareSurface, "fact_declare_surface"},
    storage_operation_entry{storage_operation::FactObserve, "fact_observe"},
    storage_operation_entry{storage_operation::FactState, "fact_state"},
    storage_operation_entry{storage_operation::FactLibraryContract, "fact_library_contract"},
    storage_operation_entry{storage_operation::FactTypeCreate, "fact_type_create"},
    storage_operation_entry{storage_operation::FactTypeList, "fact_type_list"},
    storage_operation_entry{storage_operation::FactMaterialPut, "fact_material_put"},
    storage_operation_entry{storage_operation::FactMaterialList, "fact_material_list"},
    storage_operation_entry{storage_operation::FactLibraryExport, "fact_library_export"},
    storage_operation_entry{storage_operation::FactLibraryImport, "fact_library_import"},
    storage_operation_entry{storage_operation::AssessmentContract, "assessment_contract"},
    storage_operation_entry{storage_operation::AssessmentRequest, "assessment_request"},
    storage_operation_entry{storage_operation::AssessmentExecute, "assessment_execute"},
    storage_operation_entry{storage_operation::AssessmentStatus, "assessment_status"},
    storage_operation_entry{storage_operation::AssessmentList, "assessment_list"},
    storage_operation_entry{storage_operation::AssessmentInvalidate, "assessment_invalidate"},
    storage_operation_entry{storage_operation::TrustRequire, "trust_require"},
    storage_operation_entry{storage_operation::Layout, "layout"},
    storage_operation_entry{storage_operation::EpisodeBegin, "episode_begin"},
    storage_operation_entry{storage_operation::EpisodeHeartbeat, "episode_heartbeat"},
    storage_operation_entry{storage_operation::EpisodeEnd, "episode_end"},
    storage_operation_entry{storage_operation::EpisodeAbort, "episode_abort"},
    storage_operation_entry{storage_operation::EpisodeAttachFrame, "episode_attach_frame"},
    storage_operation_entry{storage_operation::EpisodeAttachRef, "episode_attach_ref"},
    storage_operation_entry{storage_operation::EpisodeList, "episode_list"},
    storage_operation_entry{storage_operation::EpisodeInspect, "episode_inspect"},
    storage_operation_entry{storage_operation::EpisodeRecover, "episode_recover"},
    storage_operation_entry{storage_operation::EpisodeRecoveryPlan, "episode_recovery_plan"},
    storage_operation_entry{storage_operation::EpisodeRecoveryExecute, "episode_recovery_execute"},
    storage_operation_entry{storage_operation::EpisodeProjectionRebuild, "episode_projection_rebuild"},
    storage_operation_entry{storage_operation::SourceRegister, "source_register"},
    storage_operation_entry{storage_operation::SourceUpdateHead, "source_update_head"},
    storage_operation_entry{storage_operation::SourceRecordAcceptedRange, "source_record_accepted_range"},
    storage_operation_entry{storage_operation::SourceList, "source_list"},
    storage_operation_entry{storage_operation::SourceInspect, "source_inspect"},
    storage_operation_entry{storage_operation::SourceRegistryFsck, "source_registry_fsck"},
    storage_operation_entry{storage_operation::SourceRegistryRebuild, "source_registry_rebuild"},
};

static_assert(operation_catalog.size() == static_cast<size_t>(storage_operation::SourceRegistryRebuild) + 1,
              "storage operation catalog must cover every public enum value");

} // namespace

std::vector<std::string> storage_operation_names() {
  std::vector<std::string> names;
  names.reserve(operation_catalog.size());
  for (const auto &entry : operation_catalog)
    names.emplace_back(entry.name);
  return names;
}

std::string storage_operation_name(storage_operation operation) {
  const auto index = static_cast<size_t>(operation);
  if (index >= operation_catalog.size() || operation_catalog[index].operation != operation)
    throw std::invalid_argument("unknown storage operation");
  return std::string(operation_catalog[index].name);
}

storage_operation parse_storage_operation(const std::string &operation) {
  for (const auto &entry : operation_catalog)
    if (entry.name == operation)
      return entry.operation;
  throw std::invalid_argument("unsupported storage operation: " + operation);
}

} // namespace kungfu::runtime::storage_service_api
