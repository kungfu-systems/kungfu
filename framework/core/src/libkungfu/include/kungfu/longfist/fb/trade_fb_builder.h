// SPDX-License-Identifier: Apache-2.0
//
// born-FB Trade 写侧构造器(Order 同法第二类型):把 longfist POD Trade 全字段按 char-array/enum 表示口径
// (2026-06-21)序列化成 born-FB Trade 载荷(FB 编码),供生产 producer 在 feature flag 下 write_raw 到 journal,
// 与 POD Trade(tag 203)并存。
// 口径:array<char,N> -> FB string(到首 NUL,对齐 sqlite_orm text_printer);
//      enum class X:int8_t -> FB enum X:byte(镜像 enums.h,值=底层 int8,经 int8_t 中转 cast)。
// 字段全镜像 longfist::types::Trade(types.h:304-332),字段名/列对齐既有 sqlite_orm。读侧 fb_projector 反射投影(R3)。
// enum 经 trade_generated.h -> order_generated.h 复用,与 order_fb_builder 同 TU 共存不冲突。
#ifndef KUNGFU_LONGFIST_FB_TRADE_FB_BUILDER_H
#define KUNGFU_LONGFIST_FB_TRADE_FB_BUILDER_H

#include <kungfu/longfist/fb/trade_generated.h>
#include <kungfu/longfist/types.h>

#include <flatbuffers/flatbuffers.h>

#include <cstdint>
#include <string>

namespace kungfu::longfist::fb {

// born-FB Trade 迁移 msg_type(>0,区分 POD Trade longfist tag 203,迁移期并存)。
static constexpr int32_t TRADE_FB_TAG = 30203;

// 把 POD Trade 全字段构造成 born-FB Trade 载荷;返回 FB 字节,可直接 write_raw。
inline std::string build_fb_trade(const kungfu::longfist::types::Trade &t) {
  flatbuffers::FlatBufferBuilder fbb;
  // 口径:array<char,N> -> FB string(先建 Offset)。
  auto ext_order = fbb.CreateString(t.external_order_id.to_string());
  auto ext_trade = fbb.CreateString(t.external_trade_id.to_string());
  auto tday = fbb.CreateString(t.trading_day.to_string());
  auto inst = fbb.CreateString(t.instrument_id.to_string());
  auto exch = fbb.CreateString(t.exchange_id.to_string());
  auto contract = fbb.CreateString(t.contract_id.to_string());
  // 口径:enum class:int8_t -> FB enum:byte(经 int8_t 中转,值镜像 enums.h)。
  auto root = CreateTrade(fbb, t.trade_id, t.order_id, t.parent_order_id, ext_order, ext_trade, t.trade_time,
                          t.restore_time, tday, inst, exch, contract,
                          static_cast<InstrumentType>(static_cast<int8_t>(t.instrument_type)),
                          static_cast<Side>(static_cast<int8_t>(t.side)),
                          static_cast<Offset>(static_cast<int8_t>(t.offset)),
                          static_cast<HedgeFlag>(static_cast<int8_t>(t.hedge_flag)), t.price, t.volume, t.tax,
                          t.commission);
  fbb.Finish(root);
  return std::string(reinterpret_cast<const char *>(fbb.GetBufferPointer()), fbb.GetSize());
}

} // namespace kungfu::longfist::fb
#endif // KUNGFU_LONGFIST_FB_TRADE_FB_BUILDER_H
