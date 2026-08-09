// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/27.
//

#ifndef KUNGFU_RUNTIME_PROJECTION_SQLITE_ORM_EXT_H
#define KUNGFU_RUNTIME_PROJECTION_SQLITE_ORM_EXT_H

#include <cstring>
#include <stdexcept>

#include <kungfu/runtime/common.h>

#include <sqlite_orm/sqlite_orm.h>

namespace sqlite_orm {

template <typename T> struct type_printer<T, std::enable_if_t<kungfu::is_enum_class_v<T>>> : public integer_printer {};

template <size_t N> struct type_printer<kungfu::array<char, N>> : public text_printer {};

template <typename T, size_t N> struct type_printer<kungfu::array<T, N>> : public blob_printer {};

template <typename T> struct type_printer<std::vector<T>> : public blob_printer {};
} // namespace sqlite_orm

namespace sqlite_orm {
template <typename V> struct statement_binder<V, std::enable_if_t<kungfu::is_enum_class_v<V>>> {
  int bind(sqlite3_stmt *stmt, int index, const V &value) {
    return sqlite3_bind_int(stmt, index, static_cast<int>(value));
  }
};

template <size_t N> struct statement_binder<kungfu::array<char, N>> {
  int bind(sqlite3_stmt *stmt, int index, const kungfu::array<char, N> &value) {
    const auto text = value.to_string();
    return sqlite3_bind_text64(stmt, index, text.data(), text.size(), SQLITE_TRANSIENT, SQLITE_UTF8);
  }
};

template <typename V, size_t N> struct statement_binder<kungfu::array<V, N>> {
  int bind(sqlite3_stmt *stmt, int index, const kungfu::array<V, N> &value) {
    static_assert(std::is_trivially_copyable_v<V>, "SQLite BLOB arrays require trivially copyable elements");
    return sqlite3_bind_blob64(stmt, index, value.value, sizeof(value.value), SQLITE_TRANSIENT);
  }
};

template <typename V> struct statement_binder<std::vector<V>, std::enable_if_t<not std::is_same_v<V, char>>> {
  int bind(sqlite3_stmt *stmt, int index, const std::vector<V> &value) {
    static_assert(std::is_trivially_copyable_v<V>, "SQLite BLOB vectors require trivially copyable elements");
    const void *data = value.empty() ? static_cast<const void *>("") : static_cast<const void *>(value.data());
    return sqlite3_bind_blob64(stmt, index, data, value.size() * sizeof(V), SQLITE_TRANSIENT);
  }
};
} // namespace sqlite_orm

namespace sqlite_orm {

template <typename V>
static constexpr bool is_kungfu_enum = kungfu::is_enum_class_v<V> and not std::is_same_v<V, journal_mode>;

template <typename V> struct row_extractor<V, std::enable_if_t<is_kungfu_enum<V>>> {
  V extract(const char *row_value) { return static_cast<V>(atoi(row_value)); }

  V extract(sqlite3_stmt *stmt, int columnIndex) { return static_cast<V>(sqlite3_column_int(stmt, columnIndex)); }
};

template <size_t N> struct row_extractor<kungfu::array<char, N>> {
  kungfu::array<char, N> extract(const char *row_value) { return kungfu::array<char, N>{row_value}; }

  kungfu::array<char, N> extract(sqlite3_stmt *stmt, int columnIndex) {
    return kungfu::array<char, N>{sqlite3_column_text(stmt, columnIndex)};
  }
};

template <typename V, size_t N> struct row_extractor<kungfu::array<V, N>> {
  kungfu::array<V, N> extract(const char *row_value) { return kungfu::array<V, N>{row_value}; }

  kungfu::array<V, N> extract(sqlite3_stmt *stmt, int columnIndex) {
    static_assert(std::is_trivially_copyable_v<V>, "SQLite BLOB arrays require trivially copyable elements");
    const auto bytes = sqlite3_column_bytes(stmt, columnIndex);
    if (bytes != static_cast<int>(sizeof(V) * N)) {
      throw std::runtime_error("SQLite BLOB array has an invalid byte length");
    }
    const auto *blob = static_cast<const unsigned char *>(sqlite3_column_blob(stmt, columnIndex));
    if (blob == nullptr && bytes != 0) {
      throw std::runtime_error("SQLite BLOB array is null");
    }
    return kungfu::array<V, N>{blob};
  }
};

template <typename V> struct row_extractor<std::vector<V>> {
  std::vector<V> extract(const char *row_value) {
    if (row_value) {
      auto len = ::strlen(row_value);
      return this->go(row_value, len);
    }
    return {};
  }

  std::vector<V> extract(sqlite3_stmt *stmt, int columnIndex) {
    auto bytes = static_cast<const char *>(sqlite3_column_blob(stmt, columnIndex));
    auto len = sqlite3_column_bytes(stmt, columnIndex);
    return this->go(bytes, len);
  }

protected:
  std::vector<V> go(const char *bytes, size_t len) {
    static_assert(std::is_trivially_copyable_v<V>, "SQLite BLOB vectors require trivially copyable elements");
    if (len % sizeof(V) != 0) {
      throw std::runtime_error("SQLite BLOB vector has an invalid byte length");
    }
    if (len == 0) {
      return {};
    }
    if (bytes == nullptr) {
      throw std::runtime_error("SQLite BLOB vector is null");
    }
    std::vector<V> result(len / sizeof(V));
    std::memcpy(result.data(), bytes, len);
    return result;
  }
};
} // namespace sqlite_orm

#endif // KUNGFU_RUNTIME_PROJECTION_SQLITE_ORM_EXT_H
