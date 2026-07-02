#include <kungfu/wingchun/orderbook/depthorderbooks.h>

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing;
namespace kungfu::wingchun::orderbook {

int64_t DepthOrderbook::get_next_trading_day_start(int64_t data_time) {
  int64_t end_offset = 16 * time_unit::NANOSECONDS_PER_HOUR;
  int64_t trading_day_start =
      data_time - ((data_time + time_unit::UTC_OFFSET) % time_unit::NANOSECONDS_PER_DAY) + end_offset;
  if (trading_day_start < data_time) {
    trading_day_start += time_unit::NANOSECONDS_PER_DAY;
  }
  return trading_day_start;
}

bool DepthOrderbook::is_new_trading_day(int64_t data_time) {
  if (next_trading_day_start_ <= data_time) {
    SPDLOG_INFO("-- 触发跨日 --");
    return true;
  }
  return false;
}

void DepthOrderbook::clear_book() {
  bid_side_.levels_.clear();
  ask_side_.levels_.clear();
  bid_side_.map_seq_id_2_level_.clear();
  ask_side_.map_seq_id_2_level_.clear();
}

void DepthOrderbook::deal_trading_day(int64_t data_time) {
  if (next_trading_day_start_ == 0) {
    next_trading_day_start_ = get_next_trading_day_start(data_time);
  }
  if (is_new_trading_day(data_time)) {
    clear_book();
    next_trading_day_start_ = get_next_trading_day_start(data_time);
  }
}

void DepthOrderbook::on_entrust(const Entrust &entrust) {
  std::map<double, Level> &bid_map = bid_side_.levels_;
  std::map<double, Level> &ask_map = ask_side_.levels_;
  std::unordered_map<int, Level> &bid_seq_id_map = bid_side_.map_seq_id_2_level_;
  std::unordered_map<int, Level> &ask_seq_id_map = ask_side_.map_seq_id_2_level_;

  double price = entrust.price;
  double volume = entrust.volume;
  int64_t data_time = entrust.data_time;
  Side entrust_side = entrust.side;
  deal_trading_day(data_time);
  SPDLOG_DEBUG("Entrust : {}", entrust.to_string());

  if (entrust_side == Side::Buy) {
    bid_seq_id_map[entrust.orig_order_no] = Level(price, volume, data_time);
    if (bid_map.find(price) != bid_map.end()) {
      bid_map.at(price).volume += volume;
      bid_map.at(price).data_time = data_time;
    } else {
      bid_map[price] = Level(price, volume, data_time);
    }
  } else {
    ask_seq_id_map[entrust.orig_order_no] = Level(price, volume, data_time);
    if (ask_map.find(price) != ask_map.end()) {
      ask_map.at(price).volume += volume;
      ask_map.at(price).data_time = data_time;
    } else {
      ask_map[price] = Level(price, volume, data_time);
    }
  }
}

void DepthOrderbook::on_transaction(const Transaction &transaction) {
  std::map<double, Level> &bid_map = bid_side_.levels_;
  std::map<double, Level> &ask_map = ask_side_.levels_;
  std::unordered_map<int, Level> &bid_seq_id_map = bid_side_.map_seq_id_2_level_;
  std::unordered_map<int, Level> &ask_seq_id_map = ask_side_.map_seq_id_2_level_;

  double volume = transaction.volume;
  int64_t data_time = transaction.data_time;
  ExecType exec_type = transaction.exec_type;
  Side transaction_side = transaction.side;
  deal_trading_day(data_time);
  SPDLOG_DEBUG("Transaction : {}", transaction.to_string());

  if (exec_type == ExecType::Cancel) {
    if (transaction_side == Side::Buy) {
      if (bid_seq_id_map.find(transaction.bid_no) != bid_seq_id_map.end()) {
        double transaction_price = bid_seq_id_map[transaction.bid_no].price;
        if (bid_map.find(transaction_price) != bid_map.end()) {
          bid_map[transaction_price].volume -= volume;
          bid_map[transaction_price].data_time = data_time;
          if (bid_map[transaction_price].volume <= 0) {
            bid_map.erase(transaction_price);
          }
        }
        bid_seq_id_map[transaction.bid_no].volume -= volume;
        if (bid_seq_id_map[transaction.bid_no].volume <= 0) {
          bid_seq_id_map.erase(transaction.bid_no);
        }
      } else {
        SPDLOG_DEBUG("买单出现没有存入过的撤单系统编号");
      }
    } else {
      if (ask_seq_id_map.find(transaction.ask_no) != ask_seq_id_map.end()) {
        double transaction_price = ask_seq_id_map[transaction.ask_no].price;
        if (ask_map.find(transaction_price) != ask_map.end()) {
          ask_map[transaction_price].volume -= volume;
          ask_map[transaction_price].data_time = data_time;
          if (ask_map[transaction_price].volume <= 0) {
            ask_map.erase(transaction_price);
          }
        }
        ask_seq_id_map[transaction.ask_no].volume -= volume;
        if (ask_seq_id_map[transaction.ask_no].volume <= 0) {
          ask_seq_id_map.erase(transaction.ask_no);
        }
      } else {
        SPDLOG_DEBUG("卖单出现没有存入过的撤单系统编号");
      }
    }
  }

  if (exec_type == ExecType::Trade) {
    if (bid_seq_id_map.find(transaction.bid_no) != bid_seq_id_map.end()) {
      double bid_price = bid_seq_id_map[transaction.bid_no].price;
      bid_seq_id_map[transaction.bid_no].volume -= volume;
      if (bid_seq_id_map[transaction.bid_no].volume <= 0) {
        bid_seq_id_map.erase(transaction.bid_no);
      }
      if (bid_map.find(bid_price) != bid_map.end()) {
        bid_map[bid_price].volume -= volume;
        if (bid_map[bid_price].volume <= 0) {
          bid_map.erase(bid_price);
        }
      }
    }
    if (ask_seq_id_map.find(transaction.ask_no) != ask_seq_id_map.end()) {
      double ask_price = ask_seq_id_map[transaction.ask_no].price;
      ask_seq_id_map[transaction.ask_no].volume -= volume;
      if (ask_seq_id_map[transaction.ask_no].volume <= 0) {
        ask_seq_id_map.erase(transaction.ask_no);
      }
      if (ask_map.find(ask_price) != ask_map.end()) {
        ask_map[ask_price].volume -= volume;
        if (ask_map[ask_price].volume <= 0) {
          ask_map.erase(ask_price);
        }
      }
    }
  }
}

} // namespace kungfu::wingchun::orderbook
