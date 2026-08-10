// SPDX-License-Identifier: Apache-2.0

import {
  createHmac,
  generateKeySync,
  timingSafeEqual,
} from 'node:crypto';

export class SyntheticGitHubCredentialBroker {
  constructor() {
    this.active = true;
    this.rotate();
  }
  rotate() {
    this.key = generateKeySync('hmac', { length: 256 });
  }
  invalidate() {
    this.active = false;
  }
  restore() {
    this.active = true;
    this.rotate();
  }
  sign(body) {
    return `sha256=${createHmac('sha256', this.key).update(body).digest('hex')}`;
  }
  async verify({ handle, algorithm, body, signature }) {
    if (
      !this.active ||
      handle !== 'credential:github/webhook' ||
      algorithm !== 'hmac-sha256' ||
      typeof signature !== 'string' ||
      !signature.startsWith('sha256=')
    ) {
      return false;
    }
    const expected = Buffer.from(this.sign(body));
    const supplied = Buffer.from(signature);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }
}
