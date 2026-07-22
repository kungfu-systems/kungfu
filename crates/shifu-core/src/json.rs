// SPDX-License-Identifier: Apache-2.0
//
// Minimal JSON reader — enough to consume repo-local fact registries (the
// Buildchain-managed KFD files) from the std-only side of the shifu role.
//
// Read-only on purpose: shifu consumes declarations, it never authors them
// (registries are generated and audited on the node side). Objects keep their
// pairs in a Vec — registry lookups are a handful of keys deep, so linear
// scans beat dragging in a hash map, and source order survives for free.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// Member lookup on an object; None on non-objects and missing keys.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    /// String member of an object, defaulting to "" when absent or non-string.
    pub fn str_of(&self, key: &str) -> &str {
        self.get(key).and_then(Json::as_str).unwrap_or("")
    }
}

#[derive(Debug)]
pub struct JsonError {
    pub offset: usize,
    pub message: String,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.message, self.offset)
    }
}

pub fn parse(text: &str) -> Result<Json, JsonError> {
    let mut p = Parser {
        bytes: text.as_bytes(),
        pos: 0,
        depth: 0,
    };
    p.skip_ws();
    let value = p.value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(p.err("trailing content after JSON value"));
    }
    Ok(value)
}

// Nesting cap: registry files are a few levels deep; a malformed file must
// error out instead of overflowing the stack of a recursive parser.
const MAX_DEPTH: usize = 128;

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn err(&self, message: &str) -> JsonError {
        JsonError {
            offset: self.pos,
            message: message.to_string(),
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), JsonError> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.err(&format!("expected '{}'", byte as char)))
        }
    }

    fn value(&mut self) -> Result<Json, JsonError> {
        if self.depth >= MAX_DEPTH {
            return Err(self.err("nesting too deep"));
        }
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Json::String(self.string()?)),
            Some(b't') => self.literal("true", Json::Bool(true)),
            Some(b'f') => self.literal("false", Json::Bool(false)),
            Some(b'n') => self.literal("null", Json::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.number(),
            _ => Err(self.err("expected a JSON value")),
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, JsonError> {
        if self.bytes[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err(self.err(&format!("expected '{word}'")))
        }
    }

    fn object(&mut self) -> Result<Json, JsonError> {
        self.expect(b'{')?;
        self.depth += 1;
        let mut pairs = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(Json::Object(pairs));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            self.expect(b':')?;
            self.skip_ws();
            let value = self.value()?;
            pairs.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Ok(Json::Object(pairs));
                }
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self) -> Result<Json, JsonError> {
        self.expect(b'[')?;
        self.depth += 1;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err(self.err("unterminated string")),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    match self.peek() {
                        Some(b'"') => out.push('"'),
                        Some(b'\\') => out.push('\\'),
                        Some(b'/') => out.push('/'),
                        Some(b'b') => out.push('\u{0008}'),
                        Some(b'f') => out.push('\u{000C}'),
                        Some(b'n') => out.push('\n'),
                        Some(b'r') => out.push('\r'),
                        Some(b't') => out.push('\t'),
                        Some(b'u') => {
                            self.pos += 1;
                            let unit = self.hex4()?;
                            // Surrogate pair: a high surrogate must be
                            // followed by \uXXXX carrying the low half.
                            let ch = if (0xD800..0xDC00).contains(&unit) {
                                if self.peek() == Some(b'\\') {
                                    self.pos += 1;
                                    self.expect(b'u')?;
                                    let low = self.hex4()?;
                                    if !(0xDC00..0xE000).contains(&low) {
                                        return Err(self.err("invalid low surrogate"));
                                    }
                                    let combined =
                                        0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                                    char::from_u32(combined)
                                } else {
                                    None
                                }
                            } else {
                                char::from_u32(unit)
                            };
                            match ch {
                                Some(c) => out.push(c),
                                None => return Err(self.err("invalid \\u escape")),
                            }
                            continue;
                        }
                        _ => return Err(self.err("invalid escape")),
                    }
                    self.pos += 1;
                }
                Some(c) if c < 0x20 => return Err(self.err("control character in string")),
                Some(_) => {
                    // Copy a full UTF-8 scalar so multi-byte text survives.
                    let rest = &self.bytes[self.pos..];
                    let text = std::str::from_utf8(rest)
                        .map_err(|_| self.err("invalid UTF-8 in string"))?;
                    let ch = text.chars().next().unwrap();
                    out.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        // Called with pos on 'u': consume it plus four hex digits.
        let start = self.pos + 1;
        let end = start + 4;
        if end > self.bytes.len() {
            return Err(self.err("truncated \\u escape"));
        }
        let hex = std::str::from_utf8(&self.bytes[start..end])
            .map_err(|_| self.err("invalid \\u escape"))?;
        let unit = u32::from_str_radix(hex, 16).map_err(|_| self.err("invalid \\u escape"))?;
        self.pos = end - 1;
        Ok(unit)
    }

    fn number(&mut self) -> Result<Json, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| self.err("invalid number"))?;
        text.parse::<f64>()
            .map(Json::Number)
            .map_err(|_| self.err("invalid number"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_registry_shaped_document() {
        let doc = parse(
            r#"{
              "product": {"id": "kungfu"},
              "surfaces": [
                {"id": "a", "distribution": {"tasks": ["dist"], "artifacts": [
                  {"kind": "app", "platform": "macos", "pathGlob": "product/dist/desktop/mac*/*.app"}
                ]}}
              ]
            }"#,
        )
        .unwrap();
        assert_eq!(doc.get("product").unwrap().str_of("id"), "kungfu");
        let surfaces = doc.get("surfaces").unwrap().as_array().unwrap();
        let dist = surfaces[0].get("distribution").unwrap();
        assert_eq!(
            dist.get("tasks").unwrap().as_array().unwrap()[0].as_str(),
            Some("dist")
        );
        let artifact = &dist.get("artifacts").unwrap().as_array().unwrap()[0];
        assert_eq!(artifact.str_of("platform"), "macos");
    }

    #[test]
    fn parses_escapes_and_unicode() {
        let doc = parse(r#"{"s": "a\"b\\\né😀", "n": -1.5e2}"#).unwrap();
        assert_eq!(doc.str_of("s"), "a\"b\\\né😀");
        assert_eq!(doc.get("n"), Some(&Json::Number(-150.0)));
    }

    #[test]
    fn rejects_malformed_input() {
        for bad in ["", "{", "[1,]", "{\"a\":}", "\"unterminated", "1 2", "nul"] {
            assert!(parse(bad).is_err(), "should reject: {bad}");
        }
    }

    #[test]
    fn missing_lookups_default_safely() {
        let doc = parse("{\"a\": 1}").unwrap();
        assert!(doc.get("b").is_none());
        assert_eq!(doc.str_of("a"), "");
        assert!(doc.as_array().is_none());
    }
}
