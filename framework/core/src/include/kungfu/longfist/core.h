// SPDX-License-Identifier: Apache-2.0

//
// longfist-core: the schema leaf shared by libyijinjing and libkungfu.
//
// Holds the fact-ledger journal schema the yijinjing core needs, and ONLY that:
//   - frame/page packs: frame_header (tag 0), page_header (tag 1)
//   - journal enums: FrameDataType, PageStatus, mode, category, layout, Priority
//   - Location (tag 10205): the journal-endpoint pack (mode/category/group/name)
// All of the above are journal infrastructure. Business/trading types
// (Order / Trade / Quote / Position / ...) live in types.h / enums.h and are NOT
// visible here, so a pure journal core includes only this leaf and never pulls
// the trading schema (goal 2026-07-02: "core 对业务 schema 零依赖").
//
// Everything here keeps its type tag and field layout verbatim -- on-disk mmap
// journals stay byte-compatible. Location stays registered in AllTypes
// (longfist.h) via TYPE_PAIR(Location); only its definition lives here.
//

#ifndef KUNGFU_LONGFIST_CORE_H
#define KUNGFU_LONGFIST_CORE_H

#include <fmt/ostream.h>
#include <nlohmann/json.hpp>
#include <spdlog/fmt/ostr.h>

#include <kungfu/common.h>

