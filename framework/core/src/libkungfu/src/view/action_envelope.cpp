// SPDX-License-Identifier: Apache-2.0

#include <kungfu/view/action_envelope.h>

#include "ActionEnvelope_generated.h"

#include <kungfu/yijinjing/storage/content_hash.h>

#include <flatbuffers/flatbuffers.h>
#include <flatbuffers/verifier.h>

#include <memory>
#include <stdexcept>

namespace kungfu::view::action {

namespace fb = kungfu::action::fb;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

fb::PayloadEncoding to_fb(payload_encoding value) { return static_cast<fb::PayloadEncoding>(value); }

payload_encoding from_fb(fb::PayloadEncoding value) { return static_cast<payload_encoding>(value); }

void set_error(std::string *error, std::string message) {
  if (error != nullptr)
    *error = std::move(message);
}

void validate_payload(payload_view &payload) {
  if (!payload.data.empty()) {
    if (payload.byte_len != 0 && payload.byte_len != payload.data.size())
      throw std::invalid_argument("action envelope payload byte_len mismatch");
    payload.byte_len = payload.data.size();
    if (payload.hash_algorithm.empty())
      payload.hash_algorithm = yy_storage::CONTENT_HASH_ALGORITHM_SHA256;
    const auto digest =
        yy_storage::compute_content_hash_value(payload.data.data(), payload.data.size(), payload.hash_algorithm);
    if (!payload.hash.empty() && payload.hash != digest)
      throw std::invalid_argument("action envelope payload hash mismatch");
    payload.hash = digest;
  }
}

} // namespace

std::vector<uint8_t> encode(const envelope &value) {
  if (value.version != ACTION_ENVELOPE_VERSION)
    throw std::invalid_argument("unsupported action envelope version: " + std::to_string(value.version));
  if (value.action_type.empty())
    throw std::invalid_argument("action envelope requires action_type");
  if (value.schema_ref.id.empty())
    throw std::invalid_argument("action envelope requires schema_ref.id");

  fb::ActionEnvelopeT native{};
  native.version = value.version;
  native.action_type = value.action_type;
  native.schema_ref = std::make_unique<fb::SchemaRefT>();
  native.schema_ref->id = value.schema_ref.id;
  native.schema_ref->version = value.schema_ref.version;
  if (value.actor.has_value()) {
    native.actor = std::make_unique<fb::ActorT>();
    native.actor->id = value.actor->id;
    native.actor->kind = value.actor->kind;
    native.actor->storage_source_id = value.actor->storage_source_id;
    native.actor->source_type = value.actor->source_type;
  }
  if (value.session.has_value()) {
    native.session = std::make_unique<fb::SessionT>();
    native.session->run_id = value.session->run_id;
    native.session->import_id = value.session->import_id;
  }
  if (value.source.has_value()) {
    native.source = std::make_unique<fb::SourceT>();
    native.source->kind = value.source->kind;
    native.source->source_id = value.source->source_id;
    native.source->source_path = value.source->source_path;
    native.source->source_time = value.source->source_time;
    native.source->schema_version = value.source->schema_version;
  }
  if (value.batch.has_value()) {
    native.batch = std::make_unique<fb::BatchT>();
    native.batch->repo_root = value.batch->repo_root;
    native.batch->repo_head = value.batch->repo_head;
    native.batch->schema_version = value.batch->schema_version;
    native.batch->missions = value.batch->missions;
    native.batch->goals = value.batch->goals;
    native.batch->markers = value.batch->markers;
    native.batch->warnings = value.batch->warnings;
  }
  if (value.journal.has_value()) {
    native.journal = std::make_unique<fb::JournalT>();
    native.journal->frame_uid = value.journal->frame_uid;
    native.journal->trigger_frame_uid = value.journal->trigger_frame_uid;
    native.journal->stream_id = value.journal->stream_id;
    native.journal->gen_time = value.journal->gen_time;
    native.journal->trigger_time = value.journal->trigger_time;
    native.journal->carrier_type = value.journal->carrier_type;
    native.journal->source = value.journal->source;
    native.journal->initial_source = value.journal->initial_source;
    native.journal->dest = value.journal->dest;
    native.journal->data_length = value.journal->data_length;
    native.journal->data_type = value.journal->data_type;
    native.journal->integrity_version = value.journal->integrity_version;
    native.journal->checksum_algorithm = value.journal->checksum_algorithm;
    native.journal->payload_checksum = value.journal->payload_checksum;
    native.journal->frame_checksum = value.journal->frame_checksum;
  }
  if (value.payload.has_value()) {
    auto payload = *value.payload;
    validate_payload(payload);
    native.payload = std::make_unique<fb::PayloadT>();
    native.payload->encoding = to_fb(payload.encoding);
    native.payload->data = std::move(payload.data);
    native.payload->hash_algorithm = std::move(payload.hash_algorithm);
    native.payload->hash = std::move(payload.hash);
    native.payload->byte_len = payload.byte_len;
    native.payload->content_type = std::move(payload.content_type);
    native.payload->state = std::move(payload.state);
  }

  flatbuffers::FlatBufferBuilder builder;
  const auto root = fb::ActionEnvelope::Pack(builder, &native);
  fb::FinishActionEnvelopeBuffer(builder, root);
  return {builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize()};
}

