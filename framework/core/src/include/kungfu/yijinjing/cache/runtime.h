// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/27.
//

#ifndef KUNGFU_CACHE_RUNTIME_H
#define KUNGFU_CACHE_RUNTIME_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/journal/journal.h>

namespace kungfu::cache {
class bank {
public:
  template <typename DataType> void operator<<(const state<DataType> &state) {
    auto &target_map = state_map_[boost::hana::type_c<DataType>];
    target_map.insert_or_assign(state.data.uid(), state);
  }

  template <typename DataType> void operator<<(const typed_event_ptr<DataType> &event) {
    auto &target_map = state_map_[boost::hana::type_c<DataType>];
    target_map.insert_or_assign(event->template data<DataType>().uid(), *event);
  }

  void operator>>(const yijinjing::journal::writer_ptr &writer) const {
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : state_map_[type]) {
        writer->write(0, element.second.data);
      }
    });
  }

  void operator=(bank &another_bank) {
    clear();
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : another_bank[type]) {
        auto &target_map = state_map_[type];
        auto state = element.second;
        target_map.insert_or_assign(state.data.uid(), state);
      }
    });
  }

  void operator>>(cache::bank &bank) {
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : state_map_[type]) {
        bank << element.second;
      }
    });
  }

  void clear() {
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      state_map_[type].clear();
    });
  }

  uint32_t size() {
    uint32_t size = 0;
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      size += state_map_[type].size();
    });
    return size;
  }

  template <typename DataType>
  const std::unordered_map<uint64_t, state<DataType>> &operator[](const boost::hana::basic_type<DataType> &type) const {
    return state_map_[type];
  }

private:
  longfist::StateMapType state_map_ = longfist::build_state_map(longfist::StateDataTypes);
};

class deque_bank {
public:
  template <typename DataType> void operator<<(const state<DataType> &state) {
    auto &target_vector = state_map_[boost::hana::type_c<DataType>];
    target_vector.push_back(state);
  }

  template <typename DataType> void operator<<(const typed_event_ptr<DataType> &event) {
    auto &target_vector = state_map_[boost::hana::type_c<DataType>];
    target_vector.push_back(*event);
  }

  void operator>>(const yijinjing::journal::writer_ptr &writer) const {
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : state_map_[type]) {
        writer->write(0, element.data);
      }
    });
  }

  void operator=(deque_bank &another_bank) {
    clear();
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : another_bank[type]) {
        auto &target_map = state_map_[type];
        target_map.push_back(element);
      }
    });
  }

  void operator>>(cache::deque_bank &bank) {
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : state_map_[type]) {
        bank << element;
      }
    });
  }

  void clear() {
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      state_map_[type].clear();
    });
  }

  uint32_t size() {
    uint32_t size = 0;
    boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
      auto type = boost::hana::second(it);
      size += state_map_[type].size();
    });
    return size;
  }

  template <typename DataType>
  const std::deque<state<DataType>> &operator[](const boost::hana::basic_type<DataType> &type) const {
    return state_map_[type];
  }

private:
  longfist::StateDequeMapType state_map_ = longfist::build_state_deque_map(longfist::StateDataTypes);
};

class location_bank {
public:
  template <typename DataType> void operator<<(const state<DataType> &state) {
    uint64_t source_to_dest = ((uint64_t)state.source << 32u) | state.dest;

    auto pair = location_state_map_.try_emplace(source_to_dest, longfist::build_state_map(longfist::StateDataTypes));
    auto &target_map = pair.first->second[boost::hana::type_c<DataType>];
    target_map.insert_or_assign(state.data.uid(), state);
  }

  const std::unordered_map<uint64_t, longfist::StateMapType> &get_map() const { return location_state_map_; }

private:
  std::unordered_map<uint64_t, longfist::StateMapType> location_state_map_ = {};
};

template <typename DataTypes, typename DataTypesMap> class typed_bank {
public:
  explicit typed_bank(const DataTypes &types) : types_(types), state_map_(longfist::build_state_map(types_)) {}

  template <typename DataType> void operator<<(const state<DataType> &state) {
    auto &target_map = state_map_[boost::hana::type_c<DataType>];
    target_map.insert_or_assign(state.data.uid(), state);
  }

  template <typename DataType> void operator<<(const typed_event_ptr<DataType> &event) {
    auto &target_map = state_map_[boost::hana::type_c<DataType>];
    target_map.insert_or_assign(event->template data<DataType>().uid(), *event);
  }

  void operator>>(const yijinjing::journal::writer_ptr &writer) const {
    boost::hana::for_each(types_, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : state_map_[type]) {
        writer->write(0, element.second.data);
      }
    });
  }

  void operator=(bank &another_bank) {
    clear();
    boost::hana::for_each(types_, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : another_bank[type]) {
        auto &target_map = state_map_[type];
        auto state = element.second;
        target_map.insert_or_assign(state.data.uid(), state);
      }
    });
  }

  void operator>>(cache::bank &bank) {
    boost::hana::for_each(types_, [&](auto it) {
      auto type = boost::hana::second(it);
      for (const auto &element : state_map_[type]) {
        bank << element.second;
      }
    });
  }

  void clear() {
    boost::hana::for_each(types_, [&](auto it) {
      auto type = boost::hana::second(it);
      state_map_[type].clear();
    });
  }

  template <typename DataType>
  const std::unordered_map<uint64_t, state<DataType>> &operator[](const boost::hana::basic_type<DataType> &type) const {
    return state_map_[type];
  }

private:
  DataTypes types_;
  DataTypesMap state_map_;
};

} // namespace kungfu::cache

#endif // KUNGFU_CACHE_RUNTIME_H
