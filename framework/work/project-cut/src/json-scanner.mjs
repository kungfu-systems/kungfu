// SPDX-License-Identifier: Apache-2.0
// @ts-check

class JsonScanner {
  constructor(text, options) {
    this.text = text;
    this.index = 0;
    this.losslessUint64 = options?.losslessUint64 ?? false;
  }

  fail(code, message) {
    throw Object.assign(new Error(`${message} at byte ${this.index}`), {
      code,
      path: '$',
    });
  }

  skipWhitespace() {
    while (/[\t\n\r ]/u.test(this.text[this.index] ?? '')) this.index += 1;
  }

  readString() {
    if (this.text[this.index] !== '"')
      this.fail('invalid-json', 'expected string');
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index));
      }
      if (character === '\\') {
        this.index += 1;
        if (this.text[this.index] === 'u') {
          if (
            !/^[0-9a-fA-F]{4}$/u.test(
              this.text.slice(this.index + 1, this.index + 5),
            )
          )
            this.fail('invalid-json', 'invalid Unicode escape');
          this.index += 5;
        } else {
          if (!/["\\/bfnrt]/u.test(this.text[this.index] ?? ''))
            this.fail('invalid-json', 'invalid string escape');
          this.index += 1;
        }
      } else {
        if (character.charCodeAt(0) < 0x20)
          this.fail('invalid-json', 'unescaped control character');
        this.index += 1;
      }
    }
    this.fail('invalid-json', 'unterminated string');
  }

  readObject() {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set();
    const object = {};
    if (this.text[this.index] === '}') {
      this.index += 1;
      return object;
    }
    while (this.index < this.text.length) {
      const key = this.readString();
      if (keys.has(key))
        this.fail('duplicate-object-key', `duplicate object key '${key}'`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':')
        this.fail('invalid-json', 'expected colon');
      this.index += 1;
      const child = this.readValue();
      Object.defineProperty(object, key, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return object;
      }
      if (this.text[this.index] !== ',')
        this.fail('invalid-json', 'expected comma');
      this.index += 1;
      this.skipWhitespace();
    }
    this.fail('invalid-json', 'unterminated object');
  }

  readArray() {
    this.index += 1;
    this.skipWhitespace();
    const array = [];
    if (this.text[this.index] === ']') {
      this.index += 1;
      return array;
    }
    while (this.index < this.text.length) {
      array.push(this.readValue());
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return array;
      }
      if (this.text[this.index] !== ',')
        this.fail('invalid-json', 'expected comma');
      this.index += 1;
    }
    this.fail('invalid-json', 'unterminated array');
  }

  readScalar() {
    const token = this.text
      .slice(this.index)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u,
      )?.[0];
    if (!token) this.fail('invalid-json', 'expected JSON value');
    this.index += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (
      this.losslessUint64 &&
      /^[0-9]+$/u.test(token) &&
      BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return BigInt(token);
    return Number(token);
  }

  readValue() {
    this.skipWhitespace();
    const character = this.text[this.index];
    if (character === '{') return this.readObject();
    if (character === '[') return this.readArray();
    if (character === '"') return this.readString();
    return this.readScalar();
  }

  parse() {
    const parsed = this.readValue();
    this.skipWhitespace();
    if (this.index !== this.text.length)
      this.fail('invalid-json', 'unexpected trailing data');
    return parsed;
  }
}

export function scanJson(text, options) {
  return new JsonScanner(text, options).parse();
}