std::optional<envelope> decode(const uint8_t *data, size_t size, std::string *error) {
  if (data == nullptr || size == 0) {
    set_error(error, "empty action envelope buffer");
    return std::nullopt;
  }
  flatbuffers::Verifier verifier(data, size);
  if (!fb::VerifyActionEnvelopeBuffer(verifier)) {
    set_error(error, "invalid action envelope buffer");
    return std::nullopt;
  }
  const auto native = std::unique_ptr<fb::ActionEnvelopeT>(fb::GetActionEnvelope(data)->UnPack());
  if (native == nullptr || native->version != ACTION_ENVELOPE_VERSION || native->action_type.empty() ||
      native->schema_ref == nullptr || native->schema_ref->id.empty()) {
    set_error(error, "invalid action envelope semantic fields");
    return std::nullopt;
  }

  envelope result{};
  result.version = native->version;
  result.action_type = native->action_type;
  result.schema_ref = {native->schema_ref->id, native->schema_ref->version};
  if (native->actor != nullptr)
    result.actor = actor_metadata{native->actor->id, native->actor->kind, native->actor->storage_source_id,
                                  native->actor->source_type};
  if (native->session != nullptr)
    result.session = session_metadata{native->session->run_id, native->session->import_id};
  if (native->source != nullptr)
    result.source = source_metadata{native->source->kind, native->source->source_id, native->source->source_path,
                                    native->source->source_time, native->source->schema_version};
  if (native->batch != nullptr)
    result.batch = batch_metadata{native->batch->repo_root, native->batch->repo_head, native->batch->schema_version,
                                  native->batch->missions,  native->batch->goals,     native->batch->markers,
                                  native->batch->warnings};
  if (native->journal != nullptr)
    result.journal = journal_metadata{native->journal->frame_uid,
                                      native->journal->trigger_frame_uid,
                                      native->journal->stream_id,
                                      native->journal->gen_time,
                                      native->journal->trigger_time,
                                      native->journal->carrier_type,
                                      native->journal->source,
                                      native->journal->initial_source,
                                      native->journal->dest,
                                      native->journal->data_length,
                                      native->journal->data_type,
                                      native->journal->integrity_version,
                                      native->journal->checksum_algorithm,
                                      native->journal->payload_checksum,
                                      native->journal->frame_checksum};
  if (native->payload != nullptr) {
    payload_view payload{from_fb(native->payload->encoding),
                         native->payload->data,
                         native->payload->hash_algorithm,
                         native->payload->hash,
                         native->payload->byte_len,
                         native->payload->content_type,
                         native->payload->state};
    try {
      validate_payload(payload);
    } catch (const std::invalid_argument &exception) {
      set_error(error, exception.what());
      return std::nullopt;
    }
    result.payload = std::move(payload);
  }
  return result;
}

} // namespace kungfu::view::action
