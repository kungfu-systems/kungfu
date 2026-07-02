// SPDX-License-Identifier: Apache-2.0
#ifndef KUNGFU_ROCKS_H
#define KUNGFU_ROCKS_H
#include <kungfu/common.h>
#include <map>
#include <rocksdb/db.h>
#include <set>

namespace kungfu::yijinjing::util {
FORWARD_DECLARE_CLASS_PTR(rocks)
class rocks {
public:
  static rocksdb::Status open_db(const std::string &dir, ::rocksdb::DB **db, bool is_writing = false);

  static rocks_ptr get_rocks();

  static rocksdb::ReadOptions &read_options();

  static rocksdb::WriteOptions &write_options();

  static rocksdb::Options &options();

  static rocksdb::Status put_kv(const std::string &key, const std::string &value, rocksdb::DB *db);

  static rocksdb::Status put_kv(const std::string &key, const std::string &value, const std::string &dir);

  static rocksdb::Status put_kvs(const std::map<std::string, std::string> &kvs, rocksdb::DB *db);

  static rocksdb::Status put_kvs(const std::map<std::string, std::string> &kvs, const std::string &dir);

  static rocksdb::Status put_kvs(rocksdb::WriteBatch &batch, rocksdb::DB *db);

  static rocksdb::Status put_kvs(rocksdb::WriteBatch &batch, const std::string &dir);

  static rocksdb::Status get_kv(const std::string &key, std::string &value, rocksdb::DB *db);

  static rocksdb::Status get_kv(const std::string &key, std::string &value, const std::string &dir);

  static std::map<std::string, std::string> get_kvs(const std::set<std::string> &keys, rocksdb::DB *db);

  static std::map<std::string, std::string> get_kvs(const std::set<std::string> &keys, const std::string &dir);

  static void clear_rocksdb(rocksdb::DB **db);

private:
  rocksdb::ReadOptions read_options_ = {};
  rocksdb::WriteOptions write_options_ = {};
  rocksdb::Options options_ = {};

  explicit rocks();
};

// defined in rocks.cpp: installs the rocksdb-backed master-kv provider into
// the core location's uid-verification seam (idempotent)
void install_master_kv_provider();

} // namespace kungfu::yijinjing::util

#endif // KUNGFU_ROCKS_H
