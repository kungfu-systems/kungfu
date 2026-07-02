#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/util/rocks.h>
namespace kungfu::yijinjing::util {

rocksdb::Status rocks::open_db(const std::string &dir, rocksdb::DB **db, bool is_writing) {
  if (is_writing) {
    auto status = rocksdb::DB::Open(rocks::options(), dir, db);
    return status;
  } else {
    auto status = rocksdb::DB::OpenForReadOnly(rocks::options(), dir, db);
    return status;
  }
}

rocks::rocks() {
  read_options_.fill_cache = false;
  options_.create_if_missing = true;
}

rocks_ptr rocks::get_rocks() {
  static rocks_ptr rocks_ = std::shared_ptr<rocks>(new rocks());
  return rocks_;
}

rocksdb::ReadOptions &rocks::read_options() { return get_rocks()->read_options_; }

rocksdb::WriteOptions &rocks::write_options() { return get_rocks()->write_options_; }

rocksdb::Options &rocks::options() { return get_rocks()->options_; }

rocksdb::Status rocks::put_kv(const std::string &key, const std::string &value, const std::string &dir) {
  rocksdb::DB *db;
  rocksdb::Status status = open_db(dir, &db, true);
  if (not status.ok()) {
    return status;
  }
  status = put_kv(key, value, db);
  delete db;
  return status;
}

rocksdb::Status rocks::put_kv(const std::string &key, const std::string &value, rocksdb::DB *db) {
  try {
    return db->Put(write_options(), key, value);
  } catch (const std::exception &e) {
    SPDLOG_WARN("catch exception: {}", e.what());
  }
  return rocksdb::Status{};
}

rocksdb::Status rocks::put_kvs(const std::map<std::string, std::string> &kvs, const std::string &dir) {
  rocksdb::DB *db;
  rocksdb::Status status = open_db(dir, &db, true);
  if (not status.ok()) {
    return status;
  }
  status = put_kvs(kvs, db);
  delete db;
  return status;
}

rocksdb::Status rocks::put_kvs(const std::map<std::string, std::string> &kvs, rocksdb::DB *db) {
  try {
    rocksdb::WriteBatch batch;
    for (const auto &pair : kvs) {
      batch.Put(pair.first, pair.second);
    }
    return db->Write(write_options(), &batch);
  } catch (const std::exception &e) {
    SPDLOG_WARN("catch exception: {}", e.what());
  }
  return rocksdb::Status{};
}

rocksdb::Status rocks::put_kvs(rocksdb::WriteBatch &batch, const std::string &dir) {
  rocksdb::DB *db;
  rocksdb::Status status = open_db(dir, &db, true);
  if (not status.ok()) {
    return status;
  }
  status = put_kvs(batch, db);
  delete db;
  return status;
}

rocksdb::Status rocks::put_kvs(rocksdb::WriteBatch &batch, rocksdb::DB *db) {
  try {
    return db->Write(write_options(), &batch);
  } catch (const std::exception &e) {
    SPDLOG_WARN("catch exception: {}", e.what());
  }
  return rocksdb::Status{};
}

rocksdb::Status rocks::get_kv(const std::string &key, std::string &value, const std::string &dir) {
  rocksdb::DB *db;
  rocksdb::Status status = open_db(dir, &db, false);
  if (not status.ok()) {
    return status;
  }
  status = get_kv(key, value, db);
  delete db;
  return status;
}

rocksdb::Status rocks::get_kv(const std::string &key, std::string &value, rocksdb::DB *db) {
  try {
    return db->Get(read_options(), key, &value);
  } catch (const std::exception &e) {
    SPDLOG_WARN("catch exception: {}", e.what());
  }
  return rocksdb::Status{};
}

std::map<std::string, std::string> rocks::get_kvs(const std::set<std::string> &keys, const std::string &dir) {
  rocksdb::DB *db;
  if (not open_db(dir, &db, false).ok()) {
    return {};
  }
  std::map<std::string, std::string> result = get_kvs(keys, db);
  delete db;
  return result;
}

std::map<std::string, std::string> rocks::get_kvs(const std::set<std::string> &keys, rocksdb::DB *db) {
  std::map<std::string, std::string> result;
  try {
    for (const std::string &key : keys) {
      db->Get(read_options(), key, &result.try_emplace(key).first->second);
    }
  } catch (const std::exception &e) {
    SPDLOG_WARN("catch exception: {}", e.what());
  }
  return result;
}

void rocks::clear_rocksdb(rocksdb::DB **db) {
  delete *db;
  *db = nullptr;
}

// Runtime side of the location master-kv seam: the core's uid-seed
// verification asks the master's kv map through location::master_kv(); this
// backs it with the rocksdb MAP layout. Installed on load (static init) and
// again explicitly from the io_device constructor, so static-library builds
// that drop unreferenced objects still get it before any runtime lookup.
void install_master_kv_provider() {
  data::location::master_kv() = [](const data::location &self, const std::string &key) {
    namespace es = longfist::enums;
    const std::string rocksdb_dir =
        self.locator->layout_directory(es::layout::MAP, es::category::SYSTEM, "master", "master", self.mode, false);
    SPDLOG_TRACE("rocksdb_dir: {}", rocksdb_dir);
    std::string value{};
    rocks::get_kv(key, value, rocksdb_dir);
    return value;
  };
}

static const bool master_kv_provider_installed = [] {
  install_master_kv_provider();
  return true;
}();

} // namespace kungfu::yijinjing::util
