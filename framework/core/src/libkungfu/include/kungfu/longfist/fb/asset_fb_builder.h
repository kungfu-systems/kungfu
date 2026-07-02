// SPDX-License-Identifier: Apache-2.0
//
// born-FB Asset 写侧构造器(Order/Trade/Position 同法第四类型,账本资金 state):把 longfist POD Asset 全字段按
// enum 表示口径(2026-06-21)序列化成 born-FB Asset 载荷(FB 编码),供生产 producer(ledger)在 feature flag 下
// write_raw 到 journal,与 POD Asset(tag 101)并存。
// 口径:enum class X:int8_t -> FB enum X:byte(镜像 enums.h,值=底层 int8,经 int8_t 中转 cast)。Asset 无 char-array 字段。
// 字段全镜像 longfist::types::Asset(types.h:95-151),字段名/列对齐既有 sqlite_orm。读侧 fb_projector 反射投影(R3)。
// enum LedgerCategory 经 asset_generated.h -> position_generated.h 复用。
#ifndef KUNGFU_LONGFIST_FB_ASSET_FB_BUILDER_H
#define KUNGFU_LONGFIST_FB_ASSET_FB_BUILDER_H

#include <kungfu/longfist/fb/asset_generated.h>
#include <kungfu/longfist/types.h>

#include <flatbuffers/flatbuffers.h>

#include <cstdint>
#include <string>

namespace kungfu::longfist::fb {

// born-FB Asset 迁移 msg_type(>0,区分 POD Asset longfist tag 101,迁移期并存)。
static constexpr int32_t ASSET_FB_TAG = 30101;

// 把 POD Asset 全字段构造成 born-FB Asset 载荷;返回 FB 字节,可直接 write_raw。CreateAsset 参数顺序=table 字段声明序。
inline std::string build_fb_asset(const kungfu::longfist::types::Asset &a) {
  flatbuffers::FlatBufferBuilder fbb;
  auto root = CreateAsset(fbb, a.update_time, a.holder_uid,
                          static_cast<LedgerCategory>(static_cast<int8_t>(a.ledger_category)), a.initial_equity,
                          a.static_equity, a.dynamic_equity, a.realized_pnl, a.unrealized_pnl, a.market_value,
                          a.long_market_value, a.short_market_value, a.margin, a.long_margin, a.short_margin,
                          a.accumulated_fee, a.intraday_fee, a.frozen_cash, a.frozen_margin, a.frozen_fee,
                          a.position_pnl, a.close_pnl, a.avail, a.long_avail, a.short_avail, a.total_asset,
                          a.avail_margin, a.long_debt, a.short_cash, a.margin_interest, a.settlement, a.credit,
                          a.collateral_ratio, a.total_debt, a.net_assets, a.long_total_debt, a.short_total_debt,
                          a.gage_buy_fund_available, a.credit_buy_fund_available, a.buyredeliver_fund_available,
                          a.directrepay_fund_available);
  fbb.Finish(root);
  return std::string(reinterpret_cast<const char *>(fbb.GetBufferPointer()), fbb.GetSize());
}

} // namespace kungfu::longfist::fb
#endif // KUNGFU_LONGFIST_FB_ASSET_FB_BUILDER_H
