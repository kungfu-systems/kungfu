// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/service.h>

#include "service_internal.h"

#include <stdexcept>
#include <string>
#include <vector>

namespace kungfu::runtime::storage_service_api {

using namespace detail;

std::vector<std::string> storage_operation_names() {
  return {
      storage_operation_name(storage_operation::Status),
      storage_operation_name(storage_operation::Fsck),
      storage_operation_name(storage_operation::RepairPlan),
      storage_operation_name(storage_operation::RepairFetch),
      storage_operation_name(storage_operation::RepairApply),
      storage_operation_name(storage_operation::ExportBundle),
      storage_operation_name(storage_operation::ImportBundle),
      storage_operation_name(storage_operation::EpisodeAdmission),
      storage_operation_name(storage_operation::RebuildIndex),
      storage_operation_name(storage_operation::GcPlan),
      storage_operation_name(storage_operation::CompactPlan),
      storage_operation_name(storage_operation::VerifySync),
      storage_operation_name(storage_operation::BackendStatus),
      storage_operation_name(storage_operation::BackendSwitch),
      storage_operation_name(storage_operation::BackendRollback),
      storage_operation_name(storage_operation::Query),
      storage_operation_name(storage_operation::QueryPlan),
      storage_operation_name(storage_operation::FactQuery),
      storage_operation_name(storage_operation::FactChangelog),
      storage_operation_name(storage_operation::SavedQueryCatalog),
      storage_operation_name(storage_operation::ProfileLifecycle),
      storage_operation_name(storage_operation::ActionRuntime),
      storage_operation_name(storage_operation::KfxRuntime),
      storage_operation_name(storage_operation::FactKernel),
      storage_operation_name(storage_operation::FactContract),
      storage_operation_name(storage_operation::FactDeclareWorld),
      storage_operation_name(storage_operation::FactDeclareSurface),
      storage_operation_name(storage_operation::FactObserve),
      storage_operation_name(storage_operation::FactState),
      storage_operation_name(storage_operation::FactLibraryContract),
      storage_operation_name(storage_operation::FactTypeCreate),
      storage_operation_name(storage_operation::FactTypeList),
      storage_operation_name(storage_operation::FactMaterialPut),
      storage_operation_name(storage_operation::FactMaterialList),
      storage_operation_name(storage_operation::FactLibraryExport),
      storage_operation_name(storage_operation::FactLibraryImport),
      storage_operation_name(storage_operation::AssessmentContract),
      storage_operation_name(storage_operation::AssessmentRequest),
      storage_operation_name(storage_operation::AssessmentExecute),
      storage_operation_name(storage_operation::AssessmentStatus),
      storage_operation_name(storage_operation::AssessmentList),
      storage_operation_name(storage_operation::AssessmentInvalidate),
      storage_operation_name(storage_operation::TrustRequire),
      storage_operation_name(storage_operation::Layout),
      storage_operation_name(storage_operation::EpisodeBegin),
      storage_operation_name(storage_operation::EpisodeHeartbeat),
      storage_operation_name(storage_operation::EpisodeEnd),
      storage_operation_name(storage_operation::EpisodeAbort),
      storage_operation_name(storage_operation::EpisodeAttachFrame),
      storage_operation_name(storage_operation::EpisodeAttachRef),
      storage_operation_name(storage_operation::EpisodeList),
      storage_operation_name(storage_operation::EpisodeInspect),
      storage_operation_name(storage_operation::EpisodeRecover),
      storage_operation_name(storage_operation::EpisodeRecoveryPlan),
      storage_operation_name(storage_operation::EpisodeRecoveryExecute),
      storage_operation_name(storage_operation::EpisodeProjectionRebuild),
      storage_operation_name(storage_operation::SourceRegister),
      storage_operation_name(storage_operation::SourceUpdateHead),
      storage_operation_name(storage_operation::SourceRecordAcceptedRange),
      storage_operation_name(storage_operation::SourceList),
      storage_operation_name(storage_operation::SourceInspect),
      storage_operation_name(storage_operation::SourceRegistryFsck),
      storage_operation_name(storage_operation::SourceRegistryRebuild),
  };
}

std::string storage_operation_name(storage_operation operation) {
  switch (operation) {
  case storage_operation::Status:
    return "status";
  case storage_operation::Fsck:
    return "fsck";
  case storage_operation::RepairPlan:
    return "repair_plan";
  case storage_operation::RepairFetch:
    return "repair_fetch";
  case storage_operation::RepairApply:
    return "repair_apply";
  case storage_operation::ExportBundle:
    return "export_bundle";
  case storage_operation::ImportBundle:
    return "import_bundle";
  case storage_operation::EpisodeAdmission:
    return "episode_admission";
  case storage_operation::RebuildIndex:
    return "rebuild_index";
  case storage_operation::GcPlan:
    return "gc_plan";
  case storage_operation::CompactPlan:
    return "compact_plan";
  case storage_operation::VerifySync:
    return "verify_sync";
  case storage_operation::BackendStatus:
  case storage_operation::BackendSwitch:
  case storage_operation::BackendRollback:
    return backend_operation_name(operation);
  case storage_operation::Query:
    return "query";
  case storage_operation::QueryPlan:
    return "query_plan";
  case storage_operation::FactQuery:
    return "fact_query";
  case storage_operation::FactChangelog:
    return "fact_changelog";
  case storage_operation::SavedQueryCatalog:
    return "saved_query_catalog";
  case storage_operation::ProfileLifecycle:
    return "profile_lifecycle";
  case storage_operation::ActionRuntime:
    return "action_runtime";
  case storage_operation::KfxRuntime:
    return "kfx_runtime";
  case storage_operation::FactKernel:
    return "fact_kernel";
  case storage_operation::FactContract:
    return "fact_contract";
  case storage_operation::FactDeclareWorld:
    return "fact_declare_world";
  case storage_operation::FactDeclareSurface:
    return "fact_declare_surface";
  case storage_operation::FactObserve:
    return "fact_observe";
  case storage_operation::FactState:
    return "fact_state";
  case storage_operation::FactLibraryContract:
    return "fact_library_contract";
  case storage_operation::FactTypeCreate:
    return "fact_type_create";
  case storage_operation::FactTypeList:
    return "fact_type_list";
  case storage_operation::FactMaterialPut:
    return "fact_material_put";
  case storage_operation::FactMaterialList:
    return "fact_material_list";
  case storage_operation::FactLibraryExport:
    return "fact_library_export";
  case storage_operation::FactLibraryImport:
    return "fact_library_import";
  case storage_operation::AssessmentContract:
    return "assessment_contract";
  case storage_operation::AssessmentRequest:
    return "assessment_request";
  case storage_operation::AssessmentExecute:
    return "assessment_execute";
  case storage_operation::AssessmentStatus:
    return "assessment_status";
  case storage_operation::AssessmentList:
    return "assessment_list";
  case storage_operation::AssessmentInvalidate:
    return "assessment_invalidate";
  case storage_operation::TrustRequire:
    return "trust_require";
  case storage_operation::Layout:
    return "layout";
  case storage_operation::EpisodeBegin:
    return "episode_begin";
  case storage_operation::EpisodeHeartbeat:
    return "episode_heartbeat";
  case storage_operation::EpisodeEnd:
    return "episode_end";
  case storage_operation::EpisodeAbort:
    return "episode_abort";
  case storage_operation::EpisodeAttachFrame:
    return "episode_attach_frame";
  case storage_operation::EpisodeAttachRef:
    return "episode_attach_ref";
  case storage_operation::EpisodeList:
    return "episode_list";
  case storage_operation::EpisodeInspect:
    return "episode_inspect";
  case storage_operation::EpisodeRecover:
    return "episode_recover";
  case storage_operation::EpisodeRecoveryPlan:
    return "episode_recovery_plan";
  case storage_operation::EpisodeRecoveryExecute:
    return "episode_recovery_execute";
  case storage_operation::EpisodeProjectionRebuild:
    return "episode_projection_rebuild";
  case storage_operation::SourceRegister:
    return "source_register";
  case storage_operation::SourceUpdateHead:
    return "source_update_head";
  case storage_operation::SourceRecordAcceptedRange:
    return "source_record_accepted_range";
  case storage_operation::SourceList:
    return "source_list";
  case storage_operation::SourceInspect:
    return "source_inspect";
  case storage_operation::SourceRegistryFsck:
    return "source_registry_fsck";
  case storage_operation::SourceRegistryRebuild:
    return "source_registry_rebuild";
  }
  throw std::invalid_argument("unknown storage operation");
}

storage_operation parse_storage_operation(const std::string &operation) {
  if (operation == "status") {
    return storage_operation::Status;
  }
  if (operation == "fsck") {
    return storage_operation::Fsck;
  }
  if (operation == "repair_plan") {
    return storage_operation::RepairPlan;
  }
  if (operation == "repair_fetch") {
    return storage_operation::RepairFetch;
  }
  if (operation == "repair_apply") {
    return storage_operation::RepairApply;
  }
  if (operation == "export_bundle") {
    return storage_operation::ExportBundle;
  }
  if (operation == "import_bundle") {
    return storage_operation::ImportBundle;
  }
  if (operation == "episode_admission") {
    return storage_operation::EpisodeAdmission;
  }
  if (operation == "rebuild_index") {
    return storage_operation::RebuildIndex;
  }
  if (operation == "gc_plan") {
    return storage_operation::GcPlan;
  }
  if (operation == "compact_plan") {
    return storage_operation::CompactPlan;
  }
  if (operation == "verify_sync") {
    return storage_operation::VerifySync;
  }
  if (const auto backend_operation = parse_backend_operation(operation); backend_operation.has_value())
    return *backend_operation;
  if (operation == "query") {
    return storage_operation::Query;
  }
  if (operation == "query_plan") {
    return storage_operation::QueryPlan;
  }
  if (operation == "fact_query") {
    return storage_operation::FactQuery;
  }
  if (operation == "fact_changelog") {
    return storage_operation::FactChangelog;
  }
  if (operation == "saved_query_catalog") {
    return storage_operation::SavedQueryCatalog;
  }
  if (operation == "profile_lifecycle") {
    return storage_operation::ProfileLifecycle;
  }
  if (operation == "action_runtime") {
    return storage_operation::ActionRuntime;
  }
  if (operation == "kfx_runtime") {
    return storage_operation::KfxRuntime;
  }
  if (operation == "fact_kernel") {
    return storage_operation::FactKernel;
  }
  if (operation == "fact_contract") {
    return storage_operation::FactContract;
  }
  if (operation == "fact_declare_world") {
    return storage_operation::FactDeclareWorld;
  }
  if (operation == "fact_declare_surface") {
    return storage_operation::FactDeclareSurface;
  }
  if (operation == "fact_observe") {
    return storage_operation::FactObserve;
  }
  if (operation == "fact_state") {
    return storage_operation::FactState;
  }
  if (operation == "fact_library_contract") {
    return storage_operation::FactLibraryContract;
  }
  if (operation == "fact_type_create") {
    return storage_operation::FactTypeCreate;
  }
  if (operation == "fact_type_list") {
    return storage_operation::FactTypeList;
  }
  if (operation == "fact_material_put") {
    return storage_operation::FactMaterialPut;
  }
  if (operation == "fact_material_list") {
    return storage_operation::FactMaterialList;
  }
  if (operation == "fact_library_export") {
    return storage_operation::FactLibraryExport;
  }
  if (operation == "fact_library_import") {
    return storage_operation::FactLibraryImport;
  }
  if (operation == "assessment_contract") {
    return storage_operation::AssessmentContract;
  }
  if (operation == "assessment_request") {
    return storage_operation::AssessmentRequest;
  }
  if (operation == "assessment_execute") {
    return storage_operation::AssessmentExecute;
  }
  if (operation == "assessment_status") {
    return storage_operation::AssessmentStatus;
  }
  if (operation == "assessment_list") {
    return storage_operation::AssessmentList;
  }
  if (operation == "assessment_invalidate") {
    return storage_operation::AssessmentInvalidate;
  }
  if (operation == "trust_require") {
    return storage_operation::TrustRequire;
  }
  if (operation == "layout") {
    return storage_operation::Layout;
  }
  if (operation == "episode_begin") {
    return storage_operation::EpisodeBegin;
  }
  if (operation == "episode_heartbeat") {
    return storage_operation::EpisodeHeartbeat;
  }
  if (operation == "episode_end") {
    return storage_operation::EpisodeEnd;
  }
  if (operation == "episode_abort") {
    return storage_operation::EpisodeAbort;
  }
  if (operation == "episode_attach_frame") {
    return storage_operation::EpisodeAttachFrame;
  }
  if (operation == "episode_attach_ref") {
    return storage_operation::EpisodeAttachRef;
  }
  if (operation == "episode_list") {
    return storage_operation::EpisodeList;
  }
  if (operation == "episode_inspect") {
    return storage_operation::EpisodeInspect;
  }
  if (operation == "episode_recover") {
    return storage_operation::EpisodeRecover;
  }
  if (operation == "episode_recovery_plan") {
    return storage_operation::EpisodeRecoveryPlan;
  }
  if (operation == "episode_recovery_execute") {
    return storage_operation::EpisodeRecoveryExecute;
  }
  if (operation == "episode_projection_rebuild") {
    return storage_operation::EpisodeProjectionRebuild;
  }
  if (operation == "source_register") {
    return storage_operation::SourceRegister;
  }
  if (operation == "source_update_head") {
    return storage_operation::SourceUpdateHead;
  }
  if (operation == "source_record_accepted_range") {
    return storage_operation::SourceRecordAcceptedRange;
  }
  if (operation == "source_list") {
    return storage_operation::SourceList;
  }
  if (operation == "source_inspect") {
    return storage_operation::SourceInspect;
  }
  if (operation == "source_registry_fsck") {
    return storage_operation::SourceRegistryFsck;
  }
  if (operation == "source_registry_rebuild") {
    return storage_operation::SourceRegistryRebuild;
  }
  throw std::invalid_argument("unsupported storage operation: " + operation);
}

} // namespace kungfu::runtime::storage_service_api
