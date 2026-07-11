// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/content_hash.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace kungfu::yijinjing::storage {

namespace {

constexpr std::array<uint32_t, 64> SHA256_K = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};

uint32_t rotr(uint32_t value, uint32_t shift) { return (value >> shift) | (value << (32U - shift)); }

uint32_t load_be32(const uint8_t *data) {
  return (static_cast<uint32_t>(data[0]) << 24U) | (static_cast<uint32_t>(data[1]) << 16U) |
         (static_cast<uint32_t>(data[2]) << 8U) | static_cast<uint32_t>(data[3]);
}

void store_be32(uint8_t *out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value >> 24U);
  out[1] = static_cast<uint8_t>(value >> 16U);
  out[2] = static_cast<uint8_t>(value >> 8U);
  out[3] = static_cast<uint8_t>(value);
}

void store_be64(uint8_t *out, uint64_t value) {
  for (int index = 7; index >= 0; --index) {
    out[index] = static_cast<uint8_t>(value);
    value >>= 8U;
  }
}

std::string to_lower_ascii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

std::string hex_encode(const std::array<uint8_t, 32> &digest) {
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (const auto byte : digest) {
    out << std::setw(2) << static_cast<unsigned int>(byte);
  }
  return out.str();
}

class sha256_hasher {
public:
  void update(const uint8_t *data, size_t size) {
    if (size == 0) {
      return;
    }
    if (data == nullptr) {
      throw std::invalid_argument("content hash data pointer is null");
    }

    size_t offset = 0;
    while (offset < size) {
      const auto available = block_.size() - block_size_;
      const auto take = std::min(available, size - offset);
      std::memcpy(block_.data() + block_size_, data + offset, take);
      block_size_ += take;
      offset += take;
      if (block_size_ == block_.size()) {
        transform(block_.data());
        bit_length_ += 512U;
        block_size_ = 0;
      }
    }
  }

  std::array<uint8_t, 32> final() {
    bit_length_ += static_cast<uint64_t>(block_size_) * 8U;

    block_[block_size_++] = 0x80U;
    if (block_size_ > 56) {
      while (block_size_ < block_.size()) {
        block_[block_size_++] = 0U;
      }
      transform(block_.data());
      block_size_ = 0;
    }
    while (block_size_ < 56) {
      block_[block_size_++] = 0U;
    }
    store_be64(block_.data() + 56, bit_length_);
    transform(block_.data());

    std::array<uint8_t, 32> digest{};
    for (size_t index = 0; index < state_.size(); ++index) {
      store_be32(digest.data() + index * 4, state_[index]);
    }
    return digest;
  }

private:
  void transform(const uint8_t *chunk) {
    std::array<uint32_t, 64> w{};
    for (size_t index = 0; index < 16; ++index) {
      w[index] = load_be32(chunk + index * 4);
    }
    for (size_t index = 16; index < w.size(); ++index) {
      const auto s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >> 3U);
      const auto s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >> 10U);
      w[index] = w[index - 16] + s0 + w[index - 7] + s1;
    }

    uint32_t a = state_[0];
    uint32_t b = state_[1];
    uint32_t c = state_[2];
    uint32_t d = state_[3];
    uint32_t e = state_[4];
    uint32_t f = state_[5];
    uint32_t g = state_[6];
    uint32_t h = state_[7];

    for (size_t index = 0; index < w.size(); ++index) {
      const auto s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const auto ch = (e & f) ^ ((~e) & g);
      const auto temp1 = h + s1 + ch + SHA256_K[index] + w[index];
      const auto s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const auto maj = (a & b) ^ (a & c) ^ (b & c);
      const auto temp2 = s0 + maj;

      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }

    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::array<uint32_t, 8> state_ = {0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
                                    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
  std::array<uint8_t, 64> block_{};
  size_t block_size_ = 0;
  uint64_t bit_length_ = 0;
};

std::string sha256_hex(const void *data, size_t size) {
  sha256_hasher hasher;
  hasher.update(static_cast<const uint8_t *>(data), size);
  return hex_encode(hasher.final());
}

} // namespace

std::string normalize_content_hash_algorithm(const std::string &algorithm) {
  auto normalized = to_lower_ascii(algorithm.empty() ? CONTENT_HASH_ALGORITHM_SHA256 : algorithm);
  if (normalized != CONTENT_HASH_ALGORITHM_SHA256) {
    throw std::invalid_argument("unsupported content hash algorithm: " + algorithm);
  }
  return normalized;
}

bool is_supported_content_hash_algorithm(const std::string &algorithm) {
  try {
    normalize_content_hash_algorithm(algorithm);
    return true;
  } catch (const std::invalid_argument &) {
    return false;
  }
}

content_hash make_content_hash(const std::string &value, const std::string &algorithm) {
  if (value.empty()) {
    throw std::invalid_argument("content hash value is empty");
  }
  content_hash hash{};
  hash.algorithm = normalize_content_hash_algorithm(algorithm);
  hash.value = to_lower_ascii(value);
  return hash;
}

std::string format_content_hash(const content_hash &hash) {
  auto normalized = normalize_content_hash_algorithm(hash.algorithm);
  if (hash.value.empty()) {
    throw std::invalid_argument("content hash value is empty");
  }
  return normalized + ":" + to_lower_ascii(hash.value);
}

content_hash parse_content_hash(const std::string &formatted) {
  const auto separator = formatted.find(':');
  if (separator == std::string::npos) {
    throw std::invalid_argument("content hash must use algorithm:value form");
  }
  return make_content_hash(formatted.substr(separator + 1), formatted.substr(0, separator));
}

content_hash compute_content_hash(const void *data, size_t size, const std::string &algorithm) {
  auto normalized = normalize_content_hash_algorithm(algorithm);
  content_hash hash{};
  hash.algorithm = normalized;
  hash.value = sha256_hex(data, size);
  return hash;
}

content_hash compute_content_hash(const std::string &data, const std::string &algorithm) {
  return compute_content_hash(data.data(), data.size(), algorithm);
}

std::string compute_content_hash_value(const void *data, size_t size, const std::string &algorithm) {
  return compute_content_hash(data, size, algorithm).value;
}

std::string compute_content_hash_value(const std::string &data, const std::string &algorithm) {
  return compute_content_hash(data, algorithm).value;
}

bool verify_content_hash(const void *data, size_t size, const content_hash &expected) {
  return compute_content_hash_value(data, size, expected.algorithm) == to_lower_ascii(expected.value);
}

bool verify_content_hash(const std::string &data, const content_hash &expected) {
  return verify_content_hash(data.data(), data.size(), expected);
}

} // namespace kungfu::yijinjing::storage
