// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(
  new URL(
    '../framework/core/src/libkungfu/tests/durability_powercut_fixture.cpp',
    import.meta.url,
  ),
  'utf8',
);

test('power-cut fixture keeps native file operations behind platform adapters', () => {
  assert.match(
    source,
    /#ifdef _WIN32[\s\S]+?#include <io\.h>[\s\S]+?#else[\s\S]+?#include <unistd\.h>/u,
  );
  for (const operation of [
    '_wopen',
    '_lseeki64',
    '_write',
    '_commit',
    '_chsize_s',
    '_close',
  ]) {
    assert.match(source, new RegExp(`::${operation}\\(`, 'u'));
  }
  const fillBody = source.slice(
    source.indexOf('void fill_until_enospc'),
    source.indexOf('int verify_real_enospc'),
  );
  for (const adapter of [
    'open_filler_file',
    'seek_filler_end',
    'write_filler',
    'sync_filler',
    'truncate_filler',
    'close_filler',
  ]) {
    assert.match(fillBody, new RegExp(`\\b${adapter}\\(`, 'u'));
  }
});
