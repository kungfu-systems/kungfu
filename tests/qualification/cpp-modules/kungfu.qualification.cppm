// SPDX-License-Identifier: Apache-2.0

export module kungfu.qualification;

export namespace kungfu::qualification {

constexpr int mix(int value) noexcept {
  return ((value * 0x45d9f3b) ^ (value >> 3)) & 0x7fffffff;
}

} // namespace kungfu::qualification