// Enum <-> json (de)serialization helper. Defined here (the schema leaf) so that
// both the core enums below and the business enums in enums.h can use it.
#define KF_JSON_SERIALIZE_ENUM(ENUM_TYPE, ...)                                                                         \
  template <typename BasicJsonType> inline void to_json(BasicJsonType &j, const ENUM_TYPE &e) {                        \
    static_assert(std::is_enum<ENUM_TYPE>::value, #ENUM_TYPE " must be an enum!");                                     \
    static const std::pair<ENUM_TYPE, BasicJsonType> m[] = __VA_ARGS__;                                                \
    auto it =                                                                                                          \
        std::find_if(std::begin(m), std::end(m),                                                                       \
                     [e](const std::pair<ENUM_TYPE, BasicJsonType> &ej_pair) -> bool { return ej_pair.first == e; });  \
    j = ((it != std::end(m)) ? it : std::begin(m))->second;                                                            \
  }                                                                                                                    \
  template <typename BasicJsonType> inline void from_json(const BasicJsonType &j, ENUM_TYPE &e) {                      \
    static_assert(std::is_enum<ENUM_TYPE>::value, #ENUM_TYPE " must be an enum!");                                     \
    static const std::pair<ENUM_TYPE, BasicJsonType> m[] = __VA_ARGS__;                                                \
    if (j.is_number()) {                                                                                               \
      e = static_cast<ENUM_TYPE>(j.template get<int8_t>());                                                            \
      return;                                                                                                          \
    }                                                                                                                  \
    auto it =                                                                                                          \
        std::find_if(std::begin(m), std::end(m), [&j](const std::pair<ENUM_TYPE, BasicJsonType> &ej_pair) -> bool {    \
          return ej_pair.second == j;                                                                                  \
        });                                                                                                            \
    e = ((it != std::end(m)) ? it : std::begin(m))->first;                                                             \
  }

namespace kungfu::longfist::enums {
// fmt 10 不再隐式格式化枚举；通过 ADL 友元 format_as 把本命名空间所有枚举
// 按底层整数格式化（与既有 operator<< 输出 int32_t 一致）。
template <typename E, std::enable_if_t<std::is_enum_v<E>, int> = 0> constexpr int32_t format_as(E e) {
  return static_cast<int32_t>(e);
}

enum class FrameDataType : int8_t { Raw, Json, Unknown };

KF_JSON_SERIALIZE_ENUM(FrameDataType, {
                                          {FrameDataType::Raw, "Raw"},
                                          {FrameDataType::Json, "Json"},
                                          {FrameDataType::Unknown, "Unknown"},
                                      })

inline std::ostream &operator<<(std::ostream &os, FrameDataType t) { return os << int32_t(t); }

inline bool operator==(int8_t type, FrameDataType t) { return type == int8_t(t); }

inline bool operator==(FrameDataType t, int8_t type) { return type == int8_t(t); }

enum class PageStatus : int8_t { Normal, PreOpen };

KF_JSON_SERIALIZE_ENUM(PageStatus, {
                                       {PageStatus::Normal, "Normal"},
                                       {PageStatus::PreOpen, "PreOpen"},
                                   })

// Journal-infrastructure enums the yijinjing core (locator / journal) needs.
// These describe where/how a journal lives (mode / category / layout) and event
// scheduling priority -- pure journal schema, NOT trading types. They live here
// (the leaf) so a pure journal core includes only core.h. Their integer values,
// json names and helper mappings are moved verbatim from enums.h.
enum class mode : int8_t { LIVE, DATA, REPLAY, BACKTEST };

KF_JSON_SERIALIZE_ENUM(mode, {
                                 {mode::LIVE, "LIVE"},
                                 {mode::DATA, "DATA"},
                                 {mode::REPLAY, "REPLAY"},
                                 {mode::BACKTEST, "BACKTEST"},
                             })

inline std::ostream &operator<<(std::ostream &os, mode t) { return os << int32_t(t); }

inline std::string get_mode_name(mode m) {
  switch (m) {
  case mode::LIVE:
    return "live";
  case mode::DATA:
    return "data";
  case mode::REPLAY:
    return "replay";
  case mode::BACKTEST:
    return "backtest";
  default:
    return "live";
  }
}

inline mode get_mode_by_name(const std::string &name) {
  if (name == "live")
    return mode::LIVE;
  else if (name == "data")
    return mode::DATA;
  else if (name == "replay")
    return mode::REPLAY;
  else if (name == "backtest")
    return mode::BACKTEST;

  return mode::LIVE;
}

enum class category : int8_t { MD, TD, STRATEGY, SYSTEM, OPERATOR };

KF_JSON_SERIALIZE_ENUM(category, {
                                     {category::MD, "MD"},
                                     {category::TD, "TD"},
                                     {category::STRATEGY, "STRATEGY"},
                                     {category::SYSTEM, "SYSTEM"},
                                     {category::OPERATOR, "OPERATOR"},
                                 })

inline std::ostream &operator<<(std::ostream &os, category t) { return os << int32_t(t); }

inline std::string get_category_name(category c) {
  switch (c) {
  case category::MD:
    return "md";
  case category::TD:
    return "td";
  case category::STRATEGY:
    return "strategy";
  case category::OPERATOR:
    return "operator";
  case category::SYSTEM:
  default:
    return "system";
  }
}

inline category get_category_by_name(const std::string &name) {
  if (name == "md")
    return category::MD;
  else if (name == "td")
    return category::TD;
  else if (name == "strategy")
    return category::STRATEGY;
  else if (name == "operator")
    return category::OPERATOR;
  else
    return category::SYSTEM;
}

enum class layout : int8_t { JOURNAL, SQLITE, NANOMSG, LOG, MAP };

KF_JSON_SERIALIZE_ENUM(layout, {
                                   {layout::JOURNAL, "JOURNAL"},
                                   {layout::SQLITE, "SQLITE"},
                                   {layout::NANOMSG, "NANOMSG"},
                                   {layout::LOG, "LOG"},
                                   {layout::MAP, "MAP"},
                               })

inline std::string get_layout_name(layout l) {
  switch (l) {
  case layout::JOURNAL:
    return "journal";
  case layout::SQLITE:
    return "db";
  case layout::NANOMSG:
    return "nn";
  case layout::MAP:
    return "map";
  case layout::LOG:
  default:
    return "log";
  }
}

enum class Priority : int8_t { Low, Medium, High };

KF_JSON_SERIALIZE_ENUM(Priority, {
                                     {Priority::Low, "Low"},
                                     {Priority::Medium, "Medium"},
                                     {Priority::High, "High"},
                                 })

inline std::ostream &operator<<(std::ostream &os, Priority t) { return os << int32_t(t); }

inline bool operator<(Priority l, Priority r) { return int8_t(l) < int8_t(r); }

inline bool operator==(Priority l, Priority r) { return int8_t(l) == int8_t(r); }
} // namespace kungfu::longfist::enums

namespace kungfu::longfist::types {
KF_DEFINE_PACK_TYPE(                                           //
    frame_header, 0, PK(gen_time), TIMESTAMP(gen_time),        //
    /** total frame length (including header and data body);                //
     *  ADR-0001: serves as the frame publication token. Written last with   //
     *  std::atomic_ref release by the writer and read with acquire by the    //
     *  reader (see frame.h). NOT volatile: volatile gives no cross-thread    //
     *  ordering on weak-memory (ARM) targets. */                            //
    (uint32_t, length),                                        //
    /** header length */                                       //
    (uint32_t, header_length),                                 //
    /** generate time of the frame data */                     //
    (int64_t, gen_time),                                       //
    /** trigger time for this frame, use for latency stats */  //
    (int64_t, trigger_time),                                   //
    /** msg type of the data in frame (ADR-0001: no longer volatile;          //
     *  visibility is guaranteed by the length release/acquire token) */      //
    (int32_t, msg_type),                                       //
    /** source of this frame */                                //
    (uint32_t, source),                                        //
    /** dest of this frame */                                  //
    (uint32_t, dest),                                          //
    /** json or raw struct */                                  //
    (enums::FrameDataType, data_type),                         //
    /** the real writer of this frame */                       //
    (uint32_t, initial_source),                                //
    /** key of frame */                                        //
    (uint64_t, frame_uid),                                     //
    /** current_frame of reader when generate this frame */    //
    (uint64_t, trigger_frame_uid),                             //
    /** stream_id */                                           //
    (uint64_t, stream_id)                                      //
);

KF_DEFINE_PACK_TYPE(                          //
    page_header, 1, PK(version), PERPETUAL(), //
    (uint32_t, version),                      //
    (uint32_t, page_header_length),           //
    (uint64_t, page_size),                    //
    (uint32_t, frame_header_length),          //
    (longfist::enums::PageStatus, status),    // 0 close 1 preopen 2 open 3 flushing
    (uint64_t, last_frame_position)           //
);

// Location identifies a journal endpoint (mode/category/group/name). The yijinjing
// core's locator/location model it, so it lives in the leaf. It keeps type tag
// 10205 and stays registered in AllTypes (longfist.h) verbatim -- only its
// definition moves here, exactly as frame_header/page_header did.
KF_DEFINE_DATA_TYPE(                         //
    Location, 10205, PK(uid64), PERPETUAL(), //
    (uint64_t, uid64),                       //
    (uint32_t, location_uid),                //
    (enums::category, category),             //
    (enums::mode, mode),                     //
    (std::string, group),                    //
    (std::string, name),                     //
    (uint32_t, seed)                         //
);
} // namespace kungfu::longfist::types

#endif // KUNGFU_LONGFIST_CORE_H
